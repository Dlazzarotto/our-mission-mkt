// ============================================================
// Geração de imagem
//
// Usa os modelos de imagem do Gemini (os antigos Imagen foram descontinuados).
// A chave vem do Google AI Studio e é DIFERENTE da chave do Maps.
//
// A imagem sai com a paleta do cliente — é o mesmo princípio do resto do
// sistema: a identidade é dele, não da agência.
// ============================================================

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/** Rápido e barato, adequado para redes sociais. */
export const MODELO_PADRAO = "gemini-3.1-flash-image";
/** Mais caro, melhor com texto dentro da imagem. */
export const MODELO_ALTA_QUALIDADE = "gemini-3-pro-image";

export type ImagemGerada = { base64: string; mimeType: string };

export function imageProviderConnected() {
  return Boolean(process.env.GOOGLE_AI_API_KEY);
}

export type BrandContext = {
  companyName: string;
  palette: { primary: string; secondary: string; accent: string; background: string };
  visualStyle?: string | null;
  segment?: string | null;
};

/**
 * Monta o prompt final somando a direção criativa da peça com a identidade do
 * cliente. Sem isso, cada imagem sai com uma cara diferente.
 */
export function montarPromptVisual(direcao: string, marca: BrandContext, formato: string) {
  const proporcao =
    formato === "story" || formato === "reel" ? "vertical 9:16" : formato === "video" ? "16:9" : "quadrado 1:1";

  return [
    direcao.trim(),
    "",
    `Identidade visual da marca ${marca.companyName}:`,
    `- Cor principal ${marca.palette.primary}, secundária ${marca.palette.secondary}, destaque ${marca.palette.accent}, fundo ${marca.palette.background}.`,
    marca.visualStyle ? `- Estilo visual: ${marca.visualStyle}.` : "",
    marca.segment ? `- Segmento: ${marca.segment}.` : "",
    "",
    `Formato ${proporcao}. Fotografia ou ilustração profissional de marketing, iluminação natural,`,
    "composição limpa com espaço livre para texto. Sem marca d'água, sem logotipos inventados,",
    "sem texto ilegível ou embaralhado na imagem.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function gerarImagem(
  prompt: string,
  modelo: string = MODELO_PADRAO,
): Promise<ImagemGerada> {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GOOGLE_AI_API_KEY não configurada — a geração de imagem está desativada. Crie a chave em aistudio.google.com.",
    );
  }

  const response = await fetch(`${BASE_URL}/${modelo}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const detalhe = await response.text().catch(() => "");
    throw new Error(`Geração de imagem falhou (HTTP ${response.status}). ${detalhe.slice(0, 250)}`);
  }

  const data = await response.json();
  const partes = data?.candidates?.[0]?.content?.parts ?? [];

  for (const parte of partes) {
    const inline = parte?.inlineData ?? parte?.inline_data;
    if (inline?.data) {
      return { base64: inline.data, mimeType: inline.mimeType ?? inline.mime_type ?? "image/png" };
    }
  }

  // Quando o modelo recusa, ele responde em texto explicando o motivo.
  const texto = partes.find((p: { text?: string }) => p?.text)?.text;
  throw new Error(
    texto
      ? `O modelo não gerou imagem: ${String(texto).slice(0, 200)}`
      : "O modelo não retornou imagem. Tente ajustar a descrição.",
  );
}

/** Converte o base64 da API em bytes para gravar no Storage. */
export function base64ParaBytes(base64: string) {
  const binario = Buffer.from(base64, "base64");
  return new Uint8Array(binario);
}
