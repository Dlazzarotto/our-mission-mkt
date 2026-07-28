import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  PHASE_BY_ID,
  dueDateFor,
  nextPhase,
  previousPhase,
  type ExitCheck,
  type PhaseId,
} from "@/lib/workflow/phases";

// O avanço de fase não é uma caixinha marcada à mão: o sistema confere se o
// entregável existe de verdade no banco antes de liberar a passagem.

const advanceSchema = z.object({
  clientId: z.string().uuid(),
  action: z.enum(["advance", "return", "pause", "resume"]),
  note: z.string().trim().max(500).optional(),
  /** Permite passar mesmo com pendência, registrando o motivo. */
  override: z.boolean().default(false),
});

type CheckResult = { check: ExitCheck; passed: boolean; detail: string };

async function runExitChecks(
  supabase: Awaited<ReturnType<typeof createClient>>,
  clientId: string,
  phase: PhaseId,
): Promise<CheckResult[]> {
  const checks = PHASE_BY_ID[phase].exitChecks;
  const results: CheckResult[] = [];

  for (const check of checks) {
    switch (check) {
      case "brand_kit_configured": {
        const { data } = await supabase
          .from("brand_kits")
          .select("palette, tone_of_voice")
          .eq("client_id", clientId)
          .maybeSingle();
        const temTom = Boolean(data?.tone_of_voice && data.tone_of_voice.trim().length > 5);
        results.push({
          check,
          passed: Boolean(data) && temTom,
          detail: data ? (temTom ? "Preenchido" : "Falta o tom de voz") : "Brand kit não encontrado",
        });
        break;
      }
      case "contract_active": {
        const { count } = await supabase
          .from("client_contracts")
          .select("id", { count: "exact", head: true })
          .eq("client_id", clientId)
          .eq("status", "active");
        results.push({
          check,
          passed: (count ?? 0) > 0,
          detail: (count ?? 0) > 0 ? `${count} contrato(s) ativo(s)` : "Nenhum contrato ativo",
        });
        break;
      }
      case "research_completed": {
        const { data } = await supabase
          .from("market_research_requests")
          .select("ai_analysis")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const etapas = Object.keys((data?.ai_analysis ?? {}) as Record<string, string>).length;
        results.push({
          check,
          passed: etapas > 0,
          detail: etapas > 0 ? `${etapas} etapa(s) analisada(s)` : "Nenhuma pesquisa concluída",
        });
        break;
      }
      case "plan_completed": {
        const { data } = await supabase
          .from("strategic_plans")
          .select("sections")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const secoes = Object.keys((data?.sections ?? {}) as Record<string, string>).length;
        results.push({
          check,
          passed: secoes >= 3,
          detail: secoes > 0 ? `${secoes} de 5 seções` : "Plano não gerado",
        });
        break;
      }
      case "calendar_ready": {
        const { count } = await supabase
          .from("content_items")
          .select("id", { count: "exact", head: true })
          .eq("client_id", clientId);
        results.push({
          check,
          passed: (count ?? 0) > 0,
          detail: (count ?? 0) > 0 ? `${count} peça(s) no calendário` : "Calendário vazio",
        });
        break;
      }
      case "content_produced": {
        const { count } = await supabase
          .from("content_items")
          .select("id", { count: "exact", head: true })
          .eq("client_id", clientId)
          .not("caption", "is", null);
        results.push({
          check,
          passed: (count ?? 0) > 0,
          detail: (count ?? 0) > 0 ? `${count} peça(s) com texto` : "Nenhuma peça produzida",
        });
        break;
      }
      case "content_reviewed": {
        const { count } = await supabase
          .from("content_items")
          .select("id", { count: "exact", head: true })
          .eq("client_id", clientId)
          .in("status", ["review", "approved", "scheduled", "published"]);
        results.push({
          check,
          passed: (count ?? 0) > 0,
          detail: (count ?? 0) > 0 ? `${count} peça(s) revisada(s)` : "Nada em revisão",
        });
        break;
      }
      case "content_approved": {
        const { count } = await supabase
          .from("content_items")
          .select("id", { count: "exact", head: true })
          .eq("client_id", clientId)
          .in("status", ["approved", "scheduled", "published"]);
        results.push({
          check,
          passed: (count ?? 0) > 0,
          detail: (count ?? 0) > 0 ? `${count} peça(s) aprovada(s)` : "Nada aprovado pelo cliente",
        });
        break;
      }
      case "content_scheduled": {
        const { count } = await supabase
          .from("content_items")
          .select("id", { count: "exact", head: true })
          .eq("client_id", clientId)
          .in("status", ["scheduled", "published"]);
        results.push({
          check,
          passed: (count ?? 0) > 0,
          detail: (count ?? 0) > 0 ? `${count} peça(s) no ar` : "Nada agendado",
        });
        break;
      }
      case "report_delivered":
      case "manual": {
        const { count } = await supabase
          .from("workflow_tasks")
          .select("id", { count: "exact", head: true })
          .eq("client_id", clientId)
          .eq("phase", phase)
          .neq("status", "done");
        results.push({
          check,
          passed: (count ?? 0) === 0,
          detail: (count ?? 0) === 0 ? "Tarefas concluídas" : `${count} tarefa(s) em aberto`,
        });
        break;
      }
    }
  }

  return results;
}

