"use client";

import Image from "next/image";
import { FormEvent, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { AGENCY_LOGO, AGENCY_NAME } from "@/lib/brand";

// Mensagem para a pessoa: o erro do Supabase vem em inglês técnico ("Invalid login
// credentials", "Failed to fetch"); aqui vira português claro, sem expor detalhe interno.
function loginErrorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : "";
  const code = (error as { code?: string } | null)?.code ?? "";
  if (code === "invalid_credentials" || /invalid login credentials/i.test(raw)) return "E-mail ou senha incorretos.";
  if (code === "email_not_confirmed" || /email not confirmed/i.test(raw)) {
    return "Seu e-mail ainda não foi confirmado. Abra o link de confirmação que enviamos.";
  }
  if (code === "over_request_rate_limit" || /rate limit|too many/i.test(raw)) {
    return "Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.";
  }
  if (/failed to fetch|network|load failed/i.test(raw)) return "Sem conexão com o servidor. Verifique a internet e tente de novo.";
  return "Não foi possível entrar. Tente de novo em instantes.";
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

      if (signInError) throw signInError;
      window.location.assign("/");
    } catch (signInError) {
      setError(loginErrorMessage(signInError));
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f6f8fb] p-5">
      <section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-[0_24px_70px_-35px_rgba(15,23,42,0.35)] sm:p-9">
        <Image
          src={AGENCY_LOGO.src}
          width={AGENCY_LOGO.width}
          height={AGENCY_LOGO.height}
          alt={AGENCY_NAME}
          priority
          className="h-auto w-full rounded-2xl"
        />
        <h1 className="mt-7 text-3xl font-bold tracking-tight text-slate-950">Acesse sua operação.</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">Entre com sua conta para gerir clientes, contratos e os rascunhos criados por IA.</p>

        <form onSubmit={handleSubmit} className="mt-7 space-y-4">
          <label className="block">
            <span className="text-xs font-bold text-slate-700">E-mail</span>
            <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="voce@agencia.com" className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10" />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-slate-700">Senha</span>
            <input type="password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="••••••••" className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10" />
          </label>
          {error ? <p className="rounded-xl border border-rose-100 bg-rose-50 px-3 py-2.5 text-xs font-semibold text-rose-700">{error}</p> : null}
          <button type="submit" disabled={loading} className="mt-2 inline-flex w-full items-center justify-center rounded-xl bg-slate-950 px-4 py-3 text-sm font-bold text-white transition hover:bg-slate-800 disabled:opacity-70">{loading ? "Entrando..." : "Entrar"}</button>
        </form>
      </section>
    </main>
  );
}
