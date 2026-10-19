// Sale detection (spec 3A + 6A). A scan report goes in, and out come stored sales, delist / mark_sold jobs for the item's OTHER
// live listings, needs-action entries for sales we could not match, and a cursor that moves only after everything is stored.
// No marketplace calls happen here: the API worker or the extension (later steps) produce the report.
import type { DataStore } from "../data/interfaces";
import type { ConnectionType, Item, Job, JobExecutor, JobType, Listing, Marketplace, MarketplaceConnection, NewJob, Sale, Source } from "../data/types";
import { delistKey } from "./state-machine";
import { asNewListing } from "./store-helpers";
import { cancelledSaleKey, soldAgainKey, soldLiveKey, unmatchedSaleKey } from "./needs-action";

export interface DetectedSale {
  orderId: string;
  soldAt: string;                       // YYYY-MM-DD
  price: number;
  fees?: number | null;
  promo?: number | null;
  shipProvider?: string | null;
  shipCost?: number | null;
  sku?: string | null;
  title?: string | null;
  shipBy?: string | null;
  /** The marketplace's own listing id, the most reliable way to find our item. */
  externalListingId?: string | null;
  /** The sale was cancelled / refunded on the marketplace. It is never delisted automatically, it goes to needs-action. */
  cancelled?: boolean;
}
export interface ScanReport {
  marketplace: Marketplace;
  /** Connection id for API marketplaces, "device:<id>" for the extension. Default "default". */
  scopeKey?: string;
  source: Extract<Source, "api" | "extension">;
  sales: DetectedSale[];
  /** Where the next scan continues. null = leave the cursor where it is. */
  nextCursor: string | null;
  /** Importing old history: sales are stored but NOTHING is delisted, logged or marked sold (spec 3A "first connect"). */
  history?: boolean;
}
export interface ScanResult {
  ok: boolean;
  stored: number;        // new sales
  duplicates: number;    // already known (replay / overlap window / other source)
  jobsCreated: number;
  unmatched: number;
  cancelled: number;
  cursorAdvanced: boolean;
  error?: string;
}

/** Marketplaces where "mark as sold" is the normal way to close a listing. Everything else gets a plain delist. Placeholder until each marketplace is built. */
export const MARK_SOLD_MARKETPLACES: readonly Marketplace[] = ["poshmark", "depop", "grailed", "mercari"];
export const jobTypeFor = (m: Marketplace): Extract<JobType, "delist" | "mark_sold"> => (MARK_SOLD_MARKETPLACES.includes(m) ? "mark_sold" : "delist");

