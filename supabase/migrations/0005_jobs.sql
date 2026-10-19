-- 0005: job queue, extension devices, sales-scan cursors, per-item sync log, worker heartbeat.
-- Safe to run more than once (IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS). Additive only: no existing table is changed.
-- Every table carries user_id and per-owner RLS, like 0002. See docs: job-queue-extension-spec.md sections 2, 3A, 6, 6A.

-- ---------------------------------------------------------------- extension devices
-- A paired browser. Only the HASH of its token is stored. Pairing itself is built in a later step.
create table if not exists extension_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade default auth.uid(),
  label text not null,
  token_hash text not null unique,
  extension_version text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  last_poll_at timestamptz,
  last_ip_country text,
  revoked_at timestamptz,
  paused boolean not null default false          -- kill switch: a paused or revoked device claims nothing
);
create index if not exists extension_devices_user_idx on extension_devices (user_id, created_at desc);

-- Just the yes/no "is the user signed in on that marketplace, as the extension sees it". No cookies, no marketplace data.
create table if not exists extension_marketplace_state (
  device_id uuid not null references extension_devices(id) on delete cascade,
  marketplace marketplace not null,
  user_id uuid not null references profiles(id) on delete cascade default auth.uid(),
  logged_in boolean not null,
  checked_at timestamptz not null default now(),
  primary key (device_id, marketplace)
);

-- ---------------------------------------------------------------- jobs
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade default auth.uid(),
  item_id uuid references items(id) on delete set null,
  listing_id uuid references listings(id) on delete set null,
  marketplace marketplace not null,
  job_type text not null check (job_type in ('create_listing','update_listing','delist','mark_sold','sync_status')),
  executor text not null check (executor in ('api','extension')),
  status text not null default 'queued'
    check (status in ('queued','claimed','running','succeeded','retry_wait','failed','needs_user','canceled')),
  priority int not null default 10,               -- lower runs first: delist / mark_sold = 0, create / update = 10, sync = 20
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text,
  attempts int not null default 0,                -- counted when a worker claims the job
  max_attempts int not null default 5 check (max_attempts between 1 and 20),
  next_run_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  claimed_by_device uuid references extension_devices(id) on delete set null,
  last_error text,
  last_error_code text,
  result jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
-- Dedupe: one OPEN job per (user, idempotency key). A finished job frees the key.
create unique index if not exists jobs_idem_open_uq on jobs (user_id, idempotency_key)
  where idempotency_key is not null and status in ('queued','claimed','running','retry_wait','needs_user');
create index if not exists jobs_user_status_idx on jobs (user_id, status, created_at desc);
create index if not exists jobs_claim_idx on jobs (user_id, executor, priority, next_run_at) where status = 'queued';
create index if not exists jobs_lease_idx on jobs (lease_expires_at) where status in ('claimed','running');
create index if not exists jobs_retry_idx on jobs (next_run_at) where status = 'retry_wait';
create index if not exists jobs_item_idx on jobs (item_id, created_at desc);

-- The user-visible job log. Append-only.
create table if not exists job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade default auth.uid(),
  at timestamptz not null default now(),
  from_status text,
  to_status text not null,
  message text
);
create index if not exists job_events_job_idx on job_events (job_id, at);

-- ---------------------------------------------------------------- sales scan cursors (spec 3A)
-- One row per connection: scope_key is the connection id ("api") or "device:<id>". The server owns the position.
create table if not exists sales_scan_cursors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade default auth.uid(),
  marketplace marketplace not null,
  scope_key text not null default 'default',
  connection_id uuid references marketplace_connections(id) on delete cascade,
  device_id uuid references extension_devices(id) on delete cascade,
  cursor text,                                    -- opaque: last order id or timestamp
  last_scanned_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (user_id, marketplace, scope_key)
);

