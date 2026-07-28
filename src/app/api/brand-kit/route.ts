import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

// A identidade visual é SEMPRE do cliente — definida no perfil dele
// e editável a qualquer momento. As próximas gerações de conteúdo
// leem o brand kit atualizado automaticamente.

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Cor deve ser hex no formato #RRGGBB");

const requestSchema = z.object({
  clientId: z.string().uuid(),
  palette: z
    .object({
      primary: hexColor,
      secondary: hexColor,
      accent: hexColor,
      background: hexColor,
      text: hexColor,
    })
    .optional(),
  toneOfVoice: z.string().trim().min(3).max(400).optional(),
  preferredCta: z.string().trim().max(160).optional(),
  visualStyle: z
    .enum(["classic", "current", "minimal", "editorial", "vibrant", "premium", "organic", "custom"])
    .optional(),
  logoPath: z.string().trim().max(300).optional(),
  hasLogo: z.boolean().nullable().optional(),
});

export async function PATCH(request: Request) {
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

    const updates: Record<string, unknown> = {};
    if (payload.palette) updates.palette = payload.palette;
    if (payload.toneOfVoice !== undefined) updates.tone_of_voice = payload.toneOfVoice;
    if (payload.preferredCta !== undefined) updates.preferred_cta = payload.preferredCta;
    if (payload.visualStyle) updates.visual_style = payload.visualStyle;
    if (payload.logoPath) updates.logo_path = payload.logoPath;
    if (payload.hasLogo !== undefined) updates.has_logo = payload.hasLogo;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "Nenhuma alteração enviada." }, { status: 400 });
    }

    // A RLS garante que apenas editores da organização do cliente conseguem alterar.
    const { data: brandKit, error: updateError } = await supabase
      .from("brand_kits")
      .update(updates)
      .eq("client_id", payload.clientId)
      .select("*")
      .single();

    if (updateError || !brandKit) {
      return NextResponse.json(
        { error: "Brand kit não encontrado ou sem permissão para editar." },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, brandKit });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    const status = error instanceof z.ZodError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
