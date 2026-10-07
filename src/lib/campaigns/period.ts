// ============================================================
// Período, cadência e cotas da geração de campanhas.
//
// Lógica PURA (sem imports, sem banco, só sintaxe TypeScript apagável):
// é usada pelo cron, pelo worker e pela IA, e testada diretamente pelo Node
// (scripts/testes.js e tests/unit). Uma regra, um lugar.
// ============================================================

export type Cadence = "weekly" | "monthly";

export type Period = {
  /** AAAA-MM-DD, inclusivo */
  startsAt: string;
  /** AAAA-MM-DD, inclusivo */
  endsAt: string;
  days: number;
};

export type QuotaRule = {
  channel: string;
  format: string;
  quantity: number;
  period: "week" | "month";
  objective?: string;
};

export type ExtraRule = {
  format: string;
  quantity: number;
  isExtra: boolean;
  enabled: boolean;
  eventDate: string;
};

export type QuotaLine = {
  channel: string;
  format: string;
  quantity: number;
  objective: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

function utcMidnight(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysInMonth(year: number, monthIndex: number) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Soma meses sem pular mês curto: 31/jan + 1 mês = 28 (ou 29)/fev, nunca 03/mar.
 * O dia original é preservado quando o mês de destino comporta.
 */
export function addMonthsClamped(date: Date, months: number, anchorDay?: number) {
  const day = anchorDay ?? date.getUTCDate();
  const result = new Date(date.getTime());
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  result.setUTCDate(Math.min(day, daysInMonth(result.getUTCFullYear(), result.getUTCMonth())));
  return result;
}

/** Janela de conteúdo de um lote: 7 dias no semanal, um mês-calendário corrido no mensal. */
export function periodFor(targetDate: string | Date | null | undefined, cadence: Cadence, now = new Date()): Period {
  const parsed = targetDate ? new Date(targetDate) : now;
  const start = utcMidnight(Number.isNaN(parsed.getTime()) ? now : parsed);
  const end =
    cadence === "monthly"
      ? new Date(addMonthsClamped(start, 1).getTime() - DAY_MS)
      : new Date(start.getTime() + 6 * DAY_MS);
  return {
    startsAt: isoDay(start),
    endsAt: isoDay(end),
    days: Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1,
  };
}

/** Próxima data de geração depois de `current`, respeitando a cadência. */
export function advanceGeneration(current: string | Date, cadence: Cadence, anchorDay?: number) {
  const date = new Date(current);
  if (cadence === "monthly") return addMonthsClamped(date, 1, anchorDay);
  return new Date(date.getTime() + 7 * DAY_MS);
}

/**
 * Decide o lote a gerar agora e a próxima data. Se o cron ficou parado por
 * semanas, NÃO gera conteúdo para o passado: pula para o ciclo atual e agenda
 * o próximo no futuro (mantendo o dia-âncora do contrato no mensal).
 */
export function planDispatch(nextGenerationAt: string, cadence: Cadence, now = new Date(), contractAnchorDay?: number) {
  // Dia-âncora do contrato (ex.: começou dia 31): depois de cair em 28/fev, março volta ao dia 31.
  const anchorDay = contractAnchorDay ?? new Date(nextGenerationAt).getUTCDate();
  let target = new Date(nextGenerationAt);
  let next = advanceGeneration(target, cadence, anchorDay);
  let skipped = 0;
  while (next.getTime() <= now.getTime()) {
    target = next;
    next = advanceGeneration(next, cadence, anchorDay);
    skipped++;
    if (skipped > 600) break; // proteção: nunca laço infinito
  }
  return { target: target.toISOString(), next: next.toISOString(), skippedCycles: skipped };
}

/**
 * A IA devolve scheduledAt como texto livre; data inválida ou fora do período
 * quebrava o insert e queimava as tentativas do job. Normaliza antes de gravar.
 * Tolerância de 24h nas bordas por causa do fuso (00:00 em NY = 04:00Z).
 */
export function normalizeScheduledAt(rawValue: string, index: number, period: { startsAt: string; endsAt: string; days?: number }) {
  const TOLERANCIA_FUSO_MS = DAY_MS;
  const inicio = new Date(`${period.startsAt}T00:00:00Z`).getTime() - TOLERANCIA_FUSO_MS;
  const fim = new Date(`${period.endsAt}T23:59:59Z`).getTime() + TOLERANCIA_FUSO_MS;
  const totalDias = period.days ?? Math.round((new Date(`${period.endsAt}T00:00:00Z`).getTime() - new Date(`${period.startsAt}T00:00:00Z`).getTime()) / DAY_MS) + 1;

  // Fallback espalha as peças pelo período inteiro (no mensal, não só na 1ª semana).
  const fallback = new Date(`${period.startsAt}T13:00:00Z`);
  fallback.setUTCDate(fallback.getUTCDate() + (index % Math.max(1, totalDias)));

  const parsed = new Date(rawValue);
  if (Number.isNaN(parsed.getTime())) return fallback.toISOString();

  const instante = parsed.getTime();
  if (instante < inicio || instante > fim) return fallback.toISOString();
  return parsed.toISOString();
}

/** Dias do mês que restam a partir de `startsAt`, incluindo o próprio dia. */
export function daysLeftInMonth(startsAt: string) {
  const d = new Date(`${startsAt}T00:00:00Z`);
  return daysInMonth(d.getUTCFullYear(), d.getUTCMonth()) - d.getUTCDate() + 1;
}

/** Chave canal|formato usada para contar cotas. */
export function quotaKey(channel: string, format: string) {
  return `${channel}|${format}`;
}

/**
 * Quantas peças cada regra do contrato pede NESTE lote.
 *
 * - Regra semanal: quantidade × semanas do período (semanal = exata; mensal ≈ 4,3 semanas).
 * - Regra mensal num lote MENSAL: a quantidade cheia.
 * - Regra mensal num lote SEMANAL: o que ainda falta no mês dividido pelos lotes
 *   semanais que restam no mês — o mês fecha certo mesmo com 4 ou 5 lotes.
 *   `alreadyThisMonth` = peças daquele canal/formato já geradas no mês (fora rejeitadas).
 */
export function quotaPlan(
  rules: QuotaRule[],
  period: Period,
  cadence: Cadence,
  alreadyThisMonth: Record<string, number> = {},
): QuotaLine[] {
  const lines: QuotaLine[] = [];
  for (const rule of rules) {
    if (!rule || !(rule.quantity > 0)) continue;
    let quantity: number;
    if (rule.period === "week") {
      quantity = Math.round((rule.quantity * period.days) / 7);
    } else if (cadence === "monthly") {
      quantity = rule.quantity;
    } else {
      const remaining = Math.max(0, rule.quantity - (alreadyThisMonth[quotaKey(rule.channel, rule.format)] ?? 0));
      const batchesLeft = Math.max(1, Math.ceil(daysLeftInMonth(period.startsAt) / 7));
      quantity = Math.ceil(remaining / batchesLeft);
    }
    if (quantity > 0) {
      lines.push({ channel: rule.channel, format: rule.format, quantity, objective: rule.objective ?? "flexible" });
    }
  }
  return lines;
}

/** Peças EXTRAS permitidas por formato (datas especiais com isExtra dentro do período). */
export function extraAllowance(specials: ExtraRule[], period: { startsAt: string; endsAt: string }) {
  const allowance: Record<string, number> = {};
  for (const rule of specials) {
    if (!rule?.enabled || !rule.isExtra) continue;
    if (rule.eventDate < period.startsAt || rule.eventDate > period.endsAt) continue;
    allowance[rule.format] = (allowance[rule.format] ?? 0) + Math.max(0, rule.quantity);
  }
  return allowance;
}

/**
 * Confere o rascunho da IA contra as cotas. Excesso = erro (o job tenta de novo);
 * falta = aviso registrado no resultado do job (não perde o lote inteiro).
 */
export function checkQuotas(
  items: Array<{ channel: string; format: string }>,
  plan: QuotaLine[],
  extras: Record<string, number>,
) {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = quotaKey(item.channel, item.format);
    counts[key] = (counts[key] ?? 0) + 1;
  }

  const planned: Record<string, number> = {};
  for (const line of plan) planned[quotaKey(line.channel, line.format)] = (planned[quotaKey(line.channel, line.format)] ?? 0) + line.quantity;

  const overflowByFormat: Record<string, number> = {};
  const shortfalls: string[] = [];
  for (const key of new Set([...Object.keys(counts), ...Object.keys(planned)])) {
    const made = counts[key] ?? 0;
    const expected = planned[key] ?? 0;
    const format = key.split("|")[1];
    if (made > expected) overflowByFormat[format] = (overflowByFormat[format] ?? 0) + (made - expected);
    if (made < expected) shortfalls.push(`${key}: ${made}/${expected}`);
  }

  const errors: string[] = [];
  for (const [format, overflow] of Object.entries(overflowByFormat)) {
    const allowed = extras[format] ?? 0;
    if (overflow > allowed) errors.push(`${format}: ${overflow} peça(s) além da cota (extras permitidos: ${allowed})`);
  }
  return { errors, shortfalls, counts };
}
