// ============================================================
// Workflow de agência — o processo que um cliente percorre
//
// Cada fase tem dono, entregáveis, prazo e um critério de saída verificável
// contra os dados reais do sistema. A fase só avança quando o entregável
// existe de fato — não quando alguém marca uma caixinha.
// ============================================================

export type AgencyRole = "account" | "strategist" | "designer" | "copywriter" | "analyst" | "client";

export const ROLE_LABEL: Record<AgencyRole, string> = {
  account: "Atendimento",
  strategist: "Estrategista",
  designer: "Designer",
  copywriter: "Redação",
  analyst: "Performance",
  client: "Cliente",
};

export type PhaseId =
  | "onboarding"
  | "discovery"
  | "strategy"
  | "planning"
  | "production"
  | "internal_review"
  | "client_approval"
  | "publishing"
  | "measurement"
  | "optimization";

/** O que o sistema checa para liberar a passagem de fase. */
export type ExitCheck =
  | "brand_kit_configured"
  | "contract_active"
  | "research_completed"
  | "plan_completed"
  | "calendar_ready"
  | "content_produced"
  | "content_reviewed"
  | "content_approved"
  | "content_scheduled"
  | "report_delivered"
  | "manual";

export type TaskTemplate = {
  title: string;
  role: AgencyRole;
  /** Dias após a entrada na fase. */
  dueInDays: number;
};

export type Phase = {
  id: PhaseId;
  order: number;
  name: string;
  /** O que acontece nesta fase, em uma frase. */
  purpose: string;
  owner: AgencyRole;
  /** Prazo alvo da fase inteira, em dias úteis. */
  slaDays: number;
  /** O que precisa existir para a fase ser considerada concluída. */
  exitChecks: ExitCheck[];
  /** O que o cliente ou a equipe recebe ao final. */
  deliverables: string[];
  tasks: TaskTemplate[];
  /** Fase que roda em ciclo, não uma única vez. */
  recurring?: boolean;
};

export const PHASES: Phase[] = [
  {
    id: "onboarding",
    order: 1,
    name: "Onboarding",
    purpose: "Receber o cliente, fechar o escopo e capturar a identidade da marca.",
    owner: "account",
    slaDays: 5,
    exitChecks: ["brand_kit_configured", "contract_active"],
    deliverables: ["Contrato ativo com cadência definida", "Brand kit preenchido", "Acesso aos canais do cliente"],
    tasks: [
      { title: "Reunião de briefing com o cliente", role: "account", dueInDays: 2 },
      { title: "Cadastrar contrato com cadência e entregas", role: "account", dueInDays: 3 },
      { title: "Preencher paleta, tom de voz e CTA do cliente", role: "designer", dueInDays: 4 },
      { title: "Solicitar acessos: site, redes, Google Business", role: "account", dueInDays: 5 },
    ],
  },
  {
    id: "discovery",
    order: 2,
    name: "Diagnóstico",
    purpose: "Entender o território, a concorrência real e o ponto de partida digital.",
    owner: "strategist",
    slaDays: 7,
    exitChecks: ["research_completed"],
    deliverables: ["Pesquisa de mercado com concorrentes coletados", "Leitura de oportunidades", "Auditoria de presença digital"],
    tasks: [
      { title: "Rodar pesquisa de território (ZIP e raio)", role: "strategist", dueInDays: 2 },
      { title: "Revisar a lista de concorrentes coletados", role: "strategist", dueInDays: 4 },
      { title: "Validar oportunidades com o atendimento", role: "account", dueInDays: 6 },
    ],
  },
  {
    id: "strategy",
    order: 3,
    name: "Estratégia",
    purpose: "Definir posicionamento, público e metas antes de produzir qualquer peça.",
    owner: "strategist",
    slaDays: 7,
    exitChecks: ["plan_completed"],
    deliverables: ["Plano estratégico com SWOT e personas", "Metas SMART de 6 meses", "Canais definidos"],
    tasks: [
      { title: "Gerar o plano estratégico", role: "strategist", dueInDays: 2 },
      { title: "Ajustar personas com o que o atendimento sabe do cliente", role: "strategist", dueInDays: 4 },
      { title: "Apresentar a estratégia ao cliente", role: "account", dueInDays: 7 },
    ],
  },
  {
    id: "planning",
    order: 4,
    name: "Planejamento",
    purpose: "Transformar a estratégia em calendário: o que sai, em que canal, em que data.",
    owner: "strategist",
    slaDays: 4,
    exitChecks: ["calendar_ready"],
    deliverables: ["Calendário editorial do ciclo", "Briefing de cada peça", "Datas especiais mapeadas"],
    tasks: [
      { title: "Montar o calendário do ciclo", role: "strategist", dueInDays: 2 },
      { title: "Escrever o briefing das peças prioritárias", role: "strategist", dueInDays: 3 },
      { title: "Confirmar datas especiais e campanhas sazonais", role: "account", dueInDays: 4 },
    ],
  },
  {
    id: "production",
    order: 5,
    name: "Produção",
    purpose: "Criar as peças conforme o briefing e a identidade do cliente.",
    owner: "copywriter",
    slaDays: 5,
    exitChecks: ["content_produced"],
    deliverables: ["Textos das peças do ciclo", "Direção visual de cada peça"],
    tasks: [
      { title: "Gerar os rascunhos do ciclo", role: "copywriter", dueInDays: 2 },
      { title: "Adaptar o texto ao tom de voz do cliente", role: "copywriter", dueInDays: 3 },
      { title: "Produzir a direção visual das peças", role: "designer", dueInDays: 5 },
    ],
  },
  {
    id: "internal_review",
    order: 6,
    name: "Revisão interna",
    purpose: "Conferir qualidade, marca e conformidade antes de o cliente ver.",
    owner: "strategist",
    slaDays: 2,
    exitChecks: ["content_reviewed"],
    deliverables: ["Peças revisadas", "Checklist de marca aprovado"],
    tasks: [
      { title: "Revisar texto: clareza, gramática e CTA", role: "strategist", dueInDays: 1 },
      { title: "Conferir cores, logo e tom contra o brand kit", role: "designer", dueInDays: 1 },
      { title: "Checar promessas e conformidade do setor", role: "account", dueInDays: 2 },
    ],
  },
  {
    id: "client_approval",
    order: 7,
    name: "Aprovação do cliente",
    purpose: "Obter o aceite formal antes de qualquer publicação.",
    owner: "account",
    slaDays: 3,
    exitChecks: ["content_approved"],
    deliverables: ["Peças aprovadas pelo cliente", "Ajustes registrados"],
    tasks: [
      { title: "Enviar as peças para aprovação", role: "account", dueInDays: 1 },
      { title: "Registrar e aplicar os ajustes pedidos", role: "copywriter", dueInDays: 2 },
      { title: "Confirmar o aceite final", role: "account", dueInDays: 3 },
    ],
  },
  {
    id: "publishing",
    order: 8,
    name: "Veiculação",
    purpose: "Publicar nas datas do calendário e ativar as campanhas.",
    owner: "analyst",
    slaDays: 2,
    exitChecks: ["content_scheduled"],
    deliverables: ["Peças agendadas ou publicadas", "Campanhas ativas"],
    tasks: [
      { title: "Agendar as peças nas datas do calendário", role: "analyst", dueInDays: 1 },
      { title: "Subir campanhas e conferir segmentação", role: "analyst", dueInDays: 2 },
      { title: "Confirmar que tudo entrou no ar", role: "account", dueInDays: 2 },
    ],
  },
  {
    id: "measurement",
    order: 9,
    name: "Mensuração",
    purpose: "Medir o que aconteceu e relatar ao cliente com números, não impressões.",
    owner: "analyst",
    slaDays: 3,
    exitChecks: ["report_delivered"],
    deliverables: ["Relatório do ciclo com KPIs", "Comparativo com as metas SMART"],
    tasks: [
      { title: "Coletar métricas de cada canal", role: "analyst", dueInDays: 1 },
      { title: "Comparar o resultado com as metas do plano", role: "analyst", dueInDays: 2 },
      { title: "Apresentar o relatório ao cliente", role: "account", dueInDays: 3 },
    ],
  },
  {
    id: "optimization",
    order: 10,
    name: "Otimização",
    purpose: "Decidir o que dobrar, o que ajustar e o que cortar no próximo ciclo.",
    owner: "strategist",
    slaDays: 3,
    exitChecks: ["manual"],
    deliverables: ["Decisões do ciclo registradas", "Ajustes no calendário seguinte"],
    recurring: true,
    tasks: [
      { title: "Analisar o que teve melhor retorno", role: "analyst", dueInDays: 1 },
      { title: "Definir o que dobrar, ajustar e cortar", role: "strategist", dueInDays: 2 },
      { title: "Alinhar o próximo ciclo com o cliente", role: "account", dueInDays: 3 },
    ],
  },
];

