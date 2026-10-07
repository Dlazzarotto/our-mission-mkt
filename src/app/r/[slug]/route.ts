import { NextResponse } from "next/server";
import { consumeRateLimit, loadPublicLink, type AdminClient, type PublicLink } from "@/lib/marketing/public-link";
import {
  VISITOR_COOKIE,
  buildDestination,
  clientIp,
  decodeGeo,
  detectDevice,
  hashIp,
  ipRateLimitKey,
  isBot,
  isUuid,
  resolveTrackingSalt,
} from "@/lib/marketing/tracking";

// ROTA PÚBLICA — link rastreável: /r/<slug>
// Grava o clique (cidade, aparelho, robô ou pessoa) e redireciona para o site do
// cliente com UTMs — ou para o formulário de captação hospedado (/f/<slug>).
// Público por natureza: quem clica num post não tem login. Só lê o link e grava o clique.
// Limite de envios (consume_rate_limit, atômico no banco):
//   * mesmo visitante no mesmo link: 1 clique por 30 min (toque repetido / recarregar não infla)
//   * mesmo IP (/64 no IPv6) no mesmo link: no máximo MAX_CLIQUES_POR_IP_30MIN por 30 min
// Regra de ouro: o redirect SEMPRE acontece; falha ao gravar só vai para o log.
// HEAD (verificadores de link) só redireciona, sem gravar.

export const dynamic = "force-dynamic";

const JANELA_CLIQUE_S = 30 * 60;
const MAX_CLIQUES_POR_IP_30MIN = 10;

function page(title: string, status: number) {
  return new NextResponse(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><body style="font-family:system-ui;padding:48px 20px;text-align:center;color:#334155"><h1 style="font-size:20px">${title}</h1></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

function target(request: Request, link: PublicLink, visitorId: string | null) {
  return link.mode === "form" || !link.destination_url
    ? new URL(`/f/${link.slug}`, request.url).toString()
    : buildDestination(link.destination_url, link, link.slug, visitorId);
}

async function recordClick(request: Request, supabase: AdminClient, link: PublicLink, visitorId: string, bot: boolean) {
  const headers = request.headers;
  const userAgent = headers.get("user-agent");
  const salt = resolveTrackingSalt(process.env);
  if (!salt) {
    // Sem sal não há como limitar repetição por IP: falha fechada (não grava), o redirect segue.
    console.error("TRACKING_SALT e CRON_SECRET ausentes em produção: clique não gravado.");
    return;
  }
  const ipHash = await hashIp(ipRateLimitKey(clientIp(headers.get("x-forwarded-for"), headers.get("x-real-ip"))), salt);
  const ipBucket = ipHash ?? "sem-ip";

  // 1) mesmo visitante (cookie) → 1 clique por janela; 2) teto por IP (para quem descarta cookie).
  // Limite indisponível (null) = falha fechada: não grava.
  if ((await consumeRateLimit(supabase, `click:${link.id}:${ipBucket}:${bot ? "bot" : visitorId}`, JANELA_CLIQUE_S, 1)) !== true) return;
  if ((await consumeRateLimit(supabase, `click-ip:${link.id}:${ipBucket}`, JANELA_CLIQUE_S, MAX_CLIQUES_POR_IP_30MIN)) !== true) return;

  const { error } = await supabase.from("link_clicks").insert({
    organization_id: link.organization_id,
    client_id: link.client_id,
    link_id: link.id,
    visitor_id: bot ? null : visitorId,
    ip_hash: ipHash,
    user_agent: userAgent?.slice(0, 400) ?? null,
    device: detectDevice(userAgent),
    is_bot: bot,
    referrer: headers.get("referer")?.slice(0, 500) ?? null,
    country: decodeGeo(headers.get("x-vercel-ip-country")),
    region: decodeGeo(headers.get("x-vercel-ip-country-region")),
    city: decodeGeo(headers.get("x-vercel-ip-city")),
  });
  if (error) console.error(`Falha ao registrar clique do link ${link.slug}:`, error.message);
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const resolved = await loadPublicLink(slug);
  if (resolved.status === "missing") return page("This link is no longer available.", 404);
  if (resolved.status === "error") return page("This link is temporarily unavailable. Please try again in a few minutes.", 503);
  const { supabase, link } = resolved;

  const userAgent = request.headers.get("user-agent");
  const cookieVisitor = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === VISITOR_COOKIE)?.[1];
  const visitorId = isUuid(cookieVisitor) ? cookieVisitor : crypto.randomUUID();
  const bot = isBot(userAgent);

  // Falha ao gravar o clique NUNCA impede o visitante de chegar ao destino.
  try {
    await recordClick(request, supabase, link, visitorId, bot);
  } catch (error) {
    console.error(`Falha ao registrar clique do link ${slug}:`, error instanceof Error ? error.message : error);
  }

  const response = NextResponse.redirect(target(request, link, bot ? null : visitorId), 302);
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

/** Verificador de link (HEAD): mesmo destino, nenhum clique gravado, nenhum cookie. */
export async function HEAD(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const resolved = await loadPublicLink(slug);
  const noStore = { "cache-control": "no-store" };
  if (resolved.status === "missing") return new NextResponse(null, { status: 404, headers: noStore });
  if (resolved.status === "error") return new NextResponse(null, { status: 503, headers: noStore });
  const response = NextResponse.redirect(target(request, resolved.link, null), 302);
  response.headers.set("cache-control", "no-store");
  return response;
}
