// Pure job state machine: no I/O, no clock reads (callers pass `now`). Both data-layer implementations apply these results,
// so the mock and Supabase stores cannot disagree about the rules. Spec: job-queue-extension-spec.md section 2.
import type { Job, JobOutcome, JobStatus, JobType, NewJob } from "../data/types";

export const MAX_ATTEMPTS = 5;
export const LEASE_MS = 10 * 60_000;
/** Wait after the 1st, 2nd, 3rd and 4th failed attempt. A 5th failure is final. */
export const BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000] as const;

/** Open = still waiting on someone. Only open jobs count for idempotency dedupe (same set as the partial unique index in 0005). */
export const OPEN_STATUSES: readonly JobStatus[] = ["queued", "claimed", "running", "retry_wait", "needs_user"];
export const TERMINAL_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "canceled"];
export const isOpen = (s: JobStatus) => OPEN_STATUSES.includes(s);

/** Legal transitions. Anything not listed is illegal and throws. */
const LEGAL: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["claimed", "canceled"],
  claimed: ["running", "queued", "retry_wait", "needs_user", "failed", "canceled"], // queued = lease expired; retry_wait = transient error before start
  running: ["succeeded", "retry_wait", "failed", "needs_user", "canceled", "queued"], // queued = lease expired
  retry_wait: ["queued", "canceled"],
  needs_user: ["queued", "canceled"],                                     // queued = the user fixed it and pressed Retry
  failed: ["queued"],                                                     // manual retry
  succeeded: [],
  canceled: [],
};
export const canTransition = (from: JobStatus, to: JobStatus) => LEGAL[from].includes(to);

