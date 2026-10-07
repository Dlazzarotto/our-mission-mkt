// ============================================================
// Período, cadência, fuso e cotas da geração de campanhas.
//
// Lógica PURA (sem imports, sem banco, só sintaxe TypeScript apagável):
// é usada pelo cron, pelo worker, pela fila manual e pela IA, e testada
// diretamente pelo Node (scripts/testes.js). Uma regra, um lugar.
//
// Convenções:
//  * Datas de período (startsAt/endsAt) são dias-calendário AAAA-MM-DD, inclusivos,
//    derivados do dia UTC do alvo (next_generation_at). A cadeia de períodos é
//    CONTÍNUA: fim + 1 dia = início do próximo alvo (nunca lacuna, nunca sobreposição).
//  * Horário de peça (scheduledAt) é interpretado no FUSO DO CONTRATO
//    (client_contracts.timezone, padrão America/New_York): a peça pertence ao dia
//    local em que será publicada.
// ============================================================

export type Cadence = "weekly" | "monthly";

export type Period = {
  /** AAAA-MM-DD, inclusivo */
  startsAt: string;
  /** AAAA-MM-DD, inclusivo */
  endsAt: string;
  days: number;
};

export type DayWindow = { startsAt: string; endsAt: string };

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
  /**
   * Dias em que ESTAS peças podem ser agendadas (cota mensal num lote semanal que
   * cruza a virada do mês: a cota de outubro não pode cair em novembro).
   * Ausente = o período inteiro.
   */
  window?: DayWindow;
};

export const DEFAULT_TIMEZONE = "America/New_York";

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

function utcMidnight(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dayToDate(day: string) {
  return new Date(`${day}T00:00:00Z`);
}

function addDays(day: string, days: number) {
  return isoDay(new Date(dayToDate(day).getTime() + days * DAY_MS));
}

function daysBetweenInclusive(startsAt: string, endsAt: string) {
  return Math.round((dayToDate(endsAt).getTime() - dayToDate(startsAt).getTime()) / DAY_MS) + 1;
}

function daysInMonth(year: number, monthIndex: number) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function validAnchor(anchorDay: number | undefined, fallback: number) {
  const day = Number(anchorDay);
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : fallback;
}

/**
 * Dia-âncora da cadência mensal = dia de início do contrato (client_contracts.starts_at,
 * AAAA-MM-DD). Cron, worker e pedido manual usam ESTA função: âncoras diferentes
 * entre eles abriam lacunas no calendário.
 */
export function contractAnchorDay(startsAt: string | null | undefined) {
  const day = Number(String(startsAt ?? "").slice(8, 10));
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : undefined;
}

/** Período gravado no payload do job (cron/manual), validado; null se ausente ou inválido. */
export function periodFromPayload(payload: unknown): Period | null {
  if (!payload || typeof payload !== "object" || !("period" in payload)) return null;
  const period = (payload as { period?: unknown }).period;
  if (!period || typeof period !== "object") return null;
  const { startsAt, endsAt } = period as { startsAt?: unknown; endsAt?: unknown };
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof startsAt !== "string" || typeof endsAt !== "string" || !day.test(startsAt) || !day.test(endsAt)) return null;
  if (Number.isNaN(dayToDate(startsAt).getTime()) || Number.isNaN(dayToDate(endsAt).getTime()) || endsAt < startsAt) return null;
  return { startsAt, endsAt, days: daysBetweenInclusive(startsAt, endsAt) };
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

/**
 * Primeira ocorrência do dia-âncora ESTRITAMENTE depois do dia de `date`
 * (âncora 31 em fevereiro = último dia de fevereiro). Mantém a hora de `date`.
 *
 *   07/out, âncora 31 → 31/out      31/jan, âncora 31 → 28/fev (29 em ano bissexto)
 *   28/fev, âncora 31 → 31/mar      15/mar, âncora 15 → 15/abr
 */
export function nextAnchorAfter(date: Date, anchorDay: number) {
  const anchor = validAnchor(anchorDay, date.getUTCDate());
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const sameMonth = Math.min(anchor, daysInMonth(year, month));
  const result = new Date(date.getTime());
  if (sameMonth > date.getUTCDate()) {
    result.setUTCDate(sameMonth);
    return result;
  }
  result.setUTCDate(1);
  result.setUTCMonth(month + 1);
  result.setUTCDate(Math.min(anchor, daysInMonth(result.getUTCFullYear(), result.getUTCMonth())));
  return result;
}

/** Última ocorrência do dia-âncora no próprio dia de `date` ou antes dele. */
function anchorOnOrBefore(date: Date, anchorDay: number) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const sameMonth = Math.min(anchorDay, daysInMonth(year, month));
  if (sameMonth <= date.getUTCDate()) return new Date(Date.UTC(year, month, sameMonth));
  const prev = new Date(Date.UTC(year, month - 1, 1));
  return new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), Math.min(anchorDay, daysInMonth(prev.getUTCFullYear(), prev.getUTCMonth()))));
}

