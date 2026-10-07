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
--   * Toda relação é UMA FK composta por par de tabelas (agência + cliente na mesma FK),
--     mesma regra da migration anterior — o PostgREST recusa embed com 2 FKs no mesmo par.
--   * Clique e histórico de lead são append-only: não mudam e não somem por cascata de
--     link; só saem junto com o cliente/agência inteiro (ou com o lead, no caso do histórico).
--   * Códigos legíveis (CF-, C-, LD-) são SEMPRE do banco: valor enviado é ignorado.

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
-- 0.1 CHAVE-ALVO de agência + cliente nas peças (links e leads apontam para ela)
-- ============================================================
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.content_items'::regclass and conname = 'content_items_org_client_id_uq') then
    alter table public.content_items add constraint content_items_org_client_id_uq unique (organization_id, client_id, id);
  end if;
end $$;

-- ============================================================
-- 1. FAMÍLIA DE CONTEÚDO — o conceito que vira várias peças
-- ============================================================
create table if not exists public.content_families (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null,
  campaign_id uuid,
  code text not null default '',
  concept text not null check (char_length(trim(concept)) between 3 and 300),
  hypothesis text,
  origin text not null default 'manual' check (origin in ('ai', 'manual', 'recycled')),
  parent_family_id uuid,
  status text not null default 'active' check (status in ('active', 'winner', 'retired')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_families_org_code_uq unique (organization_id, code),
  constraint content_families_org_client_id_uq unique (organization_id, client_id, id),
  check (parent_family_id is null or parent_family_id <> id)
);

-- Campanha e família-mãe da MESMA agência e do MESMO cliente.
alter table public.content_families
  drop constraint if exists content_families_client_tfk,
  drop constraint if exists content_families_campaign_tfk,
  drop constraint if exists content_families_parent_tfk;
alter table public.content_families
  add constraint content_families_client_tfk foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade,
  add constraint content_families_campaign_tfk foreign key (organization_id, client_id, campaign_id) references public.campaigns (organization_id, client_id, id) on delete set null (campaign_id),
  add constraint content_families_parent_tfk foreign key (organization_id, client_id, parent_family_id) references public.content_families (organization_id, client_id, id) on delete set null (parent_family_id);

create index if not exists content_families_client_idx on public.content_families(client_id, created_at desc);
create index if not exists content_families_campaign_idx on public.content_families(campaign_id) where campaign_id is not null;

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

alter table public.content_items drop constraint if exists content_items_family_tfk;
alter table public.content_items
  add constraint content_items_family_tfk foreign key (organization_id, client_id, family_id) references public.content_families (organization_id, client_id, id) on delete set null (family_id);

create index if not exists content_items_family_idx on public.content_items(family_id) where family_id is not null;

-- Backfill das peças já existentes SEM mexer no updated_at delas:
--   * código público na ordem de criação, por agência;
--   * peça já publicada ganha published_at = data agendada (ou a última atualização).
alter table public.content_items disable trigger content_items_set_updated_at;

with numeradas as (
  select id, row_number() over (partition by organization_id order by created_at, id) as n
  from public.content_items
  where public_code is null
)
update public.content_items ci
   set public_code = 'C-' || lpad(numeradas.n::text, 5, '0')
  from numeradas
 where ci.id = numeradas.id;

update public.content_items
   set published_at = coalesce(scheduled_at, updated_at)
 where status = 'published' and published_at is null;

alter table public.content_items enable trigger content_items_set_updated_at;

insert into public.organization_sequences (organization_id, key, next_value)
select organization_id, 'content', count(*) + 1 from public.content_items group by organization_id
on conflict (organization_id, key) do update set next_value = greatest(public.organization_sequences.next_value, excluded.next_value);

alter table public.content_items alter column public_code set not null;
alter table public.content_items drop constraint if exists content_items_public_code_uq;
alter table public.content_items add constraint content_items_public_code_uq unique (organization_id, public_code);

-- Código: SEMPRE gerado no INSERT (valor enviado é ignorado — um código digitado à mão
-- colidiria com a sequência da agência) e imutável no UPDATE.
-- published_at: carimbado só na TRANSIÇÃO para 'published' (editar a legenda de uma peça
-- publicada não muda a data de publicação).
create or replace function public.content_items_assign_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.public_code := public.next_org_code(new.organization_id, 'content', 'C-', 5);
    if new.status = 'published' and new.published_at is null then
      new.published_at := now();
    end if;
  else
    new.public_code := old.public_code;
    if new.status = 'published' and old.status is distinct from 'published' and new.published_at is null then
      new.published_at := now();
    end if;
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
  if tg_op = 'INSERT' then
    new.code := public.next_org_code(new.organization_id, 'family', 'CF-', 5);
  else
    new.code := old.code;
  end if;
  return new;
end;
$$;

drop trigger if exists content_families_assign_code on public.content_families;
create trigger content_families_assign_code before insert or update on public.content_families
for each row execute function public.content_families_assign_code();

-- ============================================================
-- 3. LINK RASTREÁVEL — uma URL curta por peça e canal
-- ============================================================
create table if not exists public.tracking_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null,
  content_item_id uuid,
  campaign_id uuid,
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
  -- Link com cliques não é apagado: desativa-se (active = false).
  active boolean not null default true,
  expires_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (mode = 'form' or destination_url is not null),
  constraint tracking_links_org_client_id_uq unique (organization_id, client_id, id)
);

