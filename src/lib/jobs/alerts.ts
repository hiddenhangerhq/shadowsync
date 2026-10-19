// Job alerts (David, 1.0.4): a green check and a short chime when a job succeeds, a red X (and a soft low tone) when it fails or needs you.
// Pure parts here (tested); the tone itself is in components/chime.ts. Any job type uses the same alert, so createListing gets it for free.
import type { Job, JobStatus } from "../data/types";

export type AlertKind = "success" | "failure";
/** The mark a job shows: success = green check, failure = red X; nothing while it is still open or canceled. */
export function outcomeOf(status: JobStatus | string): AlertKind | null {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "needs_user") return "failure";
  return null;
}
export const MARK: Record<AlertKind, { icon: string; label: string }> = {
  success: { icon: "✓", label: "Succeeded" },
  failure: { icon: "✕", label: "Failed or needs you" },
};

/** Jobs that FINISHED since the last look (open -> succeeded / failed / needs you). The first look (no previous) alerts nothing,
 *  and a job first seen already finished is not "news". */
export function finishedSince(prev: ReadonlyMap<string, string> | null, now: Pick<Job, "id" | "status">[]): { id: string; kind: AlertKind }[] {
  if (!prev) return [];
  const out: { id: string; kind: AlertKind }[] = [];
  for (const j of now) {
    const before = prev.get(j.id);
    const kind = outcomeOf(j.status);
    if (!kind || before === undefined || outcomeOf(before) === kind) continue;
    out.push({ id: j.id, kind });
  }
  return out;
}
export const statusMap = (jobs: Pick<Job, "id" | "status">[]) => new Map(jobs.map((j) => [j.id, j.status as string]));

/** One chime per finished job, but at most one per `gapMs` (default 0.5 s): returns when each should play (ms from `now`).
 *  `lastAt` is when the previous chime played. Capped at `max` so a huge batch does not chime for a minute. */
export function chimeSchedule(count: number, now: number, lastAt: number, gapMs = 500, max = 20): number[] {
  const out: number[] = [];
  let t = Math.max(now, lastAt + gapMs);
  for (let i = 0; i < Math.min(count, max); i++) { out.push(t - now); t += gapMs; }
  return out;
}

export const SOUND_KEY = "ss_job_sounds";
/** Job sounds are on unless switched off on this browser (Settings). */
export const soundsOn = (store: Pick<Storage, "getItem"> | null | undefined) => (store?.getItem(SOUND_KEY) ?? "on") !== "off";
