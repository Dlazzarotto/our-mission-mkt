import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { DRAFT_LIMITS, MAX_HASHTAGS, sanitizeDraft, type DraftItem } from "@/lib/campaigns/draft";
import {
  applyQuotaWindows,
  checkQuotas,
  enforceQuotas,
  normalizeScheduledAt,
  splitQuotaPlan,
  type QuotaLine,
} from "@/lib/campaigns/period";
import {
  CHANNELS,
  CONTENT_FORMATS,
  CONTENT_OBJECTIVES,
  type AiCampaignDraft,
  type BrandPalette,
  type Channel,
  type ClientContract,
  type ContentFormat,
  type ContentObjective,
  type VisualStyle,
} from "@/lib/domain";

// ------------------------------------------------------------------
// Orçamento de cada chamada à IA.
//
// Antes: uma chamada só, max_tokens 7000 (um lote mensal de ~17 peças passa
// disso), timeout 90s × 3 tentativas ≈ 275s contra uma função de 300s.
// Agora: o lote é dividido em pedaços de até ITENS_POR_CHAMADA peças, chamados em
// paralelo com streaming (sem limite de tempo HTTP por resposta longa), e TODAS as
// chamadas obedecem a um prazo absoluto (`deadlineMs`) recebido do worker.
// ------------------------------------------------------------------
const ITENS_POR_CHAMADA = 6;
const CHAMADAS_PARALELAS = 5;
// Pior caso por peça ≈ 2.500 tokens (legenda 3.000 + briefing 1.800 + prompt 1.800 + roteiro 2.500
// caracteres). 6 peças ≈ 15k; folga para o JSON e o resumo.
const MAX_TOKENS_POR_CHAMADA = 24_000;
// Menos que isso de prazo não vale começar a chamada: ela seria abortada no meio.
const PRAZO_MINIMO_MS = 25_000;

const channelSchema = z.enum(CHANNELS);
const formatSchema = z.enum(CONTENT_FORMATS);
const objectiveSchema = z.enum(CONTENT_OBJECTIVES);

const L = DRAFT_LIMITS;
const text = ([min, max]: readonly [number, number]) => z.string().min(min).max(max);

// Schema enviado à API (structured outputs). Os limites de tamanho viram apenas
// descrição para o modelo — NÃO são garantidos. A validação real é sanitizeDraft
// (src/lib/campaigns/draft.ts), que corta em vez de derrubar o lote.
const campaignDraftWireSchema = z.object({
  campaignName: text(L.campaignName),
  campaignGoal: text(L.campaignGoal),
  summary: text(L.summary),
  contentItems: z
    .array(
      z.object({
        title: text(L.title),
        concept: text(L.concept),
        hook: text(L.hook),
        cta: text(L.cta),
        scheduledAt: text(L.scheduledAt),
        channel: channelSchema,
        format: formatSchema,
        objective: objectiveSchema,
        pillar: text(L.pillar),
        caption: text(L.caption),
        hashtags: z.array(text(L.hashtag)).max(MAX_HASHTAGS),
        creativeBrief: text(L.creativeBrief),
        imagePrompt: text(L.imagePrompt),
        videoScript: text(L.videoScript),
      }),
    )
    .min(1),
});

// Só o JSON Schema: sem o `parse` automático do SDK, que lançava erro de parse ANTES
// de o código olhar stop_reason (refusal/max_tokens nunca eram reconhecidos).
const DRAFT_OUTPUT_FORMAT = {
  type: "json_schema" as const,
  schema: zodOutputFormat(campaignDraftWireSchema).schema,
};

export type CampaignGenerationInput = {
  client: {
    companyName: string;
    industry: string;
    service: string;
    region: string;
    differentiators: string[];
    marketingMaturity?: string | null;
  };
  brandKit: {
    palette: BrandPalette;
    visualStyle: VisualStyle;
    toneOfVoice: string;
    requiredTerms: string[];
    forbiddenTerms: string[];
    preferredCta?: string | null;
  };
  contract: Pick<
    ClientContract,
    | "market"
    | "timezone"
    | "deliveryRules"
    | "specialDateRules"
    | "approvalRequired"
  >;
  period: {
    startsAt: string;
    endsAt: string;
    days: number;
  };
  /** Quantas peças cada canal/formato deve ter NESTE lote (calculado pela aplicação, não pela IA). */
  quotas: QuotaLine[];
  /** Peças extras permitidas por formato (datas especiais isExtra no período). */
  extras: Record<string, number>;
  /** Idioma do conteúdo final. Padrão: en-US (o consumidor final dos clientes é dos EUA). */
  language?: "pt-BR" | "en-US" | "es-ES";
};

export type CampaignGenerationResult = {
  /** Peças já normalizadas: scheduledAt em ISO UTC dentro do período, cotas respeitadas. */
  draft: AiCampaignDraft;
  /** Cotas que a IA entregou abaixo do pedido (aviso, não erro). */
  shortfalls: string[];
  /** Peças descartadas/cortadas na normalização (aviso, não erro). */
  warnings: string[];
};

