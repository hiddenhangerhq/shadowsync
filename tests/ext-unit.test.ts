// Extension gatekeeper, pacing / kill switch, manifest permissions, pairing codes + tokens, and SQL vs TS outcome-code parity.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseExternal, parseInternal, validateAction } from "../extension/src/handler";
import * as P from "../extension/src/pacing";
import { buildManifest, apiOriginFrom } from "../extension/src/manifest";
import { HOST_TABLE, isAllowedUrl, marketplaceOfUrl } from "../src/lib/ext/protocol";
import { formatPairingCode, isDeviceToken, newDeviceToken, newPairingCode, normalizePairingCode, sha256Hex } from "../src/lib/ext/tokens";
import { CHALLENGE_CODES, NEEDS_USER_CODES, TRANSIENT_CODES } from "../src/lib/jobs/state-machine";

const cfg = { apiOrigin: "https://shadowsync-ruby.vercel.app", extensionId: "abcdefghijklmnopabcdefghijklmnop" };
const page = { url: "https://shadowsync-ruby.vercel.app/settings/extension" };
const popup = { id: cfg.extensionId, url: `chrome-extension://${cfg.extensionId}/popup.html` };
const ID = "a1b2c3d4e5f6a1b2c3d4e5f6";
const job = (o: Record<string, unknown> = {}) => ({ jobId: "11111111-1111-4111-8111-111111111111", marketplace: "poshmark", action: "delist", payload: { externalId: ID }, leaseExpiresAt: null, attempt: 0, ...o });

