import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  VISITOR_COOKIE,
  buildDestination,
  clientIp,
  decodeGeo,
  detectDevice,
  hashIp,
  isBot,
  isUuid,
  isValidSlug,
} from "@/lib/marketing/tracking";

// Link rastreável: /r/<slug>
// Grava o clique (cidade, aparelho, robô ou pessoa) e redireciona para o site do
// cliente com UTMs — ou para o formulário de captação hospedado (/f/<slug>).
// Público por natureza: quem clica num post não tem login. Só lê o link e grava o clique.

export const dynamic = "force-dynamic";

function unavailable() {
  return new NextResponse(
    "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Link unavailable</title><body style=\"font-family:system-ui;padding:48px 20px;text-align:center;color:#334155\"><h1 style=\"font-size:20px\">This link is no longer available.</h1></body></html>",
    { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isValidSlug(slug)) return unavailable();

  const supabase = createAdminClient();
  const { data: link } = await supabase
    .from("tracking_links")
    .select("id, organization_id, client_id, slug, mode, destination_url, active, expires_at, utm_source, utm_medium, utm_campaign, utm_content, utm_term")
    .eq("slug", slug)
    .maybeSingle();

  if (!link || !link.active || (link.expires_at && new Date(link.expires_at) < new Date())) {
    return unavailable();
  }

  const headers = request.headers;
  const userAgent = headers.get("user-agent");
  const cookieVisitor = headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === VISITOR_COOKIE)?.[1];
  const visitorId = isUuid(cookieVisitor) ? cookieVisitor : crypto.randomUUID();
  const bot = isBot(userAgent);

  const salt = process.env.TRACKING_SALT ?? process.env.CRON_SECRET ?? "";
  const { error: clickError } = await supabase.from("link_clicks").insert({
    organization_id: link.organization_id,
    client_id: link.client_id,
    link_id: link.id,
    visitor_id: bot ? null : visitorId,
    ip_hash: await hashIp(clientIp(headers.get("x-forwarded-for"), headers.get("x-real-ip")), salt),
    user_agent: userAgent?.slice(0, 400) ?? null,
    device: detectDevice(userAgent),
    is_bot: bot,
    referrer: headers.get("referer")?.slice(0, 500) ?? null,
    country: decodeGeo(headers.get("x-vercel-ip-country")),
    region: decodeGeo(headers.get("x-vercel-ip-country-region")),
    city: decodeGeo(headers.get("x-vercel-ip-city")),
  });
  // Falha ao gravar o clique NUNCA impede o visitante de chegar ao destino.
  if (clickError) console.error(`Falha ao registrar clique do link ${slug}:`, clickError.message);

  const target =
    link.mode === "form" || !link.destination_url
      ? new URL(`/f/${link.slug}`, request.url).toString()
      : buildDestination(link.destination_url, link, link.slug, bot ? null : visitorId);

  const response = NextResponse.redirect(target, 302);
  response.headers.set("cache-control", "no-store");
  if (!bot) {
    response.cookies.set(VISITOR_COOKIE, visitorId, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 90,
    });
  }
  return response;
}
