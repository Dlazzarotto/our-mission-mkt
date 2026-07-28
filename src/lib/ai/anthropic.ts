import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type {
  AiCampaignDraft,
  BrandPalette,
  Channel,
  ClientContract,
  ContentFormat,
  ContentObjective,
  VisualStyle,
} from "@/lib/domain";

const channelSchema = z.enum([
  "instagram",
  "facebook",
  "google_business",
  "linkedin",
  "email",
  "whatsapp",
]);

const formatSchema = z.enum(["photo", "carousel", "reel", "story", "video", "email"]);
const objectiveSchema = z.enum([
  "attract",
  "educate",
  "social_proof",
  "convert",
  "retain",
  "engage",
]);

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
  };
  language?: "pt-BR" | "en-US" | "es-ES";
};

export async function generateCampaignDraft(
  input: CampaignGenerationInput,
): Promise<AiCampaignDraft> {
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

  validateDraftAgainstContract(draft, input.contract);

  return draft;
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
  ].join("\n");
}

function buildCampaignPrompt(input: CampaignGenerationInput) {
  const brand = input.brandKit;
  const contract = input.contract;

  const deliveryRules = contract.deliveryRules.map((rule) => ({
    channel: rule.channel,
    format: rule.format,
    quantity: rule.quantity,
    period: rule.period,
    objective: rule.objective ?? "flexible",
  }));

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
        deliveryRules,
        specialDates,
      },
      rules: [
        "Respeite exatamente a soma das quotas semanais e mensais aplicáveis ao período; não crie peças extras, exceto datas especiais marcadas como isExtra=true.",
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

function validateDraftAgainstContract(
  draft: AiCampaignDraft,
  contract: Pick<ClientContract, "deliveryRules" | "specialDateRules">,
) {
  const regularRules = contract.deliveryRules.filter((rule) => rule.quantity > 0);

  for (const rule of regularRules) {
    const maxQuantity = rule.period === "week" ? rule.quantity : rule.quantity;
    const count = draft.contentItems.filter(
      (item) => item.channel === rule.channel && item.format === rule.format,
    ).length;

    // Para o primeiro MVP, a geração é semanal: quotas mensais são tratadas como teto por lote.
    if (count > maxQuantity) {
      throw new Error(
        `A IA excedeu a quota contratada de ${rule.format} em ${rule.channel}: ${count}/${maxQuantity}.`,
      );
    }
  }
}

// Exportações tipadas facilitam o uso na rota e mantêm os enums do domínio consistentes.
export type AiChannel = Channel;
export type AiContentFormat = ContentFormat;
export type AiContentObjective = ContentObjective;
