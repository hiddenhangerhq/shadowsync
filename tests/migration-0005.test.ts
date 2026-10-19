// Runs the REAL SQL (migrations 0001, 0002, 0004, 0005) on an in-process Postgres (PGlite, WASM, free, no network) with a stub of
// Supabase's auth schema and roles. Verifies what the mock cannot: the claim function, the partial unique index, RLS and append-only
// rules, grants for the anon-callable worker function, and that the migration can be re-run. Does NOT replace the RUN_SUPABASE=1 contract run.
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = path.resolve(import.meta.dirname, "../supabase/migrations");
const sql = (f: string) => fs.readFileSync(path.join(dir, f), "utf8").replace(/create extension if not exists "pgcrypto";/i, "");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let db: PGlite;
const as = async (uid: string | null, role: "authenticated" | "anon" = "authenticated") => {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid ?? ""]);
  await db.exec(`set role ${role}`);
};
const root = () => db.exec("reset role");
const rows = async <T = Record<string, unknown>>(q: string, p: unknown[] = []) => (await db.query<T>(q, p)).rows;
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
  `);
  for (const f of ["0001_schema.sql", "0002_rls.sql", "0004_sales_ship.sql", "0005_jobs.sql"]) await db.exec(sql(f));
  await db.exec(`insert into auth.users (id, email) values ('${A}', 'a@x.com'), ('${B}', 'b@x.com')`);
});
afterAll(async () => { await db.close(); });

const seedItem = async (uid: string, sku: string) => {
  await as(uid);
  const [it] = await rows<{ id: string }>("insert into items (title, sku) values ('t', $1) returning id", [sku]);
  const [l] = await rows<{ id: string }>("insert into listings (item_id, marketplace) values ($1, 'poshmark') returning id", [it.id]);
  return { item: it.id, listing: l.id };
};
const addJob = async (uid: string, o: { type?: string; executor?: string; key?: string | null; item?: string | null; due?: string } = {}) => {
  await as(uid);
  const [j] = await rows<{ id: string }>(
    `insert into jobs (marketplace, job_type, executor, priority, idempotency_key, item_id, next_run_at)
     values ('poshmark', $1, $2, $3, $4, $5, $6::timestamptz) returning id`,
    [o.type ?? "delist", o.executor ?? "extension", (o.type ?? "delist") === "delist" || o.type === "mark_sold" ? 0 : o.type === "sync_status" ? 20 : 10, o.key ?? null, o.item ?? null, o.due ?? "2026-01-01T00:00:00Z"],
  );
  return j.id;
};

describe("migration 0005", () => {
  it("applies on top of 0001-0004 and can be run a second time without error", async () => {
    await root();
    await db.exec(sql("0005_jobs.sql"));
    const t = await rows<{ table_name: string }>("select table_name from information_schema.tables where table_schema='public' and table_name in ('jobs','job_events','extension_devices','extension_marketplace_state','sales_scan_cursors','item_sync_log','worker_state') order by 1");
    expect(t.map((x) => x.table_name)).toEqual(["extension_devices", "extension_marketplace_state", "item_sync_log", "job_events", "jobs", "sales_scan_cursors", "worker_state"]);
    const rls = await rows<{ relname: string; relrowsecurity: boolean }>("select relname, relrowsecurity from pg_class where relname in ('jobs','job_events','extension_devices','extension_marketplace_state','sales_scan_cursors','item_sync_log','worker_state')");
    expect(rls).toHaveLength(7);
    expect(rls.every((r) => r.relrowsecurity)).toBe(true);
  });
  it("every table has user_id and a policy (except worker_state: one shared heartbeat row)", async () => {
    await root();
    for (const t of ["jobs", "job_events", "extension_devices", "extension_marketplace_state", "sales_scan_cursors", "item_sync_log"]) {
      expect((await rows("select 1 from information_schema.columns where table_name=$1 and column_name='user_id'", [t])).length, t).toBe(1);
      expect((await rows("select 1 from pg_policies where tablename=$1", [t])).length, t).toBeGreaterThan(0);
    }
  });
});

describe("claim_jobs", () => {
  it("claims delist/mark_sold first, then create, then sync; due only; right executor; limit; attempt + 10-minute lease; logs the event", async () => {
    const { item } = await seedItem(A, "C1");
    const sync = await addJob(A, { type: "sync_status", item: null });
    const create = await addJob(A, { type: "create_listing", item });
    const apiJob = await addJob(A, { type: "delist", executor: "api" });
    const future = await addJob(A, { type: "delist", due: "2099-01-01T00:00:00Z" });
    const sold = await addJob(A, { type: "mark_sold" });
    await as(A);
    const got = await rows<{ id: string; status: string; attempts: number; lease_expires_at: string }>("select * from claim_jobs('extension', null, 10, '2026-10-18T12:00:00Z')");
    expect(got.map((j) => j.id)).toEqual([sold, create, sync]);
    for (const j of got) {
      expect(j.status).toBe("claimed");
      expect(j.attempts).toBe(1);
      expect(new Date(j.lease_expires_at).toISOString()).toBe("2026-10-18T12:10:00.000Z");
    }
    expect((await rows("select * from claim_jobs('extension', null, 10, '2026-10-18T12:00:00Z')"))).toEqual([]);
    expect((await rows<{ id: string }>("select * from claim_jobs('api', null, 1, '2026-10-18T12:00:00Z')")).map((j) => j.id)).toEqual([apiJob]);
    expect((await rows<{ status: string }>("select status from jobs where id=$1", [future]))[0].status).toBe("queued");
    expect((await rows<{ to_status: string }>("select to_status from job_events where job_id=$1 order by at, to_status", [sold])).map((e) => e.to_status).sort()).toEqual(["claimed"]);
  });
  it("limit is respected and an unknown executor / signed-out caller is refused", async () => {
    await as(A);
    await addJob(A, { type: "update_listing" }); await addJob(A, { type: "update_listing" }); await addJob(A, { type: "update_listing" });
    expect(await rows("select * from claim_jobs('extension', null, 2, '2026-10-18T12:00:00Z')")).toHaveLength(2);
    expect(await fails("select * from claim_jobs('robot')")).toMatch(/bad_executor/);
    await as(null);
    expect(await fails("select * from claim_jobs('api')")).toMatch(/not_signed_in/);
  });
  it("a paused or revoked device claims nothing; an active device gets the job and is recorded", async () => {
    await as(A);
    const [d] = await rows<{ id: string }>("insert into extension_devices (label, token_hash) values ('d', 'h-claim') returning id");
    await addJob(A, { type: "delist", key: "dev1" });
    await db.query("update extension_devices set paused = true where id=$1", [d.id]);
    expect(await rows("select * from claim_jobs('extension', $1, 5, '2026-10-18T12:00:00Z')", [d.id])).toEqual([]);
    await db.query("update extension_devices set paused = false, revoked_at = now() where id=$1", [d.id]);
    expect(await rows("select * from claim_jobs('extension', $1, 5, '2026-10-18T12:00:00Z')", [d.id])).toEqual([]);
    await db.query("update extension_devices set revoked_at = null where id=$1", [d.id]);
    const got = await rows<{ claimed_by_device: string }>("select * from claim_jobs('extension', $1, 5, '2026-10-18T12:00:00Z')", [d.id]);
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((j) => j.claimed_by_device === d.id)).toBe(true);
  });
  it("only ever claims the caller's own jobs", async () => {
    const bJob = await addJob(B, { type: "delist", key: "only-b" });
    await as(A);
    const mine = await rows<{ id: string }>("select * from claim_jobs('extension', null, 100, '2026-10-18T12:00:00Z')");
    expect(mine.map((j) => j.id)).not.toContain(bJob);
    await as(B);
    expect((await rows<{ id: string }>("select * from claim_jobs('extension', null, 100, '2026-10-18T12:00:00Z')")).map((j) => j.id)).toEqual([bJob]);
  });
});

describe("job_counts", () => {
  it("counts only the caller's jobs, grouped by status", async () => {
    await addJob(A, { key: "cnt-1" });
    await as(A);
    const mine = Object.fromEntries((await rows<{ status: string; n: string | number }>("select * from job_counts()")).map((r) => [r.status, Number(r.n)]));
    const [{ total }] = await rows<{ total: string }>("select count(*) as total from jobs");
    expect(Object.values(mine).reduce((a, b) => a + b, 0)).toBe(Number(total));
    await as(B);
    const theirs = (await rows<{ n: string | number }>("select * from job_counts()")).reduce((a, r) => a + Number(r.n), 0);
    expect(theirs).toBe(Number((await rows<{ total: string }>("select count(*) as total from jobs"))[0].total));
    expect(theirs).not.toBe(Object.values(mine).reduce((a, b) => a + b, 0));
    await as(null, "anon");
    expect(await rows("select * from job_counts()")).toEqual([]);
  });
});

describe("idempotency index", () => {
  it("allows one OPEN job per (user, key); a finished or canceled job frees the key; keys are per user; null keys never conflict", async () => {
    const first = await addJob(A, { key: "idem-1" });
    expect(await fails(`insert into jobs (marketplace, job_type, executor, idempotency_key) values ('poshmark','delist','extension','idem-1')`)).toMatch(/jobs_idem_open_uq|duplicate key/);
    await db.query("update jobs set status='running' where id=$1", [first]);
    expect(await fails(`insert into jobs (marketplace, job_type, executor, idempotency_key) values ('poshmark','delist','extension','idem-1')`)).toMatch(/duplicate key/);
    await db.query("update jobs set status='succeeded' where id=$1", [first]);
    expect(await fails(`insert into jobs (marketplace, job_type, executor, idempotency_key) values ('poshmark','delist','extension','idem-1')`)).toBeNull();
    await as(B);
    expect(await fails(`insert into jobs (marketplace, job_type, executor, idempotency_key) values ('poshmark','delist','extension','idem-1')`)).toBeNull();
    await as(A);
    expect(await fails(`insert into jobs (marketplace, job_type, executor) values ('poshmark','delist','extension'), ('poshmark','delist','extension')`)).toBeNull();
  });
  it("rejects bad values with check constraints", async () => {
    await as(A);
    expect(await fails(`insert into jobs (marketplace, job_type, executor) values ('poshmark','rm_rf','extension')`)).toMatch(/check/);
    expect(await fails(`insert into jobs (marketplace, job_type, executor) values ('poshmark','delist','robot')`)).toMatch(/check/);
    expect(await fails(`insert into jobs (marketplace, job_type, executor, status) values ('poshmark','delist','extension','weird')`)).toMatch(/check/);
  });
});

describe("RLS and append-only rules", () => {
  it("user B cannot read, update, delete or attach to user A's rows in any table", async () => {
    const { item, listing } = await seedItem(A, "RLS-A");
    const job = await addJob(A, { key: "rls-job", item });
    await as(A);
    await db.query("insert into job_events (job_id, to_status) values ($1, 'queued')", [job]);
    await db.query("insert into item_sync_log (item_id, event, source) values ($1, 'listed', 'api')", [item]);
    await db.query("insert into sales_scan_cursors (marketplace, cursor) values ('ebay', 'secret')");
    const [dev] = await rows<{ id: string }>("insert into extension_devices (label, token_hash) values ('A', 'h-rls') returning id");
    await db.query("insert into extension_marketplace_state (device_id, marketplace, logged_in) values ($1, 'poshmark', true)", [dev.id]);

    await as(B);
    for (const t of ["jobs", "job_events", "extension_devices", "extension_marketplace_state", "sales_scan_cursors", "item_sync_log"]) {
      expect(await rows(`select * from ${t} where user_id = $1`, [A]), t).toEqual([]); // B (who has rows of their own) sees none of A's
      expect((await rows<{ user_id: string }>(`select user_id from ${t}`)).every((r) => r.user_id === B), t).toBe(true);
    }
    expect((await db.query("update jobs set status='canceled' where id=$1", [job])).affectedRows).toBe(0);
    expect((await db.query("delete from jobs where id=$1", [job])).affectedRows).toBe(0);
    expect((await db.query("update extension_devices set paused=true where id=$1", [dev.id])).affectedRows).toBe(0);
    expect((await db.query("update sales_scan_cursors set cursor='x'")).affectedRows).toBe(0);
    // cannot create rows that point at A's item / listing / device, or spoof user_id
    expect(await fails("insert into jobs (marketplace, job_type, executor, item_id) values ('ebay','delist','api',$1)", [item])).toMatch(/row-level security/);
    expect(await fails("insert into jobs (marketplace, job_type, executor, listing_id) values ('ebay','delist','api',$1)", [listing])).toMatch(/row-level security/);
    expect(await fails("insert into item_sync_log (item_id, event, source) values ($1, 'listed', 'api')", [item])).toMatch(/row-level security/);
    expect(await fails("insert into extension_marketplace_state (device_id, marketplace, logged_in) values ($1, 'depop', true)", [dev.id])).toMatch(/row-level security/);
    expect(await fails("insert into jobs (user_id, marketplace, job_type, executor) values ($1,'ebay','delist','api')", [A])).toMatch(/row-level security/);
    // the claim function sees nothing of A's
    expect((await rows<{ id: string }>("select * from claim_jobs('extension', null, 100, '2026-10-18T12:00:00Z')")).map((j) => j.id)).not.toContain(job);
    await as(A);
    expect((await rows<{ status: string }>("select status from jobs where id=$1", [job]))[0].status).toBe("queued"); // untouched
  });
  it("anon (no login) reads and writes nothing", async () => {
    await as(null, "anon");
    for (const t of ["jobs", "job_events", "extension_devices", "extension_marketplace_state", "sales_scan_cursors", "item_sync_log"]) {
      expect(await rows(`select * from ${t}`), t).toEqual([]);
    }
    expect(await fails("insert into jobs (marketplace, job_type, executor, user_id) values ('ebay','delist','api',$1)", [A])).toMatch(/row-level security/);
    expect(await fails("select * from worker_state")).toMatch(/permission denied/);
    expect(await fails("select * from claim_jobs('api')")).toMatch(/not_signed_in/);
  });
  it("job_events and item_sync_log are append-only for users (no update, no delete)", async () => {
    const { item } = await seedItem(A, "APPEND");
    const job = await addJob(A, { key: "append", item });
    await as(A);
    await db.query("insert into job_events (job_id, to_status, message) values ($1, 'queued', 'q')", [job]);
    await db.query("insert into item_sync_log (item_id, event, source) values ($1, 'listed', 'api')", [item]);
    for (const q of ["update job_events set message='x'", "delete from job_events", "update item_sync_log set event='x'", "delete from item_sync_log"]) {
      expect(await fails(q), q).toMatch(/permission denied/);
    }
  });
  it("deleting an item keeps its sync log rows (link cleared) and removing a job removes its events", async () => {
    const { item } = await seedItem(A, "KEEPLOG");
    const job = await addJob(A, { key: "keeplog", item });
    await as(A);
    await db.query("insert into job_events (job_id, to_status) values ($1, 'queued')", [job]);
    const [log] = await rows<{ id: string }>("insert into item_sync_log (item_id, event, source, detail) values ($1, 'listed', 'api', 'kept') returning id", [item]);
    await db.query("delete from items where id=$1", [item]);
    const kept = await rows<{ item_id: string | null; detail: string }>("select item_id, detail from item_sync_log where id=$1", [log.id]);
    expect(kept).toEqual([{ item_id: null, detail: "kept" }]);
    expect((await rows<{ item_id: string | null }>("select item_id from jobs where id=$1", [job]))[0].item_id).toBeNull();
    await db.query("delete from jobs where id=$1", [job]);
    expect(await rows("select 1 from job_events where job_id=$1", [job])).toEqual([]);
  });
});

describe("job_maintenance (worker)", () => {
  const set = (id: string, sql: string) => db.query(`update jobs set ${sql} where id=$1`, [id]);
  it("callable without a login: expires leases (queue or fail), requeues due retries, stamps worker_state, logs events", async () => {
    const leased = await addJob(A, { key: "m-lease" });
    const retry = await addJob(A, { key: "m-retry" });
    const last = await addJob(A, { key: "m-last" });
    const fresh = await addJob(A, { key: "m-fresh" });
    const notDue = await addJob(A, { key: "m-notdue" });
    await root();
    await set(leased, "status='running', attempts=2, lease_expires_at = now() - interval '1 minute'");
    await set(retry, "status='retry_wait', attempts=1, next_run_at = now() - interval '1 minute'");
    await set(last, "status='claimed', attempts=5, lease_expires_at = now() - interval '1 second'");
    await set(fresh, "status='claimed', attempts=1, lease_expires_at = now() + interval '5 minutes'");
    await set(notDue, "status='retry_wait', attempts=1, next_run_at = now() + interval '5 minutes'");
    await as(null, "anon");
    const [r] = await rows<{ leases_expired: number; requeued: number }>("select * from job_maintenance()");
    expect(r.leases_expired).toBeGreaterThanOrEqual(2);
    expect(r.requeued).toBeGreaterThanOrEqual(1);
    await root();
    const st = async (id: string) => (await rows<{ status: string; attempts: number; lease_expires_at: string | null; last_error_code: string | null; finished_at: string | null }>("select * from jobs where id=$1", [id]))[0];
    expect(await st(leased)).toMatchObject({ status: "queued", attempts: 2, lease_expires_at: null, last_error_code: "lease_expired" });
    expect(await st(retry)).toMatchObject({ status: "queued", attempts: 1 });
    expect(await st(last)).toMatchObject({ status: "failed", last_error_code: "lease_expired" });
    expect((await st(last)).finished_at).not.toBeNull();
    expect((await st(fresh)).status).toBe("claimed");
    expect((await st(notDue)).status).toBe("retry_wait");
    expect((await rows<{ from_status: string; to_status: string }>("select from_status, to_status from job_events where job_id=$1", [leased]))).toEqual([{ from_status: "running", to_status: "queued" }]);
    expect((await rows<{ to_status: string }>("select to_status from job_events where job_id=$1", [last])).map((e) => e.to_status)).toEqual(["failed"]);
    const [w] = await rows<{ last_run_at: string; last_expired: number }>("select * from worker_state");
    expect(Date.now() - new Date(w.last_run_at).getTime()).toBeLessThan(60_000);
    expect(w.last_expired).toBe(r.leases_expired);
  });
  it("is idempotent: a second run has nothing left to do for already-handled jobs", async () => {
    await as(null, "anon");
    const [r] = await rows<{ leases_expired: number; requeued: number }>("select * from job_maintenance()");
    expect(r).toEqual({ leases_expired: 0, requeued: 0 });
  });
  it("worker_state: signed-in users may read it, nobody can write it directly, and it holds a single row", async () => {
    await as(A);
    expect((await rows("select * from worker_state")).length).toBe(1);
    expect(await fails("update worker_state set last_run_at = now()")).toMatch(/permission denied/);
    expect(await fails("insert into worker_state (id) values ('worker')")).toMatch(/permission denied/);
    await root();
    expect(await fails("insert into worker_state (id) values ('other')")).toMatch(/check/);
  });
});
