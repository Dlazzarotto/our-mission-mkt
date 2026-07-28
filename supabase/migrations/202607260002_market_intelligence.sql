-- EstratégiaPro CRM: módulo de inteligência de mercado multissetorial.
-- Esta migration pressupõe a execução prévia de 202607260001_initial_schema.sql.

create type public.market_research_status as enum (
  'draft', 'queued', 'running', 'completed', 'failed', 'stale', 'cancelled'
);

create type public.market_keyword_intent as enum (
  'informational', 'commercial', 'transactional', 'navigational'
);

create type public.market_priority as enum ('high', 'medium', 'low');

create table public.market_research_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  business_category text not null,
  business_type text not null,
  custom_business_type text,
  zip_code text not null check (zip_code ~ '^[0-9]{5}(-[0-9]{4})?$'),
  radius_miles integer not null check (radius_miles between 1 and 100),
  country_code text not null default 'US' check (country_code = 'US'),
  latitude numeric(10, 7),
  longitude numeric(10, 7),
  enabled_sources jsonb not null default '["maps", "keywords", "trends", "seo", "social", "ai_adoption"]'::jsonb,
  status public.market_research_status not null default 'draft',
  error_message text,
  report_summary text,
  requested_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((business_type <> 'custom') or custom_business_type is not null)
);

create index market_research_requests_org_idx
  on public.market_research_requests(organization_id, created_at desc);
create index market_research_requests_client_idx
  on public.market_research_requests(client_id, created_at desc)
  where client_id is not null;
create index market_research_requests_location_idx
  on public.market_research_requests(zip_code, radius_miles, business_type);

create table public.market_research_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  research_request_id uuid not null references public.market_research_requests(id) on delete cascade,
  status public.market_research_status not null default 'queued',
  idempotency_key text not null unique,
  payload jsonb not null default '{}'::jsonb,
  sources_used jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  scheduled_for timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index market_research_runs_due_idx
  on public.market_research_runs(status, scheduled_for)
  where status = 'queued';
create index market_research_runs_request_idx
  on public.market_research_runs(research_request_id, created_at desc);

create table public.market_competitors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  research_request_id uuid not null references public.market_research_requests(id) on delete cascade,
  external_place_id text,
  rank integer check (rank between 1 and 100),
  name text not null,
  address text,
  city text,
  state text,
  zip_code text,
  distance_miles numeric(7, 2) check (distance_miles >= 0),
  website text,
  google_business_url text,
  rating numeric(2, 1) check (rating between 0 and 5),
  review_count integer check (review_count >= 0),
  services jsonb not null default '[]'::jsonb,
  price_band text not null default 'unknown' check (price_band in ('budget', 'mid', 'premium', 'unknown')),
  differentiators jsonb not null default '[]'::jsonb,
  business_hours text,
  seo_notes text,
  social_notes text,
  ai_adoption_notes text,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (research_request_id, external_place_id)
);

create index market_competitors_request_rank_idx
  on public.market_competitors(research_request_id, rank asc nulls last);
create index market_competitors_request_rating_idx
  on public.market_competitors(research_request_id, rating desc nulls last, review_count desc nulls last);

create table public.market_keywords (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  research_request_id uuid not null references public.market_research_requests(id) on delete cascade,
  keyword text not null,
  intent public.market_keyword_intent not null,
  estimated_volume integer check (estimated_volume >= 0),
  competition text not null default 'unknown' check (competition in ('low', 'medium', 'high', 'unknown')),
  estimated_cpc_usd numeric(10, 2) check (estimated_cpc_usd >= 0),
  priority public.market_priority not null default 'medium',
  source text,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (research_request_id, keyword)
);

create index market_keywords_request_priority_idx
  on public.market_keywords(research_request_id, priority, estimated_volume desc nulls last);

create table public.market_opportunities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  research_request_id uuid not null references public.market_research_requests(id) on delete cascade,
  title text not null,
  category text not null check (category in ('service', 'keyword', 'content', 'ads', 'local_seo', 'automation', 'positioning')),
  score numeric(5, 2) not null check (score between 0 and 100),
  priority public.market_priority not null,
  evidence text not null,
  recommended_action text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index market_opportunities_request_score_idx
  on public.market_opportunities(research_request_id, score desc);

create trigger market_research_requests_set_updated_at before update on public.market_research_requests
for each row execute function public.set_updated_at();
create trigger market_research_runs_set_updated_at before update on public.market_research_runs
for each row execute function public.set_updated_at();
create trigger market_competitors_set_updated_at before update on public.market_competitors
for each row execute function public.set_updated_at();
create trigger market_keywords_set_updated_at before update on public.market_keywords
for each row execute function public.set_updated_at();
create trigger market_opportunities_set_updated_at before update on public.market_opportunities
for each row execute function public.set_updated_at();

-- Worker seguro para a fila independente de pesquisas de mercado.
create or replace function public.claim_due_market_research_runs(
  worker_name text,
  maximum_runs integer default 1
)
returns setof public.market_research_runs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidates as (
    select id
    from public.market_research_runs
    where status = 'queued'
      and scheduled_for <= now()
      and attempts < max_attempts
    order by scheduled_for asc
    limit greatest(1, least(maximum_runs, 5))
    for update skip locked
  )
  update public.market_research_runs run
  set status = 'running',
      attempts = run.attempts + 1,
      started_at = now()
  from candidates
  where run.id = candidates.id
  returning run.*;
end;
$$;

alter table public.market_research_requests enable row level security;
alter table public.market_research_runs enable row level security;
alter table public.market_competitors enable row level security;
alter table public.market_keywords enable row level security;
alter table public.market_opportunities enable row level security;

create policy market_research_requests_select_member on public.market_research_requests
for select to authenticated using (public.is_organization_member(organization_id));
create policy market_research_requests_write_editor on public.market_research_requests
for all to authenticated using (public.is_organization_editor(organization_id))
with check (public.is_organization_editor(organization_id));

create policy market_research_runs_select_editor on public.market_research_runs
for select to authenticated using (public.is_organization_editor(organization_id));
create policy market_research_runs_insert_editor on public.market_research_runs
for insert to authenticated with check (public.is_organization_editor(organization_id));

create policy market_competitors_select_member on public.market_competitors
for select to authenticated using (public.is_organization_member(organization_id));
create policy market_competitors_write_editor on public.market_competitors
for all to authenticated using (public.is_organization_editor(organization_id))
with check (public.is_organization_editor(organization_id));

create policy market_keywords_select_member on public.market_keywords
for select to authenticated using (public.is_organization_member(organization_id));
create policy market_keywords_write_editor on public.market_keywords
for all to authenticated using (public.is_organization_editor(organization_id))
with check (public.is_organization_editor(organization_id));

create policy market_opportunities_select_member on public.market_opportunities
for select to authenticated using (public.is_organization_member(organization_id));
create policy market_opportunities_write_editor on public.market_opportunities
for all to authenticated using (public.is_organization_editor(organization_id))
with check (public.is_organization_editor(organization_id));

revoke all on function public.claim_due_market_research_runs(text, integer) from public, anon, authenticated;
grant execute on function public.claim_due_market_research_runs(text, integer) to service_role;
