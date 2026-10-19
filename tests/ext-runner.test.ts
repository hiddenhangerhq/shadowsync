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
    expect(await w.poll(h.deps)).toEqual({ ran: 1 });
    expect((await svc.store.jobs.get(job.id))?.status).toBe("succeeded");
    expect((await svc.store.listings.list()).find((x) => x.id === l.id)?.status).toBe("ended");
    expect(h.fb.log.opened).toContain(`https://poshmark.com/edit-listing/${ID}`);
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
    expect(r.notes).toEqual(["Poshmark: sales scan saw 1 sale(s), 1 new, 0 delist(s) queued"]);
    expect(h.state.log[0].text).toContain("sales scan saw 1");
    h.advance(120_000);
    expect((await w.scan(h.deps, { salesOnly: true })).notes[0]).toContain("0 new"); // no duplicates
  });
});