/** Próxima data de geração depois de `current`, respeitando a cadência e o dia-âncora do contrato. */
export function advanceGeneration(current: string | Date, cadence: Cadence, anchorDay?: number) {
  const date = new Date(current);
  if (cadence === "monthly") return nextAnchorAfter(date, validAnchor(anchorDay, date.getUTCDate()));
  return new Date(date.getTime() + 7 * DAY_MS);
}

/**
 * Janela de conteúdo de um lote: 7 dias no semanal; no mensal, do alvo até a
 * VÉSPERA do próximo alvo calculado com o MESMO dia-âncora usado pelo cron
 * (planDispatch). Assim a cadeia é contínua mesmo com âncora 29–31 e mesmo
 * quando o 1º disparo não cai no dia-âncora (contrato com início 31/ago criado
 * em 07/out: 07/out–30/out, depois 31/out–29/nov, 30/nov–30/dez...).
 */
export function periodFor(
  targetDate: string | Date | null | undefined,
  cadence: Cadence,
  now = new Date(),
  anchorDay?: number,
): Period {
  const parsed = targetDate ? new Date(targetDate) : now;
  const start = utcMidnight(Number.isNaN(parsed.getTime()) ? now : parsed);
  const end =
    cadence === "monthly"
      ? new Date(nextAnchorAfter(start, validAnchor(anchorDay, start.getUTCDate())).getTime() - DAY_MS)
      : new Date(start.getTime() + 6 * DAY_MS);
  return {
    startsAt: isoDay(start),
    endsAt: isoDay(end),
    days: Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1,
  };
}

/**
 * Decide o lote a gerar agora e a próxima data. Se o cron ficou parado por
 * semanas, NÃO gera conteúdo para o passado: pula para o ciclo atual e agenda
 * o próximo no futuro (mantendo o dia-âncora do contrato no mensal).
 */
