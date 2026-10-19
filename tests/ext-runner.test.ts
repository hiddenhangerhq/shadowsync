// Runner + worker with a fake browser, fake storage and the real mock API routes (no network, no marketplace).
import { describe, expect, it } from "vitest";
import { runAction, type Browser } from "../extension/src/runner";
import * as w from "../extension/src/worker";
import { makeApi } from "../extension/src/api";
import type { StepResult } from "../extension/src/steps";
import type { ActionRequest, ExtMarketplace } from "../src/lib/ext/protocol";
import { backends } from "./helpers";
import { extJob, extListingsReport, extPairComplete, extPoll, extScanNext, extScanReport, pairStart } from "../src/lib/ext/api";
import type { Services } from "../src/lib/data/interfaces";
import { resetRateLimits } from "../src/lib/ext/ratelimit";

const ID = "a1b2c3d4e5f6a1b2c3d4e5f6";
function fakeBrowser(steps: (url: string, phase: string) => StepResult, o: { perms?: ExtMarketplace[]; redirect?: (u: string) => string; loadFails?: boolean } = {}) {
  const log = { opened: [] as string[], navigated: [] as string[], closed: [] as number[] };
  let url = "";
  const b: Browser = {
    open: async (u) => { log.opened.push(u); url = o.redirect ? o.redirect(u) : u; return 7; },
    navigate: async (_t, u) => { log.navigated.push(u); url = u; },
    waitLoaded: async () => { if (o.loadFails) throw new Error("timeout"); },
    url: async () => url,
    step: async (_t, i) => steps(url, i.phase),
    close: async (t) => { log.closed.push(t); },
    sleep: async () => undefined,
    hasPermission: async (m) => (o.perms ?? ["poshmark"]).includes(m),
  };
  return { b, log };
}
const req = (o: Partial<ActionRequest> = {}): ActionRequest => ({ jobId: null, marketplace: "poshmark", action: "delist", payload: { externalId: ID }, ...o });

describe("runner", () => {
  it("tab closed or replaced mid-job ('No tab with id: 285047528'): reopens once and finishes; twice is a retry later, not a failure", async () => {
    let gone = 1;
    const { b, log } = fakeBrowser((u, phase) => (phase === "start" ? { kind: "wait", phase: "saved", ms: 1 } : { kind: "done", result: { note: "ok" } }));
    const step = b.step;
    b.step = async (t, i) => { if (i.phase === "saved" && gone-- > 0) throw new Error("No tab with id: 285047528."); return step(t, i); };
    expect(await runAction(b, req())).toMatchObject({ ok: true });
    expect(log.opened).toHaveLength(2);
    gone = 99;
    const r = await runAction(b, req());
    expect(r).toMatchObject({ ok: false, code: "unavailable", message: expect.stringMatching(/closed or replaced/) });
    // a vanished tab while loading is the same thing, not a "took too long" timeout
    const f2 = fakeBrowser(() => ({ kind: "done" }));
    f2.b.waitLoaded = async () => { throw new Error("No tab with id: 1."); };
    expect(await runAction(f2.b, req())).toMatchObject({ ok: false, code: "unavailable" });
  });
  it("opens only table URLs, follows goto by page name, closes the tab", async () => {
    const { b, log } = fakeBrowser((u, phase) => (phase === "start" && u.includes("/listing/") ? { kind: "goto", page: "edit", phase: "start" } : u.includes("/edit-listing/") && phase === "start" ? { kind: "wait", phase: "saved", ms: 5000 } : { kind: "done", result: { note: "ok" } }));
    expect(await runAction(b, req())).toMatchObject({ ok: true, result: { note: "ok" } });
    expect(log.opened).toEqual([`https://poshmark.com/edit-listing/${ID}`]);
    expect(log.closed).toEqual([7]);
  });
  it("a tab that wanders to another site is stopped", async () => {
    const { b, log } = fakeBrowser(() => ({ kind: "done" }), { redirect: () => "https://evil.example/phish" });
    expect(await runAction(b, req())).toMatchObject({ ok: false, code: "unexpected_page" });
    expect(log.closed).toEqual([7]);
  });
  it("unsupported marketplace, missing permission and timeouts never touch a page", async () => {
    const { b, log } = fakeBrowser(() => ({ kind: "done" }));
    expect(await runAction(b, req({ marketplace: "depop", payload: { externalId: "x1" } }))).toMatchObject({ ok: false, code: "not_supported" });
    const nop = fakeBrowser(() => ({ kind: "done" }), { perms: [] });
    expect(await runAction(nop.b, req())).toMatchObject({ ok: false, code: "permission_missing" });
    expect(log.opened).toEqual([]); expect(nop.log.opened).toEqual([]);
    const slow = fakeBrowser(() => ({ kind: "done" }), { loadFails: true });
    expect(await runAction(slow.b, req())).toMatchObject({ ok: false, code: "timeout" });
  });
  it("step limit, and the tab stays open only when you must finish something", async () => {
    const loop = fakeBrowser(() => ({ kind: "wait", phase: "x", ms: 1 }));
    expect(await runAction(loop.b, req())).toMatchObject({ ok: false, code: "unexpected_page", message: expect.stringMatching(/steps/) });
    const draft = fakeBrowser(() => ({ kind: "stop", code: "review_and_submit", message: "check it", keepTab: true }));
    expect(await runAction(draft.b, req({ action: "createListing", payload: { title: "x", price: 1 } }))).toMatchObject({ ok: false, code: "review_and_submit" });
    expect(draft.log.opened).toEqual(["https://poshmark.com/create-listing"]);
    expect(draft.log.closed).toEqual([]);
  });
});