export const PHASE_BY_ID = Object.fromEntries(PHASES.map((phase) => [phase.id, phase])) as Record<
  PhaseId,
  Phase
>;

export const EXIT_CHECK_LABEL: Record<ExitCheck, string> = {
  brand_kit_configured: "Brand kit preenchido (paleta e tom de voz)",
  contract_active: "Contrato ativo cadastrado",
  research_completed: "Pesquisa de mercado com análise concluída",
  plan_completed: "Plano estratégico gerado",
  calendar_ready: "Calendário do ciclo montado",
  content_produced: "Peças produzidas",
  content_reviewed: "Peças revisadas internamente",
  content_approved: "Peças aprovadas pelo cliente",
  content_scheduled: "Peças agendadas ou publicadas",
  report_delivered: "Relatório do ciclo entregue",
  manual: "Confirmação da equipe",
};

/** Depois da otimização, o ciclo recomeça no planejamento. */
export function nextPhase(current: PhaseId): PhaseId | null {
  const phase = PHASE_BY_ID[current];
  if (phase.id === "optimization") return "planning";
  const next = PHASES.find((item) => item.order === phase.order + 1);
  return next?.id ?? null;
}

export function previousPhase(current: PhaseId): PhaseId | null {
  const phase = PHASE_BY_ID[current];
  const previous = PHASES.find((item) => item.order === phase.order - 1);
  return previous?.id ?? null;
}

/** Prazo alvo da fase a partir da entrada, ignorando fins de semana. */
export function dueDateFor(startedAt: Date, businessDays: number) {
  const result = new Date(startedAt);
  let remaining = businessDays;
  while (remaining > 0) {
    result.setDate(result.getDate() + 1);
    const weekday = result.getDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return result;
}

export type PhaseHealth = "on_track" | "at_risk" | "late";

export function phaseHealth(startedAt: string | null, slaDays: number): PhaseHealth {
  if (!startedAt) return "on_track";
  const limite = dueDateFor(new Date(startedAt), slaDays).getTime();
  const agora = Date.now();
  if (agora > limite) return "late";
  const umDia = 24 * 60 * 60 * 1000;
  if (limite - agora < umDia) return "at_risk";
  return "on_track";
}

export const HEALTH_LABEL: Record<PhaseHealth, string> = {
  on_track: "No prazo",
  at_risk: "Perto do limite",
  late: "Atrasada",
};
