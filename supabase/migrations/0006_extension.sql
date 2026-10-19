-- 0006: browser extension pairing + device-token API, per-marketplace kill switch, alert preferences.
-- Safe to run more than once (IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS). Additive only. Needs 0005.
-- Spec: job-queue-extension-spec.md sections 4 (pairing) and 5 (extension). No service-role key exists: the extension calls the
-- ext_* functions below with its RAW device token. Each one hashes it (sha256), finds a device that is not revoked (and not paused,
-- except ext_poll which still records the heartbeat), and touches ONLY that device's user's rows. They are SECURITY DEFINER so they
-- work without a user session; everything they do is spelled out here. Helpers starting with _ext_ are not callable by clients.

-- Marketplaces in the extension host table (Facebook and Vinted are new values; nothing below uses them in this same transaction).
alter type marketplace add value if not exists 'facebook';
alter type marketplace add value if not exists 'vinted';

-- ---------------------------------------------------------------- tables
-- One-time pairing codes (only the hash is stored). Valid 5 minutes, single use.
create table if not exists extension_pairings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade default auth.uid(),
  code_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  device_id uuid references extension_devices(id) on delete set null
);
create index if not exists extension_pairings_user_idx on extension_pairings (user_id, expires_at desc);

-- Kill switch per marketplace and device, plus the security-check streak (2 in a row = automatic pause).
alter table extension_marketplace_state add column if not exists paused boolean not null default false;
alter table extension_marketplace_state add column if not exists paused_reason text;
alter table extension_marketplace_state add column if not exists challenge_streak int not null default 0;

-- Settings > Alerts. SMS is a stored preference only: no provider is connected.
create table if not exists alert_prefs (
  user_id uuid primary key references profiles(id) on delete cascade default auth.uid(),
  sms_enabled boolean not null default false,
  phone text check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$'),
  updated_at timestamptz not null default now()
);

-- Request counters for the device API. No client can read or write it.
create table if not exists ext_rate (
  key text primary key,
  window_start timestamptz not null default now(),
  n int not null default 0
);

alter table extension_pairings enable row level security;
alter table alert_prefs enable row level security;
alter table ext_rate enable row level security;
drop policy if exists pairings_select on extension_pairings;
create policy pairings_select on extension_pairings for select using (user_id = auth.uid());
revoke insert, update, delete on extension_pairings from anon, authenticated;
revoke all on extension_pairings from anon;
drop policy if exists alert_prefs_all on alert_prefs;
create policy alert_prefs_all on alert_prefs for all using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on alert_prefs from anon;
revoke all on ext_rate from anon, authenticated;

-- ---------------------------------------------------------------- private helpers
create or replace function _ext_hash(t text) returns text language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(t, 'UTF8')), 'hex')
$$;
create or replace function _ext_marketplaces() returns text[] language sql immutable as $$
  select array['poshmark','facebook','depop','grailed','mercari','vinted']
$$;
-- Same host table as src/lib/ext/protocol.ts (isAllowedUrl).
create or replace function _ext_url_ok(p_marketplace text, p_url text) returns boolean language sql immutable as $$
  select case p_marketplace
    when 'poshmark' then p_url ~ '^https://poshmark\.com(/|$)'
    when 'facebook' then p_url ~ '^https://www\.facebook\.com(/?$|/marketplace(/|$|\?))'
    when 'depop' then p_url ~ '^https://www\.depop\.com(/|$)'
    when 'grailed' then p_url ~ '^https://www\.grailed\.com(/|$)'
    when 'mercari' then p_url ~ '^https://www\.mercari\.com(/|$)'
    when 'vinted' then p_url ~ '^https://www\.vinted\.com(/|$)'
    else false end
$$;

-- Fixed-window counter. Raising rolls the increment back, so a blocked caller stays blocked until the window ends.
create or replace function _ext_rate(p_key text, p_max int, p_window_s int) returns void
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  insert into ext_rate as e (key, window_start, n) values (p_key, now(), 1)
  on conflict (key) do update set
    n = case when e.window_start <= now() - make_interval(secs => p_window_s) then 1 else e.n + 1 end,
    window_start = case when e.window_start <= now() - make_interval(secs => p_window_s) then now() else e.window_start end
  returning n into v_n;
  if v_n > p_max then raise exception 'ext:rate_limited'; end if;
