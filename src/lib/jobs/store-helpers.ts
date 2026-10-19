// Behaviour shared by every DataStore implementation, written once against the interface (so the mock and Supabase cannot drift).
import type { DataStore } from "../data/interfaces";
import type { Job, JobOutcome, Listing, NewListing } from "../data/types";
import { isOpen } from "./state-machine";
import { computeNeedsAction, deleteFallbackKey, NEEDS_ACTION_EVENTS } from "./needs-action";

export function makeNeedsAction(getStore: () => DataStore): DataStore["needsAction"] {
  return {
    async list(now = new Date()) {
      const s = getStore();
      // The log event kinds the rules read, fetched separately so a long history of other events can never push an "ignore" out of range.
      const [items, listings, sales, jobs, ...logs] = await Promise.all([
        s.items.list(), s.listings.list(), s.sales.list(), s.jobs.list(),
        ...NEEDS_ACTION_EVENTS.map((event) => s.itemSyncLog.list({ event })),
      ]);
      return computeNeedsAction({ items, listings, sales, jobs, syncLog: logs.flat(), now });
    },
    async ignore(key, note) {
      await getStore().itemSyncLog.append({ event: "needs_action_ignored", source: "manual", ref: key, detail: note ?? "Ignored by you" });
    },
    async markDelisted(listingId) {
      const s = getStore();
      const l = (await s.listings.list()).find((x) => x.id === listingId);
      if (!l) throw new Error("Listing not found");
      await s.listings.upsert({ ...asNewListing(l), status: "ended", endedAt: new Date().toISOString() });
      for (const j of await s.jobs.list({ listingId })) {
        if ((j.jobType === "delist" || j.jobType === "mark_sold") && isOpen(j.status)) await s.jobs.cancel(j.id);
      }
      await s.itemSyncLog.append({ event: "delisted", source: "manual", itemId: l.itemId, listingId: l.id, marketplace: l.marketplace, detail: "Ended by hand, confirmed by you" });
    },
  };
}
export const asNewListing = (l: Listing): NewListing => ({
  itemId: l.itemId, marketplace: l.marketplace, externalId: l.externalId, url: l.url, price: l.price,
  status: l.status, listedAt: l.listedAt, endedAt: l.endedAt, source: l.source,
});

/**
 * Report a worker's result and apply its effects: a succeeded delist / mark_sold ends the listing and is logged;
 * a failed one is logged (and shows up in the needs-action list). The ONE place those side effects live.
 */
export async function completeJob(store: DataStore, id: string, outcome: JobOutcome, now = new Date()): Promise<Job> {
  const job = await store.jobs.complete(id, outcome, now);
  const isDelist = job.jobType === "delist" || job.jobType === "mark_sold";
  const source = job.executor;
  if (job.status === "succeeded" && isDelist && job.listingId && job.itemId) {
    const l = (await store.listings.listForItem(job.itemId)).find((x) => x.id === job.listingId);
    if (l && l.status === "active") {
      await store.listings.upsert({ ...asNewListing(l), status: job.jobType === "mark_sold" ? "sold" : "ended", endedAt: now.toISOString() });
    }
    // Marketplace delete or fallback: the listing row, its old id/URL, the item and the history all stay in Shadow Sync.
    const r = job.result ?? {};
    const fallback = typeof r.fallback === "string" ? r.fallback.slice(0, 300) : null;
    if (r.deleted === true) {
      await store.itemSyncLog.append({ event: "deleted", source, itemId: job.itemId, listingId: job.listingId, marketplace: job.marketplace, jobId: job.id,
        detail: `Deleted on ${job.marketplace} after the confirmed sale (kept here as ended)` });
    } else {
      await store.itemSyncLog.append({ event: job.jobType === "mark_sold" ? "marked_sold" : "delisted", source, itemId: job.itemId, listingId: job.listingId,
        marketplace: job.marketplace, jobId: job.id, detail: fallback ? "Set to Not For Sale (delete was not possible)" : "Confirmed by the worker" });
      if (fallback) {
        await store.itemSyncLog.append({ event: "delete_fallback", source, itemId: job.itemId, listingId: job.listingId, marketplace: job.marketplace, jobId: job.id,
          ref: deleteFallbackKey(job.listingId), detail: `Could not delete on ${job.marketplace} (${fallback}); set to Not For Sale instead. Delete it there by hand, then press Mark delisted.` });
      }
    }
  } else if (job.status === "succeeded" && job.jobType === "create_listing" && job.itemId && typeof job.result?.externalId === "string") {
    // Store the marketplace's listing id at once, so a retry can never post the item twice (spec 2).
    const r = job.result as { externalId: string; url?: unknown };
    const prev = (await store.listings.listForItem(job.itemId)).find((x) => x.marketplace === job.marketplace);
    const l = await store.listings.upsert({
      itemId: job.itemId, marketplace: job.marketplace, externalId: r.externalId, url: typeof r.url === "string" ? r.url : prev?.url ?? null,
      price: prev?.price ?? null, status: "active", listedAt: prev?.listedAt ?? now.toISOString(), endedAt: null, source: job.executor,
    });
    await store.itemSyncLog.append({ event: "listed", source, itemId: job.itemId, listingId: l.id, marketplace: job.marketplace, jobId: job.id, detail: "Listed by the worker" });
  } else if (job.status === "failed") {
    await store.itemSyncLog.append({ event: isDelist ? "delist_failed" : "job_failed", source, itemId: job.itemId, listingId: job.listingId,
      marketplace: job.marketplace, jobId: job.id, detail: job.lastError });
  }
  return job;
}
