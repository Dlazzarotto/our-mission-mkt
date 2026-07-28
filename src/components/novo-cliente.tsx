"use client";

import { Plus, X } from "lucide-react";
import { useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";

const RAMOS_SUGERIDOS = [
  "Contabilidade e Serviços Fiscais",
  "Advocacia e Serviços Jurídicos",
  "Limpeza Residencial / Comercial",
  "Construção Civil e Reformas",
  "Imobiliária / Corretagem de Imóveis",
  "Estética e Beleza",
  "Salão de Beleza / Barbearia",
  "Restaurante / Alimentação",
  "Clínica Médica / Saúde",
  "Odontologia",
  "Academia / Personal Trainer",
  "Pet Shop / Veterinária",
  "Manutenção e Reparos",
  "Paisagismo / Jardinagem",
  "Transporte / Logística",
  "Eventos / Festas / Buffet",
  "Fotografia e Vídeo",
  "Tradução / Serviços de Imigração",
  "Educação / Cursos",
  "Tecnologia / Software",
];

const MATURIDADES = [
  "Nunca fez marketing — começando do zero",
  "Tem canais criados, mas parados",
  "Faz algum marketing, mas sem estratégia",
  "Marketing ativo, quer melhorar resultados",
];

export function NovoCliente() {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    companyName: "",
    industry: "",
    service: "",
    region: "",
    differentiators: "",
    marketingMaturity: "",
    contactName: "",
    contactEmail: "",
    instagram: "",
    website: "",
  });

  function set(field: keyof typeof form) {
    return (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((previous) => ({ ...previous, [field]: event.target.value }));
  }

  const valido =
    form.companyName.trim().length >= 2 &&
    form.industry.trim().length >= 2 &&
    form.service.trim().length >= 3 &&
    form.region.trim().length >= 2;

  async function handleSubmit() {
    if (!valido || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: form.companyName.trim(),
          industry: form.industry.trim(),
          service: form.service.trim(),
          region: form.region.trim(),
          differentiators: form.differentiators
            .split(";")
            .map((item) => item.trim())
            .filter(Boolean),
          marketingMaturity: form.marketingMaturity || undefined,
          contactName: form.contactName.trim() || undefined,
          contactEmail: form.contactEmail.trim() || undefined,
          instagram: form.instagram.trim() || undefined,
          website: form.website.trim() || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error ?? "Não foi possível criar o cliente.");
      }
      setAberto(false);
      setForm({
        companyName: "",
        industry: "",
        service: "",
        region: "",
        differentiators: "",
        marketingMaturity: "",
        contactName: "",
        contactEmail: "",
        instagram: "",
        website: "",
      });
      router.push(`/clients/${data.client.id}`);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Erro desconhecido.");
    } finally {
      setLoading(false);
    }
  }

  if (!aberto) {
    return (
      <button
        onClick={() => setAberto(true)}
        className="inline-flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-3 text-sm font-bold text-white transition hover:bg-slate-800"
      >
        <Plus className="h-4 w-4" /> Novo cliente
      </button>
    );
  }

  const inputClass =
    "mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10";

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-bold text-slate-950">Novo cliente</h3>
        <button onClick={() => setAberto(false)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-50">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="text-xs font-bold text-slate-700">Nome da empresa *</span>
          <input value={form.companyName} onChange={set("companyName")} placeholder="Ex.: Wait Happy Cleaning" className={inputClass} />
        </label>
        <label className="block">
          <span className="text-xs font-bold text-slate-700">Ramo *</span>
          <input list="ramos-sugeridos" value={form.industry} onChange={set("industry")} placeholder="Digite ou escolha" className={inputClass} />
          <datalist id="ramos-sugeridos">
            {RAMOS_SUGERIDOS.map((ramo) => (
              <option key={ramo} value={ramo} />
            ))}
          </datalist>
        </label>
        <label className="block">
          <span className="text-xs font-bold text-slate-700">Região de atuação *</span>
          <input value={form.region} onChange={set("region")} placeholder="Ex.: Malden, MA — Grande Boston" className={inputClass} />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs font-bold text-slate-700">Serviço oferecido *</span>
          <input value={form.service} onChange={set("service")} placeholder="O que a empresa faz?" className={inputClass} />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs font-bold text-slate-700">Diferenciais (separe com ;)</span>
          <input value={form.differentiators} onChange={set("differentiators")} placeholder="Atendimento em português; produtos ecológicos" className={inputClass} />
        </label>
        <label className="block">
          <span className="text-xs font-bold text-slate-700">Maturidade em marketing</span>
          <select value={form.marketingMaturity} onChange={set("marketingMaturity")} className={inputClass}>
            <option value="">Selecione…</option>
            {MATURIDADES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-bold text-slate-700">Responsável</span>
          <input value={form.contactName} onChange={set("contactName")} placeholder="Nome do contato" className={inputClass} />
        </label>
        <label className="block">
          <span className="text-xs font-bold text-slate-700">E-mail do responsável</span>
          <input type="email" value={form.contactEmail} onChange={set("contactEmail")} placeholder="contato@empresa.com" className={inputClass} />
        </label>
        <label className="block">
          <span className="text-xs font-bold text-slate-700">Instagram</span>
          <input value={form.instagram} onChange={set("instagram")} placeholder="@empresa" className={inputClass} />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs font-bold text-slate-700">Website</span>
          <input value={form.website} onChange={set("website")} placeholder="www.empresa.com" className={inputClass} />
        </label>
      </div>

      {error ? (
        <p className="mt-4 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2.5 text-xs font-semibold text-rose-700">
          {error}
        </p>
      ) : null}

      <div className="mt-5 flex gap-3">
        <button
          onClick={handleSubmit}
          disabled={!valido || loading}
          className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-bold text-white transition hover:bg-slate-800 disabled:opacity-60"
        >
          {loading ? "Criando..." : "Criar cliente"}
        </button>
        <button onClick={() => setAberto(false)} className="rounded-xl border border-slate-200 px-5 py-3 text-sm font-bold text-slate-600 hover:bg-slate-50">
          Cancelar
        </button>
      </div>
      <p className="mt-3 text-xs text-slate-400">
        O brand kit (paleta editável) e o contrato semanal padrão são criados automaticamente.
      </p>
    </section>
  );
}