end $$;

-- Token -> device. Same rules as the mock (src/lib/data/mock.ts makeDeviceGateway). Limits: src/lib/ext/limits.ts.
create or replace function _ext_device(p_token text, p_allow_paused boolean default false) returns extension_devices
language plpgsql security definer set search_path = public as $$
declare d extension_devices;
begin
  if p_token is null or p_token !~ '^ssd_[A-Za-z0-9_-]{43}$' then raise exception 'ext:invalid_token'; end if;
  select * into d from extension_devices where token_hash = _ext_hash(p_token);
  if not found then raise exception 'ext:invalid_token'; end if;
  if d.revoked_at is not null then raise exception 'ext:device_revoked'; end if;
  if d.paused and not p_allow_paused then raise exception 'ext:device_paused'; end if;
  perform _ext_rate('device:' || d.id, 300, 600);
  return d;
end $$;

create or replace function _ext_event(p_job jobs, p_from text, p_to text, p_message text) returns void
language sql security definer set search_path = public as $$
  insert into job_events (job_id, user_id, from_status, to_status, message) values (p_job.id, p_job.user_id, p_from, p_to, p_message)
$$;

-- The device's own claimed/running job, locked. Anything else is "not your job".
create or replace function _ext_job(p_device extension_devices, p_job uuid) returns jobs
language plpgsql security definer set search_path = public as $$
declare j jobs;
begin
  select * into j from jobs where id = p_job and user_id = p_device.user_id and claimed_by_device = p_device.id and status in ('claimed','running') for update;
  if not found then raise exception 'ext:not_your_job'; end if;
  return j;
end $$;

create or replace function _ext_state(p_device extension_devices, p_marketplace text) returns extension_marketplace_state
language plpgsql security definer set search_path = public as $$
declare s extension_marketplace_state;
begin
  insert into extension_marketplace_state (device_id, marketplace, user_id, logged_in, checked_at)
  values (p_device.id, p_marketplace::marketplace, p_device.user_id, false, now())
  on conflict (device_id, marketplace) do nothing;
  select * into s from extension_marketplace_state where device_id = p_device.id and marketplace = p_marketplace::marketplace for update;
  return s;
end $$;

