-- EstratégiaPro CRM: schema inicial
-- Execute esta migration no Supabase CLI ou no SQL Editor do projeto.

create extension if not exists pgcrypto;

create type public.app_role as enum (
  'owner', 'manager', 'strategist', 'designer', 'viewer', 'client'
);

create type public.contract_status as enum ('active', 'paused', 'ended');
create type public.visual_style as enum (
  'classic', 'current', 'minimal', 'editorial', 'vibrant', 'premium', 'organic', 'custom'
);
create type public.content_channel as enum (
  'instagram', 'facebook', 'google_business', 'linkedin', 'email', 'whatsapp'
);
create type public.content_format as enum (
  'photo', 'carousel', 'reel', 'story', 'video', 'email'
);
create type public.content_objective as enum (
  'attract', 'educate', 'social_proof', 'convert', 'retain', 'engage'
);
create type public.content_status as enum (
  'planned', 'generating', 'review', 'approved', 'scheduled', 'published', 'rejected'
);
create type public.campaign_status as enum (
  'draft', 'in_review', 'approved', 'active', 'completed', 'archived'
);
create type public.generation_job_status as enum (
  'queued', 'processing', 'completed', 'failed', 'cancelled'
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 120),
  timezone text not null default 'America/New_York',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null default 'strategist',
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_name text not null check (char_length(trim(company_name)) between 2 and 180),
  industry text not null,
  service text not null,
  region text not null,
  contact_name text,
  contact_email text,
  instagram text,
  website text,
  marketing_maturity text,
  differentiators jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index clients_organization_id_idx on public.clients(organization_id);
create index clients_active_idx on public.clients(organization_id, active);

create table public.brand_kits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null unique references public.clients(id) on delete cascade,
  palette jsonb not null default '{"primary":"#2D3278","secondary":"#F47B20","accent":"#1E7F4F","background":"#F6F5F1","text":"#1A1D29"}'::jsonb,
  visual_style public.visual_style not null default 'current',
  tone_of_voice text not null default 'Profissional, claro e acolhedor.',
  required_terms jsonb not null default '[]'::jsonb,
  forbidden_terms jsonb not null default '[]'::jsonb,
  preferred_cta text,
  image_references jsonb not null default '[]'::jsonb,
  logo_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint brand_kits_organization_matches_client check (organization_id is not null)
);

create index brand_kits_organization_id_idx on public.brand_kits(organization_id);

create table public.brand_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  storage_path text not null,
  asset_type text not null check (asset_type in ('logo', 'photo', 'video', 'reference', 'font', 'other')),
  alt_text text,
  usage_rights text,
  created_at timestamptz not null default now()
);

create index brand_assets_client_id_idx on public.brand_assets(client_id);

create table public.contract_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  default_delivery_rules jsonb not null default '[]'::jsonb,
  default_special_date_rules jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table public.client_contracts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  template_id uuid references public.contract_templates(id) on delete set null,
  name text not null,
  status public.contract_status not null default 'active',
  starts_at date not null,
  ends_at date,
  market text not null default 'US',
  timezone text not null default 'America/New_York',
  generation_cadence text not null default 'weekly' check (generation_cadence in ('weekly', 'monthly')),
  next_generation_at timestamptz,
  approval_required boolean not null default true,
  delivery_rules jsonb not null default '[]'::jsonb,
  special_date_rules jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at >= starts_at)
);

create index client_contracts_active_idx on public.client_contracts(organization_id, status, next_generation_at);
create index client_contracts_client_id_idx on public.client_contracts(client_id);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  contract_id uuid references public.client_contracts(id) on delete set null,
  name text not null,
  goal text not null,
  summary text,
  starts_at date not null,
  ends_at date not null,
  status public.campaign_status not null default 'draft',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at >= starts_at)
);

create index campaigns_client_period_idx on public.campaigns(client_id, starts_at, ends_at);
create index campaigns_organization_status_idx on public.campaigns(organization_id, status);

create table public.content_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  title text not null,
  scheduled_at timestamptz not null,
  channel public.content_channel not null,
  format public.content_format not null,
  objective public.content_objective not null,
  pillar text not null,
  status public.content_status not null default 'planned',
  caption text,
  hashtags jsonb not null default '[]'::jsonb,
  creative_brief text,
  image_prompt text,
  video_script text,
  media_path text,
  generated_by_ai boolean not null default false,
  approval_notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index content_items_calendar_idx on public.content_items(client_id, scheduled_at);
create index content_items_campaign_idx on public.content_items(campaign_id, status);

create table public.content_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  content_item_id uuid not null references public.content_items(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  payload jsonb not null,
  change_note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (content_item_id, version_number)
);

