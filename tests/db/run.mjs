// Testes do banco em Postgres REAL (PGlite): migrations, isolamento entre agências,
// cadeia de atribuição, funil de leads, views de resultado e fila de geração.
// Rodar:  pnpm test:db
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { asAnon, asUser, bootDb, migrationFiles } from "./harness.mjs";

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(`${name} → ${error.message}`);
    console.log(`  FALHA ${name}\n        ${error.message}`);
  }
}
async function mustFail(name, fn, pattern) {
  try {
    await fn();
    failures.push(`${name} → esperava erro, mas passou`);
    console.log(`  FALHA ${name}\n        esperava erro, mas passou`);
  } catch (error) {
    if (!pattern || pattern.test(error.message)) {
      passed++;
      console.log(`  ok   ${name}`);
    } else {
      failures.push(`${name} → erro inesperado: ${error.message}`);
      console.log(`  FALHA ${name}\n        erro inesperado: ${error.message}`);
    }
  }
}
function eq(actual, expected, context = "") {
  if (String(actual) !== String(expected)) throw new Error(`${context} esperado=${expected} obtido=${actual}`);
}

// ---------------------------------------------------------------------------
const U = {
  ownerA: "00000000-0000-4000-8000-0000000000a1",
  viewerA: "00000000-0000-4000-8000-0000000000a2",
  ownerB: "00000000-0000-4000-8000-0000000000b1",
};
const ORG_A = "10000000-0000-4000-8000-00000000000a";
const ORG_B = "10000000-0000-4000-8000-00000000000b";

async function seedBase(db) {
  await db.exec(`
    insert into auth.users (id, email) values ('${U.ownerA}', 'a@x.com'), ('${U.viewerA}', 'v@x.com'), ('${U.ownerB}', 'b@x.com');
    insert into public.organizations (id, name) values ('${ORG_A}', 'Agência A'), ('${ORG_B}', 'Agência B');
    insert into public.organization_members (organization_id, user_id, role) values
      ('${ORG_A}', '${U.ownerA}', 'owner'), ('${ORG_A}', '${U.viewerA}', 'viewer'), ('${ORG_B}', '${U.ownerB}', 'owner');
  `);
}
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];

async function mkClient(db, org, name) {
  return (await one(db, `insert into clients (organization_id, company_name, industry, service, region) values ($1, $2, 'Limpeza', 'Residencial', 'Boston, MA') returning id`, [org, name])).id;
}
async function mkCampaign(db, org, client) {
  return (await one(db, `insert into campaigns (organization_id, client_id, name, goal, starts_at, ends_at) values ($1, $2, 'Campanha', 'Gerar leads locais', '2026-10-01', '2026-10-07') returning id`, [org, client])).id;
}
async function mkItem(db, org, client, campaign, extra = {}) {
  const status = extra.status ?? "published";
  const channel = extra.channel ?? "instagram";
  return (await one(db,
    `insert into content_items (organization_id, campaign_id, client_id, title, scheduled_at, channel, format, objective, pillar, status, family_id)
     values ($1, $2, $3, $4, now() - interval '3 days', $5, 'reel', 'convert', 'Preço', $6, $7) returning id, public_code`,
    [org, campaign, client, extra.title ?? "Quanto custa uma limpeza", channel, status, extra.family ?? null])).id;
}

// ===========================================================================
console.log("\n[0] Migrations");
let db;
await test(`todas as ${migrationFiles().length} migrations aplicam do zero`, async () => {
  db = await bootDb();
});
if (!db) {
  console.log("\nSem banco — abortando.");
  process.exit(1);
}

await test("pré-verificação da migration de integridade PARA se houver dado cruzado", async () => {
  const before = await bootDb({ upTo: "202607270003_logo_flag.sql" });
  await seedBase(before);
  const clientA = await mkClient(before, ORG_A, "Cliente A");
  // Dado podre criado ANTES da correção (era possível): campanha da agência B no cliente da A.
  await before.query(`insert into campaigns (organization_id, client_id, name, goal, starts_at, ends_at) values ($1, $2, 'x', 'meta inválida', '2026-10-01', '2026-10-07')`, [ORG_B, clientA]);
  const fix = migrationFiles().find((m) => m.file.startsWith("202610060001"));
  let blocked = false;
  try {
    await before.exec(fix.sql.replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, ""));
  } catch (error) {
    blocked = /outra agência/.test(error.message);
  }
  if (!blocked) throw new Error("a migration deveria recusar e listar o registro cruzado");
});

