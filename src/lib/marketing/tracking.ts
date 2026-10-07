// ============================================================
// Rastreamento de links e captação pública — utilitários PUROS
// (sem banco, sem imports de alias): testados direto pelo Node.
// ============================================================

/** Nome do cookie do visitante (no domínio da agência). */
export const VISITOR_COOKIE = "omm_vid";
/** Parâmetros que o link acrescenta no site do cliente para fechar a atribuição. */
export const SLUG_PARAM = "oml";
export const VISITOR_PARAM = "oml_vid";

const SLUG_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"; // sem 0/O/1/l/I

/** Slug curto e não sequencial (ninguém adivinha o link de outro cliente). */
export function generateSlug(length = 8, random: (n: number) => Uint8Array = randomBytes) {
  const bytes = random(length);
  let slug = "";
  for (let i = 0; i < length; i++) slug += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  return slug;
}

function randomBytes(n: number) {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function isValidSlug(slug: string) {
  return /^[A-Za-z0-9_-]{4,40}$/.test(slug);
}

const BOT_PATTERN =
  /bot|crawl|spider|slurp|facebookexternalhit|facebookcatalog|whatsapp|telegrambot|twitterbot|linkedinbot|slackbot|discordbot|embedly|pinterestbot|skypeuripreview|preview|headless|lighthouse|curl|wget|python-requests|axios|node-fetch|go-http-client/i;

/**
 * Pré-visualização de link (WhatsApp, Facebook, LinkedIn...) também "clica".
 * Esses acessos são gravados, mas marcados como robô e fora das métricas.
 */
export function isBot(userAgent: string | null | undefined) {
  if (!userAgent || userAgent.trim().length < 8) return true;
  return BOT_PATTERN.test(userAgent);
}

export function detectDevice(userAgent: string | null | undefined): "mobile" | "tablet" | "desktop" | "bot" | "unknown" {
  if (isBot(userAgent)) return "bot";
  const ua = userAgent ?? "";
  if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/i.test(ua)) return "tablet";
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(ua)) return "mobile";
  if (/windows|macintosh|linux|cros/i.test(ua)) return "desktop";
  return "unknown";
}

/** Primeiro IP real da cadeia de proxies. */
export function clientIp(forwardedFor: string | null, realIp: string | null) {
  const first = forwardedFor?.split(",")[0]?.trim();
  return first || realIp?.trim() || null;
}

/** Hash com sal: identifica repetição (limite de envio) sem guardar o IP. */
export async function hashIp(ip: string | null, salt: string) {
  if (!ip) return null;
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** Cabeçalhos de geolocalização da Vercel vêm codificados (ex.: "S%C3%A3o%20Paulo"). */
export function decodeGeo(value: string | null) {
  if (!value) return null;
  try {
    return decodeURIComponent(value).slice(0, 120);
  } catch {
    return value.slice(0, 120);
  }
}

export type UtmFields = {
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
};

/**
 * Monta a URL de destino com UTMs e o identificador do link.
 * Nunca sobrescreve um parâmetro que o próprio destino já traz.
 */
export function buildDestination(destination: string, utm: UtmFields, slug: string, visitorId: string | null) {
  const url = new URL(destination);
  const params: Record<string, string | null | undefined> = {
    ...utm,
    [SLUG_PARAM]: slug,
    [VISITOR_PARAM]: visitorId,
  };
  for (const [key, value] of Object.entries(params)) {
    if (value && !url.searchParams.has(key)) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Destino aceito: só https e sem credenciais embutidas. */
export function isSafeDestination(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.hostname.includes(".");
  } catch {
    return false;
  }
}

export function isUuid(value: string | null | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

/** Divisão segura para indicadores: sem base = sem dado (null), nunca zero inventado. */
export function ratio(numerator: number | null | undefined, denominator: number | null | undefined, digits = 4) {
  if (numerator === null || numerator === undefined || !denominator) return null;
  const factor = 10 ** digits;
  return Math.round((numerator / denominator) * factor) / factor;
}