export function planDispatch(nextGenerationAt: string, cadence: Cadence, now = new Date(), contractAnchorDay?: number) {
  // Dia-âncora do contrato (ex.: começou dia 31): depois de cair em 28/fev, março volta ao dia 31.
  const anchorDay = validAnchor(contractAnchorDay, new Date(nextGenerationAt).getUTCDate());
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
 * Período de um pedido MANUAL feito em `date`: do próprio dia (nunca o passado)
 * até o FIM do ciclo do contrato que contém `date`. O fim coincide com o do
 * cron para o mesmo ciclo — por isso a chave de idempotência (batchKey) usa o
 * fim do período: pedido manual e cron do mesmo ciclo nunca geram em dobro.
 *
 * Semanal: ciclos de 7 dias alinhados a next_generation_at.
 * Mensal: ciclos delimitados pelo dia-âncora.
 */
export function manualPeriodFor(
  date: string | Date,
  cadence: Cadence,
  nextGenerationAt: string | null | undefined,
  anchorDay?: number,
): Period {
  const parsed = new Date(date);
  const day = utcMidnight(Number.isNaN(parsed.getTime()) ? new Date() : parsed);
  let end: Date;
  if (cadence === "monthly") {
    end = new Date(nextAnchorAfter(day, validAnchor(anchorDay, day.getUTCDate())).getTime() - DAY_MS);
  } else {
    const ref = nextGenerationAt ? new Date(nextGenerationAt) : null;
    const gridStart = ref && !Number.isNaN(ref.getTime()) ? utcMidnight(ref) : day;
    const k = Math.floor((day.getTime() - gridStart.getTime()) / (7 * DAY_MS));
    end = new Date(gridStart.getTime() + (k * 7 + 6) * DAY_MS);
  }
  return {
    startsAt: isoDay(day),
    endsAt: isoDay(end),
    days: Math.round((end.getTime() - day.getTime()) / DAY_MS) + 1,
  };
}

/**
 * Chave de idempotência ÚNICA do lote (cron e pedido manual): contrato + fim do
 * ciclo. Antes eram 'batch_<contrato>_<alvo>' (cron) e 'manual-content-batch:...'
 * (manual) — o mesmo período podia ser gerado duas vezes.
 */
export function batchKey(contractId: string, period: { endsAt: string }) {
  return `content_batch:${contractId}:${period.endsAt}`;
}

// ------------------------------------------------------------
// Fuso horário (Intl, sem biblioteca)
// ------------------------------------------------------------

/** Fuso IANA válido ou o padrão do sistema (mesmo default do banco). */
export function safeTimeZone(timeZone: string | null | undefined) {
  for (const candidate of [timeZone, DEFAULT_TIMEZONE]) {
    if (!candidate) continue;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: candidate });
      return candidate;
    } catch {
      // fuso inválido: tenta o próximo
    }
  }
  return "UTC";
}

/** Diferença (ms) entre o relógio local do fuso e UTC no instante dado. */
function tzOffsetMs(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Instante UTC do relógio de parede `day hh:mm:ss` no fuso dado (trata horário de verão). */
export function zonedTimeToUtc(day: string, time: string, timeZone: string) {
  const tz = safeTimeZone(timeZone);
  const [hh = 0, mm = 0, ss = 0] = (time || "00:00:00").split(":").map((v) => Number(v) || 0);
  const wall = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), hh, mm, Math.floor(ss));
  let guess = wall - tzOffsetMs(wall, tz);
  guess = wall - tzOffsetMs(guess, tz);
  return new Date(guess);
}

/** Dia-calendário (AAAA-MM-DD) do instante no fuso dado. */
export function localDayOf(instant: Date | string | number, timeZone: string) {
  const ms = new Date(instant).getTime();
  return isoDay(new Date(ms + tzOffsetMs(ms, safeTimeZone(timeZone))));
}

const ISO_DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_LOCAL = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * A IA devolve scheduledAt como texto livre; data inválida ou fora do período
 * quebrava o insert ou caía no dia errado. Regras:
 *  * "2026-10-03" (só data)            → meio-dia no fuso do contrato (nunca vira o dia anterior nos EUA)
 *  * "2026-10-03T09:00" (sem offset)   → 09:00 no fuso do contrato
 *  * "2026-10-03T09:00-04:00" / "...Z" → instante exato
 *  * qualquer outro formato            → inválido
 * A peça só é aceita se o DIA LOCAL (fuso do contrato) estiver dentro do período —
 * sem tolerância de ±24h que deixava passar peça de outro período.
 * Inválida/fora → dia (início + índice) do período às 10:00 locais, espalhando
 * as peças pelo período inteiro.
 */
export function normalizeScheduledAt(
  rawValue: string,
  index: number,
  period: { startsAt: string; endsAt: string; days?: number },
  timeZone: string = DEFAULT_TIMEZONE,
) {
  const tz = safeTimeZone(timeZone);
  const totalDias = Math.max(1, period.days ?? daysBetweenInclusive(period.startsAt, period.endsAt));
  const fallback = () =>
    zonedTimeToUtc(addDays(period.startsAt, Math.abs(index) % totalDias), "10:00:00", tz).toISOString();

  const raw = typeof rawValue === "string" ? rawValue.trim() : "";
  let instant: number;
  if (ISO_DAY_ONLY.test(raw)) {
    instant = zonedTimeToUtc(raw, "12:00:00", tz).getTime();
  } else if (ISO_LOCAL.test(raw)) {
    const [, day, time] = raw.match(ISO_LOCAL) as RegExpMatchArray;
    instant = zonedTimeToUtc(day, time, tz).getTime();
  } else if (ISO_WITH_ZONE.test(raw)) {
    instant = new Date(raw).getTime();
  } else {
    return fallback();
  }
  if (Number.isNaN(instant)) return fallback();

  const dia = localDayOf(instant, tz);
  if (dia < period.startsAt || dia > period.endsAt) return fallback();
  return new Date(instant).toISOString();
}

