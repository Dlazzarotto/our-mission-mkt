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

// Robô = nome terminado em "bot" seguido de versão/traço ("Googlebot/2.1", "AdsBot-Google"),
// URL de contato no UA ("+http://..."), "compatible; ...bot" ou um nome conhecido.
// NUNCA casar "bot" solto: o celular CUBOT ("Android 10; CUBOT X30") é gente.
const BOT_PATTERN =
  /bot\/|bot-|\+https?:\/\/|compatible;[^)]*bot|crawl|spider|slurp|mediapartners-google|facebookexternalhit|facebookcatalog|meta-externalagent|whatsapp|telegrambot|twitterbot|linkedinbot|slackbot|discordbot|embedly|skypeuripreview|bingpreview|headless|lighthouse|curl\/|wget|python-requests|python-urllib|axios|node-fetch|go-http-client/i;

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

/**
 * Chave de limite por IP: IPv4 inteiro; IPv6 agrupado pelo prefixo /64 (um único
 * aparelho/casa recebe um /64 inteiro e trocaria de endereço a cada envio).
 * IPv4 embutido em IPv6 (::ffff:1.2.3.4) vira o IPv4. Inválido = null.
 */
export function ipRateLimitKey(ip: string | null | undefined) {
  if (!ip) return null;
  let value = ip.trim().toLowerCase();
  if (value.startsWith("[")) value = value.slice(1, value.indexOf("]") > 0 ? value.indexOf("]") : undefined);
  value = value.split("%")[0];
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d+)?$/;
  const v4 = value.match(ipv4);
  if (v4) return v4.slice(1, 5).every((part) => Number(part) <= 255) ? `v4:${v4.slice(1, 5).map(Number).join(".")}` : null;
  if (!value.includes(":")) return null;

  const mapped = value.match(/^(?:0{0,4}:){0,5}(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped && value.startsWith("::")) return ipRateLimitKey(mapped[1]);

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return `v6:${groups
    .slice(0, 4)
    .map((group) => group.padStart(4, "0"))
    .join(":")}::/64`;
}

/**
 * Sal do hash de IP. Sem TRACKING_SALT nem CRON_SECRET em produção devolve null
 * (falha fechada: quem chama não grava hash nem confia no limite por IP). Fora de
 * produção usa um sal fixo de desenvolvimento.
 */
export function resolveTrackingSalt(env: Record<string, string | undefined>) {
  const salt = env.TRACKING_SALT?.trim() || env.CRON_SECRET?.trim();
  if (salt) return salt;
  return env.NODE_ENV === "production" ? null : "dev-only-tracking-salt";
}

/** Hash com sal: identifica repetição (limite de envio) sem guardar o IP. Sem sal = null. */
export async function hashIp(ip: string | null, salt: string | null) {
  if (!ip || !salt) return null;
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
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;

export function buildDestination(destination: string, utm: UtmFields, slug: string, visitorId: string | null) {
  const url = new URL(destination);
  // Só as 5 UTMs: quem chama costuma passar a linha inteira do link (id, organization_id,
  // client_id...) e nada disso pode vazar para o site do cliente.
  const params: Record<string, string | null | undefined> = {
    [SLUG_PARAM]: slug,
    [VISITOR_PARAM]: visitorId,
  };
  for (const key of UTM_KEYS) params[key] = utm[key];
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

// ------------------------------------------------------------
// Consentimento — texto ÚNICO, usado na tela (/f) e gravado pelo servidor como prova.
// O servidor nunca aceita o texto vindo do navegador.
// ------------------------------------------------------------
export const FORM_LANGUAGES = ["en", "es", "pt"] as const;
export type FormLanguage = (typeof FORM_LANGUAGES)[number];

const CONSENT_TEMPLATES: Record<FormLanguage, { text: string; fallback: string }> = {
  en: { text: "I agree to receive messages and offers from {company}. I can opt out at any time.", fallback: "this company" },
  es: { text: "Acepto recibir mensajes y ofertas de {company}. Puedo cancelar en cualquier momento.", fallback: "esta empresa" },
  pt: { text: "Aceito receber mensagens e ofertas de {company}. Posso cancelar a qualquer momento.", fallback: "esta empresa" },
};

export function formLanguage(value: unknown): FormLanguage {
  return value === "pt" || value === "es" ? value : "en";
}

export function consentText(language: unknown, companyName: string | null | undefined) {
  const template = CONSENT_TEMPLATES[formLanguage(language)];
  const company = companyName?.trim() || template.fallback;
  return template.text.replace("{company}", company);
}

// ------------------------------------------------------------
// Números digitados à mão (valor em dinheiro, contagens)
// ------------------------------------------------------------
export const MAX_MONEY = 100_000_000;

/**
 * Valor em dinheiro digitado em qualquer formato comum:
 * "1500", "1500.50", "1,500.50", "1.500,50", "1500,50", "$1,500", "R$ 1.500,00".
 * O último separador seguido de 1–2 dígitos é o decimal; "1.500" e "1,500" (grupos de 3)
 * são milhar. Inválido, negativo, mais de 2 casas ou acima do teto = null.
 */
export function parseMoney(input: unknown): number | null {
  if (typeof input === "number") {
    return Number.isFinite(input) && input >= 0 && input <= MAX_MONEY ? Math.round(input * 100) / 100 : null;
  }
  if (typeof input !== "string") return null;
  const value = input.replace(/(us|r)?\$|usd|brl|\s/gi, "");
  if (!/^\d[\d.,]*$/.test(value) && !/^[.,]\d{1,2}$/.test(value)) return null;

  let normalized: string;
  const lastDot = value.lastIndexOf(".");
  const lastComma = value.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    const [integerPart, decimalPart, ...rest] = value.split(decimal);
    if (rest.length > 0) return null;
    if (!new RegExp(`^\\d{1,3}(\\${thousands}\\d{3})*$`).test(integerPart)) return null;
    normalized = `${integerPart.split(thousands).join("")}.${decimalPart}`;
  } else {
    const separator = lastDot >= 0 ? "." : lastComma >= 0 ? "," : null;
    if (!separator) normalized = value;
    else if (new RegExp(`^\\d{1,3}(\\${separator}\\d{3})+$`).test(value)) normalized = value.split(separator).join("");
    else {
      const parts = value.split(separator);
      if (parts.length !== 2) return null;
      normalized = `${parts[0] || "0"}.${parts[1]}`;
    }
  }
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount <= MAX_MONEY ? Math.round(amount * 100) / 100 : null;
}

/** Contagem inteira digitada ("1500", "1,500", "1.500", "1 500"). Fração ou texto = null. */
export function parseCount(input: unknown): number | null {
  if (typeof input === "number") return Number.isInteger(input) && input >= 0 ? input : null;
  if (typeof input !== "string") return null;
  const value = input.replace(/\s/g, "");
  if (/^\d+$/.test(value)) return Number(value);
  if (/^\d{1,3}([.,]\d{3})+$/.test(value) && !(value.includes(".") && value.includes(","))) {
    return Number(value.replace(/[.,]/g, ""));
  }
  return null;
}

/** Remove repetidos pela chave; a ÚLTIMA ocorrência vence (mesmo envio lançado duas vezes). */
export function dedupeBy<T>(rows: readonly T[], key: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) {
    const k = key(row);
    byKey.delete(k);
    byKey.set(k, row);
  }
  return Array.from(byKey.values());
}
