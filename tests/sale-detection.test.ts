import { beforeEach, describe, expect, it } from "vitest";
import { backends } from "./helpers";
import type { DataStore } from "../src/lib/data/interfaces";
import type { Item, Listing, Marketplace } from "../src/lib/data/types";
import { executorFor, initCursor, jobTypeFor, matchItem, planDelistJobs, processScanReport, type DetectedSale, type ScanReport } from "../src/lib/jobs/sale-detection";
import { completeJob } from "../src/lib/jobs/store-helpers";

const mockBackend = backends.find((b) => b.name === "mock")!;
let store: DataStore;
let other: DataStore;

beforeEach(async () => {
  const env = mockBackend.make();
  store = (await env.user(0)).store;
  other = (await env.user(1)).store;
});

const sale = (o: Partial<DetectedSale> = {}): DetectedSale => ({ orderId: "ORD-1", soldAt: "2026-10-18", price: 40, sku: "1001", ...o });
const report = (sales: DetectedSale[], o: Partial<ScanReport> = {}): ScanReport => ({ marketplace: "ebay", source: "api", sales, nextCursor: "c1", ...o });

/** Item 1001 live on eBay, Poshmark and Wix (Etsy ended). */
async function liveItem(sku = "1001") {
  const item = await store.items.create({ title: "Polo", sku, status: "listed" });
  const mk = (marketplace: Marketplace, status: Listing["status"] = "active", externalId: string | null = `${marketplace}-${sku}`) =>
    store.listings.upsert({ itemId: item.id, marketplace, externalId, url: `https://${marketplace}.example/${sku}`, price: 40, status, listedAt: null, endedAt: null, source: "manual" });
  const ls = { ebay: await mk("ebay"), poshmark: await mk("poshmark"), wix: await mk("wix"), etsy: await mk("etsy", "ended") };
  return { item, ls };
}

describe("pure helpers", () => {
  const item = { id: "i1", sku: "AB-1" } as Item;
  const listing = { itemId: "i1", marketplace: "ebay", externalId: "123" } as Listing;
  it("matches by marketplace listing id first, then by SKU (case-insensitive), else null", () => {
    expect(matchItem({ externalListingId: "123" }, "ebay", [item], [listing])).toBe(item);
    expect(matchItem({ externalListingId: "123" }, "poshmark", [item], [listing])).toBeNull(); // id is per marketplace
    expect(matchItem({ sku: " ab-1 " }, "ebay", [item], [])).toBe(item);
    expect(matchItem({ sku: "zzz" }, "ebay", [item], [])).toBeNull();
    expect(matchItem({}, "ebay", [item], [])).toBeNull();
  });
  it("picks mark_sold for resale marketplaces and delist for the rest", () => {
    expect(jobTypeFor("poshmark")).toBe("mark_sold");
    expect(jobTypeFor("wix")).toBe("delist");
    expect(jobTypeFor("ebay")).toBe("delist");
  });
  it("executor: saved connection wins (API first), else official-API marketplaces use api, the rest the extension", () => {
    expect(executorFor("ebay", [])).toBe("api");
    expect(executorFor("poshmark", [])).toBe("extension");
    expect(executorFor("depop", [{ marketplace: "depop", connectionType: "oauth_api", status: "connected" }])).toBe("api");
    expect(executorFor("ebay", [{ marketplace: "ebay", connectionType: "extension", status: "connected" }])).toBe("extension");
    expect(executorFor("ebay", [{ marketplace: "ebay", connectionType: "extension", status: "connected" }, { marketplace: "ebay", connectionType: "oauth_api", status: "connected" }])).toBe("api");
    expect(executorFor("ebay", [{ marketplace: "ebay", connectionType: "extension", status: "disconnected" }])).toBe("api");
  });
  it("plans one job per OTHER live listing, with a key per (listing, sale)", () => {
    const ls = [
      { id: "l1", itemId: "i1", marketplace: "ebay", status: "active", externalId: "1", url: null },
      { id: "l2", itemId: "i1", marketplace: "poshmark", status: "active", externalId: null, url: null },
      { id: "l3", itemId: "i1", marketplace: "depop", status: "ended", externalId: null, url: null },
      { id: "l4", itemId: "i2", marketplace: "wix", status: "active", externalId: null, url: null },
    ] as Listing[];
    const plan = planDelistJobs({ id: "s1", marketplace: "ebay" }, { id: "i1" }, ls, []);
    expect(plan.map((p) => [p.marketplace, p.jobType, p.idempotencyKey])).toEqual([["poshmark", "mark_sold", "mark_sold:l2:s1"]]);
  });
});

