// Per-item timeline (spec 6A): item_sync_log entries plus the job log, merged oldest to newest... newest first for display.
import type { ItemSyncLogEntry, Job, JobEvent, Marketplace } from "../data/types";

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
  const rows: TimelineRow[] = [
    ...entries.filter((e) => e.event !== "needs_action_ignored" || e.itemId).map((e): TimelineRow => ({
      at: e.at, kind: "log", label: words(e.event), marketplace: e.marketplace, source: e.source, detail: e.detail, jobId: e.jobId,
    })),
    ...events.flatMap((ev): TimelineRow[] => {
      const j = jobById.get(ev.jobId);
      return j ? [{ at: ev.at, kind: "job", label: `${words(j.jobType)}: ${words(ev.toStatus)}`, marketplace: j.marketplace, source: j.executor, detail: ev.message, jobId: j.id }] : [];
    }),
  ];
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}
