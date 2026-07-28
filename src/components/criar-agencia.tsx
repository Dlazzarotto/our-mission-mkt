"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { AGENCY_NAME } from "@/lib/brand";

export function CriarAgencia() {
  const [name, setName] = useState(AGENCY_NAME);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    if (name.trim().length < 2) {
      setError("Informe o nome da agência.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: rpcError } = await supabase.rpc("create_organization_with_owner", {
        organization_name: name.trim(),
      });
      if (rpcError) throw rpcError;
      window.location.assign("/");
    } catch (rpcError) {
      setError(rpcError instanceof Error ? rpcError.message : "Não foi possível criar a agência.");
      setLoading(false);
    }
  }

  return (
    <section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <p className="text-xs font-bold tracking-[0.16em] text-sky-700 uppercase">Primeiro acesso</p>
      <h1 className="mt-2 text-2xl font-bold text-slate-950">Crie a sua agência</h1>
      <p className="mt-2 text-sm text-slate-500">
        Você será o proprietário e poderá convidar a equipe depois.
      </p>
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Ex.: Our Mission MKT"
        className="mt-5 w-full rounded-xl border border-slate-200 px-3 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10"
      />
      {error ? (
        <p className="mt-3 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2.5 text-xs font-semibold text-rose-700">
          {error}
        </p>
      ) : null}
      <button
        onClick={handleCreate}
        disabled={loading}
        className="mt-4 w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-bold text-white transition hover:bg-slate-800 disabled:opacity-70"
      >
        {loading ? "Criando..." : "Criar agência"}
      </button>
    </section>
  );
}
