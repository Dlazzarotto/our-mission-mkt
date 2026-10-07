-- EstratégiaPro CRM — FASE 1 do marketing autônomo: MEDIÇÃO E ATRIBUIÇÃO
-- Depende de 202610060001_integridade_tenant_e_fila.sql.
--
-- Responde "qual peça gerou o lead que virou venda", não só "qual teve mais views":
--
--   FAMÍLIA (conceito) → PEÇA (variante por canal/formato) → LINK RASTREÁVEL
--   → CLIQUE (cidade, aparelho) → LEAD → QUALIFICADO → CLIENTE → RECEITA
--
-- Princípios:
--   * Todo número exibido é calculado pelo BANCO (views), nunca pela IA.
--   * Pouco dado = "dados insuficientes", nunca um ranking inventado.
--   * Toda relação é FK composta por agência (mesma regra da migration anterior).
--   * Clique e histórico de lead são append-only.

-- ============================================================
-- 0. NUMERAÇÃO LEGÍVEL POR AGÊNCIA (CF-00001, C-00001, LD-00001)
-- ============================================================
create table if not exists public.organization_sequences (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  key text not null,
  next_value bigint not null default 1 check (next_value >= 1),
  primary key (organization_id, key)
);
alter table public.organization_sequences enable row level security;
-- Sem policies: só funções SECURITY DEFINER mexem na numeração.

create or replace function public.next_org_code(p_organization uuid, p_key text, p_prefix text, p_padding integer default 5)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_value bigint;
begin
  insert into public.organization_sequences (organization_id, key)
  values (p_organization, p_key)
  on conflict (organization_id, key) do nothing;

  -- O UPDATE trava a linha: duas gravações simultâneas nunca recebem o mesmo número.
  update public.organization_sequences
     set next_value = next_value + 1
   where organization_id = p_organization and key = p_key
  returning next_value - 1 into v_value;

  return p_prefix || lpad(v_value::text, p_padding, '0');
end;
$$;
revoke all on function public.next_org_code(uuid, text, text, integer) from public, anon, authenticated;

-- ============================================================
-- 1. FAMÍLIA DE CONTEÚDO — o conceito que vira várias peças
-- ============================================================
create table if not exists public.content_families (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete set null,
  code text not null,
  concept text not null check (char_length(trim(concept)) between 3 and 300),
  hypothesis text,
  origin text not null default 'manual' check (origin in ('ai', 'manual', 'recycled')),
  parent_family_id uuid references public.content_families(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'winner', 'retired')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code),
  unique (organization_id, id),
  unique (id, client_id)
);

alter table public.content_families
  add constraint content_families_client_tfk foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade,
  add constraint content_families_campaign_tfk foreign key (organization_id, campaign_id) references public.campaigns (organization_id, id) on delete set null (campaign_id),
  add constraint content_families_parent_tfk foreign key (organization_id, parent_family_id) references public.content_families (organization_id, id) on delete set null (parent_family_id);

create index if not exists content_families_client_idx on public.content_families(client_id, created_at desc);

-- ============================================================
-- 2. PEÇA: vínculo com a família, código público e dados da publicação
-- ============================================================
alter table public.content_items
  add column if not exists family_id uuid,
  add column if not exists public_code text,
  add column if not exists hook text,
  add column if not exists cta text,
  add column if not exists variant_label text,
  add column if not exists external_post_id text,
  add column if not exists permalink text check (permalink is null or permalink ~* '^https://'),
  add column if not exists published_at timestamptz;

alter table public.content_items
  add constraint content_items_id_client_uq unique (id, client_id),
  add constraint content_items_family_tfk foreign key (organization_id, family_id) references public.content_families (organization_id, id) on delete set null (family_id),
  add constraint content_items_family_client_fk foreign key (family_id, client_id) references public.content_families (id, client_id) on delete set null (family_id);

create index if not exists content_items_family_idx on public.content_items(family_id) where family_id is not null;

