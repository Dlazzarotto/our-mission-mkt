import { NextResponse } from "next/server";
import { z } from "zod";
import { consumeRateLimit, loadPublicLink, type AdminClient } from "@/lib/marketing/public-link";
import {
  FORM_LANGUAGES,
  VISITOR_COOKIE,
  clientIp,
  consentText,
  decodeGeo,
  hashIp,
  ipRateLimitKey,
  isUuid,
  isValidSlug,
  resolveTrackingSalt,
} from "@/lib/marketing/tracking";

// ROTA PÚBLICA — recebe leads sem login:
//   * do formulário hospedado /f/<slug>
//   * do formulário do próprio site do cliente (envio cross-origin com o parâmetro "oml")
// Proteções: validação estrita (e-mail ou telefone obrigatório), campo isca contra robô,
// link e cliente precisam estar ativos, e limite de envios (limiteDeEnvios) ATÔMICO no
// banco (consume_rate_limit — sem corrida entre contar e gravar):
//   * por IP (IPv6 agrupado por /64): estourou → 429
//   * por link: estourou o normal → o lead é GRAVADO em quarentena (status "spam"), para que
//     um ataque ao link não bloqueie clientes de verdade; estourou o teto duro → 429
//   * limite impossível de verificar (sem sal em produção, função fora do ar) → quarentena
// O texto de consentimento gravado é montado AQUI (mesma função do /f) e só para o formulário
// hospedado; o texto enviado pelo navegador é sempre ignorado.

const MAX_POR_IP_10MIN = 5;
const MAX_POR_LINK_1MIN = 20;
const TETO_POR_LINK_10MIN = 200;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));

const requestSchema = z
  .object({
    oml: z.string().trim().refine(isValidSlug, "Invalid link."),
    oml_vid: z.string().optional(),
    lang: z.enum(FORM_LANGUAGES).optional().catch(undefined),
    name: optionalText(120),
    email: z
      .string()
      .trim()
      .max(160)
      .optional()
      .transform((value) => (value ? value.toLowerCase() : undefined))
      .refine((value) => !value || z.string().email().safeParse(value).success, "Invalid email."),
    phone: optionalText(40),
    zip: optionalText(12),
    message: optionalText(2000),
    consent: z.boolean().optional(),
    // Campo isca: invisível para pessoas. Robô que preenche é descartado em silêncio.
    website: z.string().optional(),
  })
  // Igual ao formulário: sem e-mail nem telefone não há como responder ao lead.
  .refine((data) => data.email || data.phone, "Please enter your email or phone so we can reach you.");

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

type Limite = { decision: "ok" } | { decision: "blocked" } | { decision: "quarantine"; reason: string };

async function limiteDeEnvios(supabase: AdminClient, ipHash: string | null, saltOk: boolean, linkId: string): Promise<Limite> {
  const reasons: string[] = [];

  if (!saltOk) {
    reasons.push("limite por IP indisponível (TRACKING_SALT ausente)");
  } else {
    const porIp = await consumeRateLimit(supabase, `lead-ip:${ipHash ?? "sem-ip"}`, 10 * 60, MAX_POR_IP_10MIN);
    if (porIp === false) return { decision: "blocked" };
    if (porIp === null) reasons.push("limite por IP indisponível");
  }

  const teto = await consumeRateLimit(supabase, `lead-link-teto:${linkId}`, 10 * 60, TETO_POR_LINK_10MIN);
  if (teto === false) return { decision: "blocked" };
  const porLink = await consumeRateLimit(supabase, `lead-link:${linkId}`, 60, MAX_POR_LINK_1MIN);
  if (teto === null || porLink === null) reasons.push("limite por link indisponível");
  else if (porLink === false) reasons.push("limite de envios do link excedido");

  return reasons.length > 0 ? { decision: "quarantine", reason: reasons.join("; ") } : { decision: "ok" };
}

export async function POST(request: Request) {
  let raw: unknown;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    raw = contentType.includes("application/json")
      ? await request.json()
      : Object.fromEntries((await request.formData()).entries());
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  const parsed = requestSchema.safeParse(
    raw && typeof raw === "object" && "consent" in raw && typeof raw.consent === "string"
      ? { ...raw, consent: raw.consent === "true" || raw.consent === "on" }
      : raw,
  );
  if (!parsed.success) {
    return json({ error: parsed.error.issues[0]?.message ?? "Invalid data." }, 400);
  }
  const data = parsed.data;

  // Robô preencheu a isca: responde "ok" para não ensinar o robô, mas não grava.
  if (data.website && data.website.trim() !== "") return json({ success: true });

  const resolved = await loadPublicLink(data.oml);
  if (resolved.status === "missing") return json({ error: "This form is no longer available." }, 404);
  if (resolved.status === "error") return json({ error: "We could not save your request. Please try again." }, 503);
  const { supabase, link, companyName } = resolved;

  const headers = request.headers;
  const salt = resolveTrackingSalt(process.env);
  const ipHash = salt
    ? await hashIp(ipRateLimitKey(clientIp(headers.get("x-forwarded-for"), headers.get("x-real-ip"))), salt)
    : null;
  if (!salt) console.error("TRACKING_SALT e CRON_SECRET ausentes em produção: leads públicos vão para quarentena.");

  const limite = await limiteDeEnvios(supabase, ipHash, Boolean(salt), link.id);
  if (limite.decision === "blocked") {
    return json({ error: "Too many submissions. Please try again in a few minutes." }, 429);
  }

  const cookieVisitor = headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === VISITOR_COOKIE)?.[1];
  const visitorId = isUuid(data.oml_vid) ? data.oml_vid : isUuid(cookieVisitor) ? cookieVisitor : null;

  const sourceType = link.mode === "form" ? "hosted_form" : "tracked_link";
  const { error } = await supabase.from("leads").insert({
    organization_id: link.organization_id,
    client_id: link.client_id,
    link_id: link.id,
    source_type: sourceType,
    visitor_id: visitorId,
    name: data.name ?? null,
    email: data.email ?? null,
    phone: data.phone ?? null,
    zip: data.zip ?? null,
    message: data.message ?? null,
    consent_marketing: Boolean(data.consent),
    // Só gravamos como prova o texto que a pessoa VIU: no formulário hospedado (/f) é o nosso
    // (mesma função). Vindo do site do cliente, o texto exibido lá não é verificável → null.
    consent_text: data.consent && sourceType === "hosted_form" ? consentText(data.lang, companyName) : null,
    ip_hash: ipHash,
    // Quarentena: fica visível para a agência (status "Spam") e fora das métricas.
    status: limite.decision === "quarantine" ? "spam" : "new",
    notes: limite.decision === "quarantine" ? `Quarentena automática: ${limite.reason}. Confira e mude a etapa se for real.` : null,
    // Cidade do envio (geolocalização do IP). O banco usa a do clique só quando esta vier vazia.
    city: decodeGeo(headers.get("x-vercel-ip-city")),
    state: decodeGeo(headers.get("x-vercel-ip-country-region")),
  });

  if (error) {
    console.error("Falha ao gravar lead público:", error.message);
    return json({ error: "We could not save your request. Please try again." }, 500);
  }

  return json({ success: true });
}