-- Peça e campanha da MESMA agência e do MESMO cliente.
alter table public.tracking_links
  drop constraint if exists tracking_links_client_tfk,
  drop constraint if exists tracking_links_item_tfk,
  drop constraint if exists tracking_links_campaign_tfk;
alter table public.tracking_links
  add constraint tracking_links_client_tfk foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade,
  add constraint tracking_links_item_tfk foreign key (organization_id, client_id, content_item_id) references public.content_items (organization_id, client_id, id) on delete set null (content_item_id),
  add constraint tracking_links_campaign_tfk foreign key (organization_id, client_id, campaign_id) references public.campaigns (organization_id, client_id, id) on delete set null (campaign_id);

create index if not exists tracking_links_client_idx on public.tracking_links(client_id, created_at desc);
create index if not exists tracking_links_item_idx on public.tracking_links(content_item_id) where content_item_id is not null;
create index if not exists tracking_links_campaign_idx on public.tracking_links(campaign_id) where campaign_id is not null;

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
  client_id uuid not null,
  link_id uuid not null,
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
  -- Alvo da FK do lead: garante que o clique é do MESMO link, cliente e agência do lead.
  constraint link_clicks_org_client_link_id_uq unique (organization_id, client_id, link_id, id)
);

-- Cliente: cascata (apagar o cliente leva os cliques dele).
-- Link: NO ACTION — link com clique NÃO pode ser apagado (o clique é a prova da origem);
-- a checagem é no fim do comando, então apagar o cliente/agência inteiro continua valendo.
alter table public.link_clicks
  drop constraint if exists link_clicks_client_tfk,
  drop constraint if exists link_clicks_link_tfk;
alter table public.link_clicks
  add constraint link_clicks_client_tfk foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade,
  add constraint link_clicks_link_tfk foreign key (organization_id, client_id, link_id) references public.tracking_links (organization_id, client_id, id);

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

-- DELETE em tabela append-only só acontece quando o DONO do registro deixou de existir
-- (cascata de apagar o cliente, a agência ou — no histórico — o próprio lead).
-- DELETE direto (usuário, service_role, bug) é recusado.
create or replace function public.link_clicks_block_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.organizations o where o.id = old.organization_id)
     or not exists (select 1 from public.clients c where c.id = old.client_id) then
    return old;   -- cascata de apagar a agência ou o cliente
  end if;
  raise exception 'link_clicks é append-only: registro não pode ser apagado' using errcode = '42501';
end;
$$;

drop trigger if exists link_clicks_append_only on public.link_clicks;
create trigger link_clicks_append_only before update on public.link_clicks
for each row execute function public.block_update();
drop trigger if exists link_clicks_no_delete on public.link_clicks;
create trigger link_clicks_no_delete before delete on public.link_clicks
for each row execute function public.link_clicks_block_delete();

-- Mensagem clara para quem tenta apagar link com clique (a FK recusaria de qualquer forma).
create or replace function public.tracking_links_before_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Cascata de apagar o cliente/agência: o dono já não existe, os cliques vão junto.
  if exists (select 1 from public.organizations o where o.id = old.organization_id)
     and exists (select 1 from public.clients c where c.id = old.client_id)
     and exists (select 1 from public.link_clicks lc where lc.link_id = old.id) then
    raise exception 'O link % já tem cliques registrados e não pode ser apagado: desative-o (active = false).', old.slug
      using errcode = '23503';
  end if;
  return old;