// ---- worker against the real route functions on the mock store
function harness(svc: Services, steps: (url: string, phase: string) => StepResult) {
  let state = w.emptyState();
  let t = Date.now();
  const call = async (path: string, init: RequestInit) => {
    const token = String((init.headers as Record<string, string>).authorization ?? "").replace(/^Bearer /, "") || null;
    const body = JSON.parse(String(init.body));
    const ip = "1.1.1.1";
    let r;
    const m = /^\/api\/v1\/ext\/jobs\/([^/]+)\/(\w+)$/.exec(path);
    if (path === "/api/v1/ext/pair/complete") r = await extPairComplete(svc, body, ip);
    else if (path === "/api/v1/ext/poll") r = await extPoll(svc, token, body, ip);
    else if (path === "/api/v1/ext/scan/next") r = await extScanNext(svc, token, body, ip);
    else if (path === "/api/v1/ext/scan/report") r = await extScanReport(svc, token, body, ip);
    else if (path === "/api/v1/ext/scan/listings") r = await extListingsReport(svc, token, body, ip);
    else if (m) r = await extJob(svc, m[2] as "start", token, m[1], body, ip);
    else throw new Error(path);
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  const fb = fakeBrowser(steps);
  const deps: w.Deps = {
    api: makeApi("https://app.test", () => state.token, (u, i) => call(u.replace("https://app.test", ""), i)),
    browser: fb.b, now: () => t, rand: () => 0, version: "0.1.0",
    store: { load: async () => structuredClone(state), save: async (s) => { state = structuredClone(s); } },
  };
  return { deps, fb, get state() { return state; }, advance: (ms: number) => { t += ms; } };
}

describe("worker end to end on the mock API", () => {
  const setup = async () => {
    resetRateLimits();
    const env = backends.find((b) => b.name === "mock")!.make();
    const svc = await env.user(0);
    const item = await svc.store.items.create({ title: "Polo", sku: "1", status: "listed", askingPrice: 25 });
    const l = await svc.store.listings.upsert({ itemId: item.id, marketplace: "poshmark", externalId: ID, url: null, price: 25, status: "active", listedAt: null, endedAt: null, source: "manual" });
    const enqueue = () => svc.store.jobs.enqueue({ marketplace: "poshmark", jobType: "delist", executor: "extension", itemId: item.id, listingId: l.id, nextRunAt: new Date(Date.now() - 60_000).toISOString() });
    return { svc, l, enqueue };
  };
  it("pair, sign-in check, poll, run the delist, report success; the token never reaches the popup state", async () => {
    const { svc, l, enqueue } = await setup();
    const h = harness(svc, (u, phase) => (u.endsWith("/feed") ? { kind: "done", loggedIn: true } : phase === "start" ? { kind: "wait", phase: "saved", ms: 1 } : { kind: "done", result: { note: "Set to Not For Sale" } }));
    const code = String((await pairStart(svc)).body.code);
    await w.pair(h.deps, code, "Chrome on Mac");
    expect(h.state.token).toMatch(/^ssd_/);
    await w.checkLogin(h.deps, "poshmark");
    expect(h.state.logins.poshmark?.loggedIn).toBe(true);
    const { job } = await enqueue();
    h.advance(120_000);
    expect(await w.poll(h.deps)).toEqual({ ran: 1, notes: [] });
    expect((await svc.store.jobs.get(job.id))?.status).toBe("succeeded");
    expect((await svc.store.listings.list()).find((x) => x.id === l.id)?.status).toBe("ended");
    expect(h.fb.log.opened).toContain(`https://poshmark.com/edit-listing/${ID}`);
    const texts = h.state.log.map((x) => x.text);
    expect(texts).toContain("Poshmark: Running: Set Not For Sale");
    expect(texts).toContain("Poshmark: Succeeded: Set Not For Sale (Set to Not For Sale)");
    expect(texts).toContain("Poshmark: Succeeded: Check sign-in (signed in)");
  });
  it("regression (jobs stuck in queued): an unclear or failed sign-in check does not hold jobs back; only a definite sign-out does", async () => {
    const { svc, enqueue } = await setup();
    let feed: StepResult = { kind: "done", loggedIn: null };
    const h = harness(svc, (u, phase) => (u.endsWith("/feed") ? feed : phase === "start" ? { kind: "wait", phase: "saved", ms: 1 } : { kind: "done", result: { note: "ok" } }));
    await w.pair(h.deps, String((await pairStart(svc)).body.code), "x");
    // Never checked at all: still asks for jobs.
    const a = (await enqueue()).job;
    h.advance(120_000);
    expect(await w.poll(h.deps)).toMatchObject({ ran: 1 });
    expect((await svc.store.jobs.get(a.id))?.status).toBe("succeeded");
    // Checked, could not tell: not an error (no error-burst pause), still runs jobs.
    for (let i = 0; i < 4; i++) { h.advance(120_000); await w.checkLogin(h.deps, "poshmark"); }
    expect(h.state.logins.poshmark?.loggedIn).toBeNull();
    expect(h.state.pacing.mp.poshmark?.pausedUntil ?? 0).toBeLessThan(Date.now());
    const b = (await enqueue()).job;
    h.advance(120_000);
    expect(await w.poll(h.deps)).toMatchObject({ ran: 1 });
    expect((await svc.store.jobs.get(b.id))?.status).toBe("succeeded");
    // A check that errors (page did not answer) leaves the state alone and does not block either.
    feed = { kind: "stop", code: "unexpected_page", message: "The page did not answer" };
    h.advance(120_000); await w.checkLogin(h.deps, "poshmark");
    const c = (await enqueue()).job;
    h.advance(120_000);
    expect(await w.poll(h.deps)).toMatchObject({ ran: 1 });
    expect((await svc.store.jobs.get(c.id))?.status).toBe("succeeded");
    // Definitely signed out: holds jobs, and Check now says why.
    feed = { kind: "done", loggedIn: false };
    h.advance(120_000); await w.checkLogin(h.deps, "poshmark");
    const d = (await enqueue()).job;
    h.advance(120_000);
    expect(await w.poll(h.deps)).toEqual({ ran: 0, notes: ["Poshmark: signed out (sign in, then press Check sign-in)"] });
    expect((await svc.store.jobs.get(d.id))?.status).toBe("queued");
  });
  it("upgrade: an old error-burst pause is cleared once per version, your own pause is kept, and failed sign-in checks never pause again", async () => {
    const { svc, enqueue } = await setup();
    let feed: StepResult = { kind: "stop", code: "unexpected_page", message: "The page did not answer" };
    const h = harness(svc, (u, phase) => (u.endsWith("/feed") ? feed : phase === "start" ? { kind: "wait", phase: "saved", ms: 1 } : { kind: "done", result: { note: "ok" } }));
    await w.pair(h.deps, String((await pairStart(svc)).body.code), "x");
    for (let i = 0; i < 5; i++) { h.advance(120_000); await w.checkLogin(h.deps, "poshmark"); }
    expect(h.state.pacing.mp.poshmark?.errors ?? []).toEqual([]); // 3: a failed check is never an error
    expect(h.state.pacing.mp.poshmark?.pausedUntil ?? 0).toBe(0);
    // Simulate what 1.0.1 left behind: an error-burst pause, plus your own pause on another marketplace.
    const until = Date.now() + 3600_000;
    await h.deps.store.save({ ...h.state, upgradedTo: "1.0.1", pacing: { ...h.state.pacing, mp: { ...h.state.pacing.mp,
      poshmark: { ...h.state.pacing.mp.poshmark!, pausedUntil: until, pausedReason: "Paused for an hour after 3 errors in 15 minutes", errors: [1, 2] },
      depop: { ...h.state.pacing.mp.poshmark!, paused: true, pausedReason: "Paused by you" } } } });
    expect(await w.upgrade(h.deps)).toBe(true);
    expect(h.state.pacing.mp.poshmark).toMatchObject({ pausedUntil: 0, errors: [], pausedReason: null });
    expect(h.state.pacing.mp.depop).toMatchObject({ paused: true, pausedReason: "Paused by you" });
    expect(h.state.log[0].text).toMatch(/cleared the automatic error pause/);
    expect(await w.upgrade(h.deps)).toBe(false); // once per version
    feed = { kind: "done", loggedIn: true };
    const { job } = await enqueue();
    h.advance(120_000);
    expect(await w.poll(h.deps)).toMatchObject({ ran: 1 });
    expect((await svc.store.jobs.get(job.id))?.status).toBe("succeeded");
  });
  it("Resume clears an automatic pause too", async () => {
    const { svc } = await setup();
    const h = harness(svc, () => ({ kind: "done", loggedIn: true }));
    await h.deps.store.save({ ...h.state, pacing: { devicePaused: false, mp: { poshmark: { busy: false, busySince: null, nextAt: 0, day: "", counts: {}, errors: [], challengeStreak: 0,
      pausedUntil: Date.now() + 3600_000, paused: false, pausedReason: "Paused for an hour after 3 errors in 15 minutes" } } } });
    await w.pauseMarketplace(h.deps, "poshmark", false);
    expect(h.state.pacing.mp.poshmark).toMatchObject({ pausedUntil: 0, paused: false, pausedReason: null });
  });
  it("on a long break only a delist is handed out (urgentOnly); the quantity edit waits for the break", async () => {
    const { svc, l } = await setup();
    const h = harness(svc, (u, phase) => (u.endsWith("/feed") ? { kind: "done", loggedIn: true } : phase === "start" ? { kind: "wait", phase: "saved", ms: 1 } : { kind: "done", result: { note: "ok" } }));
    await w.pair(h.deps, String((await pairStart(svc)).body.code), "x");
    await h.deps.store.save({ ...h.state, pacing: { devicePaused: false, mp: { poshmark: { busy: false, busySince: null, nextAt: 0, day: "", counts: {}, errors: [], challengeStreak: 0,
      pausedUntil: 0, paused: false, pausedReason: null, breakUntil: Date.now() + 5 * 60_000, sinceBreak: 0, breakAfter: 6 } }, speed: { poshmark: "careful" } } });
    const past = new Date(Date.now() - 60_000).toISOString();
    const { job: edit } = await svc.store.jobs.enqueue({ marketplace: "poshmark", jobType: "update_listing", executor: "extension", listingId: l.id, itemId: l.itemId, payload: { quantity: 2 }, nextRunAt: past });
    const { job: del } = await svc.store.jobs.enqueue({ marketplace: "poshmark", jobType: "delist", executor: "extension", listingId: l.id, itemId: l.itemId, idempotencyKey: "d", nextRunAt: past });
    h.advance(1000);
    expect(await w.poll(h.deps)).toMatchObject({ ran: 1 });
    expect((await svc.store.jobs.get(del.id))?.status).toBe("succeeded");
    h.advance(60_000);
    expect(await w.poll(h.deps)).toMatchObject({ ran: 0, notes: [expect.stringMatching(/short break.*delists still go first/)] });
    expect((await svc.store.jobs.get(edit.id))?.status).toBe("queued");
    h.advance(6 * 60_000);
    expect(await w.poll(h.deps)).toMatchObject({ ran: 1 });
    expect((await svc.store.jobs.get(edit.id))?.status).toBe("succeeded");
  });
  it("1.0.4: after a job, the next poll can come 2-10 s later (back to back), not at the 5-minute alarm", async () => {
    const { svc, l } = await setup();
    const h = harness(svc, (u, phase) => (u.endsWith("/feed") ? { kind: "done", loggedIn: true } : phase === "start" ? { kind: "wait", phase: "saved", ms: 1 } : { kind: "done", result: { note: "ok" } }));
    await w.pair(h.deps, String((await pairStart(svc)).body.code), "x");
    const past = new Date(Date.now() - 60_000).toISOString();
    for (const k of ["a", "b", "c"]) await svc.store.jobs.enqueue({ marketplace: "poshmark", jobType: "delist", executor: "extension", listingId: l.id, itemId: l.itemId, idempotencyKey: k, nextRunAt: past });
    h.advance(1000);
    let ran = 0;
    for (let i = 0; i < 3; i++) {
      const r = await w.poll(h.deps);
      ran += "ran" in r ? r.ran : 0;
      const ms = await w.nextWakeMs(h.deps);
      expect(ms).toBeGreaterThanOrEqual(0); expect(ms).toBeLessThanOrEqual(10_000);
      h.advance(ms + 250);
    }
    expect(ran).toBe(3); // three delists in about half a minute
  });
  it("request transport first when it supports the action; 'shape changed' pauses that marketplace and fails the job (no tab opened)", async () => {
    const { svc, enqueue } = await setup();
    const h = harness(svc, (u) => (u.endsWith("/feed") ? { kind: "done", loggedIn: true } : { kind: "done", result: { note: "tab" } }));
    await w.pair(h.deps, String((await pairStart(svc)).body.code), "x");
    const ran: string[] = [];
    h.deps.transports = { poshmark: { name: "request", supports: (a) => a.action === "delist", run: async (a) => { ran.push(a.action); return { ok: false, code: "shape_changed", message: "Poshmark changed something, sync paused, update coming (nothing was changed: GET answered 410)" }; } } };
    const { job } = await enqueue();
    h.advance(1000);
    const opened = h.fb.log.opened.length;
    await w.poll(h.deps);
    expect(ran).toEqual(["delist"]);
    expect(h.fb.log.opened.length).toBe(opened); // no tab
    expect(h.state.pacing.mp.poshmark).toMatchObject({ paused: true, pausedReason: "Poshmark changed something, sync paused, update coming" });
    const j = await svc.store.jobs.get(job.id);
    expect(j).toMatchObject({ status: "failed", lastErrorCode: "shape_changed" });
    // paused: the next poll asks for nothing on Poshmark
    await enqueue();
    h.advance(60_000);
    expect(await w.poll(h.deps)).toMatchObject({ ran: 0, notes: [expect.stringMatching(/changed something/)] });
  });
  it("Check now says why nothing ran (waiting between jobs, paused here or on the website)", async () => {
    const { svc, enqueue } = await setup();
    const h = harness(svc, () => ({ kind: "done", loggedIn: true }));
    await w.pair(h.deps, String((await pairStart(svc)).body.code), "x");
    await w.checkLogin(h.deps, "poshmark");
    await enqueue();
    const r = await w.poll(h.deps) as { ran: number; notes: string[] };
    expect(r.ran).toBe(0);
    expect(r.notes).toEqual([expect.stringMatching(/^Poshmark: Waiting between jobs \(next action around \d{1,2}:\d{2}/)]);
    await w.pauseDevice(h.deps, true);
    expect(await w.poll(h.deps)).toEqual({ ran: 0, notes: ["This browser is paused"] });
  });
  it("kill switch: a paused browser claims nothing and opens nothing", async () => {
    const { svc, enqueue } = await setup();
    const h = harness(svc, () => ({ kind: "done", loggedIn: true }));
    await w.pair(h.deps, String((await pairStart(svc)).body.code), "x");
    await w.checkLogin(h.deps, "poshmark");
    const { job } = await enqueue();
    await w.pauseDevice(h.deps, true);
    h.advance(120_000);
    await w.poll(h.deps);
    expect((await svc.store.jobs.get(job.id))?.status).toBe("queued");
    await w.pauseDevice(h.deps, false);
    await w.pauseMarketplace(h.deps, "poshmark", true);
    await w.poll(h.deps);
    expect((await svc.store.jobs.get(job.id))?.status).toBe("queued");
    expect(h.fb.log.opened).toEqual(["https://poshmark.com/feed"]);
  });
  it("2 security checks in a row pause the marketplace here and on the server", async () => {
    const { svc, enqueue } = await setup();
    let captcha = false;
    const h = harness(svc, () => (captcha ? { kind: "stop", code: "captcha", message: "captcha", keepTab: true } : { kind: "done", loggedIn: true }));
    await w.pair(h.deps, String((await pairStart(svc)).body.code), "x");
    await w.checkLogin(h.deps, "poshmark");
    captcha = true;
    for (let i = 0; i < 2; i++) {
      const { job } = await enqueue();
      await svc.store.jobs.get(job.id);
      h.advance(120_000);
      await w.poll(h.deps);
      expect((await svc.store.jobs.get(job.id))?.status).toBe("needs_user");
    }
    expect(h.state.pacing.mp.poshmark?.paused).toBe(true);
    const states = await svc.store.devices.marketplaceState();
    expect(states.find((s) => s.marketplace === "poshmark")?.paused).toBe(true);
  });
  it("a revoked browser forgets its token", async () => {
    const { svc } = await setup();
    const h = harness(svc, () => ({ kind: "done", loggedIn: true }));
    const r = await w.pair(h.deps, String((await pairStart(svc)).body.code), "x");
    await svc.store.devices.revoke(r.deviceId);
    await w.poll(h.deps);
    expect(h.state.token).toBeNull();
  });
  it("sales scan: reports sales and the server queues delists", async () => {
    const { svc } = await setup();
    const item2 = await svc.store.items.create({ title: "Jeans", sku: "2", status: "listed" });
    await svc.store.listings.upsert({ itemId: item2.id, marketplace: "poshmark", externalId: "b".repeat(24), url: null, price: 30, status: "active", listedAt: null, endedAt: null, source: "manual" });
    await svc.store.listings.upsert({ itemId: item2.id, marketplace: "ebay", externalId: "e1", url: null, price: 30, status: "active", listedAt: null, endedAt: null, source: "manual" });
    const today = new Date().toISOString().slice(0, 10);
    const h = harness(svc, (u) => (u.endsWith("/feed") ? { kind: "done", loggedIn: true } : { kind: "done", loggedIn: true, sales: [{ orderId: "o1", soldAt: today, price: 30, externalListingId: "b".repeat(24) }], nextCursor: `${today}T00:00:00.000Z` }));
    await w.pair(h.deps, String((await pairStart(svc)).body.code), "x");
    await w.checkLogin(h.deps, "poshmark");
    h.advance(120_000);
    await w.scan(h.deps); // first: the daily listing scan
    expect(h.state.listingsScanAt?.poshmark).toBeTruthy();
    h.advance(120_000);
    await w.scan(h.deps); // then sales
    const jobs = await svc.store.jobs.list({});
    expect(jobs.some((j) => j.marketplace === "ebay")).toBe(true);
  });
  it("Scan sales now (popup): reads the sales page straight away, even when the daily listing scan is due, and says what it saw", async () => {
    const { svc } = await setup();
    const today = new Date().toISOString().slice(0, 10);
    const h = harness(svc, (u) => (u.endsWith("/feed") ? { kind: "done", loggedIn: true } : { kind: "done", loggedIn: true, sales: [{ orderId: "o9", soldAt: today, price: 5 }], nextCursor: null }));
    expect((await w.scan(h.deps, { salesOnly: true })).notes).toEqual(["Not paired"]);
    await w.pair(h.deps, String((await pairStart(svc)).body.code), "x");
    await w.checkLogin(h.deps, "poshmark");
    h.advance(120_000);
    const r = await w.scan(h.deps, { salesOnly: true });
    expect(h.state.listingsScanAt?.poshmark).toBeUndefined();
    expect(r.notes).toEqual(["Poshmark: Succeeded: Scan sales (saw 1 sale(s), 1 new, 0 delist(s) queued)"]);
    expect(h.state.log[0].text).toContain("Scan sales (saw 1");
    h.advance(120_000);
    expect((await w.scan(h.deps, { salesOnly: true })).notes[0]).toContain("0 new"); // no duplicates
  });
});
