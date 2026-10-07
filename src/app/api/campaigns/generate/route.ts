import { after, NextResponse } from "next/server";
import { generateCampaignDraft } from "@/lib/ai/anthropic";
import {
  contractAnchorDay,
  dayStartUtc,
  extraAllowance,
  periodFor,
  periodFromPayload,
  quotaKey,
  quotaPlan,
  safeTimeZone,
  type Cadence,
  type Period,
  type QuotaRule,
} from "@/lib/campaigns/period";
import { appBaseUrl, fireWorker, isInternalRequest, MAX_WORKER_HOPS } from "@/lib/campaigns/worker";
import type { ClientContract, DeliveryRule, SpecialDateRule } from "@/lib/domain";
import { createAdminClient } from "@/lib/supabase/admin";

// Worker da fila de geração. Protegido por CRON_SECRET (isInternalRequest).
// Responde 202 na hora e processa em segundo plano (after), dentro do maxDuration.
export const maxDuration = 300;

// ------------------------------------------------------------------
// Orçamento de tempo (tudo medido a partir do início da requisição):
//   LIMITE_MS          — nada do worker passa disso (margem para a plataforma encerrar limpo).
//   MARGEM_GRAVACAO_MS — reservado depois da IA para gravar (RPC) ou devolver o job à fila.
//   MINIMO_POR_JOB_MS  — só reclama um job novo se sobrar ao menos isso: o pior caso
//                        da IA cabe inteiro, nunca começa um job que seria abortado.
//   IA_MAXIMO_MS       — teto da IA para um job (as chamadas em paralelo dividem esse prazo).
// ------------------------------------------------------------------
const LIMITE_MS = 285_000;
const MARGEM_GRAVACAO_MS = 20_000;
const MINIMO_POR_JOB_MS = 150_000;
const IA_MAXIMO_MS = 210_000;

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

type JobOutcome =
  | { kind: "completed"; campaignId: string; itemsCount: number; alreadyCompleted: boolean }
  | { kind: "skipped"; reason: string; period?: Period }
  | { kind: "cancelled"; reason: string };

/**
 * Peças já geradas no mês do período, por canal|formato (cota mensal em lotes semanais).
 * Limites do mês e do período no FUSO DO CONTRATO (a peça pertence ao dia local).
 */
