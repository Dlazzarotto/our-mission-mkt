"use client";

import {
  Activity,
  ArrowUpRight,
  BadgeCheck,
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileText,
  Film,
  ImageIcon,
  Layers3,
  LayoutDashboard,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  Palette,
  Plus,
  Search,
  Send,
  Sparkles,
  UsersRound,
  Video,
  WandSparkles,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  channelLabels,
  formatLabels,
  objectiveLabels,
  statusLabels,
  visualStyleLabels,
  type BrandPalette,
  type ContentItem,
  type ContentStatus,
  type DeliveryRule,
  type VisualStyle,
} from "@/lib/domain";
import {
  demoCampaign,
  demoClient,
  demoContent,
  demoJobs,
} from "@/lib/demo-data";

const clientTabs = [
  { id: "overview", label: "Visão geral", icon: LayoutDashboard },
  { id: "brand", label: "Marca", icon: Palette },
  { id: "contract", label: "Contrato", icon: FileText },
  { id: "calendar", label: "Calendário", icon: CalendarDays },
  { id: "content", label: "Conteúdos", icon: Layers3 },
] as const;

type ClientTab = (typeof clientTabs)[number]["id"];
type MainView = "dashboard" | "clients" | "calendar" | "campaigns" | "jobs";

type Tone = "slate" | "blue" | "amber" | "green" | "purple" | "red";

const toneClasses: Record<Tone, string> = {
  slate: "border-slate-200 bg-slate-50 text-slate-700",
  blue: "border-sky-100 bg-sky-50 text-sky-700",
  amber: "border-amber-100 bg-amber-50 text-amber-700",
  green: "border-emerald-100 bg-emerald-50 text-emerald-700",
  purple: "border-violet-100 bg-violet-50 text-violet-700",
  red: "border-rose-100 bg-rose-50 text-rose-700",
};

const statusTone: Record<ContentStatus, Tone> = {
  planned: "slate",
  generating: "purple",
  review: "amber",
  approved: "blue",
  scheduled: "purple",
  published: "green",
  rejected: "red",
};

