import { NextResponse } from "next/server";
import { z } from "zod";
import { CHANNELS } from "@/lib/domain";
import { generateSlug, isSafeDestination } from "@/lib/marketing/tracking";
import { createClient } from "@/lib/supabase/server";

// Links rastreáveis do cliente. A RLS garante que só editores da agência dona do
// cliente criam/alteram; as FKs compostas impedem apontar para peça de outro cliente.

const createSchema = z
  .object({
    clientId: z.string().uuid(),
    label: z.string().trim().min(2).max(120),
    mode: z.enum(["redirect", "form"]),
    destinationUrl: z.string().trim().max(2000).optional(),
    contentItemId: z.string().uuid().optional(),
    channel: z.enum(CHANNELS).optional(),
    utmCampaign: z.string().trim().max(120).optional(),
    utmTerm: z.string().trim().max(120).optional(),
  })
  .refine((data) => data.mode === "form" || (data.destinationUrl && isSafeDestination(data.destinationUrl)), {
    message: "Informe a página de destino com https:// (ex.: https://site-do-cliente.com/contato).",
    path: ["destinationUrl"],
  });

const updateSchema = z.object({
  id: z.string().uuid(),
  active: z.boolean().optional(),
  label: z.string().trim().min(2).max(120).optional(),
});

function publicBase(request: Request) {
  return process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
}

export async function POST(request: Request) {
  try {
    const payload = createSchema.parse(await request.json());
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Sessão inválida." }, { status: 401 });

    const { data: client } = await supabase
      .from("clients")
      .select("id, organization_id, company_name")
      .eq("id", payload.clientId)
      .maybeSingle();
    if (!client) return NextResponse.json({ error: "Cliente não encontrado ou sem permissão." }, { status: 404 });

    if (payload.contentItemId) {
      const { data: item } = await supabase
        .from("content_items")
        .select("id")
        .eq("id", payload.contentItemId)
        .eq("client_id", client.id)
        .maybeSingle();
      if (!item) return NextResponse.json({ error: "Peça não encontrada para este cliente." }, { status: 404 });
    }

    // Slug aleatório; colisão (rara) tenta de novo.
    for (let tentativa = 0; tentativa < 4; tentativa++) {
      const slug = generateSlug(8);
      const { data: link, error } = await supabase
        .from("tracking_links")
        .insert({
          organization_id: client.organization_id,
          client_id: client.id,
          content_item_id: payload.contentItemId ?? null,
          slug,
          label: payload.label,
          mode: payload.mode,
          destination_url: payload.mode === "redirect" ? payload.destinationUrl : null,
          channel: payload.channel ?? null,
          utm_campaign: payload.utmCampaign || null,
          utm_term: payload.utmTerm || null,
          created_by: user.id,
        })
        .select("*")
        .single();

      if (!error && link) {
        return NextResponse.json({ success: true, link, url: `${publicBase(request)}/r/${link.slug}` });
      }
      if (error?.code !== "23505") {
        return NextResponse.json(
          { error: error?.code === "42501" ? "Sem permissão para criar links neste cliente." : error?.message ?? "Erro ao criar link." },
          { status: error?.code === "42501" ? 403 : 400 },
        );
      }
    }
    return NextResponse.json({ error: "Não foi possível gerar um código único. Tente de novo." }, { status: 500 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message ?? "Dados inválidos." }, { status: 400 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erro desconhecido" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const payload = updateSchema.parse(await request.json());
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Sessão inválida." }, { status: 401 });

    const updates: Record<string, unknown> = {};
    if (payload.active !== undefined) updates.active = payload.active;
    if (payload.label !== undefined) updates.label = payload.label;
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "Nenhuma alteração enviada." }, { status: 400 });
    }

    // .select() confirma que a linha mudou: a RLS recusa em silêncio (0 linhas) e
    // sem essa conferência a tela diria "salvo" sem ter salvo.
    const { data, error } = await supabase.from("tracking_links").update(updates).eq("id", payload.id).select("id, active, label");
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Link não encontrado ou sem permissão para editar." }, { status: 404 });
    }
    return NextResponse.json({ success: true, link: data[0] });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message ?? "Dados inválidos." }, { status: 400 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erro desconhecido" }, { status: 500 });
  }
}
