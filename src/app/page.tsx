import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CriarAgencia } from "@/components/criar-agencia";
import { NovoCliente } from "@/components/novo-cliente";
import { Equipe } from "@/components/equipe";
import { PRODUCT_NAME } from "@/lib/brand";

export const dynamic = "force-dynamic";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: membership } = await supabase
    .from("organization_members")
    .select("organization_id, organizations(name)")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  if (!membership) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f6f8fb] p-5">
        <CriarAgencia />
      </main>
    );
  }

  const organizationName =
    (membership.organizations as { name?: string } | null)?.name ?? "Sua agência";

  const { data: clients } = await supabase
    .from("clients")
    .select("id, company_name, industry, region, contact_name, active, brand_kits(palette)")
    .eq("organization_id", membership.organization_id)
    .order("created_at", { ascending: false });

  const lista = clients ?? [];

  return (
    <main className="min-h-screen bg-[#f6f8fb] pb-16">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-5 py-5">
          <div>
            <p className="text-[11px] font-bold tracking-[0.16em] text-sky-700 uppercase">
              {PRODUCT_NAME}
            </p>
            <h1 className="text-2xl font-bold tracking-tight text-slate-950">{organizationName}</h1>
          </div>
          <Link
            href="/workflow"
            className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50"
          >
            Quadro de operação
          </Link>
          <Link
            href="/demo"
            className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50"
          >
            Ver demo
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-5 pt-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-slate-900">
            Clientes <span className="text-slate-400">({lista.length})</span>
          </h2>
          <Equipe />
        </div>

        <NovoCliente />

        <div className="mt-6 space-y-3">
          {lista.length === 0 ? (
            <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-white p-10 text-center">
              <p className="text-base font-bold text-slate-900">Nenhum cliente ainda</p>
              <p className="mt-1 text-sm text-slate-500">
                Cadastre o primeiro cliente acima — o brand kit e o contrato semanal são criados
                automaticamente.
              </p>
            </div>
          ) : (
            lista.map((client) => {
              // O PostgREST devolve o relacionamento como objeto ou array
              // conforme detecta a cardinalidade — tratamos os dois casos.
              const kitBruto = client.brand_kits as
                | { palette?: Record<string, string> }
                | Array<{ palette?: Record<string, string> }>
                | null;
              const kit = Array.isArray(kitBruto) ? kitBruto[0] : kitBruto;
              const palette = kit?.palette ?? {};
              return (
                <Link
                  key={client.id}
                  href={`/clients/${client.id}`}
                  className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-5 transition hover:border-sky-300 hover:shadow-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate text-base font-bold text-slate-950">
                      {client.company_name}
                    </p>
                    <p className="mt-0.5 truncate text-sm text-slate-500">
                      {client.industry} · {client.region}
                    </p>
                    {client.contact_name ? (
                      <p className="mt-0.5 text-xs text-slate-400">👤 {client.contact_name}</p>
                    ) : null}
                  </div>
                  <div className="ml-4 flex shrink-0 items-center gap-1.5">
                    {["primary", "secondary", "accent"].map((key) => (
                      <span
                        key={key}
                        className="h-5 w-5 rounded-full border border-slate-200"
                        style={{ backgroundColor: palette[key] ?? "#e2e8f0" }}
                        title={`Cor ${key} do cliente`}
                      />
                    ))}
                  </div>
                </Link>
              );
            })
          )}
        </div>
      </div>
    </main>
  );
}
