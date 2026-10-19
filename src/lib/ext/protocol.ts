// The extension protocol, shared by the web app and the extension (browser-safe: no Node imports).
// Spec: job-queue-extension-spec.md section 5. The extension is a small FIXED-ACTION worker:
// - only the 8 actions below exist; each has a strict payload schema (unknown fields are rejected, never passed on);
// - the server and web pages send an action name plus data, never code, selectors, scripts or URLs to open;
// - every marketplace URL is built by the extension from the host table below, and any URL it is given is checked against it.
import { arr, bool, keyed, nullable, num, obj, oneOf, str, type Check } from "./schema";
import type { Job, JobType, Marketplace } from "../data/types";

export const ACTIONS = ["checkLogin", "delist", "markSold", "updateQuantity", "createListing", "updateListing", "getSales", "getListings"] as const;
export type Action = (typeof ACTIONS)[number];

/** Marketplaces the extension may ever touch (spec 5 host table). eBay, Etsy, Shopify and Wix use official APIs and are NOT here. */
export const EXT_MARKETPLACES = ["poshmark", "facebook", "depop", "grailed", "mercari", "vinted"] as const satisfies readonly Marketplace[];
export type ExtMarketplace = (typeof EXT_MARKETPLACES)[number];
export const isExtMarketplace = (m: unknown): m is ExtMarketplace => (EXT_MARKETPLACES as readonly unknown[]).includes(m);

interface HostEntry {
  label: string;
  /** Exact hostnames allowed (https only, default port). */
  hosts: readonly string[];
  /** Allowed paths: "*" = any path, "/" = the home page only, anything else = that prefix (e.g. "/marketplace" and below). */
  paths: readonly string[];
  /** Optional host permissions requested when you press Connect (manifest optional_host_permissions). */
  permissions: readonly string[];
  /** Where real action code exists. Others answer "not supported yet". */
  supported: boolean;
  /** Format of the marketplace's own listing id. */
  listingId: RegExp;
}
export const HOST_TABLE: Record<ExtMarketplace, HostEntry> = {
  poshmark: { label: "Poshmark", hosts: ["poshmark.com"], paths: ["*"], permissions: ["https://poshmark.com/*"], supported: true, listingId: /^[a-f0-9]{24}$/i },
  facebook: {
    label: "Facebook Marketplace", hosts: ["www.facebook.com"], paths: ["/marketplace", "/"],
    permissions: ["https://www.facebook.com/marketplace/*", "https://www.facebook.com/"], supported: false, listingId: /^\d{5,25}$/,
  },
  depop: { label: "Depop", hosts: ["www.depop.com"], paths: ["*"], permissions: ["https://www.depop.com/*"], supported: false, listingId: /^[A-Za-z0-9_-]{1,80}$/ },
  grailed: { label: "Grailed", hosts: ["www.grailed.com"], paths: ["*"], permissions: ["https://www.grailed.com/*"], supported: false, listingId: /^\d{1,15}$/ },
  mercari: { label: "Mercari", hosts: ["www.mercari.com"], paths: ["*"], permissions: ["https://www.mercari.com/*"], supported: false, listingId: /^m\d{6,15}$/ },
  vinted: { label: "Vinted", hosts: ["www.vinted.com"], paths: ["*"], permissions: ["https://www.vinted.com/*"], supported: false, listingId: /^\d{1,15}$/ },
};

/** True only for https URLs on a host (and path prefix) in the table for that marketplace. No credentials, no odd ports. */
export function isAllowedUrl(m: ExtMarketplace, raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  const e = HOST_TABLE[m];
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  if (!e.hosts.includes(u.hostname)) return false;
  return e.paths.some((p) => p === "*" || (p === "/" ? u.pathname === "/" : u.pathname === p || u.pathname.startsWith(`${p}/`)));
}
/** Which table marketplace a URL belongs to, or null. */
export function marketplaceOfUrl(raw: string): ExtMarketplace | null {
  return EXT_MARKETPLACES.find((m) => isAllowedUrl(m, raw)) ?? null;
}

/** URLs the extension builds itself (never taken from a message). Poshmark only for now. */
export const POSHMARK = {
  origin: "https://poshmark.com",
  home: () => "https://poshmark.com/feed",
  listing: (id: string) => `https://poshmark.com/listing/${encodeURIComponent(id)}`,
  edit: (id: string) => `https://poshmark.com/edit-listing/${encodeURIComponent(id)}`,
  create: () => "https://poshmark.com/create-listing",
  sales: () => "https://poshmark.com/order/sales",
  closet: (user: string) => `https://poshmark.com/closet/${encodeURIComponent(user)}`,
};

