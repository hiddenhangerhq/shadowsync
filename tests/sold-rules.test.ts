// Sold-item rules (David, 2026-10-19): delete vs Not For Sale, Sold vs Sold but still active, relist guard, sold seen live.
import { describe, expect, it } from "vitest";
import { backends } from "./helpers";
import { classifySold, endMode, isRelist, relistBlocked } from "../src/lib/jobs/sold";
import { computeNeedsAction } from "../src/lib/jobs/needs-action";
import { buildActionRequest } from "../src/lib/ext/protocol";
import { processListingsReport, processScanReport } from "../src/lib/jobs/sale-detection";
import { createJob } from "../src/lib/jobs/api";
import { extPairComplete, extPoll, pairStart } from "../src/lib/ext/api";
import { resetRateLimits } from "../src/lib/ext/ratelimit";
import type { Item, Job, Listing, NeedsActionEntry } from "../src/lib/data/types";

const mock = backends.find((b) => b.name === "mock")!;
const ID = "a1b2c3d4e5f6a1b2c3d4e5f6";

describe("pure rules", () => {
  it("relist guard covers create, edit and restock, never a delist or quantity 0", () => {
    expect(isRelist("create_listing", {})).toBe(true);
    expect(isRelist("update_listing", { price: 3 })).toBe(true);
    expect(isRelist("update_listing", { quantity: 2 })).toBe(true);
    expect(isRelist("update_listing", { quantity: 0 })).toBe(false);
    expect(isRelist("update_listing", { quantity: 0, price: 3 })).toBe(true);
    expect(isRelist("delist", {})).toBe(false);
    expect(relistBlocked("create_listing", {}, "listed")).toBe(false);
    expect(relistBlocked("create_listing", {}, "sold")).toBe(true);
  });
  it("delete only when the setting says delete AND the sale is confirmed", () => {
    expect(endMode("delete", true)).toBe("delete");
    expect(endMode("delete", false)).toBe("not_for_sale");
    expect(endMode("not_for_sale", true)).toBe("not_for_sale");
    const job = { id: "j", marketplace: "poshmark" as const, jobType: "mark_sold" as const, payload: { saleId: "s1" } };
    const item = { title: "x", description: null, askingPrice: 1, brand: null, size: null, status: "sold" };
    expect(buildActionRequest(job, { listing: { externalId: ID, url: null }, item, soldAction: "delete", saleConfirmed: true })?.payload.mode).toBe("delete");
    expect(buildActionRequest(job, { listing: { externalId: ID, url: null }, item, soldAction: "delete", saleConfirmed: false })?.payload.mode).toBe("not_for_sale");
    expect(buildActionRequest(job, { listing: { externalId: ID, url: null }, item })?.payload.mode).toBe("not_for_sale");
    expect(buildActionRequest({ ...job, jobType: "create_listing", payload: {} }, { item })).toMatchObject({ itemSold: true });
  });
  it("Sold vs Sold but still active, naming the marketplaces; moves to Sold once cleared", () => {
    const it = { id: "i1", status: "sold" } as Item;
    const l = (marketplace: Listing["marketplace"], status: Listing["status"]) => ({ id: `l-${marketplace}`, itemId: "i1", marketplace, status }) as Listing;
    const j = (marketplace: Job["marketplace"], status: Job["status"]) => ({ id: `j-${marketplace}`, itemId: "i1", marketplace, jobType: "delist", status }) as Job;
    const na = (marketplace: NeedsActionEntry["marketplace"], kind: NeedsActionEntry["kind"]) => ({ itemId: "i1", marketplace, kind }) as NeedsActionEntry;
    const v = (ls: Listing[], js: Job[] = [], ns: NeedsActionEntry[] = []) => classifySold([it, { id: "i2", status: "listed" } as Item], ls, js, ns).get("i1");
    expect(v([l("ebay", "sold"), l("poshmark", "ended")])).toEqual({ state: "sold", marketplaces: [] });
    expect(v([l("ebay", "sold"), l("poshmark", "active"), l("depop", "active")])).toEqual({ state: "sold_still_active", marketplaces: ["depop", "poshmark"] });
    expect(v([l("poshmark", "ended")], [j("poshmark", "queued")])?.marketplaces).toEqual(["poshmark"]); // pending
    expect(v([l("poshmark", "ended")], [j("poshmark", "needs_user")])?.state).toBe("sold_still_active");
    expect(v([l("poshmark", "ended")], [j("poshmark", "succeeded")])?.state).toBe("sold");
    expect(v([l("poshmark", "ended")], [], [na("poshmark", "delist_failed")])?.marketplaces).toEqual(["poshmark"]); // failed
    expect(v([l("poshmark", "ended")], [], [na("poshmark", "sold_still_listed")])?.state).toBe("sold_still_active"); // fallback / seen live
    expect(v([l("poshmark", "ended")], [], [na(null, "unmatched_sale")])?.state).toBe("sold");
    expect(classifySold([{ id: "i2", status: "listed" } as Item], [], [], []).size).toBe(0);
  });
});