await seedBase(db);
const clientA = await mkClient(db, ORG_A, "Wait Happy Cleaning");
const clientA2 = await mkClient(db, ORG_A, "Outro cliente da A");
const clientB = await mkClient(db, ORG_B, "Cliente da B");
const campA = await mkCampaign(db, ORG_A, clientA);
const campA2 = await mkCampaign(db, ORG_A, clientA2);
const campB = await mkCampaign(db, ORG_B, clientB);

// ===========================================================================
console.log("\n[1] Isolamento entre agências (a brecha corrigida)");

await mustFail("agência B NÃO grava campanha no cliente da agência A (usuário logado)", () =>
  asUser(db, U.ownerB, () => db.query(`insert into campaigns (organization_id, client_id, name, goal, starts_at, ends_at) values ($1, $2, 'roubo', 'meta de teste', '2026-10-01', '2026-10-07')`, [ORG_B, clientA])),
/campaigns_client_tfk/);

await mustFail("nem o service_role consegue cruzar agências (FK composta)", () =>
  db.query(`insert into content_items (organization_id, campaign_id, client_id, title, scheduled_at, channel, format, objective, pillar) values ($1, $2, $3, 't', now(), 'instagram', 'reel', 'convert', 'p')`, [ORG_B, campA, clientB]),
/foreign key/);

await mustFail("peça não pode ficar em campanha de OUTRO cliente da mesma agência", () =>
  db.query(`insert into content_items (organization_id, campaign_id, client_id, title, scheduled_at, channel, format, objective, pillar) values ($1, $2, $3, 't', now(), 'instagram', 'reel', 'convert', 'p')`, [ORG_A, campA2, clientA]),
/content_items_campaign_client_fk/);

await mustFail("organization_id é imutável", () => db.query(`update clients set organization_id = $1 where id = $2`, [ORG_B, clientA]), /não pode ser alterado/);

await test("canais novos (tiktok, youtube, pinterest) aceitos", async () => {
  await mkItem(db, ORG_A, clientA, campA, { channel: "tiktok", status: "review", title: "tt" });
  await db.query(`delete from content_items where title = 'tt'`);
});

// ===========================================================================
console.log("\n[2] Fila de geração");

await test("job preso em 'processing' há mais de 15 min volta a ser reclamado", async () => {
  await db.query(`insert into generation_jobs (organization_id, client_id, job_type, status, idempotency_key, attempts, locked_at, locked_by)
                  values ($1, $2, 'content_batch', 'processing', 'preso-1', 1, now() - interval '20 minutes', 'worker-morto')`, [ORG_A, clientA]);
  const claimed = await db.query(`select id, attempts, locked_by from claim_due_generation_jobs('worker-novo', 5)`);
  eq(claimed.rows.length, 1, "reclamados:");
  eq(claimed.rows[0].attempts, 2, "tentativas:");
  eq(claimed.rows[0].locked_by, "worker-novo");
});

await test("job preso com tentativas esgotadas vira 'failed' visível", async () => {
  await db.query(`insert into generation_jobs (organization_id, client_id, job_type, status, idempotency_key, attempts, max_attempts, locked_at)
                  values ($1, $2, 'content_batch', 'processing', 'preso-2', 3, 3, now() - interval '1 hour')`, [ORG_A, clientA]);
  eq((await one(db, `select fail_exhausted_generation_jobs() n`)).n, 1);
  eq((await one(db, `select status from generation_jobs where idempotency_key = 'preso-2'`)).status, "failed");
});

await test("job em processamento recente NÃO é roubado por outro worker", async () => {
  await db.query(`insert into generation_jobs (organization_id, client_id, job_type, status, idempotency_key, attempts, locked_at)
                  values ($1, $2, 'content_batch', 'processing', 'ativo-1', 1, now())`, [ORG_A, clientA]);
  eq((await db.query(`select id from claim_due_generation_jobs('intruso', 5)`)).rows.length, 0);
});

// ===========================================================================
console.log("\n[3] Famílias, códigos e links");

const famA = (await one(db, `insert into content_families (organization_id, client_id, campaign_id, concept, origin) values ($1, $2, $3, 'Quanto custa uma limpeza profissional', 'ai') returning id, code`, [ORG_A, clientA, campA]));
const itemA = await mkItem(db, ORG_A, clientA, campA, { family: famA.id });