-- Código público para peças já existentes, na ordem de criação, por agência.
with numeradas as (
  select id, organization_id, row_number() over (partition by organization_id order by created_at, id) as n
  from public.content_items
  where public_code is null
)
update public.content_items ci
   set public_code = 'C-' || lpad(numeradas.n::text, 5, '0')
  from numeradas
 where ci.id = numeradas.id;

insert into public.organization_sequences (organization_id, key, next_value)
select organization_id, 'content', count(*) + 1 from public.content_items group by organization_id
on conflict (organization_id, key) do update set next_value = greatest(public.organization_sequences.next_value, excluded.next_value);

alter table public.content_items add constraint content_items_public_code_uq unique (organization_id, public_code);

create or replace function public.content_items_assign_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.public_code is null then
    new.public_code := public.next_org_code(new.organization_id, 'content', 'C-', 5);
  end if;
  -- Publicado sem data informada: carimba agora.
  if new.status = 'published' and new.published_at is null then
    new.published_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists content_items_assign_code on public.content_items;
create trigger content_items_assign_code before insert or update on public.content_items
for each row execute function public.content_items_assign_code();

create or replace function public.content_families_assign_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.code is null or new.code = '' then
    new.code := public.next_org_code(new.organization_id, 'family', 'CF-', 5);
  end if;
  return new;
end;
$$;

-- code nasce vazio e o trigger numera: a aplicação nunca inventa número.
alter table public.content_families alter column code set default '';
drop trigger if exists content_families_assign_code on public.content_families;
create trigger content_families_assign_code before insert on public.content_families
for each row execute function public.content_families_assign_code();

-- ============================================================
-- 3. LINK RASTREÁVEL — uma URL curta por peça e canal
-- ============================================================
create table if not exists public.tracking_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  content_item_id uuid references public.content_items(id) on delete set null,
  campaign_id uuid references public.campaigns(id) on delete set null,
  slug text not null unique check (slug ~ '^[A-Za-z0-9_-]{4,40}$'),
  label text not null check (char_length(trim(label)) between 2 and 120),
  channel public.content_channel,
  -- redirect: leva ao site do cliente com UTM | form: abre o formulário de captação hospedado aqui
  mode text not null default 'redirect' check (mode in ('redirect', 'form')),
  destination_url text check (destination_url is null or destination_url ~* '^https://[^\s]+$'),
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  active boolean not null default true,
  expires_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (mode = 'form' or destination_url is not null),
  unique (organization_id, id),
  unique (id, client_id)
);

alter table public.tracking_links
  add constraint tracking_links_client_tfk foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade,
  add constraint tracking_links_item_tfk foreign key (organization_id, content_item_id) references public.content_items (organization_id, id) on delete set null (content_item_id),
  add constraint tracking_links_item_client_fk foreign key (content_item_id, client_id) references public.content_items (id, client_id) on delete set null (content_item_id),
  add constraint tracking_links_campaign_tfk foreign key (organization_id, campaign_id) references public.campaigns (organization_id, id) on delete set null (campaign_id),
  add constraint tracking_links_campaign_client_fk foreign key (campaign_id, client_id) references public.campaigns (id, client_id) on delete set null (campaign_id);

create index if not exists tracking_links_client_idx on public.tracking_links(client_id, created_at desc);
create index if not exists tracking_links_item_idx on public.tracking_links(content_item_id) where content_item_id is not null;

-- Link de uma peça herda campanha e canal da peça quando não informados.
create or replace function public.tracking_links_fill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
begin
  if new.content_item_id is not null then
    select campaign_id, channel, public_code into v_item from public.content_items where id = new.content_item_id;
    new.campaign_id := coalesce(new.campaign_id, v_item.campaign_id);
    new.channel := coalesce(new.channel, v_item.channel);
    new.utm_content := coalesce(new.utm_content, v_item.public_code);
  end if;
  new.utm_source := coalesce(new.utm_source, new.channel::text);
  new.utm_medium := coalesce(new.utm_medium, case when new.channel in ('email') then 'email' else 'social' end);
  return new;