describe("message allow-list", () => {
  it("web pages: only our origin, only pair / status / read-only checkLogin", () => {
    expect(parseExternal({ type: "pair", code: "ABCD-EFGH" }, page, cfg)).toEqual({ ok: true, req: { type: "pair", code: "ABCD-EFGH" } });
    expect(parseExternal({ type: "status" }, page, cfg).ok).toBe(true);
    expect(parseExternal({ type: "run", action: "checkLogin", marketplace: "poshmark" }, page, cfg).ok).toBe(true);
    for (const url of ["https://evil.example/x", "https://shadowsync-ruby.vercel.app.evil.com/", "http://shadowsync-ruby.vercel.app/", "https://poshmark.com/"]) {
      expect(parseExternal({ type: "status" }, { url }, cfg)).toEqual({ ok: false, reason: "foreign_origin" });
    }
    expect(parseExternal({ type: "status" }, {}, cfg).ok).toBe(false);
    // destructive actions can never come from a page
    expect(parseExternal({ type: "run", action: "delist", marketplace: "poshmark" }, page, cfg).ok).toBe(false);
    expect(parseExternal({ type: "run", action: "checkLogin" }, page, cfg).ok).toBe(false);
    expect(parseExternal({ type: "eval", code: "x" }, page, cfg).ok).toBe(false);
    expect(parseExternal({ type: "status", extra: 1 }, page, cfg).ok).toBe(false);
    expect(parseExternal({ type: "pair", code: "ABCD-EFGH", token: "x" }, page, cfg).ok).toBe(false);
    expect(parseExternal({ type: "status", code: "ABCDEFGH" }, page, cfg).ok).toBe(false);
    expect(parseExternal("status", page, cfg).ok).toBe(false);
  });
  it("internal: only our own extension pages, never a tab or another extension", () => {
    expect(parseInternal({ type: "state" }, popup, cfg).ok).toBe(true);
    expect(parseInternal({ type: "pauseMarketplace", marketplace: "poshmark", paused: true }, popup, cfg).ok).toBe(true);
    expect(parseInternal({ type: "state" }, { ...popup, tab: { id: 1 } }, cfg)).toEqual({ ok: false, reason: "from_a_tab" });
    expect(parseInternal({ type: "state" }, { id: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", url: popup.url }, cfg).ok).toBe(false);
    expect(parseInternal({ type: "state" }, { id: cfg.extensionId, url: "https://poshmark.com/" }, cfg).ok).toBe(false);
    expect(parseInternal({ type: "runAnything" }, popup, cfg).ok).toBe(false);
    expect(parseInternal({ type: "pauseDevice", paused: "yes" }, popup, cfg).ok).toBe(false);
    expect(parseInternal({ type: "state", x: 1 }, popup, cfg).ok).toBe(false);
  });
  it("jobs: the 8 fixed actions with strict payloads; unknown actions and fields are rejected", () => {
    expect(validateAction(job())).toMatchObject({ ok: true, value: { action: "delist", payload: { externalId: ID } } });
    expect(validateAction(job({ action: "deleteAccount" }))).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(validateAction(job({ action: "eval", payload: {} }))).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(validateAction(job({ payload: { externalId: ID, script: "alert(1)" } }))).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(validateAction(job({ selector: "#x" }))).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(validateAction(job({ marketplace: "ebay" }))).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(validateAction(job({ payload: { externalId: "../../account" } }))).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(validateAction(job({ action: "updateQuantity", payload: { externalId: ID, quantity: -1 } }))).toMatchObject({ ok: false });
    expect(validateAction(job({ action: "createListing", payload: { title: "Polo", price: 20 } })).ok).toBe(true);
    expect(validateAction(job({ action: "getSales", payload: { cursor: null } })).ok).toBe(true);
  });
  it("relist guard: a Sold item is never listed, edited or restocked by the extension", () => {
    expect(validateAction(job({ action: "createListing", payload: { title: "Polo", price: 20 }, itemSold: true }))).toMatchObject({ ok: false, code: "relist_blocked" });
    expect(validateAction(job({ action: "updateListing", payload: { externalId: ID, price: 20 }, itemSold: true }))).toMatchObject({ ok: false, code: "relist_blocked" });
    expect(validateAction(job({ action: "updateQuantity", payload: { externalId: ID, quantity: 1 }, itemSold: true }))).toMatchObject({ ok: false, code: "relist_blocked" });
    expect(validateAction(job({ action: "updateQuantity", payload: { externalId: ID, quantity: 0 }, itemSold: true })).ok).toBe(true);
    expect(validateAction(job({ payload: { externalId: ID, mode: "delete" }, itemSold: true })).ok).toBe(true);
    expect(validateAction(job({ payload: { externalId: ID, mode: "nuke" } })).ok).toBe(false);
    expect(validateAction(job({ action: "createListing", payload: { title: "Polo", price: 20 }, itemSold: false })).ok).toBe(true);
  });
  it("URLs outside the host table are rejected", () => {
    for (const url of ["https://evil.example/listing/x", "https://poshmark.com.evil.com/x", "https://user:pw@poshmark.com/x", "https://poshmark.com:8443/x", "https://www.facebook.com/x"]) {
      expect(validateAction(job({ payload: { externalId: ID, url } }))).toMatchObject({ ok: false, code: "url_not_allowed" });
    }
    for (const url of ["http://poshmark.com/listing/x", "javascript:alert(1)", "data:text/html,x"]) expect(validateAction(job({ payload: { externalId: ID, url } })).ok).toBe(false);
    expect(validateAction(job({ payload: { externalId: ID, url: `https://poshmark.com/listing/${ID}` } })).ok).toBe(true);
    expect(isAllowedUrl("facebook", "https://www.facebook.com/marketplace/item/1")).toBe(true);
    expect(isAllowedUrl("facebook", "https://www.facebook.com/messages")).toBe(false);
    expect(isAllowedUrl("facebook", "https://www.facebook.com/")).toBe(true);
    expect(marketplaceOfUrl("https://www.depop.com/products/x")).toBe("depop");
    expect(marketplaceOfUrl("https://example.com/")).toBeNull();
  });
});

describe("pacing and kill switch", () => {
  const T = new Date(2026, 9, 18, 10, 0, 0).getTime();
  const S = 1000, MIN = 60 * S;
  it("one job at a time per marketplace, then a random 20-90 s gap", () => {
    let s = P.emptyPacing();
    expect(P.canRun(s, "poshmark", "delist", T).ok).toBe(true);
    s = P.begin(s, "poshmark", "delist", T);
    expect(P.canRun(s, "poshmark", "delist", T + S)).toMatchObject({ ok: false, reason: expect.stringMatching(/Another job/) });
    expect(P.canRun(s, "depop", "delist", T + S).ok).toBe(true); // other marketplaces are independent
    s = P.finish(s, "poshmark", { ok: true }, T + 10 * S, 0.5);
    expect(P.canRun(s, "poshmark", "delist", T + 30 * S).ok).toBe(false);
    expect(P.canRun(s, "poshmark", "delist", T + 10 * S + 56 * S).ok).toBe(true);
    expect(P.gapMs(0)).toBe(20 * S); expect(P.gapMs(0.9999999)).toBeLessThanOrEqual(90 * S); expect(P.gapMs(5)).toBeLessThanOrEqual(90 * S);
    expect(P.readiness(P.begin(P.emptyPacing(), "poshmark", "delist", T), "poshmark", T + 16 * MIN).ok).toBe(true); // stale busy flag
  });
  it("daily caps per action reset at local midnight", () => {
    let s = P.emptyPacing();
    for (let i = 0; i < P.PACING.dailyCaps.createListing; i++) s = P.finish(P.begin(s, "poshmark", "createListing", T), "poshmark", { ok: true }, T, 0);
    expect(P.canRun(s, "poshmark", "createListing", T + 2 * MIN)).toMatchObject({ ok: false, reason: expect.stringMatching(/Daily limit/) });
    expect(P.canRun(s, "poshmark", "delist", T + 2 * MIN).ok).toBe(true);
    expect(P.canRun(s, "poshmark", "createListing", T + 24 * 60 * MIN).ok).toBe(true);
  });
  it("an error burst pauses for an hour; signed-out does not count", () => {
    let s = P.emptyPacing();
    for (let i = 0; i < 5; i++) s = P.finish(s, "poshmark", { ok: false, code: "signed_out" }, T + i * MIN, 0);
    expect(P.readiness(s, "poshmark", T + 10 * MIN).ok).toBe(true);
    for (let i = 0; i < 3; i++) s = P.finish(s, "poshmark", { ok: false, code: "unexpected_page" }, T + i * MIN, 0);
    expect(P.readiness(s, "poshmark", T + 10 * MIN)).toMatchObject({ ok: false, reason: expect.stringMatching(/an hour/) });
    expect(P.readiness(s, "poshmark", T + 2 * MIN + 61 * MIN).ok).toBe(true);
  });
  it("auto-pauses after 2 security checks in a row, until you resume", () => {
    let s = P.finish(P.emptyPacing(), "poshmark", { ok: false, code: "captcha" }, T, 0);
    s = P.finish(s, "poshmark", { ok: true }, T + MIN, 0); // a success in between resets the streak
    s = P.finish(s, "poshmark", { ok: false, code: "challenge" }, T + 2 * MIN, 0);
    expect(P.readiness(s, "poshmark", T + 5 * MIN).ok).toBe(true);
    s = P.finish(s, "poshmark", { ok: false, code: "captcha" }, T + 6 * MIN, 0);
    expect(P.readiness(s, "poshmark", T + 99 * MIN)).toMatchObject({ ok: false, reason: expect.stringMatching(/2 security checks/) });
    s = P.setMarketplacePaused(s, "poshmark", false, T + 100 * MIN);
    expect(P.readiness(s, "poshmark", T + 100 * MIN).ok).toBe(true);
  });
  it("kill switch: this browser, or one marketplace", () => {
    let s = P.setDevicePaused(P.emptyPacing(), true);
    expect(P.canRun(s, "poshmark", "checkLogin", T)).toMatchObject({ ok: false, reason: "This browser is paused" });
    s = P.setMarketplacePaused(P.setDevicePaused(s, false), "poshmark", true, T);
    expect(P.canRun(s, "poshmark", "delist", T).ok).toBe(false);
    expect(P.canRun(s, "depop", "delist", T).ok).toBe(true);
  });
});

describe("manifest", () => {
  const m = buildManifest("https://shadowsync-ruby.vercel.app", "0.1.0");
  it("asks only for what spec section 5 allows", () => {
    expect(m.manifest_version).toBe(3);
    expect(m.permissions).toEqual(["alarms", "storage", "scripting"]);
    expect(m.host_permissions).toEqual(["https://shadowsync-ruby.vercel.app/*"]);
    expect(m.externally_connectable).toEqual({ matches: ["https://shadowsync-ruby.vercel.app/*"] });
    expect(m.optional_host_permissions).toEqual(Object.values(HOST_TABLE).flatMap((h) => h.permissions));
    const all = JSON.stringify(m);
    for (const bad of ["cookies", "webRequest", "declarativeNetRequest", "<all_urls>", "\"tabs\"", "unsafe-eval", "debugger", "history", "management", "nativeMessaging"]) expect(all).not.toContain(bad);
    expect(m.content_security_policy.extension_pages).toMatch(/^script-src 'self'/);
    expect(m.optional_host_permissions.every((p) => p.startsWith("https://") && !p.includes("*."))).toBe(true);
  });
  it("API origin is validated at build time", () => {
    expect(apiOriginFrom(undefined)).toBe("https://shadowsync-ruby.vercel.app");
    expect(apiOriginFrom("https://x.example.com")).toBe("https://x.example.com");
    expect(apiOriginFrom("http://localhost:3000")).toBe("http://localhost:3000");
    expect(() => apiOriginFrom("http://x.example.com")).toThrow();
    expect(() => apiOriginFrom("https://x.example.com/app")).toThrow();
  });
});

describe("pairing codes and device tokens", () => {
  it("codes: 8 unambiguous characters, shown as XXXX-XXXX, typed loosely", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) { const c = newPairingCode(); expect(c).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/); seen.add(c); }
    expect(seen.size).toBe(200);
    expect(formatPairingCode("ABCDEFGH")).toBe("ABCD-EFGH");
    expect(normalizePairingCode(" abcd-efgh ")).toBe("ABCDEFGH");
    expect(normalizePairingCode("ABC")).toBeNull();
    expect(normalizePairingCode(12345678)).toBeNull();
  });
  it("tokens: ssd_ + 256 random bits; only the sha256 is stored", () => {
    const t = newDeviceToken();
    expect(isDeviceToken(t)).toBe(true);
    expect(isDeviceToken(t + "x")).toBe(false);
    expect(newDeviceToken()).not.toBe(t);
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("outcome codes: SQL matches TypeScript", () => {
  const sql = readFileSync("supabase/migrations/0006_extension.sql", "utf8");
  const list = (re: RegExp) => new Set([...(re.exec(sql)?.[1] ?? "").matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]));
  it("needs-you, transient and challenge lists are identical", () => {
    expect(list(/elsif v_code in \(([^)]*)\) then v_kind := 'needs_user'/)).toEqual(new Set(NEEDS_USER_CODES));
    expect(list(/elsif v_code in \(([^)]*)\) or v_code ~ '\^http_5/)).toEqual(new Set(TRANSIENT_CODES));
    expect(list(/v_kind = 'needs_user' and v_code in \(([^)]*)\)/)).toEqual(new Set(CHALLENGE_CODES));
  });
});

import { normalizePhone } from "../src/lib/alerts";
describe("alerts phone number", () => {
  it("normalizes to E.164 or refuses", () => {
    expect(normalizePhone("(555) 123-4567")).toBe("+15551234567");
    expect(normalizePhone("1 555 123 4567")).toBe("+15551234567");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    for (const bad of ["", "123", "+0123456789", "call me", "+1555123456789012"]) expect(normalizePhone(bad)).toBeNull();
  });
});