create table public.approval_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  content_item_id uuid not null references public.content_items(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  decision text not null check (decision in ('submitted', 'approved', 'rejected', 'commented')),
  comment text,
  created_at timestamptz not null default now()
);

create table public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  contract_id uuid references public.client_contracts(id) on delete set null,
  campaign_id uuid references public.campaigns(id) on delete set null,
  job_type text not null check (job_type in ('campaign_plan', 'content_batch', 'rewrite', 'brand_suggestion')),
  status public.generation_job_status not null default 'queued',
  idempotency_key text not null unique,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  scheduled_for timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index generation_jobs_due_idx on public.generation_jobs(status, scheduled_for)
  where status = 'queued';
create index generation_jobs_client_idx on public.generation_jobs(client_id, created_at desc);

create table public.performance_metrics (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  content_item_id uuid not null references public.content_items(id) on delete cascade,
  metric_date date not null,
  reach integer check (reach >= 0),
  impressions integer check (impressions >= 0),
  engagement integer check (engagement >= 0),
  clicks integer check (clicks >= 0),
  leads integer check (leads >= 0),
  source text,
  created_at timestamptz not null default now(),
  unique (content_item_id, metric_date, source)
);

-- Mantém o timestamp atualizado sem depender do aplicativo.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger organizations_set_updated_at before update on public.organizations
for each row execute function public.set_updated_at();
create trigger clients_set_updated_at before update on public.clients
for each row execute function public.set_updated_at();
create trigger brand_kits_set_updated_at before update on public.brand_kits
for each row execute function public.set_updated_at();
create trigger contract_templates_set_updated_at before update on public.contract_templates
for each row execute function public.set_updated_at();
create trigger client_contracts_set_updated_at before update on public.client_contracts
for each row execute function public.set_updated_at();
create trigger campaigns_set_updated_at before update on public.campaigns
for each row execute function public.set_updated_at();
create trigger content_items_set_updated_at before update on public.content_items
for each row execute function public.set_updated_at();
create trigger generation_jobs_set_updated_at before update on public.generation_jobs
for each row execute function public.set_updated_at();

-- Funções de autorização. SECURITY DEFINER evita recursão das próprias políticas RLS.
create or replace function public.is_organization_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members member
    where member.organization_id = target_organization_id
      and member.user_id = auth.uid()
  );
$$;

create or replace function public.is_organization_editor(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members member
    where member.organization_id = target_organization_id
      and member.user_id = auth.uid()
      and member.role in ('owner', 'manager', 'strategist', 'designer')
  );
$$;

create or replace function public.is_organization_manager(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members member
    where member.organization_id = target_organization_id
      and member.user_id = auth.uid()
      and member.role in ('owner', 'manager')
  );
$$;