async function createPhaseTasks(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  clientId: string,
  phase: PhaseId,
  cycle: number,
) {
  const { count } = await supabase
    .from("workflow_tasks")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .eq("phase", phase)
    .eq("cycle", cycle);

  if ((count ?? 0) > 0) return; // as tarefas deste ciclo já existem

  const agora = new Date();
  const rows = PHASE_BY_ID[phase].tasks.map((task) => ({
    organization_id: organizationId,
    client_id: clientId,
    phase,
    cycle,
    title: task.title,
    role: task.role,
    due_at: dueDateFor(agora, task.dueInDays).toISOString(),
  }));

  if (rows.length > 0) await supabase.from("workflow_tasks").insert(rows);
}

// ---------------------------------------------------------------------------
// GET — situação do cliente: fase, tarefas e o que falta para avançar
// ---------------------------------------------------------------------------
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const clientId = searchParams.get("clientId");
  if (!clientId) {
    return NextResponse.json({ error: "Informe o clientId." }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sessão inválida." }, { status: 401 });

  const { data: workflow } = await supabase
    .from("client_workflow")
    .select("*")
    .eq("client_id", clientId)
    .maybeSingle();

  if (!workflow) {
    return NextResponse.json({ error: "Cliente não está no workflow." }, { status: 404 });
  }

  const [{ data: tasks }, checks, { data: events }] = await Promise.all([
    supabase
      .from("workflow_tasks")
      .select("*")
      .eq("client_id", clientId)
      .eq("phase", workflow.phase)
      .eq("cycle", workflow.cycle)
      .order("due_at", { ascending: true }),
    runExitChecks(supabase, clientId, workflow.phase as PhaseId),
    supabase
      .from("workflow_events")
      .select("*")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(12),
  ]);

  return NextResponse.json({
    success: true,
    workflow,
    tasks: tasks ?? [],
    checks,
    canAdvance: checks.every((item) => item.passed),
    events: events ?? [],
  });
}

// ---------------------------------------------------------------------------
// POST — avança, volta, pausa ou retoma
// ---------------------------------------------------------------------------
export async function POST(request: Request) {
  try {
    const payload = advanceSchema.parse(await request.json());
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Sessão inválida." }, { status: 401 });
    }

    const { data: workflow } = await supabase
      .from("client_workflow")
      .select("*")
      .eq("client_id", payload.clientId)
      .maybeSingle();

    if (!workflow) {
      return NextResponse.json({ error: "Cliente não está no workflow." }, { status: 404 });
    }

    const faseAtual = workflow.phase as PhaseId;

    if (payload.action === "pause" || payload.action === "resume") {
      const pausado = payload.action === "pause";
      await supabase
        .from("client_workflow")
        .update({ paused: pausado, pause_reason: pausado ? (payload.note ?? null) : null })
        .eq("id", workflow.id);
      await supabase.from("workflow_events").insert({
        organization_id: workflow.organization_id,
        client_id: payload.clientId,
        from_phase: faseAtual,
        to_phase: faseAtual,
        cycle: workflow.cycle,
        action: payload.action,
        note: payload.note ?? null,
        actor_id: user.id,
      });
      return NextResponse.json({ success: true, paused: pausado });
    }

    if (payload.action === "return") {
      const anterior = previousPhase(faseAtual);
      if (!anterior) {
        return NextResponse.json({ error: "Já está na primeira fase." }, { status: 409 });
      }
      await supabase
        .from("client_workflow")
        .update({ phase: anterior, phase_started_at: new Date().toISOString() })
        .eq("id", workflow.id);
      await supabase.from("workflow_events").insert({
        organization_id: workflow.organization_id,
        client_id: payload.clientId,
        from_phase: faseAtual,
        to_phase: anterior,
        cycle: workflow.cycle,
        action: "return",
        note: payload.note ?? null,
        actor_id: user.id,
      });
      return NextResponse.json({ success: true, phase: anterior });
    }

    // ---------- avançar ----------
    const checks = await runExitChecks(supabase, payload.clientId, faseAtual);
    const pendentes = checks.filter((item) => !item.passed);

    if (pendentes.length > 0 && !payload.override) {
      return NextResponse.json(
        {
          success: false,
          error: "A fase ainda tem entregáveis pendentes.",
          checks,
          pendentes,
        },
        { status: 409 },
      );
    }

    const proxima = nextPhase(faseAtual);
    if (!proxima) {
      return NextResponse.json({ error: "Não há próxima fase." }, { status: 409 });
    }

    // Sair da otimização reinicia o ciclo no planejamento.
    const novoCiclo = faseAtual === "optimization" ? workflow.cycle + 1 : workflow.cycle;

    await supabase
      .from("client_workflow")
      .update({ phase: proxima, phase_started_at: new Date().toISOString(), cycle: novoCiclo })
      .eq("id", workflow.id);

    await createPhaseTasks(
      supabase,
      workflow.organization_id,
      payload.clientId,
      proxima,
      novoCiclo,
    );

    await supabase.from("workflow_events").insert({
      organization_id: workflow.organization_id,
      client_id: payload.clientId,
      from_phase: faseAtual,
      to_phase: proxima,
      cycle: novoCiclo,
      action: novoCiclo > workflow.cycle ? "cycle_restart" : "advance",
      note: pendentes.length > 0 ? `Avanço forçado. Pendências: ${pendentes.map((p) => p.check).join(", ")}. ${payload.note ?? ""}`.trim() : (payload.note ?? null),
      actor_id: user.id,
    });

    return NextResponse.json({ success: true, phase: proxima, cycle: novoCiclo, forced: pendentes.length > 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    return NextResponse.json(
      { success: false, error: message },
      { status: error instanceof z.ZodError ? 400 : 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// PATCH — atualiza uma tarefa
// ---------------------------------------------------------------------------
const novaTarefaSchema = z.object({
  clientId: z.string().uuid(),
  title: z.string().trim().min(3).max(200),
  role: z.enum(["account", "strategist", "designer", "copywriter", "analyst", "client"]),
  dueInDays: z.number().int().min(0).max(90).default(5),
});

const taskSchema = z.object({
  taskId: z.string().uuid(),
  status: z.enum(["todo", "doing", "blocked", "done"]).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  blockedReason: z.string().trim().max(300).optional(),
});

// PUT — cria uma tarefa avulsa na fase atual do cliente
export async function PUT(request: Request) {
  try {
    const payload = novaTarefaSchema.parse(await request.json());
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Sessão inválida." }, { status: 401 });
    }

    const { data: workflow } = await supabase
      .from("client_workflow")
      .select("organization_id, phase, cycle")
      .eq("client_id", payload.clientId)
      .maybeSingle();

    if (!workflow) {
      return NextResponse.json({ error: "Cliente não está no workflow." }, { status: 404 });
    }

    // Evita duplicar a mesma tarefa se o botão for clicado duas vezes.
    const { data: existente } = await supabase
      .from("workflow_tasks")
      .select("id")
      .eq("client_id", payload.clientId)
      .eq("phase", workflow.phase)
      .eq("cycle", workflow.cycle)
      .eq("title", payload.title)
      .maybeSingle();

    if (existente) {
      return NextResponse.json({ success: true, task: existente, jaExistia: true });
    }

    const { data, error } = await supabase
      .from("workflow_tasks")
      .insert({
        organization_id: workflow.organization_id,
        client_id: payload.clientId,
        phase: workflow.phase,
        cycle: workflow.cycle,
        title: payload.title,
        role: payload.role,
        due_at: dueDateFor(new Date(), payload.dueInDays).toISOString(),
      })
      .select("*")
      .single();

    if (error || !data) throw new Error(error?.message ?? "Falha ao criar a tarefa.");

    return NextResponse.json({ success: true, task: data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    return NextResponse.json(
      { success: false, error: message },
      { status: error instanceof z.ZodError ? 400 : 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const payload = taskSchema.parse(await request.json());
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Sessão inválida." }, { status: 401 });
    }

    const updates: Record<string, unknown> = {};
    if (payload.status) {
      updates.status = payload.status;
      updates.completed_at = payload.status === "done" ? new Date().toISOString() : null;
      updates.completed_by = payload.status === "done" ? user.id : null;
    }
    if (payload.assigneeId !== undefined) updates.assignee_id = payload.assigneeId;
    if (payload.blockedReason !== undefined) updates.blocked_reason = payload.blockedReason;

    const { data, error } = await supabase
      .from("workflow_tasks")
      .update(updates)
      .eq("id", payload.taskId)
      .select("*")
      .single();

    if (error || !data) {
      return NextResponse.json({ error: "Tarefa não encontrada ou sem permissão." }, { status: 404 });
    }

    return NextResponse.json({ success: true, task: data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    return NextResponse.json(
      { success: false, error: message },
      { status: error instanceof z.ZodError ? 400 : 500 },
    );
  }
}
