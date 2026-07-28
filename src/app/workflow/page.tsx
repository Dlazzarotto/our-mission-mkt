import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PHASES, HEALTH_LABEL, ROLE_LABEL, phaseHealth, type PhaseId } from "@/lib/workflow/phases";

export const dynamic = "force-dynamic";

const HEALTH_STYLE: Record<string, string> = {
  on_track: "bg-emerald-50 text-emerald-700 border-emerald-100",
  at_risk: "bg-amber-50 text-amber-700 border-amber-100",
  late: "bg-rose-50 text-rose-700 border-rose-100",
};

export default async function WorkflowPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: membership } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  if (!membership) redirect("/");

  const [{ data: workflows }, { data: tarefas }] = await Promise.all([
    supabase
      .from("client_workflow")
      .select("client_id, phase, phase_started_at, cycle, paused, clients(company_name, industry)")
      .eq("organization_id", membership.organization_id),
    supabase
      .from("workflow_tasks")
      .select("client_id, phase, status, due_at")
      .eq("organization_id", membership.organization_id)
      .neq("status", "done"),
  ]);

  const lista = workflows ?? [];
  const abertas = tarefas ?? [];

  const atrasadas = abertas.filter(
    (t) => t.due_at && new Date(t.due_at).getTime() < Date.now(),
  ).length;

  return (
    <main className="min-h-screen bg-[#f6f8fb] pb-16">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-5 py-5">
          <Link href="/" className="text-xs font-bold text-slate-400 transition hover:text-slate-600">
            ← Clientes
          </Link>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">
            Quadro de operação
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {lista.length} cliente(s) no processo · {abertas.length} tarefa(s) em aberto
            {atrasadas > 0 ? (
              <span className="ml-1 font-bold text-rose-600">· {atrasadas} atrasada(s)</span>
            ) : null}
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 pt-6">
        <div className="flex gap-4 overflow-x-auto pb-4">
          {PHASES.map((phase) => {
            const naFase = lista.filter((item) => item.phase === phase.id);
            return (
              <section key={phase.id} className="w-72 shrink-0">
                <div className="mb-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-bold text-slate-950">
                      {phase.order}. {phase.name}
                    </p>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-600">
                      {naFase.length}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{phase.purpose}</p>
                  <p className="mt-1.5 text-[11px] font-semibold tracking-wide text-sky-700 uppercase">
                    {ROLE_LABEL[phase.owner]} · {phase.slaDays} dias
                  </p>
                </div>

                <div className="space-y-2">
                  {naFase.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-xs text-slate-400">
                      Ninguém aqui
                    </div>
                  ) : (
                    naFase.map((item) => {
                      const cliente = item.clients as { company_name?: string; industry?: string } | null;
                      const saude = phaseHealth(item.phase_started_at, phase.slaDays);
                      const pendentes = abertas.filter(
                        (t) => t.client_id === item.client_id && t.phase === item.phase,
                      ).length;
                      return (
                        <Link
                          key={item.client_id}
                          href={`/clients/${item.client_id}`}
                          className="block rounded-xl border border-slate-200 bg-white p-4 transition hover:border-sky-300 hover:shadow-sm"
                        >
                          <p className="truncate text-sm font-bold text-slate-950">
                            {cliente?.company_name ?? "Cliente"}
                          </p>
                          <p className="mt-0.5 truncate text-xs text-slate-500">
                            {cliente?.industry}
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <span
                              className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${HEALTH_STYLE[saude]}`}
                            >
                              {HEALTH_LABEL[saude]}
                            </span>
                            {item.cycle > 1 ? (
                              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600">
                                ciclo {item.cycle}
                              </span>
                            ) : null}
                            {item.paused ? (
                              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-bold text-slate-700">
                                pausado
                              </span>
                            ) : null}
                            {pendentes > 0 ? (
                              <span className="text-[11px] font-semibold text-slate-500">
                                {pendentes} tarefa(s)
                              </span>
                            ) : null}
                          </div>
                        </Link>
                      );
                    })
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </main>
  );
}
