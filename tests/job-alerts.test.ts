// Job alerts (1.0.4): green check / red X, our own tone, one chime per finished job throttled to one per 0.5 s, sounds toggle.
import { describe, expect, it, vi } from "vitest";
import { chimeSchedule, finishedSince, outcomeOf, soundsOn, statusMap, SOUND_KEY } from "../src/lib/jobs/alerts";
import { buildTimeline } from "../src/lib/jobs/timeline";
import type { Job, JobEvent } from "../src/lib/data/types";

describe("marks", () => {
  it("succeeded = green check; failed / needs you = red X; open or canceled = nothing; any job type (createListing later too)", () => {
    expect(outcomeOf("succeeded")).toBe("success");
    expect(outcomeOf("failed")).toBe("failure");
    expect(outcomeOf("needs_user")).toBe("failure");
    for (const s of ["queued", "claimed", "running", "retry_wait", "canceled"]) expect(outcomeOf(s)).toBeNull();
  });
  it("the sync log marks job lines by their outcome", () => {
    const job = { id: "j1", jobType: "update_listing", marketplace: "poshmark", executor: "extension", payload: { price: 25 }, status: "succeeded" } as unknown as Job;
    const ev = (to: string, at: string) => ({ jobId: "j1", fromStatus: null, toStatus: to, at, message: null }) as unknown as JobEvent;
    const rows = buildTimeline([], [job], [ev("queued", "2026-10-19T10:00:00Z"), ev("succeeded", "2026-10-19T10:00:09Z")]);
    expect(rows.map((r) => r.outcome)).toEqual(["success", null]);
  });
});

describe("what counts as news", () => {
  it("only jobs that finished since the last look; the first look and already-finished jobs alert nothing", () => {
    const a = [{ id: "1", status: "queued" }, { id: "2", status: "running" }, { id: "3", status: "succeeded" }] as Job[];
    expect(finishedSince(null, a)).toEqual([]);
    const b = [{ id: "1", status: "succeeded" }, { id: "2", status: "needs_user" }, { id: "3", status: "succeeded" }, { id: "4", status: "succeeded" }] as Job[];
    expect(finishedSince(statusMap(a), b)).toEqual([{ id: "1", kind: "success" }, { id: "2", kind: "failure" }]);
    expect(finishedSince(statusMap(b), b)).toEqual([]);
    // a retried job that succeeds after needing you is news again
    expect(finishedSince(new Map([["2", "needs_user"]]), [{ id: "2", status: "succeeded" }] as Job[])).toEqual([{ id: "2", kind: "success" }]);
  });
});

describe("batch throttle", () => {
  it("one chime per finished job, never closer than 0.5 s, continuing after the last one, capped", () => {
    expect(chimeSchedule(1, 10_000, 0)).toEqual([0]);
    expect(chimeSchedule(4, 10_000, 0)).toEqual([0, 500, 1000, 1500]);
    expect(chimeSchedule(2, 10_000, 9_800)).toEqual([300, 800]); // the previous chime was 0.2 s ago
    expect(chimeSchedule(50, 0, -1000)).toHaveLength(20);
    const t = chimeSchedule(10, 0, -1000);
    for (let i = 1; i < t.length; i++) expect(t[i] - t[i - 1]).toBeGreaterThanOrEqual(500);
  });
});

describe("Job sounds setting", () => {
  it("on by default, off only when switched off", () => {
    const st = (v: string | null) => ({ getItem: (k: string) => (k === SOUND_KEY ? v : null) });
    expect(soundsOn(st(null))).toBe(true);
    expect(soundsOn(st("on"))).toBe(true);
    expect(soundsOn(st("off"))).toBe(false);
    expect(soundsOn(null)).toBe(true);
  });
});

describe("our tone (Web Audio)", () => {
  it("success is two short rising sine notes; failure one quiet low tone; nothing is loaded from a file", async () => {
    const started: { type: string; freq: number }[] = [];
    class FakeCtx {
      state = "running"; currentTime = 1; destination = {};
      createOscillator() { const o = { type: "", frequency: { setValueAtTime: (f: number) => { o.f = f; } }, f: 0, connect: (g: unknown) => g, start: () => started.push({ type: o.type, freq: o.f }), stop: () => undefined }; return o; }
      createGain() { return { gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined }, connect: (d: unknown) => d }; }
      resume() { return Promise.resolve(); }
    }
    vi.stubGlobal("window", { AudioContext: FakeCtx });
    const { playTone, TONES } = await import("../src/components/chime");
    playTone("success");
    expect(started).toEqual([{ type: "sine", freq: 659.25 }, { type: "sine", freq: 987.77 }]);
    started.length = 0;
    playTone("failure");
    expect(started).toEqual([{ type: "triangle", freq: 196 }]);
    expect(Math.max(...TONES.failure.map((n) => n.peak))).toBeLessThan(Math.min(...TONES.success.map((n) => n.peak))); // softer
    vi.unstubAllGlobals();
  });
});
