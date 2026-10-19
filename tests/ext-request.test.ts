// The request transport (background calls with your own session) against a mocked fetch. No real marketplace is contacted.
import { describe, expect, it } from "vitest";
import { requestTransport, type Fetcher, type MarketplaceSpec } from "../extension/src/transport/request";
import { readFileSync } from "node:fs";
import { findPageToken, pageAuth, parseListing, parseSalesJson, priceChangePlan, salesUrl, POSHMARK_REQUEST_SPEC, POSHMARK_BOOTSTRAP } from "../extension/src/transport/poshmark-request";
import type { ReadPlan } from "../extension/src/transport/request";
import { computeHealth } from "../src/lib/jobs/health";
import type { ActionRequest } from "../src/lib/ext/protocol";
import type { Job } from "../src/lib/data/types";

const ID = "a1b2c3d4e5f6a1b2c3d4e5f6";
const READ = (id: string) => `https://poshmark.com/api/test/listing/${id}`;
const WRITE = (id: string) => `https://poshmark.com/api/test/listing/${id}/update`;
type Call = { url: string; method: string; headers: Record<string, string>; body?: string; credentials: string };

/** A pretend Poshmark: a listing with a price, a page with a token, and switches to misbehave. */
function fakePosh(o: { price?: number; token?: string | null; readShape?: "ok" | "bad"; writeStatus?: number; ignoreWrite?: boolean; status?: Record<string, number> } = {}) {
  let price = o.price ?? 20;
  const calls: Call[] = [];
  const res = (status: number, body: string, type = "application/json", url = "") => ({ status, url, headers: { get: (n: string) => (n === "content-type" ? type : null) }, text: async () => body });
  const f: Fetcher = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers ?? {}, body: init.body, credentials: init.credentials });
    if (o.status?.[url]) return res(o.status[url], "{}");
    if (url === POSHMARK_BOOTSTRAP.url) return res(200, o.token === null ? "<html>no token</html>" : `<html><head><meta data-vue-meta="1" id="csrftoken" content="${o.token ?? "tok-1234567890abcdef"}"></head></html>`, "text/html");
    if (url === READ(ID)) return res(200, JSON.stringify(o.readShape === "bad" ? { data: { id: ID, cost: "x" } } : { data: { id: ID, price_amount: { val: `${price}.0` }, title: "Black jeans", inventory: { status: "available", multi_item: false }, extra: { ignored: true } } }));
    if (url === WRITE(ID)) { if (!o.ignoreWrite) price = JSON.parse(init.body!).price_amount.val; return res(o.writeStatus ?? 200, "{}"); }
    return res(404, "{}");
  };
  return { f, calls, get price() { return price; } };
}
// The write is NOT known yet (not in the recording), so these engine tests use a pretend endpoint pair.
const testRead: ReadPlan<ReturnType<typeof parseListing>> = { request: (c) => ({ method: "GET", url: READ(c.externalId!) }), parse: (b) => parseListing(b) };
const plan = (write = WRITE, read = testRead) => priceChangePlan({ url: write, body: (_l, p) => ({ price_amount: { val: p } }) }, read) as never;
const spec = (enabled = true): MarketplaceSpec => ({ ...POSHMARK_REQUEST_SPEC, enabled, plans: { updateListing: plan() } });
const a = (payload: Record<string, unknown> = { externalId: ID, price: 25 }): ActionRequest => ({ jobId: null, marketplace: "poshmark", action: "updateListing", payload });
const noSleep = async () => undefined;

describe("transport selection", () => {
  it("ships with reads only: sign-in check and sales scan over requests; every listing change keeps using the tab", () => {
    const t = requestTransport(POSHMARK_REQUEST_SPEC, fakePosh().f);
    expect(t.supports(a())).toBe(false);
    for (const action of ["delist", "updateQuantity", "markSold", "createListing", "getListings"] as const) expect(t.supports({ ...a(), action })).toBe(false);
    expect(t.supports({ ...a(), action: "checkLogin", payload: {} })).toBe(true);
    expect(t.supports({ ...a(), action: "getSales", payload: {} })).toBe(true);
    expect(requestTransport(spec(false), fakePosh().f).supports(a())).toBe(false);
    const on = requestTransport(spec(), fakePosh().f);
    expect(on.supports(a())).toBe(true);
    expect(on.supports({ ...a(), action: "delist" })).toBe(false); // no plan -> tab
  });
});