end;
$$;

drop trigger if exists tracking_links_before_delete on public.tracking_links;
create trigger tracking_links_before_delete before delete on public.tracking_links
for each row execute function public.tracking_links_before_delete();

-- Link com clique não muda de peça, de slug nem de cliente: as views atribuem os cliques
-- pela peça ATUAL do link, então trocar a peça reescreveria o histórico (os cliques de A
-- passariam para B). Para outra peça, crie outro link. Exceção: a peça apagada zera o
-- vínculo (SET NULL da FK), e isso é permitido.
create or replace function public.tracking_links_lock_after_clicks()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (new.slug is distinct from old.slug
      or new.client_id is distinct from old.client_id
      or (new.content_item_id is distinct from old.content_item_id and new.content_item_id is not null))
     and exists (select 1 from public.link_clicks where link_id = old.id) then
    raise exception 'Este link já tem cliques: não dá para trocar a peça, o endereço ou o cliente. Crie um link novo.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists tracking_links_lock_after_clicks on public.tracking_links;
create trigger tracking_links_lock_after_clicks before update of slug, client_id, content_item_id on public.tracking_links
for each row execute function public.tracking_links_lock_after_clicks();

-- ============================================================
-- 5. LEAD — do contato à receita
-- ============================================================
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null,
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
  -- Calculada SEMPRE pelo banco (valor enviado é ignorado):
  --   click         = clique rastreado comprovado (click_id preenchido)
  --   link_no_click = veio por um link nosso, mas sem clique registrado (ex.: lead manual com link)
  --   self_reported = "como nos conheceu"
  --   unknown       = sem origem
  attribution text not null default 'unknown',
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
  constraint leads_org_id_uq unique (organization_id, id)
);

alter table public.leads drop constraint if exists leads_attribution_check;
alter table public.leads add constraint leads_attribution_check
  check (attribution in ('click', 'link_no_click', 'self_reported', 'unknown'));
-- Coerência mínima mesmo se o trigger for desligado: 'click' exige clique.
alter table public.leads drop constraint if exists leads_attribution_click_check;
alter table public.leads add constraint leads_attribution_click_check
  check ((attribution = 'click') = (click_id is not null));

-- Toda origem da MESMA agência e do MESMO cliente; o clique é do MESMO link do lead.
alter table public.leads
  drop constraint if exists leads_client_tfk,
  drop constraint if exists leads_link_tfk,
  drop constraint if exists leads_click_tfk,
  drop constraint if exists leads_item_tfk,
  drop constraint if exists leads_campaign_tfk,
  drop constraint if exists leads_family_tfk;
alter table public.leads
  add constraint leads_client_tfk foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade,
  add constraint leads_link_tfk foreign key (organization_id, client_id, link_id) references public.tracking_links (organization_id, client_id, id) on delete set null (link_id),
  add constraint leads_click_tfk foreign key (organization_id, client_id, link_id, click_id) references public.link_clicks (organization_id, client_id, link_id, id) on delete set null (click_id),
  add constraint leads_item_tfk foreign key (organization_id, client_id, content_item_id) references public.content_items (organization_id, client_id, id) on delete set null (content_item_id),
  add constraint leads_campaign_tfk foreign key (organization_id, client_id, campaign_id) references public.campaigns (organization_id, client_id, id) on delete set null (campaign_id),
  add constraint leads_family_tfk foreign key (organization_id, client_id, family_id) references public.content_families (organization_id, client_id, id) on delete set null (family_id);

create unique index if not exists leads_code_uq on public.leads(organization_id, lead_code);
create index if not exists leads_client_time_idx on public.leads(client_id, created_at desc);
create index if not exists leads_item_idx on public.leads(content_item_id) where content_item_id is not null;
create index if not exists leads_link_idx on public.leads(link_id) where link_id is not null;
create index if not exists leads_click_idx on public.leads(click_id) where click_id is not null;
create index if not exists leads_ip_time_idx on public.leads(ip_hash, created_at desc) where ip_hash is not null;

