-- EstratégiaPro CRM — Workflow de agência
-- Espinha de processo que liga onboarding, diagnóstico, estratégia, produção,
-- aprovação, veiculação e mensuração. Depende de 202607260001 e 202607270001.

create type public.workflow_phase as enum (
  'onboarding', 'discovery', 'strategy', 'planning', 'production',
  'internal_review', 'client_approval', 'publishing', 'measurement', 'optimization'
);

create type public.workflow_task_status as enum ('todo', 'doing', 'blocked', 'done');

create type public.agency_role as enum (
  'account', 'strategist', 'designer', 'copywriter', 'analyst', 'client'
);

-- ============================================================
-- Onde cada cliente está no processo
-- ============================================================
create table if not exists public.client_workflow (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  phase public.workflow_phase not null default 'onboarding',
  phase_started_at timestamptz not null default now(),
  cycle integer not null default 1 check (cycle >= 1),
  paused boolean not null default false,
  pause_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id)
);

create index if not exists client_workflow_org_phase_idx
  on public.client_workflow(organization_id, phase);

-- ============================================================
-- Tarefas da fase — cada uma com dono, papel e prazo
-- ============================================================
create table if not exists public.workflow_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  phase public.workflow_phase not null,
  cycle integer not null default 1,
  title text not null check (char_length(trim(title)) between 3 and 200),
  role public.agency_role not null,
  assignee_id uuid references auth.users(id) on delete set null,
  status public.workflow_task_status not null default 'todo',
  due_at timestamptz,
  blocked_reason text,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workflow_tasks_client_idx
  on public.workflow_tasks(client_id, phase, cycle);
create index if not exists workflow_tasks_open_idx
  on public.workflow_tasks(organization_id, status, due_at)
  where status <> 'done';
create index if not exists workflow_tasks_assignee_idx
  on public.workflow_tasks(assignee_id, status)
  where assignee_id is not null;

-- ============================================================
-- Trilha de eventos — quem passou o quê, quando e por quê
-- ============================================================
create table if not exists public.workflow_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  from_phase public.workflow_phase,
  to_phase public.workflow_phase,
  cycle integer not null default 1,
  action text not null check (action in ('advance', 'return', 'pause', 'resume', 'note', 'cycle_restart')),
  note text,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists workflow_events_client_idx
  on public.workflow_events(client_id, created_at desc);

-- ============================================================
-- Todo cliente novo entra no workflow automaticamente, no onboarding
-- ============================================================
create or replace function public.start_client_workflow()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.client_workflow (organization_id, client_id)
  values (new.organization_id, new.id)
  on conflict (client_id) do nothing;
  return new;
end;
$$;

drop trigger if exists clients_start_workflow on public.clients;
create trigger clients_start_workflow
after insert on public.clients
for each row execute function public.start_client_workflow();

-- Clientes que já existiam entram no processo também.
insert into public.client_workflow (organization_id, client_id)
select organization_id, id from public.clients
on conflict (client_id) do nothing;

drop trigger if exists client_workflow_set_updated_at on public.client_workflow;
create trigger client_workflow_set_updated_at before update on public.client_workflow
for each row execute function public.set_updated_at();

drop trigger if exists workflow_tasks_set_updated_at on public.workflow_tasks;
create trigger workflow_tasks_set_updated_at before update on public.workflow_tasks
for each row execute function public.set_updated_at();

-- ============================================================
-- Segurança
-- ============================================================
alter table public.client_workflow enable row level security;
alter table public.workflow_tasks enable row level security;
alter table public.workflow_events enable row level security;

drop policy if exists client_workflow_select_member on public.client_workflow;
create policy client_workflow_select_member on public.client_workflow
for select to authenticated using (public.is_organization_member(organization_id));
drop policy if exists client_workflow_write_editor on public.client_workflow;
create policy client_workflow_write_editor on public.client_workflow
for all to authenticated using (public.is_organization_editor(organization_id))
with check (public.is_organization_editor(organization_id));

drop policy if exists workflow_tasks_select_member on public.workflow_tasks;
create policy workflow_tasks_select_member on public.workflow_tasks
for select to authenticated using (public.is_organization_member(organization_id));
drop policy if exists workflow_tasks_write_editor on public.workflow_tasks;
create policy workflow_tasks_write_editor on public.workflow_tasks
for all to authenticated using (public.is_organization_editor(organization_id))
with check (public.is_organization_editor(organization_id));

drop policy if exists workflow_events_select_member on public.workflow_events;
create policy workflow_events_select_member on public.workflow_events
for select to authenticated using (public.is_organization_member(organization_id));
drop policy if exists workflow_events_insert_editor on public.workflow_events;
create policy workflow_events_insert_editor on public.workflow_events
for insert to authenticated with check (public.is_organization_editor(organization_id));
