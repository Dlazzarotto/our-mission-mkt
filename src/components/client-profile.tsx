"use client";

import { ImagePlus, LoaderCircle, Palette, Search, Sparkles, WandSparkles } from "lucide-react";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import { paletteFromLogo, validarLogo } from "@/lib/brand/palette-from-image";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { MarkdownLite } from "@/components/markdown-lite";
import { WorkflowPanel } from "@/components/workflow-panel";

// ============================================================
// Perfil do cliente — 4 abas:
// Marca & Paleta (identidade DO CLIENTE, editável a qualquer momento)
// Plano (5 seções) · Pesquisa (ZIP + raio) · Conteúdo (rascunhos do cron)
// ============================================================

type PaletteShape = {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
};

type BrandKitRow = {
  id: string;
  client_id: string;
  palette: PaletteShape;
  tone_of_voice: string;
  preferred_cta: string | null;
  has_logo?: boolean | null;
} | null;

type ClientRow = {
  id: string;
  company_name: string;
  service: string;
  marketing_maturity: string | null;
  instagram: string | null;
  website: string | null;
  differentiators: unknown;
};

type PlanRow = { id: string; created_at: string; sections: Record<string, string> };
type Competitor = {
  name: string;
  city: string | null;
  website: string | null;
  rating: number | null;
  review_count: number | null;
  distance_miles: number | null;
  price_band: string | null;
  fetched_at: string | null;
};

type ResearchRow = {
  id: string;
  created_at: string;
  zip_code: string;
  radius_miles: number;
  ai_analysis: Record<string, string>;
  execution_plan: string | null;
  providers_used?: string[] | null;
  market_competitors?: Competitor[] | null;
};
type ContractRow = {
  id: string;
  name: string;
  status: string;
  generation_cadence: string;
  next_generation_at: string | null;
};
type ContentRow = {
  id: string;
  title: string;
  scheduled_at: string;
  channel: string;
  format: string;
  status: string;
  caption: string | null;
};

const PALETTE_LABELS: Array<{ key: keyof PaletteShape; label: string }> = [
  { key: "primary", label: "Primária" },
  { key: "secondary", label: "Secundária" },
  { key: "accent", label: "Destaque" },
  { key: "background", label: "Fundo" },
  { key: "text", label: "Texto" },
];

const PLAN_TITLES: Record<string, string> = {
  auditoria: "1. Auditoria de Presença Digital",
  mercado: "2. Mercado, SWOT e Concorrentes",
  personas: "3. Buyer Personas",
  metas: "4. Metas SMART (6 meses)",
  canais: "5. Canais e Calendário Editorial",
};

const RESEARCH_TITLES: Record<string, string> = {
  concorrencia: "Leitura da concorrência",
  territorio: "Perfil do território",
  digital: "Presença digital dos concorrentes",
  ia: "Uso de IA pelos concorrentes",
  palavras: "Palavras-chave candidatas",
  tendencias: "Tendências e nichos",
  oportunidades: "Oportunidades priorizadas",
  funil: "Funil de aquisição local",
  ads: "Estratégia de anúncios",
  relatorio: "Relatório e plano de 12 meses",
};

const ORDEM_ANALISE = [
  "concorrencia", "territorio", "digital", "ia", "palavras",
  "tendencias", "oportunidades", "funil", "ads", "relatorio",
];

const RADIUS_OPTIONS = [5, 10, 15, 25, 50];

const STATUS_LABELS: Record<string, string> = {
  planned: "Planejado",
  generating: "Gerando",
  review: "Em revisão",
  approved: "Aprovado",
  scheduled: "Agendado",
  published: "Publicado",
  rejected: "Rejeitado",
};

