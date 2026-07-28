import Anthropic from "@anthropic-ai/sdk";

// ============================================================
// Módulos portados do EstratégiaPro artifact:
// - Pesquisa de mercado por território (ZIP + raio) em 3 etapas
// - Plano de execução ("como fazer funcionar")
// - Plano estratégico em 5 seções
// No servidor temos busca na web REAL via web_search tool.
// ============================================================

export type ResearchClientInput = {
  companyName: string;
  industry: string;
  service: string;
  region: string;
  differentiators: string[];
  marketingMaturity?: string | null;
  instagram?: string | null;
  website?: string | null;
};

const PAPEL =
  "Você é um estrategista e consultor de marketing sênior, especializado em prestação de serviços, com 20 anos de experiência. Responda SEMPRE em português do Brasil, de forma prática, direta e acionável, em markdown compacto.";

function createAnthropic() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY não configurada no ambiente do servidor.");
  }
  return new Anthropic({ apiKey, timeout: 120_000, maxRetries: 2 });
}

// Tipagem estrutural em vez dos tipos de namespace do SDK: assim a build não
// depende de nomes internos que mudam entre versões do @anthropic-ai/sdk.
function extractText(content: Array<{ type: string; text?: string }>) {
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
  if (!text) {
    throw new Error("A IA não retornou conteúdo de texto.");
  }
  return text;
}

async function callClaude(prompt: string, withWebSearch: boolean, maxTokens = 2500) {
  const anthropic = createAnthropic();
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens,
    system: PAPEL,
    messages: [{ role: "user", content: prompt }],
  };

  if (withWebSearch) {
    // A busca na web roda no servidor (diferente do artifact no app iOS).
    // Cast pontual: o nome da ferramenta é validado pela API, não pelo tipo.
    params.tools = [
      { type: "web_search_20250305", name: "web_search" },
    ] as unknown as Anthropic.MessageCreateParamsNonStreaming["tools"];
  }

  const response = await anthropic.messages.create(params);

  return extractText(response.content);
}

function clientContext(client: ResearchClientInput) {
  return [
    "DADOS DO NEGÓCIO:",
    `- Ramo: ${client.industry} | Empresa: ${client.companyName} | Região: ${client.region}`,
    `- Serviço: ${client.service}`,
    `- Diferenciais: ${client.differentiators.join("; ") || "não informados"}`,
    `- Maturidade em marketing: ${client.marketingMaturity || "não informada"}`,
    `- Instagram: ${client.instagram || "não tem"} | Website: ${client.website || "não tem"}`,
  ].join("\n");
}

// ============================================================
// PESQUISA DE MERCADO
//
// REGRA DO MÓDULO: a IA interpreta dados coletados. Ela NÃO inventa nomes de
// empresas, notas, número de avaliações, volume de busca nem CPC. Quando não há
// provedor conectado para uma métrica, o relatório declara a ausência.
// ============================================================

export const RESEARCH_STAGE_CATALOG = {
  concorrencia: {
    title: "Leitura da concorrência",
    withWeb: false,
    tokens: 3000,
    needsObserved: true,
  },
  territorio: { title: "Perfil do território", withWeb: true, tokens: 2500, needsObserved: false },
  palavras: {
    title: "Palavras-chave candidatas",
    withWeb: false,
    tokens: 2500,
    needsObserved: false,
  },
  digital: { title: "Presença digital dos concorrentes", withWeb: true, tokens: 2500, needsObserved: true },
  ia: { title: "Uso de IA pelos concorrentes", withWeb: true, tokens: 2200, needsObserved: true },
  tendencias: { title: "Tendências e nichos", withWeb: true, tokens: 2200, needsObserved: false },
  oportunidades: { title: "Oportunidades priorizadas", withWeb: false, tokens: 2500, needsObserved: true },
  funil: { title: "Funil de aquisição local", withWeb: false, tokens: 2200, needsObserved: false },
  ads: { title: "Estratégia de anúncios", withWeb: false, tokens: 2500, needsObserved: false },
  relatorio: { title: "Relatório e plano de 12 meses", withWeb: false, tokens: 4000, needsObserved: true },
} as const;

