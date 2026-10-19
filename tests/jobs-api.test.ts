// Dashboard job API (auth, validation, dedupe) over the mock store, plus the worker endpoint and graceful degradation.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { backends } from "./helpers";
import type { Services } from "../src/lib/data/interfaces";
import { SchemaMissingError } from "../src/lib/data/types";
import { cancelJob, createJob, getExtensionStatus, getItemSyncLog, getJobDetail, getNeedsAction, listJobs, retryJob } from "../src/lib/jobs/api";
import { loadOverview } from "../src/lib/jobs/overview";
import { processScanReport } from "../src/lib/jobs/sale-detection";

const mock = backends.find((b) => b.name === "mock")!;
let env: ReturnType<typeof mock.make>;
let svc: Services;
let itemId: string, listingId: string;

beforeEach(async () => {
  env = mock.make();
  svc = await env.user(0);
  const item = await svc.store.items.create({ title: "Polo", sku: "1001", status: "listed" });
  const l = await svc.store.listings.upsert({ itemId: item.id, marketplace: "poshmark", externalId: "p1", url: null, price: 1, status: "active", listedAt: null, endedAt: null, source: "manual" });
  itemId = item.id; listingId = l.id;
});

const body = (o: Record<string, unknown> = {}) => ({ marketplace: "poshmark", jobType: "delist", itemId, listingId, ...o });

describe("auth", () => {
  it("every dashboard endpoint answers 401 when signed out", async () => {
    const out = env.client();
    const id = "11111111-1111-4111-8111-111111111111";
    const results = await Promise.all([
      listJobs(out, {}), createJob(out, body()), getJobDetail(out, id), retryJob(out, id), cancelJob(out, id),
      getNeedsAction(out), getItemSyncLog(out, itemId), getExtensionStatus(out),
    ]);
    for (const r of results) expect(r).toEqual({ status: 401, body: { error: "Not signed in" } });
  });
  it("user B cannot see, retry or cancel user A's jobs (404, not 403)", async () => {
    const { body: b } = await createJob(svc, body());
    const id = (b.job as { id: string }).id;
    const other = await env.user(1);
    expect((await getJobDetail(other, id)).status).toBe(404);
    expect((await retryJob(other, id)).status).toBe(404);
    expect((await cancelJob(other, id)).status).toBe(404);
    expect((await listJobs(other, {})).body.jobs).toEqual([]);
    expect((await getItemSyncLog(other, itemId)).status).toBe(404);
  });
});

describe("POST /jobs", () => {
  it("creates a job with server-chosen executor and priority, then dedupes a repeat", async () => {
    const a = await createJob(svc, body());
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ created: true, deduped: false, job: { status: "queued", executor: "extension", priority: 0, marketplace: "poshmark", jobType: "delist", attempts: 0 } });
    const b = await createJob(svc, body());
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ created: false, deduped: true });
    expect((b.body.job as { id: string }).id).toBe((a.body.job as { id: string }).id);
    expect((await svc.store.jobs.list())).toHaveLength(1);
  });
  it("uses the official API executor when the marketplace is connected by OAuth", async () => {
    await svc.store.connections.upsert({ marketplace: "poshmark", connectionType: "oauth_api", accountLabel: null, status: "connected", lastSyncAt: null, lastError: null });
    expect((await createJob(svc, body())).body).toMatchObject({ job: { executor: "api" } });
  });
  it("an explicit idempotency key dedupes across different requests, and a finished job frees the key", async () => {
    const first = await createJob(svc, body({ idempotencyKey: "k1" }));
    expect((await createJob(svc, body({ idempotencyKey: "k1", payload: { x: 1 } }))).status).toBe(200);
    expect((await createJob(svc, body({ idempotencyKey: "k2" }))).status).toBe(201);
    const id = (first.body.job as { id: string }).id;
    await svc.store.jobs.cancel(id);
    expect((await createJob(svc, body({ idempotencyKey: "k1" }))).status).toBe(201);
  });
  it("validates: 400 for bad bodies, 404 for unknown item/listing, 400 when the listing is another marketplace's", async () => {
    expect((await createJob(svc, { marketplace: "nope" })).status).toBe(400);
    expect((await createJob(svc, body({ executor: "api" }))).status).toBe(400);
    expect((await createJob(svc, body({ itemId: "22222222-2222-4222-8222-222222222222" }))).status).toBe(404);
    expect((await createJob(svc, body({ listingId: "22222222-2222-4222-8222-222222222222" }))).status).toBe(404);
    expect((await createJob(svc, body({ marketplace: "ebay" }))).status).toBe(400);
  });
  it("queues a delist log line on the item", async () => {
    await createJob(svc, body());
    expect((await svc.store.itemSyncLog.list({ itemId })).map((e) => e.event)).toEqual(["delist_queued"]);
  });
});