-- Cria uma agência e torna o usuário autenticado seu proprietário.
create or replace function public.create_organization_with_owner(
  organization_name text,
  organization_timezone text default 'America/New_York'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_organization_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Usuário não autenticado';
  end if;

  insert into public.organizations (name, timezone)
  values (organization_name, organization_timezone)
  returning id into new_organization_id;

  insert into public.organization_members (organization_id, user_id, role)
  values (new_organization_id, auth.uid(), 'owner');

  return new_organization_id;
end;
$$;

-- Reclama jobs vencidos sem sobreposição entre invocações concorrentes.
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
    where status = 'queued'
      and scheduled_for <= now()
      and attempts < max_attempts
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

-- RLS: toda linha exposta pertence a uma organização e nunca fica pública.
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.clients enable row level security;
alter table public.brand_kits enable row level security;
alter table public.brand_assets enable row level security;
alter table public.contract_templates enable row level security;
alter table public.client_contracts enable row level security;
alter table public.campaigns enable row level security;
alter table public.content_items enable row level security;
alter table public.content_versions enable row level security;
alter table public.approval_events enable row level security;
alter table public.generation_jobs enable row level security;
alter table public.performance_metrics enable row level security;

create policy organizations_select_member on public.organizations
for select to authenticated using (public.is_organization_member(id));
create policy organizations_update_manager on public.organizations
for update to authenticated using (public.is_organization_manager(id))
with check (public.is_organization_manager(id));

create policy members_select_member on public.organization_members
for select to authenticated using (public.is_organization_member(organization_id));
create policy members_insert_manager on public.organization_members
for insert to authenticated with check (public.is_organization_manager(organization_id));
create policy members_update_manager on public.organization_members
for update to authenticated using (public.is_organization_manager(organization_id))
with check (public.is_organization_manager(organization_id));
create policy members_delete_manager on public.organization_members
for delete to authenticated using (public.is_organization_manager(organization_id));

create policy clients_select_member on public.clients
for select to authenticated using (public.is_organization_member(organization_id));
create policy clients_insert_editor on public.clients
for insert to authenticated with check (public.is_organization_editor(organization_id));
create policy clients_update_editor on public.clients
for update to authenticated using (public.is_organization_editor(organization_id))
with check (public.is_organization_editor(organization_id));
create policy clients_delete_manager on public.clients
for delete to authenticated using (public.is_organization_manager(organization_id));

create policy brand_kits_select_member on public.brand_kits
for select to authenticated using (public.is_organization_member(organization_id));
create policy brand_kits_write_editor on public.brand_kits
for all to authenticated using (public.is_organization_editor(organization_id))
with check (public.is_organization_editor(organization_id));

create policy brand_assets_select_member on public.brand_assets
for select to authenticated using (public.is_organization_member(organization_id));
create policy brand_assets_write_editor on public.brand_assets
for all to authenticated using (public.is_organization_editor(organization_id))
with check (public.is_organization_editor(organization_id));

create policy contract_templates_select_member on public.contract_templates
for select to authenticated using (public.is_organization_member(organization_id));
create policy contract_templates_write_manager on public.contract_templates
for all to authenticated using (public.is_organization_manager(organization_id))
with check (public.is_organization_manager(organization_id));

create policy client_contracts_select_member on public.client_contracts
for select to authenticated using (public.is_organization_member(organization_id));
create policy client_contracts_write_editor on public.client_contracts
for all to authenticated using (public.is_organization_editor(organization_id))
with check (public.is_organization_editor(organization_id));

create policy campaigns_select_member on public.campaigns
for select to authenticated using (public.is_organization_member(organization_id));
create policy campaigns_write_editor on public.campaigns
for all to authenticated using (public.is_organization_editor(organization_id))
with check (public.is_organization_editor(organization_id));

create policy content_items_select_member on public.content_items
for select to authenticated using (public.is_organization_member(organization_id));
create policy content_items_write_editor on public.content_items
for all to authenticated using (public.is_organization_editor(organization_id))
with check (public.is_organization_editor(organization_id));

create policy content_versions_select_member on public.content_versions
for select to authenticated using (public.is_organization_member(organization_id));
create policy content_versions_write_editor on public.content_versions
for all to authenticated using (public.is_organization_editor(organization_id))
with check (public.is_organization_editor(organization_id));

create policy approval_events_select_member on public.approval_events
for select to authenticated using (public.is_organization_member(organization_id));
create policy approval_events_write_editor on public.approval_events
for insert to authenticated with check (public.is_organization_editor(organization_id));

create policy generation_jobs_select_editor on public.generation_jobs
for select to authenticated using (public.is_organization_editor(organization_id));
create policy generation_jobs_insert_editor on public.generation_jobs
for insert to authenticated with check (public.is_organization_editor(organization_id));

create policy performance_metrics_select_member on public.performance_metrics
for select to authenticated using (public.is_organization_member(organization_id));
create policy performance_metrics_write_editor on public.performance_metrics
for all to authenticated using (public.is_organization_editor(organization_id))
with check (public.is_organization_editor(organization_id));

-- Storage: crie o bucket privado `brand-assets` no painel do Supabase antes de enviar arquivos.
insert into storage.buckets (id, name, public)
values ('brand-assets', 'brand-assets', false)
on conflict (id) do nothing;

create policy brand_assets_storage_select on storage.objects
for select to authenticated
using (
  bucket_id = 'brand-assets'
  and public.is_organization_member((storage.foldername(name))[1]::uuid)
);

create policy brand_assets_storage_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'brand-assets'
  and public.is_organization_editor((storage.foldername(name))[1]::uuid)
);

create policy brand_assets_storage_update on storage.objects
for update to authenticated
using (
  bucket_id = 'brand-assets'
  and public.is_organization_editor((storage.foldername(name))[1]::uuid)
)
with check (
  bucket_id = 'brand-assets'
  and public.is_organization_editor((storage.foldername(name))[1]::uuid)
);

create policy brand_assets_storage_delete on storage.objects
for delete to authenticated
using (
  bucket_id = 'brand-assets'
  and public.is_organization_editor((storage.foldername(name))[1]::uuid)
);

revoke all on function public.claim_due_generation_jobs(text, integer) from public, anon, authenticated;
grant execute on function public.claim_due_generation_jobs(text, integer) to service_role;
revoke all on function public.create_organization_with_owner(text, text) from public, anon;
grant execute on function public.create_organization_with_owner(text, text) to authenticated;