export type ResearchStageId = keyof typeof RESEARCH_STAGE_CATALOG;
export type ResearchDepth = "quick" | "full";

export const QUICK_FLOW: ResearchStageId[] = ["concorrencia", "territorio", "oportunidades", "funil"];
export const FULL_FLOW: ResearchStageId[] = [
  "concorrencia", "territorio", "digital", "ia", "palavras",
  "tendencias", "oportunidades", "funil", "ads", "relatorio",
];

export function stagesFor(depth: ResearchDepth) {
  const ids = depth === "full" ? FULL_FLOW : QUICK_FLOW;
  return ids.map((id, index) => ({ id, index, ...RESEARCH_STAGE_CATALOG[id] }));
}

export const RESEARCH_STAGES = stagesFor("quick");

/** Concorrente já coletado de um provedor real. */
export type ObservedCompetitor = {
  name: string;
  city?: string | null;
  website?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  distanceMiles?: number | null;
  priceBand?: string | null;
  businessHours?: string | null;
  primaryType?: string | null;
};

/** O que foi realmente medido, e por quais fontes. */
export type ObservedData = {
  competitors: ObservedCompetitor[];
  providersUsed: string[];
  keywordMetricsAvailable: boolean;
  trendsAvailable: boolean;
  collectedAt?: string | null;
};

function observedBlock(observed: ObservedData) {
  const linhas: string[] = ["DADOS COLETADOS (fatos verificados — use apenas estes como fatos):"];

  if (observed.competitors.length === 0) {
    linhas.push(
      "- Nenhum concorrente foi coletado. Nenhum provedor de mapas está conectado ou a busca não retornou resultados.",
      "- Consequência: você NÃO deve citar nomes de empresas. Declare que a lista de concorrentes exige conectar o Google Places.",
    );
  } else {
    linhas.push(
      `- ${observed.competitors.length} concorrentes coletados via ${observed.providersUsed.join(", ") || "provedor de mapas"}${observed.collectedAt ? ` em ${observed.collectedAt}` : ""}:`,
    );
    observed.competitors.forEach((competitor, index) => {
      const partes = [
        `${index + 1}. ${competitor.name}`,
        competitor.city ? `cidade: ${competitor.city}` : null,
        competitor.distanceMiles != null ? `distância: ${competitor.distanceMiles} mi` : null,
        competitor.rating != null ? `nota: ${competitor.rating}` : "nota: não informada",
        competitor.reviewCount != null ? `avaliações: ${competitor.reviewCount}` : "avaliações: não informado",
        competitor.website ? `site: ${competitor.website}` : "sem site",
        competitor.businessHours ? `horário: ${competitor.businessHours}` : null,
        competitor.primaryType ? `categoria: ${competitor.primaryType}` : null,
      ].filter(Boolean);
      linhas.push(`  ${partes.join(" | ")}`);
    });
  }

  linhas.push(
    observed.keywordMetricsAvailable
      ? "- Métricas de palavras-chave (volume, concorrência, CPC): disponíveis."
      : "- Métricas de palavras-chave (volume, concorrência, CPC): NÃO disponíveis — Google Ads não conectado.",
    observed.trendsAvailable
      ? "- Série histórica de interesse de busca: disponível."
      : "- Série histórica de interesse de busca: NÃO disponível — Google Trends não conectado.",
  );

  return linhas.join("\n");
}

const REGRAS_HONESTIDADE = `REGRAS OBRIGATÓRIAS:
1. Trate como FATO apenas o que está em DADOS COLETADOS. Não acrescente empresas, notas ou número de avaliações que não estejam ali.
2. NUNCA produza número de volume de busca, CPC ou percentual de participação quando a fonte correspondente estiver marcada como não disponível. Em vez do número, escreva "requer Google Ads conectado".
3. Sua contribuição é a LEITURA dos dados: o que eles significam, onde está a brecha, o que fazer. Isso é análise e deve ser apresentado como tal.
4. Quando precisar de um dado que não existe, diga qual dado falta e como obtê-lo — não preencha com estimativa.
5. Escreva em markdown compacto, direto ao ponto.`;

