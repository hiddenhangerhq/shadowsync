// The request transport (background calls with your own session) against a mocked fetch. No real marketplace is contacted.
import { describe, expect, it } from "vitest";
import { requestTransport, type Fetcher, type MarketplaceSpec } from "../extension/src/transport/request";
import { findPageToken, priceChangePlan, POSHMARK_REQUEST_SPEC, POSHMARK_BOOTSTRAP } from "../extension/src/transport/poshmark-request";
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
    if (url === POSHMARK_BOOTSTRAP.url) return res(200, o.token === null ? "<html>no token</html>" : `<html><head><meta name="csrf-token" content="${o.token ?? "tok-12345678"}"></head></html>`, "text/html");
    if (url === READ(ID)) return res(200, JSON.stringify(o.readShape === "bad" ? { data: { id: ID, cost: "x" } } : { data: { id: ID, price, title: "Black jeans", status: "available", extra: { ignored: true } } }));
    if (url === WRITE(ID)) { if (!o.ignoreWrite) price = JSON.parse(init.body!).price_amount.val; return res(o.writeStatus ?? 200, "{}"); }
    return res(404, "{}");
  };
  return { f, calls, get price() { return price; } };
}
const spec = (enabled = true): MarketplaceSpec => ({
  ...POSHMARK_REQUEST_SPEC, enabled,
  plans: { updateListing: priceChangePlan({ read: READ, write: WRITE, body: (_l, p) => ({ price_amount: { val: p } }) }) as never },
});
const a = (payload: Record<string, unknown> = { externalId: ID, price: 25 }): ActionRequest => ({ jobId: null, marketplace: "poshmark", action: "updateListing", payload });
const noSleep = async () => undefined;

describe("transport selection", () => {
  it("ships disabled: supports nothing, so every Poshmark action keeps using the tab", () => {
    const t = requestTransport(POSHMARK_REQUEST_SPEC, fakePosh().f);
    expect(t.supports(a())).toBe(false);
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
    expect(p.calls[2].headers["x-csrf-token"]).toBe("tok-12345678");
    expect(p.calls[1].headers["x-csrf-token"]).toBeUndefined(); // reads carry no token
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
    const evil = { ...spec(), plans: { updateListing: priceChangePlan({ read: () => "https://evil.example/x", write: WRITE, body: () => ({}) }) as never } };
    const p = fakePosh();
    expect(await requestTransport(evil, p.f, noSleep).run(a())).toMatchObject({ ok: false, code: "shape_changed" });
    expect(p.calls.some((c) => c.url.includes("evil"))).toBe(false);
  });
});

describe("page token bootstrap (stub until the recording)", () => {
  it("finds a csrf meta tag or an inline csrfToken; null otherwise", () => {
    expect(findPageToken('<meta name="csrf-token" content="abcDEF123456">')).toBe("abcDEF123456");
    expect(findPageToken('<meta content="abcDEF123456" name="csrf-token">')).toBe("abcDEF123456");
    expect(findPageToken('<script>window.x={"csrfToken":"Zz09-abc_123.4"}</script>')).toBe("Zz09-abc_123.4");
    expect(findPageToken("<html></html>")).toBeNull();
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