describe("a detected sale", () => {
  it("is stored, marks the item sold, and queues a delist / mark_sold for every OTHER live listing", async () => {
    const { item, ls } = await liveItem();
    const r = await processScanReport(store, report([sale({ externalListingId: "ebay-1001" })]));
    expect(r).toMatchObject({ ok: true, stored: 1, duplicates: 0, jobsCreated: 2, unmatched: 0, cursorAdvanced: true });
    expect((await store.sales.list())[0]).toMatchObject({ itemId: item.id, orderId: "ORD-1", source: "api" });
    expect(await store.items.get(item.id)).toMatchObject({ status: "sold", priceSold: 40, dateSold: "2026-10-18", platform: "ebay" });

    const jobs = await store.jobs.list();
    expect(jobs.map((j) => `${j.marketplace}:${j.jobType}:${j.executor}`).sort()).toEqual(["poshmark:mark_sold:extension", "wix:delist:api"]);
    expect(jobs.every((j) => j.priority === 0 && j.status === "queued" && j.itemId === item.id)).toBe(true);
    expect(jobs.map((j) => j.listingId).sort()).toEqual([ls.poshmark.id, ls.wix.id].sort());
    const listings = await store.listings.listForItem(item.id);
    expect(listings.find((l) => l.marketplace === "ebay")?.status).toBe("sold"); // where it sold
    expect(listings.find((l) => l.marketplace === "etsy")?.status).toBe("ended"); // untouched, no job
    const log = await store.itemSyncLog.list({ itemId: item.id });
    expect(log.map((e) => e.event).sort()).toEqual(["delist_queued", "delist_queued", "sale_detected"]);
  });

  it("a delist job is claimable at once and runs before older create jobs", async () => {
    const { item } = await liveItem();
    await store.jobs.enqueue({ marketplace: "poshmark", jobType: "create_listing", executor: "extension", itemId: item.id, nextRunAt: "2020-01-01T00:00:00.000Z" });
    await processScanReport(store, report([sale()]));
    const [first] = await store.jobs.claim({ executor: "extension", limit: 1 });
    expect(first.jobType).toBe("mark_sold");
  });

  it("an overlap replay creates nothing new (no sale, no job, no log, cursor still moves)", async () => {
    const { item } = await liveItem();
    const rep = report([sale({ externalListingId: "ebay-1001" })], { nextCursor: "c1" });
    await processScanReport(store, rep);
    const jobsBefore = await store.jobs.list();
    const logBefore = await store.itemSyncLog.list({ itemId: item.id });
    const again = await processScanReport(store, { ...rep, nextCursor: "c2" });
    expect(again).toMatchObject({ ok: true, stored: 0, duplicates: 1, jobsCreated: 0, cursorAdvanced: true });
    expect(await store.sales.list()).toHaveLength(1);
    expect((await store.jobs.list()).map((j) => j.id).sort()).toEqual(jobsBefore.map((j) => j.id).sort());
    expect(await store.itemSyncLog.list({ itemId: item.id })).toHaveLength(logBefore.length);
    expect((await store.cursors.get("ebay"))?.cursor).toBe("c2");
  });

  it("replay after the delists SUCCEEDED does not re-open them", async () => {
    await liveItem();
    await processScanReport(store, report([sale()]));
    for (const j of await store.jobs.claim({ executor: "extension" })) { await store.jobs.start(j.id); await completeJob(store, j.id, { kind: "success" }); }
    for (const j of await store.jobs.claim({ executor: "api" })) { await store.jobs.start(j.id); await completeJob(store, j.id, { kind: "success" }); }
    expect((await store.jobs.list({ status: "succeeded" }))).toHaveLength(2);
    const r = await processScanReport(store, report([sale()], { nextCursor: "c3" }));
    expect(r.jobsCreated).toBe(0);
    expect(await store.jobs.list()).toHaveLength(2);
  });

  it("a canceled or failed delist is not silently re-created by a replay either", async () => {
    await liveItem();
    await processScanReport(store, report([sale()]));
    const [a, b] = await store.jobs.list();
    await store.jobs.cancel(a.id);
    await store.jobs.claim({ executor: b.executor }); await store.jobs.start(b.id);
    await store.jobs.complete(b.id, { kind: "hard", code: "rejected", message: "no" });
    expect((await processScanReport(store, report([sale()]))).jobsCreated).toBe(0);
    expect(await store.jobs.list()).toHaveLength(2);
  });

  it("two sales of the same item from different marketplaces still create one job per listing", async () => {
    await liveItem();
    await processScanReport(store, report([sale({ externalListingId: "ebay-1001" })]));
    // the item was ALSO sold on wix before its delist ran: the listing there is still active, but it gets a job per sale key, never two open for one key
    const r = await processScanReport(store, { marketplace: "wix", source: "api", sales: [{ orderId: "W-9", soldAt: "2026-10-18", price: 41, externalListingId: "wix-1001" }], nextCursor: "w1" });
    expect(r.stored).toBe(1);
    const open = (await store.jobs.list()).filter((j) => j.marketplace === "wix" && j.jobType === "delist");
    expect(open).toHaveLength(1); // the wix delist from the ebay sale; the wix sale itself needs no wix job
  });
});

