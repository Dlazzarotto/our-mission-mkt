import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

// Painel de resultados do cliente. Tudo lido com a sessão do usuário (RLS).
// Totais do período: função do banco client_period_totals — o banco calcula contagens,
// somas e indicadores com as mesmas regras das views (uma origem de métrica por peça/dia,
// cliques = visitantes únicos, spam fora, sem base = NULL = "sem dado"). Nada é somado aqui.
// Tabelas por peça/canal/cidade/família vêm prontas das views do banco.

const querySchema = z.object({
  clientId: z.string().uuid(),
  days: z.coerce.number().int().refine((value) => [30, 90, 365].includes(value)).default(90),
});

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

    const [
      totalsQ,
      linksQ,
      leadsQ,
      contentQ,
      scoresQ,
      channelsQ,
      locationsQ,
      familiesQ,
    ] = await Promise.all([
      supabase.rpc("client_period_totals", { p_client_id: clientId, p_since: sinceIso }).single(),
      supabase
        .from("tracking_links")
        .select("id, slug, label, mode, channel, destination_url, active, created_at, content_item_id, link_clicks(count), leads(count)", { count: "exact" })
        .eq("client_id", clientId)
        .eq("link_clicks.is_bot", false)
        .neq("leads.status", "spam")
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

    const firstError = [totalsQ, linksQ, leadsQ, contentQ, scoresQ, channelsQ, locationsQ, familiesQ].find(
      (result) => result.error,
    )?.error;
    if (firstError) return NextResponse.json({ error: firstError.message }, { status: 400 });

    type Totals = {
      tracked_clicks: number;
      impressions: number | null;
      spend: number | string | null;
      leads: number;
      qualified: number;
      customers: number;
      revenue: number | string;
      attributed_share: number | string | null;
      lead_rate: number | string | null;
      conversion_rate: number | string | null;
      cpl: number | string | null;
      cpa: number | string | null;
      roas: number | string | null;
    };
    const t = totalsQ.data as Totals;
    // numeric chega como texto pelo PostgREST; null continua null ("sem dado").
    const num = (value: number | string | null) => (value === null ? null : Number(value));

    const scoreById = new Map(
      ((scoresQ.data ?? []) as Array<{ content_item_id: string; score: number | null; tier: string }>).map((row) => [
        row.content_item_id,
        row,
      ]),
    );

    return NextResponse.json({
      days,
      totals: {
        trackedClicks: t.tracked_clicks,
        impressions: t.impressions,
        leads: t.leads,
        qualified: t.qualified,
        customers: t.customers,
        revenue: num(t.revenue),
        spend: num(t.spend),
        attributedShare: num(t.attributed_share),
        leadRate: num(t.lead_rate),
        conversionRate: num(t.conversion_rate),
        cpl: num(t.cpl),
        cpa: num(t.cpa),
        roas: num(t.roas),
      },
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
