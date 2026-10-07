import { createAdminClient } from "@/lib/supabase/admin";
import { isValidSlug } from "@/lib/marketing/tracking";

// Leitura do link rastreável pelas rotas PÚBLICAS (/r, /f, /api/public/leads), com a
// mesma regra em todas: link ativo, não expirado e cliente ativo. Só servidor (service role).

export type AdminClient = ReturnType<typeof createAdminClient>;

export type PublicLink = {
  id: string;
  organization_id: string;
  client_id: string;
  slug: string;
  label: string;
  mode: "redirect" | "form";
  destination_url: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
};

export type PublicLinkResult =
  | { status: "ok"; supabase: AdminClient; link: PublicLink; companyName: string }
  | { status: "missing" }
  | { status: "error" };

/** "missing" = link/cliente inexistente ou inativo · "error" = sem chave ou banco fora (página amigável). */
export async function loadPublicLink(slug: string): Promise<PublicLinkResult> {
  if (!isValidSlug(slug)) return { status: "missing" };
  try {
    const supabase = createAdminClient();
    const { data: link, error } = await supabase
      .from("tracking_links")
      .select("id, organization_id, client_id, slug, label, mode, destination_url, active, expires_at, utm_source, utm_medium, utm_campaign, utm_content, utm_term")
      .eq("slug", slug)
      .maybeSingle();
    if (error) {
      console.error(`Falha ao ler o link ${slug}:`, error.message);
      return { status: "error" };
    }
    if (!link || !link.active || (link.expires_at && new Date(link.expires_at) < new Date())) return { status: "missing" };

    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("active, company_name")
      .eq("id", link.client_id)
      .maybeSingle();
    if (clientError) {
      console.error(`Falha ao ler o cliente do link ${slug}:`, clientError.message);
      return { status: "error" };
    }
    if (!client?.active) return { status: "missing" };
    return { status: "ok", supabase, link: link as PublicLink, companyName: client.company_name ?? "" };
  } catch (error) {
    console.error(`Link ${slug} indisponível:`, error instanceof Error ? error.message : error);
    return { status: "error" };
  }
}

/**
 * Limite atômico no banco (public.consume_rate_limit, só service role).
 * true = permitido · false = estourou · null = não foi possível verificar (quem chama decide, fechando).
 */
export async function consumeRateLimit(supabase: AdminClient, bucket: string, windowSeconds: number, max: number) {
  const { data, error } = await supabase.rpc("consume_rate_limit", {
    p_bucket: bucket,
    p_window_seconds: windowSeconds,
    p_max: max,
  });
  if (error) {
    console.error(`consume_rate_limit falhou (${bucket.split(":")[0]}):`, error.message);
    return null;
  }
  return data === true;
}
