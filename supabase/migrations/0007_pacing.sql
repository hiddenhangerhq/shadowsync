-- 0007: human-like pacing (David, 2026-10-19). Safe to run more than once. Needs 0006.
-- ext_poll_v2 = ext_poll plus p_urgent: marketplaces where the extension is on a long break; only delist / mark_sold are handed out there.
-- The app falls back to ext_poll (and simply waits out the break) until this file is applied.

create or replace function ext_poll_v2(p_token text, p_version text, p_states jsonb default '{}'::jsonb, p_ready text[] default '{}', p_limit int default 3, p_urgent text[] default '{}')
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
        -- Taking a long break on this marketplace: only delist / mark_sold may jump the line (they still keep the short gap).
        and (not (j.marketplace::text = any(coalesce(p_urgent, '{}'))) or j.job_type in ('delist', 'mark_sold'))
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
        'item', case when i.id is null then null else jsonb_build_object('title', i.title, 'description', i.description, 'asking_price', i.asking_price, 'brand', i.brand, 'size', i.size, 'status', i.status) end,
        'sold_action', coalesce((select ms.sold_action from marketplace_settings ms where ms.user_id = j.user_id and ms.marketplace = j.marketplace), 'delete'),
        -- Delete happens ONLY for a confirmed sale: the job's saleId is a stored sale matched to this job's item.
        'sale_confirmed', (j.item_id is not null and exists (select 1 from sales sa where sa.user_id = j.user_id and sa.id::text = j.payload ->> 'saleId' and sa.item_id = j.item_id))
      ) order by j.priority, j.next_run_at, j.created_at, j.id)
      from jobs j left join listings l on l.id = j.listing_id and l.user_id = j.user_id left join items i on i.id = j.item_id and i.user_id = j.user_id
      where j.id = any(v_ids)), '[]'::jsonb)
  );
end $$;

revoke execute on function ext_poll_v2(text, text, jsonb, text[], int, text[]) from public;
grant execute on function ext_poll_v2(text, text, jsonb, text[], int, text[]) to anon, authenticated;