export type CampaignGenerationOptions = {
  /** Instante (epoch ms) em que TODAS as chamadas precisam ter terminado. */
  deadlineMs: number;
};

export async function generateCampaignDraft(
  input: CampaignGenerationInput,
  options: CampaignGenerationOptions,
): Promise<CampaignGenerationResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY não configurada no ambiente do servidor.");
  }

  const chunks = splitQuotaPlan(input.quotas, input.extras, ITENS_POR_CHAMADA);
  if (chunks.length === 0) throw new Error("Nada a gerar: o plano de cotas está vazio.");

  // maxRetries baixo: uma nova tentativa só se couber no prazo (o `signal` corta tudo no deadline).
  const anthropic = new Anthropic({ apiKey, maxRetries: 1 });
  const fallbacks = {
    campaignName: `${input.client.companyName} · ${input.period.startsAt}`,
    campaignGoal: `Conteúdo do período ${input.period.startsAt} a ${input.period.endsAt}`,
    summary: `Lote de conteúdo de ${input.client.companyName} para ${input.period.startsAt} a ${input.period.endsAt}.`,
  };

  const results = await runPool(chunks, CHAMADAS_PARALELAS, (chunk, index) =>
    generateChunk(anthropic, model, input, chunk, index, chunks.length, options.deadlineMs, fallbacks),
  );

  const warnings = results.flatMap((r) => r.dropped);
  const merged: DraftItem[] = results.flatMap((r) => r.draft.contentItems);

  // Cota é da aplicação: excedente é cortado (antes derrubava o lote inteiro).
  const { kept, dropped: excess } = enforceQuotas(merged, input.quotas, input.extras);
  if (excess > 0) warnings.push(`${excess} peça(s) acima da cota descartada(s)`);

  // Datas: dia local do contrato dentro do período; cota mensal presa ao próprio mês.
  const timezone = input.contract.timezone;
  const scheduled = applyQuotaWindows(
    kept.map((item, index) => ({ ...item, scheduledAt: normalizeScheduledAt(item.scheduledAt, index, input.period, timezone) })),
    input.quotas,
    timezone,
  );

  const { shortfalls } = checkQuotas(scheduled, input.quotas, input.extras);
  const head = results[0].draft;
  const draft = {
    campaignName: head.campaignName,
    campaignGoal: head.campaignGoal,
    summary: head.summary,
    // Canal/formato/objetivo já conferidos contra os enums em sanitizeDraft.
    contentItems: scheduled,
  } as AiCampaignDraft;

  return { draft, shortfalls, warnings };
}

/** Executa no máximo `limit` tarefas ao mesmo tempo, preservando a ordem do resultado. */
async function runPool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

async function generateChunk(
  anthropic: Anthropic,
  model: string,
  input: CampaignGenerationInput,
  chunk: { quotas: QuotaLine[]; extras: Record<string, number> },
  index: number,
  total: number,
  deadlineMs: number,
  fallbacks: { campaignName: string; campaignGoal: string; summary: string },
) {
  const remaining = deadlineMs - Date.now();
  if (remaining < PRAZO_MINIMO_MS) {
    throw new Error(`Sem tempo para chamar a IA (restam ${Math.round(remaining / 1000)}s). O job volta para a fila.`);
  }

  let message: Anthropic.Message;
  try {
    const stream = anthropic.messages.stream(
      {
        model,
        max_tokens: MAX_TOKENS_POR_CHAMADA,
        system: buildSystemPrompt(input.language ?? "en-US"),
        messages: [{ role: "user", content: buildCampaignPrompt(input, chunk, index, total) }],
        output_config: { format: DRAFT_OUTPUT_FORMAT },
      },
      {
        // O timeout do SDK cobre só até os cabeçalhos; o signal corta o streaming inteiro no prazo.
        timeout: Math.min(remaining, 60_000),
        signal: AbortSignal.timeout(remaining),
      },
    );
    message = await stream.finalMessage();
  } catch (error) {
    if (error instanceof Anthropic.APIUserAbortError || (error instanceof Error && error.name === "TimeoutError")) {
      throw new Error(`A IA não terminou dentro do prazo (${Math.round(remaining / 1000)}s) — parte ${index + 1}/${total}.`);
    }
    if (error instanceof Anthropic.APIError) {
      throw new Error(`Erro da API da IA (${error.status ?? "rede"}) — parte ${index + 1}/${total}: ${error.message}`);
    }
    throw error;
  }

  // stop_reason ANTES de qualquer parse.
  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category ? ` (categoria: ${message.stop_details.category})` : "";
    throw new Error(`A IA recusou gerar este conteúdo${category}. Revise o contexto do cliente e do brand kit.`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error(
      `A resposta da IA foi cortada no limite de ${MAX_TOKENS_POR_CHAMADA} tokens (parte ${index + 1}/${total}). ` +
        `Reduza o tamanho dos textos pedidos ou a quantidade de peças por chamada.`,
    );
  }
  if (message.stop_reason !== "end_turn" && message.stop_reason !== "stop_sequence") {
    throw new Error(`A IA parou de forma inesperada (stop_reason: ${message.stop_reason ?? "desconhecido"}).`);
  }

  const raw = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`A IA devolveu JSON inválido (parte ${index + 1}/${total}).`);
  }

  return sanitizeDraft(parsed, { channels: CHANNELS, formats: CONTENT_FORMATS, objectives: CONTENT_OBJECTIVES }, fallbacks);
}

