import { describe, expect, it } from "vitest";
import * as sm from "../src/lib/jobs/state-machine";
import { JOB_STATUSES, type Job, type JobStatus } from "../src/lib/data/types";

const T0 = new Date("2026-10-18T12:00:00.000Z");
const plus = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;
const mk = (o: Partial<Job> = {}): Job => ({
  ...sm.buildNewJob({ marketplace: "poshmark", jobType: "delist", executor: "extension", itemId: "i1", listingId: "l1" }, { id: "j" + Math.random().toString(36).slice(2, 8), userId: "u1" }, T0),
  ...o,
});

describe("transitions", () => {
  const LEGAL: [JobStatus, JobStatus][] = [
    ["queued", "claimed"], ["queued", "canceled"],
    ["claimed", "running"], ["claimed", "queued"], ["claimed", "retry_wait"], ["claimed", "needs_user"], ["claimed", "failed"], ["claimed", "canceled"],
    ["running", "succeeded"], ["running", "retry_wait"], ["running", "failed"], ["running", "needs_user"], ["running", "canceled"], ["running", "queued"],
    ["retry_wait", "queued"], ["retry_wait", "canceled"], ["needs_user", "queued"], ["needs_user", "canceled"], ["failed", "queued"],
  ];
  it("allows exactly the legal transitions and rejects every other pair", () => {
    for (const from of JOB_STATUSES) for (const to of JOB_STATUSES) {
      const expected = LEGAL.some(([a, b]) => a === from && b === to);
      expect(sm.canTransition(from, to), `${from} -> ${to}`).toBe(expected);
    }
  });
  it("succeeded and canceled are terminal", () => {
    for (const to of JOB_STATUSES) { expect(sm.canTransition("succeeded", to)).toBe(false); expect(sm.canTransition("canceled", to)).toBe(false); }
  });
  it("illegal moves throw IllegalTransitionError", () => {
    expect(() => sm.assertTransition("queued", "succeeded")).toThrow(sm.IllegalTransitionError);
    expect(() => sm.start(mk({ status: "queued" }), T0)).toThrow(/queued -> running/);
    expect(() => sm.applyOutcome(mk({ status: "queued" }), { kind: "success" }, T0)).toThrow(sm.IllegalTransitionError);
    expect(() => sm.applyOutcome(mk({ status: "succeeded" }), { kind: "hard", code: "x", message: "m" }, T0)).toThrow(sm.IllegalTransitionError);
    expect(() => sm.cancel(mk({ status: "failed" }), T0)).toThrow(sm.IllegalTransitionError);
    expect(() => sm.manualRetry(mk({ status: "running" }), T0)).toThrow(sm.IllegalTransitionError);
    expect(() => sm.extendLease(mk({ status: "queued" }), T0)).toThrow();
  });
});

describe("claim, start, lease", () => {
  it("claim counts the attempt and sets a 10-minute lease", () => {
    const t = sm.claim(mk(), "dev1", T0);
    expect(t.patch).toMatchObject({ status: "claimed", attempts: 1, claimedByDevice: "dev1", leaseExpiresAt: plus(10 * MIN).toISOString() });
    expect(t.event).toMatchObject({ fromStatus: "queued", toStatus: "claimed" });
  });
  it("extending the lease pushes it 10 minutes from now", () => {
    const j = mk({ status: "running", leaseExpiresAt: plus(2 * MIN).toISOString() });
    expect(sm.extendLease(j, plus(5 * MIN)).patch.leaseExpiresAt).toBe(plus(15 * MIN).toISOString());
  });
  it("an expired lease returns the job to the queue and keeps the attempt counted", () => {
    const j = mk({ status: "running", attempts: 2, leaseExpiresAt: plus(10 * MIN).toISOString() });
    expect(sm.expireLease(j, plus(10 * MIN - 1))).toBeNull(); // not yet
    const t = sm.expireLease(j, plus(10 * MIN))!;
    expect(t.patch).toMatchObject({ status: "queued", leaseExpiresAt: null, claimedByDevice: null, lastErrorCode: "lease_expired" });
    expect(t.patch.attempts).toBeUndefined(); // already counted at claim
  });
  it("an expired lease on the last attempt fails the job", () => {
    const j = mk({ status: "claimed", attempts: 5, leaseExpiresAt: plus(MIN).toISOString() });
    expect(sm.expireLease(j, plus(2 * MIN))!.patch).toMatchObject({ status: "failed", lastErrorCode: "lease_expired" });
  });
  it("only claimed/running jobs can have an expired lease", () => {
    expect(sm.expireLease(mk({ status: "queued" }), plus(99 * MIN))).toBeNull();
    expect(sm.expireLease(mk({ status: "succeeded", leaseExpiresAt: plus(-MIN).toISOString() }), plus(MIN))).toBeNull();
  });
});