const RESEARCH_TASKS: Record<ResearchStageId, string> = {
  concorrencia: `TAREFA — LEITURA DA CONCORRÊNCIA: analise a lista coletada acima. Produza:
## Quadro atual
Quem lidera pela combinação de nota e volume de avaliações, e por quê. Cite apenas empresas da lista.
## Quem está vulnerável
Empresas com nota baixa, poucas avaliações, sem site ou com horário limitado — e o que isso abre.
## Espaços vazios
Faixas de preço, horários, bairros ou serviços que ninguém da lista parece cobrir.
## Como este cliente se posiciona
Três ângulos de diferenciação sustentados pelo que a lista mostra.`,
  territorio: `TAREFA — PERFIL DO TERRITÓRIO: use a busca na web para caracterizar a área do ZIP e raio informados. Produza:
## Cidades e bairros no raio
## Perfil da população
Renda, idiomas, perfil de moradia ou de comércio — cite a fonte quando encontrar.
## Leitura de demanda
Este público tende a contratar este serviço? Sustente com o que encontrou e com a densidade de concorrentes observada.
Marque claramente o que veio de fonte encontrada e o que é sua leitura.`,
  palavras: `TAREFA — PALAVRAS-CHAVE CANDIDATAS: proponha os termos que este negócio deveria disputar. Produza:
## Termos prioritários
15 a 20 termos. Para cada: o termo, a intenção (informacional, comercial, transacional ou navegacional) e por que ele importa para este negócio. NÃO informe volume nem CPC — essas colunas exigem Google Ads conectado.
## Variações locais
Combinações com as cidades e bairros do raio.
## Como validar
O que fazer no Keyword Planner para transformar estas candidatas em prioridades com número.`,
  digital: `TAREFA — PRESENÇA DIGITAL DOS CONCORRENTES: para as empresas da lista que têm site, use a busca na web para examinar a presença digital delas. Produza:
## O que eles comunicam
Serviços em destaque, promessas e chamadas para ação nos sites encontrados.
## Sinais de SEO
Termos que aparecem nos títulos e páginas dos que estão melhor posicionados.
## Redes sociais
Onde estão e com que frequência publicam, para os que você conseguir verificar.
## Brechas
3 a 5 falhas concretas na presença digital deles.
Se não conseguir acessar o site de alguma empresa, diga isso em vez de supor.`,
  ia: `TAREFA — USO DE IA PELOS CONCORRENTES: verifique nos sites das empresas da lista se há chatbot, agendamento online, orçamento automático ou lembretes. Produza:
## O que foi encontrado
Empresa por empresa, apenas o que você conseguiu verificar.
## Padrão do mercado local
O que já é comum e o que ninguém oferece.
## Vantagem disponível
Qual automação daria vantagem real a este cliente, com o esforço de implantar.`,
  tendencias: `TAREFA — TENDÊNCIAS E NICHOS: avalie os nichos deste segmento na região. Produza:
## Nichos do segmento
Para cada: demanda aparente, quantos da lista atendem, e margem típica do setor.
## Em alta
O que está crescendo, com a fonte quando houver.
## Saturado
O que a lista mostra estar disputado demais.
Sem série histórica do Trends conectada, apresente isto como leitura setorial, não como medição.`,
  oportunidades: `TAREFA — OPORTUNIDADES PRIORIZADAS: cruze a lista coletada com as etapas anteriores. Produza:
## Oportunidades
Para cada uma: o que é, a evidência nos dados coletados que a sustenta, o esforço e a ação recomendada. Ordene da maior para a menor.
## Público mais promissor
2 a 3 perfis, com o motivo de cada posição.
## O que ainda falta saber
Quais decisões dependem de dados que o sistema ainda não tem, e qual fonte traria cada um.`,
  funil: `TAREFA — FUNIL DE AQUISIÇÃO LOCAL: produza:
## Topo — atrair
## Meio — nutrir
## Fundo — converter
2 a 3 ações em cada, específicas desta área e coerentes com as brechas identificadas na concorrência.
## Primeira ação desta semana`,
  ads: `TAREFA — ESTRATÉGIA DE ANÚNCIOS: produza:
## Onde anunciar primeiro
Canais e formatos, com o motivo baseado no que foi observado.
## Termos para os primeiros testes
Das palavras candidatas, quais testar primeiro e por quê.
## Palavras negativas
O que excluir para não desperdiçar verba.
## Orçamento
Explique a lógica de dimensionamento (teste inicial, leitura, escala). NÃO invente CPC nem custo por contato — diga que esses números vêm do Keyword Planner e das primeiras semanas de campanha.`,
  relatorio: `TAREFA — RELATÓRIO FINAL: consolide tudo em um documento de decisão. Produza:
## Resumo executivo
Cinco linhas: onde este negócio está, contra quem, e a aposta principal.
## O que foi medido
Liste o que veio de dados coletados, com a fonte.
## O que é análise
Liste o que é leitura da IA sobre esses dados.
## O que falta medir
As lacunas e a fonte que resolveria cada uma.
## Plano de 12 meses
### Meses 1 a 3 — fundação
### Meses 4 a 6 — tração
### Meses 7 a 9 — escala
### Meses 10 a 12 — consolidação
Em cada trimestre: foco, 3 ações e o indicador que prova que funcionou.
## Veredicto do território
Nota de 0 a 10 para a atratividade deste raio, com as duas frases que sustentam a nota. Deixe claro que a nota é uma leitura, não uma medição.`,
};