/** Instante UTC de 00:00 do dia no fuso do contrato (limites de consulta no banco). */
export function dayStartUtc(day: string, timeZone: string) {
  return zonedTimeToUtc(day, "00:00:00", timeZone).toISOString();
}

/** Dias do mês que restam a partir de `startsAt`, incluindo o próprio dia. */
export function daysLeftInMonth(startsAt: string) {
  const d = new Date(`${startsAt}T00:00:00Z`);
  return daysInMonth(d.getUTCFullYear(), d.getUTCMonth()) - d.getUTCDate() + 1;
}

function lastDayOfMonth(day: string) {
  const d = dayToDate(day);
  return isoDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), daysInMonth(d.getUTCFullYear(), d.getUTCMonth()))));
}

/** Chave canal|formato usada para contar cotas. */
export function quotaKey(channel: string, format: string) {
  return `${channel}|${format}`;
}

/**
 * Quantas peças cada regra do contrato pede NESTE lote.
 *
 * - Regra semanal: quantidade × semanas do período (semanal = exata; mensal ≈ 4,3 semanas).
 * - Regra mensal num lote MENSAL: a quantidade cheia; se o período for um ciclo
 *   PARCIAL (1º disparo fora do dia-âncora, ex. 07/out–30/out com âncora 31),
 *   proporcional aos dias do ciclo cheio.
 * - Regra mensal num lote SEMANAL: o que ainda falta no mês dividido pelos lotes
 *   semanais que restam no mês — o mês fecha certo mesmo com 4 ou 5 lotes. As
 *   peças ficam presas aos dias do MÊS dentro do período (`window`).
 *   `alreadyThisMonth` = peças daquele canal/formato já geradas no mês (fora rejeitadas).
 */