end;
$$;

drop trigger if exists tracking_links_fill on public.tracking_links;
create trigger tracking_links_fill before insert or update of content_item_id, channel on public.tracking_links
for each row execute function public.tracking_links_fill();

-- ============================================================
-- 4. CLIQUE — append-only, gravado pela rota pública /r/[slug]
-- ============================================================
create table if not exists public.link_clicks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  link_id uuid not null references public.tracking_links(id) on delete cascade,
  clicked_at timestamptz not null default now(),
  visitor_id uuid,
  ip_hash text,              -- hash com sal do servidor: identifica repetição sem guardar IP
  user_agent text,
  device text not null default 'unknown' check (device in ('mobile', 'tablet', 'desktop', 'bot', 'unknown')),
  is_bot boolean not null default false,
  referrer text,
  country text,
  region text,
  city text,
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);

alter table public.link_clicks
  add constraint link_clicks_link_tfk foreign key (organization_id, link_id) references public.tracking_links (organization_id, id) on delete cascade,
  add constraint link_clicks_link_client_fk foreign key (link_id, client_id) references public.tracking_links (id, client_id) on delete cascade;

create index if not exists link_clicks_link_time_idx on public.link_clicks(link_id, clicked_at desc);
create index if not exists link_clicks_visitor_idx on public.link_clicks(visitor_id, clicked_at desc) where visitor_id is not null;
create index if not exists link_clicks_client_time_idx on public.link_clicks(client_id, clicked_at desc);

create or replace function public.block_update()
returns trigger
language plpgsql
as $$
begin
  raise exception '% é append-only: registro não pode ser alterado', tg_table_name using errcode = '42501';
end;
$$;

drop trigger if exists link_clicks_append_only on public.link_clicks;
create trigger link_clicks_append_only before update on public.link_clicks
for each row execute function public.block_update();

-- ============================================================
-- 5. LEAD — do contato à receita
-- ============================================================
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  lead_code text not null default '',
  name text,
  email text,
  phone text,
  zip text,
  city text,
  state text,
  message text,
  source_type text not null check (source_type in ('tracked_link', 'hosted_form', 'manual', 'import', 'webhook')),
  link_id uuid,
  click_id uuid,
  content_item_id uuid,
  campaign_id uuid,
  family_id uuid,
  channel public.content_channel,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  visitor_id uuid,
  -- click = veio por link rastreado (prova) · self_reported = "como nos conheceu" · unknown = sem origem
  attribution text not null default 'unknown' check (attribution in ('click', 'self_reported', 'unknown')),
  self_reported_source text,
  status text not null default 'new' check (status in ('new', 'contacted', 'qualified', 'customer', 'lost', 'spam')),
  contacted_at timestamptz,
  qualified_at timestamptz,
  converted_at timestamptz,
  lost_at timestamptz,
  revenue numeric(14, 2) check (revenue is null or revenue >= 0),
  lost_reason text,
  consent_marketing boolean not null default false,
  consent_text text,
  consent_at timestamptz,
  ip_hash text,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (num_nonnulls(nullif(trim(name), ''), nullif(trim(email), ''), nullif(trim(phone), '')) >= 1),
  unique (organization_id, id)
);

alter table public.leads
  add constraint leads_client_tfk foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade,
  add constraint leads_link_tfk foreign key (organization_id, link_id) references public.tracking_links (organization_id, id) on delete set null (link_id),
  add constraint leads_link_client_fk foreign key (link_id, client_id) references public.tracking_links (id, client_id) on delete set null (link_id),
  add constraint leads_click_tfk foreign key (organization_id, click_id) references public.link_clicks (organization_id, id) on delete set null (click_id),
  add constraint leads_item_tfk foreign key (organization_id, content_item_id) references public.content_items (organization_id, id) on delete set null (content_item_id),
  add constraint leads_item_client_fk foreign key (content_item_id, client_id) references public.content_items (id, client_id) on delete set null (content_item_id),
  add constraint leads_campaign_tfk foreign key (organization_id, campaign_id) references public.campaigns (organization_id, id) on delete set null (campaign_id),
  add constraint leads_campaign_client_fk foreign key (campaign_id, client_id) references public.campaigns (id, client_id) on delete set null (campaign_id),
  add constraint leads_family_tfk foreign key (organization_id, family_id) references public.content_families (organization_id, id) on delete set null (family_id),
  add constraint leads_family_client_fk foreign key (family_id, client_id) references public.content_families (id, client_id) on delete set null (family_id);

