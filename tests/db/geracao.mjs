// Testes do banco (PGlite) da GERAÇÃO TRANSACIONAL — migration 202610060003.
//   complete_generation_job(): sucesso, nova tentativa idempotente, job de outro worker,
//   atomicidade (erro no meio não deixa campanha órfã), isolamento entre agências.
//   claim_due_generation_jobs(): no máximo um job por cliente, nunca cliente em andamento.
// Rodar:  node tests/db/geracao.mjs   (ou pnpm test:db)
import { asUser, bootDb } from "./harness.mjs";

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
async function expectError(fn, pattern, context = "") {
  try {
    await fn();
  } catch (error) {
    if (pattern && !pattern.test(error.message)) throw new Error(`${context} erro inesperado: ${error.message}`);
    return error;
  }
  throw new Error(`${context} esperava erro, mas passou`);
}
function eq(actual, expected, context = "") {
  if (String(actual) !== String(expected)) throw new Error(`${context} esperado=${expected} obtido=${actual}`);
}

const U = { ownerA: "00000000-0000-4000-8000-0000000000a1", ownerB: "00000000-0000-4000-8000-0000000000b1" };
const ORG_A = "10000000-0000-4000-8000-00000000000a";
const ORG_B = "10000000-0000-4000-8000-00000000000b";