const itemACode = (await one(db, `select public_code from content_items where id = $1`, [itemA])).public_code;

await test("família e peça recebem código legível do banco (CF-, C-); código nunca é reaproveitado", async () => {
  eq(famA.code, "CF-00001");
  // C-00001 foi da peça TikTok apagada no teste anterior: o próximo é C-00002, nunca reaproveita.
  eq(itemACode, "C-00002");
});

await test("peça publicada sem data recebe published_at", async () => {
  if (!(await one(db, `select published_at from content_items where id = $1`, [itemA])).published_at) throw new Error("sem published_at");
});

await mustFail("família de um cliente não pode ser ligada a peça de outro cliente", () =>
  mkItem(db, ORG_A, clientA2, campA2, { family: famA.id }), /content_items_family_client_fk/);

const linkA = await one(db, `insert into tracking_links (organization_id, client_id, content_item_id, slug, label, destination_url) values ($1, $2, $3, 'AbCd2345', 'Reel preço', 'https://waithappy.com/quote') returning *`, [ORG_A, clientA, itemA]);

await test("link herda canal, campanha e UTMs da peça", async () => {
  eq(linkA.channel, "instagram");
  eq(linkA.campaign_id, campA);
  eq(`${linkA.utm_source}|${linkA.utm_medium}|${linkA.utm_content}`, `instagram|social|${itemACode}`);
});

await mustFail("link não pode apontar para peça de outro cliente", () =>
  db.query(`insert into tracking_links (organization_id, client_id, content_item_id, slug, label, destination_url) values ($1, $2, $3, 'zzzz9999', 'Link errado', 'https://a.com')`, [ORG_A, clientA2, itemA]),
/tracking_links_item_client_fk/);

await mustFail("destino do link precisa ser https", () =>
  db.query(`insert into tracking_links (organization_id, client_id, slug, label, destination_url) values ($1, $2, 'http0001', 'x', 'http://a.com')`, [ORG_A, clientA]),
/check constraint/);

await mustFail("modo redirect sem destino é recusado", () =>
  db.query(`insert into tracking_links (organization_id, client_id, slug, label, mode) values ($1, $2, 'semdest1', 'x', 'redirect')`, [ORG_A, clientA]),
/check constraint/);

// ===========================================================================
console.log("\n[4] Clique → lead → funil → receita");

const VISITOR = "20000000-0000-4000-8000-0000000000f1";
await db.query(`insert into link_clicks (organization_id, client_id, link_id, visitor_id, device, city, region) values ($1, $2, $3, $4, 'mobile', 'Newton', 'MA')`, [ORG_A, clientA, linkA.id, VISITOR]);
await db.query(`insert into link_clicks (organization_id, client_id, link_id, device, is_bot) values ($1, $2, $3, 'bot', true)`, [ORG_A, clientA, linkA.id]);

await mustFail("clique é append-only", () => db.query(`update link_clicks set city = 'X'`), /append-only/);

const leadA = await one(db, `insert into leads (organization_id, client_id, link_id, visitor_id, source_type, name, phone) values ($1, $2, $3, $4, 'tracked_link', 'Maria', '617-555-0101') returning *`, [ORG_A, clientA, linkA.id, VISITOR]);

await test("lead via link fecha a cadeia: clique, peça, família, campanha, canal, cidade", async () => {
  eq(leadA.lead_code, "LD-00001");
  eq(leadA.attribution, "click");
  if (!leadA.click_id) throw new Error("click_id não ligado");
  eq(leadA.content_item_id, itemA);
  eq(leadA.family_id, famA.id);
  eq(leadA.campaign_id, campA);
  eq(leadA.channel, "instagram");
  eq(`${leadA.city}/${leadA.state}`, "Newton/MA");
});

await test("funil: virar cliente carimba contato, qualificação e conversão", async () => {
  await db.query(`update leads set status = 'customer', revenue = 500 where id = $1`, [leadA.id]);
  const row = await one(db, `select contacted_at, qualified_at, converted_at from leads where id = $1`, [leadA.id]);
  if (!row.contacted_at || !row.qualified_at || !row.converted_at) throw new Error("etapas sem carimbo");
});

