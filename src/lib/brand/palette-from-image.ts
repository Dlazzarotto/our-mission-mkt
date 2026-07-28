// ============================================================
// Paleta a partir do logo
//
// Roda no navegador, sem custo de API: desenha a imagem num canvas pequeno,
// agrupa as cores por frequência e propõe uma paleta. É um ponto de partida —
// a marca pode ter cores que não aparecem no logo, então o resultado é sempre
// editável.
// ============================================================

export type Palette = {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
};

type Amostra = { r: number; g: number; b: number; peso: number };

const paraHex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase();

/** Luminância percebida (0 = preto, 255 = branco). */
const luminancia = (c: Amostra) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;

/** Saturação no modelo HSL (0 = cinza, 1 = cor pura). */
function saturacao(c: Amostra) {
  const max = Math.max(c.r, c.g, c.b) / 255;
  const min = Math.min(c.r, c.g, c.b) / 255;
  if (max === min) return 0;
  const l = (max + min) / 2;
  return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
}

/** Distância simples entre cores, para evitar propor duas quase iguais. */
const distancia = (a: Amostra, b: Amostra) =>
  Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);

function carregarImagem(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Não consegui ler a imagem."));
    };
    img.src = url;
  });
}

export async function paletteFromLogo(file: File): Promise<Palette> {
  const img = await carregarImagem(file);

  // Reduzir acelera muito e não muda o resultado: o que importa é a proporção
  // de cada cor, não o detalhe.
  const lado = 96;
  const canvas = document.createElement("canvas");
  canvas.width = lado;
  canvas.height = lado;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("O navegador não permitiu ler a imagem.");
  ctx.drawImage(img, 0, 0, lado, lado);

  const { data } = ctx.getImageData(0, 0, lado, lado);

  // Agrupa cores parecidas no mesmo balde para contar frequência.
  const balde = new Map<string, Amostra>();
  const PASSO = 24;

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < 128) continue; // pixel transparente (fundo do logo)

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const chave = `${Math.round(r / PASSO)}-${Math.round(g / PASSO)}-${Math.round(b / PASSO)}`;
    const atual = balde.get(chave);
    if (atual) {
      atual.r = (atual.r * atual.peso + r) / (atual.peso + 1);
      atual.g = (atual.g * atual.peso + g) / (atual.peso + 1);
      atual.b = (atual.b * atual.peso + b) / (atual.peso + 1);
      atual.peso += 1;
    } else {
      balde.set(chave, { r, g, b, peso: 1 });
    }
  }

  const todas = [...balde.values()].sort((a, b) => b.peso - a.peso);
  if (todas.length === 0) throw new Error("A imagem não tem cores legíveis.");

  // Branco e preto quase puros servem para fundo e texto, não para a marca.
  const coloridas = todas.filter((c) => {
    const lum = luminancia(c);
    return lum > 28 && lum < 238 && saturacao(c) > 0.12;
  });

  const candidatas = coloridas.length > 0 ? coloridas : todas;

  // Primária: a cor de marca mais presente.
  const primary = candidatas[0];

  // Destaque: a mais vibrante que seja visivelmente diferente da primária.
  const accent =
    [...candidatas]
      .sort((a, b) => saturacao(b) - saturacao(a))
      .find((c) => distancia(c, primary) > 70) ?? primary;

  // Secundária: a próxima mais presente, diferente das duas anteriores.
  const secondary =
    candidatas.find((c) => distancia(c, primary) > 70 && distancia(c, accent) > 70) ??
    accent;

  // Fundo: o tom mais claro do logo, suavizado. Texto: o mais escuro.
  const maisClara = todas.reduce((a, b) => (luminancia(a) > luminancia(b) ? a : b));
  const maisEscura = todas.reduce((a, b) => (luminancia(a) < luminancia(b) ? a : b));

  const background =
    luminancia(maisClara) > 200
      ? paraHex(
          Math.min(255, maisClara.r * 0.02 + 248),
          Math.min(255, maisClara.g * 0.02 + 248),
          Math.min(255, maisClara.b * 0.02 + 248),
        )
      : "#F8FAFC";

  const text = luminancia(maisEscura) < 90 ? paraHex(maisEscura.r, maisEscura.g, maisEscura.b) : "#0F172A";

  return {
    primary: paraHex(primary.r, primary.g, primary.b),
    secondary: paraHex(secondary.r, secondary.g, secondary.b),
    accent: paraHex(accent.r, accent.g, accent.b),
    background,
    text,
  };
}

export const LOGO_MAX_BYTES = 3 * 1024 * 1024;
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

export function validarLogo(file: File): string | null {
  if (!LOGO_TYPES.includes(file.type)) {
    return "Use PNG, JPG, WEBP ou SVG.";
  }
  if (file.size > LOGO_MAX_BYTES) {
    return "A imagem passa de 3 MB. Envie uma versão menor.";
  }
  return null;
}
