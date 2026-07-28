import { NextResponse } from "next/server";
import { generateCampaignDraft } from "@/lib/ai/anthropic";
import type { ClientContract, DeliveryRule, SpecialDateRule } from "@/lib/domain";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 300;

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

function getPeriod(payload: unknown) {
  const fallbackStart = new Date();
  const targetDate =
    payload &&
    typeof payload === "object" &&
    "target_date" in payload &&
    typeof payload.target_date === "string"
      ? new Date(payload.target_date)
      : fallbackStart;

  const startsAt = Number.isNaN(targetDate.getTime()) ? fallbackStart : targetDate;
  const endsAt = new Date(startsAt);
  endsAt.setDate(endsAt.getDate() + 6);

  return {
    startsAt: startsAt.toISOString().slice(0, 10),
    endsAt: endsAt.toISOString().slice(0, 10),
  };
}

// A IA devolve scheduledAt como string livre; datas inválidas ou fora do período
// quebravam o insert e queimavam as 3 tentativas do job. Normalizamos antes de gravar.
function normalizeScheduledAt(
  rawValue: string,
  index: number,
  period: { startsAt: string; endsAt: string },
) {
  // Tolerância de 24h nas bordas: um post às 00:00 de Nova York no primeiro dia
  // chega como 04:00Z, e às 20:00 do último dia chega como 00:00Z do dia seguinte.
  // Sem a folga, datas legítimas eram remarcadas.
  const TOLERANCIA_FUSO_MS = 24 * 60 * 60 * 1000;
  const inicio = new Date(`${period.startsAt}T00:00:00Z`).getTime() - TOLERANCIA_FUSO_MS;
  const fim = new Date(`${period.endsAt}T23:59:59Z`).getTime() + TOLERANCIA_FUSO_MS;

  const fallback = new Date(`${period.startsAt}T13:00:00Z`);
  fallback.setUTCDate(fallback.getUTCDate() + (index % 7));

  const parsed = new Date(rawValue);
  if (Number.isNaN(parsed.getTime())) return fallback.toISOString();

  const instante = parsed.getTime();
  if (instante < inicio || instante > fim) return fallback.toISOString();
  return parsed.toISOString();
}

export async function POST(request: Request) {
  if (!isInternalRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const supabase = createAdminClient();
    const workerName = `campaign-worker-${crypto.randomUUID()}`;

    const { data: jobs, error: claimError } = await supabase.rpc("claim_due_generation_jobs", {
      worker_name: workerName,
      maximum_jobs: 2,
    });

    if (claimError) {
      throw new Error(`Falha ao reclamar jobs: ${claimError.message}`);
    }

    if (!jobs || jobs.length === 0) {
      return NextResponse.json({ success: true, processed: 0, message: "Fila vazia." });
    }

    let processedCount = 0;
    const failures: Array<{ jobId: string; error: string }> = [];

    for (const job of jobs) {
      try {
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

        const period = getPeriod(job.payload);
        const generatedCampaign = await generateCampaignDraft({
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
            deliveryRules: asDeliveryRules(contract.delivery_rules),
            specialDateRules: asSpecialDateRules(contract.special_date_rules),
            approvalRequired: contract.approval_required,
          } as Pick<ClientContract, "market" | "timezone" | "deliveryRules" | "specialDateRules" | "approvalRequired">,
          period,
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

        const contentRows = generatedCampaign.contentItems.map((item, itemIndex) => ({
          organization_id: job.organization_id,
          campaign_id: campaign.id,
          client_id: job.client_id,
          title: item.title,
          scheduled_at: normalizeScheduledAt(item.scheduledAt, itemIndex, period),
          channel: item.channel,
          format: item.format,
          objective: item.objective,
          pillar: item.pillar,
          status: "review",
          caption: item.caption,
          hashtags: item.hashtags,
          creative_brief: item.creativeBrief,
          image_prompt: item.imagePrompt || null,
          video_script: item.videoScript || null,
          generated_by_ai: true,
        }));

        const { error: contentError } = await supabase.from("content_items").insert(contentRows);
        if (contentError) throw new Error(`Erro ao salvar conteúdos: ${contentError.message}`);

        const { error: finishError } = await supabase
          .from("generation_jobs")
          .update({
            status: "completed",
            completed_at: new Date().toISOString(),
            locked_at: null,
            locked_by: null,
            result: { campaign_id: campaign.id, items_count: contentRows.length },
          })
          .eq("id", job.id)
          .eq("status", "processing");

        if (finishError) throw new Error(`Erro ao finalizar job: ${finishError.message}`);
        processedCount++;
      } catch (jobError) {
        const errorMessage = jobError instanceof Error ? jobError.message : "Erro desconhecido";
        const retryAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
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

    return NextResponse.json({ success: true, processed: processedCount, failures });
  } catch (error) {
    console.error("Erro no worker de geração:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Erro desconhecido" },
      { status: 500 },
    );
  }
}