-- Cadeia de atribuição + funil. Regras (INSERT e UPDATE):
--   * lead_code: sempre gerado no INSERT; imutável.
--   * Prova de clique (click_id) só nasce em gravação do SERVIDOR (rota pública com
--     service_role, sem usuário logado). Lead digitado por usuário nunca vira 'click'.
--   * Com link: a peça é SEMPRE a do link; campanha/canal vêm do link quando ele tem.
--   * Origem (link_id / click_id) não pode ser trocada depois de gravada — só desligada
--     (vira NULL, ex.: quando o link é apagado).
--   * attribution é recalculada sempre; o valor enviado é ignorado.
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
  v_server boolean := auth.uid() is null;
begin
  if tg_op = 'INSERT' then
    new.lead_code := public.next_org_code(new.organization_id, 'lead', 'LD-', 5);

    if not v_server then
      new.click_id := null;
    end if;

    -- Clique informado sem link: o link é o do clique (a FK confere agência/cliente/link).
    if new.click_id is not null and new.link_id is null then
      select link_id into new.link_id from public.link_clicks where id = new.click_id;
      -- Clique inexistente não vira prova: sem link a FK não confere nada (MATCH SIMPLE).
      if new.link_id is null then
        new.click_id := null;
      end if;
    end if;

    if new.link_id is not null then
      select * into v_link from public.tracking_links where id = new.link_id;
      new.content_item_id := v_link.content_item_id;
      new.campaign_id := coalesce(v_link.campaign_id, new.campaign_id);
      new.channel := coalesce(v_link.channel, new.channel);
      new.utm_source := coalesce(new.utm_source, v_link.utm_source);
      new.utm_medium := coalesce(new.utm_medium, v_link.utm_medium);
      new.utm_campaign := coalesce(new.utm_campaign, v_link.utm_campaign);
      new.utm_content := coalesce(new.utm_content, v_link.utm_content);
      new.utm_term := coalesce(new.utm_term, v_link.utm_term);
    end if;

    -- Último clique deste visitante neste link (até 30 dias) = prova da origem.
    if v_server and new.click_id is null and new.link_id is not null and new.visitor_id is not null then
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

    if new.consent_marketing and new.consent_at is null then
      new.consent_at := now();
    end if;
  else
    new.lead_code := old.lead_code;

    if new.link_id is not null and new.link_id is distinct from old.link_id then
      raise exception 'A origem do lead (link) não pode ser alterada depois de gravada.' using errcode = '42501';
    end if;
    if new.click_id is not null and new.click_id is distinct from old.click_id then
      raise exception 'A origem do lead (clique) não pode ser alterada depois de gravada.' using errcode = '42501';
    end if;
    -- Sem link não há clique (o link foi apagado ou desligado).
    if new.link_id is null then
      new.click_id := null;
    end if;

    -- Trocar a peça de um lead que veio por link: continua sendo a peça do link.
    -- (NULL é aceito: é o que acontece quando a peça é apagada.)
    if new.link_id is not null and new.content_item_id is not null
       and new.content_item_id is distinct from old.content_item_id then
      select content_item_id into new.content_item_id from public.tracking_links where id = new.link_id;
    end if;
  end if;

  -- A peça define campanha e família (e o canal, se o link não definiu).
  if new.content_item_id is not null
     and (tg_op = 'INSERT' or new.content_item_id is distinct from old.content_item_id) then
    select campaign_id, family_id, channel into v_item from public.content_items where id = new.content_item_id;
    new.campaign_id := coalesce(v_item.campaign_id, new.campaign_id);
    new.family_id := coalesce(v_item.family_id, new.family_id);
    new.channel := coalesce(new.channel, v_item.channel);
  end if;

  new.attribution := case
    when new.click_id is not null then 'click'
    when new.link_id is not null then 'link_no_click'
    when nullif(trim(coalesce(new.self_reported_source, '')), '') is not null then 'self_reported'
    else 'unknown'
  end;

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
-- actor_id SEM FK para auth.users de propósito: o histórico é imutável e não pode impedir
-- que um usuário seja apagado (uma FK "on delete set null" faria um UPDATE no histórico).
-- Apagar o LEAD (ação de manager) leva o histórico junto: o histórico pertence ao lead.
create table if not exists public.lead_status_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null,
  from_status text,
  to_status text not null,
  revenue numeric(14, 2),
  actor_id uuid,
  created_at timestamptz not null default now()
);

alter table public.lead_status_history
  drop constraint if exists lead_status_history_actor_id_fkey,
  drop constraint if exists lead_status_history_lead_id_fkey,
  drop constraint if exists lead_status_history_lead_tfk;
