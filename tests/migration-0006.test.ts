// Runs the REAL SQL of migration 0006 (with 0001-0005) on an in-process Postgres (PGlite, WASM, free) with a stub of Supabase's auth
// schema, roles and default function grants. Checks what the mock cannot: token-keyed SECURITY DEFINER functions callable by anon,
// private helpers NOT callable, pairing + rate limit, claim, result rules, auto-pause, the one-transaction sales scan, RLS, re-runs.
// Complements (never replaces) the RUN_SUPABASE=1 contract run.
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newDeviceToken, newPairingCode, sha256Hex } from "../src/lib/ext/tokens";

const dir = path.resolve(import.meta.dirname, "../supabase/migrations");
const sql = (f: string) => fs.readFileSync(path.join(dir, f), "utf8").replace(/create extension if not exists "pgcrypto";/i, "");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const V = "0.1.0";

let db: PGlite;
const as = async (uid: string | null, role: "authenticated" | "anon" = "authenticated") => {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid ?? ""]);
  await db.exec(`set role ${role}`);
};
const anon = () => as(null, "anon");
const rows = async <T = Record<string, unknown>>(q: string, p: unknown[] = []) => (await db.query<T>(q, p)).rows;
const one = async <T = Record<string, unknown>>(q: string, p: unknown[] = []) => (await rows<T>(q, p))[0];
const fails = async (q: string, p: unknown[] = []) => { try { await db.query(q, p); return null; } catch (e) { return (e as Error).message; } };

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated; grant usage on schema public to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated; -- like Supabase
  `);
  for (const f of ["0001_schema.sql", "0002_rls.sql", "0004_sales_ship.sql", "0005_jobs.sql", "0006_extension.sql"]) await db.exec(sql(f));
  await db.exec(`insert into auth.users (id, email) values ('${A}', 'a@x.com'), ('${B}', 'b@x.com')`);
  await db.exec("reset role");
  await db.exec(`insert into profiles (id, email) select id, email from auth.users on conflict do nothing`);
});
afterAll(async () => { await db.close(); });

/** Pair a device for `uid` the way the app does: dashboard makes the code, the extension swaps it (as anon) for a device. */
const pair = async (uid: string, label = "Chrome") => {
  const code = newPairingCode(), token = newDeviceToken();
  await as(uid);
  await db.query("select ext_pair_start($1)", [code]);
  await anon();
  const r = await one<{ r: { device_id: string; error?: string } }>("select ext_pair_complete($1, $2, $3, $4) as r", [code, token, label, V]);
  expect(r.r.error).toBeUndefined();
  return { token, device: r.r.device_id };
};
const seed = async (uid: string, sku: string) => {
  await as(uid);
  const it = await one<{ id: string }>("insert into items (title, sku, status) values ('Polo', $1, 'listed') returning id", [sku]);
  const posh = await one<{ id: string }>("insert into listings (item_id, marketplace, external_id, status) values ($1, 'poshmark', $2, 'active') returning id", [it.id, `p-${sku}`]);
  const ebay = await one<{ id: string }>("insert into listings (item_id, marketplace, external_id, status) values ($1, 'ebay', $2, 'active') returning id", [it.id, `e-${sku}`]);
  return { item: it.id, posh: posh.id, ebay: ebay.id };
};
const addJob = async (uid: string, o: { type?: string; listing?: string | null; item?: string | null; key?: string; marketplace?: string } = {}) => {
  await as(uid);
  return (await one<{ id: string }>(
    `insert into jobs (marketplace, job_type, executor, priority, item_id, listing_id, idempotency_key, next_run_at)
     values ($1, $2, 'extension', $3, $4, $5, $6, now() - interval '1 minute') returning id`,
    [o.marketplace ?? "poshmark", o.type ?? "mark_sold", ["delist", "mark_sold"].includes(o.type ?? "mark_sold") ? 0 : 20, o.item ?? null, o.listing ?? null, o.key ?? null],
  )).id;
};
const poll = async (token: string, ready = ["poshmark"], states: Record<string, boolean> = { poshmark: true }) => {
  await anon();
  return (await one<{ r: { jobs: { job: { id: string; status: string; attempts: number } ; listing: unknown; item: unknown }[]; device: { paused: boolean }; requeued: number; marketplaces: { marketplace: string; paused: boolean; paused_reason: string | null }[] } }>(
    "select ext_poll($1, $2, $3::jsonb, $4::text[], 3) as r", [token, V, JSON.stringify(states), ready])).r;
};
const result = async (token: string, job: string, ok: boolean, code: string | null = null, msg: string | null = null, res: unknown = null) => {
  await anon();
  return one<{ status: string; last_error_code: string | null; next_run_at: string; claimed_by_device: string | null }>(
    "select * from ext_job_result($1, $2, $3, $4, $5, $6::jsonb)", [token, job, ok, code, msg, res === null ? null : JSON.stringify(res)]);
};
const start = async (token: string, job: string) => { await anon(); return one<{ status: string }>("select * from ext_job_start($1, $2)", [token, job]); };

describe("migration 0006", () => {
  it("applies on top of 0001-0005, can be re-run, and turns RLS on for the new tables", async () => {
    await db.exec("reset role");
    await db.exec(sql("0006_extension.sql"));
    await db.exec(sql("0005_jobs.sql")); // 0005 re-run on top of 0006 still fine
    const rls = await rows<{ relname: string; relrowsecurity: boolean }>("select relname, relrowsecurity from pg_class where relname in ('extension_pairings','alert_prefs','ext_rate')");
    expect(rls).toHaveLength(3);
    expect(rls.every((r) => r.relrowsecurity)).toBe(true);
    const enumVals = (await rows<{ v: string }>("select unnest(enum_range(null::marketplace))::text v")).map((r) => r.v);
    expect(enumVals).toEqual(expect.arrayContaining(["facebook", "vinted", "poshmark"]));
  });

  it("grants: ext_* callable by anon; private helpers and the rate table are not; pairing start needs a signed-in user", async () => {
    await db.exec("reset role");
    const can = async (role: string, fn: string) => (await one<{ ok: boolean }>(`select has_function_privilege($1, $2, 'execute') ok`, [role, fn])).ok;
    for (const fn of ["ext_poll(text,text,jsonb,text[],integer)", "ext_pair_complete(text,text,text,text)", "ext_job_result(text,uuid,boolean,text,text,jsonb)", "ext_scan_report(text,text,jsonb,text)"]) {
      expect(await can("anon", fn), fn).toBe(true);
    }
    for (const fn of ["_ext_device(text,boolean)", "_ext_rate(text,integer,integer)", "_ext_hash(text)", "_ext_job(extension_devices,uuid)", "_ext_state(extension_devices,text)", "_ext_event(jobs,text,text,text)"]) {
      expect(await can("anon", fn), fn).toBe(false);
      expect(await can("authenticated", fn), fn).toBe(false);
    }
    expect(await can("anon", "ext_pair_start(text)")).toBe(false);
    await anon();
    expect(await fails("select * from ext_rate")).toMatch(/permission denied/);
    expect(await fails("select * from extension_devices")).toBeNull(); // RLS: anon simply sees nothing
    expect(await rows("select * from extension_devices")).toEqual([]);
    expect(await fails("select ext_pair_start('ABCDEFGH')")).toMatch(/permission denied/);
    await as(A);
    expect(await fails("insert into extension_pairings (code_hash, expires_at) values ('x', now())")).toMatch(/permission denied/);
  });

  it("pairing: hash of the code only, 5 minutes, single use; wrong code answers (does not raise); token stored as sha256", async () => {
    await as(A);
    const code = newPairingCode();
    const exp = await one<{ e: string }>("select ext_pair_start($1) e", [code]);
    expect(new Date(exp.e).getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    expect((await rows<{ code_hash: string }>("select code_hash from extension_pairings where user_id = $1", [A])).map((r) => r.code_hash)).toContain(sha256Hex(code));
    await anon();
    const token = newDeviceToken();
    expect((await one<{ r: unknown }>("select ext_pair_complete('ZZZZZZZZ', $1, 'x', $2) r", [token, V])).r).toEqual({ error: "pairing_invalid" });
    const ok = await one<{ r: { device_id: string; label: string } }>("select ext_pair_complete($1, $2, '  My Edge ', $3) r", [code, token, V]);
    expect(ok.r.label).toBe("My Edge");
    expect((await one<{ r: unknown }>("select ext_pair_complete($1, $2, 'x', $3) r", [code, newDeviceToken(), V])).r).toEqual({ error: "pairing_invalid" });
    await db.exec("reset role");
    const d = await one<{ token_hash: string; user_id: string }>("select token_hash, user_id from extension_devices where id = $1", [ok.r.device_id]);
    expect(d).toEqual({ token_hash: sha256Hex(token), user_id: A });
    await db.exec("update extension_pairings set expires_at = now() - interval '1 second' where used_at is null");
    await as(A);
    for (let i = 0; i < 5; i++) await db.query("select ext_pair_start($1)", [newPairingCode()]);
    expect(await fails("select ext_pair_start($1)", [newPairingCode()])).toMatch(/ext:too_many_codes/);
    await db.exec("reset role");
    await db.exec("delete from extension_pairings where used_at is null");
  });

  it("rate limit: 30 pairing attempts a minute for everyone (wrong codes count), then refused until the window ends", async () => {
    await db.exec("reset role");
    await db.exec("delete from ext_rate");
    await anon();
    for (let i = 0; i < 30; i++) await db.query("select ext_pair_complete('ZZZZZZZZ', $1, 'x', $2)", [newDeviceToken(), V]);
    expect(await fails("select ext_pair_complete('ZZZZZZZZ', $1, 'x', $2)", [newDeviceToken(), V])).toMatch(/ext:rate_limited/);
    await db.exec("reset role");
    await db.exec("update ext_rate set window_start = now() - interval '61 seconds' where key = 'pair'");
    await anon();
    expect(await fails("select ext_pair_complete('ZZZZZZZZ', $1, 'x', $2)", [newDeviceToken(), V])).toBeNull();
  });

  it("token checks: unknown or malformed token, revoked device, paused device (poll only heartbeats)", async () => {
    const { token, device } = await pair(A);
    await anon();
    expect(await fails("select ext_poll($1, $2)", [newDeviceToken(), V])).toMatch(/ext:invalid_token/);
    expect(await fails("select ext_poll('x', $1)", [V])).toMatch(/ext:invalid_token/);
    expect(await fails("select ext_poll($1, 'v1')", [token])).toMatch(/ext:bad_request/);
    expect(await fails("select ext_poll($1, $2, '{\"ebay\": true}'::jsonb)", [token, V])).toMatch(/ext:bad_request/); // not an extension marketplace
    await as(A);
    await db.query("update extension_devices set paused = true where id = $1", [device]);
    const p = await poll(token);
    expect(p.device.paused).toBe(true);
    expect(await fails("select ext_scan_next($1, 'poshmark')", [token])).toMatch(/ext:device_paused/);
    await as(A);
    await db.query("update extension_devices set paused = false, revoked_at = now() where id = $1", [device]);
    await anon();
    expect(await fails("select ext_poll($1, $2)", [token, V])).toMatch(/ext:device_revoked/);
  });

  it("poll claims one job per ready, signed-in, unpaused marketplace (mark_sold first) with our listing data; result rules follow the code", async () => {
    const { token, device } = await pair(A);
    const s = await seed(A, "P1");
    const sync = await addJob(A, { type: "sync_status", item: s.item });
    const sold = await addJob(A, { type: "mark_sold", item: s.item, listing: s.posh });
    expect((await poll(token, [])).jobs).toEqual([]);
    const p = await poll(token);
    expect(p.jobs.map((j) => j.job.id)).toEqual([sold]);
    expect(p.jobs[0].listing).toEqual({ external_id: "p-P1", url: null });
    expect(p.jobs[0].job).toMatchObject({ status: "claimed", attempts: 1, claimed_by_device: device });
    expect((await poll(token)).jobs).toEqual([]); // busy: one at a time per marketplace
    await anon();
    expect(await fails("select * from ext_job_result($1, $2, true)", [token, sold])).toMatch(/illegal_transition:claimed->succeeded/);
    expect((await start(token, sold)).status).toBe("running");
    await anon();
    await db.query("select ext_job_progress($1, $2, 'Opened the listing')", [token, sold]);
    const done = await result(token, sold, true, null, null, { alreadyDone: true });
    expect(done).toMatchObject({ status: "succeeded", claimed_by_device: null });
    await as(A);
    expect((await one<{ status: string }>("select status from listings where id = $1", [s.posh])).status).toBe("sold");
    expect((await rows<{ event: string }>("select event from item_sync_log where job_id = $1", [sold])).map((r) => r.event)).toEqual(["marked_sold"]);
    expect((await rows<{ message: string }>("select message from job_events where job_id = $1 order by at", [sold])).map((r) => r.message))
      .toEqual(expect.arrayContaining(["Claimed (attempt 1 of 5)", "Started", "Opened the listing", "Succeeded"]));
    // Next poll: the sync job. A timeout retries in 5 minutes; an unknown code fails; codes are lower-cased and checked.
    const p2 = await poll(token);
    expect(p2.jobs.map((j) => j.job.id)).toEqual([sync]);
    const r = await result(token, sync, false, "timeout", "slow");
    expect(r.status).toBe("retry_wait");
    expect(new Date(r.next_run_at).getTime() - Date.now()).toBeGreaterThan(4.5 * 60_000);
    const j3 = await addJob(A, { type: "delist", item: s.item, listing: s.posh, key: "x" });
    await poll(token);
    await anon();
    expect(await fails("select * from ext_job_result($1, $2, false, 'bad code!', 'x')", [token, j3])).toMatch(/ext:bad_request/);
    expect((await result(token, j3, false, "Weird_Thing", "?")).status).toBe("failed");
    await as(A);
    expect((await rows<{ event: string }>("select event from item_sync_log where job_id = $1", [j3])).map((r) => r.event)).toEqual(["delist_failed"]);
  });

  it("signed out -> needs you; signing in again requeues; 2 security checks in a row pause the marketplace; user B's device sees nothing of A", async () => {
    const { token, device } = await pair(A);
    const s = await seed(A, "P2");
    const j1 = await addJob(A, { type: "sync_status", item: s.item, key: "s1" });
    await poll(token);
    expect((await result(token, j1, false, "signed_out", "Signed out")).status).toBe("needs_user");
    await as(A);
    expect((await one<{ logged_in: boolean }>("select logged_in from extension_marketplace_state where device_id = $1 and marketplace = 'poshmark'", [device])).logged_in).toBe(false);
    const p = await poll(token);
    expect(p.requeued).toBe(1);
    expect(p.jobs.map((j) => j.job.id)).toEqual([j1]);
    await result(token, j1, false, "captcha", "Captcha");
    const j2 = await addJob(A, { type: "sync_status", item: s.item, key: "s2" });
    await poll(token);
    await result(token, j2, false, "challenge", "Verify");
    await as(A);
    expect(await one("select paused, challenge_streak from extension_marketplace_state where device_id = $1 and marketplace = 'poshmark'", [device]))
      .toEqual({ paused: true, challenge_streak: 2 });
    await addJob(A, { type: "sync_status", item: s.item, key: "s3" });
    const p3 = await poll(token);
    expect(p3.jobs).toEqual([]);
    expect(p3.marketplaces.find((m) => m.marketplace === "poshmark")?.paused_reason).toMatch(/2 security checks/);
    const b = await pair(B);
    await addJob(A, { type: "sync_status", item: s.item, key: "s4", marketplace: "depop" });
    expect((await poll(b.token, ["depop", "poshmark"], { depop: true, poshmark: true })).jobs).toEqual([]);
    await anon();
    expect(await fails("select * from ext_job_start($1, $2)", [b.token, j2])).toMatch(/ext:not_your_job/);
  });

  it("sales scan: cursor starts at now; one transaction stores sales, queues delists for other listings, moves the cursor; replay adds nothing; a bad report keeps the cursor", async () => {
    const { token, device } = await pair(A);
    const s = await seed(A, "P3");
    await anon();
    const n = (await one<{ r: { cursor: string; scope_key: string } }>("select ext_scan_next($1, 'poshmark') r", [token])).r;
    expect(n.scope_key).toBe(`device:${device}`);
    expect(Math.abs(new Date(n.cursor).getTime() - Date.now())).toBeLessThan(60_000);
    const sales = [
      { orderId: "O-1", soldAt: "2026-10-18", price: 20, externalListingId: "p-P3" },
      { orderId: "O-2", soldAt: "2026-10-18", price: 5, sku: "unknown" },
      { orderId: "O-3", soldAt: "2026-10-17", price: 5, cancelled: true },
    ];
    const rep = async (list: unknown[], cur: string | null) => {
      await anon();
      return (await one<{ r: Record<string, unknown> }>("select ext_scan_report($1, 'poshmark', $2::jsonb, $3) r", [token, JSON.stringify(list), cur])).r;
    };
    expect(await rep(sales, "C1")).toEqual({ ok: true, stored: 2, duplicates: 0, jobs_created: 1, unmatched: 1, cancelled: 1, cursor_advanced: true });
    await as(A);
    const jobs = await rows<{ marketplace: string; job_type: string; executor: string; listing_id: string; idempotency_key: string }>("select * from jobs where item_id = $1", [s.item]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ marketplace: "ebay", job_type: "delist", executor: "api", listing_id: s.ebay });
    expect((await one<{ status: string }>("select status from items where id = $1", [s.item])).status).toBe("sold");
    expect((await one<{ status: string }>("select status from listings where id = $1", [s.posh])).status).toBe("sold");
    expect(await rep(sales, null)).toMatchObject({ ok: true, stored: 0, duplicates: 2, jobs_created: 0, unmatched: 0, cancelled: 0 });
    // A broken entry: nothing of this report is kept and the cursor stays at C1, with the error recorded.
    expect(await rep([{ orderId: "O-9", soldAt: "2026-10-19", price: 1 }, { orderId: "O-10", soldAt: "nope", price: 1 }], "C2")).toMatchObject({ ok: false, cursor_advanced: false });
    await as(A);
    expect(await rows("select 1 from sales where order_id = 'O-9'")).toEqual([]);
    expect(await one("select cursor, last_error is not null as err from sales_scan_cursors where scope_key = $1", [`device:${device}`])).toEqual({ cursor: "C1", err: true });
    expect(await fails("select ext_scan_report($1, 'ebay', '[]'::jsonb, null)", [token])).toMatch(/ext:bad_request/);
  });

  it("alert_prefs: own row only, phone must look like +<digits>, SMS defaults to off", async () => {
    await as(A);
    await db.query("insert into alert_prefs (phone) values ('+15551234567')");
    expect(await one("select sms_enabled, phone from alert_prefs")).toEqual({ sms_enabled: false, phone: "+15551234567" });
    expect(await fails("update alert_prefs set phone = '555'")).toMatch(/check constraint/);
    await as(B);
    expect(await rows("select * from alert_prefs")).toEqual([]);
    expect(await fails(`insert into alert_prefs (user_id) values ('${A}')`)).toMatch(/row-level security|duplicate/);
  });
});
