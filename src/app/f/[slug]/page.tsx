import type { Metadata } from "next";
import { loadPublicLink } from "@/lib/marketing/public-link";
import { consentText, formLanguage } from "@/lib/marketing/tracking";
import { PublicLeadForm } from "@/components/public-lead-form";

// ROTA PÚBLICA — formulário de captação hospedado: /f/<slug>
// Página pública (o visitante não tem login) com a identidade visual DO CLIENTE.
// Só exibe nome, cores e logo do cliente — nenhum outro dado sai daqui.
// Só LEITURA: não grava nada. O envio vai para /api/public/leads, que tem o limite de envios.
// Link ou cliente inativo = formulário indisponível.

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
  const language = formLanguage(lang);

  const resolved = await loadPublicLink(slug);

  let palette: Palette = {};
  let logoUrl: string | null = null;
  let preferredCta: string | null = null;

  if (resolved.status === "ok") {
    const { supabase, link } = resolved;
    const { data: brandKit, error } = await supabase
      .from("brand_kits")
      .select("palette, logo_path, preferred_cta")
      .eq("client_id", link.client_id)
      .maybeSingle();
    if (error) console.error(`Falha ao ler a marca do link ${slug}:`, error.message);
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
        {resolved.status === "ok" ? (
          <PublicLeadForm
            slug={resolved.link.slug}
            companyName={resolved.companyName}
            consentText={consentText(language, resolved.companyName)}
            logoUrl={logoUrl}
            primaryColor={colors.primary}
            textColor={colors.text}
            ctaLabel={preferredCta}
            language={language}
          />
        ) : (
          <p className="py-10 text-center text-lg font-semibold">
            {resolved.status === "error"
              ? "This form is temporarily unavailable. Please try again in a few minutes."
              : "This form is no longer available."}
          </p>
        )}
      </div>
    </main>
  );
}
