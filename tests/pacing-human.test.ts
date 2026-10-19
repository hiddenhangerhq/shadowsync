// Human-like spacing (David, 2026-10-19): long breaks, hourly cap, batches spread by next_run_at, delists jump the line.
import { describe, expect, it } from "vitest";
import * as P from "../extension/src/pacing";
import { spreadNextRunAt, SPREAD } from "../src/lib/jobs/spacing";
import { backends } from "./helpers";
import { createJob } from "../src/lib/jobs/api";

const T0 = new Date("2026-10-19T10:00:00").getTime();
const run = (s: P.PacingState, a: Parameters<typeof P.begin>[2], t: number, rand = 0) => P.finish(P.begin(s, "poshmark", a, t), "poshmark", { ok: true }, t, rand);

describe("long break after 5-8 actions", () => {
  it("rand 0: a break after exactly 5 actions, 3 to 8 minutes long, then the count starts again", () => {
    let s = P.emptyPacing(), t = T0;
    for (let i = 0; i < 4; i++) { s = run(s, "updateQuantity", t); t += 100_000; expect(P.readiness(s, "poshmark", t)).toEqual({ ok: true }); }
    s = run(s, "updateQuantity", t);
    const until = s.mp.poshmark!.breakUntil!;
    expect(until - t).toBeGreaterThanOrEqual(3 * 60_000);
    expect(until - t).toBeLessThanOrEqual(8 * 60_000);
    expect(P.readiness(s, "poshmark", t + 100_000)).toMatchObject({ ok: false, reason: "Taking a short break", until, spacing: true, urgentOk: true });
    expect(P.readiness(s, "poshmark", until)).toEqual({ ok: true });
    expect(s.mp.poshmark!.sinceBreak).toBe(0);
  });
  it("the break comes after 5 to 8 actions for any randomness, and lasts 3 to 8 minutes", () => {
    for (const r of [0, 0.13, 0.37, 0.5, 0.71, 0.99]) {
      let s = P.emptyPacing(), t = T0, n = 0;
      while (!(s.mp.poshmark?.breakUntil)) { s = run(s, "updateListing", t, r); t += 100_000; n++; }
      expect(n).toBeGreaterThanOrEqual(5); expect(n).toBeLessThanOrEqual(8);
      const len = s.mp.poshmark!.breakUntil! - (t - 100_000);
      expect(len).toBeGreaterThanOrEqual(3 * 60_000); expect(len).toBeLessThanOrEqual(8 * 60_000);
    }
  });
  it("delist and mark sold skip the long break but keep the short gap and the caps", () => {
    let s = P.emptyPacing(), t = T0;
    for (let i = 0; i < 5; i++) { s = run(s, "updateQuantity", t); t += 100_000; }
    expect(P.canRun(s, "poshmark", "updateListing", t).ok).toBe(false);
    expect(P.canRun(s, "poshmark", "delist", t)).toEqual({ ok: true });
    expect(P.canRun(s, "poshmark", "markSold", t)).toEqual({ ok: true });
    s = run(s, "delist", t);
    expect(P.canRun(s, "poshmark", "markSold", t + 5_000)).toMatchObject({ ok: false, reason: "Waiting between jobs" }); // short gap kept
    expect(P.canRun(s, "poshmark", "markSold", t + 25_000).ok).toBe(true);
  });
});

describe("hourly cap", () => {
  it("Poshmark 30 an hour by default, configurable, applies to every action, frees up as the hour rolls", () => {
    expect(P.hourlyCap(P.emptyPacing(), "poshmark")).toBe(30);
    let s: P.PacingState = { ...P.emptyPacing(), hourlyCaps: { poshmark: 3 } };
    const t = T0;
    for (let i = 0; i < 3; i++) s = { ...run(s, "updateQuantity", t + i * 1000), hourlyCaps: { poshmark: 3 } };
    s.mp.poshmark!.breakUntil = 0; s.mp.poshmark!.nextAt = 0;
    const v = P.readiness(s, "poshmark", t + 60_000);
    expect(v).toMatchObject({ ok: false, reason: "Hourly limit reached (3 an hour)", until: t + 3600_000, spacing: true });
    expect(P.canRun(s, "poshmark", "delist", t + 60_000).ok).toBe(false); // the cap holds for delists too
    expect(P.readiness(s, "poshmark", t + 3600_001)).toEqual({ ok: true });
  });
});

describe("big batches spread over time (next_run_at)", () => {
  const now = new Date(T0);
  it("first 5 run now; later ones go after the last waiting one with a 30-90 s gap, plus a 3-8 min break every 6th", () => {
    const w = (n: number) => Array.from({ length: n }, (_, i) => ({ nextRunAt: new Date(T0 + i * 1000).toISOString() }));
    expect(spreadNextRunAt(w(4), now, () => 0)).toBeUndefined();
    expect(Date.parse(spreadNextRunAt(w(5), now, () => 0)!)).toBe(T0 + 4000 + SPREAD.gapMinMs);
    expect(Date.parse(spreadNextRunAt(w(5), now, () => 0.999)!) - (T0 + 4000)).toBeLessThanOrEqual(SPREAD.gapMaxMs);
    const withBreak = Date.parse(spreadNextRunAt(w(6), now, () => 0)!) - (T0 + 5000);
    expect(withBreak).toBe(SPREAD.gapMinMs + SPREAD.breakMinMs);
  });
  it("createJob: the 6th waiting quantity edit is pushed later, a delist is never pushed", async () => {
    const env = backends.find((b) => b.name === "mock")!.make();
    const svc = await env.user(0);
    const item = await svc.store.items.create({ title: "x", sku: "TEST-1", status: "listed" });
    const l = await svc.store.listings.upsert({ itemId: item.id, marketplace: "poshmark", externalId: "a".repeat(24), url: null, price: 5, status: "active", listedAt: null, endedAt: null, source: "manual" });
    const jobs = [];
    for (let i = 0; i < 7; i++) jobs.push((await createJob(svc, { marketplace: "poshmark", jobType: "update_listing", itemId: item.id, listingId: l.id, payload: { quantity: i }, idempotencyKey: `k${i}` })).body.job as { nextRunAt: string });
    const t = jobs.map((j) => Date.parse(j.nextRunAt));
    expect(t[5] - t[4]).toBeGreaterThanOrEqual(SPREAD.gapMinMs - 1000);
    expect(t[6]).toBeGreaterThan(t[5]);
    const d = (await createJob(svc, { marketplace: "poshmark", jobType: "delist", itemId: item.id, listingId: l.id })).body.job as { nextRunAt: string };
    expect(Date.parse(d.nextRunAt)).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
