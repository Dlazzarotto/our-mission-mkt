import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  generateExecutionPlan,
  stagesFor,
  type ObservedData,
  type ResearchClientInput,
} from "@/lib/ai/research";
import { isConnected } from "@/lib/market/providers";

export const maxDuration = 300;

const requestSchema = z.object({
  researchId: z.string().uuid(),
});

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export async function POST(request: Request) {
  try {
    const payload = requestSchema.parse(await request.json());
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

    const client = research.clients;
    const clientInput: ResearchClientInput = {
      companyName: client.company_name,
      industry: client.industry,
      service: client.service,
      region: client.region,
      differentiators: asStringArray(client.differentiators),
      marketingMaturity: client.marketing_maturity,
      instagram: client.instagram,
      website: client.website,
    };

    const analysis = (research.ai_analysis ?? {}) as Record<string, string>;
    const researchBase = stagesFor("full")
      .map((stage) => {
        const text = analysis[stage.id];
        return text ? `[${stage.title}]\n${text.slice(0, 900)}` : "";
      })
      .filter(Boolean)
      .join("\n\n");

    if (!researchBase) {
      return NextResponse.json({ error: "A pesquisa ainda não tem análise concluída." }, { status: 409 });
    }

    // O plano de execução também parte dos fatos coletados, não da memória do modelo.
    const { data: competitors } = await supabase
      .from("market_competitors")
      .select("name, city, website, rating, review_count, distance_miles, price_band, business_hours")
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
      providersUsed: Array.isArray(research.providers_used)
        ? (research.providers_used as string[])
        : [],
      keywordMetricsAvailable: isConnected("google_ads"),
      trendsAvailable: isConnected("google_trends"),
    };

    const executionPlan = await generateExecutionPlan(
      clientInput,
      research.zip_code,
      research.radius_miles,
      researchBase,
      observed,
    );

    const { data: updated, error: updateError } = await supabase
      .from("market_research_requests")
      .update({ execution_plan: executionPlan })
      .eq("id", research.id)
      .select("*")
      .single();

    if (updateError || !updated) {
      throw new Error(`Erro ao salvar plano de execução: ${updateError?.message ?? "sem dados"}`);
    }

    return NextResponse.json({ success: true, research: updated });
  } catch (error) {
    console.error("Erro no plano de execução:", error);
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    const status = error instanceof z.ZodError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
