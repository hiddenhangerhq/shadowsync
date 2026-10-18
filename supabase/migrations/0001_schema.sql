-- ShadowSync schema. Every table carries user_id so the product can go multi-user later.
create extension if not exists "pgcrypto";

create type item_status as enum ('draft', 'listed', 'sold', 'delisted');
create type marketplace as enum ('ebay','poshmark','depop','whatnot','grailed','etsy','mercari','shopify','wix','other');
create type plan_id as enum ('free', 'starter', 'pro');
-- 'sheet-import' and 'email' are private legacy imports of the owner's existing data; the product never reads email.
create type data_source as enum ('api','extension','email','sheet-import','manual');
-- User-facing connection types only. Never store marketplace passwords; oauth tokens go in a separate locked-down table later.
create type connection_type as enum ('oauth_api','extension');
create type theme_id as enum ('system','light','dark','cyberpunk','retro','midnight','forest','sunset');

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- One profile per auth user.
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  plan plan_id not null default 'free',
  theme theme_id not null default 'system',
  created_at timestamptz not null default now()
);

-- Items mirror the GOLFTHRIFT Inventory columns where known:
-- SKU(B) Title(C) COGS(E) Date Listed(L) Date Sold(P) Price Sold(Q) Platform(R) Fees(T) Promo(U) Ship provider(V) Ship cost(W) Status.
create table items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade default auth.uid(),
  sku text,
  title text not null,
  description text,
  status item_status not null default 'draft',
  cogs numeric(10,2),
  purchase_location text,
  category text,
  brand text,
  size text,
  condition text,
  asking_price numeric(10,2),
  date_listed date,
  date_sold date,
  price_sold numeric(10,2),
  platform text,
  fees numeric(10,2),
  promo numeric(10,2),
  ship_provider text,
  ship_cost numeric(10,2),
  notes text,
  source data_source not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index items_user_sku_uq on items (user_id, sku) where sku is not null;
create index items_user_status_idx on items (user_id, status, created_at desc);
create trigger items_updated before update on items for each row execute function set_updated_at();

create table item_photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade default auth.uid(),
  item_id uuid not null references items(id) on delete cascade,
  path text not null,            -- storage path: {user_id}/{item_id}/{file}
  position int not null default 0,
  width int, height int, bytes int,
  created_at timestamptz not null default now()
);
create index item_photos_item_idx on item_photos (item_id, position);

-- One row per (marketplace, connection type): e.g. eBay can have both an oauth_api row and an extension row.
create table marketplace_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade default auth.uid(),
  marketplace marketplace not null,
  connection_type connection_type not null,
  account_label text,
  status text not null default 'connected' check (status in ('connected','needs_reauth','error','paused','disconnected')),
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (user_id, marketplace, connection_type)
);
-- Tokens/secrets are intentionally NOT stored here yet. A later step adds a separate, locked-down table.

create table listings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade default auth.uid(),
  item_id uuid not null references items(id) on delete cascade,
  marketplace marketplace not null,
  external_id text,
  url text,
  price numeric(10,2),
  status text not null default 'active' check (status in ('active','ended','sold','error')),
  listed_at timestamptz,
  ended_at timestamptz,
  source data_source not null default 'manual',
  created_at timestamptz not null default now(),
  unique (item_id, marketplace)
);

create table sales (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade default auth.uid(),
  item_id uuid references items(id) on delete set null,
  marketplace marketplace not null,
  order_id text,
  sold_at date not null,
  price numeric(10,2) not null,
  fees numeric(10,2),
  promo numeric(10,2),
  ship_provider text,
  ship_cost numeric(10,2),
  source data_source not null default 'manual',
  created_at timestamptz not null default now()
);
create unique index sales_order_uq on sales (user_id, marketplace, order_id) where order_id is not null;
create index sales_user_date_idx on sales (user_id, sold_at desc);

-- Detection events and failures (sale detected, duplicate skipped, delist done/failed, sync errors, legacy imports).
create table sync_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade default auth.uid(),
  marketplace marketplace,
  item_id uuid references items(id) on delete set null,
  source data_source,
  event text not null,
  level text not null default 'info' check (level in ('info','warn','error')),
  detail text,
  created_at timestamptz not null default now()
);
create index sync_log_user_idx on sync_log (user_id, created_at desc);
create index sync_log_errors_idx on sync_log (user_id, level, created_at desc) where level <> 'info';

-- Credits: balance = sum(amount). 'reset' rows set the balance to the plan allowance once per month.
create table credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade default auth.uid(),
  kind text not null check (kind in ('reset','spend','grant')),
  action text check (action in ('bg_removal','description','listing_create')),
  amount int not null,
  period text,                   -- YYYY-MM for resets
  note text,
  created_at timestamptz not null default now()
);
create unique index credit_reset_period_uq on credit_ledger (user_id, period) where kind = 'reset';
create index credit_user_idx on credit_ledger (user_id, created_at desc);

-- Create a profile automatically when someone signs up.
create or replace function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email) values (new.id, coalesce(new.email, ''));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

-- Atomic credit functions. SECURITY DEFINER because users cannot insert into credit_ledger directly;
-- both functions only ever act on auth.uid(), so a user can only touch their own ledger.
create or replace function plan_allowance(p plan_id) returns int language sql immutable as $$
  select case p when 'free' then 25 when 'starter' then 150 when 'pro' then 600 end $$;

create or replace function ensure_monthly_allowance(p_period text) returns int
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); bal int; pl plan_id;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  perform 1 from profiles where id = uid for update;   -- serialize per user
  if not exists (select 1 from credit_ledger where user_id = uid and kind = 'reset' and period = p_period) then
    select plan into pl from profiles where id = uid;
    select coalesce(sum(amount),0) into bal from credit_ledger where user_id = uid;
    insert into credit_ledger (user_id, kind, amount, period, note)
      values (uid, 'reset', plan_allowance(pl) - bal, p_period, 'Monthly allowance (' || pl || ')');
  end if;
  select coalesce(sum(amount),0) into bal from credit_ledger where user_id = uid;
  return bal;
end $$;

create or replace function spend_credits(p_action text, p_cost int, p_note text default null) returns int
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); bal int;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if p_cost <= 0 then raise exception 'cost must be positive'; end if;
  perform 1 from profiles where id = uid for update;
  select coalesce(sum(amount),0) into bal from credit_ledger where user_id = uid;
  if bal < p_cost then raise exception 'insufficient_credits'; end if;
  insert into credit_ledger (user_id, kind, action, amount, note) values (uid, 'spend', p_action, -p_cost, p_note);
  return bal - p_cost;
end $$;

revoke all on function ensure_monthly_allowance(text), spend_credits(text,int,text) from public, anon;
grant execute on function ensure_monthly_allowance(text), spend_credits(text,int,text) to authenticated;
