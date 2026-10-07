import { NextResponse } from "next/server";
import { z } from "zod";
import { METRIC_SOURCES } from "@/lib/domain";
import { countInput, moneyInput } from "@/lib/marketing/input-schemas";
import { dedupeBy } from "@/lib/marketing/tracking";
import { createClient } from "@/lib/supabase/server";

// Métricas da plataforma por peça e por dia (Fase 1: lançamento manual ou colado do
// painel da rede). Um registro por peça + dia + origem: lançar de novo SUBSTITUI o dia,
// nunca duplica. Quando as integrações por API vierem, gravam aqui com source = rede.
// Lead NÃO entra aqui: lead é pessoa, registrado em "leads" (com origem e funil),
// para que receita e conversão sejam rastreáveis até a peça.
// source: exatamente a lista do CHECK do banco (METRIC_SOURCES). A mesma peça+dia+origem
// repetida no MESMO envio é deduplicada antes do upsert (a última linha vence) — o Postgres
// recusaria o lote inteiro ("ON CONFLICT DO UPDATE command cannot affect row a second time").

const count = countInput;

const rowSchema = z.object({
  contentItemId: z.string().uuid(),
  metricDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD"),
  impressions: count,
  reach: count,
  engagement: count,
  clicks: count,
  videoViews: count,
  watchTimeSeconds: count,
  saves: count,
  shares: count,
  spend: moneyInput.refine((value) => value === undefined || value === null || value <= 10_000_000, "Investimento acima do limite."),
  source: z.enum(METRIC_SOURCES).default("manual"),
});

const requestSchema = z.object({ rows: z.array(rowSchema).min(1).max(500) });

export async function POST(request: Request) {
  try {
    const parsed = requestSchema.parse(await request.json());
    const rows = dedupeBy(parsed.rows, (row) => `${row.contentItemId}|${row.metricDate}|${row.source}`);
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Sessão inválida." }, { status: 401 });

    const ids = Array.from(new Set(rows.map((row) => row.contentItemId)));
    const { data: items, error: itemsError } = await supabase
      .from("content_items")
      .select("id, organization_id")
      .in("id", ids);
    if (itemsError) return NextResponse.json({ error: itemsError.message }, { status: 400 });

    const orgByItem = new Map((items ?? []).map((item) => [item.id, item.organization_id]));
    const missing = ids.filter((id) => !orgByItem.has(id));
    if (missing.length > 0) {
      return NextResponse.json({ error: "Peça não encontrada ou sem permissão." }, { status: 404 });
    }

    const today = new Date().toISOString().slice(0, 10);
    if (rows.some((row) => row.metricDate > today)) {
      return NextResponse.json({ error: "Não é possível lançar métrica de data futura." }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("performance_metrics")
      .upsert(
        rows.map((row) => ({
          organization_id: orgByItem.get(row.contentItemId),
          content_item_id: row.contentItemId,
          metric_date: row.metricDate,
          source: row.source,
          impressions: row.impressions ?? null,
          reach: row.reach ?? null,
          engagement: row.engagement ?? null,
          clicks: row.clicks ?? null,
          video_views: row.videoViews ?? null,
          watch_time_seconds: row.watchTimeSeconds ?? null,
          saves: row.saves ?? null,
          shares: row.shares ?? null,
          spend: row.spend ?? null,
        })),
        { onConflict: "content_item_id,metric_date,source" },
      )
      .select("id");

    if (error) {
      const forbidden = error.code === "42501";
      return NextResponse.json(
        { error: forbidden ? "Sem permissão para lançar métricas neste cliente." : error.message },
        { status: forbidden ? 403 : 400 },
      );
    }
    if (!data || data.length !== rows.length) {
      return NextResponse.json({ error: "Nem todas as linhas foram gravadas (sem permissão?)." }, { status: 403 });
    }
    return NextResponse.json({ success: true, saved: data.length, duplicatesMerged: parsed.rows.length - rows.length });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message ?? "Dados inválidos." }, { status: 400 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erro desconhecido" }, { status: 500 });
  }
}
