// The request transport (background calls with your own session) against a mocked fetch. No real marketplace is contacted.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { requestTransport, retryAfterMs, type Fetcher, type MarketplaceSpec, type ReadPlan } from "../extension/src/transport/request";
import {
  findPageToken, pageAuth, parseListing, parseSalesJson, parseClosetPage, listingIdFromOrder, priceChangePlan,
  salesUrl, saleDetailUrl, closetUrl, editUrl, deleteUrl, editBody, bodyError,
  POSHMARK_REQUEST_SPEC, POSHMARK_BOOTSTRAP, FOR_SALE, NFS,
} from "../extension/src/transport/poshmark-request";
import { computeHealth } from "../src/lib/jobs/health";
import { isTestSku, requestWritesAllowed, emptyState } from "../extension/src/worker";
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
    if (url === POSHMARK_BOOTSTRAP.url || url === POSHMARK_BOOTSTRAP.fallbackUrl) {
      return res(200, o.token === null ? "<html>no token</html>" : `<html><head><meta data-vue-meta="1" id="csrftoken" content="${o.token ?? "tok-1234567890abcdef"}"></head></html>`, "text/html");
    }
    if (url === READ(ID)) return res(200, JSON.stringify(o.readShape === "bad" ? { data: { id: ID, cost: "x" } } : { data: { id: ID, price_amount: { val: `${price}.0` }, title: "Black jeans", inventory: { status: "available", multi_item: false }, extra: { ignored: true } } }));
    if (url === WRITE(ID)) { if (!o.ignoreWrite) price = JSON.parse(init.body!).price_amount.val; return res(o.writeStatus ?? 200, "{}"); }
    return res(404, "{}");
  };
  return { f, calls, get price() { return price; } };
}
const testRead: ReadPlan<ReturnType<typeof parseListing>> = { request: (c) => ({ method: "GET", url: READ(c.externalId!) }), parse: (b) => parseListing(b) };
const plan = (write = WRITE, read = testRead) => priceChangePlan({ url: write, body: (_l, p) => ({ price_amount: { val: p } }) }, read) as never;
const spec = (enabled = true): MarketplaceSpec => ({ ...POSHMARK_REQUEST_SPEC, enabled, plans: { updateListing: plan() }, flows: {}, reads: {} });
const a = (payload: Record<string, unknown> = { externalId: ID, price: 25 }): ActionRequest => ({ jobId: null, marketplace: "poshmark", action: "updateListing", payload });
const noSleep = async () => undefined;

describe("transport selection", () => {
  it("ships with reads + write plans; createListing still has no plan (tab)", () => {
    const t = requestTransport(POSHMARK_REQUEST_SPEC, fakePosh().f);
    expect(t.supports({ ...a(), action: "checkLogin", payload: {} })).toBe(true);
    expect(t.supports({ ...a(), action: "getSales", payload: {} })).toBe(true);
    expect(t.supports({ ...a(), action: "getListings", payload: {} })).toBe(true);
    expect(t.supports(a())).toBe(true); // updateListing
    expect(t.supports({ ...a(), action: "updateQuantity", payload: { externalId: ID, quantity: 2 } })).toBe(true);
    expect(t.supports({ ...a(), action: "delist", payload: { externalId: ID } })).toBe(true);
    expect(t.supports({ ...a(), action: "createListing", payload: { title: "x", price: 10 } })).toBe(false);
  });
  it("TEST-SKU gate: request writes only for SKUs starting with TEST (or when widened)", () => {
    expect(isTestSku("TEST-1")).toBe(true);
    expect(isTestSku("test jeans")).toBe(true);
    expect(isTestSku("JEANS-1")).toBe(false);
    const st = emptyState();
    expect(requestWritesAllowed(st, { ...a(), itemSku: "TEST-1" })).toBe(true);
    expect(requestWritesAllowed(st, { ...a(), itemSku: "JEANS-1" })).toBe(false);
    expect(requestWritesAllowed(st, { ...a(), action: "getSales", payload: {}, itemSku: "JEANS-1" })).toBe(true); // reads always
    expect(requestWritesAllowed({ ...st, requestWrites: "all" }, { ...a(), itemSku: "JEANS-1" })).toBe(true);
  });
});

