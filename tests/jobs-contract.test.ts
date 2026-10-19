// Data-layer contract for the job queue: jobs, devices, cursors, item sync log, needs-action, worker.
// Runs against the mock ALWAYS, and against Supabase only with RUN_SUPABASE=1 AND migration 0005 applied (skips cleanly otherwise).
import { describe, expect, it } from "vitest";
import { backends, jobTablesExist, supabaseEnabled } from "./helpers";
import { IllegalTransitionError } from "../src/lib/jobs/state-machine";
import { completeJob } from "../src/lib/jobs/store-helpers";

const ready = !supabaseEnabled || (await jobTablesExist());
if (supabaseEnabled && !ready) console.warn("[jobs-contract] Supabase run skipped: migration 0005 tables are not on the project yet");
const targets = backends.filter((b) => b.name === "mock" || ready);

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

describe.each(targets)("job queue contract: $name", (b) => {
  const { make } = b;
  const signedIn = async (idx: 0 | 1 = 0) => make().user(idx);
  const fixture = async (idx: 0 | 1 = 0) => {
    const s = await signedIn(idx);
    const item = await s.store.items.create({ title: "Polo", sku: "J1", status: "listed" });
    const listing = await s.store.listings.upsert({ itemId: item.id, marketplace: "poshmark", externalId: "p1", url: "https://p/1", price: 1, status: "active", listedAt: null, endedAt: null, source: "manual" });
    return { ...s, item, listing };
  };
  const delist = (item: string, listing: string, key?: string) => ({ marketplace: "poshmark" as const, jobType: "delist" as const, executor: "extension" as const, itemId: item, listingId: listing, idempotencyKey: key });

  it("signed-out calls are rejected", async () => {
    const { client } = make();
    const c = client();
    await expect(c.store.jobs.list()).rejects.toThrow(/signed in/i);
    await expect(c.store.jobs.enqueue({ marketplace: "ebay", jobType: "sync_status", executor: "api" })).rejects.toThrow();
    await expect(c.store.devices.list()).rejects.toThrow();
    await expect(c.store.cursors.list()).rejects.toThrow();
    await expect(c.store.itemSyncLog.list()).rejects.toThrow();
    await expect(c.store.jobs.claim({ executor: "api" })).rejects.toThrow();
  });

  it("enqueue: defaults, log event, dedupe on an OPEN idempotency key, key freed by a finished job", async () => {
    const { store, item, listing } = await fixture();
    const a = await store.jobs.enqueue(delist(item.id, listing.id, "k1"));
    expect(a.created).toBe(true);
    expect(a.job).toMatchObject({ status: "queued", priority: 0, attempts: 0, maxAttempts: 5, executor: "extension", payload: {}, itemId: item.id, listingId: listing.id, claimedByDevice: null });
    const c = await store.jobs.enqueue({ marketplace: "poshmark", jobType: "create_listing", executor: "extension", itemId: item.id, payload: { title: "x", n: 1 } });
    expect(c.job).toMatchObject({ priority: 10, payload: { title: "x", n: 1 }, idempotencyKey: null });
    const dup = await store.jobs.enqueue(delist(item.id, listing.id, "k1"));
    expect(dup).toMatchObject({ created: false, job: { id: a.job.id } });
    expect((await store.jobs.enqueue({ ...delist(item.id, listing.id), idempotencyKey: undefined })).created).toBe(true); // no key = no dedupe
    expect((await store.jobs.enqueue({ ...delist(item.id, listing.id), idempotencyKey: undefined })).created).toBe(true);
    expect((await store.jobs.events([a.job.id])).map((e) => [e.fromStatus, e.toStatus])).toEqual([[null, "queued"]]);
    await store.jobs.cancel(a.job.id);
    const again = await store.jobs.enqueue(delist(item.id, listing.id, "k1"));
    expect(again.created).toBe(true);
    expect(again.job.id).not.toBe(a.job.id);
  });

  it("enqueue rejects an item or listing that is not yours", async () => {
    const env = make();
    const a = await env.user(0), bb = await env.user(1);
    const item = await a.store.items.create({ title: "A's" });
    await expect(bb.store.jobs.enqueue({ marketplace: "ebay", jobType: "create_listing", executor: "api", itemId: item.id })).rejects.toThrow();
    await expect(bb.store.itemSyncLog.append({ event: "linked", source: "manual", itemId: item.id })).rejects.toThrow();
  });

  it("list filters (status / item / listing / limit), newest first; get; counts", async () => {
    const { store, item, listing } = await fixture();
    const j1 = (await store.jobs.enqueue(delist(item.id, listing.id, "a"))).job;
    await new Promise((r) => setTimeout(r, 5)); // distinct created_at so "newest first" is well-defined
    const j2 = (await store.jobs.enqueue({ marketplace: "ebay", jobType: "sync_status", executor: "api" })).job;
    await store.jobs.cancel(j1.id);
    expect((await store.jobs.list()).map((j) => j.id)).toEqual([j2.id, j1.id]);
    expect((await store.jobs.list({ status: "canceled" })).map((j) => j.id)).toEqual([j1.id]);
    expect((await store.jobs.list({ status: ["queued", "canceled"] }))).toHaveLength(2);
    expect((await store.jobs.list({ itemId: item.id })).map((j) => j.id)).toEqual([j1.id]);
    expect((await store.jobs.list({ listingId: listing.id })).map((j) => j.id)).toEqual([j1.id]);
    expect(await store.jobs.list({ limit: 1 })).toHaveLength(1);
    expect((await store.jobs.get(j2.id))?.marketplace).toBe("ebay");
    expect(await store.jobs.get("11111111-1111-4111-8111-111111111111")).toBeNull();
    expect(await store.jobs.counts()).toEqual({ queued: 1, claimed: 0, running: 0, succeeded: 0, retry_wait: 0, failed: 0, needs_user: 0, canceled: 1 });
  });

  it("claim: delist/mark_sold before create/update before sync, due-only, executor-only, limit, 10-minute lease, attempt counted", async () => {
    const { store, item, listing } = await fixture();
    const old = ago(2 * 3_600_000).toISOString();
    const sync = (await store.jobs.enqueue({ marketplace: "poshmark", jobType: "sync_status", executor: "extension", nextRunAt: old })).job;
    const create = (await store.jobs.enqueue({ marketplace: "poshmark", jobType: "create_listing", executor: "extension", itemId: item.id, nextRunAt: old })).job;
    const apiJob = (await store.jobs.enqueue({ marketplace: "ebay", jobType: "delist", executor: "api", nextRunAt: old })).job;
    const future = (await store.jobs.enqueue({ ...delist(item.id, listing.id, "future"), nextRunAt: new Date(Date.now() + 3_600_000).toISOString() })).job;
    const sold = (await store.jobs.enqueue({ marketplace: "poshmark", jobType: "mark_sold", executor: "extension", itemId: item.id, listingId: listing.id, idempotencyKey: "ms" })).job;
    await new Promise((r) => setTimeout(r, 15));
    const got = await store.jobs.claim({ executor: "extension", limit: 10 });
    expect(got.map((j) => j.id)).toEqual([sold.id, create.id, sync.id]); // priority first, then due time
    for (const j of got) {
      expect(j).toMatchObject({ status: "claimed", attempts: 1 });
      const lease = new Date(j.leaseExpiresAt!).getTime() - Date.now();
      expect(lease).toBeGreaterThan(9 * MIN);
      expect(lease).toBeLessThanOrEqual(10 * MIN);
    }
    expect((await store.jobs.get(future.id))?.status).toBe("queued");     // not due
    expect((await store.jobs.get(apiJob.id))?.status).toBe("queued");     // other executor
    expect(await store.jobs.claim({ executor: "extension" })).toEqual([]); // nothing left that is due
    expect((await store.jobs.claim({ executor: "api" })).map((j) => j.id)).toEqual([apiJob.id]);
    expect((await store.jobs.events([sold.id])).map((e) => e.toStatus)).toEqual(["queued", "claimed"]);
  });

  it("claim is atomic: two simultaneous claims never get the same job", async () => {
    const { store, item } = await fixture();
    for (let n = 0; n < 4; n++) await store.jobs.enqueue({ marketplace: "poshmark", jobType: "update_listing", executor: "extension", itemId: item.id, listingId: undefined, idempotencyKey: `u${n}`, nextRunAt: ago(MIN).toISOString() });
    await new Promise((r) => setTimeout(r, 15));
    const [x, y] = await Promise.all([store.jobs.claim({ executor: "extension", limit: 3 }), store.jobs.claim({ executor: "extension", limit: 3 })]);
    const ids = [...x, ...y].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
  });

  it("start -> complete: success; transient backs off 5 / 15 min; 5th failure is final; hard fails at once; needs_user waits", async () => {
    const { store, item } = await fixture();
    const mk = async (key: string) => (await store.jobs.enqueue({ marketplace: "poshmark", jobType: "update_listing", executor: "extension", itemId: item.id, idempotencyKey: key, nextRunAt: ago(MIN).toISOString() })).job;
    const run = async (id: string, now = new Date()) => { await store.jobs.start(id, now); };

    const ok = await mk("ok");
    await store.jobs.claim({ executor: "extension" }); await run(ok.id);
    expect(await store.jobs.complete(ok.id, { kind: "success", result: { url: "u" } })).toMatchObject({ status: "succeeded", result: { url: "u" }, leaseExpiresAt: null });

    const t0 = new Date();
    const slow = await mk("slow");
    await store.jobs.claim({ executor: "extension" }); await run(slow.id, t0);
    const w1 = await store.jobs.complete(slow.id, { kind: "transient", code: "timeout", message: "slow" }, t0);
    expect(w1.status).toBe("retry_wait");
    expect(new Date(w1.nextRunAt).getTime() - t0.getTime()).toBe(5 * MIN);
    expect(w1).toMatchObject({ lastError: "slow", lastErrorCode: "timeout", attempts: 1 });
    expect(await store.jobs.claim({ executor: "extension", now: new Date(t0.getTime() + 6 * MIN) })).toEqual([]); // retry_wait is not claimable

    const hard = await mk("hard");
    await store.jobs.claim({ executor: "extension" }); await run(hard.id);
    expect(await store.jobs.complete(hard.id, { kind: "hard", code: "rejected", message: "Brand not allowed" })).toMatchObject({ status: "failed", lastError: "Brand not allowed" });

    const user = await mk("user");
    await store.jobs.claim({ executor: "extension" }); await run(user.id);
    expect(await store.jobs.complete(user.id, { kind: "needs_user", code: "captcha", message: "Captcha" })).toMatchObject({ status: "needs_user", lastErrorCode: "captcha" });

    // illegal transitions throw the shared error type and change nothing
    await expect(store.jobs.start(ok.id)).rejects.toBeInstanceOf(IllegalTransitionError);
    await expect(store.jobs.complete(ok.id, { kind: "success" })).rejects.toBeInstanceOf(IllegalTransitionError);
    await expect(store.jobs.cancel(ok.id)).rejects.toBeInstanceOf(IllegalTransitionError);
    await expect(store.jobs.retry(slow.id)).rejects.toBeInstanceOf(IllegalTransitionError);
    await expect(store.jobs.start("11111111-1111-4111-8111-111111111111")).rejects.toThrow(/not found/i);
    expect((await store.jobs.get(ok.id))?.status).toBe("succeeded");
  });

  it("5 attempts then failed; manual retry gives a fresh round; extendLease moves the lease", async () => {
    const { store, item } = await fixture();
    const j = (await store.jobs.enqueue({ marketplace: "poshmark", jobType: "update_listing", executor: "extension", itemId: item.id, nextRunAt: ago(10 * 3_600_000).toISOString() })).job;
    let now = ago(9 * 3_600_000);
    const waits: number[] = [];
    for (let n = 1; n <= 5; n++) {
      const [c] = await store.jobs.claim({ executor: "extension", now });
      expect(c.id).toBe(j.id);
      expect(c.attempts).toBe(n);
      await store.jobs.start(j.id, now);
      if (n === 1) {
        const ext = await store.jobs.extendLease(j.id, new Date(now.getTime() + 8 * MIN));
        expect(new Date(ext.leaseExpiresAt!).getTime()).toBe(now.getTime() + 18 * MIN);
      }
      const r = await store.jobs.complete(j.id, { kind: "transient", code: "http_503", message: "down" }, now);
      if (n < 5) {
        waits.push((new Date(r.nextRunAt).getTime() - now.getTime()) / MIN);
        now = new Date(r.nextRunAt);
        await store.worker.run(); // real clock is far past now: due retries go back to queued
        expect((await store.jobs.get(j.id))?.status).toBe("queued");
      } else expect(r.status).toBe("failed");
    }
    expect(waits).toEqual([5, 15, 60, 240]);
    const retried = await store.jobs.retry(j.id);
    expect(retried).toMatchObject({ status: "queued", attempts: 0, finishedAt: null });
    expect((await store.jobs.events([j.id])).at(-1)?.message).toBe("Retried by you");
  });

  it("worker.run: expired leases go back to the queue (attempt kept) and due retries are requeued, heartbeat is stamped", async () => {
    const { store, item } = await fixture();
    const past = ago(3 * 3_600_000);
    const leased = (await store.jobs.enqueue({ marketplace: "poshmark", jobType: "update_listing", executor: "extension", itemId: item.id, idempotencyKey: "L", nextRunAt: past.toISOString() })).job;
    await store.jobs.claim({ executor: "extension", now: past });              // lease ended 2h50m ago
    const retry = (await store.jobs.enqueue({ marketplace: "poshmark", jobType: "update_listing", executor: "extension", itemId: item.id, idempotencyKey: "R", nextRunAt: past.toISOString() })).job;
    await store.jobs.claim({ executor: "extension", now: past });
    await store.jobs.start(retry.id, past);
    await store.jobs.complete(retry.id, { kind: "transient", code: "timeout", message: "t" }, past);
    const last = (await store.jobs.enqueue({ marketplace: "poshmark", jobType: "update_listing", executor: "extension", itemId: item.id, idempotencyKey: "F", maxAttempts: 1, nextRunAt: past.toISOString() })).job;
    await store.jobs.claim({ executor: "extension", now: past });              // single allowed attempt, lease expired -> failed
    const before = await store.worker.lastRun();
    const r = await store.worker.run();
    expect(r.leasesExpired).toBeGreaterThanOrEqual(2);
    expect(r.requeued).toBeGreaterThanOrEqual(1);
    expect(await store.jobs.get(leased.id)).toMatchObject({ status: "queued", attempts: 1, leaseExpiresAt: null, lastErrorCode: "lease_expired" });
    expect((await store.jobs.get(retry.id))?.status).toBe("queued");
    expect(await store.jobs.get(last.id)).toMatchObject({ status: "failed", lastErrorCode: "lease_expired" });
    expect((await store.jobs.events([leased.id])).map((e) => e.toStatus)).toEqual(["queued", "claimed", "queued"]);
    const stamped = await store.worker.lastRun();
    expect(stamped).not.toBeNull();
    if (before) expect(stamped! >= before).toBe(true);
    expect(Date.now() - new Date(stamped!).getTime()).toBeLessThan(2 * MIN);
    const again = await store.worker.run(); // idempotent: nothing left to do for our jobs
    expect(await store.jobs.get(leased.id)).toMatchObject({ status: "queued", attempts: 1 });
    expect(again.ranAt).toBeTruthy();
  });

  it("cancel from any open state; retry only from failed / needs_user", async () => {
    const { store, item } = await fixture();
    const mk = async (k: string) => (await store.jobs.enqueue({ marketplace: "poshmark", jobType: "update_listing", executor: "extension", itemId: item.id, idempotencyKey: k, nextRunAt: ago(MIN).toISOString() })).job;
    const q = await mk("q");
    expect((await store.jobs.cancel(q.id)).status).toBe("canceled");
    const r = await mk("r");
    await store.jobs.claim({ executor: "extension" });
    await store.jobs.start(r.id);
    expect((await store.jobs.cancel(r.id)).status).toBe("canceled"); // running -> canceled (kill switch)
    const n = await mk("n");
    await store.jobs.claim({ executor: "extension" }); await store.jobs.start(n.id);
    await store.jobs.complete(n.id, { kind: "needs_user", code: "signed_out", message: "Signed out" });
    expect((await store.jobs.retry(n.id)).status).toBe("queued");
  });

  it("devices: register, heartbeat (+ login state), pause, revoke; a paused or revoked device claims nothing; token hash never exposed", async () => {
    const { store, item } = await fixture();
    const d = await store.devices.register({ label: "Chrome on Windows", tokenHash: `hash-${Math.random()}` });
    expect(d).toMatchObject({ label: "Chrome on Windows", paused: false, revokedAt: null, lastSeenAt: null });
    expect(JSON.stringify(d)).not.toMatch(/hash/i);
    expect(JSON.stringify(await store.devices.list())).not.toMatch(/hash/i);
    await expect(store.devices.register({ label: "x", tokenHash: "dup" })).resolves.toBeTruthy();
    await expect(store.devices.register({ label: "y", tokenHash: "dup" })).rejects.toThrow(/already registered/);

    const t = new Date();
    const hb = await store.devices.heartbeat(d.id, { extensionVersion: "0.1.0", ipCountry: "US", marketplaces: { poshmark: true, depop: false }, now: t });
    expect(hb).toMatchObject({ extensionVersion: "0.1.0", lastIpCountry: "US" });
    expect(new Date(hb.lastSeenAt!).getTime()).toBe(t.getTime());
    expect(new Date(hb.lastPollAt!).getTime()).toBe(t.getTime());
    const t2 = new Date(t.getTime() + MIN);
    await store.devices.heartbeat(d.id, { marketplaces: { depop: true }, poll: false, now: t2 });
    const dev = (await store.devices.list()).find((x) => x.id === d.id)!;
    expect(new Date(dev.lastSeenAt!).getTime()).toBe(t2.getTime());
    expect(new Date(dev.lastPollAt!).getTime()).toBe(t.getTime()); // non-poll heartbeat leaves last_poll_at
    expect((await store.devices.marketplaceState()).map((s) => [s.marketplace, s.loggedIn]).sort()).toEqual([["depop", true], ["poshmark", true]]);

    await store.jobs.enqueue({ marketplace: "poshmark", jobType: "update_listing", executor: "extension", itemId: item.id, nextRunAt: ago(MIN).toISOString() });
    await store.devices.setPaused(d.id, true);
    expect(await store.jobs.claim({ executor: "extension", deviceId: d.id })).toEqual([]);
    await store.devices.setPaused(d.id, false);
    const [claimed] = await store.jobs.claim({ executor: "extension", deviceId: d.id });
    expect(claimed).toMatchObject({ status: "claimed", claimedByDevice: d.id });
    const rev = await store.devices.revoke(d.id);
    expect(rev.revokedAt).not.toBeNull();
    expect((await store.devices.revoke(d.id)).revokedAt).toBe(rev.revokedAt); // idempotent
    await expect(store.devices.heartbeat(d.id)).rejects.toThrow(/revoked/i);
    await store.jobs.cancel(claimed.id);
    await store.jobs.enqueue({ marketplace: "poshmark", jobType: "update_listing", executor: "extension", itemId: item.id, idempotencyKey: "after", nextRunAt: ago(MIN).toISOString() });
    expect(await store.jobs.claim({ executor: "extension", deviceId: d.id })).toEqual([]);
    await expect(store.devices.heartbeat("11111111-1111-4111-8111-111111111111")).rejects.toThrow(/not found/i);
  });

  it("cursors: advance creates / moves, fail keeps the position and records the error, scopes are separate", async () => {
    const { store } = await signedIn();
    expect(await store.cursors.get("ebay")).toBeNull();
    const t = new Date();
    const c1 = await store.cursors.advance({ marketplace: "ebay", cursor: "order-100", now: t });
    expect(c1).toMatchObject({ marketplace: "ebay", scopeKey: "default", cursor: "order-100", lastError: null });
    expect(new Date(c1.lastSuccessAt!).getTime()).toBe(t.getTime());
    const t2 = new Date(t.getTime() + 5 * MIN);
    const f = await store.cursors.fail({ marketplace: "ebay", error: "token expired", now: t2 });
    expect(f).toMatchObject({ id: c1.id, cursor: "order-100", lastError: "token expired" });
    expect(new Date(f.lastScannedAt!).getTime()).toBe(t2.getTime());
    expect(new Date(f.lastSuccessAt!).getTime()).toBe(t.getTime());
    const c2 = await store.cursors.advance({ marketplace: "ebay", cursor: "order-120" });
    expect(c2).toMatchObject({ id: c1.id, cursor: "order-120", lastError: null });
    await store.cursors.advance({ marketplace: "ebay", scopeKey: "device:abc", cursor: "x" });
    const failFirst = await store.cursors.fail({ marketplace: "poshmark", scopeKey: "device:abc", error: "never scanned" });
    expect(failFirst).toMatchObject({ cursor: null, lastSuccessAt: null, lastError: "never scanned" });
    expect(await store.cursors.list()).toHaveLength(3);
    expect((await store.cursors.get("ebay", "device:abc"))?.cursor).toBe("x");
  });

  it("item sync log: append-only entries, newest first, filters, survives item deletion with the link cleared", async () => {
    const { store, item, listing } = await fixture();
    const a = await store.itemSyncLog.append({ event: "listed", source: "api", itemId: item.id, listingId: listing.id, marketplace: "poshmark", detail: "live" });
    await new Promise((r) => setTimeout(r, 5));
    await store.itemSyncLog.append({ event: "sale_detected", source: "extension", itemId: item.id, marketplace: "ebay", ref: `sale:${Math.random()}` });
    const entries = await store.itemSyncLog.list({ itemId: item.id });
    expect(entries.map((e) => e.event)).toEqual(["sale_detected", "listed"]);
    expect(entries[1]).toMatchObject({ id: a.id, source: "api", detail: "live", jobId: null, listingId: listing.id });
    expect((await store.itemSyncLog.list({ itemId: item.id, event: "listed" })).map((e) => e.id)).toEqual([a.id]);
    expect(await store.itemSyncLog.list({ itemId: item.id, limit: 1 })).toHaveLength(1);
    await store.items.remove(item.id);
    const after = (await store.itemSyncLog.list({ event: "listed" })).find((e) => e.id === a.id);
    expect(after).toMatchObject({ itemId: null, listingId: null, detail: "live" }); // history is kept
  });

  it("needs-action: a failed delist shows, Retry-then-success clears it, mark-delisted ends the listing, ignore hides it", async () => {
    const { store, item, listing } = await fixture();
    // The real project's item_sync_log is append-only, so earlier runs leave entries (e.g. unmatched/cancelled sales) behind: ignore those.
    const residue = new Set((await store.needsAction.list()).map((e) => e.key));
    const naList = async () => (await store.needsAction.list()).filter((e) => !residue.has(e.key));
    const sale = await store.sales.record({ itemId: item.id, marketplace: "ebay", orderId: `N-${Math.random()}`, soldAt: "2026-10-18", price: 5, fees: null, promo: null, shipProvider: null, shipCost: null, source: "api" });
    const job = (await store.jobs.enqueue({ ...delist(item.id, listing.id, `delist:${listing.id}:${sale.id}`), jobType: "mark_sold", nextRunAt: ago(MIN).toISOString() })).job;
    await store.jobs.claim({ executor: "extension" }); await store.jobs.start(job.id);
    await completeJob(store, job.id, { kind: "hard", code: "rejected", message: "Listing not found" });
    let na = await naList();
    expect(na).toHaveLength(1);
    expect(na[0]).toMatchObject({ kind: "delist_failed", itemId: item.id, listingId: listing.id, jobId: job.id, sku: "J1", actions: ["retry", "open_listing", "mark_delisted", "ignore"] });
    expect((await store.itemSyncLog.list({ itemId: item.id })).map((e) => e.event)).toContain("delist_failed");

    await store.jobs.retry(job.id);
    expect(await naList()).toEqual([]);                        // queued again and fresh: in progress
    await store.jobs.claim({ executor: "extension" }); await store.jobs.start(job.id);
    await completeJob(store, job.id, { kind: "success" });
    expect((await store.listings.listForItem(item.id))[0].status).toBe("sold"); // success closes the listing
    expect(await naList()).toEqual([]);                        // empties itself once confirmed
    expect((await store.itemSyncLog.list({ itemId: item.id })).map((e) => e.event)).toContain("marked_sold");

    // second listing: ended by hand
    const l2 = await store.listings.upsert({ itemId: item.id, marketplace: "depop", externalId: null, url: null, price: 1, status: "active", listedAt: null, endedAt: null, source: "manual" });
    const j2 = (await store.jobs.enqueue({ marketplace: "depop", jobType: "mark_sold", executor: "extension", itemId: item.id, listingId: l2.id, idempotencyKey: `delist:${l2.id}:${sale.id}`, nextRunAt: ago(MIN).toISOString() })).job;
    await store.jobs.claim({ executor: "extension" }); await store.jobs.start(j2.id);
    await completeJob(store, j2.id, { kind: "hard", code: "rejected", message: "no" });
    na = await naList();
    expect(na.map((e) => e.listingId)).toEqual([l2.id]);
    await store.needsAction.ignore(na[0].key);
    expect(await naList()).toEqual([]);

    const j3 = await store.listings.upsert({ itemId: item.id, marketplace: "grailed", externalId: null, url: null, price: 1, status: "active", listedAt: null, endedAt: null, source: "manual" });
    const open = (await store.jobs.enqueue({ marketplace: "grailed", jobType: "mark_sold", executor: "extension", itemId: item.id, listingId: j3.id, idempotencyKey: `delist:${j3.id}:${sale.id}` })).job;
    await store.needsAction.markDelisted(j3.id);
    expect((await store.listings.listForItem(item.id)).find((l) => l.id === j3.id)).toMatchObject({ status: "ended" });
    expect((await store.jobs.get(open.id))?.status).toBe("canceled");           // the pending job was canceled
    expect((await store.itemSyncLog.list({ itemId: item.id, event: "delisted" })).length).toBe(1);
    await expect(store.needsAction.markDelisted("11111111-1111-4111-8111-111111111111")).rejects.toThrow(/not found/i);
  });

  it("isolation: user B cannot see, claim, change or enqueue against user A's queue data", async () => {
    const env = make();
    const a = await env.user(0), bb = await env.user(1);
    const item = await a.store.items.create({ title: "A's" });
    const job = (await a.store.jobs.enqueue({ marketplace: "ebay", jobType: "create_listing", executor: "api", itemId: item.id, nextRunAt: ago(MIN).toISOString() })).job;
    const dev = await a.store.devices.register({ label: "A's browser", tokenHash: `h-${Math.random()}` });
    await a.store.cursors.advance({ marketplace: "ebay", cursor: "secret" });
    await a.store.itemSyncLog.append({ event: "listed", source: "manual", itemId: item.id });

    expect(await bb.store.jobs.list()).toEqual([]);
    expect(await bb.store.jobs.get(job.id)).toBeNull();
    expect(await bb.store.jobs.events([job.id])).toEqual([]);
    expect(await bb.store.jobs.claim({ executor: "api", limit: 10 })).toEqual([]);
    await expect(bb.store.jobs.cancel(job.id)).rejects.toThrow(/not found/i);
    await expect(bb.store.jobs.start(job.id)).rejects.toThrow();
    expect(await bb.store.devices.list()).toEqual([]);
    await expect(bb.store.devices.setPaused(dev.id, true)).rejects.toThrow();
    await expect(bb.store.devices.heartbeat(dev.id)).rejects.toThrow();
    expect(await bb.store.devices.marketplaceState()).toEqual([]);
    expect(await bb.store.cursors.list()).toEqual([]);
    expect(await bb.store.cursors.get("ebay")).toBeNull();
    expect(await bb.store.itemSyncLog.list()).toEqual([]);
    expect(await bb.store.needsAction.list()).toEqual([]);
    expect((await a.store.jobs.get(job.id))?.status).toBe("queued"); // untouched
    await expect(bb.store.jobs.claim({ executor: "extension", deviceId: dev.id })).resolves.toEqual([]); // A's device is not B's
  });
});

