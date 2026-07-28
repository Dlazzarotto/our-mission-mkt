#!/usr/bin/env node
/**
 * Testes internos do EstratégiaPro CRM (junção v2).
 * Extrai as funções REAIS do código enviado (removendo apenas as anotações
 * de tipo) e executa casos de borda — não é reimplementação.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
let passou = 0;
const falhas = [];

function teste(nome, fn) {
  try {
    fn();
    passou++;
    console.log(`  ok   ${nome}`);
  } catch (erro) {
    falhas.push(`${nome} → ${erro.message}`);
    console.log(`  FALHA ${nome}`);
    console.log(`        ${erro.message}`);
  }
}

function igual(recebido, esperado, contexto) {
  if (recebido !== esperado) {
    throw new Error(`${contexto || ""} esperado "${esperado}", recebeu "${recebido}"`);
  }
}

// ---------------------------------------------------------------------------
// 1. normalizeScheduledAt — extraída do worker real
// ---------------------------------------------------------------------------
const geradorSrc = fs.readFileSync(
  path.join(ROOT, "src/app/api/campaigns/generate/route.ts"),
  "utf8",
);
const blocoNormalize = geradorSrc.match(
  /function normalizeScheduledAt\([\s\S]*?\n\}/,
);
if (!blocoNormalize) {
  falhas.push("não encontrei normalizeScheduledAt no worker");
}
const normalizeJs = blocoNormalize[0]
  .replace(/:\s*string,/g, ",")
  .replace(/:\s*number,/g, ",")
  .replace(/,\n\s*period:\s*\{[^}]*\},/, ",\n  period,");
const normalizeScheduledAt = eval(`(${normalizeJs})`);

const periodo = { startsAt: "2026-07-27", endsAt: "2026-08-02" };

console.log("\n[1] normalizeScheduledAt — datas vindas da IA");

teste("data ISO válida dentro do período é preservada", () => {
  const saida = normalizeScheduledAt("2026-07-29T14:00:00.000Z", 0, periodo);
  igual(saida, "2026-07-29T14:00:00.000Z");
});

teste("texto não-data cai no fallback dentro do período", () => {
  const saida = normalizeScheduledAt("próxima terça de manhã", 2, periodo);
  const d = new Date(saida);
  if (Number.isNaN(d.getTime())) throw new Error("fallback inválido");
  if (saida.slice(0, 10) < periodo.startsAt || saida.slice(0, 10) > periodo.endsAt) {
    throw new Error(`fallback ${saida} fora do período`);
  }
});

teste("string vazia cai no fallback", () => {
  const saida = normalizeScheduledAt("", 1, periodo);
  if (Number.isNaN(new Date(saida).getTime())) throw new Error("fallback inválido");
});

teste("data absurda (ano errado) é rejeitada", () => {
  const saida = normalizeScheduledAt("2025-01-05T10:00:00Z", 0, periodo);
  if (saida.startsWith("2025")) throw new Error("aceitou data fora do período");
});

teste("data legítima às 00:00 do fuso de NY no 1º dia é preservada", () => {
  // Um post agendado para a meia-noite do primeiro dia em America/New_York.
  const entrada = "2026-07-27T00:00:00-04:00"; // = 04:00Z do dia 27
  const saida = normalizeScheduledAt(entrada, 0, periodo);
  igual(
    new Date(saida).toISOString(),
    new Date(entrada).toISOString(),
    "post matinal legítimo foi remarcado:",
  );
});

teste("data legítima às 08:00 do fuso de NY no 1º dia é preservada", () => {
  const entrada = "2026-07-27T08:00:00-04:00"; // = 12:00Z
  const saida = normalizeScheduledAt(entrada, 0, periodo);
  igual(new Date(saida).toISOString(), new Date(entrada).toISOString());
});

teste("data legítima às 20:00 do último dia é preservada", () => {
  const entrada = "2026-08-02T20:00:00-04:00"; // = 00:00Z do dia 03
  const saida = normalizeScheduledAt(entrada, 5, periodo);
  igual(
    new Date(saida).toISOString(),
    new Date(entrada).toISOString(),
    "post noturno do último dia foi remarcado:",
  );
});

// ---------------------------------------------------------------------------
// 2. Cadência de geração — extraída do dispatcher real
// ---------------------------------------------------------------------------
const dispatchSrc = fs.readFileSync(
  path.join(ROOT, "src/app/api/cron/dispatch-due-work/route.ts"),
  "utf8",
);
const usaMensal = /generation_cadence === "monthly"/.test(dispatchSrc);
const blocoCadencia = dispatchSrc.match(
  /const nextDate = new Date\(contract\.next_generation_at\);[\s\S]*?\n      \} else \{[\s\S]*?\n      \}/,
);

function proximaData(atual, cadencia) {
  const contract = { next_generation_at: atual, generation_cadence: cadencia };
  const codigo = blocoCadencia[0];
  const fn = new Function("contract", `${codigo}\n return nextDate.toISOString();`);
  return fn(contract);
}

console.log("\n[2] Cadência de geração (semanal / mensal)");

teste("dispatcher diferencia cadência mensal", () => {
  if (!usaMensal) throw new Error("dispatcher não trata generation_cadence");
});

teste("semanal avança exatamente 7 dias", () => {
  igual(proximaData("2026-07-27T10:00:00.000Z", "weekly").slice(0, 10), "2026-08-03");
});

teste("mensal avança 1 mês em data comum", () => {
  igual(proximaData("2026-03-15T10:00:00.000Z", "monthly").slice(0, 10), "2026-04-15");
});

teste("mensal a partir de 31/jan NÃO pode pular fevereiro", () => {
  const saida = proximaData("2026-01-31T10:00:00.000Z", "monthly").slice(0, 10);
  if (saida.startsWith("2026-03")) {
    throw new Error(`31/jan + 1 mês virou ${saida} — fevereiro inteiro foi pulado`);
  }
  if (!saida.startsWith("2026-02")) {
    throw new Error(`esperava algum dia de fevereiro, recebeu ${saida}`);
  }
});

teste("mensal a partir de 31/mai deve cair em junho", () => {
  const saida = proximaData("2026-05-31T10:00:00.000Z", "monthly").slice(0, 10);
  if (!saida.startsWith("2026-06")) {
    throw new Error(`esperava junho, recebeu ${saida}`);
  }
});

// ---------------------------------------------------------------------------
// 3. Validação de cor hex do brand kit (paleta do cliente)
// ---------------------------------------------------------------------------
const brandSrc = fs.readFileSync(path.join(ROOT, "src/app/api/brand-kit/route.ts"), "utf8");
const regexHex = brandSrc.match(/z\.string\(\)\.regex\((\/[^/]+\/)/);
const hex = new RegExp(regexHex[1].slice(1, -1));

console.log("\n[3] Paleta do cliente — validação de cor");

teste("aceita hex maiúsculo e minúsculo", () => {
  if (!hex.test("#F47B20") || !hex.test("#0ea5e9")) throw new Error("rejeitou hex válido");
});

teste("rejeita hex curto (#FFF) e valores inválidos", () => {
  if (hex.test("#FFF")) throw new Error("aceitou #FFF");
  if (hex.test("rgb(0,0,0)")) throw new Error("aceitou rgb()");
  if (hex.test("#GGGGGG")) throw new Error("aceitou caractere inválido");
});

teste("paleta neutra padrão da migration passa na validação", () => {
  const sql = fs.readFileSync(
    path.join(ROOT, "supabase/migrations/202607270001_junction_palette_research_plans.sql"),
    "utf8",
  );
  const bloco = sql.match(/'(\{"primary".*?\})'::jsonb/);
  const paleta = JSON.parse(bloco[1]);
  for (const [chave, valor] of Object.entries(paleta)) {
    if (!hex.test(valor)) throw new Error(`cor padrão ${chave}=${valor} seria rejeitada pela API`);
  }
  for (const obrig of ["primary", "secondary", "accent", "background", "text"]) {
    if (!(obrig in paleta)) throw new Error(`paleta padrão sem a chave ${obrig}`);
  }
});

// ---------------------------------------------------------------------------
// 4. Renderizador de markdown — não pode quebrar com saída inesperada da IA
// ---------------------------------------------------------------------------
console.log("\n[4] MarkdownLite — robustez com saída da IA");

const mdSrc = fs.readFileSync(path.join(ROOT, "src/components/markdown-lite.tsx"), "utf8");

teste("trata listas, títulos e negrito sem depender de biblioteca externa", () => {
  const temLista = /startsWith\("- "\)/.test(mdSrc);
  const temTitulo = /startsWith\("## "\)/.test(mdSrc);
  const temNegrito = /\\\*\\\*\[\^\*\]\+\\\*\\\*/.test(mdSrc) || /renderBold/.test(mdSrc);
  if (!temLista || !temTitulo || !temNegrito) throw new Error("parser incompleto");
});