alter table public.lead_status_history
  add constraint lead_status_history_lead_tfk foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade;
create index if not exists lead_status_history_lead_idx on public.lead_status_history(lead_id, created_at);

drop trigger if exists lead_status_history_append_only on public.lead_status_history;
create trigger lead_status_history_append_only before update on public.lead_status_history
for each row execute function public.block_update();
create or replace function public.lead_status_history_block_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.organizations o where o.id = old.organization_id)
     or not exists (select 1 from public.leads l where l.id = old.lead_id) then
    return old;   -- cascata de apagar a agência, o cliente ou o próprio lead
  end if;
  raise exception 'lead_status_history é append-only: registro não pode ser apagado' using errcode = '42501';
end;
$$;

drop trigger if exists lead_status_history_no_delete on public.lead_status_history;
create trigger lead_status_history_no_delete before delete on public.lead_status_history
for each row execute function public.lead_status_history_block_delete();

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
  foreach t in array array['content_families', 'tracking_links', 'link_clicks', 'leads', 'lead_status_history']
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
-- 9. LIMITE DE ENVIOS ATÔMICO (rotas públicas: lead, clique)
--    EXCEÇÃO à regra "toda tabela tem organization_id": rate_limit_counters NÃO é dado
--    da agência — é um contador técnico por "balde" (ex.: 'lead:ip:<hash>',
--    'lead:link:<id>'). RLS ligada SEM policies e sem grant: ninguém lê nem grava direto;
--    só a função abaixo (SECURITY DEFINER), que só o service_role executa.
--    Janela FIXA alinhada ao relógio (floor(epoch / janela)): o INSERT ... ON CONFLICT
--    DO UPDATE é atômico, então requisições paralelas nunca passam do limite.
-- ============================================================
create table if not exists public.rate_limit_counters (
  bucket text not null check (char_length(bucket) between 1 and 200),
  window_start timestamptz not null,
  hits integer not null default 0 check (hits >= 0),
  primary key (bucket, window_start)
);
alter table public.rate_limit_counters enable row level security;
revoke all on public.rate_limit_counters from public, anon, authenticated;
create index if not exists rate_limit_counters_window_idx on public.rate_limit_counters(window_start);

create or replace function public.consume_rate_limit(p_bucket text, p_window_seconds integer, p_max integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz;
  v_hits integer;
begin
  if p_bucket is null or char_length(p_bucket) not between 1 and 200 then
    raise exception 'consume_rate_limit: bucket inválido' using errcode = '22023';
  end if;
  if p_window_seconds is null or p_window_seconds not between 1 and 86400 then
    raise exception 'consume_rate_limit: janela deve ter entre 1 e 86400 segundos' using errcode = '22023';
  end if;
  if p_max is null or p_max < 1 then
    raise exception 'consume_rate_limit: limite deve ser >= 1' using errcode = '22023';
  end if;

  v_window := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);

  insert into public.rate_limit_counters as r (bucket, window_start, hits)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1
  returning r.hits into v_hits;

  -- Limpeza oportunista (~1 em 50 chamadas): janelas com mais de 2 dias (a maior janela é 1 dia).
  if random() < 0.02 then
    delete from public.rate_limit_counters where window_start < clock_timestamp() - interval '2 days';
  end if;

  return v_hits <= p_max;
end;
$$;
revoke all on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;

-- ============================================================
-- 10. VIEWS DE RESULTADO (security_invoker: a RLS de quem consulta continua valendo)
-- Regra de exibição: divisão por zero = NULL ("sem dado"), nunca 0 inventado.
-- ============================================================
drop function if exists public.client_period_totals(uuid, timestamptz);
drop view if exists public.v_location_results, public.v_channel_results, public.v_family_results,
                    public.v_content_scores, public.v_content_results, public.v_metric_daily;

