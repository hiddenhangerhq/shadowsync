// Item page: Link existing listing + Test actions (release-checklist section 4 smoke test). All through the normal job queue.
import { describe, expect, it } from "vitest";
import { backends, extTablesExist, supabaseEnabled } from "./helpers";
import { isTestItem, linkListing, parseListingRef, queueTestAction } from "../src/lib/jobs/test-actions";
import { extJob, extPairComplete, extPoll, pairStart, resetUpkeep } from "../src/lib/ext/api";
import { resetRateLimits } from "../src/lib/ext/ratelimit";

const ready = !supabaseEnabled || (await extTablesExist());
const targets = backends.filter((b) => b.name === "mock" || ready);
const ID = "6ad5e74c23cd1ee70631c1dc";
const URL1 = `https://poshmark.com/listing/jeans-black-${ID}`;

describe("parseListingRef", () => {
  it("takes a Poshmark link or bare id, only from poshmark.com", () => {
    expect(parseListingRef("poshmark", URL1)).toEqual({ ok: true, value: { externalId: ID, url: URL1 } });
    expect(parseListingRef("poshmark", `${URL1}?utm=x#y`)).toEqual({ ok: true, value: { externalId: ID, url: URL1 } });
    expect(parseListingRef("poshmark", ID)).toEqual({ ok: true, value: { externalId: ID, url: `https://poshmark.com/listing/${ID}` } });
    for (const bad of [`https://evil.com/listing/x-${ID}`, `http://poshmark.com/listing/x-${ID}`, "https://poshmark.com/closet/me", "nope", "", `https://poshmark.com.evil.com/listing/x-${ID}`])
      expect(parseListingRef("poshmark", bad).ok).toBe(false);
    expect(parseListingRef("ebay", "https://www.ebay.com/itm/123456789012")).toEqual({ ok: true, value: { externalId: "123456789012", url: "https://www.ebay.com/itm/123456789012" } });
    expect(parseListingRef("ebay", "https://example.com/itm/1").ok).toBe(false);
  });
  it("test items are the ones whose SKU starts with TEST", () => {
    expect(isTestItem({ sku: "TEST-1" })).toBe(true);
    expect(isTestItem({ sku: "test 2" })).toBe(true);
    expect(isTestItem({ sku: "TESTER" })).toBe(false);
    expect(isTestItem({ sku: null })).toBe(false);
  });
});

