// Message gatekeeper (spec 5). Pure, so it is unit-tested without a browser.
// - Web pages: only our own API origin (externally_connectable lists only it, and we check again here). They may only pair, ask for
//   status, or run the read-only checkLogin. Anything that changes a listing comes ONLY from the server job queue with the device token.
// - The popup: only our own extension pages, never a content script or a tab.
// - Jobs: strict envelope + strict per-action schema; URLs must be in the host table; listing ids must match that marketplace's format.
import { BRAND } from "./brand";
import { parse, obj, oneOf, str, num, nullable, SchemaError } from "../../src/lib/ext/schema";
import {
  ACTION_SCHEMAS, ACTIONS, EXT_MARKETPLACES, HOST_TABLE, isAllowedUrl, isRelistAction, type Action, type ActionRequest, type ExtMarketplace,
} from "../../src/lib/ext/protocol";

export interface Sender { id?: string; url?: string; origin?: string; tab?: unknown }
export interface HandlerConfig { apiOrigin: string; extensionId: string }
export type Rejected = { ok: false; reason: string };

const originOf = (s: Sender): string | null => {
  if (s.origin) return s.origin;
  try {
    if (!s.url) return null;
    const u = new URL(s.url);
    return u.protocol === "chrome-extension:" ? `chrome-extension://${u.host}` : u.origin; // URL.origin is "null" for this scheme in some runtimes
  } catch { return null; }
};

// ---------------------------------------------------------------- web page (our dashboard) -> extension
const externalSchema = obj({ type: oneOf(["pair", "status", "run"] as const), code: str({ min: 8, max: 12 }), action: oneOf(["checkLogin"] as const), marketplace: oneOf(EXT_MARKETPLACES) }, ["code", "action", "marketplace"]);
export type ExternalRequest = { type: "pair"; code: string } | { type: "status" } | { type: "run"; action: "checkLogin"; marketplace: ExtMarketplace };

export function parseExternal(msg: unknown, sender: Sender, cfg: HandlerConfig): { ok: true; req: ExternalRequest } | Rejected {
  if (originOf(sender) !== cfg.apiOrigin) return { ok: false, reason: "foreign_origin" };
  if (sender.id && sender.id !== cfg.extensionId) return { ok: false, reason: "foreign_extension" };
  let m;
  try { m = parse(externalSchema, msg); } catch (e) { return { ok: false, reason: e instanceof SchemaError ? `invalid: ${e.message}` : "invalid" }; }
  if (m.type === "pair") return m.code ? { ok: true, req: { type: "pair", code: m.code } } : { ok: false, reason: "invalid: code is required" };
  if (m.type === "run") {
    if (m.action !== "checkLogin" || !m.marketplace) return { ok: false, reason: "invalid: only checkLogin can be requested by a page" };
    return { ok: true, req: { type: "run", action: "checkLogin", marketplace: m.marketplace } };
  }
  if (m.code !== undefined || m.action !== undefined || m.marketplace !== undefined) return { ok: false, reason: "invalid: unexpected fields" };
  return { ok: true, req: { type: "status" } };
}

// ---------------------------------------------------------------- popup -> background
const internalSchema = obj({
  type: oneOf(["state", "pollNow", "scanNow", "pair", "unpair", "pauseDevice", "pauseMarketplace", "connected", "checkLogin"] as const),
  code: str({ min: 8, max: 12 }), paused: (v, p) => { if (typeof v !== "boolean") throw new SchemaError(p, "must be true or false"); return v; },
  marketplace: oneOf(EXT_MARKETPLACES),
}, ["code", "paused", "marketplace"]);
export type InternalRequest = ReturnType<typeof internalSchema>;
export function parseInternal(msg: unknown, sender: Sender, cfg: HandlerConfig): { ok: true; req: InternalRequest } | Rejected {
  if (sender.id !== cfg.extensionId) return { ok: false, reason: "foreign_extension" };
  if (sender.tab) return { ok: false, reason: "from_a_tab" }; // content scripts never send us messages; drop anything that claims to
  if (originOf(sender) !== `chrome-extension://${cfg.extensionId}`) return { ok: false, reason: "not_an_extension_page" };
  try { return { ok: true, req: parse(internalSchema, msg) }; } catch (e) { return { ok: false, reason: e instanceof SchemaError ? `invalid: ${e.message}` : "invalid" }; }
}

// ---------------------------------------------------------------- job from the server -> runnable action
const envelope = obj({
  jobId: nullable(str({ min: 36, max: 36 })), marketplace: oneOf(EXT_MARKETPLACES), action: oneOf(ACTIONS),
  payload: (v, p) => { if (!v || typeof v !== "object" || Array.isArray(v)) throw new SchemaError(p, "must be an object"); return v as Record<string, unknown>; },
  leaseExpiresAt: nullable(str({ max: 40 })), attempt: num({ min: 0, max: 50, int: true }),
  itemSold: (v, p) => { if (typeof v !== "boolean") throw new SchemaError(p, "must be true or false"); return v; },
}, ["leaseExpiresAt", "attempt", "itemSold"]);
export type JobCheck = { ok: true; value: ActionRequest } | { ok: false; code: "invalid_payload" | "url_not_allowed" | "relist_blocked"; message: string };

export function validateAction(raw: unknown): JobCheck {
  let e;
  try { e = parse(envelope, raw); } catch (x) { return { ok: false, code: "invalid_payload", message: (x as Error).message }; }
  let payload: Record<string, unknown>;
  try { payload = parse(ACTION_SCHEMAS[e.action as Action] as never, e.payload) as Record<string, unknown>; }
  catch (x) { return { ok: false, code: "invalid_payload", message: `${e.action}: ${(x as Error).message}` }; }
  const m = e.marketplace as ExtMarketplace;
  if (typeof payload.url === "string" && !isAllowedUrl(m, payload.url)) return { ok: false, code: "url_not_allowed", message: `URL is not on ${HOST_TABLE[m].label}` };
  if (typeof payload.externalId === "string" && !HOST_TABLE[m].listingId.test(payload.externalId)) {
    return { ok: false, code: "invalid_payload", message: `"${payload.externalId}" is not a ${HOST_TABLE[m].label} listing id` };
  }
  // Relist guard (the server refuses these too): never list, edit or restock an item that is Sold in Shadow Sync.
  if (e.itemSold === true && isRelistAction(e.action as Action, payload)) {
    return { ok: false, code: "relist_blocked", message: `This item is Sold in ${BRAND}; undo the sale to list it again` };
  }
  return { ok: true, value: { jobId: e.jobId, marketplace: m, action: e.action as Action, payload, ...(e.itemSold ? { itemSold: true } : {}) } };
}