describe("price change over requests (engine)", () => {
  it("bootstrap token -> read -> one write with the token, your session (credentials include) -> verify by GET", async () => {
    const p = fakePosh();
    const r = await requestTransport(spec(), p.f, noSleep).run(a());
    expect(r).toEqual({ ok: true, result: { note: "Price 20 -> 25 (checked)" } });
    expect(p.calls.map((c) => `${c.method} ${c.url.replace("https://poshmark.com", "")}`)).toEqual(["GET /feed", `GET /api/test/listing/${ID}`, `POST /api/test/listing/${ID}/update`, `GET /api/test/listing/${ID}`]);
    expect(p.calls.every((c) => c.credentials === "include")).toBe(true);
    expect(p.calls[2].headers["x-xsrf-token"]).toBe("tok-1234567890abcdef");
    expect(p.calls[1].headers["x-xsrf-token"]).toBe("tok-1234567890abcdef"); // Poshmark wants it on reads too
    expect(p.calls[0].headers["x-xsrf-token"]).toBeUndefined();
    expect(p.calls.some((c) => /cookie/i.test(Object.keys(c.headers).join(" ")))).toBe(false);
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
  it("no page token (feed + create-listing) -> shape changed, nothing written", async () => {
    const p = fakePosh({ token: null });
    expect(await requestTransport(spec(), p.f, noSleep).run(a())).toMatchObject({ ...shape, message: expect.stringMatching(/nothing was changed: no page token/) });
    expect(p.calls.map((c) => c.url)).toEqual([POSHMARK_BOOTSTRAP.url, POSHMARK_BOOTSTRAP.fallbackUrl]);
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
    expect(p.calls.filter((c) => c.method === "GET" && c.url === READ(ID))).toHaveLength(3);
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
  it("429 carries Retry-After (seconds) as retryAfterMs", async () => {
    const f: Fetcher = async (url) => {
      if (url === POSHMARK_BOOTSTRAP.url) return { status: 200, url, headers: { get: () => "text/html" }, text: async () => '<meta id="csrftoken" content="tok-1234567890abcdef">' };
      return { status: 429, url, headers: { get: (n) => (n === "retry-after" ? "120" : null) }, text: async () => "" };
    };
    expect(await requestTransport(spec(), f, noSleep).run(a())).toMatchObject({ ok: false, code: "rate_limited", retryAfterMs: 120_000 });
    expect(retryAfterMs("90")).toBe(90_000);
    expect(retryAfterMs(null)).toBeNull();
  });
  it("refuses any URL outside the marketplace's host table", async () => {
    const evil = { ...spec(), plans: { updateListing: plan(WRITE, { request: () => ({ method: "GET", url: "https://evil.example/x" }), parse: (b) => parseListing(b) }) } };
    const p = fakePosh();
    expect(await requestTransport(evil, p.f, noSleep).run(a())).toMatchObject({ ok: false, code: "shape_changed" });
    expect(p.calls.some((c) => c.url.includes("evil"))).toBe(false);
  });
  it("HTTP 200 with an error object in the body is not a success", () => {
    expect(bodyError({ error: { errorType: "AuthenticationError", statusCode: 401, userMessage: "Please log in" } })).toMatchObject({ code: "signed_out" });
    expect(bodyError({ error: { errorType: "NotFoundError", statusCode: 404 } })).toMatchObject({ code: "listing_not_found" });
    expect(bodyError({ error: { errorType: "WeirdError", userMessage: "nope" } })).toMatchObject({ code: "shape_changed", message: "nope" });
    expect(bodyError({ data: {} })).toBeNull();
  });
});

const fx = (n: string) => readFileSync(`tests/fixtures/poshmark/${n}`, "utf8");
const UIDF = "0123456789abcdef01234567", TOK = "00000000-1111-2222-3333-444444444444", POST = "fedcba9876543210fedcba98";

describe("from David's recording + REA notes (scrubbed / synthetic fixtures)", () => {
  it("page token + who you are come from /feed: <meta id=csrftoken>, auth.isUserLoggedIn / identity / dh", () => {
    const html = fx("har-feed.html");
    expect(findPageToken(html)).toBe(TOK);
    expect(pageAuth(html)).toEqual({ loggedIn: true, uid: UIDF, handle: "testcloset" });
    expect(findPageToken('<meta content="abcdef0123456789abcd" id="csrftoken">')).toBe("abcdef0123456789abcd");
    expect(findPageToken('<script>{"csrftoken":"abcdef0123456789abcd"}</script>')).toBe("abcdef0123456789abcd");
    expect(findPageToken("<html></html>")).toBeNull();
    expect(pageAuth('{"auth":{"isUserLoggedIn":false,"identity":null}}')).toEqual({ loggedIn: false, uid: null, handle: null });
    expect(pageAuth("<html></html>")).toEqual({ loggedIn: null, uid: null, handle: null });
  });
  it("GET /vm-rest/posts/<id> parses to price / title / status / multi item (+ raw for the write)", () => {
    const l = parseListing(JSON.parse(fx("har-post.json")));
    expect(l).toMatchObject({ id: POST, title: "TEST-1 Black jeans", price: 55, status: "available", multiItem: false });
    expect(l.raw?.id).toBe(POST);
    expect(l.sizes?.[0]?.quantity).toBe(1);
    expect(() => parseListing({ data: { id: POST, price: 55 } })).toThrow();
  });
  it("editBody sends back the fetched object with only the changed fields", () => {
    const l = parseListing(JSON.parse(fx("har-post.json")));
    const body = editBody(l, (post) => { (post.price_amount as { val: string }).val = "26.0"; post.price = 26; });
    expect(body.post.id).toBe(POST);
    expect((body.post.price_amount as { val: string }).val).toBe("26.0");
    expect(body.post.title).toBe("TEST-1 Black jeans");
    expect((l.raw!.price_amount as { val: string }).val).toBe("55.0"); // original untouched
  });
  it("the sales list parses; order detail maps parent_post_id -> listing id; closet page lists live ids", () => {
    const r = parseSalesJson(JSON.parse(fx("har-sales.json")));
    expect(r.more).toBe(true);
    expect(r.sales[0]).toEqual({ orderId: expect.stringMatching(/^[a-f0-9]{24}$/), soldAt: "2026-10-16", price: 20, fees: 4, title: "Sample Track Pants", externalListingId: null });
    expect(r.sales[2]).toMatchObject({ cancelled: true });
    expect(listingIdFromOrder(JSON.parse(fx("har-order.json")))).toBe(POST);
    expect(parseClosetPage(JSON.parse(fx("har-closet.json"))).ids).toEqual([POST, "111111111111111111111111"]);
  });

  type RecOpts = { feed?: string; feedStatus?: number; salesStatus?: number; salesBody?: string; orderBody?: string | null; closetBody?: string; post?: Record<string, unknown>; writeStatus?: number; deleteStatus?: number; finalUrl?: string; headers?: Record<string, string> };
  function recorded(o: RecOpts = {}) {
    const calls: Call[] = [];
    let post = o.post ?? JSON.parse(fx("har-post.json"));
    const res = (status: number, body: string, type: string, url = "", hdrs: Record<string, string> = {}) => ({ status, url, headers: { get: (n: string) => (n === "content-type" ? type : (hdrs[n] ?? o.headers?.[n] ?? null)) }, text: async () => body });
    const f: Fetcher = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers ?? {}, body: init.body, credentials: init.credentials });
      if (url === POSHMARK_BOOTSTRAP.url || url === POSHMARK_BOOTSTRAP.fallbackUrl) return res(o.feedStatus ?? 200, o.feed ?? fx("har-feed.html"), "text/html; charset=utf-8", o.finalUrl ?? url);
      if (url === salesUrl(UIDF)) return res(o.salesStatus ?? 200, o.salesBody ?? fx("har-sales.json"), "application/json");
      if (/\/orders\/sales\/[a-f0-9]{24}$/.test(url.split("?")[0])) {
        if (o.orderBody === null) return res(404, "{}", "application/json");
        return res(200, o.orderBody ?? fx("har-order.json"), "application/json");
      }
      if (url.startsWith(`https://poshmark.com/vm-rest/users/testcloset/posts/filtered`)) return res(200, o.closetBody ?? fx("har-closet.json"), "application/json");
      const postPath = `https://poshmark.com/vm-rest/posts/${POST}`;
      if (url.split("?")[0] === postPath && init.method === "GET") {
        if (!post) return res(404, "{}", "application/json");
        return res(200, JSON.stringify(post), "application/json");
      }
      if (url.split("?")[0] === postPath && init.method === "POST") {
        if (o.writeStatus && o.writeStatus >= 400) return res(o.writeStatus, JSON.stringify({ error: { errorType: "Bad", statusCode: o.writeStatus } }), "application/json");
        const body = JSON.parse(init.body!);
        post = { data: body.post, meta: {}, trace_id: "<TRACE>" };
        return res(200, JSON.stringify(post), "application/json");
      }
      if (url.split("?")[0] === postPath && init.method === "DELETE") {
        if (o.deleteStatus && o.deleteStatus >= 400) return res(o.deleteStatus, JSON.stringify({ error: { errorType: "ProductReservedError", statusCode: o.deleteStatus, userMessage: "reserved" } }), "application/json");
        post = null;
        return res(200, "{}", "application/json");
      }
      return res(404, "{}", "application/json");
    };
    return { f, calls, get post() { return post; }, setPost(p: Record<string, unknown>) { post = p; } };
  }
  const run = (f: Fetcher, action: ActionRequest["action"], payload: Record<string, unknown> = {}) =>
    requestTransport(POSHMARK_REQUEST_SPEC, f, noSleep).run({ jobId: null, marketplace: "poshmark", action, payload });

  it("checkLogin: one GET of /feed, no tab; signed in / signed out / can't tell", async () => {
    const p = recorded();
    expect(await run(p.f, "checkLogin")).toEqual({ ok: true, result: {}, loggedIn: true });
    expect(p.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET https://poshmark.com/feed"]);
    expect(await run(recorded({ feed: '<meta id="csrftoken" content="abcdef0123456789abcd"><script>{"auth":{"isUserLoggedIn":false}}</script>' }).f, "checkLogin")).toMatchObject({ ok: true, loggedIn: false });
    expect(await run(recorded({ finalUrl: "https://poshmark.com/login?pmrd=%2Ffeed" }).f, "checkLogin")).toMatchObject({ ok: true, loggedIn: false });
    expect(await run(recorded({ feed: "<html>new design</html>" }).f, "checkLogin")).toMatchObject({ ok: true, loggedIn: null });
  });
  it("getSales: list + order detail for listing id; cursor rule as the tab path", async () => {
    const p = recorded();
    const r = await run(p.f, "getSales", { cursor: "2026-10-01T00:00:00.000Z", limit: 50 });
    expect(r).toMatchObject({ ok: true, nextCursor: "2026-10-16T00:00:00.000Z" });
    expect(r.ok && r.sales!.map((s) => s.soldAt)).toEqual(["2026-10-15", "2026-10-16"]);
    expect(r.ok && r.sales!.every((s) => s.externalListingId === POST || s.cancelled)).toBe(true);
    expect(p.calls[0].url).toBe(POSHMARK_BOOTSTRAP.url);
    expect(p.calls[1].url).toBe(salesUrl(UIDF));
    expect(p.calls[1].headers["x-xsrf-token"]).toBe(TOK);
    expect(p.calls.filter((c) => /\/orders\/sales\/[a-f0-9]{24}$/.test(c.url.split("?")[0])).length).toBeGreaterThanOrEqual(1);
    expect(p.calls.every((c) => c.credentials === "include" && c.method === "GET")).toBe(true);
  });
  it("getSales trouble: signed out / 401 / bad shape / no token", async () => {
    expect(await run(recorded({ feed: '<meta id="csrftoken" content="abcdef0123456789abcd"><script>{"auth":{"isUserLoggedIn":false}}</script>' }).f, "getSales")).toMatchObject({ ok: false, code: "signed_out" });
    expect(await run(recorded({ salesStatus: 401 }).f, "getSales")).toMatchObject({ ok: false, code: "signed_out" });
    expect(await run(recorded({ salesBody: '{"data":{"orders":[]}}' }).f, "getSales")).toMatchObject({ ok: false, code: "shape_changed" });
    // no token on feed OR create-listing
    expect(await run(recorded({ feed: "<html>no token</html>" }).f, "getSales")).toMatchObject({ ok: false, code: "shape_changed" });
  });
  it("getListings: closet filtered endpoint, no tab", async () => {
    const p = recorded();
    const r = await run(p.f, "getListings", {});
    expect(r).toMatchObject({ ok: true, listingIds: [POST, "111111111111111111111111"] });
    expect(p.calls[1].url).toContain("/posts/filtered");
    expect(decodeURIComponent(p.calls[1].url)).toContain("available");
  });
  it("updateListing price: GET post -> POST {post} with new price -> verify GET", async () => {
    const p = recorded();
    const r = await run(p.f, "updateListing", { externalId: POST, price: 26 });
    expect(r).toEqual({ ok: true, result: { note: "Price 55 -> 26 (checked)" } });
    const postCall = p.calls.find((c) => c.method === "POST")!;
    expect(postCall.url).toBe(editUrl(POST));
    expect(JSON.parse(postCall.body!).post.price_amount.val).toBe("26.0");
    expect(JSON.parse(postCall.body!).post.title).toBe("TEST-1 Black jeans");
    expect(p.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
  it("updateListing Not For Sale / For Sale; already done short-circuits", async () => {
    const p = recorded();
    expect(await run(p.f, "updateListing", { externalId: POST, availability: "not_for_sale" })).toMatchObject({ ok: true, result: { note: expect.stringMatching(/Not For Sale/) } });
    expect((p.post as { data: { inventory: { status: string } } }).data.inventory.status).toBe(NFS);
    expect(await run(p.f, "updateListing", { externalId: POST, availability: "not_for_sale" })).toMatchObject({ ok: true, result: { alreadyDone: true } });
    expect(await run(p.f, "updateListing", { externalId: POST, availability: "for_sale" })).toMatchObject({ ok: true, result: { note: expect.stringMatching(/For Sale/) } });
    expect((p.post as { data: { inventory: { status: string } } }).data.inventory.status).toBe(FOR_SALE);
  });
  it("updateQuantity: Multi Item ok; Single Item quantity ≠ 1 refused with a clear message", async () => {
    const multi = JSON.parse(fx("har-post.json"));
    multi.data.inventory.multi_item = true;
    multi.data.inventory.size_quantities[0].quantity_available = 2;
    const p = recorded({ post: multi });
    expect(await run(p.f, "updateQuantity", { externalId: POST, quantity: 3 })).toMatchObject({ ok: true, result: { note: "Quantity -> 3 (checked)" } });
    const single = recorded();
    expect(await run(single.f, "updateQuantity", { externalId: POST, quantity: 2 })).toMatchObject({ ok: false, code: "unexpected_page", message: expect.stringMatching(/Single Item/) });
    expect(single.calls.some((c) => c.method === "POST")).toBe(false);
  });
  it("delist delete: DELETE then verify gone; delete refused -> Not For Sale fallback (exactly two writes max)", async () => {
    const ok = recorded();
    expect(await run(ok.f, "delist", { externalId: POST, mode: "delete" })).toMatchObject({ ok: true, result: { note: "Deleted (checked)" } });
    expect(ok.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(ok.calls.some((c) => c.method === "POST")).toBe(false);

    const fallback = recorded({ deleteStatus: 400 });
    const r = await run(fallback.f, "delist", { externalId: POST, mode: "delete" });
    expect(r).toMatchObject({ ok: true, result: { note: expect.stringMatching(/Not For Sale/) } });
    expect(fallback.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(fallback.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect((fallback.post as { data: { inventory: { status: string } } }).data.inventory.status).toBe(NFS);
  });
  it("delist Not For Sale mode; verify failure -> shape_changed after exactly one write", async () => {
    const p = recorded();
    expect(await run(p.f, "delist", { externalId: POST, mode: "not_for_sale" })).toMatchObject({ ok: true, result: { note: "Not For Sale (checked)" } });
    // Write "succeeds" but status never changes: shape_changed
    const stuck = recorded();
    const orig = stuck.post;
    const f: Fetcher = async (url, init) => {
      if (init.method === "POST") {
        // accept write but don't change stored post
        return { status: 200, url, headers: { get: () => "application/json" }, text: async () => JSON.stringify(orig) };
      }
      return stuck.f(url, init);
    };
    expect(await run(f, "delist", { externalId: POST, mode: "not_for_sale" })).toMatchObject({ ok: false, code: "shape_changed", message: expect.stringMatching(/after a save/) });
  });
  it("a 200 body error on write -> shape_changed, one write only", async () => {
    const p = recorded();
    const f: Fetcher = async (url, init) => {
      if (init.method === "POST") return { status: 200, url, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ error: { errorType: "WeirdError", userMessage: "nope" } }) };
      return p.f(url, init);
    };
    expect(await run(f, "updateListing", { externalId: POST, price: 26 })).toMatchObject({ ok: false, code: "shape_changed", message: expect.stringMatching(/nope/) });
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