create unique index if not exists leads_code_uq on public.leads(organization_id, lead_code);
create index if not exists leads_client_time_idx on public.leads(client_id, created_at desc);
create index if not exists leads_item_idx on public.leads(content_item_id) where content_item_id is not null;
create index if not exists leads_ip_time_idx on public.leads(ip_hash, created_at desc) where ip_hash is not null;

-- Preenche a cadeia de atribuição a partir do link / peça e carimba o funil.
create or replace function public.leads_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link record;
  v_click record;
  v_item record;
begin
  if tg_op = 'INSERT' then
    if new.lead_code is null or new.lead_code = '' then
      new.lead_code := public.next_org_code(new.organization_id, 'lead', 'LD-', 5);
    end if;

    if new.link_id is not null then
      select * into v_link from public.tracking_links where id = new.link_id;
      new.content_item_id := coalesce(new.content_item_id, v_link.content_item_id);
      new.campaign_id := coalesce(new.campaign_id, v_link.campaign_id);
      new.channel := coalesce(new.channel, v_link.channel);
      new.utm_source := coalesce(new.utm_source, v_link.utm_source);
      new.utm_medium := coalesce(new.utm_medium, v_link.utm_medium);
      new.utm_campaign := coalesce(new.utm_campaign, v_link.utm_campaign);
      new.utm_content := coalesce(new.utm_content, v_link.utm_content);
      new.utm_term := coalesce(new.utm_term, v_link.utm_term);
    end if;

    -- Último clique deste visitante neste link (até 30 dias) = prova da origem.
    if new.click_id is null and new.link_id is not null and new.visitor_id is not null then
      select id into new.click_id
        from public.link_clicks
       where link_id = new.link_id and visitor_id = new.visitor_id
         and clicked_at > now() - interval '30 days'
       order by clicked_at desc
       limit 1;
    end if;

    if new.click_id is not null and (new.city is null or new.state is null) then
      select city, region into v_click from public.link_clicks where id = new.click_id;
      new.city := coalesce(new.city, v_click.city);
      new.state := coalesce(new.state, v_click.region);
    end if;

    if new.content_item_id is not null then
      select campaign_id, family_id, channel into v_item from public.content_items where id = new.content_item_id;
      new.campaign_id := coalesce(new.campaign_id, v_item.campaign_id);
      new.family_id := coalesce(new.family_id, v_item.family_id);
      new.channel := coalesce(new.channel, v_item.channel);
    end if;

    new.attribution := case
      when new.link_id is not null then 'click'
      when nullif(trim(coalesce(new.self_reported_source, '')), '') is not null then 'self_reported'
      else 'unknown'
    end;

    if new.consent_marketing and new.consent_at is null then
      new.consent_at := now();
    end if;
  end if;

  -- Funil: cada etapa é carimbada na primeira vez em que é atingida.
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    if new.status in ('contacted', 'qualified', 'customer') and new.contacted_at is null then
      new.contacted_at := now();
    end if;
    if new.status in ('qualified', 'customer') and new.qualified_at is null then
      new.qualified_at := now();
    end if;
    if new.status = 'customer' and new.converted_at is null then
      new.converted_at := now();
    end if;
    if new.status <> 'customer' then
      new.converted_at := null;   -- deixou de ser cliente: não conta como conversão
    end if;
    if new.status = 'lost' and new.lost_at is null then
      new.lost_at := now();
    end if;
    if new.status <> 'lost' then
      new.lost_at := null;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists leads_before_write on public.leads;