await test("deixar de ser cliente remove a conversão (receita não fica inflada)", async () => {
  await db.query(`update leads set status = 'lost' where id = $1`, [leadA.id]);
  const row = await one(db, `select converted_at, lost_at, qualified_at from leads where id = $1`, [leadA.id]);
  if (row.converted_at) throw new Error("converted_at deveria ser nulo");
  if (!row.lost_at || !row.qualified_at) throw new Error("perdido deveria manter qualificação e carimbar perda");
  await db.query(`update leads set status = 'customer' where id = $1`, [leadA.id]);
});

await test("histórico do funil registra cada mudança (append-only)", async () => {
  eq((await one(db, `select count(*)::int n from lead_status_history where lead_id = $1`, [leadA.id])).n, 4);
});

await test("lead manual com 'como nos conheceu' = origem informada; sem nada = desconhecida", async () => {
  const informada = await one(db, `insert into leads (organization_id, client_id, source_type, name, self_reported_source) values ($1, $2, 'manual', 'João', 'vi no Instagram') returning attribution`, [ORG_A, clientA]);
  const nada = await one(db, `insert into leads (organization_id, client_id, source_type, phone) values ($1, $2, 'manual', '555') returning attribution`, [ORG_A, clientA]);
  eq(`${informada.attribution}|${nada.attribution}`, "self_reported|unknown");
});

await mustFail("lead sem nome, e-mail nem telefone é recusado", () =>
  db.query(`insert into leads (organization_id, client_id, source_type) values ($1, $2, 'manual')`, [ORG_A, clientA]), /check constraint/);

// ===========================================================================
console.log("\n[5] Permissões (RLS)");

await test("agência B não enxerga leads, links, cliques nem resultados da A", async () => {
  await asUser(db, U.ownerB, async () => {
    for (const table of ["leads", "tracking_links", "link_clicks", "content_families", "v_content_results", "v_location_results"]) {
      eq((await db.query(`select 1 from ${table}`)).rows.length, 0, `${table}:`);
    }
  });
});

await test("dono da A enxerga os próprios resultados", async () => {
  const rows = await asUser(db, U.ownerA, () => db.query(`select * from v_content_results where content_item_id = $1`, [itemA]));
  eq(rows.rows.length, 1);
});

await mustFail("perfil 'viewer' não registra lead", () =>
  asUser(db, U.viewerA, () => db.query(`insert into leads (organization_id, client_id, source_type, name) values ($1, $2, 'manual', 'x')`, [ORG_A, clientA])),
/row-level security/);

await mustFail("usuário logado não grava clique direto (só a rota pública, pelo servidor)", () =>
  asUser(db, U.ownerA, () => db.query(`insert into link_clicks (organization_id, client_id, link_id) values ($1, $2, $3)`, [ORG_A, clientA, linkA.id])),
/row-level security/);

await mustFail("visitante anônimo não lê leads", () => asAnon(db, () => db.query(`select * from leads`)), /permission denied/);
await mustFail("visitante anônimo não grava lead direto no banco", () =>
  asAnon(db, () => db.query(`insert into leads (organization_id, client_id, source_type, name) values ($1, $2, 'manual', 'x')`, [ORG_A, clientA])),
/permission denied/);

// ===========================================================================
console.log("\n[6] Views de resultado (o banco calcula, nunca a IA)");

await test("CPL, CPA, ROAS e CTR batem com a conta manual", async () => {
  await db.query(`insert into performance_metrics (organization_id, content_item_id, metric_date, impressions, reach, spend) values ($1, $2, current_date - 1, 1000, 800, 100)`, [ORG_A, itemA]);
  for (const name of ["L2", "L3", "L4"]) {
    await db.query(`insert into leads (organization_id, client_id, content_item_id, source_type, name) values ($1, $2, $3, 'manual', $4)`, [ORG_A, clientA, itemA, name]);
  }
  const r = await one(db, `select * from v_content_results where content_item_id = $1`, [itemA]);
  eq(r.tracked_clicks, 1, "cliques (robô fora):");
  eq(r.leads, 4, "leads:");
  eq(r.customers, 1, "clientes:");
  eq(Number(r.revenue), 500, "receita:");
  eq(Number(r.cpl), 25, "CPL 100/4:");
  eq(Number(r.cpa), 100, "CPA 100/1:");
  eq(Number(r.roas), 5, "ROAS 500/100:");
  eq(Number(r.ctr), 0.001, "CTR 1/1000 (clique rastreado, sem clique da plataforma):");
});

