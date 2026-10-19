// Per-item timeline (spec 6A): item_sync_log entries plus the job log, merged oldest to newest... newest first for display.
import type { ItemSyncLogEntry, Job, JobEvent, Marketplace } from "../data/types";
import { jobEventLabel, jobLabel } from "./labels";

export interface TimelineRow {
  at: string;
  kind: "log" | "job";
  label: string;
  marketplace: Marketplace | null;
  source: string | null;
  detail: string | null;
  jobId: string | null;
}
const words = (s: string) => s.replace(/_/g, " ");

export function buildTimeline(entries: ItemSyncLogEntry[], jobs: Job[], events: JobEvent[]): TimelineRow[] {
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  // A "delist queued" log line for a job we have is shown as that job's "Queued: ..." line (its reason becomes the detail).
  const queuedWhy = new Map(entries.filter((e) => e.event === "delist_queued" && e.jobId && jobById.has(e.jobId)).map((e) => [e.jobId!, e.detail]));
  const rows: TimelineRow[] = [
    ...entries.filter((e) => (e.event !== "needs_action_ignored" || e.itemId) && !(e.event === "delist_queued" && e.jobId && jobById.has(e.jobId))).map((e): TimelineRow => ({
      at: e.at, kind: "log", label: words(e.event), marketplace: e.marketplace, source: e.source, detail: e.detail, jobId: e.jobId,
    })),
    ...events.flatMap((ev): TimelineRow[] => {
      const j = jobById.get(ev.jobId);
      if (!j) return [];
      const why = ev.toStatus === "queued" && ev.fromStatus === null ? queuedWhy.get(j.id) : undefined;
      const detail = why ?? (ev.message && !/^queued$/i.test(ev.message) ? ev.message : null);
      return [{ at: ev.at, kind: "job", label: jobEventLabel(ev.toStatus, jobLabel(j), j.marketplace), marketplace: j.marketplace, source: j.executor, detail, jobId: j.id }];
    }),
  ];
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}
