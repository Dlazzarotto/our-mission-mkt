-- EstratégiaPro CRM — Migration da Junção (v2)
-- 1. Paleta padrão NEUTRA (a identidade visual é sempre do cliente, definida no perfil dele)
-- 2. Brand Kit criado automaticamente para cada cliente novo
-- 3. Contratos novos entram na fila do cron sem intervenção manual
-- 4. Módulos portados do EstratégiaPro artifact: pesquisa de mercado (ZIP + raio) e plano estratégico

-- ============================================================
-- 1. PALETA PADRÃO NEUTRA
-- A paleta de cada cliente é editável no perfil e pode mudar a qualquer momento.
-- O padrão neutro existe apenas até a agência configurar as cores do cliente.
-- ============================================================
alter table public.brand_kits
  alter column palette set default
  '{"primary":"#334155","secondary":"#0EA5E9","accent":"#10B981","background":"#F8FAFC","text":"#0F172A"}'::jsonb;

-- ============================================================
-- 2. BRAND KIT AUTOMÁTICO POR CLIENTE
-- Todo cliente nasce com um brand kit próprio (paleta neutra),
-- pronto para ser personalizado no perfil.
-- ============================================================
create or replace function public.create_default_brand_kit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.brand_kits (organization_id, client_id)
  values (new.organization_id, new.id)
  on conflict (client_id) do nothing;
  return new;
end;
$$;

drop trigger if exists clients_create_brand_kit on public.clients;
create trigger clients_create_brand_kit
after insert on public.clients
for each row execute function public.create_default_brand_kit();

-- ============================================================
-- 3. CONTRATOS ENTRAM NA FILA AUTOMATICAMENTE
-- Sem isso, next_generation_at nasce nulo e o cron nunca encontra o contrato.
-- ============================================================
create or replace function public.set_initial_next_generation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.next_generation_at is null then
    new.next_generation_at := greatest(new.starts_at::timestamptz, now());
  end if;
  return new;
end;
$$;

drop trigger if exists client_contracts_initial_generation on public.client_contracts;
create trigger client_contracts_initial_generation
before insert on public.client_contracts
for each row execute function public.set_initial_next_generation();

-- Corrige contratos já existentes que estavam fora da fila.
update public.client_contracts
set next_generation_at = greatest(starts_at::timestamptz, now())
where next_generation_at is null and status = 'active';

-- ============================================================
-- 4. INTELIGÊNCIA DE MERCADO — complementos
-- A estrutura base vem de 202607260002_market_intelligence.sql, que separa
-- DADOS OBSERVADOS (market_competitors, market_keywords) da interpretação.
-- Aqui adicionamos onde guardar a ANÁLISE DA IA, sempre em campo próprio para
-- que nunca se confunda com medição.
-- ============================================================
alter table public.market_research_requests
  add column if not exists ai_analysis jsonb not null default '{}'::jsonb,
  add column if not exists execution_plan text,
  add column if not exists providers_used jsonb not null default '[]'::jsonb;

comment on column public.market_research_requests.ai_analysis is
  'Interpretação gerada por IA a partir dos dados observados. Nunca contém métricas medidas.';
comment on column public.market_research_requests.providers_used is
  'Provedores realmente consultados nesta pesquisa (ex.: ["google_places"]).';

-- Política do Google Places: conteúdo não pode virar acervo permanente
-- (place_id é a exceção). Guardamos a data da coleta para expirar e reconsultar.
alter table public.market_competitors
  add column if not exists fetched_at timestamptz,
  add column if not exists source text not null default 'unknown';

comment on column public.market_competitors.fetched_at is
  'Quando o dado foi coletado do provedor. Conteúdo de Places deve ser reconsultado periodicamente, não tratado como acervo.';

-- ============================================================
-- 5. PLANO ESTRATÉGICO (5 seções, portado do artifact)
-- Auditoria digital, mercado/SWOT/concorrentes, personas, metas SMART,
-- canais + calendário editorial.
-- ============================================================
create table if not exists public.strategic_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  status text not null default 'completed' check (status in ('running', 'completed', 'failed')),
  sections jsonb not null default '{}'::jsonb,      -- { auditoria, mercado, personas, metas, canais }
  error_message text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists strategic_plans_client_idx on public.strategic_plans(client_id, created_at desc);

drop trigger if exists strategic_plans_set_updated_at on public.strategic_plans;
create trigger strategic_plans_set_updated_at before update on public.strategic_plans
for each row execute function public.set_updated_at();

alter table public.strategic_plans enable row level security;

drop policy if exists strategic_plans_select_member on public.strategic_plans;
create policy strategic_plans_select_member on public.strategic_plans
for select to authenticated using (public.is_organization_member(organization_id));
drop policy if exists strategic_plans_write_editor on public.strategic_plans;
create policy strategic_plans_write_editor on public.strategic_plans
for all to authenticated using (public.is_organization_editor(organization_id))
with check (public.is_organization_editor(organization_id));