export async function runResearchStage(
  stage: ResearchStageId,
  client: ResearchClientInput,
  zipCode: string,
  radiusMiles: number,
  observed: ObservedData,
  previousResults: string,
) {
  const area = `ÁREA DA PESQUISA: raio de ${radiusMiles} milhas a partir do ZIP code ${zipCode}. Limite toda a análise a esta área.`;
  const previous = previousResults
    ? `\n\nETAPAS ANTERIORES DESTA PESQUISA:\n${previousResults.slice(-4000)}`
    : "";
  const prompt = [
    clientContext(client),
    area,
    observedBlock(observed),
    REGRAS_HONESTIDADE + previous,
    RESEARCH_TASKS[stage],
  ].join("\n\n");

  const config = RESEARCH_STAGE_CATALOG[stage];
  return callClaude(prompt, config.withWeb, config.tokens);
}

// ============================================================
// PLANO DE EXECUÇÃO — "como fazer funcionar"
// ============================================================
export async function generateExecutionPlan(
  client: ResearchClientInput,
  zipCode: string,
  radiusMiles: number,
  researchBase: string,
  observed?: ObservedData,
) {
  const prompt = `${clientContext(client)}
${observed ? `\n${observedBlock(observed)}\n` : ""}
PESQUISA DE TERRITÓRIO JÁ REALIZADA (ZIP ${zipCode}, raio ${radiusMiles} milhas):
${researchBase.slice(0, 3000)}

${REGRAS_HONESTIDADE}

TAREFA — PLANO DE EXECUÇÃO (como fazer a oportunidade funcionar na prática): Transforme a pesquisa acima em um plano operacional que o dono do negócio consiga executar SEM experiência em marketing. Produza:
## Antes de começar — pré-requisitos
Checklist do que precisa existir antes do dia 1 (perfis, verba, materiais, fotos), cada item com esforço (fácil/médio).
## Primeiros 30 dias — semana a semana
### Semana 1
### Semana 2
### Semana 3
### Semana 4
2-3 ações concretas por semana. Para cada ação: o que fazer exatamente e o tempo estimado. Para custo, use "grátis" quando for, e faixas de mercado quando houver desembolso — deixando claro que é faixa de referência, não cotação.
## Roteiro pronto por canal
Para os 2 canais mais importantes desta pesquisa: exatamente o que publicar, dizer ou configurar — com exemplos práticos curtos que o cliente possa copiar.
## Orçamento mínimo vs ideal
Como dimensionar nos dois cenários e onde alocar. Apresente faixas de referência do setor, não cotações — e diga o que confirmar antes de comprometer verba.
## Como saber se está funcionando
3 indicadores simples de acompanhar + número-alvo em 30 dias + regra de decisão: quando DOBRAR o investimento, quando AJUSTAR e quando RECUAR.`;

  return callClaude(prompt, false);
}