describe.each(targets)("link + test actions: $name", (b) => {
  const setup = async (sku = "TEST-1") => {
    resetRateLimits();
    const env = b.make();
    const svc = await env.user(0);
    const item = await svc.store.items.create({ title: "Jeans black", sku, status: "draft", askingPrice: 20 });
    return { env, svc, item };
  };
  const link = async (svc: Awaited<ReturnType<typeof setup>>["svc"], itemId: string) => {
    const r = await linkListing(svc, itemId, { marketplace: "poshmark", ref: URL1 });
    expect(r.status).toBe(200);
    return (r.body.listing as { id: string });
  };

  it("links an existing Poshmark listing: active row, item Listed, logged; refuses another item's listing and Sold items", async () => {
    const { svc, item } = await setup();
    const l = await link(svc, item.id);
    expect((await svc.store.listings.list()).find((x) => x.id === l.id)).toMatchObject({ marketplace: "poshmark", externalId: ID, url: URL1, status: "active", price: 20, source: "manual" });
    expect((await svc.store.items.get(item.id))?.status).toBe("listed");
    expect((await svc.store.itemSyncLog.list({ itemId: item.id })).map((e) => e.event)).toContain("linked");
    const other = await svc.store.items.create({ title: "Other", sku: "X", status: "draft" });
    expect(await linkListing(svc, other.id, { marketplace: "poshmark", ref: ID })).toMatchObject({ status: 409 });
    await svc.store.items.update(other.id, { status: "sold" });
    expect(await linkListing(svc, other.id, { marketplace: "poshmark", ref: "a".repeat(24) })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/Sold/) } });
    expect(await linkListing(svc, item.id, { marketplace: "poshmark", ref: "https://evil.com/x" })).toMatchObject({ status: 400 });
  });

  it("each test button queues exactly one normal extension job with the right payload", async () => {
    const { svc, item } = await setup();
    const l = await link(svc, item.id);
    const q = async (a: string, v = "") => (await queueTestAction(svc, item.id, l.id, a, v)).body.job as { jobType: string; payload: Record<string, unknown>; executor: string; listingId: string };
    expect(await q("quantity", "2")).toMatchObject({ jobType: "update_listing", payload: { quantity: 2 }, executor: "extension", listingId: l.id });
    expect(await q("price", "18")).toMatchObject({ jobType: "update_listing", payload: { price: 18 } });
    expect(await q("title", "Jeans black test")).toMatchObject({ jobType: "update_listing", payload: { title: "Jeans black test" } });
    expect(await q("count")).toMatchObject({ jobType: "sync_status" });
    expect(await q("not_for_sale")).toMatchObject({ jobType: "delist", payload: {} });
    expect((await svc.store.jobs.list({ itemId: item.id }))).toHaveLength(5);
    for (const [a, v] of [["quantity", "-1"], ["quantity", "1.5"], ["price", "abc"], ["title", ""], ["nope", ""], ["sold_delete", "yes"]])
      expect((await queueTestAction(svc, item.id, l.id, a, v)).status).toBe(400);
    expect((await svc.store.items.get(item.id))?.status).toBe("listed"); // the unconfirmed delete did nothing
  });

  it("only test items; signed out is refused", async () => {
    const { env, svc, item } = await setup("REAL-1");
    const l = await link(svc, item.id);
    expect(await queueTestAction(svc, item.id, l.id, "count", "")).toMatchObject({ status: 403 });
    expect((await queueTestAction(env.client(), item.id, l.id, "count", "")).status).toBe(401);
    expect((await linkListing(env.client(), item.id, { marketplace: "poshmark", ref: ID })).status).toBe(401);
  });

  it("every test action is handed to a paired, signed-in extension on its next poll (regression: jobs stuck in queued)", async () => {
    const { env, svc, item } = await setup();
    const l = await link(svc, item.id);
    const code = (await pairStart(svc)).body.code;
    const token = String((await extPairComplete(env.client(), { code, extensionVersion: "1.0.1" }, "1.1.1.1")).body.token);
    resetUpkeep();
    const poll = () => extPoll(env.client(), token, { extensionVersion: "1.0.1", marketplaces: { poshmark: true }, ready: ["poshmark"], limit: 1 }, "1.1.1.1");
    for (const [a, v, action] of [["quantity", "2", "updateQuantity"], ["price", "25", "updateListing"], ["title", "Black jeans", "updateListing"], ["count", "", "getListings"], ["not_for_sale", "", "delist"]] as const) {
      const q = await queueTestAction(svc, item.id, l.id, a, v);
      expect(q.status, `${a}: ${JSON.stringify(q.body)}`).toBe(201);
      const r = await poll();
      expect(r.status).toBe(200);
      const jobs = r.body.jobs as { jobId: string; action: string }[];
      expect(jobs.map((j) => j.action), a).toEqual([action]);
      const id = jobs[0].jobId;
      expect((await svc.store.jobs.get(id))?.status).toBe("claimed");
      // Finish it the way the extension does, so the next one is not blocked by "one job at a time per marketplace".
      expect((await extJob(env.client(), "start", token, id, {}, "1.1.1.1")).status).toBe(200);
      expect((await extJob(env.client(), "result", token, id, { ok: true, result: { note: "Saved" } }, "1.1.1.1")).status).toBe(200);
      expect((await svc.store.jobs.get(id))?.status).toBe("succeeded");
    }
  });

  it("regression: a run that died (lease expired, never reported) no longer blocks the marketplace; the next poll requeues and hands it out", async () => {
    resetUpkeep();
    const { env, svc, item } = await setup();
    const l = await link(svc, item.id);
    const code = (await pairStart(svc)).body.code;
    const paired = (await extPairComplete(env.client(), { code, extensionVersion: "1.0.1" }, "1.1.1.1")).body;
    const token = String(paired.token);
    const hourAgo = new Date(Date.now() - 3600_000);
    const { job: dead } = await svc.store.jobs.enqueue({ marketplace: "poshmark", jobType: "sync_status", executor: "extension", itemId: item.id, listingId: l.id,
      idempotencyKey: `dead:${Date.now()}`, nextRunAt: new Date(hourAgo.getTime() - 60_000).toISOString() });
    const claimed = await svc.store.jobs.claim({ executor: "extension", deviceId: String(paired.deviceId), limit: 1, now: hourAgo });
    expect(claimed.map((j) => j.id)).toEqual([dead.id]); // claimed an hour ago: its 10-minute lease is long gone
    expect((await queueTestAction(svc, item.id, l.id, "quantity", "2")).status).toBe(201);
    const r = await extPoll(env.client(), token, { extensionVersion: "1.0.1", marketplaces: { poshmark: true }, ready: ["poshmark"], limit: 1 }, "1.1.1.1");
    expect((r.body.jobs as { jobId: string }[]).length).toBe(1);
    const events = await svc.store.jobs.events([dead.id]);
    expect(events.some((e) => e.toStatus === "queued" && /lease expired/i.test(e.message ?? ""))).toBe(true);
  });

  it("record test sale & delete: a confirmed sale, item Sold, mark_sold reaches the extension in DELETE mode; later edits are relist-blocked", async () => {
    const { env, svc, item } = await setup();
    const l = await link(svc, item.id);
    const r = await queueTestAction(svc, item.id, l.id, "sold_delete", "DELETE");
    expect(r.status).toBe(201);
    expect((await svc.store.items.get(item.id))?.status).toBe("sold");
    const sales = (await svc.store.sales.list()).filter((s) => s.itemId === item.id);
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ marketplace: "other", source: "manual" });
    const code = (await pairStart(svc)).body.code;
    const token = String((await extPairComplete(env.client(), { code, extensionVersion: "1.0.0" }, "1.1.1.1")).body.token);
    const p = await extPoll(env.client(), token, { extensionVersion: "1.0.0", marketplaces: { poshmark: true }, ready: ["poshmark"] }, "1.1.1.1");
    const jobs = p.body.jobs as { action: string; payload: Record<string, unknown> }[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ action: "markSold", payload: { externalId: ID, url: URL1, mode: "delete", saleId: sales[0].id } });
    expect(await queueTestAction(svc, item.id, l.id, "price", "10")).toMatchObject({ status: 409, body: { code: "relist_blocked" } });
    expect(await svc.store.items.get(item.id)).toBeTruthy(); // nothing in Shadow Sync is deleted
  });
});
