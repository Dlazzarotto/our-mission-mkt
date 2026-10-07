"use client";

import { Check, Copy, LoaderCircle, Plus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { CHANNELS, channelLabels, type Channel } from "@/lib/domain";

// ============================================================
// Resultados do cliente — Fase 1 do marketing autônomo (medição e atribuição).
// Cadeia: peça → link rastreável → clique → lead → qualificado → cliente → receita.
// Todo número vem do banco; ausência de dado aparece como "sem dado", nunca como 0.
// ============================================================

type Totals = {
  trackedClicks: number;
  impressions: number | null;
  leads: number;
  qualified: number;
  customers: number;
  revenue: number;
  spend: number | null;
  attributedShare: number | null;
  leadRate: number | null;
  conversionRate: number | null;
  cpl: number | null;
  cpa: number | null;
  roas: number | null;
};

type LinkRow = {
  id: string;
  slug: string;
  label: string;
  mode: "redirect" | "form";
  channel: Channel | null;
  destination_url: string | null;
  active: boolean;
  content_item_id: string | null;
  clicks: number;
  lead_count: number;
};

type LeadRow = {
  id: string;
  lead_code: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  status: LeadStatus;
  revenue: number | null;
  attribution: "click" | "self_reported" | "unknown";
  self_reported_source: string | null;
  channel: Channel | null;
  source_type: string;
  lost_reason: string | null;
  created_at: string;
  content_items: { public_code: string | null; title: string } | null;
};

type ContentRow = {
  content_item_id: string;
  public_code: string | null;
  title: string;
  channel: Channel;
  format: string;
  status: string;
  family_code: string | null;
  permalink: string | null;
  published_at: string | null;
  scheduled_at: string;
  has_platform_metrics: boolean;
  impressions: number | null;
  tracked_clicks: number;
  leads: number;
  customers: number;
  revenue: number;
  spend: number | null;
  ctr: number | null;
  cpl: number | null;
  roas: number | null;
  score: number | null;
  tier: string | null;
};

type GroupRow = {
  channel?: Channel;
  city?: string;
  state?: string;
  code?: string;
  concept?: string;
  pieces?: number;
  tracked_clicks: number;
  leads: number;
  customers: number;
  revenue: number;
  spend?: number | null;
  cpl?: number | null;
  roas?: number | null;
};

type Results = {
  days: number;
  totals: Totals;
  links: LinkRow[];
  leads: LeadRow[];
  content: ContentRow[];
  channels: GroupRow[];
  locations: GroupRow[];
  families: GroupRow[];
};

type LeadStatus = "new" | "contacted" | "qualified" | "customer" | "lost" | "spam";

const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  new: "Novo",
  contacted: "Contatado",
  qualified: "Qualificado",
  customer: "Virou cliente",
  lost: "Perdido",
  spam: "Spam",
};

const ATTRIBUTION_LABEL: Record<LeadRow["attribution"], string> = {
  click: "Origem comprovada (link)",
  self_reported: "Origem informada",
  unknown: "Origem desconhecida",
};

const TIER_STYLE: Record<string, string> = {
  S: "bg-violet-100 text-violet-800",
  A: "bg-emerald-100 text-emerald-800",
  B: "bg-sky-100 text-sky-800",
  C: "bg-slate-100 text-slate-700",
  D: "bg-amber-100 text-amber-800",
  F: "bg-rose-100 text-rose-800",
};

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat("pt-BR");

function fmtMoney(value: number | null | undefined) {
  return value === null || value === undefined ? "sem dado" : money.format(Number(value));
}
function fmtInt(value: number | null | undefined) {
  return value === null || value === undefined ? "sem dado" : integer.format(Number(value));
}
function fmtPct(value: number | null | undefined) {
  return value === null || value === undefined ? "sem dado" : `${(Number(value) * 100).toFixed(1)}%`;
}
function fmtRoas(value: number | null | undefined) {
  return value === null || value === undefined ? "sem dado" : `${Number(value).toFixed(2)}×`;
}

