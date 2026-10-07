import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidSlug } from "@/lib/marketing/tracking";
import { PublicLeadForm, type FormLanguage } from "@/components/public-lead-form";

// Formulário de captação hospedado: /f/<slug>
// Página pública (o visitante não tem login) com a identidade visual DO CLIENTE.
// Só exibe nome, cores e logo do cliente — nenhum outro dado sai daqui.

export const dynamic = "force-dynamic";

// Título neutro: o visitante é cliente do NOSSO cliente — o nome da agência não aparece.
export const metadata: Metadata = {
  title: "Request information",
  robots: { index: false, follow: false },
};

type Palette = { primary?: string; secondary?: string; accent?: string; background?: string; text?: string };

const HEX = /^#[0-9A-Fa-f]{6}$/;
function color(value: unknown, fallback: string) {
  return typeof value === "string" && HEX.test(value) ? value : fallback;
}

export default async function HostedFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const { slug } = await params;
  const { lang } = await searchParams;
  const language: FormLanguage = lang === "pt" || lang === "es" ? lang : "en";

  const supabase = createAdminClient();
  const { data: link } = isValidSlug(slug)
    ? await supabase
        .from("tracking_links")
        .select("id, slug, client_id, active, expires_at, label")
        .eq("slug", slug)
        .maybeSingle()
    : { data: null };

  const available = Boolean(link && link.active && !(link.expires_at && new Date(link.expires_at) < new Date()));

  let companyName = "";
  let palette: Palette = {};
  let logoUrl: string | null = null;
  let preferredCta: string | null = null;

  if (available && link) {
    const [{ data: client }, { data: brandKit }] = await Promise.all([
      supabase.from("clients").select("company_name").eq("id", link.client_id).maybeSingle(),
      supabase.from("brand_kits").select("palette, logo_path, preferred_cta").eq("client_id", link.client_id).maybeSingle(),
    ]);
    companyName = client?.company_name ?? "";
    palette = (brandKit?.palette as Palette | null) ?? {};
    preferredCta = brandKit?.preferred_cta ?? null;
    if (brandKit?.logo_path) {
      const { data: signed } = await supabase.storage.from("brand-assets").createSignedUrl(brandKit.logo_path, 3600);
      logoUrl = signed?.signedUrl ?? null;
    }
  }

  const colors = {
    primary: color(palette.primary, "#334155"),
    background: color(palette.background, "#F8FAFC"),
    text: color(palette.text, "#0F172A"),
  };

  return (
    <main
      className="flex min-h-screen items-start justify-center px-4 py-10 sm:items-center"
      style={{ backgroundColor: colors.background, color: colors.text }}
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5 sm:p-8">
        {available && link ? (
          <PublicLeadForm
            slug={link.slug}
            companyName={companyName}
            logoUrl={logoUrl}
            primaryColor={colors.primary}
            textColor={colors.text}
            ctaLabel={preferredCta}
            language={language}
          />
        ) : (
          <p className="py-10 text-center text-lg font-semibold">This form is no longer available.</p>
        )}
      </div>
    </main>
  );
}