create trigger leads_before_write before insert or update on public.leads
for each row execute function public.leads_before_write();

-- Histórico do funil (quem mudou, de quê para quê, quando) — append-only.
create table if not exists public.lead_status_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  from_status text,
  to_status text not null,
  revenue numeric(14, 2),
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.lead_status_history
  add constraint lead_status_history_lead_tfk foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade;
create index if not exists lead_status_history_lead_idx on public.lead_status_history(lead_id, created_at);

drop trigger if exists lead_status_history_append_only on public.lead_status_history;
create trigger lead_status_history_append_only before update on public.lead_status_history
for each row execute function public.block_update();

create or replace function public.leads_log_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status or new.revenue is distinct from old.revenue then
    insert into public.lead_status_history (organization_id, lead_id, from_status, to_status, revenue, actor_id)
    values (new.organization_id, new.id, case when tg_op = 'UPDATE' then old.status end, new.status, new.revenue, auth.uid());
  end if;
  return null;
end;
$$;

drop trigger if exists leads_log_status on public.leads;
create trigger leads_log_status after insert or update on public.leads
for each row execute function public.leads_log_status();

-- ============================================================
-- 6. MÉTRICAS DA PLATAFORMA — colunas que faltavam
-- ============================================================
alter table public.performance_metrics
  add column if not exists video_views integer check (video_views >= 0),
  add column if not exists watch_time_seconds integer check (watch_time_seconds >= 0),
  add column if not exists saves integer check (saves >= 0),
  add column if not exists shares integer check (shares >= 0),
  add column if not exists spend numeric(12, 2) check (spend >= 0),
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists performance_metrics_set_updated_at on public.performance_metrics;
create trigger performance_metrics_set_updated_at before update on public.performance_metrics
for each row execute function public.set_updated_at();

-- ============================================================
-- 7. TIMESTAMPS + organization_id imutável nas tabelas novas
-- ============================================================
drop trigger if exists content_families_set_updated_at on public.content_families;
create trigger content_families_set_updated_at before update on public.content_families
for each row execute function public.set_updated_at();
drop trigger if exists tracking_links_set_updated_at on public.tracking_links;
create trigger tracking_links_set_updated_at before update on public.tracking_links
for each row execute function public.set_updated_at();
drop trigger if exists leads_set_updated_at on public.leads;
create trigger leads_set_updated_at before update on public.leads
for each row execute function public.set_updated_at();

do $$
declare
  t text;
begin
  foreach t in array array['content_families', 'tracking_links', 'leads']
  loop
    execute format('drop trigger if exists lock_organization_id on public.%I', t);
    execute format('create trigger lock_organization_id before update on public.%I for each row execute function public.lock_organization_id()', t);
  end loop;
end $$;

-- ============================================================
-- 8. RLS
-- ============================================================
alter table public.content_families enable row level security;
alter table public.tracking_links enable row level security;
alter table public.link_clicks enable row level security;
alter table public.leads enable row level security;
alter table public.lead_status_history enable row level security;

drop policy if exists content_families_select_member on public.content_families;
create policy content_families_select_member on public.content_families
for select to authenticated using (public.is_organization_member(organization_id));
drop policy if exists content_families_write_editor on public.content_families;
create policy content_families_write_editor on public.content_families
for insert to authenticated with check (public.is_organization_editor(organization_id));
drop policy if exists content_families_update_editor on public.content_families;
create policy content_families_update_editor on public.content_families
for update to authenticated using (public.is_organization_editor(organization_id))
with check (public.is_organization_editor(organization_id));
drop policy if exists content_families_delete_manager on public.content_families;
create policy content_families_delete_manager on public.content_families
for delete to authenticated using (public.is_organization_manager(organization_id));

