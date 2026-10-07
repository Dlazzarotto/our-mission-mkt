"use client";

import { useState } from "react";
import type { FormLanguage } from "@/lib/marketing/tracking";

// O texto de consentimento vem pronto do servidor (consentText em tracking.ts) — é o MESMO
// que o servidor grava como prova; o navegador não envia esse texto.

const TEXT: Record<FormLanguage, Record<string, string>> = {
  en: {
    title: "Request information",
    subtitle: "Leave your details and we will get back to you.",
    name: "Name",
    email: "Email",
    phone: "Phone",
    zip: "ZIP code",
    message: "How can we help?",
    submit: "Send",
    sending: "Sending...",
    needContact: "Please enter your email or phone so we can reach you.",
    thanks: "Thank you! We received your request and will contact you soon.",
    error: "Something went wrong. Please try again.",
  },
  es: {
    title: "Solicite información",
    subtitle: "Déjenos sus datos y nos comunicaremos con usted.",
    name: "Nombre",
    email: "Correo electrónico",
    phone: "Teléfono",
    zip: "Código postal",
    message: "¿Cómo podemos ayudarle?",
    submit: "Enviar",
    sending: "Enviando...",
    needContact: "Ingrese su correo o teléfono para que podamos contactarle.",
    thanks: "¡Gracias! Recibimos su solicitud y nos comunicaremos pronto.",
    error: "Algo salió mal. Inténtelo de nuevo.",
  },
  pt: {
    title: "Solicite informações",
    subtitle: "Deixe seus dados e entraremos em contato.",
    name: "Nome",
    email: "E-mail",
    phone: "Telefone",
    zip: "CEP / ZIP",
    message: "Como podemos ajudar?",
    submit: "Enviar",
    sending: "Enviando...",
    needContact: "Informe seu e-mail ou telefone para podermos falar com você.",
    thanks: "Obrigado! Recebemos seu pedido e entraremos em contato em breve.",
    error: "Algo deu errado. Tente novamente.",
  },
};

export function PublicLeadForm({
  slug,
  companyName,
  consentText,
  logoUrl,
  primaryColor,
  textColor,
  ctaLabel,
  language,
}: {
  slug: string;
  companyName: string;
  consentText: string;
  logoUrl: string | null;
  primaryColor: string;
  textColor: string;
  ctaLabel: string | null;
  language: FormLanguage;
}) {
  const t = TEXT[language];
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const phone = String(form.get("phone") ?? "").trim();
    if (!email && !phone) {
      setError(t.needContact);
      return;
    }

    setSending(true);
    setError(null);
    try {
      const response = await fetch("/api/public/leads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          oml: slug,
          name: String(form.get("name") ?? ""),
          email,
          phone,
          zip: String(form.get("zip") ?? ""),
          message: String(form.get("message") ?? ""),
          consent: form.get("consent") === "on",
          lang: language,
          website: String(form.get("website") ?? ""),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? t.error);
      setDone(true);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t.error);
    } finally {
      setSending(false);
    }
  }

  const input =
    "min-h-12 w-full rounded-xl border border-slate-300 px-4 py-3 text-lg outline-none transition focus:border-slate-500";

  return (
    <div style={{ color: textColor }}>
      <div className="mb-6 text-center">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={companyName} className="mx-auto mb-4 max-h-16 object-contain" />
        ) : companyName ? (
          <p className="mb-2 text-xl font-bold">{companyName}</p>
        ) : null}
        <h1 className="text-2xl font-bold">{t.title}</h1>
        <p className="mt-1 text-lg opacity-75">{t.subtitle}</p>
      </div>

      {done ? (
        <p className="rounded-xl bg-emerald-50 px-4 py-6 text-center text-lg font-semibold text-emerald-800" role="status">
          {t.thanks}
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <label className="block">
            <span className="mb-1 block text-base font-semibold">{t.name}</span>
            <input name="name" autoComplete="name" maxLength={120} className={input} />
          </label>
          <label className="block">
            <span className="mb-1 block text-base font-semibold">{t.email}</span>
            <input name="email" type="email" autoComplete="email" maxLength={160} className={input} />
          </label>
          <label className="block">
            <span className="mb-1 block text-base font-semibold">{t.phone}</span>
            <input name="phone" type="tel" autoComplete="tel" maxLength={40} className={input} />
          </label>
          <label className="block">
            <span className="mb-1 block text-base font-semibold">{t.zip}</span>
            <input name="zip" autoComplete="postal-code" maxLength={12} className={input} />
          </label>
          <label className="block">
            <span className="mb-1 block text-base font-semibold">{t.message}</span>
            <textarea name="message" rows={3} maxLength={2000} className={input} />
          </label>

          {/* Campo isca: escondido de pessoas e de leitores de tela. */}
          <input
            name="website"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            className="absolute -left-[9999px] h-0 w-0 opacity-0"
          />

          <label className="flex min-h-12 items-start gap-3 text-base">
            <input name="consent" type="checkbox" className="mt-1 h-6 w-6 shrink-0" />
            <span>{consentText}</span>
          </label>

          {error ? (
            <p className="rounded-xl bg-rose-50 px-4 py-3 text-base font-semibold text-rose-700" role="alert">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={sending}
            className="min-h-14 w-full rounded-xl px-4 py-3 text-lg font-bold text-white transition disabled:opacity-60"
            style={{ backgroundColor: primaryColor }}
          >
            {sending ? t.sending : ctaLabel || t.submit}
          </button>
        </form>
      )}
    </div>
  );
}
