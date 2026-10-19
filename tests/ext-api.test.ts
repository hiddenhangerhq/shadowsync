// /api/v1/ext/* (device token) and /api/v1/extension/* (dashboard session) route functions over the mock store.
import { beforeEach, describe, expect, it } from "vitest";
import { backends } from "./helpers";
import { devicePause, deviceRevoke, extJob, extPairComplete, extPoll, extScanNext, extScanReport, marketplacePause, pairStart, readJson } from "../src/lib/ext/api";
import { resetRateLimits } from "../src/lib/ext/ratelimit";
import { newDeviceToken } from "../src/lib/ext/tokens";

const mock = backends.find((b) => b.name === "mock")!;
const V = { extensionVersion: "0.1.0" };
const UUID = "11111111-1111-4111-8111-111111111111";
beforeEach(() => resetRateLimits());

async function paired() {
  const env = mock.make();
  const svc = await env.user(0);
  const start = await pairStart(svc);
  const r = await extPairComplete(env.client(), { code: start.body.code, label: "Edge on Windows", ...V }, "1.2.3.4");
  return { env, svc, start, r, token: String(r.body.token) };
}

describe("pairing", () => {
  it("a signed-in user gets a 5-minute code; the extension trades it once for a token", async () => {
    const { start, r, env, token } = await paired();
    expect(start.status).toBe(201);
    expect(start.body.code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    expect(Date.parse(String(start.body.expiresAt)) - Date.now()).toBeLessThanOrEqual(5 * 60_000 + 1000);
    expect(r.status).toBe(201);
    expect(token).toMatch(/^ssd_[A-Za-z0-9_-]{43}$/);
    const again = await extPairComplete(env.client(), { code: start.body.code, ...V }, "1.2.3.4");
    expect(again).toMatchObject({ status: 400, body: { code: "pairing_invalid" } });
  });
  it("bad bodies, wrong codes and floods", async () => {
    const env = mock.make();
    const c = env.client();
    expect((await extPairComplete(c, { code: "ABCD-EFGH", ...V, admin: true }, "9.9.9.9")).status).toBe(400);
    expect((await extPairComplete(c, { code: "ABCD-EFGH" }, "9.9.9.9")).status).toBe(400);
    expect((await extPairComplete(c, { code: "ABCD-EFGH", ...V }, "9.9.9.9")).body.code).toBe("pairing_invalid");
    let last;
    for (let i = 0; i < 12; i++) last = await extPairComplete(c, { code: "ABCD-EFGH", ...V }, "8.8.8.8");
    expect(last).toMatchObject({ status: 429 });
  });
});

describe("device endpoints", () => {
  it("need a valid device token", async () => {
    const { env, token } = await paired();
    const c = env.client();
    for (const t of [null, "nope", newDeviceToken()]) {
      expect((await extPoll(c, t, V, "1.1.1.1")).status).toBe(401);
      expect((await extScanNext(c, t, { marketplace: "poshmark" }, "1.1.1.1")).status).toBe(401);
      expect((await extJob(c, "start", t, UUID, {}, "1.1.1.1")).status).toBe(401);
    }
    expect((await extPoll(c, token, V, "1.1.1.1")).status).toBe(200);
  });
  it("validate payloads strictly", async () => {
    const { env, token } = await paired();
    const c = env.client();
    expect(await extPoll(c, token, { ...V, run: "x" }, "1.1.1.1")).toMatchObject({ status: 400, body: { code: "invalid_payload" } });
    expect((await extPoll(c, token, { extensionVersion: "latest" }, "1.1.1.1")).status).toBe(400);
    expect((await extPoll(c, token, { ...V, limit: 50 }, "1.1.1.1")).status).toBe(400);
    expect((await extScanNext(c, token, { marketplace: "ebay" }, "1.1.1.1")).status).toBe(400);
    expect((await extScanReport(c, token, { marketplace: "poshmark", sales: [{ orderId: "1", soldAt: "yesterday", price: 1 }], nextCursor: null }, "1.1.1.1")).status).toBe(400);
    expect((await extJob(c, "result", token, UUID, { ok: false, code: "made_up" }, "1.1.1.1")).status).toBe(400);
    expect((await extJob(c, "start", token, "../../x", {}, "1.1.1.1")).status).toBe(404);
    expect((await extJob(c, "start", token, UUID, {}, "1.1.1.1")).status).toBe(404);
  });
  it("paused and revoked devices", async () => {
    const { env, svc, r, token } = await paired();
    const id = String(r.body.deviceId);
    expect((await devicePause(svc, id, { paused: true })).status).toBe(200);
    const p = await extPoll(env.client(), token, V, "1.1.1.1");
    expect(p.status).toBe(200);
    expect((p.body.device as { paused: boolean }).paused).toBe(true);
    expect((await deviceRevoke(svc, id)).status).toBe(200);
    expect((await extPoll(env.client(), token, V, "1.1.1.1")).status).toBe(401);
  });
  it("oversized bodies are refused before parsing", async () => {
    const big = new Request("https://x/api", { method: "POST", body: "x".repeat(300 * 1024), headers: { "content-type": "application/json" } });
    expect(await readJson(big)).toMatchObject({ ok: false, result: { status: 413 } });
  });
});

describe("dashboard endpoints", () => {
  it("answer 401 when signed out, and a device token is not a session", async () => {
    const { env, r } = await paired();
    const c = env.client();
    const id = String(r.body.deviceId);
    for (const res of [await pairStart(c), await devicePause(c, id, { paused: true }), await deviceRevoke(c, id), await marketplacePause(c, id, "poshmark", { paused: true })]) {
      expect(res.status).toBe(401);
    }
  });
  it("validate ids and bodies; another user's device is not found", async () => {
    const { env, svc, r } = await paired();
    const id = String(r.body.deviceId);
    expect((await devicePause(svc, "x", { paused: true })).status).toBe(404);
    expect((await devicePause(svc, id, { paused: "yes" })).status).toBe(400);
    expect((await marketplacePause(svc, id, "myspace", { paused: true })).status).toBe(400);
    expect((await marketplacePause(svc, id, "poshmark", { paused: true })).status).toBe(200);
    const other = await env.user(1);
    expect((await devicePause(other, id, { paused: true })).status).toBe(404);
    expect((await deviceRevoke(other, id)).status).toBe(404);
  });
});
