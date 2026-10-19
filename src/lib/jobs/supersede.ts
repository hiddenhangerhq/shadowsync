// Duplicate edit jobs (David, 1.0.4): a newer "change price" / "set quantity" / "change title" for the same listing replaces the older
// waiting ones, so only the latest value runs. Only queued / retry-wait jobs are touched; a running one is left alone. Pure planner + a runner.
import type { DataStore } from "../data/interfaces";
import type { Job } from "../data/types";

const EDIT_TYPES = new Set<string>(["update_listing"]); // quantity changes are update_listing jobs with { quantity }
const OPEN = new Set(["queued", "retry_wait"]);
/** The listing fields a job changes ("previous" is just the label's old value). */
export const editFields = (j: Pick<Job, "jobType" | "payload">) =>
  EDIT_TYPES.has(j.jobType) ? Object.keys(j.payload ?? {}).filter((k) => k !== "previous" && k !== "mode").sort() : [];

/** Which open jobs are superseded: for each listing, an older open edit whose fields are all changed again by a newer open edit. */
export function supersededJobs(jobs: Job[]): { job: Job; by: Job }[] {
  const open = jobs.filter((j) => j.listingId && EDIT_TYPES.has(j.jobType) && OPEN.has(j.status) && editFields(j).length)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)); // newest first
  const out: { job: Job; by: Job }[] = [];
  open.forEach((older, i) => {
    const f = editFields(older);
    const by = open.slice(0, i).find((n) => n.listingId === older.listingId && !out.some((o) => o.job.id === n.id) && f.every((k) => editFields(n).includes(k)));
    if (by) out.push({ job: older, by });
  });
  return out;
}

/** Cancel the superseded jobs (newest stays). Returns how many were canceled. Best effort: a job that moved on meanwhile is skipped. */
export async function supersedeDuplicates(store: DataStore, opts: { listingId?: string } = {}): Promise<number> {
  const jobs = await store.jobs.list({ status: ["queued", "retry_wait"], ...(opts.listingId ? { listingId: opts.listingId } : {}), limit: 500 });
  let n = 0;
  for (const { job } of supersededJobs(jobs)) {
    try { await store.jobs.cancel(job.id); n++; } catch { /* already claimed or done */ }
  }
  return n;
}