describe("on the mock store", () => {
  const setup = async () => {
    resetRateLimits();
    const env = mock.make();
    const svc = await env.user(0);
    const item = await svc.store.items.create({ title: "Polo", sku: "S1", status: "listed", askingPrice: 25 });
    const posh = await svc.store.listings.upsert({ itemId: item.id, marketplace: "poshmark", externalId: ID, url: `https://poshmark.com/listing/${ID}`, price: 25, status: "active", listedAt: null, endedAt: null, source: "manual" });
    return { env, svc, item, posh };
  };
  it("dashboard API refuses a relist for a Sold item with a clear 409", async () => {
    const { svc, item } = await setup();
    await svc.store.items.update(item.id, { status: "sold" });
    const r = await createJob(svc, { marketplace: "depop", jobType: "create_listing", itemId: item.id });
    expect(r).toMatchObject({ status: 409, body: { code: "relist_blocked", error: expect.stringMatching(/Sold in Shadow Sync/) } });
  });
  it("a relist job queued BEFORE the item sold is failed at poll time and never reaches the extension", async () => {
    const { env, svc, item } = await setup();
    const { job } = await svc.store.jobs.enqueue({ marketplace: "poshmark", jobType: "update_listing", executor: "extension", itemId: item.id, payload: { price: 30 }, nextRunAt: new Date(Date.now() - 60_000).toISOString() });
    await svc.store.items.update(item.id, { status: "sold" });
    const code = (await pairStart(svc)).body.code;
    const token = String((await extPairComplete(env.client(), { code, extensionVersion: "0.1.0" }, "1.1.1.1")).body.token);
    const r = await extPoll(env.client(), token, { extensionVersion: "0.1.0", marketplaces: { poshmark: true }, ready: ["poshmark"] }, "1.1.1.1");
    expect(r.body.jobs).toEqual([]);
    expect(await svc.store.jobs.get(job.id)).toMatchObject({ status: "failed", lastErrorCode: "relist_blocked" });
  });
  it("scans flag a Sold item seen live again: a second order for it, or its listing still live", async () => {
    const { svc, item, posh } = await setup();
    const sale = (orderId: string) => ({ orderId, soldAt: "2026-10-18", price: 25, externalListingId: ID });
    await processScanReport(svc.store, { marketplace: "poshmark", source: "extension", sales: [sale("O1")], nextCursor: null });
    expect((await svc.store.items.get(item.id))?.status).toBe("sold");
    await processScanReport(svc.store, { marketplace: "poshmark", source: "extension", sales: [sale("O1"), sale("O2")], nextCursor: null });
    const flags = await svc.store.itemSyncLog.list({ event: "sold_seen_live" });
    expect(flags).toHaveLength(1);
    expect(flags[0].ref).toMatch(/^sold_again:/);
    await svc.store.listings.upsert({ ...posh, status: "active" });
    expect(await processListingsReport(svc.store, { marketplace: "poshmark", externalIds: [ID], source: "reconcile" })).toEqual({ seen: 1, flagged: 1 });
    expect((await svc.store.needsAction.list()).filter((n) => n.itemId === item.id && n.kind === "sold_still_listed").length).toBeGreaterThanOrEqual(2);
    // An unsold item seen live is not flagged.
    const other = await svc.store.items.create({ title: "Hat", sku: "S2", status: "listed" });
    await svc.store.listings.upsert({ itemId: other.id, marketplace: "poshmark", externalId: "b".repeat(24), url: null, price: 5, status: "active", listedAt: null, endedAt: null, source: "manual" });
    expect(await processListingsReport(svc.store, { marketplace: "poshmark", externalIds: ["b".repeat(24)], source: "extension" })).toEqual({ seen: 1, flagged: 0 });
  });
});

describe("needs-action rule 4 after the item is removed", () => {
  it("drops delete_fallback / sold_seen_live flags whose item no longer exists (log row kept, item_id nulled)", () => {
    const e = (itemId: string | null, ref: string, event: "delete_fallback" | "sold_seen_live") =>
      ({ id: ref, userId: "u", itemId, listingId: null, marketplace: "poshmark", at: "2026-10-19T00:00:00Z", event, source: "extension", jobId: null, detail: null, ref }) as const;
    const item = { id: "i1", sku: "S1", title: "Hat" } as unknown as Item;
    const out = computeNeedsAction({ items: [item], listings: [], sales: [], jobs: [], now: new Date("2026-10-19T01:00:00Z"),
      syncLog: [e("i1", "sold_again:1", "sold_seen_live"), e(null, "sold_again:2", "sold_seen_live"), e("gone", "delete_fallback:x", "delete_fallback")] });
    expect(out.map((n) => n.key)).toEqual(["sold_again:1"]);
  });
});
