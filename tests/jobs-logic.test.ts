// Pure rules around the queue: needs-action list, health banner states, validation, timeline, cron auth.
import { describe, expect, it } from "vitest";
import { computeNeedsAction, GRACE_MS } from "../src/lib/jobs/needs-action";
import { computeHealth, formatAge, type HealthInput } from "../src/lib/jobs/health";
import { parseCreateJob, parseLimit, parseStatusFilter } from "../src/lib/jobs/validate";
import { buildTimeline } from "../src/lib/jobs/timeline";
import { authorizeCron } from "../src/lib/jobs/cron";
import { buildNewJob } from "../src/lib/jobs/state-machine";
import type { ExtensionDevice, Item, ItemSyncLogEntry, Job, Listing, Sale, ScanCursor } from "../src/lib/data/types";

const NOW = new Date("2026-10-18T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const item = { id: "i1", sku: "1001", title: "Polo" } as Item;
const listing = (o: Partial<Listing> = {}): Listing => ({ id: "l1", userId: "u", itemId: "i1", marketplace: "poshmark", externalId: null, url: "https://p/1", price: 1, status: "active", listedAt: null, endedAt: null, source: "manual", createdAt: ago(99 * MIN), ...o });
const soldOnEbay = (o: Partial<Sale> = {}): Sale => ({ id: "s1", userId: "u", itemId: "i1", marketplace: "ebay", orderId: "O1", soldAt: "2026-10-18", price: 1, fees: null, promo: null, shipProvider: null, shipCost: null, sku: null, title: null, shipBy: null, shippedAt: null, source: "api", createdAt: ago(60 * MIN), ...o });
const job = (o: Partial<Job> = {}): Job => ({ ...buildNewJob({ marketplace: "poshmark", jobType: "mark_sold", executor: "extension", itemId: "i1", listingId: "l1" }, { id: "j1", userId: "u" }, new Date(ago(60 * MIN))), ...o });
const na = (o: Partial<Parameters<typeof computeNeedsAction>[0]> = {}) => computeNeedsAction({ items: [item], listings: [listing()], sales: [soldOnEbay()], jobs: [], syncLog: [], now: NOW, ...o });
const logEntry = (o: Partial<ItemSyncLogEntry>): ItemSyncLogEntry => ({ id: "e" + Math.random(), userId: "u", itemId: null, listingId: null, marketplace: null, at: ago(MIN), event: "sale_cancelled", source: "api", jobId: null, detail: null, ref: null, ...o });

describe("needs-action ('Sold but still listed')", () => {
  it("is empty when nothing was sold, the listing is already ended/sold, or the sale was on the same marketplace", () => {
    expect(na({ sales: [] })).toEqual([]);
    expect(na({ listings: [listing({ status: "ended" })] })).toEqual([]);
    expect(na({ listings: [listing({ marketplace: "ebay" })] })).toEqual([]);
    expect(na({ listings: [listing({ status: "sold" })] })).toEqual([]);
  });
  it("flags sold-elsewhere + still active + no job after the 15 minute grace, not before", () => {
    expect(na({ sales: [soldOnEbay({ createdAt: ago(GRACE_MS - 1000) })] })).toEqual([]);
    const [e] = na({ sales: [soldOnEbay({ createdAt: ago(GRACE_MS + 1000) })] });
    expect(e).toMatchObject({ kind: "sold_still_listed", sku: "1001", marketplace: "poshmark", url: "https://p/1", actions: ["open_listing", "mark_delisted", "ignore"] });
    expect(e.overdueMs).toBe(GRACE_MS + 1000);
  });
  it("a fresh queued/running delist is in progress, an old one is 'stuck' (risk of overselling)", () => {
    expect(na({ jobs: [job({ status: "queued", createdAt: ago(5 * MIN) })] })).toEqual([]);
    expect(na({ jobs: [job({ status: "running", createdAt: ago(10 * MIN) })] })).toEqual([]);
    const [e] = na({ jobs: [job({ status: "queued", createdAt: ago(20 * MIN) })] });
    expect(e).toMatchObject({ kind: "delist_stuck", jobId: "j1" });
    expect(e.message).toMatch(/oversell/);
  });
  it("needs_user shows at once with Retry; a failed delist is red-flagged with the reason", () => {
    const [stuck] = na({ jobs: [job({ status: "needs_user", createdAt: ago(MIN), lastError: "Signed out of Poshmark" })] });
    expect(stuck).toMatchObject({ kind: "delist_stuck", actions: ["retry", "open_listing", "mark_delisted", "ignore"] });
    expect(stuck.message).toMatch(/Signed out/);
    const [failed] = na({ jobs: [job({ status: "failed", lastError: "Listing not found", finishedAt: ago(30 * MIN) })] });
    expect(failed).toMatchObject({ kind: "delist_failed", jobId: "j1", since: ago(30 * MIN) });
    expect(failed.message).toMatch(/Listing not found/);
  });
  it("uses the NEWEST job for the listing (a retry that succeeded clears an older failure)", () => {
    const old = job({ id: "old", status: "failed", createdAt: ago(50 * MIN), finishedAt: ago(45 * MIN) });
    const fresh = job({ id: "new", status: "queued", createdAt: ago(2 * MIN) });
    expect(na({ jobs: [old, fresh] })).toEqual([]);
  });
  it("empties itself once the delist is confirmed (listing ended)", () => {
    expect(na({ jobs: [job({ status: "failed" })] })).toHaveLength(1);
    expect(na({ jobs: [job({ status: "succeeded" })], listings: [listing({ status: "ended" })] })).toEqual([]);
  });
  it("Ignore hides exactly that entry", () => {
    const [e] = na({ jobs: [job({ status: "failed" })] });
    expect(na({ jobs: [job({ status: "failed" })], syncLog: [logEntry({ event: "needs_action_ignored", ref: e.key })] })).toEqual([]);
  });
  it("orders failed delists first, then stuck, then the rest, oldest first", () => {
    const l2 = listing({ id: "l2", marketplace: "wix" });
    const l3 = listing({ id: "l3", marketplace: "depop" });
    const out = na({
      listings: [listing(), l2, l3],
      jobs: [job({ id: "a", listingId: "l2", status: "failed", marketplace: "wix" }), job({ id: "b", listingId: "l3", status: "needs_user", marketplace: "depop" })],
    });
    expect(out.map((e) => e.kind)).toEqual(["delist_failed", "delist_stuck", "sold_still_listed"]);
  });
  it("lists cancelled sales and unmatched live sales from their log entries, and an unmatched sale that gets an item disappears", () => {
    const out = na({ sales: [], listings: [], syncLog: [logEntry({ event: "sale_cancelled", ref: "sale_cancelled:ebay:O9", detail: "Order O9 cancelled", itemId: "i1" })] });
    expect(out).toMatchObject([{ kind: "sale_cancelled", key: "sale_cancelled:ebay:O9", sku: "1001" }]);
    const unmatched = logEntry({ event: "sale_unmatched", ref: "unmatched_sale:s7", marketplace: "ebay", detail: "no match" });
    expect(na({ listings: [], sales: [soldOnEbay({ id: "s7", itemId: null })], syncLog: [unmatched] })).toHaveLength(1);
    expect(na({ listings: [], sales: [soldOnEbay({ id: "s7", itemId: "i1" })], syncLog: [unmatched] })).toEqual([]);
  });
});

describe("status banner health (spec section 6)", () => {
  const dev = (o: Partial<ExtensionDevice> = {}): ExtensionDevice => ({ id: "d1", userId: "u", label: "Chrome", extensionVersion: "1", createdAt: ago(99 * MIN), lastSeenAt: ago(MIN), lastPollAt: ago(MIN), lastIpCountry: null, revokedAt: null, paused: false, ...o });
  const base = (o: Partial<HealthInput> = {}): HealthInput => ({ now: NOW, devices: [], marketplaceState: [], jobs: [], cursors: [], needsAction: [], workerLastRunAt: ago(MIN), ...o });
  const waitingExt = job({ id: "w", status: "queued" });
  const by = (h: ReturnType<typeof computeHealth>, key: string) => h.items.find((i) => i.key === key);

  it("extension: green under 10 min", () => {
    const h = computeHealth(base({ devices: [dev({ lastSeenAt: ago(9 * MIN) })] }));
    expect(by(h, "extension")).toMatchObject({ level: "green" });
    expect(h.level).toBe("green");
  });
  it("extension: yellow 'hasn't checked in for X' from 10 to 30 min", () => {
    for (const m of [10, 29]) {
      const e = by(computeHealth(base({ devices: [dev({ lastSeenAt: ago(m * MIN) })], jobs: [waitingExt] })), "extension")!;
      expect(e.level).toBe("yellow");
      expect(e.title).toBe(`Extension hasn't checked in for ${m} min`);
    }
  });
  it("extension: red only after 30 min AND extension jobs waiting; otherwise stays yellow", () => {
    expect(by(computeHealth(base({ devices: [dev({ lastSeenAt: ago(31 * MIN) })], jobs: [waitingExt] })), "extension")).toMatchObject({ level: "red", title: "Extension not running or signed out" });
    expect(by(computeHealth(base({ devices: [dev({ lastSeenAt: ago(31 * MIN) })] })), "extension")!.level).toBe("yellow");
    expect(by(computeHealth(base({ devices: [dev({ lastSeenAt: null })], jobs: [waitingExt] })), "extension")).toMatchObject({ level: "red", detail: expect.stringContaining("Never checked in") });
  });
  it("extension: revoked token is red with jobs waiting, no device paired is red with jobs waiting, silent otherwise", () => {
    expect(by(computeHealth(base({ devices: [dev({ revokedAt: ago(MIN) })], jobs: [waitingExt] })), "extension")).toMatchObject({ level: "red", title: "Extension access was revoked" });
    expect(by(computeHealth(base({ jobs: [waitingExt] })), "extension")).toMatchObject({ level: "red", title: "No browser extension is paired" });
    expect(by(computeHealth(base()), "extension")).toBeUndefined();
  });
  it("extension: paused is yellow; needs_user jobs do not count as 'waiting'", () => {
    expect(by(computeHealth(base({ devices: [dev({ paused: true })] })), "extension")).toMatchObject({ level: "yellow", title: "Extension is paused" });
    expect(by(computeHealth(base({ jobs: [job({ status: "needs_user" })] })), "extension")).toBeUndefined();
  });
  it("per marketplace: signed out shows yellow (newest state wins, revoked devices ignored)", () => {
    const st = (loggedIn: boolean, checkedAt: string, deviceId = "d1") => ({ deviceId, marketplace: "poshmark" as const, loggedIn, checkedAt, paused: false, pausedReason: null, challengeStreak: 0 });
    const h = computeHealth(base({ devices: [dev()], marketplaceState: [st(false, ago(5 * MIN))] }));
    expect(by(h, "signed_out:poshmark")).toMatchObject({ level: "yellow", title: "Signed out of Poshmark in your browser" });
    expect(by(computeHealth(base({ devices: [dev()], marketplaceState: [st(false, ago(5 * MIN)), st(true, ago(MIN))] })), "signed_out:poshmark")).toBeUndefined();
    expect(by(computeHealth(base({ devices: [dev({ revokedAt: ago(MIN) })], marketplaceState: [st(false, ago(MIN))] })), "signed_out:poshmark")).toBeUndefined();
  });
  it("worker: green when recent; red when stale (>15 min) and work is waiting; quiet when stale but idle", () => {
    expect(by(computeHealth(base({ workerLastRunAt: ago(14 * MIN) })), "worker")!.level).toBe("green");
    const retry = job({ status: "retry_wait" });
    const red = by(computeHealth(base({ workerLastRunAt: ago(16 * MIN), jobs: [retry] })), "worker")!;
    expect(red).toMatchObject({ level: "red" });
    expect(red.title).toBe("Background worker hasn't run for 16 min");
    expect(by(computeHealth(base({ workerLastRunAt: null, jobs: [retry] })), "worker")).toMatchObject({ level: "red", title: "Background worker has never run" });
    expect(by(computeHealth(base({ workerLastRunAt: ago(16 * MIN) })), "worker")!.level).toBe("green"); // idle
    expect(by(computeHealth(base({ workerLastRunAt: null })), "worker")).toBeUndefined();
    const expired = job({ status: "running", leaseExpiresAt: ago(MIN) });
    expect(by(computeHealth(base({ workerLastRunAt: ago(60 * MIN), jobs: [expired] })), "worker")!.level).toBe("red");
    expect(by(computeHealth(base({ workerLastRunAt: ago(60 * MIN), workerStaleMs: 24 * 60 * MIN, jobs: [retry] })), "worker")!.level).toBe("green"); // daily-cron setups
  });
  it("sales cursor: stuck for an hour is red, an error is yellow", () => {
    const cur = (o: Partial<ScanCursor>): ScanCursor => ({ id: "c", userId: "u", marketplace: "ebay", scopeKey: "default", cursor: "x", lastScannedAt: ago(MIN), lastSuccessAt: ago(5 * MIN), lastError: null, createdAt: ago(999 * MIN), ...o });
    expect(computeHealth(base({ cursors: [cur({})] })).items.find((i) => i.key.startsWith("cursor"))).toBeUndefined();
    expect(computeHealth(base({ cursors: [cur({ lastError: "boom" })] })).items.find((i) => i.key.startsWith("cursor"))).toMatchObject({ level: "yellow" });
    const stuck = computeHealth(base({ cursors: [cur({ lastSuccessAt: ago(61 * MIN), lastError: "token expired" })] })).items.find((i) => i.key.startsWith("cursor"))!;
    expect(stuck).toMatchObject({ level: "red", title: "Ebay sales scan is stuck" });
    expect(stuck.detail).toContain("token expired");
  });
  it("overselling risk: an unfinished delist older than 1 h is red; failed delists are red; overall level is the worst", () => {
    const old = job({ status: "retry_wait", createdAt: ago(61 * MIN) });
    expect(by(computeHealth(base({ jobs: [old] })), "oversell")).toMatchObject({ level: "red", detail: "Risk of overselling" });
    expect(by(computeHealth(base({ jobs: [job({ status: "queued", createdAt: ago(59 * MIN) })] })), "oversell")).toBeUndefined();
    expect(by(computeHealth(base({ jobs: [job({ jobType: "sync_status", status: "queued", createdAt: ago(99 * MIN) })] })), "oversell")).toBeUndefined();
    const failed = computeHealth(base({ needsAction: [{ kind: "delist_failed" } as never] }));
    expect(by(failed, "delist_failed")!.level).toBe("red");
    expect(failed.level).toBe("red");
    expect(computeHealth(base({ devices: [dev({ lastSeenAt: ago(15 * MIN) })] })).level).toBe("yellow");
    expect(computeHealth(base({ devices: [dev({ lastSeenAt: ago(15 * MIN) })], needsAction: [{ kind: "delist_failed" } as never] })).items[0].level).toBe("red"); // worst first
  });
  it("formats ages", () => {
    expect([0, 90_000, 59 * MIN, 61 * MIN, 5 * 60 * MIN, 72 * 60 * MIN].map(formatAge)).toEqual(["under a minute", "2 min", "59 min", "1 h", "5 h", "3 days"]);
  });
});

describe("request validation", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  it("accepts a valid delist and defaults optional fields", () => {
    expect(parseCreateJob({ marketplace: "poshmark", jobType: "delist", itemId: id, listingId: id })).toEqual({
      ok: true, value: { marketplace: "poshmark", jobType: "delist", itemId: id, listingId: id, idempotencyKey: null, payload: {} },
    });
    expect(parseCreateJob({ marketplace: "ebay", jobType: "sync_status" }).ok).toBe(true); // no item needed
  });
  it("rejects bad input", () => {
    const bad = (b: unknown) => { const r = parseCreateJob(b); return r.ok ? "ok" : r.error; };
    expect(bad(null)).toMatch(/object/);
    expect(bad([])).toMatch(/object/);
    expect(bad({ jobType: "delist", itemId: id, listingId: id })).toMatch(/marketplace/);
    expect(bad({ marketplace: "myspace", jobType: "delist", itemId: id, listingId: id })).toMatch(/marketplace/);
    expect(bad({ marketplace: "ebay", jobType: "rm_rf" })).toMatch(/jobType/);
    expect(bad({ marketplace: "ebay", jobType: "delist", itemId: "x", listingId: id })).toMatch(/itemId/);
    expect(bad({ marketplace: "ebay", jobType: "delist", itemId: id })).toMatch(/listingId is required/);
    expect(bad({ marketplace: "ebay", jobType: "create_listing" })).toMatch(/itemId is required/);
    expect(bad({ marketplace: "ebay", jobType: "create_listing", itemId: id, idempotencyKey: "" })).toMatch(/idempotencyKey/);
    expect(bad({ marketplace: "ebay", jobType: "create_listing", itemId: id, payload: [1] })).toMatch(/payload/);
    expect(bad({ marketplace: "ebay", jobType: "create_listing", itemId: id, payload: { x: "y".repeat(11_000) } })).toMatch(/too large/);
  });
  it("the client can never choose executor, priority, attempts or timing", () => {
    for (const k of ["executor", "priority", "maxAttempts", "nextRunAt", "status", "attempts"]) {
      expect(parseCreateJob({ marketplace: "ebay", jobType: "create_listing", itemId: id, [k]: 1 })).toMatchObject({ ok: false, error: `${k} is set by the server` });
    }
  });
  it("parses status filters and limits", () => {
    expect(parseStatusFilter("queued, failed")).toEqual({ ok: true, value: ["queued", "failed"] });
    expect(parseStatusFilter("")).toEqual({ ok: true, value: undefined });
    expect(parseStatusFilter("queued,bogus").ok).toBe(false);
    expect([parseLimit(null), parseLimit("5"), parseLimit("9999"), parseLimit("-3"), parseLimit("abc")]).toEqual([100, 5, 500, 100, 100]);
  });
});