-- MÉTRICAS DA PLATAFORMA: UMA origem por (peça, dia). A mesma métrica pode chegar pela
-- API e ser digitada à mão no mesmo dia — somar as duas dobraria o número. Prioridade:
--   1º origem de API ('meta','tiktok','youtube','linkedin','pinterest','google')
--   2º 'manual'
--   (empate entre APIs: a linha atualizada por último)
-- impressions, engagement, cliques, views, tempo e spend: SOMA dos dias escolhidos.
-- reach: MAIOR valor diário — alcance NÃO é aditivo (a mesma pessoa aparece em vários
-- dias); somar dias inflaria o alcance. É uma estimativa por baixo do alcance real.
--
-- CLIQUES RASTREADOS: tracked_clicks = visitantes ÚNICOS humanos (não-robô), contados
-- por visitor_id; sem ele, pelo hash do IP; sem os dois, cada clique conta como um.
-- raw_clicks = total bruto de cliques humanos (recarregar a página conta de novo).
--
-- lead_rate = visitantes únicos que viraram lead com clique comprovado (attribution =
-- 'click', fora spam) ÷ tracked_clicks. Numerador ⊂ denominador: nunca passa de 100%.
-- Leads manuais/"como nos conheceu" contam em leads, mas não na taxa de conversão do clique.
-- Fonte única da regra "uma origem por (peça, dia)": usada por v_content_results e pelos
-- totais do período (client_period_totals). Não duplicar essa escolha em outro lugar.
create view public.v_metric_daily with (security_invoker = true) as
select distinct on (pm.content_item_id, pm.metric_date)
       pm.organization_id,
       ci.client_id,
       pm.content_item_id,
       pm.metric_date,
       pm.source,
       pm.impressions,
       pm.reach,
       pm.engagement,
       pm.clicks,
       pm.video_views,
       pm.watch_time_seconds,
       pm.spend
  from public.performance_metrics pm
  join public.content_items ci on ci.id = pm.content_item_id
 order by pm.content_item_id, pm.metric_date, (pm.source = 'manual'), pm.updated_at desc, pm.id;

create view public.v_content_results with (security_invoker = true) as
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
  round(cv.converted_visitors::numeric / nullif(c.tracked_clicks, 0), 4) as lead_rate,
  round(l.qualified::numeric / nullif(l.leads, 0), 4) as qualified_rate,
  round(l.customers::numeric / nullif(l.leads, 0), 4) as conversion_rate,
  round(m.spend / nullif(l.leads, 0), 2) as cpl,
  round(m.spend / nullif(l.customers, 0), 2) as cpa,
  round(l.revenue / nullif(m.spend, 0), 2) as roas,
  -- colunas adicionais (fim da lista para não mudar as anteriores)
  coalesce(c.raw_clicks, 0)::integer as raw_clicks,
  coalesce(l.click_leads, 0)::integer as click_leads,
  coalesce(m.metric_days, 0)::integer as metric_days
from public.content_items ci
left join public.content_families f on f.id = ci.family_id
left join lateral (
  select d.content_item_id,
         count(*) as metric_days,
         sum(d.impressions)::integer as impressions,
         max(d.reach)::integer as reach,
         sum(d.engagement)::integer as engagement,
         sum(d.clicks)::integer as platform_clicks,
         sum(d.video_views)::integer as video_views,
         sum(d.watch_time_seconds)::integer as watch_time_seconds,
         sum(d.spend)::numeric(14, 2) as spend
    from public.v_metric_daily d
   where d.content_item_id = ci.id
   group by d.content_item_id
) m on true
left join lateral (
  select count(distinct coalesce(lc.visitor_id::text, lc.ip_hash, lc.id::text)) as tracked_clicks,
         count(*) as raw_clicks
    from public.link_clicks lc
    join public.tracking_links tl on tl.id = lc.link_id
   where tl.content_item_id = ci.id and not lc.is_bot
) c on true
left join lateral (
  select count(distinct coalesce(lc.visitor_id::text, lc.ip_hash, lc.id::text)) as converted_visitors
    from public.leads ld
    join public.link_clicks lc on lc.id = ld.click_id
    join public.tracking_links tl on tl.id = lc.link_id
   where tl.content_item_id = ci.id and not lc.is_bot
     and ld.attribution = 'click' and ld.status <> 'spam'
) cv on true
left join lateral (
  select count(*) as leads,
         count(*) filter (where ld.attribution = 'click') as click_leads,
         count(*) filter (where ld.qualified_at is not null) as qualified,
         count(*) filter (where ld.status = 'customer') as customers,
         coalesce(sum(ld.revenue) filter (where ld.status = 'customer'), 0) as revenue
    from public.leads ld
   where ld.content_item_id = ci.id and ld.status <> 'spam'
) l on true;

