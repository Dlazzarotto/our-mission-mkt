-- EstratégiaPro CRM — Geração de campanhas TRANSACIONAL e IDEMPOTENTE
-- Depende de 202610060001_integridade_tenant_e_fila.sql e 202610060002_medicao_e_atribuicao.sql.
--
-- Problemas corrigidos:
-- 1. O worker gravava campanha, famílias e peças em chamadas separadas e só depois
--    marcava o job 'completed'. Se a função morresse no meio (timeout, deploy) ou a
--    finalização falhasse, sobrava campanha órfã — e a nova tentativa gravava outra
--    (conteúdo em dobro). Agora tudo acontece numa transação só, no banco:
--    public.complete_generation_job().
-- 2. A finalização não conferia QUEM detinha o job: um worker atrasado podia concluir
--    um job que outro worker já tinha reassumido. Agora só o dono (locked_by) conclui.
-- 3. Dois workers podiam processar dois jobs do MESMO cliente ao mesmo tempo e os dois
--    contavam a cota mensal antes de qualquer gravação (cota em dobro). A reserva
--    passa a entregar no máximo um job por cliente e nunca um cliente que já tem job
--    em andamento.
--
-- Re-executável: create or replace / if not exists. Só-avanço: não altera migrations anteriores.

-- ============================================================
-- 1. Chave de idempotência da campanha gerada
-- ============================================================
-- campaigns.generation_job_id: o job que gerou a campanha. Coluna SEM foreign key DE
-- PROPÓSITO: generation_jobs.campaign_id já referencia campaigns, e duas FKs entre o
-- mesmo par de tabelas deixam o embed do PostgREST ambíguo (o select com
-- "campaigns(...)" passaria a falhar). A integridade vem do índice único abaixo e do
-- fato de só complete_generation_job() preencher a coluna.
alter table public.campaigns add column if not exists generation_job_id uuid;
comment on column public.campaigns.generation_job_id is
  'Job de geração que criou esta campanha (idempotência). Sem FK de propósito: generation_jobs.campaign_id já liga as duas tabelas e uma 2ª FK tornaria o embed do PostgREST ambíguo.';
create unique index if not exists campaigns_generation_job_uq
  on public.campaigns (generation_job_id) where generation_job_id is not null;

