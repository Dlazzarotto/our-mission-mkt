import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ClientProfile } from "@/components/client-profile";

export const dynamic = "force-dynamic";

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // A RLS garante que só clientes da organização do usuário são retornados.
  const { data: client } = await supabase.from("clients").select("*").eq("id", id).maybeSingle();
  if (!client) notFound();

  const [{ data: brandKit }, { data: plans }, { data: researches }, { data: contracts }, { data: contentItems }] =
    await Promise.all([
      supabase.from("brand_kits").select("*").eq("client_id", id).maybeSingle(),
      supabase
        .from("strategic_plans")
        .select("*")
        .eq("client_id", id)
        .order("created_at", { ascending: false })
        .limit(3),
      supabase
        .from("market_research_requests")
        .select("*, market_competitors(name, city, website, rating, review_count, distance_miles, price_band, fetched_at)")
        .eq("client_id", id)
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .from("client_contracts")
        .select("id, name, status, generation_cadence, next_generation_at")
        .eq("client_id", id)
        .order("created_at", { ascending: false }),
      supabase
        .from("content_items")
        .select("id, title, scheduled_at, channel, format, status, caption")
        .eq("client_id", id)
        .order("scheduled_at", { ascending: false })
        .limit(20),
    ]);

  // O bucket brand-assets e privado: a exibicao usa uma URL assinada temporaria.
  let logoUrl: string | null = null;
  if (brandKit?.logo_path) {
    const { data: assinada } = await supabase.storage
      .from("brand-assets")
      .createSignedUrl(brandKit.logo_path, 3600);
    logoUrl = assinada?.signedUrl ?? null;
  }

  return (
    <main className="min-h-screen bg-[#f6f8fb] pb-16">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-4xl px-5 py-5">
          <Link href="/" className="text-xs font-bold text-slate-400 transition hover:text-slate-600">
            ← Todos os clientes
          </Link>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">
            {client.company_name}
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {client.industry} · {client.region}
            {client.contact_name ? ` · 👤 ${client.contact_name}` : ""}
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-5 pt-6">
        <ClientProfile
          client={client}
          brandKit={brandKit}
          logoUrl={logoUrl}
          organizationId={client.organization_id}
          plans={plans ?? []}
          researches={researches ?? []}
          contracts={contracts ?? []}
          contentItems={contentItems ?? []}
        />
      </div>
    </main>
  );
}
