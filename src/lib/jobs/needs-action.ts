// "Sold but still active" (spec 6A): a pure function over data, so the list empties itself once a delist is confirmed.
import { isOpen } from "./state-machine";
import type { Item, ItemSyncLogEntry, Job, Listing, NeedsActionEntry, Sale } from "../data/types";

/** A fresh delist is "in progress", not a problem. After this long without success it is flagged (spec 6A). */
export const GRACE_MS = 15 * 60_000;
const SEVERITY: Record<NeedsActionEntry["kind"], number> = { delist_failed: 0, delist_stuck: 1, sold_still_listed: 2, unmatched_sale: 3, sale_cancelled: 4 };
const DELIST_TYPES = new Set(["delist", "mark_sold"]);

export interface NeedsActionInput {
  items: Item[];
  listings: Listing[];
  sales: Sale[];
  jobs: Job[];
  /** itemSyncLog entries (at least the needs_action_ignored and sale_cancelled ones). */
  syncLog: ItemSyncLogEntry[];
  now: Date;
}

export const listingKey = (listingId: string) => `listing:${listingId}`;
export const unmatchedSaleKey = (saleId: string) => `unmatched_sale:${saleId}`;
export const cancelledSaleKey = (marketplace: string, orderId: string) => `sale_cancelled:${marketplace}:${orderId}`;
export const deleteFallbackKey = (listingId: string) => `delete_fallback:${listingId}`;
export const soldLiveKey = (listingId: string, day: string) => `sold_live:${listingId}:${day}`;
export const soldAgainKey = (saleId: string) => `sold_again:${saleId}`;
/** Log events makeNeedsAction must load for these rules. */
export const NEEDS_ACTION_EVENTS = ["needs_action_ignored", "sale_cancelled", "sale_unmatched", "delete_fallback", "sold_seen_live", "deleted", "delisted"] as const;

