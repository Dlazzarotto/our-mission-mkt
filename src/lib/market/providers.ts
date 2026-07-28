// ============================================================
// Provedores de dados de mercado
//
// Princípio do módulo: o sistema NUNCA apresenta número gerado por IA como se
// fosse medição. Cada fonte tem um estado explícito — conectada, indisponível
// ou fora de alcance — e a interface mostra esse estado ao lado do dado.
// ============================================================

export type ProviderId = "google_places" | "google_ads" | "google_trends" | "dataforseo";

export type ProviderStatus = {
  id: ProviderId;
  label: string;
  /** O que esta fonte entrega quando conectada. */
  delivers: string;
  connected: boolean;
  /** Por que não está disponível, quando for o caso. */
  reason?: string;
  /** Como conectar, em uma frase. */
  howTo: string;
};

export function getProviderStatus(): ProviderStatus[] {
  return [
    {
      id: "google_places",
      label: "Google Places",
      delivers: "Concorrentes reais no raio: nome, endereço, site, nota e nº de avaliações",
      connected: Boolean(process.env.GOOGLE_MAPS_API_KEY),
      reason: process.env.GOOGLE_MAPS_API_KEY
        ? undefined
        : "GOOGLE_MAPS_API_KEY não configurada",
      howTo: "Ative Geocoding API e Places API (New) no Google Cloud e crie uma chave.",
    },
    {
      id: "google_ads",
      label: "Google Ads — Keyword Planner",
      delivers: "Volume de busca mensal, concorrência e CPC reais por palavra-chave",
      connected: Boolean(
        process.env.GOOGLE_ADS_DEVELOPER_TOKEN &&
          process.env.GOOGLE_ADS_CLIENT_ID &&
          process.env.GOOGLE_ADS_REFRESH_TOKEN,
      ),
      reason:
        "Exige conta Google Ads e developer token aprovado — a aprovação leva dias ou semanas",
      howTo: "Solicite o developer token no painel do Google Ads e gere as credenciais OAuth.",
    },
    {
      id: "google_trends",
      label: "Google Trends",
      delivers: "Série de interesse de busca em 12 meses e até 5 anos",
      connected: Boolean(process.env.GOOGLE_TRENDS_API_KEY),
      reason: "API em alpha, acesso por convite — normalmente indisponível",
      howTo: "Solicite acesso ao programa alpha da Trends API.",
    },
    {
      id: "dataforseo",
      label: "Fonte de SEO (DataForSEO)",
      delivers: "Posições orgânicas e palavras dos concorrentes",
      connected: Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD),
      reason: "Credenciais não configuradas",
      howTo: "Contrate o provedor e informe login e senha nas variáveis de ambiente.",
    },
  ];
}

export function isConnected(id: ProviderId) {
  return getProviderStatus().find((provider) => provider.id === id)?.connected ?? false;
}

/**
 * Rótulo de procedência exibido ao lado de cada bloco do relatório.
 * "observed"  → veio de um provedor, com data de coleta
 * "ai"        → interpretação do modelo sobre os dados observados
 * "missing"   → não há fonte conectada; o sistema declara em vez de estimar
 */
export type Provenance = "observed" | "ai" | "missing";

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  observed: "Dado coletado",
  ai: "Análise da IA",
  missing: "Sem fonte conectada",
};
