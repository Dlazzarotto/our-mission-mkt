import { NextResponse } from "next/server";
import { z } from "zod";
import { moneyInput } from "@/lib/marketing/input-schemas";
import { createClient } from "@/lib/supabase/server";

// Leads do cliente (lado da agência, com login).
// POST = lead registrado à mão (ligação, indicação, visita) · PATCH = avanço no funil.
// Carimbos de etapa, histórico e cadeia de atribuição são feitos pelo BANCO (triggers).

const LEAD_STATUSES = ["new", "contacted", "qualified", "customer", "lost", "spam"] as const;

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : null));

/**
 * Campo editável: undefined (não enviado) = não mexer · null ou "" = LIMPAR · texto = gravar.
 * Antes, "" e null viravam "não mexer" e não havia como apagar nota/motivo de perda.
 */
const editableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === undefined ? undefined : value ? value : null));

const createSchema = z
  .object({
    clientId: z.string().uuid(),
    name: text(120),
    email: text(160).refine((value) => !value || z.string().email().safeParse(value).success, "E-mail inválido"),
    phone: text(40),
    zip: text(12),
    city: text(120),
    state: text(60),
    selfReportedSource: text(120),
    contentItemId: z.string().uuid().optional(),
    linkId: z.string().uuid().optional(),
    notes: text(2000),
    status: z.enum(LEAD_STATUSES).default("new"),
    revenue: moneyInput,
  })
  .refine((data) => data.name || data.email || data.phone, "Informe nome, e-mail ou telefone.");

const updateSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(LEAD_STATUSES).optional(),
  revenue: moneyInput,
  lostReason: editableText(300),
  notes: editableText(2000),
});

async function sessionClient() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  return { supabase, user: error ? null : user };
}

function failure(error: unknown) {
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: error.issues[0]?.message ?? "Dados inválidos." }, { status: 400 });
  }
  return NextResponse.json({ error: error instanceof Error ? error.message : "Erro desconhecido" }, { status: 500 });
}

export async function POST(request: Request) {
  try {
    const payload = createSchema.parse(await request.json());
    const { supabase, user } = await sessionClient();
    if (!user) return NextResponse.json({ error: "Sessão inválida." }, { status: 401 });

    const { data: client } = await supabase
      .from("clients")
      .select("id, organization_id")
      .eq("id", payload.clientId)
      .maybeSingle();
    if (!client) return NextResponse.json({ error: "Cliente não encontrado ou sem permissão." }, { status: 404 });

    const { data: lead, error } = await supabase
      .from("leads")
      .insert({
        organization_id: client.organization_id,
        client_id: client.id,
        source_type: "manual",
        name: payload.name,
        email: payload.email?.toLowerCase() ?? null,
        phone: payload.phone,
        zip: payload.zip,
        city: payload.city,
        state: payload.state,
        self_reported_source: payload.selfReportedSource,
        content_item_id: payload.contentItemId ?? null,
        link_id: payload.linkId ?? null,
        notes: payload.notes,
        status: payload.status,
        revenue: payload.revenue ?? null,
        created_by: user.id,
      })
      .select("id, lead_code, status, attribution")
      .single();

    if (error || !lead) {
      const forbidden = error?.code === "42501";
      return NextResponse.json(
        { error: forbidden ? "Sem permissão para registrar leads neste cliente." : error?.message ?? "Erro ao registrar lead." },
        { status: forbidden ? 403 : 400 },
      );
    }
    return NextResponse.json({ success: true, lead });
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const payload = updateSchema.parse(await request.json());
    const { supabase, user } = await sessionClient();
    if (!user) return NextResponse.json({ error: "Sessão inválida." }, { status: 401 });

    const updates: Record<string, unknown> = {};
    if (payload.status !== undefined) updates.status = payload.status;
    if (payload.revenue !== undefined) updates.revenue = payload.revenue;
    if (payload.lostReason !== undefined) updates.lost_reason = payload.lostReason;
    if (payload.notes !== undefined) updates.notes = payload.notes;
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "Nenhuma alteração enviada." }, { status: 400 });
    }

    // Confere que a linha mudou de fato (RLS recusa em silêncio com 0 linhas).
    const { data, error } = await supabase
      .from("leads")
      .update(updates)
      .eq("id", payload.id)
      .select("id, status, revenue, lost_reason, notes, qualified_at, converted_at");
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Lead não encontrado ou sem permissão para editar." }, { status: 404 });
    }
    return NextResponse.json({ success: true, lead: data[0] });
  } catch (error) {
    return failure(error);
  }
}