export function computeNeedsAction({ items, listings, sales, jobs, syncLog, now }: NeedsActionInput): NeedsActionEntry[] {
  const ignored = new Set(syncLog.filter((e) => e.event === "needs_action_ignored" && e.ref).map((e) => e.ref!));
  const itemById = new Map(items.map((i) => [i.id, i]));
  const t = now.getTime();
  const out: NeedsActionEntry[] = [];
  const push = (e: Omit<NeedsActionEntry, "overdueMs">) => {
    if (!ignored.has(e.key)) out.push({ ...e, overdueMs: Math.max(0, t - new Date(e.since).getTime()) });
  };

  // 1) Sold on one marketplace, still live on another.
  for (const l of listings) {
    if (l.status !== "active") continue;
    const soldElsewhere = sales.filter((s) => s.itemId === l.itemId && s.marketplace !== l.marketplace)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!soldElsewhere.length) continue;
    const item = itemById.get(l.itemId);
    const latest = jobs.filter((j) => j.listingId === l.id && DELIST_TYPES.has(j.jobType)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const base = { key: listingKey(l.id), itemId: l.itemId, sku: item?.sku ?? null, title: item?.title ?? null, marketplace: l.marketplace, listingId: l.id, url: l.url };
    const saleAt = soldElsewhere[0].createdAt;
    if (latest?.status === "failed") {
      push({ ...base, kind: "delist_failed", jobId: latest.id, since: latest.finishedAt ?? latest.createdAt,
        message: `Delist on ${l.marketplace} failed: ${latest.lastError ?? "unknown error"}`, actions: ["retry", "open_listing", "mark_delisted", "ignore"] });
    } else if (latest && isOpen(latest.status)) {
      if (latest.status === "needs_user") {
        push({ ...base, kind: "delist_stuck", jobId: latest.id, since: latest.createdAt,
          message: `Delist on ${l.marketplace} needs you: ${latest.lastError ?? "action required"}`, actions: ["retry", "open_listing", "mark_delisted", "ignore"] });
      } else if (t - new Date(latest.createdAt).getTime() > GRACE_MS) {
        push({ ...base, kind: "delist_stuck", jobId: latest.id, since: latest.createdAt,
          message: `Delist on ${l.marketplace} is still ${latest.status.replace("_", " ")} (risk of overselling)`, actions: ["open_listing", "mark_delisted", "ignore"] });
      }
    } else if (t - new Date(saleAt).getTime() > GRACE_MS) {
      // no job, or a finished/canceled one, yet the listing is still live (or unconfirmed)
      push({ ...base, kind: "sold_still_listed", jobId: latest?.id ?? null, since: saleAt,
        message: `Sold on ${soldElsewhere[0].marketplace}, still listed on ${l.marketplace}`, actions: ["open_listing", "mark_delisted", "ignore"] });
    }
  }

  // 2) A live-detected sale that matched no item. Driven by the log entry the scan writes (never by history imports or legacy sheet/email rows),
  //    and it disappears if the sale later gets an item.
  const saleById = new Map(sales.map((s) => [s.id, s]));
  for (const e of syncLog) {
    if (e.event !== "sale_unmatched" || !e.ref) continue;
    const s = saleById.get(e.ref.slice("unmatched_sale:".length));
    if (s?.itemId) continue;
    push({ key: e.ref, kind: "unmatched_sale", itemId: null, sku: s?.sku ?? null, title: s?.title ?? null, marketplace: e.marketplace, listingId: null, jobId: null,
      url: null, since: e.at, message: e.detail ?? "A sale did not match any of your items", actions: ["ignore"] });
  }

  // 3) A sale that was cancelled.
  for (const e of syncLog) {
    if (e.event !== "sale_cancelled" || !e.ref) continue;
    const item = e.itemId ? itemById.get(e.itemId) : undefined;
    push({ key: e.ref, kind: "sale_cancelled", itemId: e.itemId, sku: item?.sku ?? null, title: item?.title ?? null, marketplace: e.marketplace, listingId: e.listingId,
      jobId: null, url: null, since: e.at, message: e.detail ?? "A sale was cancelled. Check whether to relist.", actions: ["ignore"] });
  }

  // 4) Delete failed or was blocked (set to Not For Sale instead), or a Sold item was seen live / selling again.
  //    Cleared by a later "deleted" or "delisted" (e.g. Mark delisted after you delete it by hand) for that listing, or by Ignore.
  const clearedAt = new Map<string, string>();
  for (const e of syncLog) {
    if ((e.event === "deleted" || e.event === "delisted") && e.listingId && (clearedAt.get(e.listingId) ?? "") < e.at) clearedAt.set(e.listingId, e.at);
  }
  const listingById = new Map(listings.map((l) => [l.id, l]));
  const seen = new Set<string>();
  for (const e of syncLog) {
    if ((e.event !== "delete_fallback" && e.event !== "sold_seen_live") || !e.ref || seen.has(e.ref)) continue;
    seen.add(e.ref);
    if (e.listingId && (clearedAt.get(e.listingId) ?? "") > e.at) continue;
    const item = e.itemId ? itemById.get(e.itemId) : undefined;
    const l = e.listingId ? listingById.get(e.listingId) : undefined;
    push({ key: e.ref, kind: "sold_still_listed", itemId: e.itemId, sku: item?.sku ?? null, title: item?.title ?? null, marketplace: e.marketplace, listingId: e.listingId,
      jobId: e.jobId, url: l?.url ?? null, since: e.at,
      message: e.detail ?? (e.event === "delete_fallback" ? "Could not delete; set to Not For Sale instead" : "Sold item seen live again"),
      actions: e.listingId ? ["open_listing", "mark_delisted", "ignore"] : ["ignore"] });
  }

  return out.sort((a, b) => SEVERITY[a.kind] - SEVERITY[b.kind] || a.since.localeCompare(b.since));
}
