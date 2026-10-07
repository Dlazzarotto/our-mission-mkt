-- EstratégiaPro CRM — Integridade de tenant + fila de geração
-- Depende de todas as migrations anteriores (202607260001 → 202607270003).
--
-- 1. BRECHA CORRIGIDA: até aqui a RLS conferia apenas o organization_id da PRÓPRIA linha.
--    Um editor da agência B conseguia gravar uma campanha (com organization_id = B)
--    apontando para o client_id de um cliente da agência A. Agora toda relação entre
--    tabelas da agência é uma FK COMPOSTA que inclui organization_id (e client_id quando a
--    tabela filha tem cliente): referência cruzada vira erro do banco, inclusive para o
--    service_role e para bugs.
-- 2. EXATAMENTE UMA FK por par (tabela filha → tabela pai). A FK simples antiga
--    (<tabela>_<coluna>_fkey) é TROCADA pela composta, não somada a ela: o PostgREST
--    recusa o embed (erro PGRST201) quando existe mais de uma FK entre as mesmas tabelas.
--    Coerência de agência + cliente fica numa FK só, ex.:
--      content_items (organization_id, client_id, campaign_id) → campaigns (organization_id, client_id, id)
--    O teste de banco e o scripts/auditoria.py recusam qualquer par com 2+ FKs.
-- 3. organization_id passa a ser imutável em todas as tabelas da agência.
-- 4. Jobs presos em 'processing' (worker caiu no meio) voltam para a fila após 15 min.
-- 5. performance_metrics: source obrigatório e restrito à lista de origens conhecidas
--    ('manual','meta','tiktok','youtube','linkedin','pinterest','google'); duplicatas
--    legadas do mesmo dia/origem são deduplicadas (fica a mais recente).
-- 6. Canais novos: tiktok, youtube, pinterest.
--
-- Migration só-avanço: não altera arquivos já aplicados. Re-executável: toda constraint
-- nova é derrubada com "if exists" antes de ser criada.

-- ============================================================
-- 0. PRÉ-VERIFICAÇÃO — se já existir dado cruzado entre agências (ou entre clientes
--    numa relação que passa a exigir o mesmo cliente), PARA aqui e lista o que precisa
--    ser corrigido (nada é apagado automaticamente). Cobre TODAS as relações que ganham
--    FK composta nesta migration.
-- ============================================================
do $$
declare
  problemas text;
  total integer;
