import { NextResponse } from "next/server";
import { z } from "zod";
import { ratio } from "@/lib/marketing/tracking";
import { createClient } from "@/lib/supabase/server";

// Painel de resultados do cliente. Tudo lido com a sessão do usuário (RLS).
// Totais do período:
//   * CONTAGENS (leads, qualificados, clientes, origem comprovada, cliques) = count exato
//     feito pelo banco (head + count: "exact"), sem trazer linha nenhuma — nunca truncam.
//   * SOMAS (receita, investimento, impressões) = leitura COMPLETA paginada das linhas do
//     período. O PostgREST corta cada resposta em max-rows (1000 no Supabase) sem avisar;
//     por isso o total de linhas vem do banco (count) e, se não couber no teto, o indicador
//     vira "sem dado" com aviso — nunca um total parcial apresentado como total.
//   * Indicadores derivados: ratio() (função pura testada; sem base = null = "sem dado").
// Tabelas por peça/canal/cidade/família vêm prontas das views do banco.

const PAGE = 1000;
const MAX_ROWS_SOMA = 20_000;

/** Lê todas as linhas (paginando) ou devolve truncated=true se passar do teto. */
async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null; count: number | null }>,
) {
  const rows: T[] = [];
  for (let from = 0; from < MAX_ROWS_SOMA; from += PAGE) {
    const { data, error, count } = await page(from, from + PAGE - 1);
    if (error) return { rows, error, truncated: false };
    rows.push(...(data ?? []));
    if (count !== null && rows.length >= count) return { rows, error: null, truncated: false };
    if (!data || data.length === 0) return { rows, error: null, truncated: count !== null && rows.length < count };
  }
  return { rows, error: null, truncated: true };
}

const querySchema = z.object({
  clientId: z.string().uuid(),
  days: z.coerce.number().int().refine((value) => [30, 90, 365].includes(value)).default(90),
});