export function quotaPlan(
  rules: QuotaRule[],
  period: Period,
  cadence: Cadence,
  alreadyThisMonth: Record<string, number> = {},
  anchorDay?: number,
): QuotaLine[] {
  const lines: QuotaLine[] = [];
  for (const rule of rules) {
    if (!rule || !(rule.quantity > 0)) continue;
    let quantity: number;
    let window: DayWindow | undefined;
    if (rule.period === "week") {
      quantity = Math.round((rule.quantity * period.days) / 7);
    } else if (cadence === "monthly") {
      const start = dayToDate(period.startsAt);
      const anchor = validAnchor(anchorDay, start.getUTCDate());
      const cycleStart = anchorOnOrBefore(start, anchor);
      const fullDays = Math.round((nextAnchorAfter(cycleStart, anchor).getTime() - cycleStart.getTime()) / DAY_MS);
      quantity = period.days >= fullDays ? rule.quantity : Math.round((rule.quantity * period.days) / fullDays);
    } else {
      const remaining = Math.max(0, rule.quantity - (alreadyThisMonth[quotaKey(rule.channel, rule.format)] ?? 0));
      const batchesLeft = Math.max(1, Math.ceil(daysLeftInMonth(period.startsAt) / 7));
      quantity = Math.ceil(remaining / batchesLeft);
      const monthEnd = lastDayOfMonth(period.startsAt);
      if (monthEnd < period.endsAt) window = { startsAt: period.startsAt, endsAt: monthEnd };
    }
    if (quantity > 0) {
      lines.push({
        channel: rule.channel,
        format: rule.format,
        quantity,
        objective: rule.objective ?? "flexible",
        ...(window ? { window } : {}),
      });
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
 * Confere o rascunho da IA contra as cotas. Excesso = erro; falta = aviso
 * registrado no resultado do job (não perde o lote inteiro).
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

/**
 * A cota é da aplicação, nunca da IA: em vez de descartar o lote inteiro quando a
 * IA entrega a mais, mantém as primeiras peças até a cota (+ extras do formato)
 * e descarta o excedente, registrando quantas.
 */
export function enforceQuotas<T extends { channel: string; format: string }>(
  items: T[],
  plan: QuotaLine[],
  extras: Record<string, number>,
) {
  const remaining: Record<string, number> = {};
  for (const line of plan) remaining[quotaKey(line.channel, line.format)] = (remaining[quotaKey(line.channel, line.format)] ?? 0) + line.quantity;
  const extraLeft: Record<string, number> = { ...extras };
  const kept: T[] = [];
  let dropped = 0;
  for (const item of items) {
    const key = quotaKey(item.channel, item.format);
    if ((remaining[key] ?? 0) > 0) {
      remaining[key]--;
      kept.push(item);
    } else if ((extraLeft[item.format] ?? 0) > 0) {
      extraLeft[item.format]--;
      kept.push(item);
    } else {
      dropped++;
    }
  }
  return { kept, dropped };
}

/**
 * Divide o plano em pedaços de até `maxPerChunk` peças (cada pedaço = uma
 * chamada à IA, em paralelo): um lote mensal de 17+ peças numa chamada só
 * estourava max_tokens e o tempo da função. Extras vão no primeiro pedaço.
 */
export function splitQuotaPlan(plan: QuotaLine[], extras: Record<string, number>, maxPerChunk: number) {
  const size = Math.max(1, Math.floor(maxPerChunk));
  const chunks: Array<{ quotas: QuotaLine[]; extras: Record<string, number> }> = [];
  let current: QuotaLine[] = [];
  let used = 0;
  for (const line of plan) {
    let left = line.quantity;
    while (left > 0) {
      const take = Math.min(left, size - used);
      current.push({ ...line, quantity: take });
      used += take;
      left -= take;
      if (used >= size) {
        chunks.push({ quotas: current, extras: {} });
        current = [];
        used = 0;
      }
    }
  }
  if (current.length > 0) chunks.push({ quotas: current, extras: {} });
  const hasExtras = Object.values(extras).some((n) => n > 0);
  if (chunks.length === 0 && hasExtras) chunks.push({ quotas: [], extras: {} });
  if (chunks.length > 0) chunks[0].extras = { ...extras };
  return chunks;
}

/**
 * Prende as peças de cota mensal (lote semanal na virada do mês) aos dias do mês
 * dentro do período: sem isso a cota de outubro caía em novembro e o mês não fechava.
 * Peças fora da janela são remarcadas para dentro dela (dia local do contrato).
 */
export function applyQuotaWindows<T extends { channel: string; format: string; scheduledAt: string }>(
  items: T[],
  plan: QuotaLine[],
  timeZone: string,
): T[] {
  const tz = safeTimeZone(timeZone);
  const need: Record<string, { window: DayWindow; count: number }> = {};
  for (const line of plan) {
    if (!line.window) continue;
    const key = quotaKey(line.channel, line.format);
    need[key] = { window: line.window, count: (need[key]?.count ?? 0) + line.quantity };
  }
  if (Object.keys(need).length === 0) return items;

  const inWindow = (item: T, w: DayWindow) => {
    const day = localDayOf(item.scheduledAt, tz);
    return day >= w.startsAt && day <= w.endsAt;
  };
  const result = items.map((item) => ({ ...item }));
  for (const [key, { window, count }] of Object.entries(need)) {
    const sameKey = result.filter((item) => quotaKey(item.channel, item.format) === key);
    let missing = count - sameKey.filter((item) => inWindow(item, window)).length;
    let spread = 0;
    for (const item of sameKey) {
      if (missing <= 0) break;
      if (inWindow(item, window)) continue;
      item.scheduledAt = normalizeScheduledAt("", spread++, window, tz);
      missing--;
    }
  }
  return result;
}
