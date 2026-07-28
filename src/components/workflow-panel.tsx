"use client";

import { CircleCheck, CircleDashed, LoaderCircle, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  EXIT_CHECK_LABEL,
  HEALTH_LABEL,
  PHASE_BY_ID,
  PHASES,
  ROLE_LABEL,
  phaseHealth,
  type AgencyRole,
  type PhaseId,
} from "@/lib/workflow/phases";

type Task = {
  id: string;
  title: string;
  role: AgencyRole;
  status: "todo" | "doing" | "blocked" | "done";
  due_at: string | null;
};

type Check = { check: string; passed: boolean; detail: string };

type WorkflowRow = {
  phase: PhaseId;
  phase_started_at: string;
  cycle: number;
  paused: boolean;
  pause_reason: string | null;
};

const STATUS_NEXT: Record<Task["status"], Task["status"]> = {
  todo: "doing",
  doing: "done",
  done: "todo",
  blocked: "doing",
};

const STATUS_LABEL: Record<Task["status"], string> = {
  todo: "A fazer",
  doing: "Em andamento",
  done: "Concluída",
  blocked: "Bloqueada",
};

const STATUS_STYLE: Record<Task["status"], string> = {
  todo: "border-slate-200 text-slate-500",
  doing: "border-sky-200 bg-sky-50 text-sky-700",
  done: "border-emerald-200 bg-emerald-50 text-emerald-700",
  blocked: "border-rose-200 bg-rose-50 text-rose-700",
};

const HEALTH_STYLE: Record<string, string> = {
  on_track: "bg-emerald-50 text-emerald-700",
  at_risk: "bg-amber-50 text-amber-700",
  late: "bg-rose-50 text-rose-700",
};

