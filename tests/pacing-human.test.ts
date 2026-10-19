// Pacing speeds (David, 1.0.4): "normal" = Vendoo-like (2-10 s gaps, a 20-40 s breather after 25 in a row, Poshmark 100/hour);
// "careful" = the 1.0.3 pace (20-90 s, 3-8 min breaks every 5-8, 30/hour). Delists / mark sold skip breaks, never the gap or caps.
import { describe, expect, it } from "vitest";
import * as P from "../extension/src/pacing";
import { backends } from "./helpers";
import { createJob } from "../src/lib/jobs/api";

const T0 = new Date("2026-10-19T10:00:00").getTime();
const run = (s: P.PacingState, a: Parameters<typeof P.begin>[2], t: number, rand = 0) => P.finish(P.begin(s, "poshmark", a, t), "poshmark", { ok: true }, t, rand);
const careful = (): P.PacingState => ({ ...P.emptyPacing(), speed: { poshmark: "careful" } });

describe("normal speed (default): Vendoo-like", () => {
  it("2-10 s jittered gap", () => {
    expect(P.speedOf(P.emptyPacing(), "poshmark")).toBe("normal");
    for (const r of [0, 0.25, 0.5, 0.999]) {
      const s = run(P.emptyPacing(), "updateListing", T0, r);
      const gap = s.mp.poshmark!.nextAt - T0;
      expect(gap).toBeGreaterThanOrEqual(2_000); expect(gap).toBeLessThanOrEqual(10_000);
    }
    expect(P.gapMs(0)).toBe(2_000); expect(P.gapMs(0.999999)).toBe(10_000);
    const s = run(P.emptyPacing(), "updateListing", T0, 0.5);
    expect(P.readiness(s, "poshmark", T0 + 1_000)).toMatchObject({ ok: false, reason: "Waiting between jobs", spacing: true });
    expect(P.readiness(s, "poshmark", s.mp.poshmark!.nextAt)).toEqual({ ok: true });
  });
  it("10 listings run back to back in about a minute: no long break", () => {
    let s = P.emptyPacing(), t = T0;
    for (let i = 0; i < 10; i++) {
      expect(P.canRun(s, "poshmark", "updateListing", t)).toEqual({ ok: true });
      s = run(s, "updateListing", t, (i * 0.37) % 1);
      t = s.mp.poshmark!.nextAt;
    }
    expect(t - T0).toBeLessThanOrEqual(10 * 10_000);
    expect(s.mp.poshmark!.breakUntil ?? 0).toBe(0);
  });
  it("a light 20-40 s breather after 25 in a row; delists skip it", () => {
    let s = P.emptyPacing(), t = T0;
    for (let i = 0; i < 25; i++) { s = run(s, "updateQuantity", t); t += 10_000; }
    const until = s.mp.poshmark!.breakUntil!;
    const len = until - (t - 10_000);
    expect(len).toBeGreaterThanOrEqual(20_000); expect(len).toBeLessThanOrEqual(40_000);
    expect(P.canRun(s, "poshmark", "updateListing", t)).toMatchObject({ ok: false, reason: "Taking a short break", urgentOk: true });
    expect(P.canRun(s, "poshmark", "delist", t)).toEqual({ ok: true });
    expect(P.readiness(s, "poshmark", until)).toEqual({ ok: true });
  });
  it("hourly backstop: Poshmark 100, Facebook 60, configurable per browser; it holds for delists too", () => {
    expect(P.hourlyCap(P.emptyPacing(), "poshmark")).toBe(100);
    expect(P.hourlyCap(P.emptyPacing(), "facebook")).toBe(60);
    let s: P.PacingState = { ...P.emptyPacing(), hourlyCaps: { poshmark: 3 } };
    for (let i = 0; i < 3; i++) s = run(s, "updateQuantity", T0 + i * 1000);
    expect(P.readiness(s, "poshmark", T0 + 60_000)).toMatchObject({ ok: false, reason: "Hourly limit reached (3 an hour)", until: T0 + 3600_000, spacing: true });
    expect(P.canRun(s, "poshmark", "delist", T0 + 60_000).ok).toBe(false);
    expect(P.readiness(s, "poshmark", T0 + 3600_001)).toEqual({ ok: true });
  });
});