drop policy if exists tracking_links_select_member on public.tracking_links;
create policy tracking_links_select_member on public.tracking_links
for select to authenticated using (public.is_organization_member(organization_id));
drop policy if exists tracking_links_insert_editor on public.tracking_links;
create policy tracking_links_insert_editor on public.tracking_links
for insert to authenticated with check (public.is_organization_editor(organization_id));
drop policy if exists tracking_links_update_editor on public.tracking_links;
create policy tracking_links_update_editor on public.tracking_links
for update to authenticated using (public.is_organization_editor(organization_id))
with check (public.is_organization_editor(organization_id));
drop policy if exists tracking_links_delete_manager on public.tracking_links;
create policy tracking_links_delete_manager on public.tracking_links
for delete to authenticated using (public.is_organization_manager(organization_id));

-- Cliques: leitura para membros; gravação SÓ pelo servidor (rota pública com service_role).
drop policy if exists link_clicks_select_member on public.link_clicks;
create policy link_clicks_select_member on public.link_clicks
for select to authenticated using (public.is_organization_member(organization_id));

drop policy if exists leads_select_member on public.leads;
create policy leads_select_member on public.leads
for select to authenticated using (public.is_organization_member(organization_id));
drop policy if exists leads_insert_editor on public.leads;
create policy leads_insert_editor on public.leads
for insert to authenticated with check (public.is_organization_editor(organization_id));
drop policy if exists leads_update_editor on public.leads;
create policy leads_update_editor on public.leads
for update to authenticated using (public.is_organization_editor(organization_id))
with check (public.is_organization_editor(organization_id));
drop policy if exists leads_delete_manager on public.leads;
create policy leads_delete_manager on public.leads
for delete to authenticated using (public.is_organization_manager(organization_id));

drop policy if exists lead_status_history_select_member on public.lead_status_history;
create policy lead_status_history_select_member on public.lead_status_history
for select to authenticated using (public.is_organization_member(organization_id));

-- O visitante anônimo nunca lê nem grava nada disso direto.
revoke all on public.content_families, public.tracking_links, public.link_clicks,
              public.leads, public.lead_status_history, public.organization_sequences from anon;

-- ============================================================
-- 9. VIEWS DE RESULTADO (security_invoker: a RLS de quem consulta continua valendo)
-- Regra de exibição: divisão por zero = NULL ("sem dado"), nunca 0 inventado.
-- ============================================================
create or replace view public.v_content_results with (security_invoker = true) as
select
  ci.organization_id,
  ci.client_id,
  ci.id as content_item_id,
  ci.public_code,
  ci.title,
  ci.channel,
  ci.format,
  ci.status,
  ci.campaign_id,
  ci.family_id,
  f.code as family_code,
  f.concept as family_concept,
  ci.hook,
  ci.cta,
  ci.permalink,
  ci.scheduled_at,
  ci.published_at,
  (m.content_item_id is not null) as has_platform_metrics,
  m.impressions,
  m.reach,
  m.engagement,
  m.platform_clicks,
  m.video_views,
  m.watch_time_seconds,
  m.spend,
  coalesce(c.tracked_clicks, 0)::integer as tracked_clicks,
  coalesce(l.leads, 0)::integer as leads,
  coalesce(l.qualified, 0)::integer as qualified_leads,
  coalesce(l.customers, 0)::integer as customers,
  coalesce(l.revenue, 0)::numeric(14, 2) as revenue,
  -- CTR usa o clique informado pela plataforma; sem ele, o clique rastreado pelo nosso link.
  round(coalesce(nullif(m.platform_clicks, 0), c.tracked_clicks)::numeric / nullif(m.impressions, 0), 4) as ctr,
  round(l.leads::numeric / nullif(c.tracked_clicks, 0), 4) as lead_rate,
  round(l.qualified::numeric / nullif(l.leads, 0), 4) as qualified_rate,
  round(l.customers::numeric / nullif(l.leads, 0), 4) as conversion_rate,
  round(m.spend / nullif(l.leads, 0), 2) as cpl,
  round(m.spend / nullif(l.customers, 0), 2) as cpa,
  round(l.revenue / nullif(m.spend, 0), 2) as roas
