import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { checkQuotas, type QuotaLine } from "@/lib/campaigns/period";
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

// Uma fonte só: os canais/formatos aceitos da IA são exatamente os do domínio (e do enum do banco).
const channelSchema = z.enum(CHANNELS);
const formatSchema = z.enum(CONTENT_FORMATS);
const objectiveSchema = z.enum(CONTENT_OBJECTIVES);

// Todos os campos são obrigatórios: quando não se aplicarem, a IA deve devolver string vazia.
// Isso reduz ambiguidade, simplifica a persistência e evita schema complexo.
const campaignDraftSchema = z.object({
  campaignName: z.string().min(3).max(120),
  campaignGoal: z.string().min(10).max(420),
  summary: z.string().min(20).max(1000),
  contentItems: z
    .array(
      z.object({
        title: z.string().min(4).max(180),
        concept: z.string().min(3).max(300),
        hook: z.string().max(300),
        cta: z.string().max(200),
        scheduledAt: z.string().min(10).max(64),
        channel: channelSchema,
        format: formatSchema,
        objective: objectiveSchema,
        pillar: z.string().min(3).max(80),
        caption: z.string().min(20).max(3000),
        hashtags: z.array(z.string().min(2).max(80)).max(25),
        creativeBrief: z.string().min(20).max(1800),
        imagePrompt: z.string().max(1800),
        videoScript: z.string().max(2500),
      }),
    )
    .min(1)
    .max(40),
});

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
  language?: "pt-BR" | "en-US" | "es-ES";
};

export type CampaignGenerationResult = {
  draft: AiCampaignDraft;
  /** Cotas que a IA entregou abaixo do pedido (aviso, não erro). */
  shortfalls: string[];
};

export async function generateCampaignDraft(
  input: CampaignGenerationInput,
): Promise<CampaignGenerationResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY não configurada no ambiente do servidor.");
  }

  const anthropic = new Anthropic({
    apiKey,
    timeout: 90_000,
    maxRetries: 2,
  });

  const response = await anthropic.messages.parse({
    model,
    max_tokens: 7000,
    system: buildSystemPrompt(input.language ?? "pt-BR"),
    messages: [
      {
        role: "user",
        content: buildCampaignPrompt(input),
      },
    ],
    output_config: {
      format: zodOutputFormat(campaignDraftSchema),
    },
  });

  if (response.stop_reason === "refusal") {
    throw new Error("A IA recusou a geração deste conteúdo. Revise o contexto do pedido.");
  }

  if (response.stop_reason === "max_tokens") {
    throw new Error("A resposta da IA excedeu o limite de tokens. Reduza a quantidade de peças no contrato.");
  }

  const draft = response.parsed_output;
  if (!draft) {
    throw new Error("A IA não devolveu um rascunho estruturado válido.");
  }

  // Excesso de peças = erro (o job tenta de novo); falta = aviso guardado no resultado do job.
  const { errors, shortfalls } = checkQuotas(draft.contentItems, input.quotas, input.extras);
  if (errors.length > 0) {
    throw new Error(`A IA excedeu a cota contratada — ${errors.join("; ")}`);
  }

  return { draft, shortfalls };
}

function buildSystemPrompt(language: string) {
  return [
    "Você é um estrategista de marketing digital sênior que atende pequenas e médias empresas.",
    `Gere conteúdo no idioma ${language}.`,
    "Respeite rigorosamente o Brand Kit, as quotas contratuais e as restrições de marca fornecidas.",
    "Crie apenas rascunhos: nunca prometa publicação automática, descontos não autorizados, resultados garantidos ou alegações não verificáveis.",
    "Para foto/carrossel, escreva um briefing criativo e um prompt visual sem texto embutido na imagem.",
    "Para reel/vídeo, inclua um roteiro claro de até 45 segundos no campo videoScript.",
    "Retorne strings vazias para imagePrompt ou videoScript quando o formato não exigir o campo.",
    "Não use termos proibidos. Inclua os termos obrigatórios somente quando forem naturais e relevantes.",
    "Cada peça pertence a um conceito (campo concept). Peças que adaptam a mesma ideia para canais ou formatos diferentes DEVEM repetir exatamente o mesmo texto em concept — é assim que o sistema mede qual ideia gera leads.",
    "Preencha hook (a frase de abertura da peça) e cta (a chamada para ação). Varie hooks e CTAs entre peças do mesmo conceito para que possam ser comparados.",
  ].join("\n");
}

function buildCampaignPrompt(input: CampaignGenerationInput) {
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
      task: "Criar uma campanha editorial completa para o período solicitado.",
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
        quotasForThisPeriod: input.quotas,
        specialDates,
      },
      rules: [
        "Crie EXATAMENTE a quantidade de peças indicada em quotasForThisPeriod para cada canal e formato — nem mais, nem menos. Peças extras só para datas especiais marcadas como isExtra=true.",
        "Caso uma data especial isExtra=false coincida com uma quota regular, ela deve substituir uma peça regular, não aumentar a entrega.",
        "Distribua as peças em datas do período e retorne scheduledAt em ISO 8601 com offset do fuso do contrato.",
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