describe("careful speed: the 1.0.3 pace", () => {
  it("20-90 s gaps, a 3-8 minute break after 5-8 actions, 30 an hour", () => {
    expect(P.hourlyCap(careful(), "poshmark")).toBe(30);
    for (const r of [0, 0.13, 0.5, 0.99]) {
      let s = careful(), t = T0, n = 0;
      const g = run(s, "updateListing", T0, r).mp.poshmark!.nextAt - T0;
      expect(g).toBeGreaterThanOrEqual(20_000); expect(g).toBeLessThanOrEqual(90_000);
      while (!(s.mp.poshmark?.breakUntil)) { s = run(s, "updateListing", t, r); t += 100_000; n++; }
      expect(n).toBeGreaterThanOrEqual(5); expect(n).toBeLessThanOrEqual(8);
      const len = s.mp.poshmark!.breakUntil! - (t - 100_000);
      expect(len).toBeGreaterThanOrEqual(3 * 60_000); expect(len).toBeLessThanOrEqual(8 * 60_000);
    }
  });
  it("delist and mark sold skip the long break but keep the short gap", () => {
    let s = careful(), t = T0;
    for (let i = 0; i < 5; i++) { s = run(s, "updateQuantity", t); t += 100_000; }
    expect(P.canRun(s, "poshmark", "updateListing", t).ok).toBe(false);
    expect(P.canRun(s, "poshmark", "delist", t)).toEqual({ ok: true });
    s = run(s, "delist", t);
    expect(P.canRun(s, "poshmark", "markSold", t + 5_000)).toMatchObject({ ok: false, reason: "Waiting between jobs" });
    expect(P.canRun(s, "poshmark", "markSold", t + 25_000).ok).toBe(true);
  });
});

describe("switching speed, and the 1.0.4 upgrade", () => {
  it("careful -> normal cuts a 3-8 minute break and a long gap down to the normal maximum", () => {
    let s = careful(), t = T0;
    for (let i = 0; i < 8 && !s.mp.poshmark?.breakUntil; i++) { s = run(s, "updateQuantity", t, 0.9); t += 100_000; }
    expect(s.mp.poshmark!.breakUntil! - t).toBeGreaterThan(60_000);
    s = P.setSpeed(s, "poshmark", "normal", t);
    expect(P.speedOf(s, "poshmark")).toBe("normal");
    expect(s.mp.poshmark!.breakUntil! - t).toBeLessThanOrEqual(40_000);
    expect(s.mp.poshmark!.nextAt - t).toBeLessThanOrEqual(10_000);
  });
  it("refitSpeeds (upgrade) shortens leftovers for normal marketplaces, leaves careful ones alone", () => {
    const leftover = { ...P.emptyPacing(), speed: { depop: "careful" as const } };
    leftover.mp.poshmark = { ...run(P.emptyPacing(), "updateListing", T0).mp.poshmark!, nextAt: T0 + 80_000, breakUntil: T0 + 7 * 60_000, sinceBreak: 6, breakAfter: 7 };
    leftover.mp.depop = { ...leftover.mp.poshmark, breakUntil: T0 + 7 * 60_000 };
    const s = P.refitSpeeds(leftover, T0);
    expect(s.mp.poshmark!.nextAt).toBe(T0 + 10_000);
    expect(s.mp.poshmark!.breakUntil).toBe(T0 + 40_000);
    expect(s.mp.poshmark!.breakAfter).toBeUndefined();
    expect(s.mp.depop!.breakUntil).toBe(T0 + 7 * 60_000);
    expect(s.speed).toEqual({ depop: "careful" });
  });
});

describe("batches are no longer spread by next_run_at", () => {
  it("createJob: every job in a batch is due now; the extension spaces them", async () => {
    const env = backends.find((b) => b.name === "mock")!.make();
    const svc = await env.user(0);
    const item = await svc.store.items.create({ title: "x", sku: "TEST-1", status: "listed" });
    const l = await svc.store.listings.upsert({ itemId: item.id, marketplace: "poshmark", externalId: "a".repeat(24), url: null, price: 5, status: "active", listedAt: null, endedAt: null, source: "manual" });
    for (let i = 0; i < 10; i++) {
      const j = (await createJob(svc, { marketplace: "poshmark", jobType: "update_listing", itemId: item.id, listingId: l.id, payload: { quantity: i }, idempotencyKey: `k${i}` })).body.job as { nextRunAt: string };
      expect(Date.parse(j.nextRunAt)).toBeLessThanOrEqual(Date.now() + 1000);
    }
  });
});

describe("popup 'next action' line", () => {
  it("seconds when it is close, a clock time when it is further", () => {
    expect(P.nextActionText(T0 + 6_200, T0)).toBe("Next action in about 7 s");
    expect(P.nextActionText(T0 + 100, T0)).toBe("Next action in about 1 s");
    expect(P.nextActionText(T0 + 5 * 60_000, T0)).toMatch(/^Next action around \d{1,2}:\d{2}/);
  });
});