-- ---------------------------------------------------------------- per-item sync log (spec 6A). Append-only.
create table if not exists item_sync_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade default auth.uid(),
  item_id uuid references items(id) on delete set null,      -- null for e.g. a sale of an unknown item; kept when an item is deleted
  listing_id uuid references listings(id) on delete set null,
  marketplace marketplace,
  at timestamptz not null default now(),
  event text not null,
  source text not null default 'manual' check (source in ('api','extension','reconcile','manual')),
  job_id uuid references jobs(id) on delete set null,
  detail text,
  ref text                                        -- stable reference, e.g. "sale:<id>"; used to ignore a needs-action entry
);
create index if not exists item_sync_log_item_idx on item_sync_log (user_id, item_id, at desc);
create index if not exists item_sync_log_user_idx on item_sync_log (user_id, at desc);
create index if not exists item_sync_log_ref_idx on item_sync_log (user_id, ref) where ref is not null;

-- ---------------------------------------------------------------- worker heartbeat
create table if not exists worker_state (
  id text primary key default 'worker' check (id = 'worker'),
  last_run_at timestamptz,
  last_expired int not null default 0,
  last_requeued int not null default 0
);
insert into worker_state (id) values ('worker') on conflict do nothing;

-- ---------------------------------------------------------------- RLS
alter table extension_devices enable row level security;
alter table extension_marketplace_state enable row level security;
alter table jobs enable row level security;
alter table job_events enable row level security;
alter table sales_scan_cursors enable row level security;
alter table item_sync_log enable row level security;
alter table worker_state enable row level security;

drop policy if exists devices_all on extension_devices;
create policy devices_all on extension_devices for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists ext_state_all on extension_marketplace_state;
create policy ext_state_all on extension_marketplace_state for all using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from extension_devices d where d.id = device_id and d.user_id = auth.uid()));
drop policy if exists jobs_all on jobs;
create policy jobs_all on jobs for all using (user_id = auth.uid()) with check (
  user_id = auth.uid()
  and (item_id is null or exists (select 1 from items i where i.id = item_id and i.user_id = auth.uid()))
  and (listing_id is null or exists (select 1 from listings l where l.id = listing_id and l.user_id = auth.uid()))
);
drop policy if exists job_events_select on job_events;
create policy job_events_select on job_events for select using (user_id = auth.uid());
drop policy if exists job_events_insert on job_events;
create policy job_events_insert on job_events for insert with check (user_id = auth.uid());
drop policy if exists cursors_all on sales_scan_cursors;
create policy cursors_all on sales_scan_cursors for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists item_sync_log_select on item_sync_log;
create policy item_sync_log_select on item_sync_log for select using (user_id = auth.uid());
drop policy if exists item_sync_log_insert on item_sync_log;
create policy item_sync_log_insert on item_sync_log for insert with check (
  user_id = auth.uid()
  and (item_id is null or exists (select 1 from items i where i.id = item_id and i.user_id = auth.uid()))
  and (listing_id is null or exists (select 1 from listings l where l.id = listing_id and l.user_id = auth.uid()))
);
-- Append-only logs: users can read and add, never edit or delete (rows still go away with the account, by cascade).
revoke update, delete on job_events, item_sync_log from authenticated, anon;

-- The worker heartbeat is a single non-sensitive row: signed-in users read it, only job_maintenance() writes it.
drop policy if exists worker_state_select on worker_state;
create policy worker_state_select on worker_state for select to authenticated using (true);
revoke insert, update, delete on worker_state from authenticated, anon;
revoke all on worker_state from anon;