function buildSystemPrompt(language: string) {
  return [
    "Você é um estrategista de marketing digital sênior que atende pequenas e médias empresas.",
    `Gere todo o conteúdo voltado ao público (títulos, legendas, hooks, CTAs, roteiros) no idioma ${language}.`,
    "O público final dos clientes está nos EUA: use referências dos EUA (LLC, EIN, Schedule C, IRS) e nunca conceitos brasileiros (MEI, CNPJ, Simples Nacional).",
    "Em setores regulados (tributário, financeiro, saúde, jurídico), não afirme regra, prazo ou valor específico: convide o público a falar com o profissional.",
    "Respeite rigorosamente o Brand Kit, as quotas contratuais e as restrições de marca fornecidas.",
    "Crie apenas rascunhos: nunca prometa publicação automática, descontos não autorizados, resultados garantidos ou alegações não verificáveis.",
    "Para foto/carrossel, escreva um briefing criativo e um prompt visual sem texto embutido na imagem.",
    "Para reel/vídeo, inclua um roteiro claro de até 45 segundos no campo videoScript.",
    "Retorne strings vazias para imagePrompt ou videoScript quando o formato não exigir o campo.",
    "Não use termos proibidos. Inclua os termos obrigatórios somente quando forem naturais e relevantes.",
    "Cada peça pertence a um conceito (campo concept). Peças que adaptam a mesma ideia para canais ou formatos diferentes DEVEM repetir exatamente o mesmo texto em concept — é assim que o sistema mede qual ideia gera leads.",
    "Preencha hook (a frase de abertura da peça) e cta (a chamada para ação). Varie hooks e CTAs entre peças do mesmo conceito para que possam ser comparados.",
    "Respeite os tamanhos máximos indicados no schema: textos maiores serão cortados.",
  ].join("\n");
}

function buildCampaignPrompt(
  input: CampaignGenerationInput,
  chunk: { quotas: QuotaLine[]; extras: Record<string, number> },
  index: number,
  total: number,
) {
  const brand = input.brandKit;
  const contract = input.contract;

  const specialDates = contract.specialDateRules
    .filter((rule) => rule.enabled)
    .filter((rule) => rule.eventDate >= input.period.startsAt && rule.eventDate <= input.period.endsAt)
    .map((rule) => ({
      label: rule.label,
      date: rule.eventDate,
      quantity: rule.quantity,
      format: rule.format,
      isExtra: rule.isExtra,
    }));

  return JSON.stringify(
    {
      task:
        total > 1
          ? `Criar a parte ${index + 1} de ${total} de uma campanha editorial para o período solicitado (as outras partes são geradas separadamente; crie apenas as peças desta parte).`
          : "Criar uma campanha editorial completa para o período solicitado.",
      period: input.period,
      client: input.client,
      brandKit: {
        palette: brand.palette,
        visualStyle: brand.visualStyle,
        toneOfVoice: brand.toneOfVoice,
        requiredTerms: brand.requiredTerms,
        forbiddenTerms: brand.forbiddenTerms,
        preferredCta: brand.preferredCta ?? "",
      },
      contract: {
        market: contract.market,
        timezone: contract.timezone,
        approvalRequired: contract.approvalRequired,
        quotasForThisPeriod: chunk.quotas,
        extrasAllowedByFormat: chunk.extras,
        specialDates,
      },
      rules: [
        "Crie EXATAMENTE a quantidade de peças indicada em quotasForThisPeriod para cada canal e formato — nem mais, nem menos. Peças extras só para datas especiais marcadas como isExtra=true, até extrasAllowedByFormat.",
        "Caso uma data especial isExtra=false coincida com uma quota regular, ela deve substituir uma peça regular, não aumentar a entrega.",
        "Distribua as peças em datas do período e retorne scheduledAt em ISO 8601 com o offset do fuso do contrato (ex.: 2026-10-03T10:00:00-04:00).",
        "Quando uma quota tiver 'window', agende essas peças somente entre window.startsAt e window.endsAt.",
        "Varie pilares e objetivos para evitar repetição.",
        "Gere hashtags apenas para redes sociais; para e-mail, Google Business e WhatsApp, retorne lista vazia.",
        "Cada título deve ser específico, acionável e compatível com o contexto local do cliente.",
      ],
    },
    null,
    2,
  );
}

// Exportações tipadas facilitam o uso na rota e mantêm os enums do domínio consistentes.
export type AiChannel = Channel;
export type AiContentFormat = ContentFormat;
export type AiContentObjective = ContentObjective;