const card = "rounded-2xl border border-slate-200 bg-white p-5";
const input =
  "min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-sky-500";
const buttonPrimary =
  "inline-flex min-h-11 items-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-slate-800 disabled:opacity-60";
const buttonGhost =
  "inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50";

async function send(url: string, method: "POST" | "PATCH", body: unknown) {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? "Não foi possível salvar.");
  return data;
}

export function ResultsPanel({ clientId }: { clientId: string }) {
  const [days, setDays] = useState(90);
  const [version, setVersion] = useState(0);
  const [data, setData] = useState<Results | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const reload = () => setVersion((value) => value + 1);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/results?clientId=${clientId}&days=${days}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? "Falha ao carregar resultados.");
        return body as Results;
      })
      .then((body) => {
        if (!cancelled) {
          setData(body);
          setLoadError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Falha ao carregar resultados.");
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, days, version]);

  async function act(action: () => Promise<unknown>, okText: string) {
    try {
      await action();
      setMessage({ kind: "ok", text: okText });
      reload();
      return true;
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Erro ao salvar." });
      return false;
    }
  }

  if (loadError && !data) {
    return <p className="rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{loadError}</p>;
  }
  if (!data) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-slate-500">
        <LoaderCircle className="h-4 w-4 animate-spin" /> Carregando resultados...
      </div>
    );
  }

  const t = data.totals;
  const empty = data.links.length === 0 && data.leads.length === 0;

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-950">Resultados que viram dinheiro</h3>
          <p className="text-sm text-slate-500">Receita › clientes › leads qualificados › leads › cliques. Curtida não entra na conta.</p>
        </div>
        <div className="flex items-center gap-2">
          {[30, 90, 365].map((value) => (
            <button
              key={value}
              onClick={() => setDays(value)}
              className={`min-h-10 rounded-lg px-3 text-xs font-bold ${days === value ? "bg-slate-950 text-white" : "border border-slate-200 bg-white text-slate-600"}`}
            >
              {value === 365 ? "12 meses" : `${value} dias`}
            </button>
          ))}
          <button onClick={reload} className={buttonGhost} aria-label="Atualizar">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {message ? (
        <p
          role="status"
          className={`rounded-xl px-3 py-2.5 text-xs font-semibold ${message.kind === "error" ? "border border-rose-100 bg-rose-50 text-rose-700" : "border border-emerald-100 bg-emerald-50 text-emerald-700"}`}
        >
          {message.text}
        </p>
      ) : null}

      {/* ---------- Indicadores do período ---------- */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Receita atribuída" value={fmtMoney(t.revenue)} strong />
        <Kpi label="Viraram clientes" value={fmtInt(t.customers)} hint={`conversão ${fmtPct(t.conversionRate)}`} strong />
        <Kpi label="Leads qualificados" value={fmtInt(t.qualified)} />
        <Kpi label="Leads" value={fmtInt(t.leads)} hint={`${fmtPct(t.attributedShare)} com origem comprovada`} />
        <Kpi label="Cliques rastreados" value={fmtInt(t.trackedClicks)} hint={`taxa de lead ${fmtPct(t.leadRate)}`} />
        <Kpi label="Investimento" value={fmtMoney(t.spend)} />
        <Kpi label="Custo por lead (CPL)" value={fmtMoney(t.cpl)} hint={`por cliente ${fmtMoney(t.cpa)}`} />
        <Kpi label="ROAS" value={fmtRoas(t.roas)} hint="receita ÷ investimento" />
      </div>
      <p className="text-xs text-slate-400">
        Indicadores contam os leads criados nos últimos {data.days} dias. Tabelas abaixo: desde o início.
        &quot;sem dado&quot; = falta informação para calcular (ex.: investimento não lançado).
      </p>

      {empty ? (
        <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-white p-6 text-sm text-slate-600">
          <p className="font-bold text-slate-900">Como começar a medir</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>Crie um link rastreável abaixo (para a peça ou para a bio/perfil).</li>
            <li>Use esse link no post, no anúncio ou na bio — nunca o endereço direto do site.</li>
            <li>Cada clique fica registrado com cidade e aparelho; cada contato vira um lead com origem.</li>
            <li>Quando o lead fechar, marque &quot;Virou cliente&quot; e informe o valor: é isso que mostra qual peça dá dinheiro.</li>
          </ol>
        </div>
      ) : null}

      <LinksSection data={data} clientId={clientId} act={act} />
      <LeadsSection data={data} clientId={clientId} act={act} />
      <ContentSection data={data} act={act} />
      <GroupTable
        title="Por canal"
        rows={data.channels}
        first={(row) => (row.channel ? channelLabels[row.channel] ?? row.channel : "—")}
      />
      <GroupTable
        title="Por cidade"
        subtitle="Cidade do clique (localização aproximada pelo IP) e cidade informada pelo lead."
        rows={data.locations}
        first={(row) => `${row.city}${row.state ? ` · ${row.state}` : ""}`}
      />
      <GroupTable
        title="Por família de conteúdo (conceito)"
        subtitle="A mesma ideia adaptada para vários canais. É a ideia vencedora que se replica, não o post."
        rows={data.families}
        first={(row) => `${row.code} — ${row.concept}`}
      />
    </section>
  );
}