begin
  select string_agg(problema, E'\n' order by problema), count(*) into problemas, total from (
    -- filhos de clients (mesma agência)
              select 'brand_kits ' || x.id || ' → cliente ' || x.client_id as problema from public.brand_kits x join public.clients c on c.id = x.client_id where c.organization_id <> x.organization_id
    union all select 'brand_assets ' || x.id || ' → cliente ' || x.client_id from public.brand_assets x join public.clients c on c.id = x.client_id where c.organization_id <> x.organization_id
    union all select 'client_contracts ' || x.id || ' → cliente ' || x.client_id from public.client_contracts x join public.clients c on c.id = x.client_id where c.organization_id <> x.organization_id
    union all select 'campaigns ' || x.id || ' → cliente ' || x.client_id from public.campaigns x join public.clients c on c.id = x.client_id where c.organization_id <> x.organization_id
    union all select 'content_items ' || x.id || ' → cliente ' || x.client_id from public.content_items x join public.clients c on c.id = x.client_id where c.organization_id <> x.organization_id
    union all select 'generation_jobs ' || x.id || ' → cliente ' || x.client_id from public.generation_jobs x join public.clients c on c.id = x.client_id where c.organization_id <> x.organization_id
    union all select 'strategic_plans ' || x.id || ' → cliente ' || x.client_id from public.strategic_plans x join public.clients c on c.id = x.client_id where c.organization_id <> x.organization_id
    union all select 'client_workflow ' || x.id || ' → cliente ' || x.client_id from public.client_workflow x join public.clients c on c.id = x.client_id where c.organization_id <> x.organization_id
    union all select 'workflow_tasks ' || x.id || ' → cliente ' || x.client_id from public.workflow_tasks x join public.clients c on c.id = x.client_id where c.organization_id <> x.organization_id
    union all select 'workflow_events ' || x.id || ' → cliente ' || x.client_id from public.workflow_events x join public.clients c on c.id = x.client_id where c.organization_id <> x.organization_id
    union all select 'market_research_requests ' || x.id || ' → cliente ' || x.client_id from public.market_research_requests x join public.clients c on c.id = x.client_id where c.organization_id <> x.organization_id
    -- contrato ← modelo de contrato (mesma agência)
    union all select 'client_contracts(modelo) ' || x.id || ' → modelo ' || x.template_id from public.client_contracts x join public.contract_templates t on t.id = x.template_id where t.organization_id <> x.organization_id
    -- campanha ← contrato (mesma agência E mesmo cliente)
    union all select 'campaigns(contrato) ' || x.id || ' → contrato ' || x.contract_id from public.campaigns x join public.client_contracts k on k.id = x.contract_id where k.organization_id <> x.organization_id or k.client_id <> x.client_id
    -- peça ← campanha (mesma agência E mesmo cliente)
    union all select 'content_items(campanha) ' || x.id || ' → campanha ' || x.campaign_id from public.content_items x join public.campaigns k on k.id = x.campaign_id where k.organization_id <> x.organization_id or k.client_id <> x.client_id
    -- filhos de content_items (mesma agência)
    union all select 'content_versions ' || x.id || ' → peça ' || x.content_item_id from public.content_versions x join public.content_items i on i.id = x.content_item_id where i.organization_id <> x.organization_id
    union all select 'approval_events ' || x.id || ' → peça ' || x.content_item_id from public.approval_events x join public.content_items i on i.id = x.content_item_id where i.organization_id <> x.organization_id
    union all select 'performance_metrics ' || x.id || ' → peça ' || x.content_item_id from public.performance_metrics x join public.content_items i on i.id = x.content_item_id where i.organization_id <> x.organization_id
    -- fila de geração ← contrato / campanha (mesma agência E mesmo cliente)
    union all select 'generation_jobs(contrato) ' || x.id || ' → contrato ' || x.contract_id from public.generation_jobs x join public.client_contracts k on k.id = x.contract_id where k.organization_id <> x.organization_id or k.client_id <> x.client_id
    union all select 'generation_jobs(campanha) ' || x.id || ' → campanha ' || x.campaign_id from public.generation_jobs x join public.campaigns k on k.id = x.campaign_id where k.organization_id <> x.organization_id or k.client_id <> x.client_id
    -- filhos da pesquisa de mercado (mesma agência)
    union all select 'market_research_runs ' || x.id || ' → pesquisa ' || x.research_request_id from public.market_research_runs x join public.market_research_requests r on r.id = x.research_request_id where r.organization_id <> x.organization_id
    union all select 'market_competitors ' || x.id || ' → pesquisa ' || x.research_request_id from public.market_competitors x join public.market_research_requests r on r.id = x.research_request_id where r.organization_id <> x.organization_id
    union all select 'market_keywords ' || x.id || ' → pesquisa ' || x.research_request_id from public.market_keywords x join public.market_research_requests r on r.id = x.research_request_id where r.organization_id <> x.organization_id
    union all select 'market_opportunities ' || x.id || ' → pesquisa ' || x.research_request_id from public.market_opportunities x join public.market_research_requests r on r.id = x.research_request_id where r.organization_id <> x.organization_id
  ) p;
  if problemas is not null then
    raise exception 'Existem % registro(s) apontando para outra agência (ou para outro cliente). Nada foi alterado. Corrija antes de aplicar:%',
      total, E'\n' || problemas;
  end if;
end $$;

-- ============================================================
-- 1. Remove as FKs antigas (simples) e as compostas desta migration (re-execução).
--    Cada uma volta abaixo como UMA FK composta por par de tabelas.
-- ============================================================
alter table public.brand_kits               drop constraint if exists brand_kits_client_id_fkey,
                                            drop constraint if exists brand_kits_client_tfk;
alter table public.brand_assets             drop constraint if exists brand_assets_client_id_fkey,
                                            drop constraint if exists brand_assets_client_tfk;
alter table public.client_contracts         drop constraint if exists client_contracts_client_id_fkey,
                                            drop constraint if exists client_contracts_template_id_fkey,
                                            drop constraint if exists client_contracts_client_tfk,
                                            drop constraint if exists client_contracts_template_tfk;