export class IllegalTransitionError extends Error {
  constructor(public from: JobStatus, public to: JobStatus) {
    super(`Illegal job transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}
export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/** Lower number runs first: overselling is the expensive mistake, so delist / mark_sold go before everything else. */
export const PRIORITY: Record<JobType, number> = { delist: 0, mark_sold: 0, create_listing: 10, update_listing: 10, sync_status: 20 };
export const priorityFor = (t: JobType) => PRIORITY[t];

/** What a state change writes back, plus the line for the user-visible job log. */
export interface Transition {
  patch: Partial<Job>;
  event: { fromStatus: JobStatus; toStatus: JobStatus; message: string };
}
const iso = (d: Date) => d.toISOString();
const move = (job: Job, to: JobStatus, patch: Partial<Job>, message: string): Transition => {
  assertTransition(job.status, to);
  return { patch: { ...patch, status: to }, event: { fromStatus: job.status, toStatus: to, message } };
};

/** Backoff after `attempts` attempts have been used (1-based). null = out of attempts. */
export function backoffAfter(attempts: number, maxAttempts = MAX_ATTEMPTS): number | null {
  if (attempts >= maxAttempts) return null;
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];
}

const FIELD_RESET = { leaseExpiresAt: null, claimedByDevice: null } as const;

/** queued -> claimed with a 10-minute lease. Counts the attempt. The caller must have checked isDue. */
export function claim(job: Job, deviceId: string | null, now: Date): Transition {
  return move(job, "claimed", { attempts: job.attempts + 1, claimedByDevice: deviceId, leaseExpiresAt: iso(new Date(now.getTime() + LEASE_MS)) },
    `Claimed (attempt ${job.attempts + 1} of ${job.maxAttempts})`);
}
export function start(job: Job, now: Date): Transition {
  return move(job, "running", { startedAt: job.startedAt ?? iso(now) }, "Started");
}
/** Long jobs extend the lease. Only claimed/running jobs have one. */
export function extendLease(job: Job, now: Date): Transition {
  if (job.status !== "claimed" && job.status !== "running") throw new IllegalTransitionError(job.status, job.status);
  return { patch: { leaseExpiresAt: iso(new Date(now.getTime() + LEASE_MS)) }, event: { fromStatus: job.status, toStatus: job.status, message: "Lease extended" } };
}

/** Apply a worker's result: success, transient (retry with backoff), hard (fail now), needs_user (stop until the user acts). */
export function applyOutcome(job: Job, outcome: JobOutcome, now: Date): Transition {
  switch (outcome.kind) {
    case "success":
      return move(job, "succeeded", { ...FIELD_RESET, result: outcome.result ?? null, finishedAt: iso(now), lastError: null, lastErrorCode: null }, "Succeeded");
    case "hard":
      return move(job, "failed", { ...FIELD_RESET, finishedAt: iso(now), lastError: outcome.message, lastErrorCode: outcome.code }, `Failed: ${outcome.message}`);
    case "needs_user":
      return move(job, "needs_user", { ...FIELD_RESET, lastError: outcome.message, lastErrorCode: outcome.code }, `Needs you: ${outcome.message}`);
    case "transient": {
      const wait = backoffAfter(job.attempts, job.maxAttempts);
      const err = { lastError: outcome.message, lastErrorCode: outcome.code };
      if (wait === null) return move(job, "failed", { ...FIELD_RESET, ...err, finishedAt: iso(now) }, `Failed after ${job.attempts} attempts: ${outcome.message}`);
      return move(job, "retry_wait", { ...FIELD_RESET, ...err, nextRunAt: iso(new Date(now.getTime() + wait)) },
        `Attempt ${job.attempts} failed (${outcome.message}). Retrying in ${Math.round(wait / 60_000)} min`);
    }
  }
}

/** Error codes the extension and API workers use, mapped to an outcome kind. Unknown codes are hard errors, never silently retried. */
// Keep in sync with _ext_outcome() in migration 0006 (the device-token SQL path); the contract suite checks both.
export const TRANSIENT_CODES: ReadonlySet<string> = new Set(["timeout", "network", "rate_limited", "http_5xx", "server_error", "unavailable", "deferred"]);
export const NEEDS_USER_CODES: ReadonlySet<string> = new Set([
  "signed_out", "login_required", "captcha", "challenge", "verification_required", "reauth_required",
  "unexpected_page", "review_and_submit", "listing_not_found", "permission_missing",
]);
/** Security checks: two in a row on one marketplace auto-pause it for that device (spec 5). */
export const CHALLENGE_CODES: ReadonlySet<string> = new Set(["captcha", "challenge", "verification_required"]);
export function outcomeFromError(code: string, message: string): JobOutcome {
  const c = code.toLowerCase();
  if (NEEDS_USER_CODES.has(c)) return { kind: "needs_user", code: c, message };
  if (TRANSIENT_CODES.has(c) || /^http_5\d\d$/.test(c)) return { kind: "transient", code: c, message };
  return { kind: "hard", code: c, message };
}

/** Lease expiry: a claimed/running job whose lease ran out goes back to the queue (attempt already counted), or fails when out of attempts. */
export const leaseExpired = (job: Job, now: Date) =>
  (job.status === "claimed" || job.status === "running") && job.leaseExpiresAt !== null && new Date(job.leaseExpiresAt).getTime() <= now.getTime();
export function expireLease(job: Job, now: Date): Transition | null {
  if (!leaseExpired(job, now)) return null;
  const err = { lastError: "Lease expired: the worker did not report back in time", lastErrorCode: "lease_expired" };
  if (job.attempts >= job.maxAttempts) {
    return move(job, "failed", { ...FIELD_RESET, ...err, finishedAt: iso(now) }, "Lease expired and no attempts left");
  }
  return move(job, "queued", { ...FIELD_RESET, ...err, nextRunAt: iso(now) }, `Lease expired, back in the queue (attempt ${job.attempts} of ${job.maxAttempts} used)`);
}

/** retry_wait whose time has come goes back to queued. */
export function requeueIfDue(job: Job, now: Date): Transition | null {
  if (job.status !== "retry_wait" || new Date(job.nextRunAt).getTime() > now.getTime()) return null;
  return move(job, "queued", {}, "Retry is due, back in the queue");
}

/** User pressed Retry on a failed or needs_user job: a fresh round of attempts. */
export function manualRetry(job: Job, now: Date): Transition {
  if (job.status !== "failed" && job.status !== "needs_user") throw new IllegalTransitionError(job.status, "queued");
  return move(job, "queued", { ...FIELD_RESET, attempts: 0, nextRunAt: iso(now), finishedAt: null }, "Retried by you");
}
/** The extension reports you are signed in again: jobs that stopped because you were signed out go back in the queue (fresh round). */
export const SIGNED_OUT_CODES: ReadonlySet<string> = new Set(["signed_out", "login_required"]);
export function requeueAfterSignIn(job: Job, now: Date): Transition | null {
  if (job.status !== "needs_user" || !SIGNED_OUT_CODES.has(job.lastErrorCode ?? "")) return null;
  return move(job, "queued", { ...FIELD_RESET, attempts: 0, nextRunAt: iso(now), finishedAt: null }, "You are signed in again, back in the queue");
}
/** Cancel (the user, or the kill switch). Legal from any open state. */
export function cancel(job: Job, now: Date, why = "Canceled by you"): Transition {
  return move(job, "canceled", { ...FIELD_RESET, finishedAt: iso(now) }, why);
}

export const isDue = (job: Job, now: Date) => job.status === "queued" && new Date(job.nextRunAt).getTime() <= now.getTime();

/** Claim order: priority (delist / mark_sold first), then due time, then age. Same order as claim_jobs() in 0005. */
export function claimOrder(a: Job, b: Job): number {
  return a.priority - b.priority || a.nextRunAt.localeCompare(b.nextRunAt) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}
export function pickClaimable(jobs: Job[], executor: Job["executor"], now: Date, limit: number): Job[] {
  return jobs.filter((j) => j.executor === executor && isDue(j, now)).sort(claimOrder).slice(0, Math.max(0, limit));
}

/** Dedupe: an open job with the same idempotency key (per user) already exists. */
export function findOpenDuplicate(jobs: Job[], idempotencyKey: string | null | undefined): Job | undefined {
  if (!idempotencyKey) return undefined;
  return jobs.find((j) => j.idempotencyKey === idempotencyKey && isOpen(j.status));
}
export const delistKey = (type: "delist" | "mark_sold", listingId: string, saleId: string) => `${type}:${listingId}:${saleId}`;

/** Fill defaults for a new job. */
export function buildNewJob(input: NewJob, ids: { id: string; userId: string }, now: Date): Job {
  return {
    id: ids.id, userId: ids.userId, itemId: input.itemId ?? null, listingId: input.listingId ?? null,
    marketplace: input.marketplace, jobType: input.jobType, executor: input.executor, status: "queued",
    priority: input.priority ?? priorityFor(input.jobType), payload: input.payload ?? {},
    idempotencyKey: input.idempotencyKey ?? null, attempts: 0, maxAttempts: input.maxAttempts ?? MAX_ATTEMPTS,
    nextRunAt: input.nextRunAt ?? iso(now), leaseExpiresAt: null, claimedByDevice: null, lastError: null, lastErrorCode: null,
    result: null, createdAt: iso(now), startedAt: null, finishedAt: null,
  };
}