// ============================================================
// PLANO ESTRATÉGICO — 5 seções
// (busca na web nas seções que dependem de dados externos)
// ============================================================
export const PLAN_SECTIONS = [
  { id: "auditoria", title: "Auditoria de Presença Digital", withWeb: true },
  { id: "mercado", title: "Mercado, SWOT e Concorrentes", withWeb: true },
  { id: "personas", title: "Buyer Personas", withWeb: false },
  { id: "metas", title: "Metas SMART (6 meses)", withWeb: false },
  { id: "canais", title: "Canais e Calendário Editorial", withWeb: false },
] as const;

export type PlanSectionId = (typeof PLAN_SECTIONS)[number]["id"];

const PLAN_TASKS: Record<PlanSectionId, string> = {
  auditoria: `TAREFA: Auditoria de presença digital. Pesquise na web os canais declarados (busque o site e o nome da empresa no Google). Compare com critérios mínimos (website indexado e mobile, Google Business ativo com avaliações, bio completa nas redes, WhatsApp Business, consistência NAP). Produza:
## Diagnóstico por canal
Para cada canal: **CONFORME** / **PRECISA AJUSTES** / **NÃO EXISTE** + 1 frase do encontrado.
## Lacunas prioritárias
3-5 lacunas mais graves em ordem de impacto.
## Fundação mínima — primeiros passos
Se o cliente está começando do zero: 5 ações em ordem com esforço estimado (fácil/médio/difícil).`,
  mercado: `TAREFA: Análise do mercado local com dados atuais da web. Produza:
## Situação atual do mercado
2 parágrafos com dados recentes (tamanho, tendências, comportamento do consumidor).
## Matriz SWOT
### Forças
### Fraquezas
### Oportunidades
### Ameaças
3-4 itens em cada, específicos para este negócio.
## 3 principais concorrentes reais da região
Nome + ponto forte + ponto fraco + como se posicionar diferente.`,
  personas: `TAREFA: 2 buyer personas detalhadas, coerentes com o diagnóstico e o mercado acima. Para cada:
## Persona [N]: [nome fictício, idade]
- **Perfil:** ocupação, renda, localização
- **Dores:** o que a incomoda hoje
- **Desejos:** o que busca e sonha
- **Objeções:** por que hesitaria em contratar
- **Redes mais usadas:** onde e como consome
- **Gatilho de decisão:** o que a faz fechar`,
  metas: `TAREFA: 3 metas SMART para 6 meses — 1 de aquisição, 1 de conversão/receita, 1 de marca — realistas para o ponto de partida diagnosticado acima. Para cada:
## Meta [N]: [título curto]
- **Específica** / **Mensurável (KPI)** / **Atingível** / **Relevante** / **Temporal** / **Como medir na prática**`,
  canais: `TAREFA: Canais recomendados + calendário editorial do mês 1, com base no diagnóstico, mercado e personas acima. Produza:
## Canais recomendados
3-4 canais com 2 frases cada explicando por que funcionam para este negócio e público.
## Calendário editorial — Mês 1
Semanas 1 a 4, com 2-3 ideias por semana: tema, formato, objetivo (atrair/nutrir/CONVERTER).
## Primeira ação desta semana
1 ação prática para começar amanhã.`,
};

export async function runPlanSection(
  section: PlanSectionId,
  client: ResearchClientInput,
  previousResults: string,
) {
  const previous = previousResults
    ? `\n\nSEÇÕES JÁ GERADAS DO PLANO (use como base — o plano deve ser coerente e realista para este ponto de partida):\n${previousResults.slice(-2600)}`
    : "";
  const prompt = `${clientContext(client)}${previous}\n\n${PLAN_TASKS[section]}`;
  const config = PLAN_SECTIONS.find((item) => item.id === section);
  return callClaude(prompt, Boolean(config?.withWeb));
}