alter table public.campaigns                drop constraint if exists campaigns_client_id_fkey,
                                            drop constraint if exists campaigns_contract_id_fkey,
                                            drop constraint if exists campaigns_client_tfk,
                                            drop constraint if exists campaigns_contract_tfk,
                                            drop constraint if exists campaigns_contract_client_fk;
alter table public.content_items            drop constraint if exists content_items_campaign_id_fkey,
                                            drop constraint if exists content_items_client_id_fkey,
                                            drop constraint if exists content_items_client_tfk,
                                            drop constraint if exists content_items_campaign_tfk,
                                            drop constraint if exists content_items_campaign_client_fk;
alter table public.content_versions         drop constraint if exists content_versions_content_item_id_fkey,
                                            drop constraint if exists content_versions_item_tfk;
alter table public.approval_events          drop constraint if exists approval_events_content_item_id_fkey,
                                            drop constraint if exists approval_events_item_tfk;
alter table public.performance_metrics      drop constraint if exists performance_metrics_content_item_id_fkey,
                                            drop constraint if exists performance_metrics_item_tfk;
alter table public.generation_jobs          drop constraint if exists generation_jobs_client_id_fkey,
                                            drop constraint if exists generation_jobs_contract_id_fkey,
                                            drop constraint if exists generation_jobs_campaign_id_fkey,
                                            drop constraint if exists generation_jobs_client_tfk,
                                            drop constraint if exists generation_jobs_contract_tfk,
                                            drop constraint if exists generation_jobs_campaign_tfk;
alter table public.market_research_requests drop constraint if exists market_research_requests_client_id_fkey,
                                            drop constraint if exists market_research_requests_client_tfk;
alter table public.market_research_runs     drop constraint if exists market_research_runs_research_request_id_fkey,
                                            drop constraint if exists market_research_runs_request_tfk;
alter table public.market_competitors       drop constraint if exists market_competitors_research_request_id_fkey,
                                            drop constraint if exists market_competitors_request_tfk;
alter table public.market_keywords          drop constraint if exists market_keywords_research_request_id_fkey,
                                            drop constraint if exists market_keywords_request_tfk;
alter table public.market_opportunities     drop constraint if exists market_opportunities_research_request_id_fkey,
                                            drop constraint if exists market_opportunities_request_tfk;
alter table public.strategic_plans          drop constraint if exists strategic_plans_client_id_fkey,
                                            drop constraint if exists strategic_plans_client_tfk;
alter table public.client_workflow          drop constraint if exists client_workflow_client_id_fkey,
                                            drop constraint if exists client_workflow_client_tfk;
alter table public.workflow_tasks           drop constraint if exists workflow_tasks_client_id_fkey,
                                            drop constraint if exists workflow_tasks_client_tfk;
alter table public.workflow_events          drop constraint if exists workflow_events_client_id_fkey,
                                            drop constraint if exists workflow_events_client_tfk;

-- O nome prometia "organização bate com o cliente", mas só verificava "não nulo".
alter table public.brand_kits drop constraint if exists brand_kits_organization_matches_client;

-- ============================================================
-- 2. CHAVES-ALVO nas tabelas referenciadas
--    (organization_id, id)            → filhos sem client_id
--    (organization_id, client_id, id) → filhos com client_id: agência E cliente na mesma FK
-- ============================================================
do $$
declare
  k record;
begin
  for k in
    select * from (values
      ('clients',                  'clients_org_id_uq',                  'organization_id, id'),
      ('contract_templates',       'contract_templates_org_id_uq',       'organization_id, id'),
      ('client_contracts',         'client_contracts_org_client_id_uq',  'organization_id, client_id, id'),
      ('campaigns',                'campaigns_org_client_id_uq',         'organization_id, client_id, id'),
      ('content_items',            'content_items_org_id_uq',            'organization_id, id'),
      ('market_research_requests', 'market_research_requests_org_id_uq', 'organization_id, id')
    ) as v(tabela, nome, colunas)
  loop
    if not exists (
      select 1 from pg_constraint
       where conrelid = format('public.%I', k.tabela)::regclass and conname = k.nome
    ) then
      execute format('alter table public.%I add constraint %I unique (%s)', k.tabela, k.nome, k.colunas);
    end if;
  end loop;
end $$;