export function ClientProfile({
  client,
  brandKit,
  logoUrl,
  organizationId,
  plans,
  researches,
  contracts,
  contentItems,
}: {
  client: ClientRow;
  brandKit: BrandKitRow;
  logoUrl?: string | null;
  organizationId: string;
  plans: PlanRow[];
  researches: ResearchRow[];
  contracts: ContractRow[];
  contentItems: ContentRow[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"processo" | "marca" | "plano" | "pesquisa" | "conteudo">("processo");

  // ----- Marca & Paleta -----
  const [palette, setPalette] = useState<PaletteShape>(
    brandKit?.palette ?? {
      primary: "#334155",
      secondary: "#0EA5E9",
      accent: "#10B981",
      background: "#F8FAFC",
      text: "#0F172A",
    },
  );
  const [tone, setTone] = useState(brandKit?.tone_of_voice ?? "Profissional, claro e acolhedor.");
  const [cta, setCta] = useState(brandKit?.preferred_cta ?? "");
  const [temLogo, setTemLogo] = useState<boolean | null>(brandKit?.has_logo ?? null);
  const [tarefaCriada, setTarefaCriada] = useState(false);
  const [logoPreview, setLogoPreview] = useState<string | null>(logoUrl ?? null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoMsg, setLogoMsg] = useState<string | null>(null);
  const [savingBrand, setSavingBrand] = useState(false);
  const [brandMessage, setBrandMessage] = useState<string | null>(null);

  async function marcarTemLogo(valor: boolean) {
    setTemLogo(valor);
    setLogoMsg(null);
    setTarefaCriada(false);
    try {
      await fetch("/api/brand-kit", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: client.id, hasLogo: valor }),
      });
      router.refresh();
    } catch {
      /* a escolha continua valendo na tela */
    }
  }

  async function criarTarefaIdentidade() {
    try {
      const response = await fetch("/api/workflow", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: client.id,
          title: "Criar identidade visual (logo e paleta)",
          role: "designer",
          dueInDays: 7,
        }),
      });
      const data = await response.json();
      if (data.success) setTarefaCriada(true);
      else setLogoMsg(`Erro: ${data.error ?? "não consegui criar a tarefa"}`);
    } catch (error) {
      setLogoMsg(`Erro: ${error instanceof Error ? error.message : "falha ao criar a tarefa"}`);
    }
  }

  async function enviarLogo(file: File) {
    const problema = validarLogo(file);
    if (problema) {
      setLogoMsg(`Erro: ${problema}`);
      return;
    }
    setLogoBusy(true);
    setLogoMsg(null);
    try {
      // A paleta sai da imagem antes do upload — o resultado aparece na hora.
      if (file.type !== "image/svg+xml") {
        try {
          const sugerida = await paletteFromLogo(file);
          setPalette(sugerida);
          setLogoMsg("Cores lidas do logo. Ajuste o que quiser antes de salvar.");
        } catch {
          setLogoMsg("Logo enviado. Não consegui ler as cores desta imagem — defina na mão.");
        }
      } else {
        setLogoMsg("Logo enviado. SVG não permite leitura automática de cores.");
      }

      setLogoPreview(URL.createObjectURL(file));
      setTemLogo(true);

      const supabase = createBrowserClient();
      const extensao = file.name.split(".").pop()?.toLowerCase() || "png";
      // O primeiro nível da pasta precisa ser a organização: é assim que a
      // permissão do bucket identifica quem pode ler e gravar.
      const caminho = `${organizationId}/${client.id}/logo.${extensao}`;

      const { error: uploadError } = await supabase.storage
        .from("brand-assets")
        .upload(caminho, file, { upsert: true, contentType: file.type });

      if (uploadError) throw new Error(uploadError.message);

      const response = await fetch("/api/brand-kit", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: client.id, logoPath: caminho, hasLogo: true }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error ?? "Falha ao registrar o logo.");
      router.refresh();
    } catch (error) {
      setLogoMsg(`Erro: ${error instanceof Error ? error.message : "não consegui enviar"}`);
    } finally {
      setLogoBusy(false);
    }
  }

  async function saveBrandKit() {
    setSavingBrand(true);
    setBrandMessage(null);
    try {
      const response = await fetch("/api/brand-kit", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: client.id,
          palette,
          toneOfVoice: tone.trim(),
          preferredCta: cta.trim(),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error ?? "Falha ao salvar.");
      setBrandMessage("Identidade do cliente salva. As próximas gerações já usam as novas cores.");
      router.refresh();
    } catch (saveError) {
      setBrandMessage(
        `Erro: ${saveError instanceof Error ? saveError.message : "não foi possível salvar"}`,
      );
    } finally {
      setSavingBrand(false);
    }
  }

  // ----- Plano estratégico -----
  const [generatingPlan, setGeneratingPlan] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  async function generatePlan() {
    setGeneratingPlan(true);
    setPlanError(null);
    try {
      const response = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: client.id }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error ?? "Falha ao gerar o plano.");
      router.refresh();
    } catch (planGenerationError) {
      setPlanError(
        planGenerationError instanceof Error ? planGenerationError.message : "Erro desconhecido",
      );
    } finally {
      setGeneratingPlan(false);
    }
  }

  // ----- Pesquisa de mercado -----
  const [zip, setZip] = useState("");
  const [radius, setRadius] = useState(10);
  const [depth, setDepth] = useState<"quick" | "full">("quick");
  const [progress, setProgress] = useState<{ done: number; total: number; title: string } | null>(null);
  const [runningResearch, setRunningResearch] = useState(false);
  const [researchError, setResearchError] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [openResearch, setOpenResearch] = useState<string | null>(researches[0]?.id ?? null);

  // Uma etapa por requisição: a pesquisa completa tem 10 e estouraria o
  // limite de tempo se fosse tudo de uma vez.
  async function runResearch() {
    if (zip.trim().length < 3 || runningResearch) return;
    setRunningResearch(true);
    setResearchError(null);
    setProgress(null);
    try {
      const openResponse = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: client.id,
          zipCode: zip.trim(),
          radiusMiles: radius,
          depth,
        }),
      });
      const opened = await openResponse.json();
      if (!openResponse.ok || !opened.success) {
        throw new Error(opened.error ?? "Não foi possível abrir a pesquisa.");
      }

      const researchId = opened.research.id;
      const stages: Array<{ id: string; title: string }> = opened.stages ?? [];
      setOpenResearch(researchId);

      for (let index = 0; index < stages.length; index += 1) {
        const stage = stages[index];
        setProgress({ done: index, total: stages.length, title: stage.title });
        const stageResponse = await fetch("/api/research", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ researchId, stage: stage.id }),
        });
        const stageData = await stageResponse.json();
        if (!stageResponse.ok || !stageData.success) {
          throw new Error(`Etapa "${stage.title}": ${stageData.error ?? "falhou"}`);
        }
      }

      setProgress(null);
      setZip("");
      router.refresh();
    } catch (researchRunError) {
      setResearchError(
        researchRunError instanceof Error ? researchRunError.message : "Erro desconhecido",
      );
      router.refresh();
    } finally {
      setProgress(null);
      setRunningResearch(false);
    }
  }

  async function generateExecution(researchId: string) {
    if (executingId) return;
    setExecutingId(researchId);
    setResearchError(null);
    try {
      const response = await fetch("/api/research/execution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ researchId }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error ?? "Falha na execução.");
      router.refresh();
    } catch (executionError) {
      setResearchError(
        executionError instanceof Error ? executionError.message : "Erro desconhecido",
      );
    } finally {
      setExecutingId(null);
    }
  }

  // ----- Conteúdo -----
  const [queueMessage, setQueueMessage] = useState<string | null>(null);
  const [queueing, setQueueing] = useState(false);

  async function queueCampaign() {
    setQueueing(true);
    setQueueMessage(null);
    try {
      const response = await fetch("/api/campaigns/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: client.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Falha ao enfileirar.");
      setQueueMessage(
        "Campanha enfileirada. O worker gera os rascunhos em instantes — atualize a página em ~1 minuto.",
      );
    } catch (queueError) {
      setQueueMessage(
        `Erro: ${queueError instanceof Error ? queueError.message : "não foi possível enfileirar"}`,
      );
    } finally {
      setQueueing(false);
    }
  }

  const latestPlan = plans[0] ?? null;
  const tabClass = (active: boolean) =>
    `border-b-2 px-4 py-3 text-sm font-bold transition ${
      active ? "border-sky-600 text-sky-700" : "border-transparent text-slate-400 hover:text-slate-600"
    }`;
  const buttonPrimary =
    "inline-flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-3 text-sm font-bold text-white transition hover:bg-slate-800 disabled:opacity-60";

  return (
    <div>
      <nav className="mb-6 flex overflow-x-auto border-b border-slate-200">
        <button onClick={() => setTab("processo")} className={tabClass(tab === "processo")}>
          🔄 Processo
        </button>
        <button onClick={() => setTab("marca")} className={tabClass(tab === "marca")}>
          🎨 Marca &amp; Paleta
        </button>
        <button onClick={() => setTab("plano")} className={tabClass(tab === "plano")}>
          📋 Plano
        </button>
        <button onClick={() => setTab("pesquisa")} className={tabClass(tab === "pesquisa")}>
          🔍 Pesquisa
        </button>
        <button onClick={() => setTab("conteudo")} className={tabClass(tab === "conteudo")}>
          ✍️ Conteúdo
        </button>
      </nav>

      {/* ================= PROCESSO ================= */}
      {tab === "processo" ? <WorkflowPanel clientId={client.id} /> : null}

      {/* ================= MARCA & PALETA ================= */}
      {tab === "marca" ? (
        <section className="space-y-5">
          <div className="rounded-2xl border border-slate-200 bg-white p-6">
            <div className="mb-1 flex items-center gap-2">
              <Palette className="h-4 w-4 text-sky-600" />
              <h3 className="text-base font-bold text-slate-950">Paleta do cliente</h3>
            </div>
            <p className="mb-5 text-sm text-slate-500">
              As cores são <strong>deste cliente</strong> — não da agência. Mude quando ele pedir; as
              próximas gerações de conteúdo usam automaticamente a paleta atualizada.
            </p>

            {/* Este cliente tem logo? A resposta vira trabalho quando é "não". */}
            <div className="mb-4">
              <p className="mb-2 text-sm font-bold text-slate-900">
                Este cliente já tem logomarca?
              </p>
              <div className="flex flex-wrap gap-2">
                {([
                  { valor: true, label: "Sim, tem logo" },
                  { valor: false, label: "Não tem — precisa criar" },
                ] as const).map((opcao) => (
                  <button
                    key={String(opcao.valor)}
                    onClick={() => marcarTemLogo(opcao.valor)}
                    className={`min-h-11 rounded-xl border-2 px-4 py-2.5 text-sm font-bold transition ${
                      temLogo === opcao.valor
                        ? "border-slate-950 bg-slate-950 text-white"
                        : "border-slate-200 text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {opcao.label}
                  </button>
                ))}
              </div>
            </div>

            {temLogo === false ? (
              <div className="mb-6 rounded-xl border border-amber-100 bg-amber-50 p-4">
                <p className="text-sm font-bold text-amber-900">
                  Criar a identidade visual é uma entrega da agência
                </p>
                <p className="mt-1 text-xs leading-5 text-amber-800">
                  Sem logo, defina a paleta abaixo à mão. Ela guia os materiais até a marca existir.
                </p>
                {tarefaCriada ? (
                  <p className="mt-3 text-xs font-bold text-emerald-700">
                    Tarefa criada na fase atual, para o Designer.
                  </p>
                ) : (
                  <button
                    onClick={criarTarefaIdentidade}
                    className="mt-3 min-h-10 rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-bold text-amber-800 transition hover:bg-amber-100"
                  >
                    + Adicionar tarefa de criar identidade visual
                  </button>
                )}
              </div>
            ) : null}

            {/* Logo: fonte das cores */}
            {temLogo !== false ? (
            <div className="mb-6 flex flex-wrap items-center gap-4 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
              <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-white">
                {logoPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={logoPreview} alt="Logo do cliente" className="max-h-full max-w-full object-contain" />
                ) : (
                  <ImagePlus className="h-6 w-6 text-slate-300" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-slate-900">Logo do cliente</p>
                <p className="mt-0.5 text-xs leading-5 text-slate-500">
                  Ao enviar, o sistema lê as cores da imagem e preenche a paleta abaixo.
                  Você ajusta o que quiser antes de salvar.
                </p>
                <label className="mt-2 inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-50">
                  {logoBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
                  {logoBusy ? "Enviando..." : logoPreview ? "Trocar logo" : "Enviar logo"}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    className="hidden"
                    disabled={logoBusy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) enviarLogo(file);
                      event.target.value = "";
                    }}
                  />
                </label>
              </div>
            </div>
            ) : null}

            {logoMsg ? (
              <p
                className={`mb-4 rounded-xl px-3 py-2.5 text-xs font-semibold ${
                  logoMsg.startsWith("Erro")
                    ? "border border-rose-100 bg-rose-50 text-rose-700"
                    : "border border-emerald-100 bg-emerald-50 text-emerald-700"
                }`}
              >
                {logoMsg}
              </p>
            ) : null}

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              {PALETTE_LABELS.map(({ key, label }) => (
                <label key={key} className="block">
                  <span className="text-xs font-bold text-slate-700">{label}</span>
                  <div className="mt-1.5 flex items-center gap-2">
                    <input
                      type="color"
                      value={palette[key]}
                      onChange={(event) =>
                        setPalette((previous) => ({ ...previous, [key]: event.target.value }))
                      }
                      className="h-11 w-11 shrink-0 cursor-pointer rounded-lg border border-slate-200"
                      aria-label={`Cor ${label}`}
                    />
                    <input
                      value={palette[key]}
                      onChange={(event) =>
                        setPalette((previous) => ({ ...previous, [key]: event.target.value }))
                      }
                      className="w-full rounded-lg border border-slate-200 px-2 py-2 font-mono text-xs text-slate-700 outline-none focus:border-sky-500"
                    />
                  </div>
                </label>
              ))}
            </div>

            {/* Pré-visualização com a identidade do cliente */}
            <div
              className="mt-6 rounded-xl border border-slate-200 p-5"
              style={{ backgroundColor: palette.background }}
            >
              <p className="text-[11px] font-bold tracking-widest uppercase" style={{ color: palette.secondary }}>
                Pré-visualização
              </p>
              <div className="mt-1 flex items-center gap-3">
                {logoPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={logoPreview} alt="" className="h-9 w-9 shrink-0 object-contain" />
                ) : null}
                <p className="text-lg font-bold" style={{ color: palette.primary }}>
                  {client.company_name}
                </p>
              </div>
              <p className="mt-1 text-sm" style={{ color: palette.text }}>
                Assim ficam os materiais com a identidade deste cliente.
              </p>
              <span
                className="mt-3 inline-block rounded-lg px-4 py-2 text-sm font-bold text-white"
                style={{ backgroundColor: palette.accent }}
              >
                {cta || "Fale conosco"}
              </span>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-bold text-slate-700">Tom de voz</span>
                <input
                  value={tone}
                  onChange={(event) => setTone(event.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-sky-500"
                />
              </label>
              <label className="block">
                <span className="text-xs font-bold text-slate-700">CTA preferido</span>
                <input
                  value={cta}
                  onChange={(event) => setCta(event.target.value)}
                  placeholder="Ex.: Agende sua avaliação gratuita"
                  className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-sky-500"
                />
              </label>
            </div>

            {brandMessage ? (
              <p
                className={`mt-4 rounded-xl px-3 py-2.5 text-xs font-semibold ${
                  brandMessage.startsWith("Erro")
                    ? "border border-rose-100 bg-rose-50 text-rose-700"
                    : "border border-emerald-100 bg-emerald-50 text-emerald-700"
                }`}
              >
                {brandMessage}
              </p>
            ) : null}

            <button onClick={saveBrandKit} disabled={savingBrand} className={`mt-5 ${buttonPrimary}`}>
              {savingBrand ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
              {savingBrand ? "Salvando..." : "Salvar identidade do cliente"}
            </button>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6">
            <h3 className="text-base font-bold text-slate-950">Contratos</h3>
            {contracts.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">Nenhum contrato cadastrado.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {contracts.map((contract) => (
                  <li
                    key={contract.id}
                    className="flex items-center justify-between rounded-xl border border-slate-100 px-4 py-3 text-sm"
                  >
                    <span className="font-semibold text-slate-800">{contract.name}</span>
                    <span className="text-xs text-slate-500">
                      {contract.status} · {contract.generation_cadence === "monthly" ? "mensal" : "semanal"}
                      {contract.next_generation_at
                        ? ` · próxima: ${new Date(contract.next_generation_at).toLocaleDateString("pt-BR")}`
                        : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : null}

      {/* ================= PLANO ================= */}
      {tab === "plano" ? (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5">
            <div>
              <h3 className="text-base font-bold text-slate-950">Plano estratégico (5 seções)</h3>
              <p className="text-sm text-slate-500">
                Auditoria digital com busca na web, SWOT, personas, metas SMART e calendário.
              </p>
            </div>
            <button onClick={generatePlan} disabled={generatingPlan} className={buttonPrimary}>
              {generatingPlan ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {generatingPlan ? "Gerando (pode levar minutos)..." : latestPlan ? "Gerar nova versão" : "Gerar plano"}
            </button>
          </div>
          {planError ? (
            <p className="rounded-xl border border-rose-100 bg-rose-50 px-3 py-2.5 text-xs font-semibold text-rose-700">
              {planError}
            </p>
          ) : null}

          {latestPlan ? (
            <div className="space-y-3">
              <p className="text-xs text-slate-400">
                Gerado em {new Date(latestPlan.created_at).toLocaleString("pt-BR")}
              </p>
              {Object.keys(PLAN_TITLES).map((sectionId) =>
                latestPlan.sections[sectionId] ? (
                  <details
                    key={sectionId}
                    open={sectionId === "auditoria"}
                    className="rounded-2xl border border-slate-200 bg-white"
                  >
                    <summary className="cursor-pointer px-5 py-4 text-sm font-bold text-slate-900">
                      {PLAN_TITLES[sectionId]}
                    </summary>
                    <div className="border-t border-slate-100 px-5 py-4">
                      <MarkdownLite text={latestPlan.sections[sectionId]} />
                    </div>
                  </details>
                ) : null,
              )}
            </div>
          ) : (
            <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
              Nenhum plano gerado ainda.
            </div>
          )}
        </section>
      ) : null}

      {/* ================= PESQUISA ================= */}
      {tab === "pesquisa" ? (
        <section className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-6">
            <div className="mb-1 flex items-center gap-2">
              <Search className="h-4 w-4 text-sky-600" />
              <h3 className="text-base font-bold text-slate-950">Pesquisa de mercado por território</h3>
            </div>
            <p className="mb-4 text-sm text-slate-500">
              Coleta os concorrentes reais no raio e depois analisa, etapa por etapa, terminando com
              o veredicto de 0 a 10 do território.
            </p>
            <div className="mb-4 flex gap-2">
              {([
                { id: "quick", label: "Rápida", hint: "4 etapas · 3 a 4 min" },
                { id: "full", label: "Completa", hint: "10 etapas · 8 a 12 min" },
              ] as const).map((option) => (
                <button
                  key={option.id}
                  onClick={() => setDepth(option.id)}
                  className={`flex-1 rounded-xl border-2 px-4 py-3 text-left transition ${
                    depth === option.id
                      ? "border-slate-950 bg-slate-950 text-white"
                      : "border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  <span className="block text-sm font-bold">{option.label}</span>
                  <span className="block text-xs opacity-80">{option.hint}</span>
                </button>
              ))}
            </div>
            {depth === "full" ? (
              <p className="mb-4 rounded-xl bg-slate-50 px-3 py-2.5 text-xs leading-5 text-slate-600">
                Leitura da concorrência coletada, perfil do território, presença digital e uso de IA
                pelos concorrentes, palavras-chave candidatas, nichos, oportunidades, funil,
                estratégia de anúncios e o relatório com plano de 12 meses. Volume de busca e CPC só
                aparecem com o Google Ads conectado — o sistema não estima esses números.
              </p>
            ) : null}
            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="text-xs font-bold text-slate-700">ZIP code base</span>
                <input
                  value={zip}
                  onChange={(event) => setZip(event.target.value)}
                  placeholder="Ex.: 02148"
                  inputMode="numeric"
                  className="mt-1.5 w-36 rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-sky-500"
                />
              </label>
              <div>
                <span className="text-xs font-bold text-slate-700">Raio</span>
                <div className="mt-1.5 flex gap-1.5">
                  {RADIUS_OPTIONS.map((option) => (
                    <button
                      key={option}
                      onClick={() => setRadius(option)}
                      className={`rounded-lg px-3 py-2.5 text-xs font-bold transition ${
                        radius === option
                          ? "bg-slate-950 text-white"
                          : "border border-slate-200 text-slate-500 hover:bg-slate-50"
                      }`}
                    >
                      {option} mi
                    </button>
                  ))}
                </div>
              </div>
              <button
                onClick={runResearch}
                disabled={runningResearch || zip.trim().length < 3}
                className={buttonPrimary}
              >
                {runningResearch ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                {runningResearch
                  ? progress
                    ? `Etapa ${progress.done + 1} de ${progress.total}: ${progress.title}...`
                    : "Abrindo pesquisa..."
                  : depth === "full"
                    ? "Rodar pesquisa completa"
                    : "Pesquisar mercado"}
              </button>
            </div>
            {researchError ? (
              <p className="mt-4 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2.5 text-xs font-semibold text-rose-700">
                {researchError}
              </p>
            ) : null}
          </div>

          {researches.length === 0 ? (
            <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
              Nenhuma pesquisa de território ainda.
            </div>
          ) : (
            researches.map((research) => {
              const isOpen = openResearch === research.id;
              return (
                <div key={research.id} className="rounded-2xl border border-slate-200 bg-white">
                  <button
                    onClick={() => setOpenResearch(isOpen ? null : research.id)}
                    className="flex w-full items-center justify-between px-5 py-4 text-left"
                  >
                    <span className="text-sm font-bold text-slate-900">
                      📍 ZIP {research.zip_code} · raio {research.radius_miles} mi
                      <span className="ml-2 text-xs font-semibold text-slate-400">
                        {(research.market_competitors ?? []).length > 0
                          ? `${(research.market_competitors ?? []).length} coletados`
                          : "sem coleta"}
                      </span>
                    </span>
                    <span className="text-xs text-slate-400">
                      {new Date(research.created_at).toLocaleDateString("pt-BR")} {isOpen ? "▲" : "▼"}
                    </span>
                  </button>
                  {isOpen ? (
                    <div className="border-t border-slate-100 px-5 py-4">
                      {/* Dados coletados de provedores reais */}
                      {(research.market_competitors ?? []).length > 0 ? (
                        <div className="mb-5 rounded-xl border border-emerald-100 bg-emerald-50/40 p-4">
                          <p className="mb-2 flex items-center gap-2 text-sm font-bold text-emerald-800">
                            Dado coletado
                            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold">
                              {(research.market_competitors ?? []).length} concorrentes
                            </span>
                          </p>
                          <div className="overflow-x-auto">
                            <table className="w-full text-left text-xs">
                              <thead className="text-slate-500">
                                <tr>
                                  <th className="pb-1.5 pr-3 font-bold">Empresa</th>
                                  <th className="pb-1.5 pr-3 font-bold">Nota</th>
                                  <th className="pb-1.5 pr-3 font-bold">Avaliações</th>
                                  <th className="pb-1.5 pr-3 font-bold">Distância</th>
                                  <th className="pb-1.5 font-bold">Site</th>
                                </tr>
                              </thead>
                              <tbody className="text-slate-700">
                                {(research.market_competitors ?? []).map((competitor) => (
                                  <tr key={competitor.name} className="border-t border-emerald-100">
                                    <td className="py-1.5 pr-3 font-semibold">{competitor.name}</td>
                                    <td className="py-1.5 pr-3">{competitor.rating ?? "—"}</td>
                                    <td className="py-1.5 pr-3">{competitor.review_count ?? "—"}</td>
                                    <td className="py-1.5 pr-3">
                                      {competitor.distance_miles != null ? `${competitor.distance_miles} mi` : "—"}
                                    </td>
                                    <td className="py-1.5">
                                      {competitor.website ? (
                                        <a
                                          href={competitor.website}
                                          target="_blank"
                                          rel="noreferrer noopener"
                                          className="text-sky-700 underline"
                                        >
                                          abrir
                                        </a>
                                      ) : (
                                        "sem site"
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <p className="mt-2 text-[11px] text-slate-500">
                            Fonte: {(research.providers_used ?? []).join(", ") || "provedor de mapas"} · dados do Google
                          </p>
                        </div>
                      ) : (
                        <div className="mb-5 rounded-xl border border-amber-100 bg-amber-50 p-4 text-xs leading-5 text-amber-800">
                          Nenhum concorrente foi coletado nesta pesquisa. Conecte o Google Places
                          para obter a lista real — o sistema não inventa empresas.
                        </div>
                      )}

                      {/* Interpretação da IA sobre o que foi coletado */}
                      <p className="mb-2 text-sm font-bold text-sky-800">Análise da IA</p>
                      {ORDEM_ANALISE.map((stageId, stageIndex) =>
                        research.ai_analysis?.[stageId] ? (
                          <div key={stageId} className="mb-4">
                            <p className="mb-1 text-sm font-bold text-slate-800">
                              {stageIndex + 1}. {RESEARCH_TITLES[stageId] ?? stageId}
                            </p>
                            <MarkdownLite text={research.ai_analysis[stageId]} />
                          </div>
                        ) : null,
                      )}

                      <div className="mt-4 border-t-2 border-slate-100 pt-4">
                        {research.execution_plan ? (
                          <div>
                            <p className="mb-1 text-sm font-bold text-amber-700">
                              ▶ Plano de Execução — como fazer funcionar
                            </p>
                            <MarkdownLite text={research.execution_plan} />
                          </div>
                        ) : (
                          <button
                            onClick={() => generateExecution(research.id)}
                            disabled={executingId !== null}
                            className={buttonPrimary}
                          >
                            {executingId === research.id ? (
                              <LoaderCircle className="h-4 w-4 animate-spin" />
                            ) : (
                              <WandSparkles className="h-4 w-4" />
                            )}
                            {executingId === research.id
                              ? "Montando o plano..."
                              : "▶ Como fazer funcionar — gerar plano de execução"}
                          </button>
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </section>
      ) : null}

      {/* ================= CONTEÚDO ================= */}
      {tab === "conteudo" ? (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5">
            <div>
              <h3 className="text-base font-bold text-slate-950">Rascunhos de conteúdo</h3>
              <p className="text-sm text-slate-500">
                Gerados pelo cron conforme o contrato — ou sob demanda agora.
              </p>
            </div>
            <button onClick={queueCampaign} disabled={queueing} className={buttonPrimary}>
              {queueing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {queueing ? "Enfileirando..." : "Gerar campanha agora"}
            </button>
          </div>
          {queueMessage ? (
            <p
              className={`rounded-xl px-3 py-2.5 text-xs font-semibold ${
                queueMessage.startsWith("Erro")
                  ? "border border-rose-100 bg-rose-50 text-rose-700"
                  : "border border-emerald-100 bg-emerald-50 text-emerald-700"
              }`}
            >
              {queueMessage}
            </p>
          ) : null}

          {contentItems.length === 0 ? (
            <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
              Nenhum conteúdo ainda. Use “Gerar campanha agora” ou aguarde o próximo ciclo do cron.
            </div>
          ) : (
            contentItems.map((item) => (
              <details key={item.id} className="rounded-2xl border border-slate-200 bg-white">
                <summary className="flex cursor-pointer items-center justify-between px-5 py-4">
                  <span className="min-w-0 truncate pr-3 text-sm font-bold text-slate-900">
                    {item.title}
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">
                    {item.channel} · {item.format} ·{" "}
                    {new Date(item.scheduled_at).toLocaleDateString("pt-BR")} ·{" "}
                    <span className="font-bold text-sky-700">
                      {STATUS_LABELS[item.status] ?? item.status}
                    </span>
                  </span>
                </summary>
                {item.caption ? (
                  <div className="border-t border-slate-100 px-5 py-4 text-sm whitespace-pre-wrap text-slate-700">
                    {item.caption}
                  </div>
                ) : null}
              </details>
            ))
          )}
        </section>
      ) : null}
    </div>
  );
}
