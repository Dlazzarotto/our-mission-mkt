-- EstratégiaPro CRM — Integridade de tenant + fila de geração
-- Depende de todas as migrations anteriores (202607260001 → 202607270003).
--
-- 1. BRECHA CORRIGIDA: até aqui a RLS conferia apenas o organization_id da PRÓPRIA linha.
--    Um editor da agência B conseguia gravar uma campanha (com organization_id = B)
--    apontando para o client_id de um cliente da agência A. Agora toda relação entre
--    tabelas da agência é uma FK COMPOSTA (organization_id, x_id) → (organization_id, id):
--    referência cruzada vira erro do banco, inclusive para o service_role e para bugs.
-- 2. organization_id passa a ser imutável em todas as tabelas da agência.
-- 3. Jobs presos em 'processing' (worker caiu no meio) voltam para a fila após 15 min.
-- 4. performance_metrics: source nulo permitia linhas duplicadas para o mesmo dia
--    (NULL nunca colide em unique). Agora source é obrigatório ('manual' por padrão).
-- 5. Canais novos: tiktok, youtube, pinterest.
--
-- Migration só-avanço: não altera arquivos já aplicados.

-- ============================================================
-- 0. PRÉ-VERIFICAÇÃO — se já existir dado cruzado entre agências, PARA aqui
--    e lista o que precisa ser corrigido (nada é apagado automaticamente).
-- ============================================================
do $$
declare
  problemas text;
begin
  select string_agg(problema, E'\n') into problemas from (
    select 'brand_kits ' || b.id as problema from public.brand_kits b join public.clients c on c.id = b.client_id where c.organization_id <> b.organization_id
    union all select 'brand_assets ' || x.id from public.brand_assets x join public.clients c on c.id = x.client_id where c.organization_id <> x.organization_id
    union all select 'client_contracts ' || x.id from public.client_contracts x join public.clients c on c.id = x.client_id where c.organization_id <> x.organization_id
    union all select 'campaigns ' || x.id from public.campaigns x join public.clients c on c.id = x.client_id where c.organization_id <> x.organization_id
    union all select 'campaigns(contrato) ' || x.id from public.campaigns x join public.client_contracts k on k.id = x.contract_id where k.organization_id <> x.organization_id or k.client_id <> x.client_id
    union all select 'content_items ' || x.id from public.content_items x join public.campaigns k on k.id = x.campaign_id where k.organization_id <> x.organization_id or k.client_id <> x.client_id
    union all select 'generation_jobs ' || x.id from public.generation_jobs x join public.clients c on c.id = x.client_id where c.organization_id <> x.organization_id
    union all select 'strategic_plans ' || x.id from public.strategic_plans x join public.clients c on c.id = x.client_id where c.organization_id <> x.organization_id
    union all select 'client_workflow ' || x.id from public.client_workflow x join public.clients c on c.id = x.client_id where c.organization_id <> x.organization_id
    union all select 'workflow_tasks ' || x.id from public.workflow_tasks x join public.clients c on c.id = x.client_id where c.organization_id <> x.organization_id
    union all select 'market_research_requests ' || x.id from public.market_research_requests x join public.clients c on c.id = x.client_id where c.organization_id <> x.organization_id
  ) p;
  if problemas is not null then
    raise exception 'Existem registros apontando para outra agência. Corrija antes de aplicar:%', E'\n' || problemas;
  end if;
end $$;

-- ============================================================
-- 1. CHAVES-ALVO (organization_id, id) nas tabelas referenciadas
-- ============================================================
alter table public.clients                  add constraint clients_org_id_uq                  unique (organization_id, id);
alter table public.contract_templates       add constraint contract_templates_org_id_uq       unique (organization_id, id);
alter table public.client_contracts         add constraint client_contracts_org_id_uq         unique (organization_id, id);
alter table public.campaigns                add constraint campaigns_org_id_uq                unique (organization_id, id);
alter table public.content_items            add constraint content_items_org_id_uq            unique (organization_id, id);
alter table public.market_research_requests add constraint market_research_requests_org_id_uq unique (organization_id, id);
-- Coerência de cliente: peça e campanha do MESMO cliente; campanha e contrato do MESMO cliente.
alter table public.campaigns                add constraint campaigns_id_client_uq             unique (id, client_id);
alter table public.client_contracts         add constraint client_contracts_id_client_uq      unique (id, client_id);

-- O nome prometia "organização bate com o cliente", mas só verificava "não nulo".
alter table public.brand_kits drop constraint if exists brand_kits_organization_matches_client;