describe("price change over requests", () => {
  it("bootstrap token -> read -> one write with the token, your session (credentials include) -> verify by GET", async () => {
    const p = fakePosh();
    const r = await requestTransport(spec(), p.f, noSleep).run(a());
    expect(r).toEqual({ ok: true, result: { note: "Price 20 -> 25 (checked)" } });
    expect(p.calls.map((c) => `${c.method} ${c.url.replace("https://poshmark.com", "")}`)).toEqual(["GET /feed", `GET /api/test/listing/${ID}`, `POST /api/test/listing/${ID}/update`, `GET /api/test/listing/${ID}`]);
    expect(p.calls.every((c) => c.credentials === "include")).toBe(true);
    expect(p.calls[2].headers["x-xsrf-token"]).toBe("tok-1234567890abcdef");
    expect(p.calls[1].headers["x-xsrf-token"]).toBe("tok-1234567890abcdef"); // Poshmark wants it on reads too
    expect(p.calls[0].headers["x-xsrf-token"]).toBeUndefined(); // not on the page we read it from
    expect(p.calls.some((c) => /cookie/i.test(Object.keys(c.headers).join(" ")))).toBe(false); // we never set or read cookies
  });
  it("already that price: done, nothing written", async () => {
    const p = fakePosh({ price: 25 });
    expect(await requestTransport(spec(), p.f, noSleep).run(a())).toMatchObject({ ok: true, result: { alreadyDone: true } });
    expect(p.calls.some((c) => c.method !== "GET")).toBe(false);
  });
  it("bad price or extra fields: refused before any request", async () => {
    const p = fakePosh();
    expect(await requestTransport(spec(), p.f, noSleep).run(a({ externalId: ID, price: 2 }))).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(await requestTransport(spec(), p.f, noSleep).run(a({ externalId: ID, price: 25, title: "x" }))).toMatchObject({ ok: false, code: "not_supported" });
    expect(p.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});

describe("'shape changed' detector: pause, never a half-done write", () => {
  const shape = { ok: false, code: "shape_changed", message: expect.stringMatching(/^Poshmark changed something, sync paused, update coming/) };
  it("no page token -> shape changed, nothing written", async () => {
    const p = fakePosh({ token: null });
    expect(await requestTransport(spec(), p.f, noSleep).run(a())).toMatchObject({ ...shape, message: expect.stringMatching(/nothing was changed: no page token/) });
    expect(p.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
  it("a read with an unexpected shape -> shape changed before any write", async () => {
    const p = fakePosh({ readShape: "bad" });
    expect(await requestTransport(spec(), p.f, noSleep).run(a())).toMatchObject({ ...shape, message: expect.stringMatching(/nothing was changed: unexpected answer/) });
    expect(p.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
  it("an unexpected status on the write (e.g. 400 / 410) -> shape changed, exactly one write attempted", async () => {
    const p = fakePosh({ writeStatus: 410 });
    expect(await requestTransport(spec(), p.f, noSleep).run(a())).toMatchObject(shape);
    expect(p.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
  it("write said OK but the fresh GET does not show it (twice) -> shape changed, flagged 'after a save; please check'", async () => {
    const p = fakePosh({ ignoreWrite: true });
    const r = await requestTransport(spec(), p.f, noSleep).run(a());
    expect(r).toMatchObject({ ...shape, message: expect.stringMatching(/after a save; please check the listing/) });
    expect(p.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(p.calls.filter((c) => c.method === "GET" && c.url === READ(ID))).toHaveLength(3); // read, verify, verify again
  });
  it("ordinary trouble keeps its own meaning: 401 signed out, 429 slow down, 5xx retry, 404 not found, network error", async () => {
    const run = (status: number) => requestTransport(spec(), fakePosh({ status: { [READ(ID)]: status } }).f, noSleep).run(a());
    expect(await run(401)).toMatchObject({ ok: false, code: "signed_out" });
    expect(await run(429)).toMatchObject({ ok: false, code: "rate_limited" });
    expect(await run(503)).toMatchObject({ ok: false, code: "unavailable" });
    expect(await run(404)).toMatchObject({ ok: false, code: "listing_not_found" });
    const down: Fetcher = async () => { throw new TypeError("Failed to fetch"); };
    expect(await requestTransport(spec(), down, noSleep).run(a())).toMatchObject({ ok: false, code: "network" });
  });
  it("refuses any URL outside the marketplace's host table", async () => {
    const evil = { ...spec(), plans: { updateListing: plan(WRITE, { request: () => ({ method: "GET", url: "https://evil.example/x" }), parse: (b) => parseListing(b) }) } };
    const p = fakePosh();
    expect(await requestTransport(evil, p.f, noSleep).run(a())).toMatchObject({ ok: false, code: "shape_changed" });
    expect(p.calls.some((c) => c.url.includes("evil"))).toBe(false);
  });
});

const fx = (n: string) => readFileSync(`tests/fixtures/poshmark/${n}`, "utf8");
const UIDF = "0123456789abcdef01234567", TOK = "00000000-1111-2222-3333-444444444444";

describe("from David's recording (scrubbed fixtures)", () => {
  it("page token + who you are come from /feed: <meta id=csrftoken>, auth.isUserLoggedIn / identity", () => {
    const html = fx("har-feed.html");
    expect(findPageToken(html)).toBe(TOK);
    expect(pageAuth(html)).toEqual({ loggedIn: true, uid: UIDF });
    expect(findPageToken('<meta content="abcdef0123456789abcd" id="csrftoken">')).toBe("abcdef0123456789abcd");
    expect(findPageToken('<script>{"csrftoken":"abcdef0123456789abcd"}</script>')).toBe("abcdef0123456789abcd");
    expect(findPageToken("<html></html>")).toBeNull();
    expect(pageAuth('{"auth":{"isUserLoggedIn":false,"identity":null}}')).toEqual({ loggedIn: false, uid: null });
    expect(pageAuth("<html></html>")).toEqual({ loggedIn: null, uid: null });
  });
  it("GET /vm-rest/posts/<id> parses to price / title / status / multi item", () => {
    expect(parseListing(JSON.parse(fx("har-post.json")))).toEqual({ id: "fedcba9876543210fedcba98", title: "TEST-1 Black jeans", price: 55, status: "available", multiItem: false });
    expect(() => parseListing({ data: { id: "fedcba9876543210fedcba98", price: 55 } })).toThrow();
  });
  it("the sales list parses to sales (fees = price - your earnings; cancelled flagged; no listing id in this list)", () => {
    const r = parseSalesJson(JSON.parse(fx("har-sales.json")));
    expect(r.more).toBe(true);
    expect(r.sales).toHaveLength(3);
    expect(r.sales[0]).toEqual({ orderId: expect.stringMatching(/^[a-f0-9]{24}$/), soldAt: "2026-10-16", price: 20, fees: 4, title: "Sample Track Pants", externalListingId: null });
    expect(r.sales[2]).toMatchObject({ soldAt: "2026-06-26", price: 25, cancelled: true });
    expect(() => parseSalesJson({ data: { orders: [] } })).toThrow();
    expect(() => parseSalesJson({ data: { sales_summary: [{ id: "x1234", state: "s" }] } })).toThrow();
  });

  /** Poshmark as recorded: /feed page, the sales list, the post. */
  function recorded(o: { feed?: string; feedStatus?: number; salesStatus?: number; salesBody?: string; finalUrl?: string } = {}) {
    const calls: Call[] = [];
    const res = (status: number, body: string, type: string, url = "") => ({ status, url, headers: { get: (n: string) => (n === "content-type" ? type : null) }, text: async () => body });
    const f: Fetcher = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers ?? {}, body: init.body, credentials: init.credentials, redirect: init.redirect } as Call);
      if (url === POSHMARK_BOOTSTRAP.url) return res(o.feedStatus ?? 200, o.feed ?? fx("har-feed.html"), "text/html; charset=utf-8", o.finalUrl ?? url);
      if (url === salesUrl(UIDF)) return res(o.salesStatus ?? 200, o.salesBody ?? fx("har-sales.json"), "application/json; charset=utf-8", url);
      return res(404, "{}", "application/json");
    };
    return { f, calls };
  }
  const run = (f: Fetcher, action: "checkLogin" | "getSales", payload: Record<string, unknown> = {}) =>
    requestTransport(POSHMARK_REQUEST_SPEC, f, noSleep).run({ jobId: null, marketplace: "poshmark", action, payload });

  it("checkLogin: one GET of /feed, no tab; signed in / signed out / can't tell", async () => {
    const p = recorded();
    expect(await run(p.f, "checkLogin")).toEqual({ ok: true, result: {}, loggedIn: true });
    expect(p.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET https://poshmark.com/feed"]);
    expect(await run(recorded({ feed: '<meta id="csrftoken" content="abcdef0123456789abcd"><script>{"auth":{"isUserLoggedIn":false}}</script>' }).f, "checkLogin")).toMatchObject({ ok: true, loggedIn: false });
    expect(await run(recorded({ finalUrl: "https://poshmark.com/login?pmrd=%2Ffeed" }).f, "checkLogin")).toMatchObject({ ok: true, loggedIn: false });
    expect(await run(recorded({ feed: "<html>new design</html>" }).f, "checkLogin")).toMatchObject({ ok: true, loggedIn: null });
  });
  it("getSales: /feed for the token + your id, then ONE GET of the sales list with x-xsrf-token; cursor rule as the tab path", async () => {
    const p = recorded();
    const r = await run(p.f, "getSales", { cursor: "2026-10-01T00:00:00.000Z", limit: 50 });
    expect(r).toMatchObject({ ok: true, nextCursor: "2026-10-16T00:00:00.000Z" });
    expect(r.ok && r.sales!.map((s) => s.soldAt)).toEqual(["2026-10-15", "2026-10-16"]);
    expect(p.calls.map((c) => c.url)).toEqual([POSHMARK_BOOTSTRAP.url, salesUrl(UIDF)]);
    expect(p.calls[1].headers["x-xsrf-token"]).toBe(TOK);
    expect(decodeURIComponent(p.calls[1].url)).toContain('request={"filters":{},"count":100}');
    expect(p.calls.every((c) => c.credentials === "include" && c.method === "GET")).toBe(true);
    expect(p.calls.some((c) => Object.keys(c.headers).some((h) => /cookie/i.test(h)))).toBe(false);
  });
  it("getSales trouble: signed out page -> signed_out; 401 -> signed_out; new JSON shape -> shape_changed (worker falls back to the tab)", async () => {
    expect(await run(recorded({ feed: '<meta id="csrftoken" content="abcdef0123456789abcd"><script>{"auth":{"isUserLoggedIn":false}}</script>' }).f, "getSales")).toMatchObject({ ok: false, code: "signed_out" });
    expect(await run(recorded({ salesStatus: 401 }).f, "getSales")).toMatchObject({ ok: false, code: "signed_out" });
    expect(await run(recorded({ salesBody: '{"data":{"orders":[]}}' }).f, "getSales")).toMatchObject({ ok: false, code: "shape_changed" });
    expect(await run(recorded({ feed: "<html>no token</html>" }).f, "getSales")).toMatchObject({ ok: false, code: "shape_changed" });
  });
});

describe("dashboard alert", () => {
  const job = (o: Partial<Job>) => ({ id: "1", marketplace: "poshmark", executor: "extension", status: "failed", lastErrorCode: null, createdAt: "2026-10-19T10:00:00Z", finishedAt: "2026-10-19T10:00:05Z", ...o }) as Job;
  const health = (jobs: Job[]) => computeHealth({ now: new Date("2026-10-19T11:00:00Z"), devices: [], marketplaceState: [], jobs, cursors: [], needsAction: [], workerLastRunAt: null } as never);
  it("'Poshmark changed something, sync paused, update coming' until a Poshmark job succeeds again", () => {
    const hit = job({ lastErrorCode: "shape_changed" });
    expect(health([hit]).items.find((i) => i.key === "shape:poshmark")).toMatchObject({ level: "red", title: "Poshmark changed something, sync paused, update coming" });
    expect(health([hit, job({ id: "2", status: "succeeded", finishedAt: "2026-10-19T10:30:00Z" })]).items.some((i) => i.key === "shape:poshmark")).toBe(false);
    expect(health([job({ lastErrorCode: "timeout" })]).items.some((i) => i.key.startsWith("shape:"))).toBe(false);
  });
});