// ---------------------------------------------------------------- action payloads (strict)
const text = (max: number) => str({ max });
const optUrl = str({ max: 500, pattern: /^https:\/\// }); // host checked separately against the table
const listingRef = { externalId: str({ min: 1, max: 80 }), url: optUrl } as const;
export const ACTION_SCHEMAS = {
  checkLogin: obj({}),
  // mode: "delete" only after a confirmed sale and when that marketplace's setting allows it; otherwise (or if absent) Not For Sale.
  delist: obj({ ...listingRef, saleId: text(80), soldOn: text(40), mode: oneOf(["delete", "not_for_sale"] as const) }, ["url", "saleId", "soldOn", "mode"]),
  markSold: obj({ ...listingRef, saleId: text(80), soldOn: text(40), mode: oneOf(["delete", "not_for_sale"] as const) }, ["url", "saleId", "soldOn", "mode"]),
  updateQuantity: obj({ ...listingRef, quantity: num({ min: 0, max: 999, int: true }) }, ["url"]),
  updateListing: obj({ ...listingRef, title: text(80), description: text(5000), price: num({ min: 1, max: 100_000 }), availability: oneOf(["for_sale", "not_for_sale"] as const) }, ["url", "title", "description", "price", "availability"]),
  createListing: obj(
    { title: str({ min: 1, max: 80 }), description: text(5000), price: num({ min: 1, max: 100_000 }), originalPrice: num({ min: 0, max: 100_000 }), brand: text(80), size: text(40) },
    ["description", "originalPrice", "brand", "size"],
  ),
  getSales: obj({ cursor: nullable(text(200)), limit: num({ min: 1, max: 100, int: true }) }, ["cursor", "limit"]),
  getListings: obj({ limit: num({ min: 1, max: 500, int: true }) }, ["limit"]),
} satisfies Record<Action, Check<unknown>>;
export type ActionPayload<A extends Action> = ReturnType<(typeof ACTION_SCHEMAS)[A]>;

/** What the extension runs: one job, already turned into a fixed action. */
export interface ActionRequest {
  jobId: string | null; marketplace: ExtMarketplace; action: Action; payload: Record<string, unknown>;
  /** The item is Sold in Shadow Sync: the extension refuses createListing / updateListing / updateQuantity above 0 (relist guard). */
  itemSold?: boolean;
  /** The item's SKU (used by the extension to keep unconfirmed request writes on TEST items only). */
  itemSku?: string | null;
}
/** Relist guard, extension side (same rule as lib/jobs/sold.ts isRelist). */
export const isRelistAction = (a: Action, payload: Record<string, unknown>) =>
  a === "createListing" || a === "updateListing" || (a === "updateQuantity" && Number(payload.quantity) > 0);

/** Job type -> action. update_listing with only a quantity becomes updateQuantity. sync_status is the read-only listing check. */
export function actionForJob(jobType: JobType, payload: Record<string, unknown>): Action {
  switch (jobType) {
    case "delist": return "delist";
    case "mark_sold": return "markSold";
    case "create_listing": return "createListing";
    case "update_listing": return payload.quantity !== undefined && payload.title === undefined && payload.price === undefined && payload.description === undefined ? "updateQuantity" : "updateListing";
    case "sync_status": return "getListings";
  }
}

/** Server side: build the action payload for a claimed job from OUR data only (listing id from our listing row, fields from the item). */
export interface JobContext {
  listing?: { externalId: string | null; url: string | null } | null;
  item?: { title: string; description: string | null; askingPrice: number | null; brand: string | null; size: string | null; status?: string; sku?: string | null } | null;
  soldAction?: "delete" | "not_for_sale";
  saleConfirmed?: boolean;
}
export function buildActionRequest(job: Pick<Job, "id" | "marketplace" | "jobType" | "payload">, ctx: JobContext): ActionRequest | null {
  if (!isExtMarketplace(job.marketplace)) return null;
  const p = job.payload ?? {};
  const action = actionForJob(job.jobType, p);
  const ref = () => {
    const externalId = ctx.listing?.externalId ?? (typeof p.externalId === "string" ? p.externalId : undefined);
    const url = ctx.listing?.url ?? (typeof p.url === "string" ? p.url : undefined);
    return { ...(externalId ? { externalId } : {}), ...(url ? { url } : {}) };
  };
  const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => p[k] !== undefined && p[k] !== null).map((k) => [k, p[k]]));
  // sku on the job payload (test actions) or on the item (poll) -> itemSku on the action; never left in the action payload.
  const itemSku = (typeof p.sku === "string" && p.sku ? p.sku : null) ?? (ctx.item?.sku ? ctx.item.sku : null);
  let payload: Record<string, unknown>;
  switch (action) {
    case "delist": case "markSold":
      // Delete ONLY after a confirmed sale (stored + matched to this item) and if this marketplace's setting is "delete" (the default).
      payload = { ...ref(), ...pick(["saleId", "soldOn"]), mode: (ctx.soldAction ?? "delete") === "delete" && ctx.saleConfirmed === true ? "delete" : "not_for_sale" };
      break;
    case "updateQuantity": payload = { ...ref(), ...pick(["quantity"]) }; break;
    case "updateListing": payload = { ...ref(), ...pick(["title", "description", "price", "availability"]) }; break;
    case "createListing": {
      const it = ctx.item;
      payload = {
        title: p.title ?? it?.title, price: p.price ?? it?.askingPrice ?? undefined,
        ...(p.description ?? it?.description ? { description: p.description ?? it?.description } : {}),
        ...(p.brand ?? it?.brand ? { brand: p.brand ?? it?.brand } : {}),
        ...(p.size ?? it?.size ? { size: p.size ?? it?.size } : {}),
        ...pick(["originalPrice"]),
      };
      for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
      break;
    }
    default: payload = {};
  }
  return {
    jobId: job.id, marketplace: job.marketplace, action, payload,
    ...(ctx.item?.status === "sold" ? { itemSold: true } : {}),
    ...(itemSku ? { itemSku } : {}),
  };
}