type MetricRow = { impressions: number | null; spend: number | string | null };

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const { clientId, days } = querySchema.parse({
      clientId: url.searchParams.get("clientId"),
      days: url.searchParams.get("days") ?? undefined,
    });

    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Sessão inválida." }, { status: 401 });

    const { data: client } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
    if (!client) return NextResponse.json({ error: "Cliente não encontrado ou sem permissão." }, { status: 404 });

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const sinceIso = since.toISOString();

    const periodLeads = () =>
      supabase.from("leads").select("id", { count: "exact", head: true }).eq("client_id", clientId).neq("status", "spam").gte("created_at", sinceIso);

    const [
      clicksQ,
      leadsCountQ,
      qualifiedQ,
      customersQ,
      attributedQ,
      revenueQ,
      metricsQ,
      linksQ,
      leadsQ,
      contentQ,
      scoresQ,
      channelsQ,
      locationsQ,
      familiesQ,
    ] = await Promise.all([
      supabase
        .from("link_clicks")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId)
        .eq("is_bot", false)
        .gte("clicked_at", sinceIso),
      periodLeads(),
      periodLeads().not("qualified_at", "is", null),
      periodLeads().eq("status", "customer"),
      // Só clique comprovado é "origem comprovada"; link_no_click não entra.
      periodLeads().eq("attribution", "click"),
      fetchAll<{ revenue: number | string }>((from, to) =>
        supabase
          .from("leads")
          .select("revenue", { count: "exact" })
          .eq("client_id", clientId)
          .eq("status", "customer")
          .not("revenue", "is", null)
          .gte("created_at", sinceIso)
          .order("id")
          .range(from, to),
      ),
      fetchAll<MetricRow>((from, to) =>
        supabase
          .from("performance_metrics")
          .select("impressions, spend, content_items!inner(client_id)", { count: "exact" })
          .eq("content_items.client_id", clientId)
          .gte("metric_date", sinceIso.slice(0, 10))
          .order("id")
          .range(from, to),
      ),
      supabase
        .from("tracking_links")
        .select("id, slug, label, mode, channel, destination_url, active, created_at, content_item_id, link_clicks(count), leads(count)", { count: "exact" })
        .eq("client_id", clientId)
        .eq("link_clicks.is_bot", false)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase
        .from("leads")
        .select("id, lead_code, name, email, phone, city, state, status, revenue, attribution, self_reported_source, channel, source_type, lost_reason, notes, created_at, content_item_id, content_items(public_code, title)", { count: "exact" })
        .eq("client_id", clientId)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase
        .from("v_content_results")
        .select("*", { count: "exact" })
        .eq("client_id", clientId)
        .order("scheduled_at", { ascending: false })
        .limit(80),
      supabase.from("v_content_scores").select("content_item_id, score, tier, sufficient").eq("client_id", clientId),
      supabase.from("v_channel_results").select("*").eq("client_id", clientId),
      supabase
        .from("v_location_results")
        .select("*")
        .eq("client_id", clientId)
        .order("leads", { ascending: false })
        .order("tracked_clicks", { ascending: false })
        .limit(20),
      supabase
        .from("v_family_results")
        .select("*")
        .eq("client_id", clientId)
        .order("revenue", { ascending: false })
        .order("leads", { ascending: false })
        .limit(20),
    ]);

    const firstError = [
      clicksQ,
      leadsCountQ,
      qualifiedQ,
      customersQ,
      attributedQ,
      revenueQ,
      metricsQ,
      linksQ,
      leadsQ,
      contentQ,
      scoresQ,
      channelsQ,
      locationsQ,
      familiesQ,
    ].find((result) => result.error)?.error;
    if (firstError) return NextResponse.json({ error: firstError.message }, { status: 400 });

    const warnings: string[] = [];
    const leads = leadsCountQ.count ?? 0;
    const qualified = qualifiedQ.count ?? 0;
    const customers = customersQ.count ?? 0;
    const attributed = attributedQ.count ?? 0;
    const trackedClicks = clicksQ.count ?? 0;

    const toCents = (value: number) => Math.round(value * 100) / 100;
    let revenue: number | null = toCents(revenueQ.rows.reduce((sum, row) => sum + Number(row.revenue), 0));
    if (revenueQ.truncated) {
      revenue = null;
      warnings.push(`Receita: mais de ${MAX_ROWS_SOMA} vendas no período — total não exibido para não mostrar valor parcial.`);
    }

    const metricRows = metricsQ.rows;
    let impressions: number | null = metricRows.length > 0 ? metricRows.reduce((sum, row) => sum + (row.impressions ?? 0), 0) : null;
    const spendRows = metricRows.filter((row) => row.spend !== null);
    let spend: number | null = spendRows.length > 0 ? toCents(spendRows.reduce((sum, row) => sum + Number(row.spend), 0)) : null;
    if (metricsQ.truncated) {
      impressions = null;
      spend = null;
      warnings.push(`Métricas: mais de ${MAX_ROWS_SOMA} lançamentos no período — impressões e investimento não exibidos para não mostrar valor parcial.`);
    }

    const scoreById = new Map(
      ((scoresQ.data ?? []) as Array<{ content_item_id: string; score: number | null; tier: string }>).map((row) => [
        row.content_item_id,
        row,
      ]),
    );

    return NextResponse.json({
      days,
      totals: {
        trackedClicks,
        impressions,
        leads,
        qualified,
        customers,
        revenue,
        spend,
        attributedShare: ratio(attributed, leads),
        leadRate: ratio(leads, trackedClicks),
        conversionRate: ratio(customers, leads),
        cpl: spend === null ? null : ratio(spend, leads, 2),
        cpa: spend === null ? null : ratio(spend, customers, 2),
        roas: spend === null ? null : ratio(revenue, spend, 2),
      },
      warnings,
      counts: {
        links: linksQ.count ?? null,
        leads: leadsQ.count ?? null,
        content: contentQ.count ?? null,
      },
      links: (linksQ.data ?? []).map((link) => ({
        ...link,
        clicks: (link.link_clicks as unknown as Array<{ count: number }>)?.[0]?.count ?? 0,
        lead_count: (link.leads as unknown as Array<{ count: number }>)?.[0]?.count ?? 0,
        link_clicks: undefined,
        leads: undefined,
      })),
      leads: leadsQ.data ?? [],
      content: (contentQ.data ?? []).map((row) => ({
        ...row,
        score: scoreById.get(row.content_item_id)?.score ?? null,
        tier: scoreById.get(row.content_item_id)?.tier ?? null,
      })),
      channels: channelsQ.data ?? [],
      locations: locationsQ.data ?? [],
      families: familiesQ.data ?? [],
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Parâmetros inválidos." }, { status: 400 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erro desconhecido" }, { status: 500 });
  }
}