teste("todo elemento de lista recebe key (evita warning/erro do React)", () => {
  const mapsSemKey = [];
  const regexMap = /\.map\(\((\w+)(?:,\s*(\w+))?\)\s*=>\s*\(?([\s\S]{0,220})/g;
  let m;
  while ((m = regexMap.exec(mdSrc)) !== null) {
    if (m[3].includes("<") && !m[3].includes("key=")) mapsSemKey.push(m[3].slice(0, 60));
  }
  if (mapsSemKey.length > 0) throw new Error(`map sem key: ${mapsSemKey.join(" | ")}`);
});

// ---------------------------------------------------------------------------
// 5. Segurança — segredos e autenticação
// ---------------------------------------------------------------------------
console.log("\n[5] Segurança");

const arquivosApi = [];
(function varrer(dir) {
  for (const nome of fs.readdirSync(dir)) {
    const p = path.join(dir, nome);
    if (fs.statSync(p).isDirectory()) varrer(p);
    else if (nome.endsWith(".ts")) arquivosApi.push(p);
  }
})(path.join(ROOT, "src/app/api"));

teste("toda rota de API valida sessão ou segredo do cron", () => {
  const semProtecao = arquivosApi.filter((p) => {
    const s = fs.readFileSync(p, "utf8");
    return !/auth\.getUser\(\)/.test(s) && !/CRON_SECRET/.test(s);
  });
  if (semProtecao.length > 0) {
    throw new Error(`rotas sem proteção: ${semProtecao.map((p) => path.relative(ROOT, p)).join(", ")}`);
  }
});

teste("service_role nunca é usado em componente de cliente", () => {
  const clientes = [];
  (function varrer(dir) {
    for (const nome of fs.readdirSync(dir)) {
      const p = path.join(dir, nome);
      if (fs.statSync(p).isDirectory()) varrer(p);
      else if (/\.tsx?$/.test(nome)) {
        const s = fs.readFileSync(p, "utf8");
        if (s.startsWith('"use client"') && /SERVICE_ROLE|createAdminClient/.test(s)) {
          clientes.push(path.relative(ROOT, p));
        }
      }
    }
  })(path.join(ROOT, "src"));
  if (clientes.length > 0) throw new Error(`vazamento de chave admin: ${clientes.join(", ")}`);
});

teste("ANTHROPIC_API_KEY só é lida no servidor", () => {
  const vazamentos = [];
  (function varrer(dir) {
    for (const nome of fs.readdirSync(dir)) {
      const p = path.join(dir, nome);
      if (fs.statSync(p).isDirectory()) varrer(p);
      else if (/\.tsx?$/.test(nome)) {
        const s = fs.readFileSync(p, "utf8");
        if (s.startsWith('"use client"') && /ANTHROPIC_API_KEY/.test(s)) {
          vazamentos.push(path.relative(ROOT, p));
        }
      }
    }
  })(path.join(ROOT, "src"));
  if (vazamentos.length > 0) throw new Error(`chave da IA em cliente: ${vazamentos.join(", ")}`);
});

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`Passou: ${passou} | Falhou: ${falhas.length}`);
if (falhas.length > 0) {
  console.log("\nFALHAS:");
  falhas.forEach((f) => console.log("  ✗ " + f));
  process.exit(1);
}
console.log("Todos os testes internos passaram.");
