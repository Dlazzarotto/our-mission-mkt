import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const requestSchema = z.object({
  companyName: z.string().trim().min(2).max(180),
  industry: z.string().trim().min(2).max(120),
  service: z.string().trim().min(3).max(600),
  region: z.string().trim().min(2).max(160),
  differentiators: z.array(z.string().trim().min(1).max(200)).max(12).default([]),
  marketingMaturity: z.string().trim().max(120).optional(),
  contactName: z.string().trim().max(120).optional(),
  contactEmail: z.string().trim().email().optional().or(z.literal("")),
  instagram: z.string().trim().max(120).optional(),
  website: z.string().trim().max(200).optional(),
  createDefaultContract: z.boolean().default(true),
});

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

    // Organização do usuário (primeira associação encontrada).
    const { data: membership, error: memberError } = await supabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .limit(1)
      .single();

    if (memberError || !membership) {
      return NextResponse.json(
        { error: "Você ainda não pertence a uma agência. Crie a sua na tela inicial." },
        { status: 409 },
      );
    }

    const { data: client, error: insertError } = await supabase
      .from("clients")
      .insert({
        organization_id: membership.organization_id,
        company_name: payload.companyName,
        industry: payload.industry,
        service: payload.service,
        region: payload.region,
        differentiators: payload.differentiators,
        marketing_maturity: payload.marketingMaturity || null,
        contact_name: payload.contactName || null,
        contact_email: payload.contactEmail || null,
        instagram: payload.instagram || null,
        website: payload.website || null,
      })
      .select("*")
      .single();

    if (insertError || !client) {
      throw new Error(`Erro ao criar cliente: ${insertError?.message ?? "sem dados"}`);
    }
    // O brand kit (paleta neutra, editável no perfil) é criado por trigger no banco.

    // Contrato padrão semanal: faz o pipeline do cron funcionar desde o dia 1.
    // O trigger do banco preenche next_generation_at automaticamente.
    if (payload.createDefaultContract) {
      const today = new Date().toISOString().slice(0, 10);
      const { error: contractError } = await supabase.from("client_contracts").insert({
        organization_id: membership.organization_id,
        client_id: client.id,
        name: "Contrato padrão (semanal)",
        status: "active",
        starts_at: today,
        market: "US",
        timezone: "America/New_York",
        generation_cadence: "weekly",
        approval_required: true,
        delivery_rules: [
          { id: "r1", channel: "instagram", format: "photo", quantity: 2, period: "week" },
          { id: "r2", channel: "instagram", format: "reel", quantity: 1, period: "week" },
          { id: "r3", channel: "google_business", format: "photo", quantity: 1, period: "week" },
        ],
        special_date_rules: [],
      });
      if (contractError) {
        console.error("Cliente criado, mas o contrato padrão falhou:", contractError.message);
      }
    }

    return NextResponse.json({ success: true, client });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    const status = error instanceof z.ZodError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