/** Official-API marketplaces by default (spec section 7); everything else goes to the extension. A saved connection overrides it, API first. */
const API_MARKETPLACES: readonly Marketplace[] = ["ebay", "etsy", "shopify", "wix"];
export function executorFor(m: Marketplace, connections: Pick<MarketplaceConnection, "marketplace" | "connectionType" | "status">[]): JobExecutor {
  const usable = connections.filter((c) => c.marketplace === m && c.status !== "disconnected");
  const has = (t: ConnectionType) => usable.some((c) => c.connectionType === t);
  if (has("oauth_api")) return "api";
  if (has("extension")) return "extension";
  return API_MARKETPLACES.includes(m) ? "api" : "extension";
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Match a detected sale to our item: marketplace listing id first, then SKU. */
export function matchItem(sale: Pick<DetectedSale, "sku" | "externalListingId">, marketplace: Marketplace, items: Item[], listings: Listing[]): Item | null {
  if (sale.externalListingId) {
    const l = listings.find((x) => x.marketplace === marketplace && x.externalId === sale.externalListingId);
    const it = l && items.find((i) => i.id === l.itemId);
    if (it) return it;
  }
  if (norm(sale.sku)) return items.find((i) => norm(i.sku) === norm(sale.sku)) ?? null;
  return null;
}

/** The jobs a sale should create: one per OTHER live listing of the same item. Pure. */
export function planDelistJobs(
  sale: Pick<Sale, "id" | "marketplace">, item: Pick<Item, "id">, listings: Listing[], connections: MarketplaceConnection[],
): NewJob[] {
  return listings
    .filter((l) => l.itemId === item.id && l.status === "active" && l.marketplace !== sale.marketplace)
    .map((l) => {
      const jobType = jobTypeFor(l.marketplace);
      return {
        marketplace: l.marketplace, jobType, executor: executorFor(l.marketplace, connections), itemId: item.id, listingId: l.id,
        idempotencyKey: delistKey(jobType, l.id, sale.id),
        payload: { saleId: sale.id, soldOn: sale.marketplace, externalId: l.externalId, url: l.url },
      };
    });
}

/** First connect: start the cursor at `startAt` (default now) so old sales are never replayed as new ones. No-op if a cursor exists. */
export async function initCursor(store: DataStore, marketplace: Marketplace, scopeKey = "default", startAt: string = new Date().toISOString()) {
  const cur = await store.cursors.get(marketplace, scopeKey);
  return cur ?? store.cursors.advance({ marketplace, scopeKey, cursor: startAt });
}

export async function processScanReport(store: DataStore, report: ScanReport, now = new Date()): Promise<ScanResult> {
  const scopeKey = report.scopeKey ?? "default";
  const res: ScanResult = { ok: true, stored: 0, duplicates: 0, jobsCreated: 0, unmatched: 0, cancelled: 0, cursorAdvanced: false };
  try {
    const [items, listings, sales, jobs, connections, cancelledLog, prior] = await Promise.all([
      store.items.list(), store.listings.list(), store.sales.list(), store.jobs.list(), store.connections.list(),
      store.itemSyncLog.list({ event: "sale_cancelled" }), store.cursors.get(report.marketplace, scopeKey),
    ]);
    const known = new Map(sales.filter((s) => s.orderId).map((s) => [`${s.marketplace}:${s.orderId}`, s]));
    const loggedCancels = new Set(cancelledLog.map((e) => e.ref));
    const itemById = new Map(items.map((i) => [i.id, i]));
    const allJobs: Job[] = [...jobs];

    // Oldest first, so a crash half-way leaves a clean prefix stored and the cursor still behind it.
    const ordered = [...report.sales].sort((a, b) => a.soldAt.localeCompare(b.soldAt) || a.orderId.localeCompare(b.orderId));
    for (const s of ordered) {
      const key = `${report.marketplace}:${s.orderId}`;
      const before = known.get(key);

      if (s.cancelled) {
        const ref = cancelledSaleKey(report.marketplace, s.orderId);
        if (!report.history && !loggedCancels.has(ref)) {
          await store.itemSyncLog.append({
            event: "sale_cancelled", source: report.source, itemId: before?.itemId ?? null, marketplace: report.marketplace, ref,
            detail: `Order ${s.orderId} on ${report.marketplace} was cancelled${before ? "" : " (we had not recorded it)"}. Check whether the item should be relisted.`,
          });
          loggedCancels.add(ref);
          res.cancelled++;
        }
        continue;
      }

      const item = matchItem(s, report.marketplace, items, listings);
      const rec = await store.sales.record({
        itemId: item?.id ?? before?.itemId ?? null, marketplace: report.marketplace, orderId: s.orderId, soldAt: s.soldAt, price: s.price,
        fees: s.fees ?? null, promo: s.promo ?? null, shipProvider: s.shipProvider ?? null, shipCost: s.shipCost ?? null,
        sku: s.sku ?? null, title: s.title ?? null, shipBy: s.shipBy ?? null, source: report.source,
      });
      known.set(key, rec);
      if (before) res.duplicates++; else res.stored++;
      if (report.history) continue; // history import: stored only

      const owner = rec.itemId ? itemById.get(rec.itemId) : undefined;
      if (!owner) {
        if (!before) {
          res.unmatched++;
          await store.itemSyncLog.append({ event: "sale_unmatched", source: report.source, marketplace: report.marketplace, ref: unmatchedSaleKey(rec.id),
            detail: `Sale on ${report.marketplace} (order ${s.orderId}) matched no item` });
        }
        continue;
      }

      if (!before) {
        await store.itemSyncLog.append({ event: "sale_detected", source: report.source, itemId: owner.id, marketplace: report.marketplace, ref: `sale:${rec.id}`,
          detail: `Order ${s.orderId} sold for ${s.price}` });
      }
      // Sold in Shadow Sync already and a NEW order arrives for it from another sale: it was live again somewhere. Flag it (never relist/undo).
      if (owner.status === "sold" && !before && [...known.values()].some((x) => x.itemId === owner.id && x.id !== rec.id)) {
        await store.itemSyncLog.append({ event: "sold_seen_live", source: report.source, itemId: owner.id, marketplace: report.marketplace, ref: soldAgainKey(rec.id),
          detail: `Sold again on ${report.marketplace} (order ${s.orderId}) although it was already Sold. Check for a double sale.` });
      }
      // Idempotent on every pass (a replay repairs a crash between "sale stored" and "item updated").
      if (owner.status !== "sold") {
        const upd = await store.items.update(owner.id, { status: "sold", dateSold: owner.dateSold ?? s.soldAt, priceSold: owner.priceSold ?? s.price, platform: owner.platform ?? report.marketplace });
        itemById.set(owner.id, upd);
      }
      const own = listings.find((l) => l.itemId === owner.id && l.marketplace === report.marketplace && l.status === "active");
      if (own) {
        const upd = await store.listings.upsert({ ...asNewListing(own), status: "sold", endedAt: now.toISOString() });
        listings.splice(listings.indexOf(own), 1, upd);
      }
      for (const plan of planDelistJobs(rec, owner, listings, connections)) {
        // Any job ever created for this (listing, sale) means it is handled: even a finished, failed or canceled one. A replay must never re-open it.
        if (allJobs.some((j) => j.idempotencyKey === plan.idempotencyKey)) continue;
        const { job, created } = await store.jobs.enqueue(plan);
        allJobs.push(job);
        if (!created) continue;
        res.jobsCreated++;
        await store.itemSyncLog.append({ event: "delist_queued", source: report.source, itemId: owner.id, listingId: plan.listingId ?? null, marketplace: plan.marketplace,
          jobId: job.id, detail: `${job.jobType} queued because it sold on ${report.marketplace}` });
      }
    }

    // Only now, with every sale stored, does the cursor move.
    await store.cursors.advance({ marketplace: report.marketplace, scopeKey, cursor: report.nextCursor ?? prior?.cursor ?? null, now });
    res.cursorAdvanced = true;
    return res;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Keep the cursor where it was: the next scan re-reads this page, and dedupe makes that harmless.
    await store.cursors.fail({ marketplace: report.marketplace, scopeKey, error, now }).catch(() => undefined);
    return { ...res, ok: false, cursorAdvanced: false, error };
  }
}

/**
 * Listing scan (extension getListings today; weekly reconcile later): the marketplace listing ids seen LIVE. Any that belong to an item Sold in
 * Shadow Sync are flagged once per listing per day into "Sold but still active". Nothing is changed on the marketplace or the item.
 */
export async function processListingsReport(store: DataStore, input: { marketplace: Marketplace; externalIds: string[]; source: "api" | "extension" | "reconcile" }, now = new Date()) {
  const ids = new Set(input.externalIds);
  const [items, listings, prior] = await Promise.all([store.items.list({ status: "sold" }), store.listings.list(), store.itemSyncLog.list({ event: "sold_seen_live" })]);
  const sold = new Map(items.map((i) => [i.id, i]));
  const day = now.toISOString().slice(0, 10);
  const have = new Set(prior.map((e) => e.ref));
  let flagged = 0;
  for (const l of listings) {
    if (l.marketplace !== input.marketplace || !l.externalId || !ids.has(l.externalId) || !sold.has(l.itemId)) continue;
    const ref = soldLiveKey(l.id, day);
    if (have.has(ref)) continue;
    await store.itemSyncLog.append({ event: "sold_seen_live", source: input.source, itemId: l.itemId, listingId: l.id, marketplace: l.marketplace, ref,
      detail: `Sold in Shadow Sync but still live on ${l.marketplace}. Delete or end it there, then press Mark delisted.` });
    have.add(ref);
    flagged++;
  }
  return { seen: ids.size, flagged };
}
