import { NextResponse } from "next/server";
import { generateCampaignDraft } from "@/lib/ai/anthropic";
import {
  extraAllowance,
  normalizeScheduledAt,
  periodFor,
  quotaKey,
  quotaPlan,
  type Cadence,
  type QuotaRule,
} from "@/lib/campaigns/period";
import type { ClientContract, DeliveryRule, SpecialDateRule } from "@/lib/domain";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 300;

// Reserva de segurança: não começa um job novo se faltar menos que isso para o limite da função.
const ORCAMENTO_MS = 230_000;
const LOTE_POR_RECLAMACAO = 2;

function isInternalRequest(request: Request) {
  if (process.env.NODE_ENV !== "production") return true;

  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  return Boolean(cronSecret && authHeader === `Bearer ${cronSecret}`);
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asDeliveryRules(value: unknown): DeliveryRule[] {
  if (!Array.isArray(value)) return [];
  return value as DeliveryRule[];
}

function asSpecialDateRules(value: unknown): SpecialDateRule[] {
  if (!Array.isArray(value)) return [];
  return value as SpecialDateRule[];
}

function targetDateOf(payload: unknown) {
  return payload && typeof payload === "object" && "target_date" in payload && typeof payload.target_date === "string"
    ? payload.target_date
    : null;
}

type Supabase = ReturnType<typeof createAdminClient>;
type JobRow = {
  id: string;
  organization_id: string;
  client_id: string;
  contract_id: string | null;
  payload: unknown;
  attempts: number;
  max_attempts: number;
};

/** Peças já geradas no mês do período, por canal|formato (cota mensal em lotes semanais). */
async function alreadyGeneratedThisMonth(supabase: Supabase, clientId: string, periodStart: string) {
  const inicioDoMes = `${periodStart.slice(0, 7)}-01T00:00:00Z`;

  // Do dia 1 até a véspera do período: o que este lote vai gerar ainda não conta.
  const { data, error } = await supabase
    .from("content_items")
    .select("channel, format")
    .eq("client_id", clientId)
    .neq("status", "rejected")
    .gte("scheduled_at", inicioDoMes)
    .lt("scheduled_at", `${periodStart}T00:00:00Z`);

  if (error) throw new Error(`Erro ao contar peças do mês: ${error.message}`);
  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    const key = quotaKey(row.channel, row.format);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Agrupa as peças por conceito e cria uma família por conceito (código CF- vem do banco). */
async function createFamilies(
  supabase: Supabase,
  job: JobRow,
  campaignId: string,
  concepts: string[],
) {
  const unique = Array.from(new Map(concepts.map((c) => [c.trim().toLowerCase(), c.trim()])).entries());
  if (unique.length === 0) return new Map<string, string>();

  const { data, error } = await supabase
    .from("content_families")
    .insert(
      unique.map(([, concept]) => ({
        organization_id: job.organization_id,
        client_id: job.client_id,
        campaign_id: campaignId,
        concept: concept.slice(0, 300),
        origin: "ai",
      })),
    )
    .select("id, concept");

  if (error) throw new Error(`Erro ao criar famílias de conteúdo: ${error.message}`);
  return new Map((data ?? []).map((row) => [row.concept.trim().toLowerCase(), row.id as string]));
}

async function processJob(supabase: Supabase, job: JobRow) {
  const [{ data: client, error: clientError }, { data: brandKit, error: brandError }, { data: contract, error: contractError }] =
    await Promise.all([
      supabase.from("clients").select("*").eq("id", job.client_id).single(),
      supabase.from("brand_kits").select("*").eq("client_id", job.client_id).single(),
      job.contract_id
        ? supabase.from("client_contracts").select("*").eq("id", job.contract_id).single()
        : supabase
            .from("client_contracts")
            .select("*")
            .eq("client_id", job.client_id)
            .eq("status", "active")
            .order("starts_at", { ascending: false })
            .limit(1)
            .single(),
    ]);

  if (clientError || !client) throw new Error(`Cliente não encontrado: ${clientError?.message ?? "sem dados"}`);
  if (brandError || !brandKit) throw new Error(`Brand Kit não encontrado: ${brandError?.message ?? "sem dados"}`);
  if (contractError || !contract) throw new Error(`Contrato ativo não encontrado: ${contractError?.message ?? "sem dados"}`);

  // Período segue a cadência do contrato: 7 dias no semanal, um mês inteiro no mensal.
  const cadence = (contract.generation_cadence === "monthly" ? "monthly" : "weekly") as Cadence;
  const period = periodFor(targetDateOf(job.payload), cadence);
  const deliveryRules = asDeliveryRules(contract.delivery_rules);
  const specialDateRules = asSpecialDateRules(contract.special_date_rules);

  const alreadyThisMonth =
    cadence === "weekly" && deliveryRules.some((rule) => rule.period === "month")
      ? await alreadyGeneratedThisMonth(supabase, job.client_id, period.startsAt)
      : {};
  const quotas = quotaPlan(deliveryRules as QuotaRule[], period, cadence, alreadyThisMonth);
  const extras = extraAllowance(specialDateRules, period);

  if (quotas.length === 0 && Object.keys(extras).length === 0) {
    return { skipped: true as const, reason: "Cota do período já atendida ou contrato sem regras de entrega." };
  }

  const { draft: generatedCampaign, shortfalls } = await generateCampaignDraft({
    client: {
      companyName: client.company_name,
      industry: client.industry,
      service: client.service,
      region: client.region,
      differentiators: asStringArray(client.differentiators),
      marketingMaturity: client.marketing_maturity,
    },
    brandKit: {
      palette: brandKit.palette as { primary: string; secondary: string; accent: string; background: string; text: string },
      visualStyle: brandKit.visual_style,
      toneOfVoice: brandKit.tone_of_voice,
      requiredTerms: asStringArray(brandKit.required_terms),
      forbiddenTerms: asStringArray(brandKit.forbidden_terms),
      preferredCta: brandKit.preferred_cta,
    },
    contract: {
      market: contract.market,
      timezone: contract.timezone,
      deliveryRules,
      specialDateRules,
      approvalRequired: contract.approval_required,
    } as Pick<ClientContract, "market" | "timezone" | "deliveryRules" | "specialDateRules" | "approvalRequired">,
    period,
    quotas,
    extras,
  });

  const { data: campaign, error: campaignError } = await supabase
    .from("campaigns")
    .insert({
      organization_id: job.organization_id,
      client_id: job.client_id,
      contract_id: contract.id,
      name: generatedCampaign.campaignName,
      goal: generatedCampaign.campaignGoal,
      summary: generatedCampaign.summary,
      starts_at: period.startsAt,
      ends_at: period.endsAt,
      status: "in_review",
    })
    .select("id")
    .single();

  if (campaignError || !campaign) {
    throw new Error(`Erro ao salvar campanha: ${campaignError?.message ?? "sem dados"}`);
  }

  try {
    const families = await createFamilies(
      supabase,
      job,
      campaign.id,
      generatedCampaign.contentItems.map((item) => item.concept),
    );

    const contentRows = generatedCampaign.contentItems.map((item, itemIndex) => ({
      organization_id: job.organization_id,
      campaign_id: campaign.id,
      client_id: job.client_id,
      family_id: families.get(item.concept.trim().toLowerCase()) ?? null,
      title: item.title,
      scheduled_at: normalizeScheduledAt(item.scheduledAt, itemIndex, period),
      channel: item.channel,
      format: item.format,
      objective: item.objective,
      pillar: item.pillar,
      status: "review",
      caption: item.caption,
      hashtags: item.hashtags,
      hook: item.hook || null,
      cta: item.cta || null,
      variant_label: `${item.channel} · ${item.format}`,
      creative_brief: item.creativeBrief,
      image_prompt: item.imagePrompt || null,
      video_script: item.videoScript || null,
      generated_by_ai: true,
    }));

    const { error: contentError } = await supabase.from("content_items").insert(contentRows);
    if (contentError) throw new Error(`Erro ao salvar conteúdos: ${contentError.message}`);

    return {
      skipped: false as const,
      result: {
        campaign_id: campaign.id,
        items_count: contentRows.length,
        families_count: families.size,
        period,
        quotas,
        shortfalls,
      },
    };
  } catch (error) {
    // Sem peças, campanha e famílias vazias não podem ficar no painel nem duplicar na nova tentativa.
    await supabase.from("content_families").delete().eq("campaign_id", campaign.id);
    await supabase.from("campaigns").delete().eq("id", campaign.id);
    throw error;
  }
}

export async function POST(request: Request) {
  if (!isInternalRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const startedAt = Date.now();

  try {
    const supabase = createAdminClient();
    const workerName = `campaign-worker-${crypto.randomUUID()}`;

    // Jobs presos que já gastaram todas as tentativas viram 'failed' (visíveis), não somem.
    await supabase.rpc("fail_exhausted_generation_jobs");

    let processedCount = 0;
    let skippedCount = 0;
    const failures: Array<{ jobId: string; error: string }> = [];

    // Esvazia a fila enquanto houver tempo — antes eram só 2 jobs por chamada e o resto
    // esperava o próximo contrato vencer (podia levar dias).
    while (Date.now() - startedAt < ORCAMENTO_MS) {
      const { data: jobs, error: claimError } = await supabase.rpc("claim_due_generation_jobs", {
        worker_name: workerName,
        maximum_jobs: LOTE_POR_RECLAMACAO,
      });

      if (claimError) {
        throw new Error(`Falha ao reclamar jobs: ${claimError.message}`);
      }
      if (!jobs || jobs.length === 0) break;

      for (const job of jobs as JobRow[]) {
        try {
          const outcome = await processJob(supabase, job);

          const { error: finishError } = await supabase
            .from("generation_jobs")
            .update({
              status: "completed",
              completed_at: new Date().toISOString(),
              locked_at: null,
              locked_by: null,
              error_message: null,
              result: outcome.skipped ? { skipped: true, reason: outcome.reason } : outcome.result,
            })
            .eq("id", job.id)
            .eq("status", "processing");

          if (finishError) throw new Error(`Erro ao finalizar job: ${finishError.message}`);
          if (outcome.skipped) skippedCount++;
          else processedCount++;
        } catch (jobError) {
          const errorMessage = jobError instanceof Error ? jobError.message : "Erro desconhecido";
          // Espera crescente entre tentativas: 5, 10, 20 min.
          const retryAt = new Date(Date.now() + 5 * 60 * 1000 * 2 ** Math.max(0, job.attempts - 1)).toISOString();
          const jobStatus = job.attempts >= job.max_attempts ? "failed" : "queued";

          await supabase
            .from("generation_jobs")
            .update({
              status: jobStatus,
              scheduled_for: retryAt,
              locked_at: null,
              locked_by: null,
              error_message: errorMessage,
            })
            .eq("id", job.id)
            .eq("status", "processing");

          failures.push({ jobId: job.id, error: errorMessage });
          console.error(`Erro ao processar job ${job.id}:`, jobError);
        }
      }
    }

    return NextResponse.json({ success: true, processed: processedCount, skipped: skippedCount, failures });
  } catch (error) {
    console.error("Erro no worker de geração:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Erro desconhecido" },
      { status: 500 },
    );
  }
}