// ---------------------------------------------------------------- results the extension reports
/** Codes an action may report. The SERVER decides retry / needs-you / fail from the code (state-machine outcomeFromError). */
export const RESULT_CODES = [
  "signed_out", "captcha", "challenge", "verification_required", "unexpected_page", "review_and_submit", "listing_not_found",
  "timeout", "network", "rate_limited", "deferred", "unavailable",
  "not_supported", "invalid_payload", "url_not_allowed", "rejected", "permission_missing", "action_failed", "relist_blocked",
  // The marketplace's own pages / API answered in a way we don't recognise: the extension pauses that marketplace and the dashboard says so.
  "shape_changed",
] as const;
export type ResultCode = (typeof RESULT_CODES)[number];
export const resultSchema = obj(
  {
    ok: bool, code: oneOf(RESULT_CODES), message: str({ max: 500 }),
    // deleted: removed on the marketplace (kept in Shadow Sync). fallback: why delete wasn't possible (then it was set to Not For Sale).
    result: obj({ externalId: str({ max: 80 }), url: optUrl, alreadyDone: bool, note: str({ max: 300 }), deleted: bool, fallback: str({ min: 1, max: 300 }) },
      ["externalId", "url", "alreadyDone", "note", "deleted", "fallback"]),
  },
  ["code", "message", "result"],
);
export type ActionResult = ReturnType<typeof resultSchema>;

// ---------------------------------------------------------------- /api/v1/ext request bodies (strict)
export const DEVICE_TOKEN = /^ssd_[A-Za-z0-9_-]{43}$/;
export const PAIR_CODE = /^[0-9A-Z]{8}$/;
const semver = str({ max: 20, pattern: /^\d{1,3}\.\d{1,3}\.\d{1,3}$/ });
export const pairCompleteSchema = obj({ code: str({ min: 8, max: 12 }), label: str({ min: 1, max: 80 }), extensionVersion: semver }, ["label"]);
export const pollSchema = obj(
  { extensionVersion: semver, marketplaces: keyed(EXT_MARKETPLACES, bool), ready: arr(oneOf(EXT_MARKETPLACES), { max: EXT_MARKETPLACES.length }), limit: num({ min: 0, max: 6, int: true }),
    urgentOnly: arr(oneOf(EXT_MARKETPLACES), { max: EXT_MARKETPLACES.length }) },
  ["marketplaces", "ready", "limit", "urgentOnly"],
);
export const scanNextSchema = obj({ marketplace: oneOf(EXT_MARKETPLACES) });
const day = str({ pattern: /^\d{4}-\d{2}-\d{2}$/ });
export const saleSchema = obj(
  {
    orderId: str({ min: 1, max: 80 }), soldAt: day, price: num({ min: 0, max: 1_000_000 }), fees: nullable(num({ min: 0, max: 1_000_000 })),
    sku: nullable(text(80)), title: nullable(text(200)), shipBy: nullable(day), externalListingId: nullable(text(80)), cancelled: bool,
  },
  ["fees", "sku", "title", "shipBy", "externalListingId", "cancelled"],
);
export const scanReportSchema = obj({ marketplace: oneOf(EXT_MARKETPLACES), sales: arr(saleSchema, { max: 100 }), nextCursor: nullable(text(200)) });
export const listingsReportSchema = obj({ marketplace: oneOf(EXT_MARKETPLACES), externalIds: arr(str({ min: 1, max: 80 }), { max: 1000 }) });
export const progressSchema = obj({ message: str({ min: 1, max: 300 }) });
export const jobResultSchema = resultSchema;