export function WorkflowPanel({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [workflow, setWorkflow] = useState<WorkflowRow | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [canAdvance, setCanAdvance] = useState(false);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/workflow?clientId=${clientId}`);
      const data = await response.json();
      if (data.success) {
        setWorkflow(data.workflow);
        setTasks(data.tasks ?? []);
        setChecks(data.checks ?? []);
        setCanAdvance(Boolean(data.canAdvance));
      }
    } catch {
      /* mantém o que já está na tela */
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    load();
  }, [load]);

  async function agir(action: "advance" | "return" | "pause" | "resume", override = false) {
    setActing(true);
    setMessage(null);
    try {
      const response = await fetch("/api/workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, action, override }),
      });
      const data = await response.json();
      if (!data.success) {
        setMessage(data.error ?? "Não foi possível concluir.");
      } else if (data.forced) {
        setMessage("Fase avançada com pendências — o motivo ficou registrado na trilha.");
      }
      await load();
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Erro desconhecido");
    } finally {
      setActing(false);
    }
  }

  async function alternarTarefa(task: Task) {
    const novo = STATUS_NEXT[task.status];
    setTasks((atual) => atual.map((t) => (t.id === task.id ? { ...t, status: novo } : t)));
    await fetch("/api/workflow", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: task.id, status: novo }),
    });
    load();
  }

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-400">
        Carregando o processo…
      </div>
    );
  }

  if (!workflow) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
        Este cliente ainda não entrou no workflow.
      </div>
    );
  }

  const phase = PHASE_BY_ID[workflow.phase];
  const saude = phaseHealth(workflow.phase_started_at, phase.slaDays);
  const concluidas = tasks.filter((t) => t.status === "done").length;

  return (
    <section className="space-y-4">
      {/* Onde está */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold tracking-[0.16em] text-sky-700 uppercase">
              Fase {phase.order} de {PHASES.length}
              {workflow.cycle > 1 ? ` · ciclo ${workflow.cycle}` : ""}
            </p>
            <h3 className="mt-1 text-xl font-bold text-slate-950">{phase.name}</h3>
            <p className="mt-1 max-w-xl text-sm leading-6 text-slate-500">{phase.purpose}</p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <span className={`rounded-full px-3 py-1 text-xs font-bold ${HEALTH_STYLE[saude]}`}>
              {HEALTH_LABEL[saude]}
            </span>
            <span className="text-xs text-slate-400">
              {ROLE_LABEL[phase.owner]} · {phase.slaDays} dias
            </span>
          </div>
        </div>

        {/* Trilho das fases */}
        <div className="mt-5 flex gap-1">
          {PHASES.map((item) => (
            <div
              key={item.id}
              title={item.name}
              className={`h-1.5 flex-1 rounded-full ${
                item.order < phase.order
                  ? "bg-emerald-500"
                  : item.order === phase.order
                    ? "bg-sky-500"
                    : "bg-slate-200"
              }`}
            />
          ))}
        </div>

        {workflow.paused ? (
          <p className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-semibold text-slate-600">
            Processo pausado{workflow.pause_reason ? `: ${workflow.pause_reason}` : ""}.
          </p>
        ) : null}
      </div>

      {/* O que falta para passar */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <h4 className="text-sm font-bold text-slate-950">Para encerrar esta fase</h4>
        <ul className="mt-3 space-y-2">
          {checks.map((item) => (
            <li key={item.check} className="flex items-start gap-2.5">
              {item.passed ? (
                <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              ) : (
                <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />
              )}
              <span className="text-sm leading-6 text-slate-700">
                {EXIT_CHECK_LABEL[item.check as keyof typeof EXIT_CHECK_LABEL] ?? item.check}
                <span className="ml-1.5 text-xs text-slate-400">— {item.detail}</span>
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            onClick={() => agir("advance")}
            disabled={acting || !canAdvance}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-slate-800 disabled:opacity-50"
          >
            {acting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
            Concluir fase e avançar
          </button>
          {!canAdvance ? (
            <button
              onClick={() => agir("advance", true)}
              disabled={acting}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-bold text-amber-700 transition hover:bg-amber-100 disabled:opacity-50"
            >
              <TriangleAlert className="h-4 w-4" /> Avançar mesmo assim
            </button>
          ) : null}
          <button
            onClick={() => agir("return")}
            disabled={acting || phase.order === 1}
            className="min-h-11 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
          >
            Voltar fase
          </button>
          <button
            onClick={() => agir(workflow.paused ? "resume" : "pause")}
            disabled={acting}
            className="min-h-11 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
          >
            {workflow.paused ? "Retomar" : "Pausar"}
          </button>
        </div>

        {message ? (
          <p className="mt-3 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2.5 text-xs font-semibold text-amber-700">
            {message}
          </p>
        ) : null}
      </div>

      {/* Tarefas da fase */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="mb-3 flex items-center justify-between">
          <h4 className="text-sm font-bold text-slate-950">
            Tarefas desta fase
            <span className="ml-2 font-normal text-slate-400">
              {concluidas}/{tasks.length}
            </span>
          </h4>
        </div>

        {tasks.length === 0 ? (
          <p className="text-sm text-slate-400">
            Nenhuma tarefa criada. Elas são geradas quando a fase começa.
          </p>
        ) : (
          <ul className="space-y-2">
            {tasks.map((task) => {
              const atrasada =
                task.status !== "done" && task.due_at && new Date(task.due_at) < new Date();
              return (
                <li
                  key={task.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p
                      className={`truncate text-sm font-semibold ${
                        task.status === "done" ? "text-slate-400 line-through" : "text-slate-800"
                      }`}
                    >
                      {task.title}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {ROLE_LABEL[task.role]}
                      {task.due_at
                        ? ` · ${new Date(task.due_at).toLocaleDateString("pt-BR")}`
                        : ""}
                      {atrasada ? <span className="ml-1 font-bold text-rose-600">atrasada</span> : null}
                    </p>
                  </div>
                  <button
                    onClick={() => alternarTarefa(task)}
                    className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-bold transition ${STATUS_STYLE[task.status]}`}
                  >
                    {STATUS_LABEL[task.status]}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* O que sai desta fase */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <h4 className="text-sm font-bold text-slate-950">Entregáveis da fase</h4>
        <ul className="mt-3 space-y-1.5">
          {phase.deliverables.map((item) => (
            <li key={item} className="flex gap-2.5 text-sm leading-6 text-slate-600">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" />
              {item}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
