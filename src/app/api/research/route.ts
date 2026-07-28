import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  RESEARCH_STAGE_CATALOG,
  runResearchStage,
  stagesFor,
  type ObservedData,
  type ResearchClientInput,
  type ResearchStageId,
} from "@/lib/ai/research";
import { getProviderStatus, isConnected } from "@/lib/market/providers";
import { geocodeZip, searchCompetitors, toPriceBand } from "@/lib/market/places";

// A pesquisa acontece em duas fases distintas, e a separação é proposital:
//   POST  -> COLETA. Consulta provedores reais e grava os fatos observados.
//   PATCH -> ANÁLISE. A IA lê o que foi coletado, uma etapa por requisição.
// Assim nenhum número gerado por modelo se mistura com dado medido.
export const maxDuration = 300;

const startSchema = z.object({
  clientId: z.string().uuid(),
  zipCode: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "Informe um ZIP code americano válido."),
  radiusMiles: z.number().int().min(1).max(100),
  depth: z.enum(["quick", "full"]).default("quick"),
  businessType: z.string().trim().min(2).max(150).optional(),
});

const stageSchema = z.object({
  researchId: z.string().uuid(),
  stage: z.string().refine((value): value is ResearchStageId => value in RESEARCH_STAGE_CATALOG, {
    message: "Etapa desconhecida.",
  }),
});

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function toClientInput(client: Record<string, unknown>): ResearchClientInput {
  return {
    companyName: String(client.company_name ?? ""),
    industry: String(client.industry ?? ""),
    service: String(client.service ?? ""),
    region: String(client.region ?? ""),
    differentiators: asStringArray(client.differentiators),
    marketingMaturity: (client.marketing_maturity as string | null) ?? null,
    instagram: (client.instagram as string | null) ?? null,
    website: (client.website as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// POST — coleta os dados reais e abre a pesquisa
// ---------------------------------------------------------------------------
export async function POST(request: Request) {
  try {
    const payload = startSchema.parse(await request.json());
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Sessão inválida." }, { status: 401 });
    }

    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("*")
      .eq("id", payload.clientId)
      .single();

    if (clientError || !client) {
      return NextResponse.json({ error: "Cliente não encontrado ou sem permissão." }, { status: 404 });
    }

    const { data: research, error: insertError } = await supabase
      .from("market_research_requests")
      .insert({
        organization_id: client.organization_id,
        client_id: client.id,
        business_category: "custom",
        business_type: "custom",
        custom_business_type: payload.businessType || client.industry,
        zip_code: payload.zipCode,
        radius_miles: payload.radiusMiles,
        status: "running",
        requested_by: user.id,
      })
      .select("*")
      .single();

    if (insertError || !research) {
      throw new Error(`Erro ao abrir pesquisa: ${insertError?.message ?? "sem dados"}`);
    }

    // ---------- Fase de coleta ----------
    const providersUsed: string[] = [];
    const warnings: string[] = [];
    let competitorsSaved = 0;

    if (isConnected("google_places")) {
      try {
        const center = await geocodeZip(payload.zipCode);
        const query = `${payload.businessType || client.industry} near ${payload.zipCode}`;
        const found = await searchCompetitors(query, center, payload.radiusMiles);

        if (found.length > 0) {
          const rows = found.map((place, index) => ({
            organization_id: client.organization_id,
            research_request_id: research.id,
            external_place_id: place.placeId,
            rank: index + 1,
            name: place.name,
            address: place.address,
            distance_miles: place.distanceMiles,
            website: place.website,
            google_business_url: place.googleMapsUri,
            rating: place.rating,
            review_count: place.reviewCount,
            price_band: toPriceBand(place.priceLevel),
            business_hours: place.businessHours,
            source: "google_places",
            fetched_at: new Date().toISOString(),
            evidence: { primary_type: place.primaryType },
          }));

          const { error: competitorError } = await supabase.from("market_competitors").insert(rows);
          if (competitorError) {
            warnings.push(`Concorrentes coletados, mas falhou ao gravar: ${competitorError.message}`);
          } else {
            competitorsSaved = rows.length;
            providersUsed.push("google_places");
          }
        } else {
          warnings.push("O Google Places não retornou empresas para este segmento e raio.");
        }

        await supabase
          .from("market_research_requests")
          .update({ latitude: center.latitude, longitude: center.longitude })
          .eq("id", research.id);
      } catch (placesError) {
        warnings.push(
          `Coleta no Google Places falhou: ${placesError instanceof Error ? placesError.message : "erro desconhecido"}`,
        );
      }
    } else {
      warnings.push(
        "Google Places não conectado — a pesquisa segue sem lista de concorrentes reais. A IA não vai inventar empresas.",
      );
    }

    const { data: updated } = await supabase
      .from("market_research_requests")
      .update({ providers_used: providersUsed })
      .eq("id", research.id)
      .select("*")
      .single();

    return NextResponse.json({
      success: true,
      research: updated ?? research,
      stages: stagesFor(payload.depth).map((item) => ({ id: item.id, title: item.title })),
      collected: { competitors: competitorsSaved, providersUsed },
      providers: getProviderStatus(),
      warnings,
    });
  } catch (error) {
    console.error("Erro ao abrir pesquisa:", error);
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    return NextResponse.json(
      { success: false, error: message },
      { status: error instanceof z.ZodError ? 400 : 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// PATCH — a IA analisa os dados coletados, uma etapa por requisição
// ---------------------------------------------------------------------------
export async function PATCH(request: Request) {
  try {
    const payload = stageSchema.parse(await request.json());
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Sessão inválida." }, { status: 401 });
    }

    const { data: research, error: researchError } = await supabase
      .from("market_research_requests")
      .select("*, clients(*)")
      .eq("id", payload.researchId)
      .single();

    if (researchError || !research || !research.clients) {
      return NextResponse.json({ error: "Pesquisa não encontrada ou sem permissão." }, { status: 404 });
    }

    // Os fatos vêm do banco, não do modelo.
    const { data: competitors } = await supabase
      .from("market_competitors")
      .select("name, city, website, rating, review_count, distance_miles, price_band, business_hours, fetched_at")
      .eq("research_request_id", research.id)
      .order("rank", { ascending: true });

    const observed: ObservedData = {
      competitors: (competitors ?? []).map((row) => ({
        name: row.name,
        city: row.city,
        website: row.website,
        rating: row.rating,
        reviewCount: row.review_count,
        distanceMiles: row.distance_miles,
        priceBand: row.price_band,
        businessHours: row.business_hours,
      })),
      providersUsed: asStringArray(research.providers_used),
      keywordMetricsAvailable: isConnected("google_ads"),
      trendsAvailable: isConnected("google_trends"),
      collectedAt: competitors?.[0]?.fetched_at
        ? new Date(competitors[0].fetched_at).toLocaleDateString("pt-BR")
        : null,
    };

    const analysis = (research.ai_analysis ?? {}) as Record<string, string>;
    const depth = Object.keys(RESEARCH_STAGE_CATALOG).length > 0 && analysis.relatorio ? "full" : "full";
    const previous = stagesFor(depth as "full")
      .filter((item) => analysis[item.id])
      .map((item) => `[${item.title}]\n${analysis[item.id].slice(0, 900)}`)
      .join("\n\n");

    const text = await runResearchStage(
      payload.stage,
      toClientInput(research.clients),
      research.zip_code,
      research.radius_miles,
      observed,
      previous,
    );

    const { data: updated, error: updateError } = await supabase
      .from("market_research_requests")
      .update({ ai_analysis: { ...analysis, [payload.stage]: text } })
      .eq("id", research.id)
      .select("*")
      .single();

    if (updateError || !updated) {
      throw new Error(`Erro ao salvar etapa: ${updateError?.message ?? "sem dados"}`);
    }

    return NextResponse.json({ success: true, research: updated, stage: payload.stage });
  } catch (error) {
    console.error("Erro na etapa da pesquisa:", error);
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    return NextResponse.json(
      { success: false, error: message },
      { status: error instanceof z.ZodError ? 400 : 500 },
    );
  }
}
