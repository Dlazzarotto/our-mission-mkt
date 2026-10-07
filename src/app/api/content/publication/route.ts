import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

// Marca a peça como PUBLICADA, com link do post e data real.
// Só peça aprovada/agendada pode ser publicada — rascunho não pula a aprovação.

const requestSchema = z.object({
  contentItemId: z.string().uuid(),
  permalink: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((value) => value || null)
    .refine((value) => !value || /^https:\/\/\S+$/i.test(value), "O link do post precisa começar com https://"),
  publishedAt: z.string().datetime({ offset: true }).optional(),
  externalPostId: z.string().trim().max(200).optional(),
});

const PUBLICAVEIS = ["approved", "scheduled", "published"];

export async function PATCH(request: Request) {
  try {
    const payload = requestSchema.parse(await request.json());
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Sessão inválida." }, { status: 401 });

    const { data: item } = await supabase
      .from("content_items")
      .select("id, status")
      .eq("id", payload.contentItemId)
      .maybeSingle();
    if (!item) return NextResponse.json({ error: "Peça não encontrada ou sem permissão." }, { status: 404 });
    if (!PUBLICAVEIS.includes(item.status)) {
      return NextResponse.json({ error: "A peça precisa estar aprovada antes de ser marcada como publicada." }, { status: 409 });
    }

    const publishedAt = payload.publishedAt ? new Date(payload.publishedAt) : new Date();
    if (publishedAt.getTime() > Date.now() + 5 * 60 * 1000) {
      return NextResponse.json({ error: "Data de publicação no futuro: use o agendamento." }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("content_items")
      .update({
        status: "published",
        published_at: publishedAt.toISOString(),
        permalink: payload.permalink,
        external_post_id: payload.externalPostId || null,
      })
      .eq("id", item.id)
      .select("id, status, published_at, permalink, public_code");
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Sem permissão para alterar esta peça." }, { status: 403 });
    }
    return NextResponse.json({ success: true, content: data[0] });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message ?? "Dados inválidos." }, { status: 400 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erro desconhecido" }, { status: 500 });
  }
}