describe("dedupe across sources (higher trust wins)", () => {
  it("api beats extension beats manual beats sheet-import beats email, one sale each time", async () => {
    await liveItem();
    const order = ["email", "sheet-import", "manual", "extension", "api"] as const;
    for (const [n, src] of order.entries()) {
      // record directly (the scan only produces api / extension), then confirm the store keeps the best
      await store.sales.record({ itemId: null, marketplace: "ebay", orderId: "X", soldAt: "2026-10-18", price: 10 + n, fees: null, promo: null, shipProvider: null, shipCost: null, source: src });
    }
    expect(await store.sales.list()).toHaveLength(1);
    expect((await store.sales.list())[0]).toMatchObject({ source: "api", price: 14 });
    await store.sales.record({ itemId: null, marketplace: "ebay", orderId: "X", soldAt: "2026-10-18", price: 1, fees: null, promo: null, shipProvider: null, shipCost: null, source: "email" });
    expect((await store.sales.list())[0]).toMatchObject({ source: "api", price: 14 });
  });
  it("an api scan finding a sale the legacy email import already stored upgrades it and still creates the delists", async () => {
    const { item } = await liveItem();
    await store.sales.record({ itemId: item.id, marketplace: "ebay", orderId: "ORD-1", soldAt: "2026-10-18", price: 38, fees: null, promo: null, shipProvider: null, shipCost: null, source: "email" });
    const r = await processScanReport(store, report([sale({ price: 40 })]));
    expect(r).toMatchObject({ stored: 0, duplicates: 1 });
    expect(await store.sales.list()).toHaveLength(1);
    expect((await store.sales.list())[0]).toMatchObject({ source: "api", price: 40 });
    expect(r.jobsCreated).toBe(2);
  });
});

describe("unknown items and cancelled sales go to needs-action", () => {
  it("a sale that matches no item is stored and listed, and Ignore removes it", async () => {
    await liveItem();
    const r = await processScanReport(store, report([sale({ orderId: "MYSTERY", sku: "NOPE", title: "Mystery hat" })]));
    expect(r).toMatchObject({ stored: 1, unmatched: 1, jobsCreated: 0 });
    const na = await store.needsAction.list();
    expect(na).toHaveLength(1);
    expect(na[0]).toMatchObject({ kind: "unmatched_sale", marketplace: "ebay", title: "Mystery hat", actions: ["ignore"] });
    await store.needsAction.ignore(na[0].key);
    expect(await store.needsAction.list()).toEqual([]);
    // replaying does not bring it back or log it twice
    await processScanReport(store, report([sale({ orderId: "MYSTERY", sku: "NOPE" })]));
    expect(await store.needsAction.list()).toEqual([]);
    expect((await store.itemSyncLog.list({ event: "sale_unmatched" }))).toHaveLength(1);
  });
  it("legacy sheet/email sales without an item do not flood needs-action", async () => {
    await store.sales.record({ itemId: null, marketplace: "ebay", orderId: "OLD", soldAt: "2025-01-01", price: 5, fees: null, promo: null, shipProvider: null, shipCost: null, source: "sheet-import" });
    expect(await store.needsAction.list()).toEqual([]);
  });
  it("a cancelled sale is logged once, creates no jobs, and appears in needs-action", async () => {
    const { item } = await liveItem();
    await processScanReport(store, report([sale()]));
    const jobs = (await store.jobs.list()).length;
    const rep = report([sale({ cancelled: true })], { nextCursor: "c9" });
    expect((await processScanReport(store, rep)).cancelled).toBe(1);
    expect((await processScanReport(store, rep)).cancelled).toBe(0); // replay
    expect(await store.jobs.list()).toHaveLength(jobs);
    const na = (await store.needsAction.list()).filter((e) => e.kind === "sale_cancelled");
    expect(na).toHaveLength(1);
    expect(na[0].itemId).toBe(item.id);
  });
});