-- Score relativo ao histórico do PRÓPRIO cliente (últimos 90 dias).
-- Cada indicador é dividido pelo MELHOR valor do cliente no período (0 a 1) e somado com
-- pesos — receita, clientes e leads qualificados pesam mais (prioridade do Master Prompt):
--   receita 35 · clientes 25 · qualificados 15 · leads 15 · CTR 5 · alcance 5
-- Indicador em que NENHUMA peça do cliente pontuou (melhor = 0) sai da conta: a nota é
-- normalizada pela soma dos pesos que sobraram (sem receita lançada, a melhor peça ainda
-- pode tirar S). Sem nenhum indicador de NEGÓCIO (receita, clientes, qualificados, leads)
-- com melhor > 0 → "insufficient_data" (alcance/CTR sozinhos não dão nota).
-- Amostra mínima: sem 3 leads, 30 cliques rastreados ou 1.000 impressões → "insufficient_data";
-- e com menos de 5 peças medidas no cliente não existe comparação → "insufficient_data".
create view public.v_content_scores with (security_invoker = true) as
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
weights as (
  select x.*,
         (x.revenue > 0 or x.customers > 0 or x.qualified > 0 or x.leads > 0) as has_business_signal,
         (case when x.revenue   > 0 then 0.35 else 0 end
        + case when x.customers > 0 then 0.25 else 0 end
        + case when x.qualified > 0 then 0.15 else 0 end
        + case when x.leads     > 0 then 0.15 else 0 end
        + case when x.ctr       > 0 then 0.05 else 0 end
        + case when x.reach     > 0 then 0.05 else 0 end) as weight_total
    from best x
),
scored as (
  select b.*,
         coalesce(w.scored_items, 0) as scored_items,
         case when b.sufficient and w.has_business_signal then
           round(100 * (
               case when w.revenue   > 0 then 0.35 * b.revenue / w.revenue else 0 end
             + case when w.customers > 0 then 0.25 * b.customers::numeric / w.customers else 0 end
             + case when w.qualified > 0 then 0.15 * b.qualified_leads::numeric / w.qualified else 0 end
             + case when w.leads     > 0 then 0.15 * b.leads::numeric / w.leads else 0 end
             + case when w.ctr       > 0 then 0.05 * coalesce(b.ctr, 0) / w.ctr else 0 end
             + case when w.reach     > 0 then 0.05 * coalesce(b.reach, 0)::numeric / w.reach else 0 end
           ) / w.weight_total, 1)
         end as score
    from base b
    left join weights w on w.client_id = b.client_id
)
select
  scored.*,
  case
    when not scored.sufficient then 'insufficient_data'
    when scored.scored_items < 5 then 'insufficient_data'   -- ranking com menos de 5 peças medidas não diz nada
    when scored.score is null then 'insufficient_data'      -- nenhum indicador de negócio no cliente
    when scored.score >= 85 then 'S'
    when scored.score >= 70 then 'A'
    when scored.score >= 50 then 'B'
    when scored.score >= 30 then 'C'
    when scored.score >= 15 then 'D'
    else 'F'
  end as tier
from scored;

-- Família e canal: somam as peças (tracked_clicks = soma dos visitantes únicos de cada peça).
create view public.v_family_results with (security_invoker = true) as
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
  round(sum(r.revenue) / nullif(sum(r.spend), 0), 2) as roas,
  coalesce(sum(r.raw_clicks), 0)::integer as raw_clicks
from public.content_families f
left join public.v_content_results r on r.family_id = f.id
group by f.organization_id, f.client_id, f.id, f.code, f.concept, f.origin, f.status;

create view public.v_channel_results with (security_invoker = true) as
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
  round(sum(r.revenue) / nullif(sum(r.spend), 0), 2) as roas,
  coalesce(sum(r.raw_clicks), 0)::integer as raw_clicks
from public.v_content_results r
group by r.organization_id, r.client_id, r.channel;

