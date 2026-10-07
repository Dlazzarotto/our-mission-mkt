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
// 1. normalizeScheduledAt — módulo real usado pelo worker (src/lib/campaigns/period.ts)
//    Node 22.18+ carrega TypeScript direto (só sintaxe de tipo apagável).
// ---------------------------------------------------------------------------
const periodo = { startsAt: "2026-07-27", endsAt: "2026-08-02" };
const periodoLib = require(path.join(ROOT, "src/lib/campaigns/period.ts"));
const normalizeScheduledAt = periodoLib.normalizeScheduledAt;

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
// 2. Cadência de geração — mesma função que o dispatcher usa
// ---------------------------------------------------------------------------
const dispatchSrc = fs.readFileSync(
  path.join(ROOT, "src/app/api/cron/dispatch-due-work/route.ts"),
  "utf8",
);
const usaMensal = /generation_cadence === "monthly"/.test(dispatchSrc) && /planDispatch\(/.test(dispatchSrc);

function proximaData(atual, cadencia) {
  // "agora" = o próprio instante agendado: sem atraso, o próximo ciclo é exatamente 1 passo.
  return periodoLib.planDispatch(atual, cadencia, new Date(atual)).next;
}

console.log("\n[2] Cadência de geração (semanal / mensal)");

teste("dispatcher diferencia cadência mensal e usa planDispatch", () => {
  if (!usaMensal) throw new Error("dispatcher não trata generation_cadence com planDispatch");
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

teste("mensal volta ao dia-âncora do contrato depois de fevereiro (31 → 28/fev → 31/mar)", () => {
  const plano = periodoLib.planDispatch("2026-02-28T10:00:00.000Z", "monthly", new Date("2026-02-28T10:00:00.000Z"), 31);
  igual(plano.next.slice(0, 10), "2026-03-31");
});

teste("cron parado 5 semanas: gera só o ciclo atual, nunca semanas passadas", () => {
  const plano = periodoLib.planDispatch("2026-08-03T02:00:00.000Z", "weekly", new Date("2026-09-08T12:00:00.000Z"));
  igual(plano.target.slice(0, 10), "2026-09-07", "ciclo gerado:");
  igual(plano.next.slice(0, 10), "2026-09-14", "próximo ciclo:");
  igual(plano.skippedCycles, 5, "ciclos pulados:");
});

// ---------------------------------------------------------------------------
// 2b. Período e cotas por lote — antes o mensal gerava só 7 dias e a cota
//     mensal era tratada como semanal
// ---------------------------------------------------------------------------
console.log("\n[2b] Período e cotas por lote");

teste("período semanal = 7 dias; mensal = mês corrido inteiro", () => {
  const semanal = periodoLib.periodFor("2026-10-05T02:00:00Z", "weekly");
  igual(`${semanal.startsAt}..${semanal.endsAt}/${semanal.days}`, "2026-10-05..2026-10-11/7");
  const mensal = periodoLib.periodFor("2026-10-05T02:00:00Z", "monthly");
  igual(`${mensal.startsAt}..${mensal.endsAt}/${mensal.days}`, "2026-10-05..2026-11-04/31");
  const fev = periodoLib.periodFor("2026-01-31T02:00:00Z", "monthly");
  igual(fev.endsAt, "2026-02-27", "31/jan → fim antes de 28/fev:");
});

teste("regra semanal num lote mensal multiplica pelas semanas do período", () => {
  const mensal = periodoLib.periodFor("2026-10-01T00:00:00Z", "monthly");
  const plano = periodoLib.quotaPlan([{ channel: "instagram", format: "reel", quantity: 3, period: "week" }], mensal, "monthly");
  igual(plano[0].quantity, 13, "3/semana em 31 dias:");
});

teste("regra mensal em lotes semanais fecha o mês exato (4 por mês)", () => {
  const regra = [{ channel: "linkedin", format: "photo", quantity: 4, period: "month" }];
  let feitas = 0;
  for (const inicio of ["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22", "2026-10-29"]) {
    const p = periodoLib.periodFor(`${inicio}T00:00:00Z`, "weekly");
    const plano = periodoLib.quotaPlan(regra, p, "weekly", { "linkedin|photo": feitas });
    feitas += plano[0]?.quantity ?? 0;
  }
  igual(feitas, 4, "total do mês:");
});

teste("excesso de peças é erro; falta é só aviso; data especial extra libera peça a mais", () => {
  const plano = [{ channel: "instagram", format: "photo", quantity: 2, objective: "flexible" }];
  const tres = [{ channel: "instagram", format: "photo" }, { channel: "instagram", format: "photo" }, { channel: "instagram", format: "photo" }];
  igual(periodoLib.checkQuotas(tres, plano, {}).errors.length, 1, "3 de 2 sem extra:");
  igual(periodoLib.checkQuotas(tres, plano, { photo: 1 }).errors.length, 0, "3 de 2 com 1 extra:");
  const um = periodoLib.checkQuotas([tres[0]], plano, {});
  igual(`${um.errors.length}/${um.shortfalls.length}`, "0/1", "1 de 2:");
});

teste("fallback de data espalha pelo mês inteiro no lote mensal", () => {
  const mensal = periodoLib.periodFor("2026-10-01T00:00:00Z", "monthly");
  const datas = new Set();
  for (let i = 0; i < 20; i++) datas.add(normalizeScheduledAt("sem data", i, mensal).slice(0, 10));
  if (datas.size < 20) throw new Error(`só ${datas.size} dias distintos para 20 peças`);
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

teste("toda rota de API valida sessão ou segredo do cron (públicas: marcadas e com limite)", () => {
  const semProtecao = arquivosApi.filter((p) => {
    const s = fs.readFileSync(p, "utf8");
    // Rota pública só é aceita se declarada como tal E com limite de requisições.
    if (/ROTA PÚBLICA/.test(s)) return !/rateLimit|limiteDeEnvios/.test(s);
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
// 6. Rastreamento — link, robô, destino e indicadores (src/lib/marketing/tracking.ts)
// ---------------------------------------------------------------------------
console.log("\n[6] Rastreamento e atribuição");
const rastreio = require(path.join(ROOT, "src/lib/marketing/tracking.ts"));

teste("slug tem 8 caracteres válidos e não se repete em 2.000 gerações", () => {
  const vistos = new Set();
  for (let i = 0; i < 2000; i++) {
    const slug = rastreio.generateSlug(8);
    if (!rastreio.isValidSlug(slug) || slug.length !== 8) throw new Error(`slug inválido ${slug}`);
    vistos.add(slug);
  }
  if (vistos.size < 2000) throw new Error(`${2000 - vistos.size} colisões`);
});

teste("prévia de link (WhatsApp, Facebook, LinkedIn) conta como robô, pessoa não", () => {
  for (const ua of ["WhatsApp/2.23.20 A", "facebookexternalhit/1.1", "LinkedInBot/1.0", "curl/8.4.0", ""]) {
    if (!rastreio.isBot(ua)) throw new Error(`não detectou robô: "${ua}"`);
  }
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0";
  if (rastreio.isBot(iphone)) throw new Error("navegador do Instagram marcado como robô");
  igual(rastreio.detectDevice(iphone), "mobile");
  igual(rastreio.detectDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36"), "desktop");
});

teste("destino recebe UTM e oml sem sobrescrever parâmetro do próprio site", () => {
  const url = rastreio.buildDestination(
    "https://waithappy.com/quote?utm_source=google&ref=1",
    { utm_source: "instagram", utm_medium: "social", utm_content: "C-00012" },
    "AbCd2345",
    "20000000-0000-4000-8000-0000000000f1",
  );
  const u = new URL(url);
  igual(u.searchParams.get("utm_source"), "google", "não pode sobrescrever:");
  igual(u.searchParams.get("utm_content"), "C-00012");
  igual(u.searchParams.get("oml"), "AbCd2345");
  igual(u.searchParams.get("ref"), "1");
});

teste("só aceita destino https sem usuário/senha embutidos", () => {
  if (!rastreio.isSafeDestination("https://site.com/contato")) throw new Error("recusou https válido");
  for (const ruim of ["http://site.com", "javascript:alert(1)", "https://user:pass@site.com", "https://localhost", "site.com"]) {
    if (rastreio.isSafeDestination(ruim)) throw new Error(`aceitou ${ruim}`);
  }
});

teste("indicador sem base é 'sem dado' (null), nunca zero", () => {
  igual(rastreio.ratio(5, 0), null);
  igual(rastreio.ratio(null, 10), null);
  igual(rastreio.ratio(100, 4, 2), 25);
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
