// ============================================================
// Normalização do rascunho devolvido pela IA.
//
// Lógica PURA (sem imports, só sintaxe TypeScript apagável), testada pelo Node
// em scripts/testes.js. Os limites de tamanho do JSON Schema viram só DESCRIÇÃO
// para a API (não são garantidos): antes o zod derrubava o lote inteiro por uma
// legenda 3 caracteres maior. Agora: corta/ajusta o que dá, descarta só a peça
// realmente inutilizável e registra o motivo.
// ============================================================

/** [mínimo, máximo] em caracteres (code points). Fonte única: o schema enviado à IA usa os mesmos. */
export const DRAFT_LIMITS = {
  campaignName: [3, 120],
  campaignGoal: [10, 420],
  summary: [20, 1000],
  title: [4, 180],
  // Mesmo limite do check do banco: char_length(trim(concept)) between 3 and 300.
  concept: [3, 300],
  hook: [0, 300],
  cta: [0, 200],
  scheduledAt: [0, 64],
  pillar: [3, 80],
  caption: [20, 3000],
  hashtag: [2, 80],
  creativeBrief: [0, 1800],
  imagePrompt: [0, 1800],
  videoScript: [0, 2500],
} as const;

export const MAX_HASHTAGS = 25;
export const MAX_ITEMS_PER_DRAFT = 40;

export type DraftItem = {
  title: string;
  concept: string;
  hook: string;
  cta: string;
  scheduledAt: string;
  channel: string;
  format: string;
  objective: string;
  pillar: string;
  caption: string;
  hashtags: string[];
  creativeBrief: string;
  imagePrompt: string;
  videoScript: string;
};

export type Draft = {
  campaignName: string;
  campaignGoal: string;
  summary: string;
  contentItems: DraftItem[];
};

export type DraftEnums = {
  channels: readonly string[];
  formats: readonly string[];
  objectives: readonly string[];
};

export type DraftFallbacks = {
  campaignName: string;
  campaignGoal: string;
  summary: string;
};

/** Corta por code point (nunca deixa meio emoji/surrogate, que o Postgres recusa). */
export function clipText(value: unknown, max: number) {
  const text = typeof value === "string" ? value.replace(/\u0000/g, "").trim() : "";
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : text;
}

function textLength(text: string) {
  return Array.from(text).length;
}

/**
 * Valida e normaliza o JSON da IA. Lança erro só se não sobrar nenhuma peça
 * utilizável; peças ruins são descartadas individualmente (`dropped`).
 */
export function sanitizeDraft(raw: unknown, enums: DraftEnums, fallbacks: DraftFallbacks) {
  if (!raw || typeof raw !== "object") throw new Error("A IA não devolveu um objeto JSON.");
  const source = raw as Record<string, unknown>;
  const L = DRAFT_LIMITS;
  const orFallback = (value: unknown, [min, max]: readonly [number, number], fallback: string) => {
    const text = clipText(value, max);
    return textLength(text) >= min ? text : clipText(fallback, max);
  };

  const dropped: string[] = [];
  const items: DraftItem[] = [];
  const rawItems = Array.isArray(source.contentItems) ? source.contentItems : [];

  rawItems.forEach((entry, index) => {
    if (items.length >= MAX_ITEMS_PER_DRAFT) {
      dropped.push(`peça ${index + 1}: acima do máximo de ${MAX_ITEMS_PER_DRAFT}`);
      return;
    }
    if (!entry || typeof entry !== "object") {
      dropped.push(`peça ${index + 1}: não é objeto`);
      return;
    }
    const it = entry as Record<string, unknown>;
    const channel = clipText(it.channel, 40);
    const format = clipText(it.format, 40);
    if (!enums.channels.includes(channel)) return void dropped.push(`peça ${index + 1}: canal inválido "${channel}"`);
    if (!enums.formats.includes(format)) return void dropped.push(`peça ${index + 1}: formato inválido "${format}"`);

    const title = clipText(it.title, L.title[1]);
    const caption = clipText(it.caption, L.caption[1]);
    if (textLength(title) < L.title[0]) return void dropped.push(`peça ${index + 1}: título vazio ou curto`);
    if (textLength(caption) < L.caption[0]) return void dropped.push(`peça ${index + 1}: legenda vazia ou curta`);

    const objectiveRaw = clipText(it.objective, 40);
    const objective = enums.objectives.includes(objectiveRaw) ? objectiveRaw : enums.objectives[0];
    // Conceito curto/vazio: usa o título (sempre ≥ 4) — a peça fica numa família própria.
    const concept = orFallback(it.concept, L.concept, title);
    const pillar = orFallback(it.pillar, L.pillar, "general");

    const seen = new Set<string>();
    const hashtags = (Array.isArray(it.hashtags) ? it.hashtags : [])
      .map((tag) => clipText(tag, L.hashtag[1]))
      .filter((tag) => textLength(tag) >= L.hashtag[0])
      .filter((tag) => (seen.has(tag.toLowerCase()) ? false : (seen.add(tag.toLowerCase()), true)))
      .slice(0, MAX_HASHTAGS);

    items.push({
      title,
      concept,
      hook: clipText(it.hook, L.hook[1]),
      cta: clipText(it.cta, L.cta[1]),
      scheduledAt: clipText(it.scheduledAt, L.scheduledAt[1]),
      channel,
      format,
      objective,
      pillar,
      caption,
      hashtags,
      creativeBrief: clipText(it.creativeBrief, L.creativeBrief[1]),
      imagePrompt: clipText(it.imagePrompt, L.imagePrompt[1]),
      videoScript: clipText(it.videoScript, L.videoScript[1]),
    });
  });

  if (items.length === 0) {
    throw new Error(`A IA não devolveu nenhuma peça utilizável${dropped.length ? ` (${dropped.slice(0, 5).join("; ")})` : ""}.`);
  }

  const draft: Draft = {
    campaignName: orFallback(source.campaignName, L.campaignName, fallbacks.campaignName),
    campaignGoal: orFallback(source.campaignGoal, L.campaignGoal, fallbacks.campaignGoal),
    summary: orFallback(source.summary, L.summary, fallbacks.summary),
    contentItems: items,
  };
  return { draft, dropped };
}