-- ============================================================
-- 2. FKs COMPOSTAS (mesma ação de exclusão das FKs simples já existentes)
-- ============================================================
alter table public.brand_kits       add constraint brand_kits_client_tfk       foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade;
alter table public.brand_assets     add constraint brand_assets_client_tfk     foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade;
alter table public.client_contracts add constraint client_contracts_client_tfk foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade;
alter table public.client_contracts add constraint client_contracts_template_tfk foreign key (organization_id, template_id) references public.contract_templates (organization_id, id) on delete set null (template_id);

alter table public.campaigns add constraint campaigns_client_tfk   foreign key (organization_id, client_id)   references public.clients (organization_id, id) on delete cascade;
alter table public.campaigns add constraint campaigns_contract_tfk foreign key (organization_id, contract_id) references public.client_contracts (organization_id, id) on delete set null (contract_id);
alter table public.campaigns add constraint campaigns_contract_client_fk foreign key (contract_id, client_id) references public.client_contracts (id, client_id) on delete set null (contract_id);

alter table public.content_items add constraint content_items_campaign_tfk foreign key (organization_id, campaign_id) references public.campaigns (organization_id, id) on delete cascade;
alter table public.content_items add constraint content_items_client_tfk   foreign key (organization_id, client_id)   references public.clients (organization_id, id) on delete cascade;
alter table public.content_items add constraint content_items_campaign_client_fk foreign key (campaign_id, client_id) references public.campaigns (id, client_id) on delete cascade;

alter table public.content_versions    add constraint content_versions_item_tfk    foreign key (organization_id, content_item_id) references public.content_items (organization_id, id) on delete cascade;
alter table public.approval_events     add constraint approval_events_item_tfk     foreign key (organization_id, content_item_id) references public.content_items (organization_id, id) on delete cascade;
alter table public.performance_metrics add constraint performance_metrics_item_tfk foreign key (organization_id, content_item_id) references public.content_items (organization_id, id) on delete cascade;

alter table public.generation_jobs add constraint generation_jobs_client_tfk   foreign key (organization_id, client_id)   references public.clients (organization_id, id) on delete cascade;
alter table public.generation_jobs add constraint generation_jobs_contract_tfk foreign key (organization_id, contract_id) references public.client_contracts (organization_id, id) on delete set null (contract_id);
alter table public.generation_jobs add constraint generation_jobs_campaign_tfk foreign key (organization_id, campaign_id) references public.campaigns (organization_id, id) on delete set null (campaign_id);

alter table public.market_research_requests add constraint market_research_requests_client_tfk foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete set null (client_id);
alter table public.market_research_runs  add constraint market_research_runs_request_tfk  foreign key (organization_id, research_request_id) references public.market_research_requests (organization_id, id) on delete cascade;
alter table public.market_competitors    add constraint market_competitors_request_tfk    foreign key (organization_id, research_request_id) references public.market_research_requests (organization_id, id) on delete cascade;
alter table public.market_keywords       add constraint market_keywords_request_tfk       foreign key (organization_id, research_request_id) references public.market_research_requests (organization_id, id) on delete cascade;
alter table public.market_opportunities  add constraint market_opportunities_request_tfk  foreign key (organization_id, research_request_id) references public.market_research_requests (organization_id, id) on delete cascade;

alter table public.strategic_plans add constraint strategic_plans_client_tfk foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade;
alter table public.client_workflow add constraint client_workflow_client_tfk foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade;
alter table public.workflow_tasks  add constraint workflow_tasks_client_tfk  foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade;
alter table public.workflow_events add constraint workflow_events_client_tfk foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade;

-- ============================================================
-- 3. organization_id IMUTÁVEL em toda tabela da agência
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
-- 4. FILA: jobs presos em 'processing' voltam a ser elegíveis após 15 min
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
-- 5. performance_metrics: source obrigatório (unique passa a valer)
-- ============================================================
-- Duplicatas antigas com source nulo: mantém a mais recente de cada dia.
delete from public.performance_metrics p
using public.performance_metrics q
where p.source is null and q.source is null
  and p.content_item_id = q.content_item_id
  and p.metric_date = q.metric_date
  and p.created_at < q.created_at;

update public.performance_metrics set source = 'manual' where source is null;
alter table public.performance_metrics alter column source set default 'manual';
alter table public.performance_metrics alter column source set not null;

-- ============================================================
-- 6. CANAIS NOVOS
-- ============================================================
alter type public.content_channel add value if not exists 'tiktok';
alter type public.content_channel add value if not exists 'youtube';
alter type public.content_channel add value if not exists 'pinterest';

notify pgrst, 'reload schema';