async function alreadyGeneratedThisMonth(supabase: Supabase, clientId: string, periodStart: string, timeZone: string) {
  const inicioDoMes = dayStartUtc(`${periodStart.slice(0, 7)}-01`, timeZone);
  const inicioDoPeriodo = dayStartUtc(periodStart, timeZone);

  // Do dia 1 até a véspera do período: o que este lote vai gerar ainda não conta.
  const { data, error } = await supabase
    .from("content_items")
    .select("channel, format")
    .eq("client_id", clientId)
    .neq("status", "rejected")
    .gte("scheduled_at", inicioDoMes)
    .lt("scheduled_at", inicioDoPeriodo);

  if (error) throw new Error(`Erro ao contar peças do mês: ${error.message}`);
  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    const key = quotaKey(row.channel, row.format);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function processJob(supabase: Supabase, job: JobRow, workerName: string, aiDeadlineMs: number): Promise<JobOutcome> {
  const [{ data: client, error: clientError }, { data: brandKit, error: brandError }, { data: contract, error: contractError }] =
    await Promise.all([
      supabase.from("clients").select("*").eq("id", job.client_id).single(),
      supabase.from("brand_kits").select("*").eq("client_id", job.client_id).single(),
      job.contract_id
        ? supabase.from("client_contracts").select("*").eq("id", job.contract_id).maybeSingle()
        : supabase
            .from("client_contracts")
            .select("*")
            .eq("client_id", job.client_id)
            .eq("status", "active")
            .order("starts_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
    ]);

  if (clientError || !client) throw new Error(`Cliente não encontrado: ${clientError?.message ?? "sem dados"}`);
  if (brandError || !brandKit) throw new Error(`Brand Kit não encontrado: ${brandError?.message ?? "sem dados"}`);
  if (contractError) throw new Error(`Erro ao ler o contrato: ${contractError.message}`);

  // Contrato pausado/encerrado/apagado: não gera (nem gasta IA). O job é cancelado com o motivo.
  if (!contract) return { kind: "cancelled", reason: "Sem contrato ativo para este cliente." };
  if (contract.status !== "active") {
    return { kind: "cancelled", reason: `Contrato ${contract.status === "paused" ? "pausado" : "encerrado"}: geração cancelada.` };
  }

  // Período: o gravado no job no momento do enfileiramento (cron/manual, mesma regra);
  // jobs antigos sem período no payload recalculam com o mesmo dia-âncora.
  const cadence = (contract.generation_cadence === "monthly" ? "monthly" : "weekly") as Cadence;
  const anchorDay = contractAnchorDay(contract.starts_at);
  const period = periodFromPayload(job.payload) ?? periodFor(targetDateOf(job.payload), cadence, new Date(), anchorDay);
  if (contract.ends_at && period.startsAt > String(contract.ends_at)) {
    return { kind: "cancelled", reason: `Contrato terminou em ${contract.ends_at}: período ${period.startsAt} fora da vigência.` };
  }

  const timeZone = safeTimeZone(contract.timezone);
  const deliveryRules = asDeliveryRules(contract.delivery_rules);
  const specialDateRules = asSpecialDateRules(contract.special_date_rules);

  const alreadyThisMonth =
    cadence === "weekly" && deliveryRules.some((rule) => rule.period === "month")
      ? await alreadyGeneratedThisMonth(supabase, job.client_id, period.startsAt, timeZone)
      : {};
  const quotas = quotaPlan(deliveryRules as QuotaRule[], period, cadence, alreadyThisMonth, anchorDay);
  const extras = extraAllowance(specialDateRules, period);

  if (quotas.length === 0 && Object.keys(extras).length === 0) {
    return { kind: "skipped", reason: "Cota do período já atendida ou contrato sem regras de entrega.", period };
  }

  const { draft, shortfalls, warnings } = await generateCampaignDraft(
    {
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
        timezone: timeZone,
        deliveryRules,
        specialDateRules,
        approvalRequired: contract.approval_required,
      } as Pick<ClientContract, "market" | "timezone" | "deliveryRules" | "specialDateRules" | "approvalRequired">,
      period,
      quotas,
      extras,
    },
    { deadlineMs: aiDeadlineMs },
  );

  // Campanha + famílias + peças + job 'completed' numa transação só, idempotente pelo job
  // e só para o worker que detém o job (supabase/migrations/202610060003).
  const { data, error } = await supabase.rpc("complete_generation_job", {
    p_job_id: job.id,
    p_worker: workerName,
    p_campaign: {
      contract_id: contract.id,
      name: draft.campaignName,
      goal: draft.campaignGoal,
      summary: draft.summary,
      starts_at: period.startsAt,
      ends_at: period.endsAt,
    },
    p_items: draft.contentItems.map((item) => ({
      concept: item.concept,
      title: item.title,
      scheduled_at: item.scheduledAt,
      channel: item.channel,
      format: item.format,
      objective: item.objective,
      pillar: item.pillar,
      caption: item.caption,
      hashtags: item.hashtags,
      hook: item.hook,
      cta: item.cta,
      variant_label: `${item.channel} · ${item.format}`,
      creative_brief: item.creativeBrief,
      image_prompt: item.imagePrompt ?? "",
      video_script: item.videoScript ?? "",
    })),
    p_result: { period, quotas, shortfalls, warnings, time_zone: timeZone },
  });

  if (error) throw new Error(`Erro ao gravar a campanha: ${error.message}`);
  const saved = data as { campaign_id: string; items_count: number; already_completed: boolean } | null;
  if (!saved?.campaign_id) throw new Error("A gravação da campanha não devolveu o identificador.");
  return { kind: "completed", campaignId: saved.campaign_id, itemsCount: saved.items_count, alreadyCompleted: saved.already_completed };
}

/**
 * Atualiza o job SÓ se ele ainda for deste worker (status 'processing' + locked_by).
 * Devolve false quando outro worker já reassumiu o job — a RLS/filtro não dá erro
 * com 0 linhas, por isso a checagem da linha devolvida.
 */
async function releaseJob(supabase: Supabase, jobId: string, workerName: string, fields: Record<string, unknown>) {
  const { data, error } = await supabase
    .from("generation_jobs")
    .update({
      ...fields,
      locked_at: null,
      locked_by: null,
    })
    .eq("id", jobId)
    .eq("status", "processing")
    .eq("locked_by", workerName)
    .select("id");
  if (error) {
    console.error(`Erro ao atualizar o job ${jobId}:`, error);
    return false;
  }
  if (!data || data.length === 0) {
    console.warn(`Job ${jobId} não pertence mais ao worker ${workerName}: atualização ignorada.`);
    return false;
  }
  return true;
}

async function drainQueue(startedAt: number, hop: number, baseUrl: string) {
  const supabase = createAdminClient();
  const workerName = `campaign-worker-${crypto.randomUUID()}`;
  const hardDeadline = startedAt + LIMITE_MS;

  // Jobs presos que já gastaram todas as tentativas viram 'failed' (visíveis), não somem.
  const { error: exhaustError } = await supabase.rpc("fail_exhausted_generation_jobs");
  if (exhaustError) console.error("Erro ao encerrar jobs esgotados:", exhaustError);

  const summary = { processed: 0, skipped: 0, cancelled: 0, failures: [] as Array<{ jobId: string; error: string }> };
  let outOfTime = false;

  // Um job por vez, conferindo o orçamento ANTES de cada reserva (antes: pares de jobs e
  // conferência só antes do par — o 2º job podia estourar o limite da função).
  for (;;) {
    if (hardDeadline - Date.now() < MINIMO_POR_JOB_MS) {
      outOfTime = true;
      break;
    }

    const { data: jobs, error: claimError } = await supabase.rpc("claim_due_generation_jobs", {
      worker_name: workerName,
      maximum_jobs: 1,
    });
    if (claimError) {
      console.error("Falha ao reclamar jobs:", claimError);
      break;
    }
    const job = (jobs as JobRow[] | null)?.[0];
    if (!job) break;

    const aiDeadline = Math.min(Date.now() + IA_MAXIMO_MS, hardDeadline - MARGEM_GRAVACAO_MS);
    try {
      const outcome = await processJob(supabase, job, workerName, aiDeadline);
      if (outcome.kind === "completed") {
        summary.processed++;
      } else if (outcome.kind === "skipped") {
        await releaseJob(supabase, job.id, workerName, {
          status: "completed",
          completed_at: new Date().toISOString(),
          error_message: null,
          result: { skipped: true, reason: outcome.reason, period: outcome.period ?? null },
        });
        summary.skipped++;
      } else {
        await releaseJob(supabase, job.id, workerName, {
          status: "cancelled",
          completed_at: new Date().toISOString(),
          error_message: outcome.reason,
          result: { skipped: true, reason: outcome.reason },
        });
        summary.cancelled++;
      }
    } catch (jobError) {
      const errorMessage = jobError instanceof Error ? jobError.message : "Erro desconhecido";
      // Nova tentativa com espera crescente: 5 min depois da 1ª falha, 10 depois da 2ª,
      // 20 depois da 3ª (e assim por diante). Quando a falha é a da ÚLTIMA tentativa
      // (attempts >= max_attempts), o job vira 'failed' e não volta para a fila.
      const retryAt = new Date(Date.now() + 5 * 60 * 1000 * 2 ** Math.max(0, job.attempts - 1)).toISOString();
      const exhausted = job.attempts >= job.max_attempts;

      // Filtra pelo dono: se a gravação foi concluída por outro caminho, nada é desfeito.
      await releaseJob(supabase, job.id, workerName, {
        status: exhausted ? "failed" : "queued",
        scheduled_for: retryAt,
        error_message: errorMessage,
      });

      summary.failures.push({ jobId: job.id, error: errorMessage });
      console.error(`Erro ao processar job ${job.id}:`, jobError);
    }
  }

  // Sem tempo e com fila pendente: dispara a próxima rodada em vez de esperar o próximo cron.
  if (outOfTime && hop < MAX_WORKER_HOPS) {
    await fireWorker(baseUrl, hop + 1);
  }
  console.info(`Worker ${workerName} (rodada ${hop}):`, JSON.stringify({ ...summary, outOfTime }));
}

export async function POST(request: Request) {
  // CRON_SECRET: exigido sempre que definido (ver isInternalRequest).
  if (!isInternalRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const startedAt = Date.now();
  const hop = Math.max(0, Number(request.headers.get("x-worker-hop")) || 0);
  const baseUrl = appBaseUrl(request);

  try {
    createAdminClient(); // falha de configuração aparece na resposta, não só no log
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Erro desconhecido" },
      { status: 500 },
    );
  }

  // Responde já: quem disparou (cron, tela) não espera a IA. O processamento continua
  // depois da resposta, limitado pelo maxDuration desta função.
  after(() =>
    drainQueue(startedAt, hop, baseUrl).catch((error) => console.error("Erro no worker de geração:", error)),
  );

  return NextResponse.json({ success: true, accepted: true, hop }, { status: 202 });
}