describe("GET /jobs, GET /jobs/:id, retry, cancel", () => {
  it("lists newest first with a status filter and a limit", async () => {
    const mk = async (k: string, t: "delist" | "create_listing" = "delist") => ((await createJob(svc, body({ jobType: t, idempotencyKey: k }))).body.job as { id: string }).id;
    const a = await mk("a"), b = await mk("b"), c = await mk("c", "create_listing");
    await svc.store.jobs.cancel(a);
    expect((await listJobs(svc, {})).body.jobs).toHaveLength(3);
    expect(((await listJobs(svc, { status: "canceled" })).body.jobs as { id: string }[]).map((j) => j.id)).toEqual([a]);
    expect(((await listJobs(svc, { status: "queued,canceled", limit: "2" })).body.jobs as unknown[])).toHaveLength(2);
    expect((await listJobs(svc, { status: "bogus" })).status).toBe(400);
    expect((await listJobs(svc, { itemId: "nope" })).status).toBe(400);
    void b; void c;
  });
  it("detail returns the job with its log events; unknown or malformed ids are 404", async () => {
    const id = ((await createJob(svc, body())).body.job as { id: string }).id;
    const d = await getJobDetail(svc, id);
    expect(d.status).toBe(200);
    expect((d.body.events as { toStatus: string }[]).map((e) => e.toStatus)).toEqual(["queued"]);
    expect((await getJobDetail(svc, "11111111-1111-4111-8111-111111111111")).status).toBe(404);
    expect((await getJobDetail(svc, "not-a-uuid")).status).toBe(404);
  });
  it("retry works on failed jobs (fresh attempts, logged) and is 409 on a queued job; cancel is 409 on finished jobs", async () => {
    const id = ((await createJob(svc, body())).body.job as { id: string }).id;
    expect((await retryJob(svc, id)).status).toBe(409);
    await svc.store.jobs.claim({ executor: "extension" });
    await svc.store.jobs.start(id);
    await svc.store.jobs.complete(id, { kind: "hard", code: "rejected", message: "nope" });
    const r = await retryJob(svc, id);
    expect(r).toMatchObject({ status: 200, body: { job: { status: "queued", attempts: 0 } } });
    expect(((await getJobDetail(svc, id)).body.events as { message: string }[]).map((e) => e.message)).toContain("Retried by you");
    expect((await cancelJob(svc, id)).status).toBe(200);
    const again = await cancelJob(svc, id);
    expect(again).toMatchObject({ status: 409, body: { code: "illegal_transition", from: "canceled", to: "canceled" } });
  });
});

describe("needs-action, sync log, extension status", () => {
  it("shows a failed delist in needs-action and in the item's timeline until it is marked delisted", async () => {
    await processScanReport(svc.store, { marketplace: "ebay", source: "api", sales: [{ orderId: "O1", soldAt: "2026-10-18", price: 20, sku: "1001" }], nextCursor: "c" });
    const [job] = await svc.store.jobs.list();
    await svc.store.jobs.claim({ executor: "extension" }); await svc.store.jobs.start(job.id);
    await svc.store.jobs.complete(job.id, { kind: "hard", code: "rejected", message: "Listing not found" });
    const na = (await getNeedsAction(svc)).body.entries as { kind: string; listingId: string; message: string }[];
    expect(na).toHaveLength(1);
    expect(na[0]).toMatchObject({ kind: "delist_failed" });
    expect(na[0].message).toContain("Listing not found");
    const log = (await getItemSyncLog(svc, itemId)).body as { item: { sku: string }; timeline: { label: string }[] };
    expect(log.item.sku).toBe("1001");
    expect(log.timeline.map((r) => r.label)).toEqual(expect.arrayContaining(["sale detected", "mark sold: failed", "mark sold: queued"]));
    await svc.store.needsAction.markDelisted(na[0].listingId);
    expect((await getNeedsAction(svc)).body.entries).toEqual([]);
    expect((await svc.store.listings.listForItem(itemId))[0].status).toBe("ended");
    expect((await svc.store.itemSyncLog.list({ itemId })).map((e) => e.event)).toContain("delisted");
  });
  it("extension status reports devices, per-marketplace login and health", async () => {
    const d = await svc.store.devices.register({ label: "Chrome on Windows", tokenHash: "h1" });
    await svc.store.devices.heartbeat(d.id, { extensionVersion: "0.1.0", marketplaces: { poshmark: false } });
    await svc.store.worker.run();
    const r = await getExtensionStatus(svc);
    expect(r.status).toBe(200);
    const b = r.body as { devices: { label: string; extensionVersion: string }[]; marketplaces: { marketplace: string; loggedIn: boolean }[]; health: { items: { key: string }[] } };
    expect(b.devices[0]).toMatchObject({ label: "Chrome on Windows", extensionVersion: "0.1.0" });
    expect(JSON.stringify(b)).not.toMatch(/h1|tokenHash|token_hash/); // the hash never leaves the server
    expect(b.marketplaces).toMatchObject([{ marketplace: "poshmark", loggedIn: false }]);
    expect(b.health.items.map((i) => i.key)).toEqual(expect.arrayContaining(["extension", "signed_out:poshmark", "worker"]));
  });
});