function Kpi({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className={`${card} p-4`}>
      <p className="text-xs font-bold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-1 font-bold ${strong ? "text-2xl text-slate-950" : "text-xl text-slate-800"} ${value === "sem dado" ? "!text-base !text-slate-400" : ""}`}>
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

type Act = (action: () => Promise<unknown>, okText: string) => Promise<boolean>;

function LinksSection({ data, clientId, act }: { data: Results; clientId: string; act: Act }) {
  const [open, setOpen] = useState(data.links.length === 0);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [form, setForm] = useState({ label: "", mode: "redirect" as "redirect" | "form", destinationUrl: "", contentItemId: "", channel: "" });
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  async function create() {
    setBusy(true);
    const ok = await act(
      () =>
        send("/api/links", "POST", {
          clientId,
          label: form.label,
          mode: form.mode,
          destinationUrl: form.mode === "redirect" ? form.destinationUrl : undefined,
          contentItemId: form.contentItemId || undefined,
          channel: form.channel || undefined,
        }),
      "Link criado. Copie e use no post, anúncio ou bio.",
    );
    if (ok) setForm({ label: "", mode: form.mode, destinationUrl: form.destinationUrl, contentItemId: "", channel: "" });
    setBusy(false);
  }

  async function copy(slug: string) {
    await navigator.clipboard.writeText(`${origin}/r/${slug}`);
    setCopied(slug);
    setTimeout(() => setCopied(null), 1800);
  }

  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-bold text-slate-950">Links rastreáveis ({data.links.length})</h4>
        <button onClick={() => setOpen(!open)} className={buttonGhost}>
          <Plus className="h-3.5 w-3.5" /> Novo link
        </button>
      </div>

      {open ? (
        <div className="mt-4 grid gap-3 rounded-xl bg-slate-50 p-4 sm:grid-cols-2">
          <label className="text-xs font-bold text-slate-600 sm:col-span-2">
            Nome do link
            <input className={input} placeholder="Ex.: Reel preço da limpeza — Instagram" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </label>
          <label className="text-xs font-bold text-slate-600">
            Para onde leva
            <select className={input} value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as "redirect" | "form" })}>
              <option value="redirect">Site do cliente (com UTM)</option>
              <option value="form">Formulário de captação hospedado</option>
            </select>
          </label>
          <label className="text-xs font-bold text-slate-600">
            Canal
            <select className={input} value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
              <option value="">(o da peça, ou nenhum)</option>
              {CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {channelLabels[channel]}
                </option>
              ))}
            </select>
          </label>
          {form.mode === "redirect" ? (
            <label className="text-xs font-bold text-slate-600 sm:col-span-2">
              Página de destino (https://)
              <input className={input} placeholder="https://site-do-cliente.com/orcamento" value={form.destinationUrl} onChange={(e) => setForm({ ...form, destinationUrl: e.target.value })} />
            </label>
          ) : null}
          <label className="text-xs font-bold text-slate-600 sm:col-span-2">
            Peça de conteúdo (opcional — sem peça = link de bio/perfil)
            <select className={input} value={form.contentItemId} onChange={(e) => setForm({ ...form, contentItemId: e.target.value })}>
              <option value="">Nenhuma</option>
              {data.content.map((item) => (
                <option key={item.content_item_id} value={item.content_item_id}>
                  {item.public_code} — {item.title.slice(0, 70)}
                </option>
              ))}
            </select>
          </label>
          <div className="sm:col-span-2">
            <button onClick={create} disabled={busy || form.label.trim().length < 2} className={buttonPrimary}>
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Criar link
            </button>
          </div>
        </div>
      ) : null}

      {data.links.length > 0 ? (
        <div className="mt-4 divide-y divide-slate-100">
          {data.links.map((link) => (
            <div key={link.id} className={`flex flex-wrap items-center justify-between gap-3 py-3 ${link.active ? "" : "opacity-50"}`}>
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-900">{link.label}</p>
                <p className="truncate text-xs text-slate-500">
                  /r/{link.slug} · {link.mode === "form" ? "formulário" : link.destination_url}
                  {link.channel ? ` · ${channelLabels[link.channel] ?? link.channel}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-600">
                <span className="font-bold">{integer.format(link.clicks)} cliques</span>
                <span className="font-bold">{integer.format(link.lead_count)} leads</span>
                <button onClick={() => copy(link.slug)} className={buttonGhost}>
                  {copied === link.slug ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied === link.slug ? "Copiado" : "Copiar"}
                </button>
                <button
                  onClick={() => act(() => send("/api/links", "PATCH", { id: link.id, active: !link.active }), link.active ? "Link desativado." : "Link reativado.")}
                  className={buttonGhost}
                >
                  {link.active ? "Desativar" : "Reativar"}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LeadsSection({ data, clientId, act }: { data: Results; clientId: string; act: Act }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "", city: "", state: "", selfReportedSource: "", contentItemId: "" });
  const [revenueDraft, setRevenueDraft] = useState<Record<string, string>>({});

  async function create() {
    setBusy(true);
    const ok = await act(
      () =>
        send("/api/leads", "POST", {
          clientId,
          name: form.name,
          email: form.email,
          phone: form.phone,
          city: form.city,
          state: form.state,
          selfReportedSource: form.selfReportedSource,
          contentItemId: form.contentItemId || undefined,
        }),
      "Lead registrado.",
    );
    if (ok) setForm({ name: "", email: "", phone: "", city: "", state: "", selfReportedSource: "", contentItemId: "" });
    setBusy(false);
  }

  function saveRevenue(lead: LeadRow) {
    const raw = (revenueDraft[lead.id] ?? "").replace(/[^0-9.]/g, "");
    if (raw === "") return;
    act(() => send("/api/leads", "PATCH", { id: lead.id, revenue: Number(raw) }), "Valor registrado.");
  }

  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-bold text-slate-950">Leads ({data.leads.length})</h4>
        <button onClick={() => setOpen(!open)} className={buttonGhost}>
          <Plus className="h-3.5 w-3.5" /> Registrar lead
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Leads do formulário e dos links entram sozinhos. Registre à mão os que chegaram por telefone, indicação ou visita.
      </p>

      {open ? (
        <div className="mt-4 grid gap-3 rounded-xl bg-slate-50 p-4 sm:grid-cols-2">
          <input className={input} placeholder="Nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className={input} placeholder="Telefone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <input className={input} placeholder="E-mail" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <div className="grid grid-cols-3 gap-2">
            <input className={`${input} col-span-2`} placeholder="Cidade" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            <input className={input} placeholder="UF" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
          </div>
          <input
            className={input}
            placeholder='Como nos conheceu? (ex.: "vi o vídeo no Instagram")'
            value={form.selfReportedSource}
            onChange={(e) => setForm({ ...form, selfReportedSource: e.target.value })}
          />
          <select className={input} value={form.contentItemId} onChange={(e) => setForm({ ...form, contentItemId: e.target.value })}>
            <option value="">Peça que trouxe o lead (se souber)</option>
            {data.content.map((item) => (
              <option key={item.content_item_id} value={item.content_item_id}>
                {item.public_code} — {item.title.slice(0, 60)}
              </option>
            ))}
          </select>
          <div className="sm:col-span-2">
            <button onClick={create} disabled={busy || !(form.name || form.email || form.phone)} className={buttonPrimary}>
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Registrar
            </button>
          </div>
        </div>
      ) : null}

      {data.leads.length > 0 ? (
        <div className="mt-4 divide-y divide-slate-100">
          {data.leads.map((lead) => (
            <div key={lead.id} className="grid gap-2 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-900">
                  {lead.lead_code} · {lead.name || lead.email || lead.phone}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {[lead.phone, lead.email].filter(Boolean).join(" · ")}
                  {lead.city ? ` · ${lead.city}${lead.state ? `/${lead.state}` : ""}` : ""}
                  {" · "}
                  {new Date(lead.created_at).toLocaleDateString("pt-BR")}
                </p>
                <p className="truncate text-xs text-slate-400">
                  {ATTRIBUTION_LABEL[lead.attribution]}
                  {lead.content_items ? ` · ${lead.content_items.public_code} ${lead.content_items.title}` : ""}
                  {lead.self_reported_source ? ` · "${lead.self_reported_source}"` : ""}
                  {lead.channel ? ` · ${channelLabels[lead.channel] ?? lead.channel}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Etapa do lead"
                  className="min-h-10 rounded-lg border border-slate-200 bg-white px-2 text-xs font-bold text-slate-700"
                  value={lead.status}
                  onChange={(e) => act(() => send("/api/leads", "PATCH", { id: lead.id, status: e.target.value }), "Etapa atualizada.")}
                >
                  {(Object.keys(LEAD_STATUS_LABEL) as LeadStatus[]).map((status) => (
                    <option key={status} value={status}>
                      {LEAD_STATUS_LABEL[status]}
                    </option>
                  ))}
                </select>
                {lead.status === "customer" ? (
                  <div className="flex items-center gap-1">
                    <input
                      aria-label="Valor da venda (US$)"
                      inputMode="decimal"
                      className="min-h-10 w-28 rounded-lg border border-slate-200 px-2 text-xs"
                      placeholder={lead.revenue === null ? "Valor US$" : money.format(Number(lead.revenue))}
                      value={revenueDraft[lead.id] ?? ""}
                      onChange={(e) => setRevenueDraft({ ...revenueDraft, [lead.id]: e.target.value })}
                    />
                    <button onClick={() => saveRevenue(lead)} className={buttonGhost}>
                      Salvar
                    </button>
                  </div>
                ) : null}
                {lead.status === "customer" && lead.revenue === null ? (
                  <span className="text-xs font-bold text-amber-700">informe o valor</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ContentSection({ data, act }: { data: Results; act: Act }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [mode, setMode] = useState<"metrics" | "publish">("metrics");
  const today = new Date().toISOString().slice(0, 10);
  const [metric, setMetric] = useState({ metricDate: today, impressions: "", reach: "", engagement: "", clicks: "", videoViews: "", spend: "" });
  const [publish, setPublish] = useState({ permalink: "", publishedAt: "" });

  function num(value: string) {
    const clean = value.replace(/[^0-9.]/g, "");
    return clean === "" ? null : Number(clean);
  }

  async function saveMetrics(contentItemId: string) {
    const ok = await act(
      () =>
        send("/api/metrics", "POST", {
          rows: [
            {
              contentItemId,
              metricDate: metric.metricDate,
              impressions: num(metric.impressions),
              reach: num(metric.reach),
              engagement: num(metric.engagement),
              clicks: num(metric.clicks),
              videoViews: num(metric.videoViews),
              spend: num(metric.spend),
            },
          ],
        }),
      "Métricas do dia gravadas (lançar o mesmo dia de novo substitui).",
    );
    if (ok) setMetric({ metricDate: today, impressions: "", reach: "", engagement: "", clicks: "", videoViews: "", spend: "" });
  }

  async function markPublished(contentItemId: string) {
    const ok = await act(
      () =>
        send("/api/content/publication", "PATCH", {
          contentItemId,
          permalink: publish.permalink || undefined,
          publishedAt: publish.publishedAt ? new Date(publish.publishedAt).toISOString() : undefined,
        }),
      "Peça marcada como publicada.",
    );
    if (ok) {
      setPublish({ permalink: "", publishedAt: "" });
      setOpenId(null);
    }
  }

  return (
    <div className={card}>
      <h4 className="text-sm font-bold text-slate-950">Desempenho por peça</h4>
      <p className="mt-1 text-xs text-slate-500">
        Nota (S a F) compara a peça com o histórico do próprio cliente nos últimos 90 dias, com peso maior para receita,
        clientes e leads qualificados. Abaixo de 5 peças medidas, ou com pouco dado, aparece &quot;dados insuficientes&quot;.
      </p>

      {data.content.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">Nenhuma peça ainda.</p>
      ) : (
        <div className="mt-3 divide-y divide-slate-100">
          {data.content.map((row) => (
            <div key={row.content_item_id} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-slate-900">
                    {row.public_code} · {row.title}
                  </p>
                  <p className="text-xs text-slate-500">
                    {channelLabels[row.channel] ?? row.channel} · {row.format}
                    {row.family_code ? ` · família ${row.family_code}` : ""} ·{" "}
                    {row.published_at ? `publicada ${new Date(row.published_at).toLocaleDateString("pt-BR")}` : row.status}
                    {row.permalink ? (
                      <>
                        {" · "}
                        <a href={row.permalink} target="_blank" rel="noreferrer" className="font-bold text-sky-700">
                          ver post
                        </a>
                      </>
                    ) : null}
                  </p>
                </div>
                <span
                  className={`rounded-lg px-2 py-1 text-xs font-bold ${row.tier && TIER_STYLE[row.tier] ? TIER_STYLE[row.tier] : "bg-slate-50 text-slate-400"}`}
                >
                  {row.tier && TIER_STYLE[row.tier] ? `Nota ${row.tier}` : "dados insuficientes"}
                </span>
              </div>

              <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-slate-600 sm:grid-cols-7">
                <Stat label="Impressões" value={row.has_platform_metrics ? fmtInt(row.impressions) : "sem dado"} />
                <Stat label="Cliques" value={fmtInt(row.tracked_clicks)} />
                <Stat label="Leads" value={fmtInt(row.leads)} />
                <Stat label="Clientes" value={fmtInt(row.customers)} />
                <Stat label="Receita" value={fmtMoney(row.revenue)} />
                <Stat label="CPL" value={fmtMoney(row.cpl)} />
                <Stat label="ROAS" value={fmtRoas(row.roas)} />
              </div>

              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  onClick={() => {
                    setMode("metrics");
                    setOpenId(openId === row.content_item_id && mode === "metrics" ? null : row.content_item_id);
                  }}
                  className={buttonGhost}
                >
                  Lançar métricas
                </button>
                {["approved", "scheduled"].includes(row.status) ? (
                  <button
                    onClick={() => {
                      setMode("publish");
                      setOpenId(openId === row.content_item_id && mode === "publish" ? null : row.content_item_id);
                    }}
                    className={buttonGhost}
                  >
                    Marcar como publicada
                  </button>
                ) : null}
              </div>

              {openId === row.content_item_id && mode === "metrics" ? (
                <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-4">
                  <label className="text-xs font-bold text-slate-600">
                    Dia
                    <input type="date" max={today} className={input} value={metric.metricDate} onChange={(e) => setMetric({ ...metric, metricDate: e.target.value })} />
                  </label>
                  {(
                    [
                      ["impressions", "Impressões"],
                      ["reach", "Alcance"],
                      ["engagement", "Engajamento"],
                      ["clicks", "Cliques (plataforma)"],
                      ["videoViews", "Visualizações de vídeo"],
                      ["spend", "Investimento US$"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="text-xs font-bold text-slate-600">
                      {label}
                      <input inputMode="decimal" className={input} value={metric[key]} onChange={(e) => setMetric({ ...metric, [key]: e.target.value })} />
                    </label>
                  ))}
                  <div className="col-span-2 flex items-end sm:col-span-1">
                    <button onClick={() => saveMetrics(row.content_item_id)} className={buttonPrimary}>
                      Gravar
                    </button>
                  </div>
                </div>
              ) : null}

              {openId === row.content_item_id && mode === "publish" ? (
                <div className="mt-3 grid gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
                  <label className="text-xs font-bold text-slate-600">
                    Link do post (https://)
                    <input className={input} value={publish.permalink} onChange={(e) => setPublish({ ...publish, permalink: e.target.value })} />
                  </label>
                  <label className="text-xs font-bold text-slate-600">
                    Publicado em (vazio = agora)
                    <input type="datetime-local" className={input} value={publish.publishedAt} onChange={(e) => setPublish({ ...publish, publishedAt: e.target.value })} />
                  </label>
                  <button onClick={() => markPublished(row.content_item_id)} className={buttonPrimary}>
                    Confirmar
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase text-slate-400">{label}</p>
      <p className={`font-bold ${value === "sem dado" ? "text-slate-300" : "text-slate-800"}`}>{value}</p>
    </div>
  );
}

function GroupTable({
  title,
  subtitle,
  rows,
  first,
}: {
  title: string;
  subtitle?: string;
  rows: GroupRow[];
  first: (row: GroupRow) => string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className={card}>
      <h4 className="text-sm font-bold text-slate-950">{title}</h4>
      {subtitle ? <p className="mt-1 text-xs text-slate-500">{subtitle}</p> : null}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-xs">
          <thead className="text-slate-400">
            <tr>
              <th className="py-2 pr-3 font-bold"> </th>
              <th className="py-2 pr-3 font-bold">Cliques</th>
              <th className="py-2 pr-3 font-bold">Leads</th>
              <th className="py-2 pr-3 font-bold">Clientes</th>
              <th className="py-2 pr-3 font-bold">Receita</th>
              <th className="py-2 pr-3 font-bold">CPL</th>
              <th className="py-2 font-bold">ROAS</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700">
            {rows.map((row, index) => (
              <tr key={`${first(row)}-${index}`}>
                <td className="max-w-[240px] truncate py-2 pr-3 font-bold text-slate-900">{first(row)}</td>
                <td className="py-2 pr-3">{fmtInt(row.tracked_clicks)}</td>
                <td className="py-2 pr-3">{fmtInt(row.leads)}</td>
                <td className="py-2 pr-3">{fmtInt(row.customers)}</td>
                <td className="py-2 pr-3">{fmtMoney(row.revenue)}</td>
                <td className="py-2 pr-3">{row.cpl === undefined ? "—" : fmtMoney(row.cpl)}</td>
                <td className="py-2">{row.roas === undefined ? "—" : fmtRoas(row.roas)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