-- Geografia: cidade do clique (geolocalização por IP da Vercel) e cidade do lead.
-- tracked_clicks = visitantes únicos humanos na cidade; lead_rate = desses visitantes,
-- quantos viraram lead com clique comprovado (nunca passa de 100%).
create view public.v_location_results with (security_invoker = true) as
with clicks as (
  select lc.organization_id, lc.client_id,
         coalesce(nullif(trim(lc.city), ''), '(sem cidade)') as city,
         coalesce(nullif(trim(lc.region), ''), '') as state,
         count(distinct coalesce(lc.visitor_id::text, lc.ip_hash, lc.id::text)) as tracked_clicks,
         count(*) as raw_clicks,
         count(distinct coalesce(lc.visitor_id::text, lc.ip_hash, lc.id::text)) filter (
           where exists (
             select 1 from public.leads ld
              where ld.click_id = lc.id and ld.attribution = 'click' and ld.status <> 'spam'
           )
         ) as converted_visitors
    from public.link_clicks lc
   where not lc.is_bot
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
  round(c.converted_visitors::numeric / nullif(c.tracked_clicks, 0), 4) as lead_rate,
  coalesce(c.raw_clicks, 0)::integer as raw_clicks
from clicks c
full outer join lead_geo l
  on l.organization_id = c.organization_id and l.client_id = c.client_id and l.city = c.city and l.state = c.state;

-- TOTAIS DO PERÍODO do cliente (cards do topo da aba Resultados). O banco calcula tudo,
-- com as mesmas regras das views: métricas = uma origem por (peça, dia) (v_metric_daily);
-- cliques = visitantes únicos humanos; lead_rate = visitantes que viraram lead com clique
-- comprovado ÷ cliques; spam fora; divisão por zero = NULL ("sem dado").
-- security invoker: a RLS de quem chama vale (outra agência recebe zeros/nulos).
create function public.client_period_totals(p_client_id uuid, p_since timestamptz)
returns table (
  tracked_clicks integer,
  raw_clicks integer,
  impressions integer,
  spend numeric(14, 2),
  leads integer,
  click_leads integer,
  qualified integer,
  customers integer,
  revenue numeric(14, 2),
  attributed_share numeric,
  lead_rate numeric,
  conversion_rate numeric,
  cpl numeric,
  cpa numeric,
  roas numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with c as (
    select count(distinct coalesce(lc.visitor_id::text, lc.ip_hash, lc.id::text)) as tracked_clicks,
           count(*) as raw_clicks
      from public.link_clicks lc
     where lc.client_id = p_client_id and not lc.is_bot and lc.clicked_at >= p_since
  ),
  cv as (
    select count(distinct coalesce(lc.visitor_id::text, lc.ip_hash, lc.id::text)) as converted_visitors
      from public.leads ld
      join public.link_clicks lc on lc.id = ld.click_id
     where ld.client_id = p_client_id and not lc.is_bot and lc.clicked_at >= p_since
       and ld.attribution = 'click' and ld.status <> 'spam' and ld.created_at >= p_since
  ),
  m as (
    select sum(d.impressions)::integer as impressions,
           sum(d.spend)::numeric(14, 2) as spend
      from public.v_metric_daily d
     where d.client_id = p_client_id and d.metric_date >= (p_since at time zone 'UTC')::date
  ),
  l as (
    select count(*) as leads,
           count(*) filter (where ld.attribution = 'click') as click_leads,
           count(*) filter (where ld.qualified_at is not null) as qualified,
           count(*) filter (where ld.status = 'customer') as customers,
           sum(ld.revenue) filter (where ld.status = 'customer') as revenue
      from public.leads ld
     where ld.client_id = p_client_id and ld.status <> 'spam' and ld.created_at >= p_since
  )
  select c.tracked_clicks::integer,
         c.raw_clicks::integer,
         m.impressions,
         m.spend,
         l.leads::integer,
         l.click_leads::integer,
         l.qualified::integer,
         l.customers::integer,
         coalesce(l.revenue, 0)::numeric(14, 2),
         round(l.click_leads::numeric / nullif(l.leads, 0), 4),
         round(cv.converted_visitors::numeric / nullif(c.tracked_clicks, 0), 4),
         round(l.customers::numeric / nullif(l.leads, 0), 4),
         round(m.spend / nullif(l.leads, 0), 2),
         round(m.spend / nullif(l.customers, 0), 2),
         round(coalesce(l.revenue, 0) / nullif(m.spend, 0), 2)
    from c, cv, m, l;
$$;

revoke all on function public.client_period_totals(uuid, timestamptz) from public, anon;
grant execute on function public.client_period_totals(uuid, timestamptz) to authenticated;

grant select on public.v_metric_daily, public.v_content_results, public.v_content_scores, public.v_family_results,
                public.v_channel_results, public.v_location_results to authenticated;
revoke all on public.v_metric_daily, public.v_content_results, public.v_content_scores, public.v_family_results,
              public.v_channel_results, public.v_location_results from anon;

notify pgrst, 'reload schema';
