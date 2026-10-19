// Sold-item rules (David, 2026-10-19), shared by both stores, the SQL mirror (0006) and the extension:
// 1) After a CONFIRMED sale (stored and matched to the item), delisting elsewhere means DELETE on the marketplace (per-marketplace setting,
//    default "delete"), falling back to Not For Sale if delete fails or is blocked. Never on unmatched/ambiguous sales.
// 2) Nothing is ever deleted in Shadow Sync: the item, its photos, sale, listing row (kept as "ended" with its old id/URL) and log stay.
// 3) Relist guard: a Sold item can't be listed, edited or restocked anywhere until you undo the sale.
// 4) "Sold" vs "Sold but still active": an item is only fully Sold once every other marketplace is delisted/deleted.
import type { Item, Job, JobType, Listing, Marketplace, NeedsActionEntry, SoldAction } from "../data/types";
import { isOpen } from "./state-machine";

export const DEFAULT_SOLD_ACTION: SoldAction = "delete";

/** True when this job would put a Sold item back on sale (or change it): create, edit, or a quantity above 0. */
export function isRelist(jobType: JobType, payload: Record<string, unknown> | null | undefined): boolean {
  if (jobType === "create_listing") return true;
  if (jobType !== "update_listing") return false;
  const p = payload ?? {};
  const onlyQuantity = p.quantity !== undefined && p.title === undefined && p.price === undefined && p.description === undefined;
  return !(onlyQuantity && Number(p.quantity) === 0); // quantity 0 is a delist, always allowed
}
export const relistBlocked = (jobType: JobType, payload: Record<string, unknown> | null | undefined, itemStatus: Item["status"] | null | undefined) =>
  itemStatus === "sold" && isRelist(jobType, payload);

/** How the extension ends a listing: delete only when the setting says so AND the sale is confirmed. */
export const endMode = (soldAction: SoldAction, saleConfirmed: boolean): "delete" | "not_for_sale" =>
  soldAction === "delete" && saleConfirmed ? "delete" : "not_for_sale";

export interface SoldView { state: "sold" | "sold_still_active"; marketplaces: Marketplace[] }
const DELIST = new Set<JobType>(["delist", "mark_sold"]);
const STILL_ACTIVE_KINDS = new Set<NeedsActionEntry["kind"]>(["delist_failed", "delist_stuck", "sold_still_listed"]);

/**
 * Sold items -> "sold" (delisted or deleted everywhere) or "sold_still_active" with the marketplaces still to clear: a listing still
 * active, a delist pending/failed/needing you, a delete that fell back to Not For Sale, or the item seen live again (needs-action entries).
 * Moves to "sold" by itself once those are cleared. Pure.
 */
export function classifySold(items: Item[], listings: Listing[], jobs: Job[], needs: NeedsActionEntry[]): Map<string, SoldView> {
  const out = new Map<string, SoldView>();
  for (const it of items) {
    if (it.status !== "sold") continue;
    const mps = new Set<Marketplace>();
    for (const l of listings) if (l.itemId === it.id && l.status === "active") mps.add(l.marketplace);
    for (const j of jobs) if (j.itemId === it.id && DELIST.has(j.jobType) && isOpen(j.status)) mps.add(j.marketplace);
    for (const n of needs) if (n.itemId === it.id && STILL_ACTIVE_KINDS.has(n.kind) && n.marketplace) mps.add(n.marketplace);
    out.set(it.id, { state: mps.size ? "sold_still_active" : "sold", marketplaces: [...mps].sort() });
  }
  return out;
}

/** Loads what classifySold needs. If the job tables are missing (0005 not applied) every sold item counts as plain "sold". */
export async function loadSoldViews(store: import("../data/interfaces").DataStore): Promise<Map<string, SoldView>> {
  const items = await store.items.list({ status: "sold" });
  try {
    const [listings, jobs, needs] = await Promise.all([store.listings.list(), store.jobs.list(), store.needsAction.list()]);
    return classifySold(items, listings, jobs, needs);
  } catch (e) {
    if (e instanceof Error && e.name === "SchemaMissingError") return classifySold(items, [], [], []);
    throw e;
  }
}
