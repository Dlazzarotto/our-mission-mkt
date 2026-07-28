"use client";

import { LoaderCircle, UserPlus, Users, X } from "lucide-react";
import { useEffect, useState } from "react";

type Membro = {
  user_id: string;
  email: string | null;
  role: string;
};

const PAPEIS = [
  { id: "manager", label: "Gerente", desc: "Faz tudo, menos remover o dono" },
  { id: "strategist", label: "Estrategista", desc: "Cria clientes, planos e conteúdo" },
  { id: "designer", label: "Designer", desc: "Trabalha em marca e conteúdo" },
  { id: "viewer", label: "Somente leitura", desc: "Vê tudo, não altera nada" },
];

const ROTULO_PAPEL: Record<string, string> = {
  owner: "Dono",
  manager: "Gerente",
  strategist: "Estrategista",
  designer: "Designer",
  viewer: "Somente leitura",
  client: "Cliente",
};

function senhaSugerida() {
  const alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let saida = "";
  try {
    const bytes = new Uint8Array(14);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length; i += 1) saida += alfabeto[bytes[i] % alfabeto.length];
  } catch {
    for (let i = 0; i < 14; i += 1) saida += alfabeto[Math.floor(Math.random() * alfabeto.length)];
  }
  return saida;
}

export function Equipe() {
  const [aberto, setAberto] = useState(false);
  const [membros, setMembros] = useState<Membro[]>([]);
  const [meuPapel, setMeuPapel] = useState<string>("");
  const [meuId, setMeuId] = useState<string>("");
  const [carregando, setCarregando] = useState(false);
  const [form, setForm] = useState({ email: "", password: "", role: "strategist" });
  const [salvando, setSalvando] = useState(false);
  const [mensagem, setMensagem] = useState<string | null>(null);

  async function carregar() {
    setCarregando(true);
    try {
      const response = await fetch("/api/team");
      const data = await response.json();
      if (data.success) {
        setMembros(data.membros ?? []);
        setMeuPapel(data.meuPapel ?? "");
        setMeuId(data.meuId ?? "");
      }
    } catch {
      /* silencioso: a lista simplesmente não abre */
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    if (aberto) carregar();
  }, [aberto]);

  const podeGerenciar = ["owner", "manager"].includes(meuPapel);

  async function adicionar() {
    if (!form.email.trim() || form.password.length < 8 || salvando) return;
    setSalvando(true);
    setMensagem(null);
    try {
      const response = await fetch("/api/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error ?? "Falha ao adicionar.");
      setMensagem(
        data.reaproveitado
          ? `${form.email} já tinha conta e foi adicionado à agência.`
          : `Acesso criado. Passe para ${form.email}: e-mail e a senha que você definiu.`,
      );
      setForm({ email: "", password: "", role: "strategist" });
      carregar();
    } catch (error) {
      setMensagem(`Erro: ${error instanceof Error ? error.message : "desconhecido"}`);
    } finally {
      setSalvando(false);
    }
  }

  async function remover(userId: string) {
    try {
      const response = await fetch("/api/team", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error ?? "Falha ao remover.");
      carregar();
    } catch (error) {
      setMensagem(`Erro: ${error instanceof Error ? error.message : "desconhecido"}`);
    }
  }

  if (!aberto) {
    return (
      <button
        onClick={() => setAberto(true)}
        className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold text-slate-600 transition hover:bg-slate-50"
      >
        <Users className="h-4 w-4" /> Equipe
      </button>
    );
  }

  const inputClass =
    "mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10";

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-base font-bold text-slate-950">
          <Users className="h-4 w-4 text-sky-600" /> Equipe da agência
        </h3>
        <button
          onClick={() => setAberto(false)}
          aria-label="Fechar equipe"
          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-50"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <p className="mb-4 text-sm leading-6 text-slate-500">
        Todo mundo aqui enxerga os mesmos clientes, de qualquer computador ou celular. O acesso é
        por e-mail e senha — não depende da máquina.
      </p>

      {carregando ? (
        <p className="text-sm text-slate-400">Carregando…</p>
      ) : (
        <ul className="mb-5 space-y-2">
          {membros.map((membro) => (
            <li
              key={membro.user_id}
              className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-800">
                  {membro.email ?? membro.user_id.slice(0, 8)}
                  {membro.user_id === meuId ? (
                    <span className="ml-2 text-xs font-normal text-slate-400">você</span>
                  ) : null}
                </p>
                <p className="text-xs text-slate-500">{ROTULO_PAPEL[membro.role] ?? membro.role}</p>
              </div>
              {podeGerenciar && membro.user_id !== meuId && membro.role !== "owner" ? (
                <button
                  onClick={() => remover(membro.user_id)}
                  className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-500 transition hover:border-rose-200 hover:text-rose-600"
                >
                  Remover
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {podeGerenciar ? (
        <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-4">
          <p className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-800">
            <UserPlus className="h-4 w-4" /> Dar acesso a alguém
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-bold text-slate-700">E-mail</span>
              <input
                type="email"
                value={form.email}
                onChange={(event) => setForm((p) => ({ ...p, email: event.target.value }))}
                placeholder="pessoa@ourmissionmkt.com"
                className={inputClass}
                autoComplete="off"
              />
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-700">Papel</span>
              <select
                value={form.role}
                onChange={(event) => setForm((p) => ({ ...p, role: event.target.value }))}
                className={inputClass}
              >
                {PAPEIS.map((papel) => (
                  <option key={papel.id} value={papel.id}>
                    {papel.label} — {papel.desc}
                  </option>
                ))}
              </select>
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-bold text-slate-700">Senha inicial</span>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={form.password}
                  onChange={(event) => setForm((p) => ({ ...p, password: event.target.value }))}
                  placeholder="mínimo 8 caracteres"
                  className={inputClass}
                  autoComplete="off"
                />
                <button
                  onClick={() => setForm((p) => ({ ...p, password: senhaSugerida() }))}
                  className="mt-1.5 shrink-0 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 hover:bg-slate-50"
                >
                  Gerar
                </button>
              </div>
            </label>
          </div>

          {mensagem ? (
            <p
              className={`mt-3 rounded-xl px-3 py-2.5 text-xs font-semibold ${
                mensagem.startsWith("Erro")
                  ? "border border-rose-100 bg-rose-50 text-rose-700"
                  : "border border-emerald-100 bg-emerald-50 text-emerald-700"
              }`}
            >
              {mensagem}
            </p>
          ) : null}

          <button
            onClick={adicionar}
            disabled={salvando || !form.email.trim() || form.password.length < 8}
            className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-slate-800 disabled:opacity-60"
          >
            {salvando ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
            {salvando ? "Criando..." : "Criar acesso"}
          </button>
        </div>
      ) : (
        <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-xs text-slate-500">
          Só o dono ou um gerente pode adicionar pessoas.
        </p>
      )}
    </section>
  );
}
