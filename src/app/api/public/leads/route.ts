import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { VISITOR_COOKIE, clientIp, decodeGeo, hashIp, isUuid, isValidSlug } from "@/lib/marketing/tracking";

// ROTA PÚBLICA — recebe leads sem login:
//   * do formulário hospedado /f/<slug>
//   * do formulário do próprio site do cliente (envio cross-origin com o parâmetro "oml")
// Proteções: validação estrita, campo isca contra robô, limite de envios por IP e por
// link (limiteDeEnvios), e o link precisa existir e estar ativo. Nada é lido de volta.

const MAX_POR_IP_10MIN = 5;
const MAX_POR_LINK_1MIN = 20;

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
    oml: z.string().trim().refine(isValidSlug, "Link inválido"),
    oml_vid: z.string().optional(),
    name: optionalText(120),
    email: z
      .string()
      .trim()
      .max(160)
      .optional()
      .transform((value) => (value ? value.toLowerCase() : undefined))
      .refine((value) => !value || z.string().email().safeParse(value).success, "E-mail inválido"),
    phone: optionalText(40),
    zip: optionalText(12),
    message: optionalText(2000),
    consent: z.boolean().optional(),
    consentText: optionalText(600),
    // Campo isca: invisível para pessoas. Robô que preenche é descartado em silêncio.
    website: z.string().optional(),
  })
  .refine((data) => data.name || data.email || data.phone, "Informe nome, e-mail ou telefone.");

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

async function limiteDeEnvios(
  supabase: ReturnType<typeof createAdminClient>,
  ipHash: string | null,
  linkId: string,
) {
  const [porIp, porLink] = await Promise.all([
    ipHash
      ? supabase
          .from("leads")
          .select("id", { count: "exact", head: true })
          .eq("ip_hash", ipHash)
          .gte("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString())
      : Promise.resolve({ count: 0 }),
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("link_id", linkId)
      .gte("created_at", new Date(Date.now() - 60 * 1000).toISOString()),
  ]);
  return (porIp.count ?? 0) >= MAX_POR_IP_10MIN || (porLink.count ?? 0) >= MAX_POR_LINK_1MIN;
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

  const supabase = createAdminClient();
  const { data: link } = await supabase
    .from("tracking_links")
    .select("id, organization_id, client_id, active, expires_at, mode")
    .eq("slug", data.oml)
    .maybeSingle();

  if (!link || !link.active || (link.expires_at && new Date(link.expires_at) < new Date())) {
    return json({ error: "This form is no longer available." }, 404);
  }

  const headers = request.headers;
  const salt = process.env.TRACKING_SALT ?? process.env.CRON_SECRET ?? "";
  const ipHash = await hashIp(clientIp(headers.get("x-forwarded-for"), headers.get("x-real-ip")), salt);

  if (await limiteDeEnvios(supabase, ipHash, link.id)) {
    return json({ error: "Too many submissions. Please try again in a few minutes." }, 429);
  }

  const cookieVisitor = headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === VISITOR_COOKIE)?.[1];
  const visitorId = isUuid(data.oml_vid) ? data.oml_vid : isUuid(cookieVisitor) ? cookieVisitor : null;

  const { error } = await supabase.from("leads").insert({
    organization_id: link.organization_id,
    client_id: link.client_id,
    link_id: link.id,
    source_type: link.mode === "form" ? "hosted_form" : "tracked_link",
    visitor_id: visitorId,
    name: data.name ?? null,
    email: data.email ?? null,
    phone: data.phone ?? null,
    zip: data.zip ?? null,
    message: data.message ?? null,
    consent_marketing: Boolean(data.consent),
    consent_text: data.consent ? data.consentText ?? null : null,
    ip_hash: ipHash,
    // Sem clique encontrado, a cidade vem da geolocalização do próprio envio.
    city: decodeGeo(headers.get("x-vercel-ip-city")),
    state: decodeGeo(headers.get("x-vercel-ip-country-region")),
  });

  if (error) {
    console.error("Falha ao gravar lead público:", error.message);
    return json({ error: "We could not save your request. Please try again." }, 500);
  }

  return json({ success: true });
}
