import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  MODELO_ALTA_QUALIDADE,
  MODELO_PADRAO,
  base64ParaBytes,
  gerarImagem,
  imageProviderConnected,
  montarPromptVisual,
} from "@/lib/media/image-gen";

export const maxDuration = 120;

const schema = z.object({
  contentItemId: z.string().uuid(),
  /** Permite ajustar a direção antes de gerar. */
  prompt: z.string().trim().min(10).max(1500).optional(),
  qualidade: z.enum(["rapida", "alta"]).default("rapida"),
});

export async function POST(request: Request) {
  try {
    if (!imageProviderConnected()) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Geração de imagem não configurada. Adicione GOOGLE_AI_API_KEY nas variáveis de ambiente.",
        },
        { status: 409 },
      );
    }

    const payload = schema.parse(await request.json());
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Sessão inválida." }, { status: 401 });
    }

    const { data: item, error: itemError } = await supabase
      .from("content_items")
      .select("*, clients(company_name, industry)")
      .eq("id", payload.contentItemId)
      .single();

    if (itemError || !item) {
      return NextResponse.json({ error: "Peça não encontrada ou sem permissão." }, { status: 404 });
    }

    const direcao = payload.prompt || item.image_prompt || item.creative_brief || item.title;
    if (!direcao) {
      return NextResponse.json(
        { error: "Esta peça não tem direção visual. Descreva a imagem antes de gerar." },
        { status: 409 },
      );
    }

    // A imagem herda a identidade do cliente, não a da agência.
    const { data: brandKit } = await supabase
      .from("brand_kits")
      .select("palette, visual_style")
      .eq("client_id", item.client_id)
      .maybeSingle();

    const palette = (brandKit?.palette ?? {}) as Record<string, string>;
    const cliente = item.clients as { company_name?: string; industry?: string } | null;

    const prompt = montarPromptVisual(
      direcao,
      {
        companyName: cliente?.company_name ?? "o cliente",
        palette: {
          primary: palette.primary ?? "#334155",
          secondary: palette.secondary ?? "#0EA5E9",
          accent: palette.accent ?? "#10B981",
          background: palette.background ?? "#F8FAFC",
        },
        visualStyle: brandKit?.visual_style ?? null,
        segment: cliente?.industry ?? null,
      },
      item.format,
    );

    const imagem = await gerarImagem(
      prompt,
      payload.qualidade === "alta" ? MODELO_ALTA_QUALIDADE : MODELO_PADRAO,
    );

    const extensao = imagem.mimeType.includes("jpeg") ? "jpg" : "png";
    const caminho = `${item.organization_id}/${item.client_id}/content/${item.id}.${extensao}`;

    const { error: uploadError } = await supabase.storage
      .from("brand-assets")
      .upload(caminho, base64ParaBytes(imagem.base64), {
        upsert: true,
        contentType: imagem.mimeType,
      });

    if (uploadError) throw new Error(`Imagem gerada, mas falhou ao gravar: ${uploadError.message}`);

    await supabase
      .from("content_items")
      .update({ media_path: caminho, image_prompt: direcao })
      .eq("id", item.id);

    const { data: assinada } = await supabase.storage
      .from("brand-assets")
      .createSignedUrl(caminho, 3600);

    return NextResponse.json({
      success: true,
      mediaPath: caminho,
      url: assinada?.signedUrl ?? null,
      promptUsado: prompt,
    });
  } catch (error) {
    console.error("Erro ao gerar imagem:", error);
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    return NextResponse.json(
      { success: false, error: message },
      { status: error instanceof z.ZodError ? 400 : 500 },
    );
  }
}