await test("sem investimento lançado: CPL/ROAS ficam NULOS (sem dado), não zero", async () => {
  const item = await mkItem(db, ORG_A, clientA, campA, { title: "sem gasto" });
  await db.query(`insert into leads (organization_id, client_id, content_item_id, source_type, name) values ($1, $2, $3, 'manual', 'x')`, [ORG_A, clientA, item]);
  const r = await one(db, `select cpl, roas, ctr from v_content_results where content_item_id = $1`, [item]);
  if (r.cpl !== null || r.roas !== null || r.ctr !== null) throw new Error(`esperava nulos, veio ${JSON.stringify(r)}`);
});

await test("métrica do mesmo dia não duplica (upsert por peça+dia+origem)", async () => {
  await mustFailInner(() => db.query(`insert into performance_metrics (organization_id, content_item_id, metric_date, impressions) values ($1, $2, current_date - 1, 5)`, [ORG_A, itemA]));
});
async function mustFailInner(fn) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error("aceitou métrica duplicada");
}

await test("nota S–F só com amostra: poucas peças medidas = dados insuficientes", async () => {
  const r = await one(db, `select tier from v_content_scores where content_item_id = $1`, [itemA]);
  eq(r.tier, "insufficient_data");
});

await test("com 5+ peças medidas, a que mais gera receita leva a nota mais alta", async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = await mkItem(db, ORG_A, clientA, campA, { title: `peça ${i}` });
    ids.push(id);
    await db.query(`insert into performance_metrics (organization_id, content_item_id, metric_date, impressions) values ($1, $2, current_date - 1, 2000)`, [ORG_A, id]);
    for (let k = 0; k < 3; k++) {
      await db.query(`insert into leads (organization_id, client_id, content_item_id, source_type, name, status, revenue) values ($1, $2, $3, 'manual', 'n', $4, $5)`,
        [ORG_A, clientA, id, k < i ? "customer" : "new", k < i ? 200 * (i + 1) : null]);
    }
  }
  const best = await one(db, `select tier from v_content_scores where content_item_id = $1`, [ids[4]]);
  const worst = await one(db, `select tier from v_content_scores where content_item_id = $1`, [ids[0]]);
  if (!["S", "A"].includes(best.tier)) throw new Error(`melhor peça recebeu ${best.tier}`);
  if (!["D", "F"].includes(worst.tier)) throw new Error(`pior peça recebeu ${worst.tier}`);
});

await test("família soma as peças; geografia junta clique e lead por cidade", async () => {
  const fam = await one(db, `select pieces, leads, customers, revenue from v_family_results where family_id = $1`, [famA.id]);
  eq(`${fam.pieces}|${fam.leads}|${fam.customers}|${Number(fam.revenue)}`, "1|4|1|500");
  const newton = await one(db, `select tracked_clicks, leads from v_location_results where client_id = $1 and city = 'Newton'`, [clientA]);
  eq(`${newton.tracked_clicks}|${newton.leads}`, "1|1");
});

// ===========================================================================
console.log("\n[7] Exclusão");

await test("apagar a peça mantém o lead e a receita (só perde o vínculo)", async () => {
  await db.query(`delete from content_items where id = $1`, [itemA]);
  const lead = await one(db, `select content_item_id, revenue, status from leads where id = $1`, [leadA.id]);
  eq(`${lead.content_item_id}|${Number(lead.revenue)}|${lead.status}`, "null|500|customer");
});

await test("apagar a agência inteira remove tudo dela e nada da outra", async () => {
  await db.query(`delete from organizations where id = $1`, [ORG_A]);
  for (const table of ["clients", "leads", "tracking_links", "link_clicks", "content_families", "lead_status_history"]) {
    eq((await one(db, `select count(*)::int n from ${table} where organization_id = $1`, [ORG_A])).n, 0, `${table}:`);
  }
  eq((await one(db, `select count(*)::int n from clients where organization_id = $1`, [ORG_B])).n, 1, "agência B:");
});

// ===========================================================================
console.log(`\n${"=".repeat(60)}\nBanco: ${passed} passaram · ${failures.length} falharam`);
if (failures.length > 0) {
  failures.forEach((failure) => console.log(`  ✗ ${failure}`));
  process.exit(1);
}
void PGlite;
void pgcrypto;
void campB;