from public.content_items ci
left join public.content_families f on f.id = ci.family_id
left join lateral (
  select pm.content_item_id,
         sum(pm.impressions)::integer as impressions,
         sum(pm.reach)::integer as reach,
         sum(pm.engagement)::integer as engagement,
         sum(pm.clicks)::integer as platform_clicks,
         sum(pm.video_views)::integer as video_views,
         sum(pm.watch_time_seconds)::integer as watch_time_seconds,
         sum(pm.spend)::numeric(14, 2) as spend
    from public.performance_metrics pm
   where pm.content_item_id = ci.id
   group by pm.content_item_id
) m on true
left join lateral (
  select count(*) as tracked_clicks
    from public.link_clicks lc
    join public.tracking_links tl on tl.id = lc.link_id
   where tl.content_item_id = ci.id and not lc.is_bot
) c on true
left join lateral (
  select count(*) as leads,
         count(*) filter (where ld.qualified_at is not null) as qualified,
         count(*) filter (where ld.status = 'customer') as customers,
         coalesce(sum(ld.revenue) filter (where ld.status = 'customer'), 0) as revenue
    from public.leads ld
   where ld.content_item_id = ci.id and ld.status <> 'spam'
) l on true;

-- Score relativo ao histórico do PRÓPRIO cliente (últimos 90 dias).
-- Cada indicador é dividido pelo MELHOR valor do cliente no período (0 a 1) e somado com
-- pesos — receita, clientes e leads qualificados pesam mais (prioridade do Master Prompt):
--   receita 35 · clientes 25 · qualificados 15 · leads 15 · CTR 5 · alcance 5  (= 100)
-- Amostra mínima: sem 3 leads, 30 cliques rastreados ou 1.000 impressões → "insufficient_data";
-- e com menos de 5 peças medidas no cliente não existe comparação → "insufficient_data".
create or replace view public.v_content_scores with (security_invoker = true) as
with base as (
  select r.*,
         (r.leads >= 3 or r.tracked_clicks >= 30 or coalesce(r.impressions, 0) >= 1000) as sufficient
    from public.v_content_results r
   where coalesce(r.published_at, r.scheduled_at) >= now() - interval '90 days'
     and r.status in ('published', 'scheduled', 'approved')
),
best as (
  select client_id,
         max(revenue) as revenue,
         max(customers) as customers,
         max(qualified_leads) as qualified,
         max(leads) as leads,
         max(coalesce(ctr, 0)) as ctr,
         max(coalesce(reach, 0)) as reach,
         count(*) as scored_items
    from base
   where sufficient
   group by client_id
),
scored as (
  select b.*,
         coalesce(x.scored_items, 0) as scored_items,
         case when b.sufficient then
           round(100 * (
               0.35 * coalesce(b.revenue / nullif(x.revenue, 0), 0)
             + 0.25 * coalesce(b.customers::numeric / nullif(x.customers, 0), 0)
             + 0.15 * coalesce(b.qualified_leads::numeric / nullif(x.qualified, 0), 0)
             + 0.15 * coalesce(b.leads::numeric / nullif(x.leads, 0), 0)
             + 0.05 * coalesce(coalesce(b.ctr, 0) / nullif(x.ctr, 0), 0)
             + 0.05 * coalesce(coalesce(b.reach, 0)::numeric / nullif(x.reach, 0), 0)
           ), 1)
         end as score
    from base b
    left join best x on x.client_id = b.client_id
)
select
  scored.*,
  case
    when not scored.sufficient then 'insufficient_data'
    when scored.scored_items < 5 then 'insufficient_data'   -- ranking com menos de 5 peças medidas não diz nada
    when scored.score >= 85 then 'S'
    when scored.score >= 70 then 'A'
    when scored.score >= 50 then 'B'
    when scored.score >= 30 then 'C'
    when scored.score >= 15 then 'D'
    else 'F'
  end as tier
from scored;