console.log("\n[G0] Migrations");
let db;
await test("todas as migrations (incluindo 202610060003) aplicam do zero", async () => {
  db = await bootDb();
});
if (!db) {
  console.log("\nSem banco — abortando.");
  process.exit(1);
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const count = async (sql, params) => Number((await one(sql, params)).n);

await db.exec(`
  insert into auth.users (id, email) values ('${U.ownerA}', 'a@x.com'), ('${U.ownerB}', 'b@x.com');
  insert into public.organizations (id, name) values ('${ORG_A}', 'Agência A'), ('${ORG_B}', 'Agência B');
  insert into public.organization_members (organization_id, user_id, role) values ('${ORG_A}', '${U.ownerA}', 'owner'), ('${ORG_B}', '${U.ownerB}', 'owner');
`);
async function mkClient(org, name) {
  return (await one(`insert into clients (organization_id, company_name, industry, service, region) values ($1, $2, 'Limpeza', 'Residencial', 'Boston, MA') returning id`, [org, name])).id;
}
async function mkContract(org, client) {
  return (await one(`insert into client_contracts (organization_id, client_id, name, starts_at, next_generation_at) values ($1, $2, 'Contrato', '2026-10-01', now() + interval '30 days') returning id`, [org, client])).id;
}
let seq = 0;
async function mkJob(org, client, contract, extra = {}) {
  seq++;
  return (await one(
    `insert into generation_jobs (organization_id, client_id, contract_id, job_type, status, idempotency_key, scheduled_for, attempts, locked_at, locked_by)
     values ($1, $2, $3, 'content_batch', $4, $5, now() - interval '1 minute', $6, $7, $8) returning id`,
    [org, client, contract, extra.status ?? "queued", `geracao-${seq}`, extra.attempts ?? 0, extra.lockedAt ?? null, extra.lockedBy ?? null],
  )).id;
}
const campaignPayload = (contract) => ({
  contract_id: contract,
  name: "Outubro — limpeza de outono",
  goal: "Gerar orçamentos de limpeza residencial",
  summary: "Lote semanal",
  starts_at: "2026-10-05",
  ends_at: "2026-10-11",
});
const item = (over = {}) => ({
  concept: "Quanto custa uma limpeza profissional",
  title: "Quanto custa limpar sua casa",
  scheduled_at: "2026-10-06T14:00:00Z",
  channel: "instagram",
  format: "reel",
  objective: "convert",
  pillar: "Preço",
  caption: "Descubra quanto custa uma limpeza profissional em Boston.",
  hashtags: ["#boston", "#cleaning"],
  hook: "Você sabe quanto custa?",
  cta: "Peça seu orçamento",
  variant_label: "instagram · reel",
  creative_brief: "Vídeo curto mostrando antes e depois.",
  image_prompt: "",
  video_script: "Cena 1...",
  ...over,
});
const complete = (job, worker, contract, items, result = { period: { startsAt: "2026-10-05" } }) =>
  one(`select complete_generation_job($1, $2, $3::jsonb, $4::jsonb, $5::jsonb) r`, [
    job, worker, JSON.stringify(campaignPayload(contract)), JSON.stringify(items), JSON.stringify(result),
  ]).then((row) => row.r);

const clientA = await mkClient(ORG_A, "Wait Happy Cleaning");
const clientA2 = await mkClient(ORG_A, "Outro cliente da A");
const clientB = await mkClient(ORG_B, "Cliente da B");
const contractA = await mkContract(ORG_A, clientA);
const contractA2 = await mkContract(ORG_A, clientA2);
const contractB = await mkContract(ORG_B, clientB);

// ===========================================================================
console.log("\n[G1] complete_generation_job — sucesso e idempotência");

const jobOk = await mkJob(ORG_A, clientA, contractA);
await test("worker reserva o job e conclui: campanha + famílias + peças + job 'completed' numa transação", async () => {
  const claimed = (await db.query(`select id, locked_by from claim_due_generation_jobs('w1', 5)`)).rows;
  eq(claimed.length, 1, "reservados:");
  eq(claimed[0].id, jobOk, "job:");
  const r = await complete(jobOk, "w1", contractA, [
    item(),
    item({ channel: "facebook", format: "photo", concept: "  quanto custa uma   LIMPEZA profissional " }),
    item({ concept: "Checklist de mudança", title: "Checklist para mudança" }),
  ]);
  eq(r.already_completed, false, "already_completed:");
  eq(r.items_count, 3, "peças:");
  eq(r.families_count, 2, "famílias (mesmo conceito com caixa/espaços diferentes = 1):");
  const job = await one(`select status, campaign_id, locked_by, locked_at, completed_at, result from generation_jobs where id = $1`, [jobOk]);
  eq(job.status, "completed");
  eq(job.campaign_id, r.campaign_id, "job.campaign_id:");
  eq(job.locked_by, null, "locked_by liberado:");
  eq(job.result.items_count, 3, "result.items_count:");
  eq(job.result.period.startsAt, "2026-10-05", "result extra preservado:");
  const camp = await one(`select organization_id, client_id, contract_id, status, generation_job_id, starts_at::text s from campaigns where id = $1`, [r.campaign_id]);
  eq(`${camp.organization_id}|${camp.client_id}|${camp.contract_id}|${camp.status}|${camp.generation_job_id}|${camp.s}`,
    `${ORG_A}|${clientA}|${contractA}|in_review|${jobOk}|2026-10-05`);
  const items = (await db.query(`select ci.public_code, ci.status, ci.hook, ci.image_prompt, ci.generated_by_ai, f.code, f.concept
                                   from content_items ci left join content_families f on f.id = ci.family_id
                                  where ci.campaign_id = $1 order by ci.created_at, ci.public_code`, [r.campaign_id])).rows;
  eq(items.length, 3);
  for (const row of items) {
    if (!/^C-\d{5}$/.test(row.public_code)) throw new Error(`código de peça ${row.public_code}`);
    if (!/^CF-\d{5}$/.test(row.code ?? "")) throw new Error(`peça sem família: ${row.code}`);
    eq(row.status, "review", "status da peça:");
    eq(row.generated_by_ai, true);
    eq(row.image_prompt, null, "string vazia vira null:");
  }
  eq(new Set(items.map((row) => row.code)).size, 2, "famílias distintas nas peças:");
});

await test("nova tentativa do MESMO job não grava de novo (idempotente)", async () => {
  const before = await count(`select count(*) n from content_items`);
  const r = await complete(jobOk, "w1", contractA, [item(), item()]);
  eq(r.already_completed, true, "already_completed:");
  eq(r.items_count, 3, "devolve o resultado original:");
  eq(await count(`select count(*) n from campaigns where generation_job_id = $1`, [jobOk]), 1, "campanhas do job:");
  eq(await count(`select count(*) n from content_items`), before, "peças:");
});

await test("job já concluído chamado por OUTRO worker também não duplica", async () => {
  const r = await complete(jobOk, "w-atrasado", contractA, [item()]);
  eq(r.already_completed, true);
  eq(await count(`select count(*) n from campaigns where generation_job_id = $1`, [jobOk]), 1);
});

// ===========================================================================
console.log("\n[G2] Dono do job (locked_by)");

await test("worker que NÃO detém o job não conclui e não grava nada", async () => {
  const job = await mkJob(ORG_A, clientA2, contractA2, { status: "processing", attempts: 1, lockedAt: new Date().toISOString(), lockedBy: "w-dono" });
  const campaigns = await count(`select count(*) n from campaigns`);
  await expectError(() => complete(job, "w-intruso", contractA2, [item()]), /não está reservado/);
  eq(await count(`select count(*) n from campaigns`), campaigns, "campanhas:");
  eq((await one(`select status from generation_jobs where id = $1`, [job])).status, "processing", "status:");
  // O dono conclui normalmente.
  const r = await complete(job, "w-dono", contractA2, [item()]);
  eq(r.items_count, 1);
});

await test("worker atrasado (job reassumido após 15 min por outro) é recusado; o novo dono conclui", async () => {
  const job = await mkJob(ORG_A, clientA2, contractA2, { status: "processing", attempts: 1, lockedAt: new Date(Date.now() - 20 * 60e3).toISOString(), lockedBy: "w-lento" });
  const claimed = (await db.query(`select id, locked_by from claim_due_generation_jobs('w-novo', 5)`)).rows;
  eq(claimed.map((j) => j.id).join(), job, "reassumido:");
  await expectError(() => complete(job, "w-lento", contractA2, [item()]), /não está reservado/, "worker lento:");
  const r = await complete(job, "w-novo", contractA2, [item()]);
  eq(r.already_completed, false);
  eq(await count(`select count(*) n from campaigns where generation_job_id = $1`, [job]), 1);
});

await test("job 'queued' (não reservado) não pode ser concluído", async () => {
  const job = await mkJob(ORG_A, clientA2, contractA2);
  await expectError(() => complete(job, "w1", contractA2, [item()]), /não está reservado/);
  await db.query(`delete from generation_jobs where id = $1`, [job]);
});

// ===========================================================================
console.log("\n[G3] Atomicidade");

await test("erro no meio (peça inválida) desfaz tudo: sem campanha nem família órfã", async () => {
  const job = await mkJob(ORG_A, clientA2, contractA2, { status: "processing", attempts: 1, lockedAt: new Date().toISOString(), lockedBy: "w1" });
  const before = await one(`select (select count(*) from campaigns) c, (select count(*) from content_families) f, (select count(*) from content_items) i`);
  await expectError(() => complete(job, "w1", contractA2, [item(), item({ channel: "orkut" })]), /content_channel/);
  const after = await one(`select (select count(*) from campaigns) c, (select count(*) from content_families) f, (select count(*) from content_items) i`);
  eq(`${after.c}|${after.f}|${after.i}`, `${before.c}|${before.f}|${before.i}`, "contagens:");
  eq((await one(`select status, locked_by from generation_jobs where id = $1`, [job])).status, "processing", "job intacto:");
  // Nova tentativa válida do mesmo job grava uma vez só.
  eq((await complete(job, "w1", contractA2, [item()])).items_count, 1);
});

await test("lote vazio é recusado", async () => {
  const job = await mkJob(ORG_A, clientA2, contractA2, { status: "processing", attempts: 1, lockedAt: new Date().toISOString(), lockedBy: "w1" });
  await expectError(() => complete(job, "w1", contractA2, []), /sem peças/);
  await db.query(`update generation_jobs set status = 'cancelled', locked_by = null where id = $1`, [job]);
});

await test("conceito curto/vazio não cria família (check do banco) e a peça entra sem família", async () => {
  const job = await mkJob(ORG_A, clientA2, contractA2, { status: "processing", attempts: 1, lockedAt: new Date().toISOString(), lockedBy: "w1" });
  const r = await complete(job, "w1", contractA2, [item({ concept: " x " }), item({ concept: "" })]);
  eq(`${r.items_count}|${r.families_count}`, "2|0");
  eq(await count(`select count(*) n from content_items where campaign_id = $1 and family_id is null`, [r.campaign_id]), 2);
});

// ===========================================================================
console.log("\n[G4] Isolamento entre agências");

await test("organização e cliente vêm do JOB, nunca do payload", async () => {
  const job = await mkJob(ORG_B, clientB, contractB, { status: "processing", attempts: 1, lockedAt: new Date().toISOString(), lockedBy: "w1" });
  const r = await complete(job, "w1", contractB, [item({ organization_id: ORG_A, client_id: clientA })]);
  const row = await one(`select c.organization_id, c.client_id, (select count(*) from content_items i where i.campaign_id = c.id and i.organization_id = $2) n
                           from campaigns c where c.id = $1`, [r.campaign_id, ORG_B]);
  eq(`${row.organization_id}|${row.client_id}|${row.n}`, `${ORG_B}|${clientB}|1`);
});

await test("contrato de OUTRA agência no payload é barrado pela FK composta e nada é gravado", async () => {
  const job = await mkJob(ORG_B, clientB, contractB, { status: "processing", attempts: 1, lockedAt: new Date().toISOString(), lockedBy: "w1" });
  const campaigns = await count(`select count(*) n from campaigns`);
  await expectError(() => complete(job, "w1", contractA, [item()]), /foreign key/);
  eq(await count(`select count(*) n from campaigns`), campaigns, "campanhas:");
  await db.query(`update generation_jobs set status = 'cancelled', locked_by = null where id = $1`, [job]);
});

await test("usuário logado (nem dono da agência) NÃO executa complete_generation_job nem claim", async () => {
  const job = await mkJob(ORG_A, clientA, contractA, { status: "processing", attempts: 1, lockedAt: new Date().toISOString(), lockedBy: "w1" });
  await expectError(() => asUser(db, U.ownerA, () => complete(job, "w1", contractA, [item()])), /permission denied/);
  await expectError(() => asUser(db, U.ownerB, () => db.query(`select * from claim_due_generation_jobs('x', 5)`)), /permission denied/);
  await db.query(`update generation_jobs set status = 'cancelled', locked_by = null where id = $1`, [job]);
});

await test("generation_job_id é único: duas campanhas não podem apontar para o mesmo job", async () => {
  await expectError(
    () => db.query(`insert into campaigns (organization_id, client_id, name, goal, starts_at, ends_at, generation_job_id) values ($1, $2, 'dup', 'meta duplicada', '2026-10-01', '2026-10-07', $3)`, [ORG_A, clientA, jobOk]),
    /campaigns_generation_job_uq/,
  );
});

await test("contrato do schema: no máximo UMA foreign key entre campaigns e generation_jobs (embed do PostgREST)", async () => {
  const n = await count(`
    select count(*) n from pg_constraint
     where contype = 'f'
       and ((conrelid = 'public.campaigns'::regclass and confrelid = 'public.generation_jobs'::regclass)
         or (conrelid = 'public.generation_jobs'::regclass and confrelid = 'public.campaigns'::regclass))
       and not exists (select 1 from pg_attribute a where a.attrelid = conrelid and a.attnum = any(conkey) and a.attname = 'organization_id')`);
  if (n > 1) throw new Error(`${n} FKs de relação entre campaigns e generation_jobs`);
  const reverse = await count(`select count(*) n from pg_constraint where contype = 'f' and conrelid = 'public.campaigns'::regclass and confrelid = 'public.generation_jobs'::regclass`);
  eq(reverse, 0, "FK de campaigns → generation_jobs:");
});

// ===========================================================================
console.log("\n[G5] Reserva serializada por cliente");

await test("dois jobs do MESMO cliente: só um é reservado por vez; outro cliente segue normalmente", async () => {
  await db.query(`update generation_jobs set status = 'cancelled', locked_by = null where status in ('queued', 'processing')`);
  const j1 = await mkJob(ORG_A, clientA, contractA);
  const j2 = await mkJob(ORG_A, clientA, contractA);
  const j3 = await mkJob(ORG_B, clientB, contractB);
  const first = (await db.query(`select id, client_id from claim_due_generation_jobs('w1', 5)`)).rows;
  eq(first.length, 2, "1ª reserva (um por cliente):");
  if (!first.some((j) => j.id === j3)) throw new Error("job do outro cliente não foi reservado");
  const fromA = first.find((j) => j.client_id === clientA);
  eq(fromA.id, j1, "o mais antigo do cliente vem primeiro:");
  eq((await db.query(`select id from claim_due_generation_jobs('w2', 5)`)).rows.length, 0, "2ª reserva com o cliente em andamento:");
  await complete(j1, "w1", contractA, [item()]);
  const third = (await db.query(`select id from claim_due_generation_jobs('w2', 5)`)).rows;
  eq(third.map((j) => j.id).join(), j2, "depois que o 1º termina:");
});

await test("job travado há mais de 15 min não bloqueia o cliente (é reassumido)", async () => {
  await db.query(`update generation_jobs set status = 'cancelled', locked_by = null where status in ('queued', 'processing')`);
  const stuck = await mkJob(ORG_A, clientA2, contractA2, { status: "processing", attempts: 1, lockedAt: new Date(Date.now() - 30 * 60e3).toISOString(), lockedBy: "w-morto" });
  const claimed = (await db.query(`select id, attempts from claim_due_generation_jobs('w3', 5)`)).rows;
  eq(claimed.map((j) => `${j.id}:${j.attempts}`).join(), `${stuck}:2`);
});

await test("lote 'failed' ou 'cancelled' sem campanha volta para a fila (nova tentativa); o resto não", async () => {
  const failed = await mkJob(ORG_A, clientA, contractA, { status: "failed", attempts: 3 });
  const cancelled = await mkJob(ORG_A, clientA, contractA, { status: "cancelled" });
  const requeue = (job, user) => asUser(db, user, () => one(`select requeue_generation_job($1) as id`, [job]));
  eq((await requeue(failed, U.ownerA)).id, failed, "failed:");
  const f = await one(`select status, attempts, error_message from generation_jobs where id = $1`, [failed]);
  eq(`${f.status}|${f.attempts}|${f.error_message}`, "queued|0|null");
  eq((await requeue(cancelled, U.ownerA)).id, cancelled, "cancelled:");
  // Job concluído (com campanha) não é reaberto.
  eq((await requeue(jobOk, U.ownerA)).id, null, "completed:");
  // Outra agência não reenfileira.
  const other = await mkJob(ORG_A, clientA, contractA, { status: "failed", attempts: 3 });
  await expectError(() => requeue(other, U.ownerB), /sem permissão/, "agência B:");
  eq((await one(`select status from generation_jobs where id = $1`, [other])).status, "failed", "intacto:");
});

// ===========================================================================
console.log(`\n${"=".repeat(60)}\nGeração: ${passed} passaram · ${failures.length} falharam`);
if (failures.length > 0) {
  failures.forEach((failure) => console.log(`  ✗ ${failure}`));
  process.exit(1);
}