function Badge({
  children,
  tone = "slate",
}: {
  children: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${toneClasses[tone]}`}
    >
      {children}
    </span>
  );
}

function SectionHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {eyebrow ? (
          <p className="mb-2 text-xs font-bold tracking-[0.16em] text-sky-700 uppercase">
            {eyebrow}
          </p>
        ) : null}
        <h2 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
          {title}
        </h2>
        {description ? (
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string | number;
  detail: string;
  icon: React.ElementType;
  tone: Tone;
}) {
  const iconTone: Record<Tone, string> = {
    slate: "bg-slate-100 text-slate-700",
    blue: "bg-sky-100 text-sky-700",
    amber: "bg-amber-100 text-amber-700",
    green: "bg-emerald-100 text-emerald-700",
    purple: "bg-violet-100 text-violet-700",
    red: "bg-rose-100 text-rose-700",
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_12px_30px_-22px_rgba(15,23,42,0.35)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-slate-950">{value}</p>
        </div>
        <div className={`rounded-xl p-2.5 ${iconTone[tone]}`}>
          <Icon className="h-5 w-5" strokeWidth={2.2} />
        </div>
      </div>
      <p className="mt-3 text-xs font-medium text-slate-500">{detail}</p>
    </div>
  );
}

function formatDate(value: string, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "medium",
    ...options,
  }).format(new Date(value));
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  })
    .format(new Date(value))
    .replace(".", "")
    .replace(",", "");
}

function formatJobType(type: string) {
  const labels: Record<string, string> = {
    campaign_plan: "Planejamento de campanha",
    content_batch: "Lote de conteúdos",
    rewrite: "Reescrita de conteúdo",
    brand_suggestion: "Sugestão de marca",
  };
  return labels[type] ?? type;
}

function ContentCard({
  item,
  expanded,
  onToggle,
  onApprove,
}: {
  item: ContentItem;
  expanded: boolean;
  onToggle: () => void;
  onApprove: () => void;
}) {
  const isVideo = item.format === "reel" || item.format === "video";

  return (
    <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white transition-shadow hover:shadow-[0_16px_38px_-28px_rgba(15,23,42,0.42)]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-4 p-4 text-left"
      >
        <div
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
            isVideo ? "bg-violet-50 text-violet-700" : "bg-sky-50 text-sky-700"
          }`}
        >
          {isVideo ? <Video className="h-5 w-5" /> : <ImageIcon className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-bold text-slate-900">{item.title}</p>
            <Badge tone={statusTone[item.status]}>{statusLabels[item.status]}</Badge>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {dateLabel(item.scheduledAt)} · {channelLabels[item.channel]} · {formatLabels[item.format]}
          </p>
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      {expanded ? (
        <div className="border-t border-slate-100 px-4 py-4">
          <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
            <div>
              <p className="text-xs font-bold tracking-[0.14em] text-slate-400 uppercase">Legenda</p>
              <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-700">{item.caption}</p>
              {item.hashtags.length ? (
                <p className="mt-3 text-xs leading-5 text-sky-700">{item.hashtags.join(" ")}</p>
              ) : null}
            </div>
            <div className="rounded-xl bg-slate-50 p-3.5">
              <p className="text-xs font-bold tracking-[0.14em] text-slate-400 uppercase">Direção criativa</p>
              <p className="mt-2 text-xs leading-5 text-slate-600">{item.creativeBrief}</p>
              {item.videoScript ? (
                <div className="mt-3 border-t border-slate-200 pt-3">
                  <p className="text-xs font-bold text-violet-700">Roteiro do vídeo</p>
                  <p className="mt-1 whitespace-pre-line text-xs leading-5 text-slate-600">{item.videoScript}</p>
                </div>
              ) : null}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
            {item.status === "review" ? (
              <button
                type="button"
                onClick={onApprove}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-950 px-3 py-2 text-xs font-bold text-white transition hover:bg-slate-800"
              >
                <Check className="h-3.5 w-3.5" /> Aprovar conteúdo
              </button>
            ) : null}
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-50"
            >
              <WandSparkles className="h-3.5 w-3.5 text-violet-600" /> Reescrever com IA
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-50"
            >
              <MoreHorizontal className="h-3.5 w-3.5" /> Mais ações
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function CrmDashboard() {
  const [mainView, setMainView] = useState<MainView>("dashboard");
  const [activeTab, setActiveTab] = useState<ClientTab>("overview");
  const [client, setClient] = useState(demoClient);
  const [contents, setContents] = useState<ContentItem[]>(demoContent);
  const [expandedContent, setExpandedContent] = useState<string | null>(demoContent[0].id);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showMobileNav, setShowMobileNav] = useState(false);
  const [showCreateClient, setShowCreateClient] = useState(false);
  const [generationMessage, setGenerationMessage] = useState<string | null>(null);

  const reviewCount = useMemo(
    () => contents.filter((item) => item.status === "review").length,
    [contents],
  );
  const approvedCount = useMemo(
    () => contents.filter((item) => item.status === "approved").length,
    [contents],
  );
  const weeklyQuota = useMemo(
    () =>
      client.contract.deliveryRules
        .filter((rule) => rule.period === "week")
        .reduce((total, rule) => total + rule.quantity, 0),
    [client.contract.deliveryRules],
  );

  function updatePalette(key: keyof BrandPalette, value: string) {
    setClient((previous) => ({
      ...previous,
      brandKit: {
        ...previous.brandKit,
        palette: { ...previous.brandKit.palette, [key]: value },
      },
    }));
  }

  function updateVisualStyle(value: VisualStyle) {
    setClient((previous) => ({
      ...previous,
      brandKit: { ...previous.brandKit, visualStyle: value },
    }));
  }

  function updateDeliveryRule(ruleId: string, quantity: number) {
    setClient((previous) => ({
      ...previous,
      contract: {
        ...previous.contract,
        deliveryRules: previous.contract.deliveryRules.map((rule) =>
          rule.id === ruleId ? { ...rule, quantity: Math.max(0, quantity) } : rule,
        ),
      },
    }));
  }

  function approveContent(id: string) {
    setContents((previous) =>
      previous.map((item) =>
        item.id === id ? { ...item, status: "approved", approvalNotes: "Aprovado no painel." } : item,
      ),
    );
  }

  async function generateCampaign() {
    if (isGenerating) return;

    setIsGenerating(true);
    setGenerationMessage(null);

    try {
      const response = await fetch("/api/campaigns/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: client.id,
          contractId: client.contract.id,
          targetDate: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Não foi possível enfileirar a campanha.");
      }

      const data = (await response.json()) as { message: string };
      setGenerationMessage(data.message);
      setActiveTab("content");
    } catch (error) {
      // O protótipo continua navegável sem credenciais locais; em produção, a falha é exibida
      // e nenhum conteúdo fictício é inserido.
      if (process.env.NODE_ENV === "development") {
        const newItem: ContentItem = {
          id: `demo-generated-${Date.now()}`,
          campaignId: demoCampaign.id,
          clientId: client.id,
          title: "Checklist de entrada: comece a semana com mais leveza",
          scheduledAt: "2026-08-09T10:00:00-04:00",
          channel: "instagram",
          format: "photo",
          objective: "engage",
          pillar: "Dica prática",
          status: "review",
          caption:
            "Uma casa organizada começa com pequenas escolhas. Salve este checklist para preparar seus ambientes antes de uma semana agitada e conte com a Sunrise Clean Co. quando quiser delegar a limpeza com tranquilidade.\n\nPeça seu orçamento gratuito pelo WhatsApp.",
          hashtags: ["#BostonHome", "#CleaningChecklist", "#MaldenMA", "#HomeRoutine"],
          creativeBrief:
            "Foto editorial de uma bancada organizada com checklist manuscrito, vaso pequeno e produtos discretos. Usar luz natural e detalhes em azul-petróleo e amarelo da marca.",
          imagePrompt:
            "Editorial lifestyle photograph of an organized home counter with a handwritten cleaning checklist, warm natural light, navy blue and warm yellow branded accents, Greater Boston home, premium local cleaning company, no visible text.",
          generatedByAi: true,
        };

        setContents((previous) => [...previous, newItem]);
        setExpandedContent(newItem.id);
        setGenerationMessage("Modo local: rascunho demonstrativo criado e enviado para revisão.");
        setActiveTab("content");
      } else {
        setGenerationMessage(
          error instanceof Error ? error.message : "Erro inesperado ao enfileirar a campanha.",
        );
      }
    } finally {
      setIsGenerating(false);
    }
  }

  const mainNavigation: Array<{ id: MainView; label: string; icon: React.ElementType }> = [
    { id: "dashboard", label: "Visão geral", icon: LayoutDashboard },
    { id: "clients", label: "Clientes", icon: UsersRound },
    { id: "calendar", label: "Calendário", icon: CalendarDays },
    { id: "campaigns", label: "Campanhas", icon: Sparkles },
    { id: "jobs", label: "Automações", icon: Activity },
  ];

  function renderClientContent() {
    if (activeTab === "overview") {
      return (
        <div className="space-y-6">
          <section className="rounded-2xl bg-slate-950 p-6 text-white sm:p-7">
            <div className="grid gap-7 lg:grid-cols-[1.3fr_0.7fr] lg:items-end">
              <div>
                <Badge tone="blue">
                  <BadgeCheck className="h-3.5 w-3.5" /> Contrato ativo até 31 dez. 2026
                </Badge>
                <h3 className="mt-4 text-2xl font-bold tracking-tight">{demoCampaign.name}</h3>
                <p className="mt-2 max-w-xl text-sm leading-6 text-slate-300">{demoCampaign.goal}</p>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Badge tone="amber">{weeklyQuota} entregas por semana</Badge>
                  <Badge tone="purple">Criação automática semanal</Badge>
                  <Badge tone="green">Aprovação obrigatória</Badge>
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs font-bold tracking-[0.14em] text-slate-400 uppercase">Próxima criação por IA</p>
                <p className="mt-2 text-lg font-bold">Domingo, 2 de agosto · 23:00</p>
                <p className="mt-1 text-xs leading-5 text-slate-400">O sistema verificará o contrato e gerará apenas os itens ainda pendentes.</p>
                <button
                  type="button"
                  onClick={generateCampaign}
                  disabled={isGenerating}
                  className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#F6AE2D] px-3 py-2.5 text-xs font-bold text-slate-950 transition hover:bg-[#ffd36c] disabled:cursor-wait disabled:opacity-70"
                >
                  {isGenerating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}
                  {isGenerating ? "Criando rascunhos..." : "Gerar agora"}
                </button>
              </div>
            </div>
          </section>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Em revisão" value={reviewCount} detail="Rascunhos aguardando validação" icon={Clock3} tone="amber" />
            <MetricCard label="Aprovados" value={approvedCount} detail="Prontos para produção ou agendamento" icon={BadgeCheck} tone="blue" />
            <MetricCard label="Entregas da semana" value={weeklyQuota} detail="Conforme contrato ativo" icon={Layers3} tone="purple" />
            <MetricCard label="Datas especiais" value={client.contract.specialDateRules.filter((item) => item.enabled).length} detail="Configuradas no contrato" icon={CalendarDays} tone="green" />
          </div>

          <section className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-slate-950">Próximas entregas</p>
                  <p className="mt-1 text-xs text-slate-500">Campanha atual e itens programados</p>
                </div>
                <button onClick={() => setActiveTab("calendar")} className="text-xs font-bold text-sky-700 hover:text-sky-900">
                  Abrir calendário
                </button>
              </div>
              <div className="mt-5 space-y-3">
                {contents.slice(0, 4).map((item) => (
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab("content");
                      setExpandedContent(item.id);
                    }}
                    key={item.id}
                    className="flex w-full items-center gap-3 rounded-xl p-2 text-left transition hover:bg-slate-50"
                  >
                    <div className="w-12 text-center">
                      <p className="text-xs font-bold text-slate-900">{new Date(item.scheduledAt).getDate()}</p>
                      <p className="text-[10px] font-medium uppercase text-slate-400">ago</p>
                    </div>
                    <div className="h-9 w-px bg-slate-200" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-800">{item.title}</p>
                      <p className="mt-0.5 text-xs text-slate-500">{formatLabels[item.format]} · {objectiveLabels[item.objective]}</p>
                    </div>
                    <Badge tone={statusTone[item.status]}>{statusLabels[item.status]}</Badge>
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-slate-950">Saúde do contrato</p>
                  <p className="mt-1 text-xs text-slate-500">Acompanhamento da entrega mensal</p>
                </div>
                <Badge tone="green"><Activity className="h-3.5 w-3.5" /> Em dia</Badge>
              </div>
              <div className="mt-6 space-y-5">
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-600">Posts regulares</span>
                    <span className="font-bold text-slate-900">9 de 12</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full w-3/4 rounded-full bg-sky-600" />
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-600">Vídeos / Reels</span>
                    <span className="font-bold text-slate-900">3 de 4</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full w-[75%] rounded-full bg-violet-600" />
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-600">Peças promocionais</span>
                    <span className="font-bold text-slate-900">1 de 2</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full w-1/2 rounded-full bg-[#F6AE2D]" />
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      );
    }

    if (activeTab === "brand") {
      const paletteEntries = Object.entries(client.brandKit.palette) as Array<[keyof BrandPalette, string]>;
      const paletteLabels: Record<keyof BrandPalette, string> = {
        primary: "Primária",
        secondary: "Secundária",
        accent: "Destaque",
        background: "Fundo",
        text: "Texto",
      };

      return (
        <div className="space-y-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="text-sm font-bold text-slate-950">Identidade visual</p>
                <p className="mt-1 max-w-xl text-sm leading-6 text-slate-500">Estas regras são incluídas em cada pedido para a IA e em todos os briefings para a equipe criativa.</p>
              </div>
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3.5 py-2.5 text-xs font-bold text-violet-700 transition hover:bg-violet-100"
              >
                <Sparkles className="h-4 w-4" /> Sugerir marca com IA
              </button>
            </div>

            <div className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
              {paletteEntries.map(([key, value]) => (
                <label key={key} className="group rounded-xl border border-slate-200 p-3 transition hover:border-slate-300">
                  <span className="text-xs font-semibold text-slate-600">{paletteLabels[key]}</span>
                  <span className="mt-3 flex items-center gap-3">
                    <span className="relative flex h-10 w-10 overflow-hidden rounded-xl border border-black/10" style={{ backgroundColor: value }}>
                      <input
                        aria-label={`Cor ${paletteLabels[key]}`}
                        type="color"
                        value={value}
                        onChange={(event) => updatePalette(key, event.target.value)}
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      />
                    </span>
                    <span className="font-mono text-xs font-bold text-slate-700">{value.toUpperCase()}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
              <p className="text-sm font-bold text-slate-950">Estilo e voz da marca</p>
              <div className="mt-5 space-y-4">
                <label className="block">
                  <span className="text-xs font-bold text-slate-600">Estilo visual</span>
                  <select
                    value={client.brandKit.visualStyle}
                    onChange={(event) => updateVisualStyle(event.target.value as VisualStyle)}
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-800 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10"
                  >
                    {Object.entries(visualStyleLabels).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs font-bold text-slate-600">Tom de voz</span>
                  <textarea
                    value={client.brandKit.toneOfVoice}
                    onChange={(event) => setClient((previous) => ({ ...previous, brandKit: { ...previous.brandKit, toneOfVoice: event.target.value } }))}
                    rows={4}
                    className="mt-2 w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm leading-6 text-slate-700 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10"
                  />
                </label>
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
              <p className="text-sm font-bold text-slate-950">Guardrails de conteúdo</p>
              <div className="mt-5 space-y-4">
                <div>
                  <p className="text-xs font-bold text-slate-600">Termos obrigatórios</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {client.brandKit.requiredTerms.map((term) => <Badge key={term} tone="blue">{term}</Badge>)}
                    <button className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs font-bold text-slate-500 hover:bg-slate-50"><Plus className="h-3 w-3" /> Adicionar</button>
                  </div>
                </div>
                <div>
                  <p className="text-xs font-bold text-slate-600">Termos a evitar</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {client.brandKit.forbiddenTerms.map((term) => <Badge key={term} tone="red">{term}</Badge>)}
                    <button className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs font-bold text-slate-500 hover:bg-slate-50"><Plus className="h-3 w-3" /> Adicionar</button>
                  </div>
                </div>
                <label className="block border-t border-slate-100 pt-4">
                  <span className="text-xs font-bold text-slate-600">CTA preferencial</span>
                  <input
                    value={client.brandKit.preferredCta}
                    onChange={(event) => setClient((previous) => ({ ...previous, brandKit: { ...previous.brandKit, preferredCta: event.target.value } }))}
                    className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10"
                  />
                </label>
              </div>
            </section>
          </div>
        </div>
      );
    }

    if (activeTab === "contract") {
      return (
        <div className="space-y-6">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm font-bold text-slate-950">{client.contract.name}</p>
                <p className="mt-1 text-sm text-slate-500">Vigência de {formatDate(client.contract.startsAt)} a {formatDate(client.contract.endsAt ?? client.contract.startsAt)}</p>
              </div>
              <Badge tone="green"><BadgeCheck className="h-3.5 w-3.5" /> Contrato ativo</Badge>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-3">
              <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-bold text-slate-500">Mercado</p><p className="mt-1 text-sm font-bold text-slate-900">Estados Unidos</p></div>
              <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-bold text-slate-500">Fuso de publicação</p><p className="mt-1 text-sm font-bold text-slate-900">{client.contract.timezone}</p></div>
              <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-bold text-slate-500">Cadência da IA</p><p className="mt-1 text-sm font-bold text-slate-900">Geração semanal</p></div>
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 sm:px-6">
              <div>
                <p className="text-sm font-bold text-slate-950">Quotas de entrega</p>
                <p className="mt-1 text-xs text-slate-500">A IA só cria conteúdos dentro destas quantidades contratadas.</p>
              </div>
              <button className="inline-flex items-center gap-2 text-xs font-bold text-sky-700 hover:text-sky-900"><Plus className="h-4 w-4" /> Nova quota</button>
            </div>
            <div className="divide-y divide-slate-100">
              {client.contract.deliveryRules.map((rule: DeliveryRule) => (
                <div key={rule.id} className="grid gap-3 p-4 sm:grid-cols-[1fr_1fr_120px_90px] sm:items-center sm:px-6">
                  <div><p className="text-sm font-semibold text-slate-800">{channelLabels[rule.channel]}</p><p className="mt-0.5 text-xs text-slate-500">Canal de entrega</p></div>
                  <div><p className="text-sm font-semibold text-slate-800">{formatLabels[rule.format]}</p><p className="mt-0.5 text-xs text-slate-500">{rule.objective ? objectiveLabels[rule.objective] : "Objetivo flexível"}</p></div>
                  <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-2">
                    <input aria-label="Quantidade contratada" type="number" min="0" value={rule.quantity} onChange={(event) => updateDeliveryRule(rule.id, Number(event.target.value))} className="w-full bg-transparent text-center text-sm font-bold text-slate-900 outline-none" />
                    <span className="text-xs text-slate-500">{rule.period === "week" ? "/sem" : "/mês"}</span>
                  </label>
                  <Badge tone={rule.format === "reel" || rule.format === "video" ? "purple" : "blue"}>{rule.format === "reel" || rule.format === "video" ? <Film className="h-3.5 w-3.5" /> : <ImageIcon className="h-3.5 w-3.5" />}{rule.format === "reel" || rule.format === "video" ? "Vídeo" : "Post"}</Badge>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
            <div className="flex items-center justify-between gap-4">
              <div><p className="text-sm font-bold text-slate-950">Datas especiais incluídas</p><p className="mt-1 text-xs text-slate-500">O motor reserva essas peças antes de preencher o calendário regular.</p></div>
              <button className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"><Plus className="h-3.5 w-3.5" /> Adicionar data</button>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              {client.contract.specialDateRules.map((rule) => (
                <div key={rule.id} className="flex items-center gap-3 rounded-xl border border-slate-200 p-3.5">
                  <div className="rounded-xl bg-amber-50 p-2.5 text-amber-700"><CalendarDays className="h-4 w-4" /></div>
                  <div className="min-w-0 flex-1"><p className="text-sm font-bold text-slate-800">{rule.label}</p><p className="mt-0.5 text-xs text-slate-500">{formatDate(rule.eventDate)} · {rule.quantity} {formatLabels[rule.format]}</p></div>
                  <Badge tone={rule.isExtra ? "green" : "slate"}>{rule.isExtra ? "Extra" : "Substitui"}</Badge>
                </div>
              ))}
            </div>
          </section>
        </div>
      );
    }

    if (activeTab === "calendar") {
      const byDate = [...contents].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
      return (
        <div className="space-y-6">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div><p className="text-sm font-bold text-slate-950">Calendário editorial</p><p className="mt-1 text-sm text-slate-500">Semana de 3 a 9 de agosto · {client.contract.timezone}</p></div>
              <div className="flex items-center gap-2"><button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50">← Semana anterior</button><button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50">Próxima semana →</button></div>
            </div>
            <div className="mt-7 overflow-x-auto pb-1">
              <div className="grid min-w-[760px] grid-cols-7 gap-3">
                {["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"].map((day, index) => {
                  const dayNumber = index + 3;
                  const dayContents = byDate.filter((item) => new Date(item.scheduledAt).getDate() === dayNumber);
                  return (
                    <div key={day} className="min-h-[240px] rounded-xl border border-slate-200 bg-slate-50/70 p-2.5">
                      <div className="flex items-center justify-between"><p className="text-xs font-bold text-slate-500 uppercase">{day}</p><p className="text-sm font-bold text-slate-900">{dayNumber}</p></div>
                      <div className="mt-3 space-y-2">
                        {dayContents.map((item) => (
                          <button key={item.id} onClick={() => { setActiveTab("content"); setExpandedContent(item.id); }} className="w-full rounded-lg border border-slate-200 bg-white p-2 text-left shadow-sm transition hover:border-sky-300">
                            <div className="flex items-center gap-1.5 text-[10px] font-bold text-sky-700"><span className="h-1.5 w-1.5 rounded-full bg-sky-600" /> {formatLabels[item.format]}</div>
                            <p className="mt-1 line-clamp-2 text-xs font-semibold leading-4 text-slate-700">{item.title}</p>
                          </button>
                        ))}
                        {!dayContents.length ? <button className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-slate-300 px-2 py-2 text-[11px] font-bold text-slate-400 hover:bg-white"><Plus className="h-3 w-3" /> Adicionar</button> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        </div>
      );
    }

    return (
      <div className="space-y-5">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div><p className="text-sm font-bold text-slate-950">Conteúdos gerados</p><p className="mt-1 text-sm text-slate-500">Rascunhos baseados no Brand Kit e nas quotas contratadas.</p></div>
            <button onClick={generateCampaign} disabled={isGenerating} className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-bold text-white transition hover:bg-slate-800 disabled:cursor-wait disabled:opacity-70">
              {isGenerating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4 text-[#F6AE2D]" />} {isGenerating ? "Gerando lote..." : "Criar rascunhos por IA"}
            </button>
          </div>
          {generationMessage ? <div className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2.5 text-xs font-semibold text-emerald-700"><Check className="h-4 w-4" /> {generationMessage}<button className="ml-auto" onClick={() => setGenerationMessage(null)}><X className="h-3.5 w-3.5" /></button></div> : null}
        </section>
        <div className="space-y-3">
          {contents.map((item) => <ContentCard key={item.id} item={item} expanded={expandedContent === item.id} onToggle={() => setExpandedContent((current) => current === item.id ? null : item.id)} onApprove={() => approveContent(item.id)} />)}
        </div>
      </div>
    );
  }

  const clientDetailVisible = mainView === "clients";

  return (
    <div className="min-h-screen bg-[#f6f8fb] text-slate-900">
      <div className="flex min-h-screen">
        <aside className="sticky top-0 hidden h-screen w-[252px] shrink-0 flex-col border-r border-slate-200 bg-white px-4 py-5 lg:flex">
          <div className="flex items-center gap-3 px-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-950 shadow-lg shadow-slate-900/10"><Sparkles className="h-5 w-5 text-[#F6AE2D]" /></div>
            <div><p className="text-base font-extrabold tracking-tight text-slate-950">Estratégia<span className="text-sky-700">Pro</span></p><p className="text-[10px] font-bold tracking-[0.14em] text-slate-400 uppercase">Campaign OS</p></div>
          </div>
          <nav className="mt-9 space-y-1">
            {mainNavigation.map(({ id, label, icon: Icon }) => {
              const active = mainView === id;
              return <button type="button" key={id} onClick={() => setMainView(id)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold transition ${active ? "bg-slate-950 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"}`}><Icon className={`h-4.5 w-4.5 ${active ? "text-[#F6AE2D]" : "text-slate-400"}`} />{label}{id === "jobs" ? <span className="ml-auto rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold text-violet-700">1</span> : null}</button>;
            })}
          </nav>
          <div className="mt-auto rounded-2xl bg-slate-950 p-4 text-white"><div className="flex items-center gap-2"><div className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-500 text-xs font-bold">MC</div><div className="min-w-0"><p className="truncate text-xs font-bold">Mariana Costa</p><p className="truncate text-[10px] text-slate-400">EstratégiaPro Agency</p></div><ChevronDown className="ml-auto h-3.5 w-3.5 text-slate-400" /></div></div>
        </aside>

        <main className="min-w-0 flex-1">
          <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6 lg:px-8">
            <div className="flex items-center gap-3"><button onClick={() => setShowMobileNav(true)} className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"><Menu className="h-5 w-5" /></button><div className="hidden items-center gap-2 text-xs text-slate-500 sm:flex"><span>Agência</span><ChevronRight className="h-3.5 w-3.5" /><span className="font-semibold text-slate-800">Operações</span></div></div>
            <div className="flex items-center gap-2"><button className="hidden items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 sm:flex"><Search className="h-4 w-4" /> Buscar</button><button className="relative rounded-lg p-2 text-slate-600 hover:bg-slate-100"><Bell className="h-4.5 w-4.5" /><span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-[#F6AE2D]" /></button><button className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-950 text-xs font-bold text-white lg:hidden">MC</button></div>
          </header>

          <div className="mx-auto max-w-[1480px] px-4 py-7 sm:px-6 lg:px-8 lg:py-9">
            {mainView === "dashboard" ? (
              <div className="space-y-7">
                <SectionHeading eyebrow="Operação da agência" title="Bom dia, Mariana." description="Acompanhe contratos, aprovações e o trabalho que a IA preparou para a sua equipe." action={<button onClick={() => setMainView("clients")} className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 py-3 text-xs font-bold text-white transition hover:bg-slate-800"><Plus className="h-4 w-4" /> Novo cliente</button>} />
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><MetricCard label="Clientes ativos" value="12" detail="2 com revisão pendente" icon={UsersRound} tone="blue" /><MetricCard label="Rascunhos para aprovar" value={reviewCount} detail="Criados pela IA nesta semana" icon={Clock3} tone="amber" /><MetricCard label="Entregas concluídas" value="38" detail="84% da meta mensal" icon={BadgeCheck} tone="green" /><MetricCard label="Jobs automáticos" value="1" detail="Próximo lote no domingo" icon={Activity} tone="purple" /></div>
                <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
                  <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6"><div className="flex items-center justify-between"><div><p className="text-sm font-bold text-slate-950">Fila de aprovação</p><p className="mt-1 text-xs text-slate-500">Conteúdos que precisam de uma decisão humana.</p></div><button onClick={() => { setMainView("clients"); setActiveTab("content"); }} className="text-xs font-bold text-sky-700 hover:text-sky-900">Ver todos</button></div><div className="mt-5 space-y-3">{contents.filter((item) => item.status === "review").slice(0, 3).map((item) => <button onClick={() => { setMainView("clients"); setActiveTab("content"); setExpandedContent(item.id); }} key={item.id} className="flex w-full items-center gap-3 rounded-xl border border-slate-100 p-3 text-left transition hover:border-sky-200 hover:bg-sky-50/30"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-50 text-amber-700"><Clock3 className="h-4 w-4" /></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-800">{item.title}</p><p className="mt-0.5 text-xs text-slate-500">{client.companyName} · {formatLabels[item.format]}</p></div><ChevronRight className="h-4 w-4 text-slate-400" /></button>)}</div></section>
                  <section className="rounded-2xl bg-[#124E66] p-5 text-white sm:p-6"><div className="flex items-start justify-between"><div><p className="text-sm font-bold">Automações da semana</p><p className="mt-1 text-xs leading-5 text-sky-100">A criação só ocorre dentro do contrato e nunca publica sem aprovação.</p></div><div className="rounded-xl bg-white/10 p-2"><WandSparkles className="h-5 w-5 text-[#F6AE2D]" /></div></div><div className="mt-7 rounded-xl border border-white/10 bg-white/5 p-4"><p className="text-xs font-bold tracking-[0.14em] text-sky-200 uppercase">Próximo job</p><p className="mt-2 text-lg font-bold">Campanha semanal</p><p className="mt-1 text-xs text-sky-100">Domingo · 23:00 · Sunrise Clean Co.</p><button onClick={() => { setMainView("clients"); generateCampaign(); }} className="mt-4 inline-flex items-center gap-2 text-xs font-bold text-[#F6AE2D] hover:text-yellow-200">Executar agora <ArrowUpRight className="h-3.5 w-3.5" /></button></div></section>
                </div>
              </div>
            ) : null}

            {clientDetailVisible ? (
              <div className="space-y-6">
                <SectionHeading eyebrow="Cliente selecionado" title={client.companyName} description={`${client.industry} · ${client.region}`} action={<div className="flex gap-2"><button onClick={() => setShowCreateClient(true)} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-50"><Plus className="h-4 w-4" /> Cliente</button><button onClick={generateCampaign} disabled={isGenerating} className="inline-flex items-center gap-2 rounded-xl bg-slate-950 px-3.5 py-2.5 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-70">{isGenerating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4 text-[#F6AE2D]" />} Criar com IA</button></div>} />
                <div className="rounded-2xl border border-slate-200 bg-white p-2"><div className="flex gap-1 overflow-x-auto">{clientTabs.map(({ id, label, icon: Icon }) => <button type="button" key={id} onClick={() => setActiveTab(id)} className={`inline-flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2.5 text-xs font-bold transition ${activeTab === id ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"}`}><Icon className="h-3.5 w-3.5" />{label}</button>)}</div></div>
                {renderClientContent()}
              </div>
            ) : null}

            {mainView === "calendar" ? (
              <div className="space-y-6"><SectionHeading eyebrow="Visão consolidada" title="Calendário da agência" description="Todas as entregas dos clientes, organizadas pela data de publicação." action={<button onClick={() => setMainView("clients")} className="inline-flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-3 text-xs font-bold text-white"><CalendarDays className="h-4 w-4" /> Abrir calendário do cliente</button>} /><div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="grid gap-4 md:grid-cols-3"><MetricCard label="Esta semana" value="26" detail="Entregas planejadas" icon={CalendarDays} tone="blue" /><MetricCard label="Aguardando aprovação" value={reviewCount} detail="Antes de produção" icon={Clock3} tone="amber" /><MetricCard label="Publicados" value="18" detail="No período atual" icon={Send} tone="green" /></div></div></div>
            ) : null}

            {mainView === "campaigns" ? (
              <div className="space-y-6"><SectionHeading eyebrow="Estratégia e IA" title="Campanhas" description="Planeje a mensagem, deixe a IA gerar o primeiro rascunho e valide a qualidade antes da produção." action={<button onClick={() => { setMainView("clients"); generateCampaign(); }} className="inline-flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-3 text-xs font-bold text-white"><WandSparkles className="h-4 w-4 text-[#F6AE2D]" /> Nova campanha IA</button>} /><div className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6"><Badge tone="amber">Em revisão</Badge><h3 className="mt-4 text-xl font-bold text-slate-950">{demoCampaign.name}</h3><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{demoCampaign.goal}</p><div className="mt-5 grid gap-3 sm:grid-cols-3"><div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Período</p><p className="mt-1 text-sm font-bold">3–9 ago.</p></div><div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Itens criados</p><p className="mt-1 text-sm font-bold">{contents.length}</p></div><div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Objetivo</p><p className="mt-1 text-sm font-bold">Conversão local</p></div></div></div></div>
            ) : null}

            {mainView === "jobs" ? (
              <div className="space-y-6"><SectionHeading eyebrow="Operação automática" title="Automações e jobs" description="Cada job é persistido e processado de forma idempotente, evitando a duplicação de campanhas." action={<button onClick={() => { setMainView("clients"); generateCampaign(); }} className="inline-flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-3 text-xs font-bold text-white"><Plus className="h-4 w-4" /> Criar job</button>} /><section className="overflow-hidden rounded-2xl border border-slate-200 bg-white"><div className="grid grid-cols-[1.3fr_0.8fr_0.7fr_0.5fr] gap-4 border-b border-slate-100 bg-slate-50 px-5 py-3 text-[11px] font-bold tracking-[0.12em] text-slate-500 uppercase sm:px-6"><span>Tipo</span><span>Status</span><span>Agendado</span><span>Tentativas</span></div>{demoJobs.map((job) => <div key={job.id} className="grid grid-cols-[1.3fr_0.8fr_0.7fr_0.5fr] gap-4 border-b border-slate-100 px-5 py-4 text-xs sm:px-6"><div><p className="font-bold text-slate-800">{formatJobType(job.type)}</p><p className="mt-1 truncate text-slate-500">{client.companyName}</p></div><div><Badge tone={job.status === "completed" ? "green" : job.status === "queued" ? "purple" : "amber"}>{job.status === "completed" ? "Concluído" : job.status === "queued" ? "Na fila" : "Processando"}</Badge></div><span className="text-slate-600">{formatDate(job.scheduledFor, { day: "2-digit", month: "short" })}</span><span className="font-semibold text-slate-700">{job.attempts}/{job.maxAttempts}</span></div>)}</section><div className="flex items-start gap-3 rounded-2xl border border-sky-100 bg-sky-50 p-4 text-sm text-sky-800"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /><p><strong>Como funciona:</strong> o cron chama apenas o despachante. O despachante cria ou reclama jobs no Supabase; cada job possui chave de idempotência, tentativas e registro de erro.</p></div></div>
            ) : null}
          </div>
        </main>
      </div>

      {showMobileNav ? <div className="fixed inset-0 z-50 bg-slate-950/45 lg:hidden"><button aria-label="Fechar menu" onClick={() => setShowMobileNav(false)} className="absolute inset-0 h-full w-full" /><aside className="relative h-full w-[270px] bg-white p-5 shadow-xl"><div className="flex items-center justify-between"><div className="flex items-center gap-2"><div className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-950"><Sparkles className="h-4 w-4 text-[#F6AE2D]" /></div><p className="font-extrabold">Estratégia<span className="text-sky-700">Pro</span></p></div><button onClick={() => setShowMobileNav(false)} className="rounded-lg p-2 hover:bg-slate-100"><X className="h-4 w-4" /></button></div><nav className="mt-8 space-y-1">{mainNavigation.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => { setMainView(id); setShowMobileNav(false); }} className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-semibold ${mainView === id ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100"}`}><Icon className="h-4 w-4" />{label}</button>)}</nav></aside></div> : null}

      {showCreateClient ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4"><div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl"><div className="flex items-center justify-between"><div><p className="text-sm font-bold text-slate-950">Novo cliente</p><p className="mt-1 text-xs text-slate-500">O cadastro completo ficará conectado ao Supabase.</p></div><button onClick={() => setShowCreateClient(false)} className="rounded-lg p-2 hover:bg-slate-100"><X className="h-4 w-4" /></button></div><div className="mt-5 space-y-3"><input placeholder="Nome da empresa" className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-sky-500" /><input placeholder="Ramo de atuação" className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-sky-500" /><input placeholder="Cidade / região" className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-sky-500" /></div><div className="mt-5 flex justify-end gap-2"><button onClick={() => setShowCreateClient(false)} className="rounded-lg px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100">Cancelar</button><button onClick={() => setShowCreateClient(false)} className="rounded-lg bg-slate-950 px-3.5 py-2 text-xs font-bold text-white">Criar cliente</button></div></div></div> : null}
    </div>
  );
}