-- ============================================================
-- 2. Reserva de jobs: um por cliente, nunca cliente já em andamento
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
  -- Serializa as reservas (são rápidas). A 2ª chamada simultânea espera a 1ª confirmar e,
  -- como cada comando abaixo tira um snapshot NOVO (READ COMMITTED), já enxerga o job
  -- que a 1ª reservou — sem isso as duas viam o cliente "livre" ao mesmo tempo.
  perform pg_advisory_xact_lock(hashtext('public.claim_due_generation_jobs'));

  return query
  with ocupados as (
    -- Cliente com job em andamento (trava recente) não recebe outro: a cota do mês é
    -- contada antes da gravação e dois lotes simultâneos contariam a mesma cota.
    select distinct client_id
      from public.generation_jobs
     where status = 'processing'
       and locked_at >= now() - interval '15 minutes'
  ),
  elegiveis as (
    select distinct on (j.client_id) j.id, j.scheduled_for, j.created_at
      from public.generation_jobs j
     where j.attempts < j.max_attempts
       and (
         (j.status = 'queued' and j.scheduled_for <= now())
         -- Worker morreu no meio (timeout da função, deploy): o job não fica preso para sempre.
         or (j.status = 'processing' and j.locked_at < now() - interval '15 minutes')
       )
       and not exists (select 1 from ocupados o where o.client_id = j.client_id)
     order by j.client_id, j.scheduled_for, j.created_at
  ),
  candidates as (
    select g.id
      from public.generation_jobs g
      join elegiveis e on e.id = g.id
     order by e.scheduled_for, e.created_at
     limit greatest(1, least(maximum_jobs, 20))
       for update of g skip locked
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

revoke all on function public.claim_due_generation_jobs(text, integer) from public, anon, authenticated;
grant execute on function public.claim_due_generation_jobs(text, integer) to service_role;

-- ============================================================
-- 3. Conclusão transacional e idempotente do job
-- ============================================================
-- p_campaign: {"contract_id", "name", "goal", "summary", "starts_at", "ends_at"}
-- p_items:    [{"concept", "title", "scheduled_at", "channel", "format", "objective", "pillar",
--               "caption", "hashtags", "hook", "cta", "variant_label", "creative_brief",
--               "image_prompt", "video_script"}, ...]
-- p_result:   dados extras guardados em generation_jobs.result (período, cotas, avisos).
--
-- Numa transação só: cria a campanha, uma família por conceito (código CF- pelo trigger),
-- as peças (código C- pelo trigger) e marca o job 'completed'. organization_id e
-- client_id vêm do PRÓPRIO job, nunca do chamador.
--
-- Idempotente pelo job: se o job já está 'completed' (ou já existe campanha com este
-- generation_job_id), devolve o que existe com already_completed = true e não regrava.
-- Só o worker que detém o job (status 'processing' e locked_by = p_worker) conclui.
create or replace function public.complete_generation_job(
  p_job_id uuid,
  p_worker text,
  p_campaign jsonb,
  p_items jsonb,
  p_result jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.generation_jobs%rowtype;
  v_campaign_id uuid;
  v_families integer := 0;
  v_items integer := 0;
begin
  select * into v_job from public.generation_jobs where id = p_job_id for update;
  if not found then
    raise exception 'Job de geração % não encontrado.', p_job_id using errcode = 'P0002';
  end if;

  -- Idempotência: nova tentativa de um job já concluído não grava nada de novo.
  if v_job.status = 'completed' then
    return jsonb_build_object(
      'campaign_id', v_job.campaign_id,
      'items_count', coalesce((v_job.result ->> 'items_count')::integer, 0),
      'families_count', coalesce((v_job.result ->> 'families_count')::integer, 0),
      'already_completed', true
    );
  end if;

  if v_job.status <> 'processing' or v_job.locked_by is distinct from p_worker then
    raise exception 'Job % não está reservado para o worker % (status %, dono %).',
      p_job_id, p_worker, v_job.status, coalesce(v_job.locked_by, 'nenhum')
      using errcode = '55000';
  end if;

  -- Defesa extra: campanha deste job já existe (estado inconsistente) → só fecha o job.
  select id into v_campaign_id from public.campaigns where generation_job_id = p_job_id;
  if found then
    update public.generation_jobs
       set status = 'completed', completed_at = now(), campaign_id = v_campaign_id,
           locked_at = null, locked_by = null, error_message = null,
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object('campaign_id', v_campaign_id)
     where id = p_job_id;
    return jsonb_build_object('campaign_id', v_campaign_id, 'items_count', 0, 'families_count', 0, 'already_completed', true);
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Lote sem peças: nada a gravar para o job %.', p_job_id using errcode = '22023';
  end if;

  insert into public.campaigns (
    organization_id, client_id, contract_id, name, goal, summary, starts_at, ends_at, status, generation_job_id
  ) values (
    v_job.organization_id,
    v_job.client_id,
    coalesce(nullif(p_campaign ->> 'contract_id', '')::uuid, v_job.contract_id),
    p_campaign ->> 'name',
    p_campaign ->> 'goal',
    nullif(p_campaign ->> 'summary', ''),
    (p_campaign ->> 'starts_at')::date,
    (p_campaign ->> 'ends_at')::date,
    'in_review',
    p_job_id
  )
  returning id into v_campaign_id;

  -- Conceito normalizado (espaços colapsados, até 300) = mesma regra para família e peça.
  with entrada as (
    select e.value as item,
           e.ordinality as ordem,
           left(regexp_replace(btrim(coalesce(e.value ->> 'concept', '')), '\s+', ' ', 'g'), 300) as conceito
      from jsonb_array_elements(p_items) with ordinality as e(value, ordinality)
  ),
  conceitos as (
    select distinct on (lower(btrim(conceito))) btrim(conceito) as conceito, lower(btrim(conceito)) as chave
      from entrada
     where char_length(btrim(conceito)) >= 3
     order by lower(btrim(conceito)), ordem
  ),
  familias as (
    insert into public.content_families (organization_id, client_id, campaign_id, concept, origin)
    select v_job.organization_id, v_job.client_id, v_campaign_id, c.conceito, 'ai'
      from conceitos c
    returning id, lower(btrim(concept)) as chave
  ),
  pecas as (
    insert into public.content_items (
      organization_id, campaign_id, client_id, family_id, title, scheduled_at, channel, format,
      objective, pillar, status, caption, hashtags, hook, cta, variant_label, creative_brief,
      image_prompt, video_script, generated_by_ai
    )
    select v_job.organization_id,
           v_campaign_id,
           v_job.client_id,
           f.id,
           en.item ->> 'title',
           (en.item ->> 'scheduled_at')::timestamptz,
           (en.item ->> 'channel')::public.content_channel,
           (en.item ->> 'format')::public.content_format,
           (en.item ->> 'objective')::public.content_objective,
           en.item ->> 'pillar',
           'review',
           en.item ->> 'caption',
           coalesce(en.item -> 'hashtags', '[]'::jsonb),
           nullif(en.item ->> 'hook', ''),
           nullif(en.item ->> 'cta', ''),
           nullif(en.item ->> 'variant_label', ''),
           nullif(en.item ->> 'creative_brief', ''),
           nullif(en.item ->> 'image_prompt', ''),
           nullif(en.item ->> 'video_script', ''),
           true
      from entrada en
      left join familias f on f.chave = lower(btrim(en.conceito))
     order by en.ordem
    returning 1
  )
  select (select count(*) from familias)::integer, (select count(*) from pecas)::integer
    into v_families, v_items;

  update public.generation_jobs
     set status = 'completed',
         completed_at = now(),
         campaign_id = v_campaign_id,
         locked_at = null,
         locked_by = null,
         error_message = null,
         result = coalesce(p_result, '{}'::jsonb)
                  || jsonb_build_object('campaign_id', v_campaign_id, 'items_count', v_items, 'families_count', v_families)
   where id = p_job_id;

  return jsonb_build_object(
    'campaign_id', v_campaign_id,
    'items_count', v_items,
    'families_count', v_families,
    'already_completed', false
  );
end;
$$;

revoke all on function public.complete_generation_job(uuid, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.complete_generation_job(uuid, text, jsonb, jsonb, jsonb) to service_role;

notify pgrst, 'reload schema';
