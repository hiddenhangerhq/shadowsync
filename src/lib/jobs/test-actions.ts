// Item page helpers (release-checklist section 4 smoke test, David 2026-10-19):
// - "Link existing listing": attach a listing you already have on a marketplace (URL or id) to an item.
// - "Test actions": one button per extension action, ONLY for test items (SKU starting with "TEST"). Every button goes through the normal
//   job API (createJob: validation, dedupe, relist guard, executor), so nothing here can do more than a normal job.
import type { Services } from "../data/interfaces";
import type { Item, Listing, Marketplace } from "../data/types";
import { HOST_TABLE, isExtMarketplace } from "../ext/protocol";
import { createJob, type ApiResult } from "./api";
import { delistKey } from "./state-machine";

/** Marketplaces you can link a listing on (the database's marketplace list). */
export const LINKABLE_MARKETPLACES: Marketplace[] = ["poshmark", "ebay", "depop", "grailed", "mercari", "etsy", "whatnot", "shopify", "wix", "other"];
const OTHER_HOSTS: Partial<Record<Marketplace, string[]>> = {
  ebay: ["www.ebay.com", "ebay.com"], etsy: ["www.etsy.com", "etsy.com"], whatnot: ["www.whatnot.com", "whatnot.com"],
};

/** A test item: its SKU starts with "TEST" (e.g. TEST-1). Only those show the Test actions panel. */
export const isTestItem = (item: Pick<Item, "sku">) => /^test\b/i.test((item.sku ?? "").trim());

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** "https://poshmark.com/listing/jeans-black-6ad5…" or just "6ad5…" -> { externalId, url }. Only that marketplace's own site is accepted. */
export function parseListingRef(marketplace: Marketplace, raw: string): Parsed<{ externalId: string; url: string | null }> {
  const v = raw.trim();
  if (!v) return { ok: false, error: "Paste the listing's link or id" };
  if (v.length > 500) return { ok: false, error: "That link is too long" };
  const ext = isExtMarketplace(marketplace) ? HOST_TABLE[marketplace] : null;
  if (!/^https?:\/\//i.test(v)) {
    if (ext && !ext.listingId.test(v)) return { ok: false, error: `That doesn't look like a ${ext.label} listing id` };
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(v)) return { ok: false, error: "A listing id has only letters, numbers, - and _" };
    return { ok: true, value: { externalId: v, url: ext && marketplace === "poshmark" ? `https://poshmark.com/listing/${v}` : null } };
  }
  let u: URL;
  try { u = new URL(v); } catch { return { ok: false, error: "That link is not valid" }; }
  if (u.protocol !== "https:") return { ok: false, error: "The link must start with https://" };
  const hosts = ext?.hosts ?? OTHER_HOSTS[marketplace];
  if (hosts && !hosts.includes(u.hostname)) return { ok: false, error: `That link is not on ${ext?.label ?? marketplace} (${hosts[0]})` };
  const segs = u.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  if (marketplace === "poshmark") id = /([a-f0-9]{24})$/i.exec(segs[segs.length - 1] ?? "")?.[1];
  else id = [...segs].reverse().find((s) => (ext ? ext.listingId.test(s) : /^[A-Za-z0-9_-]{1,80}$/.test(s)));
  if (!id || (marketplace === "poshmark" && segs[0] !== "listing")) return { ok: false, error: `Couldn't find the listing id in that link. Open the listing and copy the address bar.` };
  return { ok: true, value: { externalId: id, url: `${u.origin}${u.pathname}` } };
}

const fail = (status: number, error: string): ApiResult => ({ status, body: { error } });

export async function linkListing(svc: Services, itemId: string, input: { marketplace: string; ref: string; price?: number | null }): Promise<ApiResult> {
  if (!(await svc.auth.getUser())) return fail(401, "Not signed in");
  const item = await svc.store.items.get(itemId);
  if (!item) return fail(404, "Item not found");
  const m = input.marketplace as Marketplace;
  if (!LINKABLE_MARKETPLACES.includes(m)) return fail(400, "Pick a marketplace");
  // Relist guard: a Sold item gets no new listing (undo the sale first).
  if (item.status === "sold") return fail(409, "This item is Sold, so it can't get a new listing. Undo the sale first.");
  const p = parseListingRef(m, input.ref);
  if (!p.ok) return fail(400, p.error);
  const listings = await svc.store.listings.list();
  const taken = listings.find((l) => l.marketplace === m && l.externalId === p.value.externalId && l.itemId !== itemId);
  if (taken) return fail(409, "That listing is already linked to another item");
  const listing = await svc.store.listings.upsert({
    itemId, marketplace: m, externalId: p.value.externalId, url: p.value.url, price: input.price ?? item.askingPrice ?? null,
    status: "active", listedAt: null, endedAt: null, source: "manual",
  });
  if (item.status === "draft" || item.status === "delisted") await svc.store.items.update(itemId, { status: "listed" });
  await svc.store.itemSyncLog.append({ event: "linked", source: "manual", itemId, listingId: listing.id, marketplace: m, detail: `Linked existing listing ${p.value.externalId}` }).catch(() => undefined);
  return { status: 200, body: { listing } };
}

