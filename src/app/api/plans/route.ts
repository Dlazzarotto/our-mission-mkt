import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { PLAN_SECTIONS, runPlanSection, type ResearchClientInput } from "@/lib/ai/research";

export const maxDuration = 300;

const requestSchema = z.object({
  clientId: z.string().uuid(),
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

    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("*")
      .eq("id", payload.clientId)
      .single();

    if (clientError || !client) {
      return NextResponse.json({ error: "Cliente não encontrado ou sem permissão." }, { status: 404 });
    }

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

    // Gera as 5 seções em sequência; a auditoria alimenta as seguintes.
    const sections: Record<string, string> = {};
    let accumulated = "";

    for (const section of PLAN_SECTIONS) {
      const text = await runPlanSection(section.id, clientInput, accumulated);
      sections[section.id] = text;
      accumulated += `\n\n[${section.title}]\n${text.slice(0, 900)}`;
    }

    const { data: plan, error: insertError } = await supabase
      .from("strategic_plans")
      .insert({
        organization_id: client.organization_id,
        client_id: client.id,
        status: "completed",
        sections,
        created_by: user.id,
      })
      .select("*")
      .single();

    if (insertError || !plan) {
      throw new Error(`Erro ao salvar plano: ${insertError?.message ?? "sem dados"}`);
    }

    return NextResponse.json({ success: true, plan });
  } catch (error) {
    console.error("Erro no plano estratégico:", error);
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    const status = error instanceof z.ZodError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