describe("cursor", () => {
  it("advances only after the sales are stored: a crash mid-page keeps the cursor and a retry finishes cleanly", async () => {
    await liveItem();
    await initCursor(store, "ebay", "default", "start");
    const real = store.sales.record.bind(store.sales);
    let calls = 0;
    store.sales.record = async (input) => { if (++calls === 2) throw new Error("database blip"); return real(input); };
    const page = report([sale({ orderId: "A", soldAt: "2026-10-16", sku: "1001" }), sale({ orderId: "B", soldAt: "2026-10-17", sku: "none" }), sale({ orderId: "C", soldAt: "2026-10-18", sku: "none" })], { nextCursor: "after-C" });
    const bad = await processScanReport(store, page);
    expect(bad).toMatchObject({ ok: false, cursorAdvanced: false, error: "database blip" });
    expect(await store.sales.list()).toHaveLength(1);                    // only the first was stored
    expect(await store.cursors.get("ebay")).toMatchObject({ cursor: "start", lastError: "database blip" });
    store.sales.record = real;
    const good = await processScanReport(store, page);                   // same page is read again
    expect(good).toMatchObject({ ok: true, stored: 2, duplicates: 1, cursorAdvanced: true });
    expect(await store.sales.list()).toHaveLength(3);
    expect(await store.cursors.get("ebay")).toMatchObject({ cursor: "after-C", lastError: null });
    expect((await store.jobs.list()).filter((j) => j.jobType !== "delist" && j.jobType !== "mark_sold")).toHaveLength(0);
    expect((await store.jobs.list()).length).toBe(2); // item 1001 sold once -> 2 jobs, no duplicates from the retry
  });
  it("first connect starts at the given point and an existing cursor is never reset", async () => {
    const c = await initCursor(store, "poshmark", "device:1", "2026-10-18T00:00:00Z");
    expect(c.cursor).toBe("2026-10-18T00:00:00Z");
    await store.cursors.advance({ marketplace: "poshmark", scopeKey: "device:1", cursor: "later" });
    expect((await initCursor(store, "poshmark", "device:1", "reset?")).cursor).toBe("later");
    expect((await store.cursors.list())).toHaveLength(1);
  });
  it("a null next cursor leaves the position where it was; scopes are separate", async () => {
    await store.cursors.advance({ marketplace: "ebay", cursor: "keep" });
    await processScanReport(store, report([], { nextCursor: null }));
    expect((await store.cursors.get("ebay"))?.cursor).toBe("keep");
    await processScanReport(store, report([], { nextCursor: "x", scopeKey: "device:9" }));
    expect((await store.cursors.get("ebay"))?.cursor).toBe("keep");
    expect((await store.cursors.get("ebay", "device:9"))?.cursor).toBe("x");
  });
  it("importing history stores sales but never delists, logs or marks sold", async () => {
    const { item } = await liveItem();
    const r = await processScanReport(store, report([sale({ orderId: "H1" }), sale({ orderId: "H2", sku: "unknown" })], { history: true }));
    expect(r).toMatchObject({ stored: 2, jobsCreated: 0, unmatched: 0 });
    expect(await store.jobs.list()).toEqual([]);
    expect(await store.itemSyncLog.list()).toEqual([]);
    expect((await store.items.get(item.id))?.status).toBe("listed");
    expect(await store.needsAction.list()).toEqual([]);
  });
});

describe("isolation", () => {
  it("another user's scan data never matches this user's items or jobs", async () => {
    await liveItem();
    const r = await processScanReport(other, report([sale()]));
    expect(r.unmatched).toBe(1);
    expect(await store.jobs.list()).toEqual([]);
    expect(await store.sales.list()).toEqual([]);
  });
});