export const TEST_ACTIONS = ["quantity", "price", "title", "count", "not_for_sale", "for_sale", "sold_delete"] as const;
export type TestAction = (typeof TEST_ACTIONS)[number];

/** One test button -> one normal job (createJob). sold_delete first records a test sale (marketplace "other"), so the delete is a CONFIRMED sale. */
export async function queueTestAction(svc: Services, itemId: string, listingId: string, action: string, value: string, now = new Date()): Promise<ApiResult> {
  if (!(await svc.auth.getUser())) return fail(401, "Not signed in");
  const item = await svc.store.items.get(itemId);
  if (!item) return fail(404, "Item not found");
  if (!isTestItem(item)) return fail(403, "Test actions are only for test items (SKU starting with TEST)");
  const listing: Listing | undefined = (await svc.store.listings.list()).find((l) => l.id === listingId && l.itemId === itemId);
  if (!listing) return fail(404, "Listing not found");
  if (!TEST_ACTIONS.includes(action as TestAction)) return fail(400, "Unknown test action");
  const key = (k: string) => `test:${k}:${listing.id}:${now.getTime()}`;
  // Old value for the "old -> new" label: the last successful change of that field, else what we stored for the listing / item.
  const done = (await svc.store.jobs.list({ itemId })).filter((j) => j.listingId === listing.id && j.jobType === "update_listing" && j.status === "succeeded")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const last = (f: "price" | "title" | "quantity") => done.find((j) => j.payload[f] !== undefined && j.payload[f] !== null)?.payload[f];
  const base = { marketplace: listing.marketplace, itemId, listingId: listing.id };
  // sku rides on the job payload only so the extension can gate unconfirmed request writes; buildActionRequest lifts it to itemSku.
  const withSku = (payload: Record<string, unknown>) => ({ ...payload, ...(item.sku ? { sku: item.sku } : {}) });
  const v = value.trim();
  switch (action as TestAction) {
    case "quantity": {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 999) return fail(400, "Quantity must be a whole number from 0 to 999");
      return createJob(svc, { ...base, jobType: "update_listing", payload: withSku({ quantity: n, ...(last("quantity") !== undefined ? { previous: { quantity: last("quantity") } } : {}) }), idempotencyKey: key(`quantity:${n}`) });
    }
    case "price": {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1 || n > 100000) return fail(400, "Price must be a number of dollars");
      return createJob(svc, { ...base, jobType: "update_listing", payload: withSku({ price: Math.round(n), previous: { price: last("price") ?? listing.price ?? item.askingPrice ?? null } }), idempotencyKey: key(`price:${n}`) });
    }
    case "title": {
      if (!v || v.length > 80) return fail(400, "Title must be 1 to 80 characters");
      return createJob(svc, { ...base, jobType: "update_listing", payload: withSku({ title: v, previous: { title: last("title") ?? item.title } }), idempotencyKey: key("title") });
    }
    case "count": return createJob(svc, { ...base, jobType: "sync_status", idempotencyKey: key("count") });
    case "not_for_sale": return createJob(svc, { ...base, jobType: "delist", payload: withSku({}), idempotencyKey: key("nfs") });
    case "for_sale": return createJob(svc, { ...base, jobType: "update_listing", payload: withSku({ availability: "for_sale" }), idempotencyKey: key("for_sale") });
    case "sold_delete": {
      if (v !== "DELETE") return fail(400, 'Type DELETE in the box to confirm');
      const sale = await svc.store.sales.record({
        itemId, marketplace: "other", orderId: `TEST-${now.getTime()}`, soldAt: now.toISOString().slice(0, 10), price: listing.price ?? item.askingPrice ?? 1,
        fees: null, promo: null, shipProvider: null, shipCost: null, source: "manual",
      });
      await svc.store.items.update(itemId, { status: "sold", dateSold: item.dateSold ?? sale.soldAt, priceSold: item.priceSold ?? sale.price, platform: item.platform ?? "other" });
      await svc.store.itemSyncLog.append({ event: "sale_detected", source: "manual", itemId, marketplace: "other", ref: `sale:${sale.id}`, detail: `Test sale ${sale.orderId} recorded by you` }).catch(() => undefined);
      const jobType = listing.marketplace === "poshmark" || listing.marketplace === "depop" || listing.marketplace === "grailed" || listing.marketplace === "mercari" ? "mark_sold" : "delist";
      return createJob(svc, { ...base, jobType, payload: withSku({ saleId: sale.id, soldOn: "other" }), idempotencyKey: delistKey(jobType, listing.id, sale.id) });
    }
  }
}