revoke execute on function _ext_hash(text), _ext_marketplaces(), _ext_url_ok(text, text), _ext_rate(text, int, int),
  _ext_device(text, boolean), _ext_event(jobs, text, text, text), _ext_job(extension_devices, uuid), _ext_state(extension_devices, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------- dashboard: pairing code (signed-in user)
-- For the signed-in user only (auth.uid()); direct inserts are revoked so the 5-minute expiry and the 5-open-codes cap always apply.
create or replace function ext_pair_start(p_code text) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v_exp timestamptz := now() + interval '5 minutes';
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if p_code is null or p_code !~ '^[0-9A-Z]{8}$' then raise exception 'ext:bad_request'; end if;
  if (select count(*) from extension_pairings where user_id = auth.uid() and used_at is null and expires_at > now()) >= 5 then
    raise exception 'ext:too_many_codes';
  end if;
  insert into extension_pairings (user_id, code_hash, expires_at) values (auth.uid(), encode(sha256(convert_to(p_code, 'UTF8')), 'hex'), v_exp);
  return v_exp;
end $$;
revoke execute on function ext_pair_start(text) from public, anon;
grant execute on function ext_pair_start(text) to authenticated;

-- ---------------------------------------------------------------- extension: pairing (no session, no token yet)
-- A wrong code does NOT raise (so the guess counter is kept); it answers {"error":"pairing_invalid"}.
create or replace function ext_pair_complete(p_code text, p_token text, p_label text, p_version text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p extension_pairings; v_id uuid; v_label text;
begin
  perform _ext_rate('pair', 30, 60);
  if p_token is null or p_token !~ '^ssd_[A-Za-z0-9_-]{43}$' or p_version is null or p_version !~ '^\d{1,3}\.\d{1,3}\.\d{1,3}$' then
    raise exception 'ext:bad_request';
  end if;
  if p_code is null or p_code !~ '^[0-9A-Z]{8}$' then return jsonb_build_object('error', 'pairing_invalid'); end if;
  select * into p from extension_pairings where code_hash = _ext_hash(p_code) and used_at is null and expires_at > now() for update;
  if not found then return jsonb_build_object('error', 'pairing_invalid'); end if;
  v_label := coalesce(nullif(left(btrim(coalesce(p_label, '')), 80), ''), 'Browser extension');
  insert into extension_devices (user_id, label, token_hash, extension_version, last_seen_at)
  values (p.user_id, v_label, _ext_hash(p_token), p_version, now()) returning id into v_id;
  update extension_pairings set used_at = now(), device_id = v_id where id = p.id;
  return jsonb_build_object('device_id', v_id, 'label', v_label);
end $$;

-- ---------------------------------------------------------------- extension: poll = heartbeat + signed-in states + claim
-- Claims at most one job per READY marketplace (signed in, not paused for this device, nothing already claimed by this device there),
-- delist / mark_sold first, at most p_limit (max 6). A paused device only records the heartbeat.
create or replace function ext_poll(p_token text, p_version text, p_states jsonb default '{}'::jsonb, p_ready text[] default '{}', p_limit int default 3)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d extension_devices; k text; v jsonb; n_req int := 0; n int; v_ids uuid[] := '{}';
begin
  d := _ext_device(p_token, true);
  if p_version is null or p_version !~ '^\d{1,3}\.\d{1,3}\.\d{1,3}$' then raise exception 'ext:bad_request'; end if;
  if jsonb_typeof(coalesce(p_states, '{}'::jsonb)) <> 'object' then raise exception 'ext:bad_request'; end if;
  update extension_devices set last_seen_at = now(), last_poll_at = now(), extension_version = p_version where id = d.id;

  for k, v in select * from jsonb_each(coalesce(p_states, '{}'::jsonb)) loop
    if not (k = any(_ext_marketplaces())) or jsonb_typeof(v) <> 'boolean' then raise exception 'ext:bad_request'; end if;
    insert into extension_marketplace_state (device_id, marketplace, user_id, logged_in, checked_at)
    values (d.id, k::marketplace, d.user_id, (v #>> '{}')::boolean, now())
    on conflict (device_id, marketplace) do update set logged_in = excluded.logged_in, checked_at = excluded.checked_at;
    if (v #>> '{}')::boolean then
      -- Signed in again: jobs that stopped because you were signed out go back in the queue (state machine: requeueAfterSignIn).
      with upd as (
        update jobs j set status = 'queued', attempts = 0, next_run_at = now(), finished_at = null, lease_expires_at = null, claimed_by_device = null
        where j.user_id = d.user_id and j.marketplace = k::marketplace and j.executor = 'extension' and j.status = 'needs_user'
          and j.last_error_code in ('signed_out', 'login_required')
        returning j.id, j.user_id
      ), ev as (
        insert into job_events (job_id, user_id, from_status, to_status, message)
        select u.id, u.user_id, 'needs_user', 'queued', 'You are signed in again, back in the queue' from upd u
      )
      select count(*) into n from upd;
      n_req := n_req + n;
    end if;
  end loop;

  if not d.paused then
    with ready as (
      select s.marketplace from extension_marketplace_state s
      where s.device_id = d.id and s.logged_in and not s.paused and s.marketplace::text = any(coalesce(p_ready, '{}'))
        and not exists (select 1 from jobs b where b.claimed_by_device = d.id and b.status in ('claimed','running') and b.marketplace = s.marketplace)
    ), firsts as (
      select distinct on (j.marketplace) j.id, j.priority, j.next_run_at, j.created_at
      from jobs j join ready r on r.marketplace = j.marketplace
      where j.user_id = d.user_id and j.status = 'queued' and j.executor = 'extension' and j.next_run_at <= now()
      order by j.marketplace, j.priority, j.next_run_at, j.created_at, j.id
    ), picked as (
      select f.id from firsts f order by f.priority, f.next_run_at, f.created_at, f.id limit least(greatest(coalesce(p_limit, 3), 0), 6)
    ), locked as (
      select j.id from jobs j join picked p on p.id = j.id where j.status = 'queued' for update of j skip locked
    ), upd as (
      update jobs j set status = 'claimed', attempts = j.attempts + 1, claimed_by_device = d.id, lease_expires_at = now() + interval '10 minutes'
      from locked l where j.id = l.id
      returning j.*
    ), ev as (
      insert into job_events (job_id, user_id, from_status, to_status, message)
      select u.id, u.user_id, 'queued', 'claimed', 'Claimed (attempt ' || u.attempts || ' of ' || u.max_attempts || ')' from upd u
    )
    select coalesce(array_agg(u.id), '{}') into v_ids from upd u;
  end if;

  return jsonb_build_object(
    'device', jsonb_build_object('id', d.id, 'label', d.label, 'paused', d.paused),
    'requeued', n_req,
    'marketplaces', coalesce((select jsonb_agg(jsonb_build_object('marketplace', s.marketplace, 'logged_in', s.logged_in, 'paused', s.paused, 'paused_reason', s.paused_reason) order by s.marketplace)
                              from extension_marketplace_state s where s.device_id = d.id), '[]'::jsonb),
    'jobs', coalesce((select jsonb_agg(jsonb_build_object(
        'job', to_jsonb(j),
        'listing', case when l.id is null then null else jsonb_build_object('external_id', l.external_id, 'url', l.url) end,
        'item', case when i.id is null then null else jsonb_build_object('title', i.title, 'description', i.description, 'asking_price', i.asking_price, 'brand', i.brand, 'size', i.size) end
      ) order by j.priority, j.next_run_at, j.created_at, j.id)
      from jobs j left join listings l on l.id = j.listing_id and l.user_id = j.user_id left join items i on i.id = j.item_id and i.user_id = j.user_id
      where j.id = any(v_ids)), '[]'::jsonb)
  );
end $$;

-- ---------------------------------------------------------------- extension: job lifecycle
create or replace function ext_job_start(p_token text, p_job uuid) returns jobs
language plpgsql security definer set search_path = public as $$
declare d extension_devices; j jobs;
begin
  d := _ext_device(p_token);
  j := _ext_job(d, p_job);
  if j.status <> 'claimed' then raise exception 'illegal_transition:%->running', j.status; end if;
  update jobs set status = 'running', started_at = coalesce(started_at, now()) where id = j.id returning * into j;
  perform _ext_event(j, 'claimed', 'running', 'Started');
  return j;
end $$;

create or replace function ext_job_progress(p_token text, p_job uuid, p_message text) returns void
language plpgsql security definer set search_path = public as $$
declare d extension_devices; j jobs;
begin
  d := _ext_device(p_token);
  j := _ext_job(d, p_job);
  if p_message is null or length(btrim(p_message)) = 0 then raise exception 'ext:bad_request'; end if;
  perform _ext_event(j, j.status, j.status, left(p_message, 300));
end $$;

create or replace function ext_job_extend(p_token text, p_job uuid) returns jobs
language plpgsql security definer set search_path = public as $$
declare d extension_devices; j jobs;
begin
  d := _ext_device(p_token);
  j := _ext_job(d, p_job);
  update jobs set lease_expires_at = now() + interval '10 minutes' where id = j.id returning * into j;
  perform _ext_event(j, j.status, j.status, 'Lease extended');
  return j;
end $$;

-- The result. The kind comes from the CODE with the same lists as state-machine.ts (outcomeFromError), so a device cannot pick
-- "retry" for an unknown error. Then the side effects of completeJob() (store-helpers.ts) and the 2-in-a-row automatic pause.
create or replace function ext_job_result(p_token text, p_job uuid, p_ok boolean, p_code text default null, p_message text default null, p_result jsonb default null)
returns jobs language plpgsql security definer set search_path = public as $$
declare
  d extension_devices; j jobs; s extension_marketplace_state; l listings;
  v_kind text; v_code text := lower(coalesce(p_code, 'action_failed')); v_msg text := left(coalesce(nullif(btrim(p_message), ''), 'Failed'), 500);
  v_wait interval; v_to text; v_from text; v_ext text; v_url text;
begin
  d := _ext_device(p_token);
  j := _ext_job(d, p_job);
  v_from := j.status;
  if p_result is not null and (jsonb_typeof(p_result) <> 'object' or length(p_result::text) > 2000) then raise exception 'ext:bad_request'; end if;
  if v_code !~ '^[a-z0-9_]{1,40}$' then raise exception 'ext:bad_request'; end if;
  if p_ok then v_kind := 'success';
  elsif v_code in ('signed_out','login_required','captcha','challenge','verification_required','reauth_required','unexpected_page','review_and_submit','listing_not_found','permission_missing') then v_kind := 'needs_user';
  elsif v_code in ('timeout','network','rate_limited','http_5xx','server_error','unavailable','deferred') or v_code ~ '^http_5\d\d$' then v_kind := 'transient';
  else v_kind := 'hard';
  end if;

  if v_kind = 'success' then
    if j.status <> 'running' then raise exception 'illegal_transition:%->succeeded', j.status; end if;
    update jobs set status = 'succeeded', lease_expires_at = null, claimed_by_device = null, result = p_result, finished_at = now(), last_error = null, last_error_code = null
      where id = j.id returning * into j;
    perform _ext_event(j, v_from, 'succeeded', 'Succeeded');
  elsif v_kind = 'hard' then
    update jobs set status = 'failed', lease_expires_at = null, claimed_by_device = null, finished_at = now(), last_error = v_msg, last_error_code = v_code
      where id = j.id returning * into j;
    perform _ext_event(j, v_from, 'failed', 'Failed: ' || v_msg);
  elsif v_kind = 'needs_user' then
    update jobs set status = 'needs_user', lease_expires_at = null, claimed_by_device = null, last_error = v_msg, last_error_code = v_code
      where id = j.id returning * into j;
    perform _ext_event(j, v_from, 'needs_user', 'Needs you: ' || v_msg);
  else
    if j.attempts >= j.max_attempts then
      update jobs set status = 'failed', lease_expires_at = null, claimed_by_device = null, last_error = v_msg, last_error_code = v_code, finished_at = now()
        where id = j.id returning * into j;
      perform _ext_event(j, v_from, 'failed', 'Failed after ' || j.attempts || ' attempts: ' || v_msg);
    else
      v_wait := case least(greatest(j.attempts, 1), 4) when 1 then interval '5 minutes' when 2 then interval '15 minutes' when 3 then interval '1 hour' else interval '4 hours' end;
      update jobs set status = 'retry_wait', lease_expires_at = null, claimed_by_device = null, last_error = v_msg, last_error_code = v_code, next_run_at = now() + v_wait
        where id = j.id returning * into j;
      perform _ext_event(j, v_from, 'retry_wait',
        'Attempt ' || j.attempts || ' failed (' || v_msg || '). Retrying in ' || round(extract(epoch from v_wait) / 60) || ' min');
    end if;
  end if;

  -- Side effects (completeJob in store-helpers.ts).
  if j.status = 'succeeded' and j.job_type in ('delist','mark_sold') and j.listing_id is not null and j.item_id is not null then
    update listings set status = case when j.job_type = 'mark_sold' then 'sold' else 'ended' end, ended_at = now()
      where id = j.listing_id and user_id = j.user_id and status = 'active';
    insert into item_sync_log (user_id, item_id, listing_id, marketplace, event, source, job_id, detail)
    values (j.user_id, j.item_id, j.listing_id, j.marketplace, case when j.job_type = 'mark_sold' then 'marked_sold' else 'delisted' end, j.executor, j.id, 'Confirmed by the worker');
  elsif j.status = 'succeeded' and j.job_type = 'create_listing' and j.item_id is not null and jsonb_typeof(p_result -> 'externalId') = 'string' then
    v_ext := left(p_result ->> 'externalId', 80);
    v_url := case when jsonb_typeof(p_result -> 'url') = 'string' and _ext_url_ok(j.marketplace::text, p_result ->> 'url') then left(p_result ->> 'url', 500) end;
    insert into listings (user_id, item_id, marketplace, external_id, url, status, listed_at, ended_at, source)
    values (j.user_id, j.item_id, j.marketplace, v_ext, v_url, 'active', now(), null, j.executor::data_source)
    on conflict (item_id, marketplace) do update set external_id = excluded.external_id, url = coalesce(excluded.url, listings.url),
      status = 'active', listed_at = coalesce(listings.listed_at, excluded.listed_at), ended_at = null, source = excluded.source
    returning * into l;
    insert into item_sync_log (user_id, item_id, listing_id, marketplace, event, source, job_id, detail)
    values (j.user_id, j.item_id, l.id, j.marketplace, 'listed', j.executor, j.id, 'Listed by the worker');
  elsif j.status = 'failed' then
    insert into item_sync_log (user_id, item_id, listing_id, marketplace, event, source, job_id, detail)
    values (j.user_id, j.item_id, j.listing_id, j.marketplace, case when j.job_type in ('delist','mark_sold') then 'delist_failed' else 'job_failed' end, j.executor, j.id, j.last_error);
  end if;

  -- Security-check streak: 2 in a row pauses this marketplace on this device. A success resets it. Signed out = not logged in.
  s := _ext_state(d, j.marketplace::text);
  if v_kind = 'success' then
    update extension_marketplace_state set challenge_streak = 0 where device_id = d.id and marketplace = j.marketplace;
  elsif v_kind = 'needs_user' and v_code in ('captcha','challenge','verification_required') then
    update extension_marketplace_state set challenge_streak = s.challenge_streak + 1,
      paused = case when s.challenge_streak + 1 >= 2 then true else paused end,
      paused_reason = case when s.challenge_streak + 1 >= 2 then 'Paused automatically after 2 security checks in a row. Solve it in your browser, then resume.' else paused_reason end
    where device_id = d.id and marketplace = j.marketplace;
  end if;
  if v_kind = 'needs_user' and v_code in ('signed_out','login_required') then
    update extension_marketplace_state set logged_in = false, checked_at = now() where device_id = d.id and marketplace = j.marketplace;
  end if;
  return j;
end $$;

-- ---------------------------------------------------------------- extension: sales scan with the server-held cursor (spec 3A)
create or replace function ext_scan_next(p_token text, p_marketplace text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d extension_devices; c sales_scan_cursors; v_scope text;
begin
  d := _ext_device(p_token);
  if not (p_marketplace = any(_ext_marketplaces())) then raise exception 'ext:bad_request'; end if;
  v_scope := 'device:' || d.id;
  -- First use: start at "now", so old sales are never replayed as new ones (initCursor in sale-detection.ts).
  insert into sales_scan_cursors (user_id, marketplace, scope_key, device_id, cursor, last_scanned_at, last_success_at)
  values (d.user_id, p_marketplace::marketplace, v_scope, d.id, to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), now(), now())
  on conflict (user_id, marketplace, scope_key) do nothing;
  select * into c from sales_scan_cursors where user_id = d.user_id and marketplace = p_marketplace::marketplace and scope_key = v_scope;
  return jsonb_build_object('marketplace', p_marketplace, 'scope_key', v_scope, 'cursor', c.cursor, 'limit', 50, 'overlap_hours', 24);
end $$;

-- Same rules as processScanReport() in sale-detection.ts, in ONE transaction: everything is stored, then the cursor moves.
-- On any error nothing of the report is kept, the cursor stays put, and the error is recorded on the cursor.
create or replace function ext_scan_report(p_token text, p_marketplace text, p_sales jsonb, p_next_cursor text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d extension_devices; v_scope text; s jsonb; v_order text; v_mp marketplace;
  before_sale sales; rec sales; v_item uuid; owner items; own listings; l listings;
  v_ref text; v_type text; v_exec text; v_key text; v_job jobs;
  n_stored int := 0; n_dup int := 0; n_jobs int := 0; n_unmatched int := 0; n_cancel int := 0; v_err text;
begin
  d := _ext_device(p_token);
  if not (p_marketplace = any(_ext_marketplaces())) then raise exception 'ext:bad_request'; end if;
  if jsonb_typeof(p_sales) <> 'array' or jsonb_array_length(p_sales) > 100 or length(p_sales::text) > 200000 then raise exception 'ext:bad_request'; end if;
  if p_next_cursor is not null and length(p_next_cursor) > 200 then raise exception 'ext:bad_request'; end if;
  v_mp := p_marketplace::marketplace;
  v_scope := 'device:' || d.id;
  begin
    for s in select e from jsonb_array_elements(p_sales) e order by e ->> 'soldAt', e ->> 'orderId' loop
      v_order := s ->> 'orderId';
      if v_order is null or length(v_order) > 80 or (s ->> 'soldAt') !~ '^\d{4}-\d{2}-\d{2}$' or jsonb_typeof(s -> 'price') <> 'number' then
        raise exception 'invalid sale in report';
      end if;
      select * into before_sale from sales where user_id = d.user_id and marketplace = v_mp and order_id = v_order;

      if coalesce((s ->> 'cancelled')::boolean, false) then
        v_ref := 'sale_cancelled:' || p_marketplace || ':' || v_order;
        if not exists (select 1 from item_sync_log where user_id = d.user_id and event = 'sale_cancelled' and ref = v_ref) then
          insert into item_sync_log (user_id, item_id, marketplace, event, source, ref, detail)
          values (d.user_id, before_sale.item_id, v_mp, 'sale_cancelled', 'extension', v_ref,
            'Order ' || v_order || ' on ' || p_marketplace || ' was cancelled' || case when before_sale.id is null then ' (we had not recorded it)' else '' end
            || '. Check whether the item should be relisted.');
          n_cancel := n_cancel + 1;
        end if;
        continue;
      end if;

      -- Match: the marketplace's listing id first, then SKU (matchItem).
      v_item := null;
      if nullif(s ->> 'externalListingId', '') is not null then
        select li.item_id into v_item from listings li join items it on it.id = li.item_id
        where li.user_id = d.user_id and li.marketplace = v_mp and li.external_id = s ->> 'externalListingId' limit 1;
      end if;
      if v_item is null and nullif(btrim(lower(s ->> 'sku')), '') is not null then
        select it.id into v_item from items it where it.user_id = d.user_id and btrim(lower(it.sku)) = btrim(lower(s ->> 'sku'))
        order by it.created_at desc, it.id desc limit 1;
      end if;

      -- Record (sales.record): extension is below api only. A trusted-or-equal source already there: only fill blanks.
      if before_sale.id is not null then
        if before_sale.source in ('api', 'extension') then
          update sales set sku = coalesce(sku, nullif(s ->> 'sku', '')), title = coalesce(title, nullif(s ->> 'title', '')),
            ship_by = coalesce(ship_by, (nullif(s ->> 'shipBy', ''))::date)
          where id = before_sale.id returning * into rec;
        else
          update sales set item_id = coalesce(v_item, before_sale.item_id), sold_at = (s ->> 'soldAt')::date, price = (s ->> 'price')::numeric,
            fees = (s ->> 'fees')::numeric, promo = null, ship_provider = null, ship_cost = null,
            sku = s ->> 'sku', title = s ->> 'title', ship_by = (s ->> 'shipBy')::date, source = 'extension'
          where id = before_sale.id returning * into rec;
        end if;
        n_dup := n_dup + 1;
      else
        insert into sales (user_id, item_id, marketplace, order_id, sold_at, price, fees, sku, title, ship_by, source)
        values (d.user_id, v_item, v_mp, v_order, (s ->> 'soldAt')::date, (s ->> 'price')::numeric, (s ->> 'fees')::numeric,
          s ->> 'sku', s ->> 'title', (s ->> 'shipBy')::date, 'extension')
        returning * into rec;
        n_stored := n_stored + 1;
      end if;

      owner := null;
      if rec.item_id is not null then select * into owner from items where id = rec.item_id and user_id = d.user_id; end if;
      if owner.id is null then
        if before_sale.id is null then
          n_unmatched := n_unmatched + 1;
          insert into item_sync_log (user_id, marketplace, event, source, ref, detail)
          values (d.user_id, v_mp, 'sale_unmatched', 'extension', 'unmatched_sale:' || rec.id, 'Sale on ' || p_marketplace || ' (order ' || v_order || ') matched no item');
        end if;
        continue;
      end if;

      if before_sale.id is null then
        insert into item_sync_log (user_id, item_id, marketplace, event, source, ref, detail)
        values (d.user_id, owner.id, v_mp, 'sale_detected', 'extension', 'sale:' || rec.id, 'Order ' || v_order || ' sold for ' || (s ->> 'price'));
      end if;
      if owner.status <> 'sold' then
        update items set status = 'sold', date_sold = coalesce(date_sold, (s ->> 'soldAt')::date), price_sold = coalesce(price_sold, (s ->> 'price')::numeric),
          platform = coalesce(platform, p_marketplace), updated_at = now()
        where id = owner.id;
      end if;
      update listings set status = 'sold', ended_at = now() where item_id = owner.id and user_id = d.user_id and marketplace = v_mp and status = 'active';

      -- One delist / mark_sold job per OTHER live listing (planDelistJobs). Any job ever made for (listing, sale) blocks a new one.
      for l in select * from listings where item_id = owner.id and user_id = d.user_id and status = 'active' and marketplace <> v_mp loop
        v_type := case when l.marketplace::text in ('poshmark','depop','grailed','mercari') then 'mark_sold' else 'delist' end;
        v_exec := case
          when exists (select 1 from marketplace_connections c where c.user_id = d.user_id and c.marketplace = l.marketplace and c.status <> 'disconnected' and c.connection_type = 'oauth_api') then 'api'
          when exists (select 1 from marketplace_connections c where c.user_id = d.user_id and c.marketplace = l.marketplace and c.status <> 'disconnected' and c.connection_type = 'extension') then 'extension'
          when l.marketplace::text in ('ebay','etsy','shopify','wix') then 'api' else 'extension' end;
        v_key := v_type || ':' || l.id || ':' || rec.id;
        if exists (select 1 from jobs where user_id = d.user_id and idempotency_key = v_key) then continue; end if;
        insert into jobs (user_id, item_id, listing_id, marketplace, job_type, executor, priority, payload, idempotency_key)
        values (d.user_id, owner.id, l.id, l.marketplace, v_type, v_exec, 0,
          jsonb_build_object('saleId', rec.id, 'soldOn', p_marketplace, 'externalId', l.external_id, 'url', l.url), v_key)
        returning * into v_job;
        perform _ext_event(v_job, null, 'queued', 'Queued');
        n_jobs := n_jobs + 1;
        insert into item_sync_log (user_id, item_id, listing_id, marketplace, event, source, job_id, detail)
        values (d.user_id, owner.id, l.id, l.marketplace, 'delist_queued', 'extension', v_job.id, v_type || ' queued because it sold on ' || p_marketplace);
      end loop;
    end loop;

    -- Only now, with every sale stored, does the cursor move.
    insert into sales_scan_cursors (user_id, marketplace, scope_key, device_id, cursor, last_scanned_at, last_success_at, last_error)
    values (d.user_id, v_mp, v_scope, d.id, p_next_cursor, now(), now(), null)
    on conflict (user_id, marketplace, scope_key) do update set cursor = coalesce(excluded.cursor, sales_scan_cursors.cursor),
      last_scanned_at = now(), last_success_at = now(), last_error = null;
  exception when others then
    v_err := sqlerrm;
    insert into sales_scan_cursors (user_id, marketplace, scope_key, device_id, last_scanned_at, last_error)
    values (d.user_id, v_mp, v_scope, d.id, now(), v_err)
    on conflict (user_id, marketplace, scope_key) do update set last_scanned_at = now(), last_error = excluded.last_error;
    return jsonb_build_object('ok', false, 'stored', 0, 'duplicates', 0, 'jobs_created', 0, 'unmatched', 0, 'cancelled', 0, 'cursor_advanced', false, 'error', v_err);
  end;
  return jsonb_build_object('ok', true, 'stored', n_stored, 'duplicates', n_dup, 'jobs_created', n_jobs, 'unmatched', n_unmatched, 'cancelled', n_cancel, 'cursor_advanced', true);
end $$;

-- The device API is for the extension (anon key + device token). Signed-in users may call it too; it still only accepts a token.
revoke execute on function ext_pair_complete(text, text, text, text), ext_poll(text, text, jsonb, text[], int), ext_job_start(text, uuid),
  ext_job_progress(text, uuid, text), ext_job_extend(text, uuid), ext_job_result(text, uuid, boolean, text, text, jsonb),
  ext_scan_next(text, text), ext_scan_report(text, text, jsonb, text) from public;
grant execute on function ext_pair_complete(text, text, text, text), ext_poll(text, text, jsonb, text[], int), ext_job_start(text, uuid),
  ext_job_progress(text, uuid, text), ext_job_extend(text, uuid), ext_job_result(text, uuid, boolean, text, text, jsonb),
  ext_scan_next(text, text), ext_scan_report(text, text, jsonb, text) to anon, authenticated;
