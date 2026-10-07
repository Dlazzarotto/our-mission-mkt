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

// ===========================================================================
// 7. ROTAS PÚBLICAS E MEDIÇÃO — endurecimento (início da seção; mantida pelo
//    responsável por /r, /f, /api/public, /api/leads, /api/links, /api/metrics,
//    /api/results, /api/content/publication, tracking.ts e results-panel)
// ===========================================================================
console.log("\n[7] Rotas públicas e medição — endurecimento");

const ler = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const srcR = ler("src/app/r/[slug]/route.ts");
const srcF = ler("src/app/f/[slug]/page.tsx");
const srcPublicLeads = ler("src/app/api/public/leads/route.ts");
const srcLeads = ler("src/app/api/leads/route.ts");
const srcMetrics = ler("src/app/api/metrics/route.ts");
const srcResults = ler("src/app/api/results/route.ts");
const srcPublication = ler("src/app/api/content/publication/route.ts");
const srcPainel = ler("src/components/results-panel.tsx");
const srcForm = ler("src/components/public-lead-form.tsx");
const dominio = require(path.join(ROOT, "src/lib/domain.ts"));

teste("isBot: celular CUBOT é gente; Googlebot, prévias e scripts são robô", () => {
  const humanos = [
    "Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 9; CUBOT_X20_PRO Build/PPR1.180610.011) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 13; CUBOT P60) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/440.0.0.0;]",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0",
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  ];
  for (const ua of humanos) if (rastreio.isBot(ua)) throw new Error(`pessoa marcada como robô: ${ua.slice(0, 70)}`);
  igual(rastreio.detectDevice(humanos[0]), "mobile", "CUBOT:");
  const robos = [
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0 Safari/537.36",
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
    "WhatsApp/2.23.20.0 A",
    "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "TelegramBot (like TwitterBot)",
    "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
    "AdsBot-Google (+http://www.google.com/adsbot.html)",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36",
    "curl/8.4.0",
    "python-requests/2.31.0",
    "",
  ];
  for (const ua of robos) if (!rastreio.isBot(ua)) throw new Error(`robô não detectado: "${ua.slice(0, 70)}"`);
});

teste("parseMoney: '1.500,00' é 1500 (não 1,5) e aceita os formatos comuns", () => {
  const casos = {
    "1500": 1500, "1500.50": 1500.5, "1,500.50": 1500.5, "1.500,50": 1500.5, "1500,50": 1500.5,
    "1.500,00": 1500, "$1,500": 1500, "US$ 2,000.10": 2000.1, "R$ 1.500,00": 1500, "1.500": 1500,
    "1,500": 1500, "1.250.000,99": 1250000.99, "0,99": 0.99, "1.5": 1.5, "1500.5": 1500.5,
  };
  for (const [entrada, esperado] of Object.entries(casos)) igual(rastreio.parseMoney(entrada), esperado, `"${entrada}":`);
  for (const ruim of ["", "abc", "-5", "1500.505", "1,2,3", "1.50,0", "12,34,56", "1e5", "100000001"]) {
    igual(rastreio.parseMoney(ruim), null, `"${ruim}":`);
  }
  igual(rastreio.parseMoney(99.999), 100, "número já numérico arredonda para centavos:");
});

teste("parseCount: contagem inteira com separador de milhar; fração é recusada", () => {
  for (const [entrada, esperado] of [["1500", 1500], ["1,500", 1500], ["1.500", 1500], ["1 500", 1500], ["0", 0]]) {
    igual(rastreio.parseCount(entrada), esperado, `"${entrada}":`);
  }
  for (const ruim of ["1.5", "1,50", "abc", "-3", "1.500,00"]) igual(rastreio.parseCount(ruim), null, `"${ruim}":`);
});