-- ============================================================
-- 3. FKs COMPOSTAS — uma por par (filha, pai); mesma ação de exclusão das FKs antigas
-- ============================================================
alter table public.brand_kits       add constraint brand_kits_client_tfk       foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade;
alter table public.brand_assets     add constraint brand_assets_client_tfk     foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade;
alter table public.client_contracts add constraint client_contracts_client_tfk foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade;
alter table public.client_contracts add constraint client_contracts_template_tfk foreign key (organization_id, template_id) references public.contract_templates (organization_id, id) on delete set null (template_id);

alter table public.campaigns add constraint campaigns_client_tfk   foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade;
-- Contrato da MESMA agência e do MESMO cliente.
alter table public.campaigns add constraint campaigns_contract_tfk foreign key (organization_id, client_id, contract_id) references public.client_contracts (organization_id, client_id, id) on delete set null (contract_id);

alter table public.content_items add constraint content_items_client_tfk   foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade;
-- Campanha da MESMA agência e do MESMO cliente.
alter table public.content_items add constraint content_items_campaign_tfk foreign key (organization_id, client_id, campaign_id) references public.campaigns (organization_id, client_id, id) on delete cascade;

alter table public.content_versions    add constraint content_versions_item_tfk    foreign key (organization_id, content_item_id) references public.content_items (organization_id, id) on delete cascade;
alter table public.approval_events     add constraint approval_events_item_tfk     foreign key (organization_id, content_item_id) references public.content_items (organization_id, id) on delete cascade;
alter table public.performance_metrics add constraint performance_metrics_item_tfk foreign key (organization_id, content_item_id) references public.content_items (organization_id, id) on delete cascade;

alter table public.generation_jobs add constraint generation_jobs_client_tfk   foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade;
alter table public.generation_jobs add constraint generation_jobs_contract_tfk foreign key (organization_id, client_id, contract_id) references public.client_contracts (organization_id, client_id, id) on delete set null (contract_id);
alter table public.generation_jobs add constraint generation_jobs_campaign_tfk foreign key (organization_id, client_id, campaign_id) references public.campaigns (organization_id, client_id, id) on delete set null (campaign_id);

alter table public.market_research_requests add constraint market_research_requests_client_tfk foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete set null (client_id);
alter table public.market_research_runs  add constraint market_research_runs_request_tfk  foreign key (organization_id, research_request_id) references public.market_research_requests (organization_id, id) on delete cascade;
alter table public.market_competitors    add constraint market_competitors_request_tfk    foreign key (organization_id, research_request_id) references public.market_research_requests (organization_id, id) on delete cascade;
alter table public.market_keywords       add constraint market_keywords_request_tfk       foreign key (organization_id, research_request_id) references public.market_research_requests (organization_id, id) on delete cascade;
alter table public.market_opportunities  add constraint market_opportunities_request_tfk  foreign key (organization_id, research_request_id) references public.market_research_requests (organization_id, id) on delete cascade;

alter table public.strategic_plans add constraint strategic_plans_client_tfk foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade;
alter table public.client_workflow add constraint client_workflow_client_tfk foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade;
alter table public.workflow_tasks  add constraint workflow_tasks_client_tfk  foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade;
alter table public.workflow_events add constraint workflow_events_client_tfk foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade;

-- Índices de apoio para as FKs que não começam pela mesma coluna de um índice existente.
create index if not exists content_versions_item_idx    on public.content_versions(content_item_id);
create index if not exists approval_events_item_idx     on public.approval_events(content_item_id);
create index if not exists generation_jobs_campaign_idx on public.generation_jobs(campaign_id) where campaign_id is not null;
create index if not exists campaigns_contract_idx       on public.campaigns(contract_id) where contract_id is not null;

-- ============================================================
-- 4. organization_id IMUTÁVEL em toda tabela da agência
-- ============================================================
create or replace function public.lock_organization_id()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'organization_id não pode ser alterado (%.%)', tg_table_name, old.id using errcode = '42501';
  end if;
  return new;
end;
$$;

do $$
declare
  t record;