// Real project WITHOUT migration 0005: the contract run above is skipped, but the app must keep working. Proves the real PostgREST
// "table/function not found" errors become SchemaMissingError, so Mission Control / Jobs / item pages degrade instead of crashing.
describe.runIf(supabaseEnabled && !ready)("supabase WITHOUT the 0005 tables (contract run skipped)", () => {
  it("every job-queue call raises SchemaMissingError and loadOverview reports schemaMissing without throwing", async () => {
    const { SchemaMissingError } = await import("../src/lib/data/types");
    const { loadOverview } = await import("../src/lib/jobs/overview");
    const { store } = await backends.find((x) => x.name === "supabase")!.make().user(0);
    await expect(store.jobs.list()).rejects.toBeInstanceOf(SchemaMissingError);
    await expect(store.jobs.counts()).rejects.toBeInstanceOf(SchemaMissingError);        // rpc job_counts missing
    await expect(store.jobs.claim({ executor: "api" })).rejects.toBeInstanceOf(SchemaMissingError); // rpc claim_jobs missing
    await expect(store.devices.list()).rejects.toBeInstanceOf(SchemaMissingError);
    await expect(store.cursors.list()).rejects.toBeInstanceOf(SchemaMissingError);
    await expect(store.itemSyncLog.list()).rejects.toBeInstanceOf(SchemaMissingError);
    await expect(store.worker.lastRun()).rejects.toBeInstanceOf(SchemaMissingError);
    await expect(store.worker.run()).rejects.toBeInstanceOf(SchemaMissingError);         // rpc job_maintenance missing
    await expect(store.needsAction.list()).rejects.toBeInstanceOf(SchemaMissingError);
    expect(await loadOverview(store)).toMatchObject({ ready: false, schemaMissing: true, health: null, needsAction: [] });
    expect(await store.items.list()).toBeDefined(); // everything that existed before keeps working
  });
});