describe("item timeline", () => {
  it("merges the item log with job events, newest first, and drops events of unknown jobs", () => {
    const j = job({ id: "j1" });
    const rows = buildTimeline(
      [logEntry({ event: "sale_detected", at: ago(60 * MIN), marketplace: "ebay", detail: "sold" })],
      [j],
      [
        { id: "1", jobId: "j1", userId: "u", at: ago(59 * MIN), fromStatus: null, toStatus: "queued", message: "Queued" },
        { id: "2", jobId: "j1", userId: "u", at: ago(10 * MIN), fromStatus: "running", toStatus: "failed", message: "Failed: x" },
        { id: "3", jobId: "other", userId: "u", at: ago(5 * MIN), fromStatus: null, toStatus: "queued", message: "not ours" },
      ],
    );
    expect(rows.map((r) => r.label)).toEqual(["mark sold: failed", "mark sold: queued", "sale detected"]);
    expect(rows[0]).toMatchObject({ kind: "job", marketplace: "poshmark", source: "extension", jobId: "j1" });
  });
});

describe("cron endpoint auth", () => {
  const secret = "s3cret-s3cret-s3cret";
  it("is off without a (long enough) secret, rejects wrong or missing credentials, accepts Bearer <secret>", () => {
    expect(authorizeCron(`Bearer ${secret}`, undefined)).toBe("unconfigured");
    expect(authorizeCron("Bearer short", "short")).toBe("unconfigured");
    expect(authorizeCron(null, secret)).toBe("forbidden");
    expect(authorizeCron("Bearer nope-nope-nope-nope", secret)).toBe("forbidden");
    expect(authorizeCron(secret, secret)).toBe("forbidden"); // missing the Bearer prefix
    expect(authorizeCron(`Bearer ${secret}`, secret)).toBe("ok");
  });
});