create or replace view public.v_family_results with (security_invoker = true) as
select
  f.organization_id,
  f.client_id,
  f.id as family_id,
  f.code,
  f.concept,
  f.origin,
  f.status,
  count(r.content_item_id)::integer as pieces,
  count(distinct r.channel)::integer as channels,
  sum(r.impressions)::integer as impressions,
  coalesce(sum(r.tracked_clicks), 0)::integer as tracked_clicks,
  coalesce(sum(r.leads), 0)::integer as leads,
  coalesce(sum(r.qualified_leads), 0)::integer as qualified_leads,
  coalesce(sum(r.customers), 0)::integer as customers,
  coalesce(sum(r.revenue), 0)::numeric(14, 2) as revenue,
  sum(r.spend)::numeric(14, 2) as spend,
  round(sum(r.spend) / nullif(sum(r.leads), 0), 2) as cpl,
  round(sum(r.revenue) / nullif(sum(r.spend), 0), 2) as roas
from public.content_families f
left join public.v_content_results r on r.family_id = f.id
group by f.organization_id, f.client_id, f.id, f.code, f.concept, f.origin, f.status;

create or replace view public.v_channel_results with (security_invoker = true) as
select
  r.organization_id,
  r.client_id,
  r.channel,
  count(*)::integer as pieces,
  sum(r.impressions)::integer as impressions,
  coalesce(sum(r.tracked_clicks), 0)::integer as tracked_clicks,
  coalesce(sum(r.leads), 0)::integer as leads,
  coalesce(sum(r.qualified_leads), 0)::integer as qualified_leads,
  coalesce(sum(r.customers), 0)::integer as customers,
  coalesce(sum(r.revenue), 0)::numeric(14, 2) as revenue,
  sum(r.spend)::numeric(14, 2) as spend,
  round(sum(r.spend) / nullif(sum(r.leads), 0), 2) as cpl,
  round(sum(r.spend) / nullif(sum(r.customers), 0), 2) as cpa,
  round(sum(r.revenue) / nullif(sum(r.spend), 0), 2) as roas
from public.v_content_results r
group by r.organization_id, r.client_id, r.channel;

-- Geografia: cidade do clique (geolocalização por IP da Vercel) e cidade do lead.
create or replace view public.v_location_results with (security_invoker = true) as
with clicks as (
  select organization_id, client_id,
         coalesce(nullif(trim(city), ''), '(sem cidade)') as city,
         coalesce(nullif(trim(region), ''), '') as state,
         count(*) as tracked_clicks
    from public.link_clicks
   where not is_bot
   group by 1, 2, 3, 4
),
lead_geo as (
  select organization_id, client_id,
         coalesce(nullif(trim(city), ''), '(sem cidade)') as city,
         coalesce(nullif(trim(state), ''), '') as state,
         count(*) as leads,
         count(*) filter (where qualified_at is not null) as qualified_leads,
         count(*) filter (where status = 'customer') as customers,
         coalesce(sum(revenue) filter (where status = 'customer'), 0) as revenue
    from public.leads
   where status <> 'spam'
   group by 1, 2, 3, 4
)
select
  coalesce(c.organization_id, l.organization_id) as organization_id,
  coalesce(c.client_id, l.client_id) as client_id,
  coalesce(c.city, l.city) as city,
  coalesce(c.state, l.state) as state,
  coalesce(c.tracked_clicks, 0)::integer as tracked_clicks,
  coalesce(l.leads, 0)::integer as leads,
  coalesce(l.qualified_leads, 0)::integer as qualified_leads,
  coalesce(l.customers, 0)::integer as customers,
  coalesce(l.revenue, 0)::numeric(14, 2) as revenue,
  round(l.leads::numeric / nullif(c.tracked_clicks, 0), 4) as lead_rate
from clicks c
full outer join lead_geo l
  on l.organization_id = c.organization_id and l.client_id = c.client_id and l.city = c.city and l.state = c.state;

grant select on public.v_content_results, public.v_content_scores, public.v_family_results,
                public.v_channel_results, public.v_location_results to authenticated;
revoke all on public.v_content_results, public.v_content_scores, public.v_family_results,
              public.v_channel_results, public.v_location_results from anon;

notify pgrst, 'reload schema';
