import { NextResponse } from "next/server";
import { z } from "zod";
import { ratio } from "@/lib/marketing/tracking";
import { createClient } from "@/lib/supabase/server";

// Painel de resultados do cliente. Tudo lido com a sessão do usuário (RLS):
// números vêm das views do banco; aqui só se soma o período e se divide com
// segurança (sem base = null = "sem dado", nunca zero inventado).

const querySchema = z.object({
  clientId: z.string().uuid(),
  days: z.coerce.number().int().refine((value) => [30, 90, 365].includes(value)).default(90),
});

type LeadRow = {
  status: string;
  revenue: number | null;
  qualified_at: string | null;
  attribution: string;
};

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

    const [clicksQ, periodLeadsQ, metricsQ, linksQ, leadsQ, contentQ, scoresQ, channelsQ, locationsQ, familiesQ] =
      await Promise.all([
        supabase
          .from("link_clicks")
          .select("id", { count: "exact", head: true })
          .eq("client_id", clientId)
          .eq("is_bot", false)
          .gte("clicked_at", sinceIso),
        supabase
          .from("leads")
          .select("status, revenue, qualified_at, attribution")
          .eq("client_id", clientId)
          .neq("status", "spam")
          .gte("created_at", sinceIso)
          .limit(5000),
        supabase
          .from("performance_metrics")
          .select("impressions, reach, spend, content_items!inner(client_id)")
          .eq("content_items.client_id", clientId)
          .gte("metric_date", sinceIso.slice(0, 10))
          .limit(10000),
        supabase
          .from("tracking_links")
          .select("id, slug, label, mode, channel, destination_url, active, created_at, content_item_id, link_clicks(count), leads(count)")
          .eq("client_id", clientId)
          .eq("link_clicks.is_bot", false)
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("leads")
          .select("id, lead_code, name, email, phone, city, state, status, revenue, attribution, self_reported_source, channel, source_type, lost_reason, notes, created_at, content_item_id, content_items(public_code, title)")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("v_content_results")
          .select("*")
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

    const firstError = [clicksQ, periodLeadsQ, metricsQ, linksQ, leadsQ, contentQ, scoresQ, channelsQ, locationsQ, familiesQ].find(
      (result) => result.error,
    )?.error;
    if (firstError) return NextResponse.json({ error: firstError.message }, { status: 400 });

    const periodLeads = (periodLeadsQ.data ?? []) as LeadRow[];
    const leads = periodLeads.length;
    const qualified = periodLeads.filter((lead) => lead.qualified_at).length;
    const customers = periodLeads.filter((lead) => lead.status === "customer").length;
    const revenue = periodLeads
      .filter((lead) => lead.status === "customer")
      .reduce((sum, lead) => sum + Number(lead.revenue ?? 0), 0);
    const attributed = periodLeads.filter((lead) => lead.attribution === "click").length;

    const metricRows = (metricsQ.data ?? []) as Array<{ impressions: number | null; reach: number | null; spend: number | null }>;
    const hasMetrics = metricRows.length > 0;
    const impressions = hasMetrics ? metricRows.reduce((sum, row) => sum + (row.impressions ?? 0), 0) : null;
    const spendRows = metricRows.filter((row) => row.spend !== null);
    const spend = spendRows.length > 0 ? spendRows.reduce((sum, row) => sum + Number(row.spend), 0) : null;
    const trackedClicks = clicksQ.count ?? 0;

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
        revenue: Math.round(revenue * 100) / 100,
        spend: spend === null ? null : Math.round(spend * 100) / 100,
        attributedShare: ratio(attributed, leads),
        leadRate: ratio(leads, trackedClicks),
        conversionRate: ratio(customers, leads),
        cpl: spend === null ? null : ratio(spend, leads, 2),
        cpa: spend === null ? null : ratio(spend, customers, 2),
        roas: spend === null ? null : ratio(revenue, spend, 2),
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
