// Behaviour shared by every DataStore implementation, written once against the interface (so the mock and Supabase cannot drift).
import type { DataStore } from "../data/interfaces";
import type { Job, JobOutcome, Listing, NewListing } from "../data/types";
import { isOpen } from "./state-machine";
import { computeNeedsAction } from "./needs-action";

export function makeNeedsAction(getStore: () => DataStore): DataStore["needsAction"] {
  return {
    async list(now = new Date()) {
      const s = getStore();
      // The three log event kinds the rules read, fetched separately so a long history of other events can never push an "ignore" out of range.
      const [items, listings, sales, jobs, ignored, cancelled, unmatched] = await Promise.all([
        s.items.list(), s.listings.list(), s.sales.list(), s.jobs.list(),
        s.itemSyncLog.list({ event: "needs_action_ignored" }), s.itemSyncLog.list({ event: "sale_cancelled" }), s.itemSyncLog.list({ event: "sale_unmatched" }),
      ]);
      return computeNeedsAction({ items, listings, sales, jobs, syncLog: [...ignored, ...cancelled, ...unmatched], now });
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
    await store.itemSyncLog.append({ event: job.jobType === "mark_sold" ? "marked_sold" : "delisted", source, itemId: job.itemId, listingId: job.listingId,
      marketplace: job.marketplace, jobId: job.id, detail: "Confirmed by the worker" });
  } else if (job.status === "failed") {
    await store.itemSyncLog.append({ event: isDelist ? "delist_failed" : "job_failed", source, itemId: job.itemId, listingId: job.listingId,
      marketplace: job.marketplace, jobId: job.id, detail: job.lastError });
  }
  return job;
}