describe("degrades gracefully when the 0005 tables are missing", () => {
  const broken = (): Services => {
    const boom = () => { throw new SchemaMissingError(); };
    const store = new Proxy(svc.store, {
      get: (t, k) => (k === "jobs" || k === "devices" || k === "cursors" || k === "itemSyncLog" || k === "worker" || k === "needsAction" ? new Proxy({}, { get: () => boom }) : (t as never)[k]),
    });
    return { ...svc, store };
  };
  it("API answers 503 schema_missing instead of crashing", async () => {
    expect(await listJobs(broken(), {})).toMatchObject({ status: 503, body: { code: "schema_missing" } });
    expect(await getNeedsAction(broken())).toMatchObject({ status: 503, body: { code: "schema_missing" } });
    expect(await getExtensionStatus(broken())).toMatchObject({ status: 503, body: { code: "schema_missing" } });
  });
  it("loadOverview never throws: ready=false with the reason", async () => {
    const o = await loadOverview(broken().store);
    expect(o).toMatchObject({ ready: false, schemaMissing: true, health: null, needsAction: [], counts: null });
    const generic = await loadOverview(new Proxy(svc.store, { get: (t, k) => (k === "jobs" ? { ...t.jobs, list: async () => { throw new Error("db down"); } } : (t as never)[k]) }));
    expect(generic).toMatchObject({ ready: false, schemaMissing: false, error: "db down" });
  });
  it("loadOverview on a healthy store is ready", async () => {
    expect(await loadOverview(svc.store)).toMatchObject({ ready: true, schemaMissing: false, needsAction: [] });
  });
});

describe("worker endpoint /api/cron/worker", () => {
  const SECRET = "test-cron-secret-0123456789";
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@/lib/data", () => ({ getServices: async () => svc }));
  });
  const call = async (header?: string) => {
    const { GET, POST } = await import("../src/app/api/cron/worker/route");
    const req = (m: string) => new Request("http://x/api/cron/worker", { method: m, headers: header ? { authorization: header } : {} });
    return { get: await GET(req("GET")), post: await POST(req("POST")) };
  };
  it("is disabled (503) without CRON_SECRET and forbidden (401) with the wrong one", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call(`Bearer ${SECRET}`)).get.status).toBe(503);
    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await call()).get.status).toBe(401);
    expect((await call("Bearer wrong-wrong-wrong-wrong")).post.status).toBe(401);
    vi.unstubAllEnvs();
  });
  it("with the secret: expires leases, requeues due retries, records the heartbeat", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const past = new Date(Date.now() - 3 * 3_600_000);
    // job A: claimed long ago, lease expired. job B: retry_wait whose time has passed.
    const a = (await svc.store.jobs.enqueue({ marketplace: "poshmark", jobType: "delist", executor: "extension", itemId, listingId, idempotencyKey: "A", nextRunAt: past.toISOString() })).job;
    await svc.store.jobs.claim({ executor: "extension", now: past });
    const b = (await svc.store.jobs.enqueue({ marketplace: "poshmark", jobType: "create_listing", executor: "extension", itemId, idempotencyKey: "B", nextRunAt: past.toISOString() })).job;
    await svc.store.jobs.claim({ executor: "extension", now: past, limit: 1 }); // claims B (A is no longer queued)
    await svc.store.jobs.start(b.id, past);
    await svc.store.jobs.complete(b.id, { kind: "transient", code: "timeout", message: "slow" }, new Date(past.getTime() - 3_600_000)); // next_run_at is in the past
    expect(await svc.store.worker.lastRun()).toBeNull();
    const res = (await call(`Bearer ${SECRET}`)).get;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, leasesExpired: 1, requeued: 1 });
    expect((await svc.store.jobs.get(a.id))?.status).toBe("queued");
    expect((await svc.store.jobs.get(b.id))?.status).toBe("queued");
    expect(await svc.store.worker.lastRun()).not.toBeNull();
    vi.unstubAllEnvs();
  });
});
