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
/content_items_campaign_tfk/);

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
  mkItem(db, ORG_A, clientA2, campA2, { family: famA.id }), /content_items_family_tfk/);

const linkA = await one(db, `insert into tracking_links (organization_id, client_id, content_item_id, slug, label, destination_url) values ($1, $2, $3, 'AbCd2345', 'Reel preço', 'https://waithappy.com/quote') returning *`, [ORG_A, clientA, itemA]);

await test("link herda canal, campanha e UTMs da peça", async () => {
  eq(linkA.channel, "instagram");
  eq(linkA.campaign_id, campA);
  eq(`${linkA.utm_source}|${linkA.utm_medium}|${linkA.utm_content}`, `instagram|social|${itemACode}`);
});

await mustFail("link não pode apontar para peça de outro cliente", () =>
  db.query(`insert into tracking_links (organization_id, client_id, content_item_id, slug, label, destination_url) values ($1, $2, $3, 'zzzz9999', 'Link errado', 'https://a.com')`, [ORG_A, clientA2, itemA]),
/tracking_links_item_tfk/);

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
// [8]–[10] Correções da auditoria da branch fase1-medicao. Cada bloco usa um banco
// novo para não depender da ordem dos testes acima.
// ===========================================================================
const PRE = "202607270003_logo_flag.sql";
const stripNotify = (sql) => sql.replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const migration = (prefix) => stripNotify(migrationFiles().find((m) => m.file.startsWith(prefix)).sql);
async function seedChain(d) {
  await seedBase(d);
  const c1 = await mkClient(d, ORG_A, "Cliente 1");
  const c2 = await mkClient(d, ORG_A, "Cliente 2");
  const k1 = await mkCampaign(d, ORG_A, c1);
  const k2 = await mkCampaign(d, ORG_A, c2);
  return { c1, c2, k1, k2 };
}
// Peça no schema ANTERIOR à 0002 (sem family_id).
const mkLegacyItem = async (d, org, client, campaign) =>
  (await one(d, `insert into content_items (organization_id, campaign_id, client_id, title, scheduled_at, channel, format, objective, pillar, status) values ($1, $2, $3, 'legado', now() - interval '3 days', 'instagram', 'reel', 'convert', 'p', 'published') returning id`, [org, campaign, client])).id;
const mkLink = async (d, client, slug, item = null) =>
  (await one(d, `insert into tracking_links (organization_id, client_id, slug, label, mode, content_item_id) values ($1, $2, $3, 'Link', 'form', $4) returning id`, [ORG_A, client, slug, item])).id;