teste("receita: tela e servidor usam o MESMO parser (parseMoney)", () => {
  if (!/parseMoney/.test(srcPainel) || /replace\(\/\[\^0-9\.\]\/g/.test(srcPainel)) throw new Error("results-panel não usa parseMoney");
  if (!/moneyInput/.test(srcLeads)) throw new Error("/api/leads não valida receita com moneyInput");
  if (!/parseMoney/.test(ler("src/lib/marketing/input-schemas.ts"))) throw new Error("moneyInput não usa parseMoney");
});

teste("limite por IP: IPv6 agrupado por /64, IPv4 inteiro, IPv4 mapeado vira IPv4", () => {
  const a = rastreio.ipRateLimitKey("2001:db8:abcd:12:1:2:3:4");
  igual(rastreio.ipRateLimitKey("2001:db8:abcd:12::ffff"), a, "mesmo /64:");
  if (rastreio.ipRateLimitKey("2001:db8:abcd:13::1") === a) throw new Error("/64 diferente agrupado junto");
  igual(rastreio.ipRateLimitKey("203.0.113.7"), "v4:203.0.113.7");
  if (rastreio.ipRateLimitKey("203.0.113.8") === rastreio.ipRateLimitKey("203.0.113.7")) throw new Error("IPv4 agrupado");
  igual(rastreio.ipRateLimitKey("::ffff:203.0.113.7"), "v4:203.0.113.7");
  igual(rastreio.ipRateLimitKey("lixo"), null);
  igual(rastreio.ipRateLimitKey("1.2.3.999"), null);
});

teste("sal ausente em produção falha fechado (null), nunca string vazia", () => {
  igual(rastreio.resolveTrackingSalt({ NODE_ENV: "production" }), null, "sem nada:");
  igual(rastreio.resolveTrackingSalt({ NODE_ENV: "production", TRACKING_SALT: "  ", CRON_SECRET: "" }), null, "só espaços:");
  igual(rastreio.resolveTrackingSalt({ NODE_ENV: "production", CRON_SECRET: "c" }), "c", "fallback CRON_SECRET:");
  igual(rastreio.resolveTrackingSalt({ NODE_ENV: "production", TRACKING_SALT: "t", CRON_SECRET: "c" }), "t");
  if (!rastreio.resolveTrackingSalt({ NODE_ENV: "development" })) throw new Error("dev sem sal deveria ter sal fixo");
  for (const src of [srcR, srcPublicLeads]) {
    if (/\?\?\s*""/.test(src.split("\n").filter((l) => /SALT|CRON_SECRET/.test(l)).join("\n"))) throw new Error("rota ainda usa sal vazio");
    if (!/resolveTrackingSalt\(process\.env\)/.test(src)) throw new Error("rota não usa resolveTrackingSalt");
  }
});

teste("hashIp sem sal não gera hash", () => {
  // hashIp é assíncrona (crypto.subtle) e o executor de teste é síncrono: confere a guarda no código.
  if (!/if \(!ip \|\| !salt\) return null/.test(ler("src/lib/marketing/tracking.ts"))) throw new Error("hashIp aceita sal vazio");
});

teste("consentimento: texto montado no servidor pela mesma função do /f; o do navegador é ignorado", () => {
  igual(
    rastreio.consentText("en", "Wait Happy"),
    "I agree to receive messages and offers from Wait Happy. I can opt out at any time.",
  );
  igual(rastreio.consentText("xx", ""), rastreio.consentText("en", ""), "idioma inválido cai no inglês:");
  if (!/consentText\(language, resolved\.companyName\)/.test(srcF)) throw new Error("/f não usa consentText()");
  if (!/consent_text: data\.consent \? consentText\(data\.lang, companyName\)/.test(srcPublicLeads)) {
    throw new Error("/api/public/leads não monta o texto no servidor");
  }
  if (/data\.consentText|consentText:\s*optionalText/.test(srcPublicLeads)) throw new Error("servidor ainda lê consentText do navegador");
  if (/consentText,\s*\n\s*website/.test(srcForm) || /\.replace\("\{company\}"/.test(srcForm)) {
    throw new Error("formulário ainda monta/envia o próprio texto de consentimento");
  }
});

teste("lead público exige e-mail ou telefone e cliente ativo", () => {
  if (!/\.refine\(\(data\) => data\.email \|\| data\.phone/.test(srcPublicLeads)) throw new Error("servidor aceita lead só com nome");
  const helper = ler("src/lib/marketing/public-link.ts");
  if (!/from\("clients"\)[\s\S]{0,120}active/.test(helper) || !/!client\?\.active/.test(helper)) throw new Error("cliente inativo não é recusado");
  for (const [nome, src] of [["/r", srcR], ["/f", srcF], ["/api/public/leads", srcPublicLeads]]) {
    if (!/loadPublicLink\(/.test(src)) throw new Error(`${nome} não usa loadPublicLink (regra única de link/cliente ativo)`);
  }
});

teste("limite de envios atômico (consume_rate_limit) — sem corrida contar→gravar", () => {
  if (/count:\s*"exact"/.test(srcPublicLeads)) throw new Error("/api/public/leads ainda conta antes de gravar");
  if (!/consumeRateLimit\(supabase, `lead-ip:/.test(srcPublicLeads) || !/consumeRateLimit\(supabase, `lead-link:/.test(srcPublicLeads)) {
    throw new Error("faltam os buckets por IP e por link");
  }
  if (!/rpc\("consume_rate_limit"/.test(ler("src/lib/marketing/public-link.ts"))) throw new Error("helper não chama a função do banco");
  // Estouro POR LINK não bloqueia lead real: grava em quarentena (status spam).
  if (!/status: limite\.decision === "quarantine" \? "spam" : "new"/.test(srcPublicLeads)) throw new Error("estouro por link sem quarentena");
});

teste("/r: HEAD não grava clique; clique deduplicado; redirect sobrevive a falha de gravação", () => {
  const head = srcR.slice(srcR.indexOf("export async function HEAD"));
  if (!head.startsWith("export async function HEAD")) throw new Error("/r não exporta HEAD");
  if (/recordClick|\.insert\(|cookies\.set/.test(head)) throw new Error("HEAD grava clique ou cookie");
  if (!/`click:\$\{link\.id\}:\$\{ipBucket\}/.test(srcR) || !/JANELA_CLIQUE_S = 30 \* 60/.test(srcR)) throw new Error("sem deduplicação de 30 min");
  if (!/try \{\s*await recordClick\([\s\S]{0,200}\} catch/.test(srcR)) throw new Error("falha ao gravar clique derruba o redirect");
  if (!/status === "error"\) return page\(/.test(srcR)) throw new Error("sem página amigável quando o banco/chave falha");
});

teste("rotas públicas fora de /api (/r, /f) marcadas e, se gravam, com limite de envios", () => {
  const problemas = [];
  (function varrer(dir) {
    for (const nome of fs.readdirSync(dir)) {
      const p = path.join(dir, nome);
      if (fs.statSync(p).isDirectory()) {
        if (p !== path.join(ROOT, "src/app/api")) varrer(p);
      } else if (/\.tsx?$/.test(nome)) {
        const s = fs.readFileSync(p, "utf8");
        if (!/createAdminClient|loadPublicLink/.test(s)) continue;
        const rel = path.relative(ROOT, p);
        if (!/ROTA PÚBLICA/.test(s)) problemas.push(`${rel} sem marcação ROTA PÚBLICA`);
        if (/\.(insert|upsert|update|delete)\(|\.rpc\(/.test(s) && !/consumeRateLimit|consume_rate_limit|limiteDeEnvios/.test(s)) {
          problemas.push(`${rel} grava sem limite de envios`);
        }
      }
    }
  })(path.join(ROOT, "src/app"));
  if (!/ROTA PÚBLICA/.test(srcR) || !/ROTA PÚBLICA/.test(srcF)) problemas.push("/r ou /f sem marcação");
  if (problemas.length > 0) throw new Error(problemas.join("; "));
});

teste("métricas: origem é a lista fechada do banco e linhas repetidas no envio são unificadas", () => {
  igual(dominio.METRIC_SOURCES.join(","), "manual,meta,tiktok,youtube,linkedin,pinterest,google");
  if (!/source: z\.enum\(METRIC_SOURCES\)/.test(srcMetrics)) throw new Error("/api/metrics não usa z.enum(METRIC_SOURCES)");
  if (!/METRIC_SOURCES\.map/.test(srcPainel)) throw new Error("tela não oferece a origem da métrica");
  const linhas = rastreio.dedupeBy(
    [{ k: "a", v: 1 }, { k: "b", v: 2 }, { k: "a", v: 3 }],
    (row) => row.k,
  );
  igual(JSON.stringify(linhas), JSON.stringify([{ k: "b", v: 2 }, { k: "a", v: 3 }]), "última vence:");
  if (!/dedupeBy\(parsed\.rows/.test(srcMetrics)) throw new Error("/api/metrics não deduplica antes do upsert");
  // Quando a migration com o CHECK existir, a lista do código tem de ser idêntica.
  const migracoes = fs.readdirSync(path.join(ROOT, "supabase/migrations")).map((n) => ler(`supabase/migrations/${n}`)).join("\n");
  const check = migracoes.match(/performance_metrics_source_check[\s\S]{0,200}?in\s*\(([^)]*)\)/);
  if (check) {
    const banco = check[1].match(/'([^']+)'/g).map((v) => v.slice(1, -1)).sort().join(",");
    igual(banco, [...dominio.METRIC_SOURCES].sort().join(","), "CHECK do banco × METRIC_SOURCES:");
  }
});

teste("atribuição: só 'click' é origem comprovada; 'link_no_click' tem rótulo próprio", () => {
  igual(dominio.LEAD_ATTRIBUTIONS.join(","), "click,link_no_click,self_reported,unknown");
  igual(dominio.attributionLabels.link_no_click, "Via link (sem clique registrado)");
  if (!/Origem comprovada/.test(dominio.attributionLabels.click)) throw new Error("rótulo de click");
  if (/comprovada/i.test(dominio.attributionLabels.link_no_click)) throw new Error("link_no_click rotulado como comprovado");
  if (!/\.eq\("attribution", "click"\)/.test(srcResults)) throw new Error("attributedShare não conta só 'click'");
  if (!/attributionLabels\[lead\.attribution\]/.test(srcPainel)) throw new Error("tela não usa attributionLabels");
});

teste("resultados: totais sem corte silencioso (count do banco + leitura completa com aviso)", () => {
  if (/\.limit\((5000|10000)\)/.test(srcResults)) throw new Error("ainda usa .limit(5000/10000) para totais");
  for (const trecho of ['periodLeads().not("qualified_at", "is", null)', 'periodLeads().eq("status", "customer")', "truncated", "warnings"]) {
    if (!srcResults.includes(trecho)) throw new Error(`faltou ${trecho}`);
  }
  if (!/data\.warnings\?\.map/.test(srcPainel)) throw new Error("tela não mostra avisos de truncamento");
});

teste("painel: erro ao recarregar com dados antigos aparece na tela", () => {
  if (!/\{loadError \? \(/.test(srcPainel)) throw new Error("erro de recarga some quando já há dados");
});

teste("publicação: remarcar sem permalink/ID não apaga o que já estava gravado", () => {
  if (/permalink: payload\.permalink,/.test(srcPublication) || /external_post_id: payload\.externalPostId \|\| null/.test(srcPublication)) {
    throw new Error("update sobrescreve permalink/external_post_id com null");
  }
  if (!/if \(payload\.permalink\) updates\.permalink/.test(srcPublication)) throw new Error("permalink não é condicional");
});

teste("lead PATCH: notas e motivo de perda podem ser limpos (undefined ≠ vazio)", () => {
  if (/payload\.(notes|lostReason) !== null/.test(srcLeads)) throw new Error("PATCH ainda ignora valor vazio");
  if (!/payload\.notes !== undefined/.test(srcLeads) || !/payload\.lostReason !== undefined/.test(srcLeads)) throw new Error("PATCH não diferencia undefined");
});

teste("destino só recebe UTMs + oml: dados internos do link (ids, organização) não vazam", () => {
  const linhaDoLink = {
    id: "11111111-1111-4111-8111-111111111111", organization_id: "org", client_id: "cli", label: "Reel X",
    mode: "redirect", destination_url: "https://cliente.com/contato", utm_source: "instagram", utm_medium: null,
  };
  const u = new URL(rastreio.buildDestination(linhaDoLink.destination_url, linhaDoLink, "AbCd2345", null));
  const chaves = [...u.searchParams.keys()].sort().join(",");
  igual(chaves, "oml,utm_source", "parâmetros:");
});

teste("links: não existe DELETE (cliques são append-only); a tela oferece Desativar", () => {
  if (/export async function DELETE/.test(ler("src/app/api/links/route.ts"))) throw new Error("/api/links tem DELETE");
  if (!/"Desativar"/.test(srcPainel)) throw new Error("tela sem Desativar");
});
// ===========================================================================
// fim da seção 7
// ===========================================================================

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`Passou: ${passou} | Falhou: ${falhas.length}`);
if (falhas.length > 0) {
  console.log("\nFALHAS:");
  falhas.forEach((f) => console.log("  ✗ " + f));
  process.exit(1);
}
console.log("Todos os testes internos passaram.");