-- ---------------------------------------------------------------- atomic claim
-- SECURITY INVOKER on purpose: RLS and auth.uid() confine it to the caller's own jobs, so no privilege is borrowed.
-- FOR UPDATE SKIP LOCKED makes two simultaneous workers take different jobs. Order: priority (delist / mark_sold first),
-- then due time, then age. Lease = 10 minutes. The attempt is counted here. A paused or revoked device claims nothing.
create or replace function claim_jobs(p_executor text, p_device uuid default null, p_limit int default 1, p_now timestamptz default now())
returns setof jobs language plpgsql set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if p_executor not in ('api','extension') then raise exception 'bad_executor'; end if;
  if p_device is not null and not exists (
    select 1 from extension_devices d where d.id = p_device and d.user_id = auth.uid() and d.revoked_at is null and not d.paused
  ) then
    return;
  end if;
  return query
  with picked as (
    select j.id from jobs j
    where j.user_id = auth.uid() and j.status = 'queued' and j.executor = p_executor and j.next_run_at <= p_now
    order by j.priority, j.next_run_at, j.created_at
    limit greatest(p_limit, 0)
    for update skip locked
  ),
  upd as (
    update jobs j set status = 'claimed', attempts = j.attempts + 1, claimed_by_device = p_device,
      lease_expires_at = p_now + interval '10 minutes'
    from picked where j.id = picked.id
    returning j.*
  ),
  ev as (
    insert into job_events (job_id, user_id, from_status, to_status, message)
    select u.id, u.user_id, 'queued', 'claimed', 'Claimed (attempt ' || u.attempts || ' of ' || u.max_attempts || ')' from upd u
  )
  select u.* from upd u order by u.priority, u.next_run_at, u.created_at;
end $$;

-- Counts per status for the header badge and Jobs tabs (RLS limits it to the caller's rows; avoids the API's 1000-row cap).
create or replace function job_counts() returns table (status text, n bigint)
language sql stable set search_path = public as $$
  select j.status, count(*) from jobs j group by j.status
$$;

-- ---------------------------------------------------------------- worker maintenance (cron)
-- Expires leases (job back to the queue, or failed when out of attempts), moves due retry_wait jobs to queued,
-- and stamps worker_state. It only performs transitions that time alone would cause, and it takes no time argument,
-- so calling it early or repeatedly changes nothing. It is SECURITY DEFINER because the cron has no user session
-- (this project has no service-role key). The /api/cron/worker route is additionally protected by CRON_SECRET.
create or replace function job_maintenance()
returns table (leases_expired int, requeued int) language plpgsql security definer set search_path = public as $$
declare n_exp int := 0; n_req int := 0;
begin
  with locked as (
    select j.id, j.status as old_status from jobs j
    where j.status in ('claimed','running') and j.lease_expires_at is not null and j.lease_expires_at <= now()
    for update skip locked
  ),
  upd as (
    update jobs j set
      status = case when j.attempts >= j.max_attempts then 'failed' else 'queued' end,
      next_run_at = now(), lease_expires_at = null, claimed_by_device = null,
      last_error = 'Lease expired: the worker did not report back in time', last_error_code = 'lease_expired',
      finished_at = case when j.attempts >= j.max_attempts then now() else j.finished_at end
    from locked where j.id = locked.id
    returning j.id, j.user_id, j.status, j.attempts, j.max_attempts, locked.old_status
  ),
  ev as (
    insert into job_events (job_id, user_id, from_status, to_status, message)
    select u.id, u.user_id, u.old_status, u.status,
      case when u.status = 'failed' then 'Lease expired and no attempts left'
           else 'Lease expired, back in the queue (attempt ' || u.attempts || ' of ' || u.max_attempts || ' used)' end
    from upd u
  )
  select count(*) into n_exp from upd;

  with upd as (
    update jobs j set status = 'queued' where j.status = 'retry_wait' and j.next_run_at <= now()
    returning j.id, j.user_id
  ),
  ev as (
    insert into job_events (job_id, user_id, from_status, to_status, message)
    select u.id, u.user_id, 'retry_wait', 'queued', 'Retry is due, back in the queue' from upd u
  )
  select count(*) into n_req from upd;

  update worker_state set last_run_at = now(), last_expired = n_exp, last_requeued = n_req where id = 'worker';
  return query select n_exp, n_req;
end $$;
grant execute on function job_maintenance() to anon, authenticated;