describe("retries and backoff", () => {
  it("backs off 5 min, 15 min, 1 h, 4 h, then gives up on the 5th failure", () => {
    expect([1, 2, 3, 4].map((n) => sm.backoffAfter(n))).toEqual([5 * MIN, 15 * MIN, 60 * MIN, 240 * MIN]);
    expect(sm.backoffAfter(5)).toBeNull();
    expect(sm.MAX_ATTEMPTS).toBe(5);
  });
  it("a transient error goes to retry_wait with the right next_run_at", () => {
    const expected = [5, 15, 60, 240];
    expected.forEach((min, i) => {
      const j = mk({ status: "running", attempts: i + 1 });
      const t = sm.applyOutcome(j, { kind: "transient", code: "timeout", message: "slow" }, T0);
      expect(t.patch).toMatchObject({ status: "retry_wait", nextRunAt: plus(min * MIN).toISOString(), lastErrorCode: "timeout", leaseExpiresAt: null });
    });
  });
  it("the 5th transient failure is final", () => {
    const t = sm.applyOutcome(mk({ status: "running", attempts: 5 }), { kind: "transient", code: "http_503", message: "down" }, T0);
    expect(t.patch).toMatchObject({ status: "failed", finishedAt: T0.toISOString() });
  });
  it("walks a whole job through 5 attempts: queued -> ... -> failed", () => {
    let j = mk();
    let now = T0;
    const waits: number[] = [];
    for (let n = 1; n <= 5; n++) {
      j = { ...j, ...sm.claim(j, null, now).patch } as Job;
      j = { ...j, ...sm.start(j, now).patch } as Job;
      j = { ...j, ...sm.applyOutcome(j, { kind: "transient", code: "timeout", message: "t" }, now).patch } as Job;
      if (j.status === "retry_wait") {
        waits.push((new Date(j.nextRunAt).getTime() - now.getTime()) / MIN);
        now = new Date(j.nextRunAt);
        expect(sm.requeueIfDue(j, new Date(now.getTime() - 1))).toBeNull();
        j = { ...j, ...sm.requeueIfDue(j, now)!.patch } as Job;
      }
    }
    expect(waits).toEqual([5, 15, 60, 240]);
    expect(j).toMatchObject({ status: "failed", attempts: 5 });
  });
  it("requeueIfDue only moves retry_wait jobs whose time has come", () => {
    const j = mk({ status: "retry_wait", nextRunAt: plus(5 * MIN).toISOString() });
    expect(sm.requeueIfDue(j, plus(4 * MIN))).toBeNull();
    expect(sm.requeueIfDue(j, plus(5 * MIN))!.patch.status).toBe("queued");
    expect(sm.requeueIfDue(mk({ status: "queued" }), plus(99 * MIN))).toBeNull();
  });
});

