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

teste("consentimento: texto montado no servidor (só no formulário hospedado, que é o texto exibido); o do navegador é ignorado", () => {
  igual(
    rastreio.consentText("en", "Wait Happy"),
    "I agree to receive messages and offers from Wait Happy. I can opt out at any time.",
  );
  igual(rastreio.consentText("xx", ""), rastreio.consentText("en", ""), "idioma inválido cai no inglês:");
  if (!/consentText\(language, resolved\.companyName\)/.test(srcF)) throw new Error("/f não usa consentText()");
  if (!/consent_text: data\.consent && sourceType === "hosted_form" \? consentText\(data\.lang, companyName\)/.test(srcPublicLeads)) {
    throw new Error("/api/public/leads não monta o texto no servidor só para o formulário hospedado");
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
  if (!/attributionLabels\[lead\.attribution\]/.test(srcPainel)) throw new Error("tela não usa attributionLabels");
});

teste("resultados: totais vêm do banco (client_period_totals), nada somado na rota", () => {
  if (!/rpc\("client_period_totals"/.test(srcResults)) throw new Error("rota não usa client_period_totals");
  if (/\.reduce\(/.test(srcResults)) throw new Error("rota soma valores em JS");
  if (/\.limit\((5000|10000)\)/.test(srcResults)) throw new Error("ainda usa .limit(5000/10000) para totais");
});

teste("rota pública fala com o público em inglês; login traduz o erro do Supabase", () => {
  const publicas = [...srcPublicLeads.matchAll(/(?:error: |refine\([^,]+, )"([^"]+)"/g)].map((m) => m[1]);
  if (publicas.length < 5) throw new Error("mensagens públicas não encontradas");
  const pt = publicas.filter((msg) => /[ãõçáéíóúêâ]/i.test(msg));
  if (pt.length) throw new Error(`mensagem pública em português: ${pt.join(" | ")}`);
  const login = ler("src/app/login/page.tsx");
  if (!/setError\(loginErrorMessage\(signInError\)\)/.test(login)) throw new Error("login mostra o erro cru do Supabase");
  for (const trecho of ["E-mail ou senha incorretos.", "Sem conexão com o servidor"]) if (!login.includes(trecho)) throw new Error(`login sem: ${trecho}`);
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

// ===========================================================================
// >>> INÍCIO SEÇÃO 8 — GERAÇÃO DE CAMPANHAS (período contínuo, fuso, cotas, IA,
//     worker/cron/fila). Mantida pelo engenheiro da geração; outras seções à parte.
// ===========================================================================
console.log("\n[8] Geração — período contínuo, fuso, cotas, IA e fila");
{
  const P = require(path.join(ROOT, "src/lib/campaigns/period.ts"));
  const D = require(path.join(ROOT, "src/lib/campaigns/draft.ts"));
  const A = require(path.join(ROOT, "src/lib/campaigns/internal-auth.ts"));
  const lerSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const diaSeguinte = (dia) => new Date(Date.parse(`${dia}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);

  /** Simula o cron disparando no instante exato de cada alvo e confere a cadeia de períodos. */
  function cadeia(primeiroDisparo, cadencia, ancora, ciclos) {
    let nga = primeiroDisparo;
    let anterior = null;
    const periodos = [];
    for (let i = 0; i < ciclos; i++) {
      const plano = P.planDispatch(nga, cadencia, new Date(Date.parse(nga) + 60e3), ancora);
      const periodo = P.periodFor(plano.target, cadencia, new Date(), ancora);
      if (anterior && diaSeguinte(anterior.endsAt) !== periodo.startsAt) {
        throw new Error(`lacuna/sobreposição: ${anterior.startsAt}..${anterior.endsAt} → ${periodo.startsAt}..${periodo.endsAt}`);
      }
      if (diaSeguinte(periodo.endsAt) !== plano.next.slice(0, 10)) {
        throw new Error(`período ${periodo.startsAt}..${periodo.endsAt} não termina na véspera do próximo alvo ${plano.next.slice(0, 10)}`);
      }
      if (periodo.days < 1) throw new Error(`período vazio ${JSON.stringify(periodo)}`);
      periodos.push(periodo);
      anterior = periodo;
      nga = plano.next;
    }
    return periodos;
  }

  teste("cadeia mensal contínua (fim + 1 dia = próximo início) para âncoras 1, 15, 28, 29, 30, 31", () => {
    for (const ancora of [1, 15, 28, 29, 30, 31]) {
      const inicio = `2026-01-${String(ancora).padStart(2, "0")}T05:00:00.000Z`;
      const periodos = cadeia(inicio, "monthly", ancora, 40); // 40 meses: passa por fev/2028 (bissexto)
      for (const p of periodos) {
        if (p.days < 28 || p.days > 31) throw new Error(`âncora ${ancora}: ciclo cheio com ${p.days} dias (${p.startsAt}..${p.endsAt})`);
      }
    }
  });

  teste("âncora 31 respeita fevereiro bissexto (2028) e volta ao dia 31", () => {
    const periodos = cadeia("2028-01-31T05:00:00.000Z", "monthly", 31, 3);
    igual(periodos.map((p) => `${p.startsAt}..${p.endsAt}`).join(" "), "2028-01-31..2028-02-28 2028-02-29..2028-03-30 2028-03-31..2028-04-29");
  });

  teste("âncora 29 em ano NÃO bissexto: 29/jan → 28/fev → 29/mar sem lacuna", () => {
    const periodos = cadeia("2027-01-29T05:00:00.000Z", "monthly", 29, 3);
    igual(periodos.map((p) => `${p.startsAt}..${p.endsAt}`).join(" "), "2027-01-29..2027-02-27 2027-02-28..2027-03-28 2027-03-29..2027-04-28");
  });

  teste("1º disparo fora do dia-âncora (início 31/ago, criado 07/out): sem lacuna de 23 dias", () => {
    const periodos = cadeia("2026-10-07T14:23:00.000Z", "monthly", 31, 4);
    igual(periodos.map((p) => `${p.startsAt}..${p.endsAt}`).join(" "),
      "2026-10-07..2026-10-30 2026-10-31..2026-11-29 2026-11-30..2026-12-30 2026-12-31..2027-01-30");
  });

  teste("cron parado meses: retoma no ciclo atual e a cadeia continua contínua", () => {
    const plano = P.planDispatch("2026-01-31T05:00:00.000Z", "monthly", new Date("2026-06-10T00:00:00Z"), 31);
    igual(plano.target.slice(0, 10), "2026-05-31", "ciclo atual:");
    const periodo = P.periodFor(plano.target, "monthly", new Date(), 31);
    igual(diaSeguinte(periodo.endsAt), plano.next.slice(0, 10), "fim do período:");
  });

  teste("cadeia semanal contínua", () => {
    cadeia("2026-10-29T02:00:00.000Z", "weekly", undefined, 20);
  });

  teste("dia-âncora vem de starts_at (mesma função no cron, worker e fila)", () => {
    igual(P.contractAnchorDay("2026-08-31"), 31);
    igual(P.contractAnchorDay(null), undefined);
    for (const rel of ["src/app/api/cron/dispatch-due-work/route.ts", "src/app/api/campaigns/generate/route.ts", "src/app/api/campaigns/queue/route.ts"]) {
      if (!/contractAnchorDay\(/.test(lerSrc(rel))) throw new Error(`${rel} não usa contractAnchorDay`);
    }
  });

  teste("pedido manual e cron do MESMO ciclo têm a MESMA chave (sem conteúdo em dobro)", () => {
    // Mensal, âncora 31: cron gerou 07/out..30/out; pedido manual em 10/out.
    const cron = P.periodFor("2026-10-07T14:23:00Z", "monthly", new Date(), 31);
    const manual = P.manualPeriodFor("2026-10-10T15:00:00Z", "monthly", "2026-10-31T14:23:00Z", 31);
    igual(`${manual.startsAt}..${manual.endsAt}`, "2026-10-10..2026-10-30", "período manual:");
    igual(P.batchKey("k", manual), P.batchKey("k", cron), "chave:");
    // Semanal: grade alinhada a next_generation_at (cron já avançou para 14/out).
    const cronSemanal = P.periodFor("2026-10-07T02:00:00Z", "weekly");
    const manualSemanal = P.manualPeriodFor("2026-10-10T15:00:00Z", "weekly", "2026-10-14T02:00:00Z");
    igual(P.batchKey("k", manualSemanal), P.batchKey("k", cronSemanal), "chave semanal:");
    igual(manualSemanal.startsAt, "2026-10-10", "manual nunca gera o passado:");
    for (const rel of ["src/app/api/cron/dispatch-due-work/route.ts", "src/app/api/campaigns/queue/route.ts"]) {
      const s = lerSrc(rel);
      if (!/batchKey\(/.test(s) || /manual-content-batch|batch_\$\{/.test(s)) throw new Error(`${rel} não usa a chave unificada`);
    }
  });

  teste("período do job é lido do payload (validado) — o worker não recalcula diferente do cron", () => {
    igual(JSON.stringify(P.periodFromPayload({ period: { startsAt: "2026-10-07", endsAt: "2026-10-30" } })), JSON.stringify({ startsAt: "2026-10-07", endsAt: "2026-10-30", days: 24 }));
    igual(P.periodFromPayload({ period: { startsAt: "2026-10-30", endsAt: "2026-10-07" } }), null, "invertido:");
    igual(P.periodFromPayload({ target_date: "2026-10-07" }), null, "sem período:");
  });

  console.log("    · fuso e datas");

  teste("data sem hora ('2026-10-03') vira meio-dia local e NÃO o dia anterior nos EUA", () => {
    const periodo = { startsAt: "2026-10-01", endsAt: "2026-10-07" };
    for (const tz of ["America/New_York", "America/Chicago", "America/Los_Angeles", "Pacific/Honolulu"]) {
      const saida = P.normalizeScheduledAt("2026-10-03", 0, periodo, tz);
      igual(P.localDayOf(saida, tz), "2026-10-03", `${tz}:`);
    }
    igual(P.normalizeScheduledAt("2026-10-03", 0, periodo, "America/New_York"), "2026-10-03T16:00:00.000Z", "NY meio-dia (EDT):");
  });

  teste("horário sem offset é do fuso do contrato; com offset/Z é instante exato", () => {
    const periodo = { startsAt: "2026-10-01", endsAt: "2026-10-07" };
    igual(P.normalizeScheduledAt("2026-10-03T09:00", 0, periodo, "America/Los_Angeles"), "2026-10-03T16:00:00.000Z");
    igual(P.normalizeScheduledAt("2026-10-03T09:00:00-04:00", 0, periodo, "America/Los_Angeles"), "2026-10-03T13:00:00.000Z");
  });

  teste("peça fora do período por poucas horas é recusada (sem tolerância de ±24h)", () => {
    const periodo = { startsAt: "2026-07-27", endsAt: "2026-08-02" };
    // 03/ago 00:30 em NY: já é o período seguinte (antes era aceito pela tolerância).
    const fora = P.normalizeScheduledAt("2026-08-03T00:30:00-04:00", 0, periodo, "America/New_York");
    if (P.localDayOf(fora, "America/New_York") > periodo.endsAt) throw new Error(`aceitou ${fora}`);
    const antes = P.normalizeScheduledAt("2026-07-26T23:30:00-04:00", 0, periodo, "America/New_York");
    if (P.localDayOf(antes, "America/New_York") < periodo.startsAt) throw new Error(`aceitou ${antes}`);
    // 02/ago 20:00 em NY (= 03/ago 00:00Z) continua aceito: o dia local é 02/ago.
    igual(P.normalizeScheduledAt("2026-08-03T00:00:00Z", 0, periodo, "America/New_York"), "2026-08-03T00:00:00.000Z");
  });

  teste("formato não ISO ('10/03/2026', 'next Tuesday') cai no fallback dentro do período", () => {
    const periodo = { startsAt: "2026-10-01", endsAt: "2026-10-07" };
    for (const bruto of ["10/03/2026", "next Tuesday", "2026-13-45", ""]) {
      const dia = P.localDayOf(P.normalizeScheduledAt(bruto, 3, periodo, "America/New_York"), "America/New_York");
      if (dia < periodo.startsAt || dia > periodo.endsAt) throw new Error(`"${bruto}" → ${dia}`);
    }
  });

  teste("horário de verão: 10:00 local antes e depois da troca (NY, nov/2026)", () => {
    igual(P.zonedTimeToUtc("2026-10-31", "10:00", "America/New_York").toISOString(), "2026-10-31T14:00:00.000Z");
    igual(P.zonedTimeToUtc("2026-11-02", "10:00", "America/New_York").toISOString(), "2026-11-02T15:00:00.000Z");
    igual(P.safeTimeZone("Mars/Olympus"), "America/New_York", "fuso inválido:");
  });

  console.log("    · cotas");

  teste("cota mensal em lotes semanais NÃO vaza na virada do mês (8/mês por 4 meses)", () => {
    const tz = "America/New_York";
    const regras = [{ channel: "instagram", format: "photo", quantity: 8, period: "month" }];
    const geradas = [];
    let inicio = Date.parse("2026-10-01T04:00:00Z");
    for (let semana = 0; semana < 18; semana++, inicio += 7 * 864e5) {
      const periodo = P.periodFor(new Date(inicio).toISOString(), "weekly");
      const mes = periodo.startsAt.slice(0, 7);
      const ja = geradas.filter((g) => g.dia.slice(0, 7) === mes && g.dia < periodo.startsAt).length;
      const plano = P.quotaPlan(regras, periodo, "weekly", { "instagram|photo": ja });
      const n = plano[0]?.quantity ?? 0;
      // IA "preguiçosa": joga todas as peças no ÚLTIMO dia do período (pior caso).
      const ia = Array.from({ length: n }, () => ({ channel: "instagram", format: "photo", scheduledAt: `${periodo.endsAt}T15:00:00Z` }));
      const datas = ia.map((it, i) => ({ ...it, scheduledAt: P.normalizeScheduledAt(it.scheduledAt, i, periodo, tz) }));
      for (const it of P.applyQuotaWindows(datas, plano, tz)) geradas.push({ dia: P.localDayOf(it.scheduledAt, tz) });
    }
    const porMes = {};
    for (const g of geradas) porMes[g.dia.slice(0, 7)] = (porMes[g.dia.slice(0, 7)] ?? 0) + 1;
    for (const mes of ["2026-10", "2026-11", "2026-12", "2027-01"]) igual(porMes[mes], 8, `${mes}:`);
  });

  teste("ciclo mensal PARCIAL (1º disparo fora da âncora) recebe cota proporcional; ciclo cheio, a cota inteira", () => {
    const regras = [{ channel: "instagram", format: "reel", quantity: 8, period: "month" }];
    const parcial = P.periodFor("2026-10-07T14:00:00Z", "monthly", new Date(), 31); // 24 de 31 dias
    igual(P.quotaPlan(regras, parcial, "monthly", {}, 31)[0].quantity, 6, "parcial:");
    const cheio = P.periodFor("2026-10-31T14:00:00Z", "monthly", new Date(), 31);
    igual(P.quotaPlan(regras, cheio, "monthly", {}, 31)[0].quantity, 8, "cheio:");
    const fev = P.periodFor("2027-01-31T14:00:00Z", "monthly", new Date(), 31); // 28 dias, ciclo cheio
    igual(P.quotaPlan(regras, fev, "monthly", {}, 31)[0].quantity, 8, "fevereiro:");
  });

  teste("excedente da IA é cortado na cota (não derruba o lote); extras de data especial respeitados", () => {
    const plano = [{ channel: "instagram", format: "photo", quantity: 2, objective: "flexible" }];
    const itens = Array.from({ length: 5 }, (_, i) => ({ channel: "instagram", format: "photo", i }));
    const { kept, dropped } = P.enforceQuotas(itens, plano, { photo: 1 });
    igual(`${kept.length}/${dropped}`, "3/2");
    igual(kept.map((k) => k.i).join(), "0,1,2", "mantém as primeiras:");
  });

  teste("lote grande é dividido em chamadas de até 6 peças sem perder cota", () => {
    const plano = [
      { channel: "instagram", format: "reel", quantity: 13, objective: "flexible" },
      { channel: "facebook", format: "photo", quantity: 4, objective: "flexible" },
    ];
    const pedacos = P.splitQuotaPlan(plano, { reel: 1 }, 6);
    igual(pedacos.length, 3, "pedaços:");
    for (const p of pedacos) {
      const n = p.quotas.reduce((s, l) => s + l.quantity, 0);
      if (n > 6) throw new Error(`pedaço com ${n} peças`);
    }
    igual(pedacos.flatMap((p) => p.quotas).reduce((s, l) => s + l.quantity, 0), 17, "total:");
    igual(JSON.stringify(pedacos.map((p) => p.extras)), JSON.stringify([{ reel: 1 }, {}, {}]), "extras só no 1º:");
  });

  console.log("    · rascunho da IA");
  const enums = { channels: ["instagram", "facebook"], formats: ["photo", "reel"], objectives: ["attract", "convert"] };
  const fallbacks = { campaignName: "Cliente · 2026-10-01", campaignGoal: "Conteúdo do período", summary: "Lote de conteúdo do período." };
  const pecaBoa = (extra = {}) => ({
    title: "Quanto custa uma limpeza", concept: "Preço transparente", hook: "Quanto custa?", cta: "Peça orçamento",
    scheduledAt: "2026-10-03T10:00:00-04:00", channel: "instagram", format: "reel", objective: "convert", pillar: "Preço",
    caption: "Descubra quanto custa uma limpeza profissional.", hashtags: ["#boston"], creativeBrief: "Vídeo curto.",
    imagePrompt: "", videoScript: "Cena 1", ...extra,
  });

  teste("texto acima do limite é CORTADO (antes o zod derrubava o lote inteiro)", () => {
    const { draft } = D.sanitizeDraft({ campaignName: "Outubro", campaignGoal: "Gerar orçamentos locais", summary: "x".repeat(5000), contentItems: [pecaBoa({ caption: "a".repeat(3100), hashtags: Array.from({ length: 40 }, (_, i) => `#t${i}`) })] }, enums, fallbacks);
    igual(draft.summary.length, D.DRAFT_LIMITS.summary[1], "resumo:");
    igual(draft.contentItems[0].caption.length, D.DRAFT_LIMITS.caption[1], "legenda:");
    igual(draft.contentItems[0].hashtags.length, D.MAX_HASHTAGS, "hashtags:");
  });

  teste("concept com espaços é aparado; curto/vazio usa o título (casa com o check 3..300 do banco)", () => {
    const { draft } = D.sanitizeDraft({ campaignName: "Outubro", campaignGoal: "Gerar orçamentos locais", summary: "Resumo do lote de outubro.", contentItems: [pecaBoa({ concept: "   ab  " }), pecaBoa({ concept: `  ${"c".repeat(400)} ` })] }, enums, fallbacks);
    igual(draft.contentItems[0].concept, "Quanto custa uma limpeza", "curto:");
    igual(draft.contentItems[1].concept.length, 300, "longo:");
    for (const item of draft.contentItems) {
      const n = Array.from(item.concept.trim()).length;
      if (n < 3 || n > 300) throw new Error(`concept fora do check: ${n}`);
    }
  });

  teste("peça com canal/formato inválido é descartada sozinha; lote sem peça válida é erro", () => {
    const { draft, dropped } = D.sanitizeDraft({ campaignName: "Outubro", campaignGoal: "Gerar orçamentos locais", summary: "Resumo do lote de outubro.", contentItems: [pecaBoa(), pecaBoa({ channel: "orkut" }), pecaBoa({ objective: "viralizar" })] }, enums, fallbacks);
    igual(draft.contentItems.length, 2, "válidas:");
    igual(dropped.length, 1, "descartadas:");
    igual(draft.contentItems[1].objective, "attract", "objetivo inválido vira o padrão:");
    let erro = null;
    try { D.sanitizeDraft({ contentItems: [pecaBoa({ caption: "" })] }, enums, fallbacks); } catch (e) { erro = e; }
    if (!erro) throw new Error("aceitou lote sem peça válida");
  });

  teste("corte nunca parte emoji ao meio (o Postgres recusa surrogate solto)", () => {
    const cortado = D.clipText("a" + "😀".repeat(10), 4);
    igual(cortado, "a😀😀😀");
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cortado)) throw new Error("surrogate solto");
  });

  console.log("    · IA, worker, cron e fila (contratos do código)");
  const ia = lerSrc("src/lib/ai/anthropic.ts");
  teste("IA: streaming + finalMessage, stop_reason conferido ANTES do parse, sem messages.parse", () => {
    if (!/messages\.stream\(/.test(ia) || !/finalMessage\(\)/.test(ia)) throw new Error("não usa streaming/finalMessage");
    if (/messages\.parse\(/.test(ia)) throw new Error("ainda usa messages.parse (parse antes do stop_reason)");
    const posStop = ia.indexOf('stop_reason === "max_tokens"');
    const posParse = ia.indexOf("JSON.parse(");
    if (posStop < 0 || posParse < 0 || posStop > posParse) throw new Error("stop_reason não é conferido antes do JSON.parse");
    if (!/stop_reason === "refusal"/.test(ia)) throw new Error("sem tratamento de recusa");
    const maxTokens = Number((ia.match(/MAX_TOKENS_POR_CHAMADA = ([\d_]+)/) || [])[1]?.replace(/_/g, ""));
    if (!(maxTokens >= 16000)) throw new Error(`max_tokens baixo: ${maxTokens}`);
    if (!/signal: AbortSignal\.timeout\(/.test(ia)) throw new Error("streaming sem prazo absoluto (signal)");
    if (/maxRetries: [2-9]/.test(ia)) throw new Error("maxRetries alto");
  });

  const worker = lerSrc("src/app/api/campaigns/generate/route.ts");
  teste("worker: 1 job por reserva, orçamento conferido antes de cada job, gravação via RPC transacional", () => {
    if (!/maximum_jobs: 1\b/.test(worker)) throw new Error("reserva mais de 1 job por vez");
    if (!/complete_generation_job/.test(worker)) throw new Error("não usa complete_generation_job");
    if (/from\("campaigns"\)\s*\.insert|from\("content_items"\)\s*\.insert/.test(worker)) throw new Error("ainda grava campanha/peças fora da transação");
    if (!/\.eq\("locked_by", workerName\)/.test(worker) || !/\.select\("id"\)/.test(worker)) throw new Error("atualização do job sem filtro de dono ou sem checar linhas");
    const limite = Number(worker.match(/LIMITE_MS = ([\d_]+)/)[1].replace(/_/g, ""));
    const iaMax = Number(worker.match(/IA_MAXIMO_MS = ([\d_]+)/)[1].replace(/_/g, ""));
    const margem = Number(worker.match(/MARGEM_GRAVACAO_MS = ([\d_]+)/)[1].replace(/_/g, ""));
    const duracao = Number(worker.match(/maxDuration = (\d+)/)[1]) * 1000;
    if (limite >= duracao) throw new Error("limite interno não é menor que maxDuration");
    if (iaMax + margem > limite) throw new Error("pior caso da IA + gravação passa do limite");
    if (!/status !== "active"/.test(worker)) throw new Error("não confere se o contrato está ativo");
  });

  teste("cron e fila disparam o worker SEM esperar (after), worker responde 202", () => {
    for (const rel of ["src/app/api/cron/dispatch-due-work/route.ts", "src/app/api/campaigns/queue/route.ts"]) {
      const s = lerSrc(rel);
      if (/await fetch\(/.test(s)) throw new Error(`${rel} ainda espera o worker`);
      if (!/triggerWorkerInBackground\(/.test(s)) throw new Error(`${rel} não dispara o worker`);
    }
    if (!/status: 202/.test(worker) || !/after\(/.test(worker)) throw new Error("worker não responde 202 / não usa after");
    const cron = lerSrc("src/app/api/cron/dispatch-due-work/route.ts");
    if (/\.limit\(LOTE_DE_CONTRATOS\)/.test(cron)) throw new Error("lote fixo de contratos ainda pode bloquear a fila");
  });

  teste("CRON_SECRET exigido sempre que definido; sem segredo, só localhost fora de produção", () => {
    const ok = (o) => A.internalRequestAllowed({ authorization: null, url: "https://app.vercel.app/x", cronSecret: undefined, nodeEnv: "development", ...o });
    igual(ok({ cronSecret: "s", nodeEnv: "development" }), false, "preview sem header:");
    igual(ok({ cronSecret: "s", authorization: "Bearer s" }), true, "com segredo:");
    igual(ok({ cronSecret: "s", authorization: "Bearer s", nodeEnv: "production" }), true);
    igual(ok({ cronSecret: "s", url: "http://localhost:3000/x" }), false, "localhost sem header com segredo:");
    igual(ok({}), false, "host público sem segredo:");
    igual(ok({ url: "http://localhost:3000/x" }), true, "dev localhost sem segredo:");
    igual(ok({ url: "http://localhost:3000/x", nodeEnv: "production" }), false, "produção sem segredo:");
  });
  teste("IA: conteúdo final em inglês por padrão e com regras do mercado dos EUA", () => {
    const src = lerSrc("src/lib/ai/anthropic.ts");
    if (!/input\.language \?\? "en-US"/.test(src)) throw new Error("idioma padrão não é en-US");
    if (/\?\? "pt-BR"/.test(src)) throw new Error("ainda cai em pt-BR");
    for (const termo of ["LLC", "EIN", "IRS", "MEI", "CNPJ"]) if (!src.includes(termo)) throw new Error(`prompt sem ${termo}`);
  });
}
// <<< FIM SEÇÃO 8 — GERAÇÃO DE CAMPANHAS
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