const mkClick = async (d, client, link, extra = {}) =>
  (await one(d, `insert into link_clicks (organization_id, client_id, link_id, visitor_id, ip_hash, is_bot, city, region) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [ORG_A, client, link, extra.visitor ?? null, extra.ip ?? null, extra.bot ?? false, extra.city ?? null, extra.region ?? null])).id;

console.log("\n[8] Esquema: uma FK por par de tabelas (PostgREST PGRST201) e migrations re-executáveis");

await test("nenhum par (filha, pai) do schema public tem mais de uma FK", async () => {
  const d = await bootDb();
  const rows = (await d.query(`
    select c.conrelid::regclass::text as filha, c.confrelid::regclass::text as pai, string_agg(c.conname, ', ' order by c.conname) as fks
      from pg_constraint c
      join pg_class pc on pc.oid = c.confrelid
     where c.contype = 'f' and c.connamespace = 'public'::regnamespace and pc.relnamespace = 'public'::regnamespace
     group by 1, 2
    having count(*) > 1`)).rows;
  if (rows.length) throw new Error(rows.map((r) => `${r.filha}→${r.pai}: ${r.fks}`).join(" | "));
  // E nenhuma FK simples antiga sobrou numa relação que virou composta.
  const simples = (await d.query(`
    select conname from pg_constraint
     where contype = 'f' and connamespace = 'public'::regnamespace
       and conname ~ '_(client_id|campaign_id|contract_id|template_id|content_item_id|research_request_id|link_id|click_id|lead_id|family_id)_fkey$'`)).rows;
  if (simples.length) throw new Error(`FK simples restante: ${simples.map((r) => r.conname).join(", ")}`);
});

await test("as duas migrations novas re-executam sem erro sobre o banco já migrado", async () => {
  const d = await bootDb();
  await seedChain(d);
  const snapshot = `select string_agg(x, E'\n' order by x) s from (
                      select conrelid::regclass || '.' || conname || ' ' || pg_get_constraintdef(oid) x
                        from pg_constraint where connamespace = 'public'::regnamespace) c`;
  const before = (await one(d, snapshot)).s;
  await d.exec(migration("202610060001"));
  await d.exec(migration("202610060002"));
  eq((await one(d, snapshot)).s === before, true, "constraints idênticas após re-executar:");
});

console.log("\n[9] Migração 0001 sobre dados legados");

await test("métricas duplicadas legadas (NULL + 'manual' no mesmo dia; duas NULL no mesmo instante) são deduplicadas e normalizadas", async () => {
  const d = await bootDb({ upTo: PRE });
  const s = await seedChain(d);
  const it = await mkLegacyItem(d, ORG_A, s.c1, s.k1);
  await d.query(`insert into performance_metrics (organization_id, content_item_id, metric_date, impressions, source, created_at) values
      ($1, $2, '2026-09-01', 10, 'manual', '2026-09-02 10:00'), ($1, $2, '2026-09-01', 20, null, '2026-09-02 11:00'),
      ($1, $2, '2026-09-02', 30, null, '2026-09-03 10:00'), ($1, $2, '2026-09-02', 40, null, '2026-09-03 10:00'),
      ($1, $2, '2026-09-03', 50, ' Meta ', '2026-09-04 10:00'), ($1, $2, '2026-09-03', 60, 'meta', '2026-09-04 11:00'),
      ($1, $2, '2026-09-04', 70, 'facebook', '2026-09-05 10:00'), ($1, $2, '2026-09-04', 80, 'TikTok', '2026-09-05 10:00')`, [ORG_A, it]);
  await d.exec(migration("202610060001"));
  const rows = (await d.query(`select metric_date::text d, source, impressions from performance_metrics order by 1, 2`)).rows;
  const got = rows.map((r) => `${r.d}:${r.source}:${r.impressions}`).join(" ");
  const day2 = rows.find((r) => r.d === "2026-09-02");
  eq(rows.length, 5, `linhas (${got}):`);
  eq(rows.filter((r) => r.d === "2026-09-01").map((r) => `${r.source}:${r.impressions}`).join(), "manual:20", "dia 1 (fica a mais recente):");
  if (!["30", "40"].includes(String(day2.impressions)) || day2.source !== "manual") throw new Error(`dia 2: ${got}`);
  eq(rows.filter((r) => r.d === "2026-09-03").map((r) => `${r.source}:${r.impressions}`).join(), "meta:60", "dia 3 (' Meta ' = 'meta'):");
  eq(rows.filter((r) => r.d === "2026-09-04").map((r) => `${r.source}:${r.impressions}`).join(" "), "manual:70 tiktok:80", "dia 4 (fora da lista → manual):");
  await mustFailInner(() => d.query(`insert into performance_metrics (organization_id, content_item_id, metric_date, impressions, source) values ($1, $2, '2026-09-09', 1, 'facebook')`, [ORG_A, it]));
});

await test("pré-verificação cobre TODAS as relações que ganham FK composta (lista amigável, nada aplicado)", async () => {
  const d = await bootDb({ upTo: PRE });
  const s = await seedChain(d);
  const itB = await (async () => {
    const cB = await mkClient(d, ORG_B, "Cliente B");
    const kB = await mkCampaign(d, ORG_B, cB);
    return mkLegacyItem(d, ORG_B, cB, kB);
  })();
  const it1 = await mkLegacyItem(d, ORG_A, s.c1, s.k1);
  // Dados podres que a versão anterior da pré-verificação NÃO listava (caía em erro cru de FK).
  await d.query(`insert into performance_metrics (organization_id, content_item_id, metric_date, source) values ($1, $2, '2026-09-01', 'manual')`, [ORG_A, itB]);
  await d.query(`insert into content_versions (organization_id, content_item_id, version_number, payload) values ($1, $2, 1, '{}')`, [ORG_A, itB]);
  await d.query(`insert into approval_events (organization_id, content_item_id, decision) values ($1, $2, 'approved')`, [ORG_A, itB]);
  await d.query(`insert into workflow_events (organization_id, client_id, action, note) values ($1, $2, 'note', 'x')`, [ORG_B, s.c1]);
  await d.query(`insert into generation_jobs (organization_id, client_id, campaign_id, job_type, idempotency_key) values ($1, $2, $3, 'content_batch', 'legado-x')`, [ORG_A, s.c1, s.k2]);
  const tpl = (await one(d, `insert into contract_templates (organization_id, name) values ($1, 'Modelo B') returning id`, [ORG_B])).id;
  await d.query(`insert into client_contracts (organization_id, client_id, template_id, name, starts_at) values ($1, $2, $3, 'Contrato', '2026-10-01')`, [ORG_A, s.c1, tpl]);
  const req = (await one(d, `insert into market_research_requests (organization_id, business_category, business_type, zip_code, radius_miles) values ($1, 'services', 'cleaning', '02148', 5) returning id`, [ORG_B])).id;
  await d.query(`insert into market_competitors (organization_id, research_request_id, name) values ($1, $2, 'Concorrente')`, [ORG_A, req]);
  void it1;
  let message = "";
  try {
    await d.exec(migration("202610060001"));
  } catch (error) {
    message = error.message;
  }
  for (const marker of ["outra agência", "performance_metrics ", "content_versions ", "approval_events ", "generation_jobs(campanha) ",
    "workflow_events ", "client_contracts(modelo) ", "market_competitors "]) {
    if (!message.includes(marker)) throw new Error(`mensagem sem "${marker}": ${message.slice(0, 600)}`);
  }
  // Transação única: nada ficou aplicado (a FK simples antiga continua lá).
  eq((await one(d, `select count(*)::int n from pg_constraint where conname = 'campaigns_client_id_fkey'`)).n, 1, "nada aplicado:");
});

await test("peça já publicada antes da 0002 recebe published_at = agendamento; editar a legenda não muda a data", async () => {
  const d = await bootDb({ upTo: PRE });
  const s = await seedChain(d);
  const it = (await one(d, `insert into content_items (organization_id, campaign_id, client_id, title, scheduled_at, channel, format, objective, pillar, status, updated_at)
                            values ($1, $2, $3, 't', '2026-01-10 15:00+00', 'instagram', 'reel', 'convert', 'p', 'published', '2026-01-11 09:00+00') returning id`, [ORG_A, s.k1, s.c1])).id;
  const rascunho = (await one(d, `insert into content_items (organization_id, campaign_id, client_id, title, scheduled_at, channel, format, objective, pillar, status)
                                  values ($1, $2, $3, 'r', '2026-01-12', 'instagram', 'reel', 'convert', 'p', 'approved') returning id`, [ORG_A, s.k1, s.c1])).id;
  await d.exec(migration("202610060001"));
  await d.exec(migration("202610060002"));
  const a = await one(d, `select published_at, updated_at, public_code from content_items where id = $1`, [it]);
  eq(new Date(a.published_at).toISOString(), "2026-01-10T15:00:00.000Z", "backfill:");
  eq(new Date(a.updated_at).toISOString(), "2026-01-11T09:00:00.000Z", "backfill não mexe no updated_at:");
  eq(a.public_code, "C-00001");
  await d.query(`update content_items set caption = 'corrige typo' where id = $1`, [it]);
  eq(new Date((await one(d, `select published_at from content_items where id = $1`, [it])).published_at).toISOString(), "2026-01-10T15:00:00.000Z", "após editar:");
  const r0 = await one(d, `select published_at from content_items where id = $1`, [rascunho]);
  if (r0.published_at) throw new Error("rascunho não publicado ganhou published_at");
  await d.query(`update content_items set status = 'published' where id = $1`, [rascunho]);
  if (!(await one(d, `select published_at from content_items where id = $1`, [rascunho])).published_at) throw new Error("transição para published não carimbou");
});

console.log("\n[10] Atribuição, append-only, códigos, views e limite de envios");
const d2 = await bootDb();
const s2 = await seedChain(d2);

await test("códigos C-/CF-/LD- digitados à mão são ignorados (sequência nunca trava) e imutáveis", async () => {
  await asUser(d2, U.ownerA, async () => {
    const ins = (code) => one(d2, `insert into content_items (organization_id, campaign_id, client_id, title, scheduled_at, channel, format, objective, pillar, public_code) values ($1, $2, $3, 't', now(), 'instagram', 'reel', 'convert', 'p', $4) returning id, public_code`, [ORG_A, s2.k1, s2.c1, code]);
    const a = await ins("C-00002");
    const b = await ins(null);
    const c = await ins("QUALQUER");
    eq(`${a.public_code}|${b.public_code}|${c.public_code}`, "C-00001|C-00002|C-00003");
    const f1 = await one(d2, `insert into content_families (organization_id, client_id, concept, code) values ($1, $2, 'conceito um', 'CF-00002') returning id, code`, [ORG_A, s2.c1]);
    const f2 = await one(d2, `insert into content_families (organization_id, client_id, concept) values ($1, $2, 'conceito dois') returning code`, [ORG_A, s2.c1]);
    eq(`${f1.code}|${f2.code}`, "CF-00001|CF-00002");
    const l1 = await one(d2, `insert into leads (organization_id, client_id, source_type, name, lead_code) values ($1, $2, 'manual', 'n', 'LD-00002') returning id, lead_code`, [ORG_A, s2.c1]);
    const l2 = await one(d2, `insert into leads (organization_id, client_id, source_type, name) values ($1, $2, 'manual', 'n') returning lead_code`, [ORG_A, s2.c1]);
    eq(`${l1.lead_code}|${l2.lead_code}`, "LD-00001|LD-00002");
    await d2.query(`update content_items set public_code = 'C-99999' where id = $1`, [a.id]);
    await d2.query(`update content_families set code = 'CF-99999' where id = $1`, [f1.id]);
    await d2.query(`update leads set lead_code = 'LD-99999' where id = $1`, [l1.id]);
    eq((await one(d2, `select public_code from content_items where id = $1`, [a.id])).public_code, "C-00001", "C imutável:");
    eq((await one(d2, `select code from content_families where id = $1`, [f1.id])).code, "CF-00001", "CF imutável:");
    eq((await one(d2, `select lead_code from leads where id = $1`, [l1.id])).lead_code, "LD-00001", "LD imutável:");
  });
});

await mustFail("família não aponta para campanha de OUTRO cliente", () =>
  d2.query(`insert into content_families (organization_id, client_id, campaign_id, concept) values ($1, $2, $3, 'conceito')`, [ORG_A, s2.c1, s2.k2]),
/content_families_campaign_tfk/);

await mustFail("família-mãe precisa ser do MESMO cliente", async () => {
  const mae = (await one(d2, `insert into content_families (organization_id, client_id, concept) values ($1, $2, 'mãe de outro cliente') returning id`, [ORG_A, s2.c2])).id;
  await d2.query(`insert into content_families (organization_id, client_id, parent_family_id, concept) values ($1, $2, $3, 'filha')`, [ORG_A, s2.c1, mae]);
}, /content_families_parent_tfk/);

const itX = await mkItem(d2, ORG_A, s2.c1, s2.k1, { title: "peça X" });
const itY = await mkItem(d2, ORG_A, s2.c1, s2.k1, { title: "peça Y" });
const linkX = await mkLink(d2, s2.c1, "slugX001", itX);
const linkOutro = await mkLink(d2, s2.c2, "slugC2xx");
const clickOutro = await mkClick(d2, s2.c2, linkOutro, { city: "Miami", region: "FL" });
const linkSemPeca = await mkLink(d2, s2.c1, "slugC1xx");

await mustFail("lead não aceita clique de OUTRO cliente", () =>
  d2.query(`insert into leads (organization_id, client_id, source_type, name, link_id, click_id) values ($1, $2, 'tracked_link', 'n', $3, $4)`, [ORG_A, s2.c1, linkSemPeca, clickOutro]),
/leads_click_tfk/);

await mustFail("lead não aceita clique de OUTRO link do mesmo cliente", async () => {
  const outroLink = await mkLink(d2, s2.c1, "slugC1yy");
  const ck = await mkClick(d2, s2.c1, outroLink);
  await d2.query(`insert into leads (organization_id, client_id, source_type, name, link_id, click_id) values ($1, $2, 'tracked_link', 'n', $3, $4)`, [ORG_A, s2.c1, linkSemPeca, ck]);
}, /leads_click_tfk/);

await test("lead com link mas sem clique = 'link_no_click'; peça é SEMPRE a do link", async () => {
  const r = await asUser(d2, U.ownerA, () => one(d2, `insert into leads (organization_id, client_id, source_type, name, link_id, content_item_id) values ($1, $2, 'manual', 'n', $3, $4) returning attribution, content_item_id, click_id`, [ORG_A, s2.c1, linkX, itY]));
  eq(r.attribution, "link_no_click");
  eq(r.content_item_id, itX, "peça do link:");
  eq(r.click_id, null);
});

await test("usuário logado não fabrica prova de clique (click_id e visitante ignorados; 'click' à mão recalculado)", async () => {
  const V = "20000000-0000-4000-8000-0000000000c1";
  const ck = await mkClick(d2, s2.c1, linkX, { visitor: V });
  const r = await asUser(d2, U.ownerA, async () => {
    const lead = await one(d2, `insert into leads (organization_id, client_id, source_type, name, link_id, click_id, visitor_id, attribution) values ($1, $2, 'manual', 'n', $3, $4, $5, 'click') returning id, attribution, click_id`, [ORG_A, s2.c1, linkX, ck, V]);
    const manual = await one(d2, `insert into leads (organization_id, client_id, source_type, name) values ($1, $2, 'manual', 'm') returning id`, [ORG_A, s2.c1]);
    const upd = await one(d2, `update leads set attribution = 'click' where id = $1 returning attribution`, [manual.id]);
    return { lead, upd };
  });
  eq(`${r.lead.attribution}|${r.lead.click_id}`, "link_no_click|null");
  eq(r.upd.attribution, "unknown", "update de attribution:");
});

await mustFail("origem do lead (link) não pode ser trocada depois de gravada", async () => {
  const lead = await one(d2, `insert into leads (organization_id, client_id, source_type, name, link_id) values ($1, $2, 'tracked_link', 'n', $3) returning id`, [ORG_A, s2.c1, linkX]);
  await d2.query(`update leads set link_id = $1 where id = $2`, [linkSemPeca, lead.id]);
}, /não pode ser alterada/);

await test("servidor (rota pública): visitante com clique = 'click'; clique sem link herda o link; peça do link", async () => {
  const V = "20000000-0000-4000-8000-0000000000c2";
  const ck = await mkClick(d2, s2.c1, linkX, { visitor: V, city: "Malden", region: "MA" });
  const a = await one(d2, `insert into leads (organization_id, client_id, source_type, name, link_id, visitor_id) values ($1, $2, 'tracked_link', 'n', $3, $4) returning attribution, click_id, city`, [ORG_A, s2.c1, linkX, V]);
  eq(`${a.attribution}|${a.click_id}|${a.city}`, `click|${ck}|Malden`);
  const b = await one(d2, `insert into leads (organization_id, client_id, source_type, name, click_id) values ($1, $2, 'tracked_link', 'n', $3) returning attribution, link_id, content_item_id`, [ORG_A, s2.c1, ck]);
  eq(`${b.attribution}|${b.link_id}|${b.content_item_id}`, `click|${linkX}|${itX}`);
});

await test("cliques: tracked_clicks = visitantes únicos humanos; raw_clicks = total; lead_rate nunca passa de 100%", async () => {
  const it = await mkItem(d2, ORG_A, s2.c1, s2.k1, { title: "peça K" });
  const l = await mkLink(d2, s2.c1, "slugK001", it);
  const V = "20000000-0000-4000-8000-0000000000c3";
  for (let i = 0; i < 3; i++) await mkClick(d2, s2.c1, l, { visitor: V, city: "Medford", region: "MA" });
  await mkClick(d2, s2.c1, l, { ip: "hash-1", city: "Medford", region: "MA" });
  await mkClick(d2, s2.c1, l, { ip: "hash-1", city: "Medford", region: "MA" });
  await mkClick(d2, s2.c1, l, { bot: true });
  // 4 leads manuais na peça (sem clique) + 2 leads do MESMO visitante via clique.
  for (let k = 0; k < 4; k++) await d2.query(`insert into leads (organization_id, client_id, source_type, name, content_item_id) values ($1, $2, 'manual', 'n', $3)`, [ORG_A, s2.c1, it]);
  for (let k = 0; k < 2; k++) await d2.query(`insert into leads (organization_id, client_id, source_type, name, link_id, visitor_id) values ($1, $2, 'tracked_link', 'n', $3, $4)`, [ORG_A, s2.c1, l, V]);
  const r = await one(d2, `select tracked_clicks, raw_clicks, leads, click_leads, lead_rate from v_content_results where content_item_id = $1`, [it]);
  eq(`${r.tracked_clicks}|${r.raw_clicks}|${r.leads}|${r.click_leads}|${Number(r.lead_rate)}`, "2|5|6|2|0.5");
  const g = await one(d2, `select tracked_clicks, raw_clicks, lead_rate from v_location_results where client_id = $1 and city = 'Medford'`, [s2.c1]);
  eq(`${g.tracked_clicks}|${g.raw_clicks}|${Number(g.lead_rate)}`, "2|5|0.5", "geografia:");
});

await test("métricas: uma origem por (peça, dia) — API vence manual; alcance = maior valor diário (não soma)", async () => {
  const it = await mkItem(d2, ORG_A, s2.c1, s2.k1, { title: "peça M" });
  await d2.query(`insert into performance_metrics (organization_id, content_item_id, metric_date, impressions, reach, spend, source) values
      ($1, $2, current_date - 2, 1000, 800, 50, 'manual'), ($1, $2, current_date - 2, 1100, 900, 55, 'meta'),
      ($1, $2, current_date - 1, 500, 600, 10, 'manual')`, [ORG_A, it]);
  const r = await one(d2, `select impressions, reach, spend, metric_days from v_content_results where content_item_id = $1`, [it]);
  eq(`${r.impressions}|${r.reach}|${Number(r.spend)}|${r.metric_days}`, "1600|900|65|2");
});

await test("nota S–F sem receita: normaliza pelos indicadores com dado (melhor peça pode tirar S)", async () => {
  const c = await mkClient(d2, ORG_A, "Cliente sem receita");
  const k = await mkCampaign(d2, ORG_A, c);
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = await mkItem(d2, ORG_A, c, k, { title: `sr ${i}` });
    ids.push(id);
    await d2.query(`insert into performance_metrics (organization_id, content_item_id, metric_date, impressions, reach, clicks) values ($1, $2, current_date - 1, $3, $4, $5)`, [ORG_A, id, (i + 1) * 2000, (i + 1) * 1500, (i + 1) * 40]);
    for (let n = 0; n <= i; n++) await d2.query(`insert into leads (organization_id, client_id, content_item_id, source_type, name) values ($1, $2, $3, 'manual', 'n')`, [ORG_A, c, id]);
  }
  const best = await one(d2, `select score, tier from v_content_scores where content_item_id = $1`, [ids[4]]);
  eq(`${Number(best.score)}|${best.tier}`, "100|S");
});

await test("nota S–F: sem nenhum indicador de negócio (só alcance/impressões) = dados insuficientes", async () => {
  const c = await mkClient(d2, ORG_A, "Cliente só alcance");
  const k = await mkCampaign(d2, ORG_A, c);
  for (let i = 0; i < 5; i++) {
    const id = await mkItem(d2, ORG_A, c, k, { title: `al ${i}` });
    await d2.query(`insert into performance_metrics (organization_id, content_item_id, metric_date, impressions, reach) values ($1, $2, current_date - 1, $3, $3)`, [ORG_A, id, (i + 1) * 2000]);
  }
  const tiers = (await d2.query(`select distinct tier from v_content_scores where client_id = $1`, [c])).rows.map((r) => r.tier);
  eq(tiers.join(), "insufficient_data");
});

await test("apagar usuário com histórico de funil funciona (actor_id fica gravado, sem FK)", async () => {
  const U2 = "00000000-0000-4000-8000-0000000000a9";
  await d2.exec(`insert into auth.users (id, email) values ('${U2}', 'z@x.com'); insert into organization_members (organization_id, user_id, role) values ('${ORG_A}', '${U2}', 'strategist');`);
  const lead = await asUser(d2, U2, () => one(d2, `insert into leads (organization_id, client_id, source_type, name) values ($1, $2, 'manual', 'n') returning id`, [ORG_A, s2.c1]));
  await d2.query(`delete from auth.users where id = $1`, [U2]);
  eq((await one(d2, `select actor_id from lead_status_history where lead_id = $1`, [lead.id])).actor_id, U2);
});

await mustFail("link com cliques não pode ser apagado (nem pelo manager): desativa-se", () =>
  asUser(d2, U.ownerA, () => d2.query(`delete from tracking_links where id = $1`, [linkX])),
/desative/);

await test("link SEM cliques pode ser apagado pelo manager (o lead perde só o vínculo)", async () => {
  const l = await mkLink(d2, s2.c1, "slugDel01", itX);
  const lead = await one(d2, `insert into leads (organization_id, client_id, source_type, name, link_id) values ($1, $2, 'tracked_link', 'n', $3) returning id`, [ORG_A, s2.c1, l]);
  await asUser(d2, U.ownerA, () => d2.query(`delete from tracking_links where id = $1`, [l]));
  const r = await one(d2, `select link_id, attribution from leads where id = $1`, [lead.id]);
  eq(`${r.link_id}|${r.attribution}`, "null|unknown");
});

await mustFail("clique não pode ser apagado direto (nem pelo service_role)", () =>
  d2.query(`delete from link_clicks where link_id = $1`, [linkX]), /append-only/);

await mustFail("histórico do funil não pode ser apagado direto", () =>
  d2.query(`delete from lead_status_history where organization_id = $1`, [ORG_A]), /append-only/);

await test("apagar o lead (manager) leva o histórico dele junto", async () => {
  const lead = await one(d2, `insert into leads (organization_id, client_id, source_type, name) values ($1, $2, 'manual', 'apagável') returning id`, [ORG_A, s2.c1]);
  await d2.query(`update leads set status = 'contacted' where id = $1`, [lead.id]);
  await asUser(d2, U.ownerA, () => d2.query(`delete from leads where id = $1`, [lead.id]));
  eq((await one(d2, `select count(*)::int n from lead_status_history where lead_id = $1`, [lead.id])).n, 0);
});

await test("limite de envios atômico: consume_rate_limit libera até o máximo e recusa o excedente", async () => {
  const r = [];
  for (let i = 0; i < 4; i++) r.push((await one(d2, `select consume_rate_limit('lead:ip:abc', 600, 3) ok`)).ok);
  eq(r.join(), "true,true,true,false");
  eq((await one(d2, `select consume_rate_limit('lead:ip:outro', 600, 3) ok`)).ok, true, "balde independente:");
  await d2.exec(`set role service_role`);
  try {
    eq((await one(d2, `select consume_rate_limit('lead:link:x', 60, 1) ok`)).ok, true, "service_role executa:");
  } finally {
    await d2.exec(`reset role`);
  }
});

await mustFail("usuário logado não executa consume_rate_limit", () =>
  asUser(d2, U.ownerA, () => d2.query(`select consume_rate_limit('x', 60, 1)`)), /permission denied/);
await mustFail("visitante anônimo não executa consume_rate_limit", () =>
  asAnon(d2, () => d2.query(`select consume_rate_limit('x', 60, 1)`)), /permission denied/);
await mustFail("usuário logado não lê rate_limit_counters", () =>
  asUser(d2, U.ownerA, () => d2.query(`select * from rate_limit_counters`)), /permission denied/);

await test("apagar o cliente com a cadeia completa (família, peça, link, clique, lead, histórico) funciona", async () => {
  const fam = (await one(d2, `insert into content_families (organization_id, client_id, campaign_id, concept) values ($1, $2, $3, 'cadeia completa') returning id`, [ORG_A, s2.c1, s2.k1])).id;
  const it = await mkItem(d2, ORG_A, s2.c1, s2.k1, { title: "cadeia", family: fam });
  const l = await mkLink(d2, s2.c1, "slugFull1", it);
  const V = "20000000-0000-4000-8000-0000000000c9";
  await mkClick(d2, s2.c1, l, { visitor: V });
  const lead = await one(d2, `insert into leads (organization_id, client_id, source_type, name, link_id, visitor_id) values ($1, $2, 'tracked_link', 'n', $3, $4) returning id, attribution, family_id`, [ORG_A, s2.c1, l, V]);
  eq(`${lead.attribution}|${lead.family_id}`, `click|${fam}`, "cadeia montada:");
  await d2.query(`update leads set status = 'customer', revenue = 900 where id = $1`, [lead.id]);
  await asUser(d2, U.ownerA, () => d2.query(`delete from clients where id = $1`, [s2.c1]));
  eq((await one(d2, `select count(*)::int n from clients where id = $1`, [s2.c1])).n, 0, "cliente apagado pelo dono:");
  eq((await one(d2, `select count(*)::int n from lead_status_history where lead_id = $1`, [lead.id])).n, 0, "histórico:");
  for (const table of ["content_families", "content_items", "tracking_links", "link_clicks", "leads"]) {
    eq((await one(d2, `select count(*)::int n from ${table} where client_id = $1`, [s2.c1])).n, 0, `${table}:`);
  }
  eq((await one(d2, `select count(*)::int n from link_clicks where client_id = $1`, [s2.c2])).n, 1, "cliques do outro cliente intactos:");
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