begin
  for t in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables tb
      on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
    join information_schema.columns i
      on i.table_schema = c.table_schema and i.table_name = c.table_name and i.column_name = 'id'
    where c.table_schema = 'public' and c.column_name = 'organization_id'
  loop
    execute format('drop trigger if exists lock_organization_id on public.%I', t.table_name);
    execute format('create trigger lock_organization_id before update on public.%I for each row execute function public.lock_organization_id()', t.table_name);
  end loop;
end $$;

-- ============================================================
-- 5. FILA: jobs presos em 'processing' voltam a ser elegíveis após 15 min
-- ============================================================
create or replace function public.claim_due_generation_jobs(
  worker_name text,
  maximum_jobs integer default 5
)
returns setof public.generation_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidates as (
    select id
    from public.generation_jobs
    where attempts < max_attempts
      and (
        (status = 'queued' and scheduled_for <= now())
        -- Worker morreu no meio (timeout da função, deploy): o job não fica preso para sempre.
        or (status = 'processing' and locked_at < now() - interval '15 minutes')
      )
    order by scheduled_for asc
    limit greatest(1, least(maximum_jobs, 20))
    for update skip locked
  )
  update public.generation_jobs job
  set status = 'processing',
      attempts = job.attempts + 1,
      locked_at = now(),
      locked_by = worker_name
  from candidates
  where job.id = candidates.id
  returning job.*;
end;
$$;

-- Job preso que já gastou todas as tentativas vira 'failed' (visível), em vez de sumir.
create or replace function public.fail_exhausted_generation_jobs()
returns integer
language sql
security definer
set search_path = public
as $$
  with falhos as (
    update public.generation_jobs
       set status = 'failed',
           locked_at = null,
           locked_by = null,
           error_message = coalesce(error_message, 'Tentativas esgotadas: o worker não concluiu o job.')
     where status = 'processing'
       and locked_at < now() - interval '15 minutes'
       and attempts >= max_attempts
    returning 1
  )
  select count(*)::integer from falhos;
$$;

revoke all on function public.claim_due_generation_jobs(text, integer) from public, anon, authenticated;
grant execute on function public.claim_due_generation_jobs(text, integer) to service_role;
revoke all on function public.fail_exhausted_generation_jobs() from public, anon, authenticated;
grant execute on function public.fail_exhausted_generation_jobs() to service_role;

-- ============================================================
-- 6. performance_metrics: source obrigatório e de uma lista fechada
--    Origens válidas (a aplicação usa exatamente esta lista):
--      'manual','meta','tiktok','youtube','linkedin','pinterest','google'
--    Legado: lower(trim(source)); nulo, vazio ou fora da lista → 'manual'.
--    Depois de normalizar, (peça, dia, origem) pode repetir (ex.: NULL + 'manual' no mesmo
--    dia, ou duas NULL gravadas na mesma transação): fica só a linha mais recente.
-- ============================================================
alter table public.performance_metrics drop constraint if exists performance_metrics_source_check;

with normalizadas as (
  select id,
         row_number() over (
           partition by content_item_id, metric_date,
             case when lower(trim(source)) in ('manual', 'meta', 'tiktok', 'youtube', 'linkedin', 'pinterest', 'google')
                  then lower(trim(source)) else 'manual' end
           order by created_at desc, id desc
         ) as posicao
    from public.performance_metrics
)
delete from public.performance_metrics p
 using normalizadas n
 where p.id = n.id and n.posicao > 1;

update public.performance_metrics
   set source = case when lower(trim(source)) in ('manual', 'meta', 'tiktok', 'youtube', 'linkedin', 'pinterest', 'google')
                     then lower(trim(source)) else 'manual' end
 where source is null
    or source is distinct from (case when lower(trim(source)) in ('manual', 'meta', 'tiktok', 'youtube', 'linkedin', 'pinterest', 'google')
                                     then lower(trim(source)) else 'manual' end);

alter table public.performance_metrics alter column source set default 'manual';
alter table public.performance_metrics alter column source set not null;
alter table public.performance_metrics add constraint performance_metrics_source_check
  check (source in ('manual', 'meta', 'tiktok', 'youtube', 'linkedin', 'pinterest', 'google'));

-- ============================================================
-- 7. CANAIS NOVOS
-- ============================================================
alter type public.content_channel add value if not exists 'tiktok';
alter type public.content_channel add value if not exists 'youtube';
alter type public.content_channel add value if not exists 'pinterest';

notify pgrst, 'reload schema';