describe("error classes", () => {
  it("hard errors fail at once with the reason", () => {
    const t = sm.applyOutcome(mk({ status: "running", attempts: 1 }), { kind: "hard", code: "item_rejected", message: "Brand not allowed" }, T0);
    expect(t.patch).toMatchObject({ status: "failed", lastError: "Brand not allowed", lastErrorCode: "item_rejected" });
  });
  it("captcha / signed out goes to needs_user and is never scheduled for a retry", () => {
    for (const code of ["captcha", "signed_out", "challenge"]) {
      const o = sm.outcomeFromError(code, "stop");
      expect(o.kind).toBe("needs_user");
      const t = sm.applyOutcome(mk({ status: "running", attempts: 1 }), o, T0);
      expect(t.patch.status).toBe("needs_user");
      expect(t.patch.nextRunAt).toBeUndefined();
    }
    // the only way out is the user pressing Retry (fresh attempts) or canceling
    const nu = mk({ status: "needs_user", attempts: 3 });
    expect(sm.requeueIfDue(nu, plus(999 * MIN))).toBeNull();
    expect(sm.manualRetry(nu, T0).patch).toMatchObject({ status: "queued", attempts: 0 });
  });
  it("classifies codes: transient / needs_user / unknown is hard", () => {
    expect(sm.outcomeFromError("timeout", "x").kind).toBe("transient");
    expect(sm.outcomeFromError("rate_limited", "x").kind).toBe("transient");
    expect(sm.outcomeFromError("HTTP_502", "x").kind).toBe("transient");
    expect(sm.outcomeFromError("validation_error", "x").kind).toBe("hard");
    expect(sm.outcomeFromError("???", "x").kind).toBe("hard");
  });
  it("success clears the error and stores the result", () => {
    const t = sm.applyOutcome(mk({ status: "running", lastError: "old", lastErrorCode: "timeout" }), { kind: "success", result: { listingId: "x1" } }, T0);
    expect(t.patch).toMatchObject({ status: "succeeded", lastError: null, lastErrorCode: null, result: { listingId: "x1" }, finishedAt: T0.toISOString() });
  });
  it("manual retry works from failed and gives a fresh round", () => {
    expect(sm.manualRetry(mk({ status: "failed", attempts: 5 }), T0).patch).toMatchObject({ status: "queued", attempts: 0, finishedAt: null, nextRunAt: T0.toISOString() });
  });
});

describe("idempotency and priority", () => {
  it("finds an OPEN job with the same key, ignores finished ones and other keys", () => {
    const open = mk({ idempotencyKey: "delist:l1:s1", status: "retry_wait" });
    expect(sm.findOpenDuplicate([open], "delist:l1:s1")).toBe(open);
    expect(sm.findOpenDuplicate([mk({ idempotencyKey: "delist:l1:s1", status: "succeeded" })], "delist:l1:s1")).toBeUndefined();
    expect(sm.findOpenDuplicate([mk({ idempotencyKey: "delist:l1:s1", status: "failed" })], "delist:l1:s1")).toBeUndefined();
    expect(sm.findOpenDuplicate([open], "delist:l2:s1")).toBeUndefined();
    expect(sm.findOpenDuplicate([open], null)).toBeUndefined();
    for (const s of sm.OPEN_STATUSES) expect(sm.findOpenDuplicate([mk({ idempotencyKey: "k", status: s })], "k")).toBeDefined();
  });
  it("delist and mark_sold run before create / update, then sync", () => {
    expect(sm.priorityFor("delist")).toBeLessThan(sm.priorityFor("create_listing"));
    expect(sm.priorityFor("mark_sold")).toBeLessThan(sm.priorityFor("update_listing"));
    expect(sm.priorityFor("create_listing")).toBeLessThan(sm.priorityFor("sync_status"));
    const jobs = [
      mk({ id: "sync", jobType: "sync_status", priority: sm.priorityFor("sync_status"), createdAt: "2026-10-18T10:00:00.000Z", nextRunAt: "2026-10-18T10:00:00.000Z" }),
      mk({ id: "create", jobType: "create_listing", priority: sm.priorityFor("create_listing"), createdAt: "2026-10-18T10:01:00.000Z", nextRunAt: "2026-10-18T10:01:00.000Z" }),
      mk({ id: "delist", jobType: "delist", priority: 0, createdAt: "2026-10-18T11:00:00.000Z", nextRunAt: "2026-10-18T11:00:00.000Z" }),
      mk({ id: "sold", jobType: "mark_sold", priority: 0, createdAt: "2026-10-18T11:30:00.000Z", nextRunAt: "2026-10-18T11:30:00.000Z" }),
    ];
    expect(sm.pickClaimable(jobs, "extension", T0, 10).map((j) => j.id)).toEqual(["delist", "sold", "create", "sync"]);
    expect(sm.pickClaimable(jobs, "extension", T0, 2).map((j) => j.id)).toEqual(["delist", "sold"]);
    expect(sm.pickClaimable(jobs, "api", T0, 10)).toEqual([]); // wrong executor
  });
  it("only due, queued jobs are claimable", () => {
    const later = mk({ id: "later", nextRunAt: plus(MIN).toISOString() });
    const waiting = mk({ id: "w", status: "retry_wait", nextRunAt: plus(-MIN).toISOString() });
    expect(sm.pickClaimable([later, waiting], "extension", T0, 5)).toEqual([]);
    expect(sm.pickClaimable([later], "extension", plus(MIN), 5)).toHaveLength(1);
  });
});
