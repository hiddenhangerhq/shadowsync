// Poshmark over requests (David, t433): background calls from the service worker with your own signed-in session (the browser
// sends your poshmark.com cookies by itself; we never read or set cookies), no tab. Built from David's recording of 2026-10-19
// (scrubbed copy only):
//   token     GET /feed (HTML)  -> <meta id="csrftoken" content="..."> ; also tells us signed in or not and your user id
//                                  ("auth":{"isUserLoggedIn":true,"identity":"<24 hex>"}). Poshmark sends it back as the
//                                  x-xsrf-token header on every /vm-rest call, reads included. It rotates, so we re-read it often.
//   listing   GET /vm-rest/posts/<id>                       -> {data:{id, title, price_amount:{val}, inventory:{status, multi_item}}}
//   sales     GET /vm-rest/users/<uid>/orders/sales?request={"filters":{},"count":100} -> {data:{sales_summary:[...]}, meta:{next_max_id}}
// NOT in the recording: the save (price / title / Not For Sale), delete and quantity requests. Those stay on the tab (DOM) path
// until David records them; `priceChangePlan` is the ready-made shape for when we have the real write.
import { pick, str, num, bool, nullable, SchemaError, parse } from "../../../src/lib/ext/schema";
import type { ExtScanSale } from "../../../src/lib/data/types";
import type { ActionPlan, Bootstrap, MarketplaceSpec, ReadOnlyPlan, ReadPlan } from "./request";
import { Out, ShapeChanged } from "./request";

export const BASE = "https://poshmark.com";
const UID = /^[a-f0-9]{24}$/;

/** The page token: <meta id="csrftoken" content="..."> (attribute order free), or an inline "csrftoken":"..." value. */
export function findPageToken(html: string): string | null {
  const meta = /<meta\b[^>]*\bid=["']csrftoken["'][^>]*\bcontent=["']([A-Za-z0-9_\-.:+/=]{16,200})["']/i.exec(html)
    ?? /<meta\b[^>]*\bcontent=["']([A-Za-z0-9_\-.:+/=]{16,200})["'][^>]*\bid=["']csrftoken["']/i.exec(html);
  if (meta) return meta[1];
  const inline = /["']csrf_?token["']\s*:\s*["']([A-Za-z0-9_\-.:+/=]{16,200})["']/i.exec(html);
  return inline ? inline[1] : null;
}
/** Signed in or not, and your user id, from the page's inline state. loggedIn null = the page did not say. */
export function pageAuth(html: string): { loggedIn: boolean | null; uid: string | null } {
  const m = /"isUserLoggedIn"\s*:\s*(true|false)/.exec(html);
  const id = /"auth"\s*:\s*\{[^{}]*?"identity"\s*:\s*"([a-f0-9]{24})"/.exec(html)?.[1] ?? /"userInfo"\s*:\s*\{[^{}]*?"uid"\s*:\s*"([a-f0-9]{24})"/.exec(html)?.[1] ?? null;
  return { loggedIn: m ? m[1] === "true" : null, uid: m?.[1] === "true" ? id : null };
}
export const POSHMARK_BOOTSTRAP: Bootstrap = {
  url: `${BASE}/feed`, token: findPageToken, header: "x-xsrf-token", sendOn: "all",
  vars: (html) => { const a = pageAuth(html); return { loggedIn: a.loggedIn, uid: a.uid }; },
};

/** One listing, shape checked on every read. */
export interface PoshListing { id: string; title: string; price: number; status: string; multiItem: boolean }
const postShape = pick({
  id: str({ min: 24, max: 24 }), title: str({ max: 200 }),
  price_amount: pick({ val: str({ max: 20 }) }),
  inventory: pick({ status: str({ max: 40 }), multi_item: bool }),
});
export function parseListing(body: unknown): PoshListing {
  const d = (body as { data?: unknown } | null)?.data;
  if (!d || typeof d !== "object") throw new SchemaError("data", "must be an object");
  const p = parse(postShape, d) as { id: string; title: string; price_amount: { val: string }; inventory: { status: string; multi_item: boolean } };
  const price = Number(p.price_amount.val);
  if (!Number.isFinite(price)) throw new SchemaError("data.price_amount.val", "must be a number");
  return { id: p.id, title: p.title, price, status: p.inventory.status, multiItem: p.inventory.multi_item };
}
export const postUrl = (id: string) => `${BASE}/vm-rest/posts/${encodeURIComponent(id)}`;
export const readListing: ReadPlan<PoshListing> = {
  request: (c) => { if (!c.externalId || !UID.test(c.externalId)) throw new ShapeChanged("bad listing id"); return { method: "GET", url: postUrl(c.externalId) }; },
  parse: (b) => parseListing(b),
};

/** updateListing (price only). The write URL / body are NOT known yet (not in the recording): this is only wired up once they are. */
export const priceChangePlan = (write: { url: (id: string) => string; body: (l: PoshListing, price: number) => unknown; method?: "POST" | "PUT" }, read: ReadPlan<PoshListing> = readListing): ActionPlan<PoshListing> => ({
  read,
  decide(cur, a) {
    const p = a.payload.price;
    if (typeof p !== "number" || !Number.isInteger(p) || p < 3) return { refuse: "Poshmark prices are whole dollars of at least $3", code: "invalid_payload" };
    if (Object.keys(a.payload).some((k) => !["externalId", "price", "previous"].includes(k))) return { refuse: "Only price changes go over requests so far", code: "not_supported" };
    if (cur.price === p) return null;
    return { write: { method: write.method ?? "POST", url: write.url(cur.id), body: write.body(cur, p) }, note: `Price ${cur.price} -> ${p}` };
  },
  verified: (after, a) => after.price === a.payload.price,
});

// ---- Sales ----
const saleShape = pick({
  id: str({ min: 4, max: 40 }), state: str({ max: 60 }), title: nullable(str({ max: 500 })),
  total_price_amount: pick({ val: str({ max: 20 }) }), inventory_booked_at: str({ min: 10, max: 40 }),
});
type RawSale = { id: string; state: string; title: string | null; total_price_amount: { val: string }; inventory_booked_at: string; seller_earning_amount?: { val?: unknown }; display_status?: unknown };
export function parseSalesJson(body: unknown): { sales: ExtScanSale[]; more: boolean } {
  const b = body as { data?: { sales_summary?: unknown }; meta?: { next_max_id?: unknown } } | null;
  const list = b?.data?.sales_summary;
  if (!Array.isArray(list)) throw new SchemaError("data.sales_summary", "must be a list");
  const sales = list.map((x, i): ExtScanSale => {
    let s: RawSale;
    try { s = parse(saleShape, x) as RawSale; } catch (e) { throw new SchemaError(`data.sales_summary[${i}]`, e instanceof SchemaError ? e.message : "bad"); }
    const day = /^\d{4}-\d{2}-\d{2}/.exec(s.inventory_booked_at)?.[0]; // Poshmark gives your local date with its offset
    const price = Number(s.total_price_amount.val);
    if (!day || !Number.isFinite(price)) throw new SchemaError(`data.sales_summary[${i}]`, "bad date or price");
    const earn = Number((x as RawSale).seller_earning_amount?.val);
    const disp = typeof (x as RawSale).display_status === "string" ? String((x as RawSale).display_status) : "";
    return {
      orderId: s.id, soldAt: day, price, fees: Number.isFinite(earn) && earn <= price ? Math.round((price - earn) * 100) / 100 : null,
      title: s.title ? s.title.slice(0, 200) : null,
      externalListingId: null, // the sales list does not name the listing (needs the order page recording)
      ...(/cancel/i.test(s.state) || /cancel/i.test(disp) ? { cancelled: true } : {}),
    };
  });
  return { sales, more: typeof b?.meta?.next_max_id === "string" && b.meta.next_max_id !== "" };
}
export const salesUrl = (uid: string) => `${BASE}/vm-rest/users/${uid}/orders/sales?request=${encodeURIComponent(JSON.stringify({ filters: {}, count: 100 }))}`;

/** Same cursor rule as the tab path: newer than the cursor minus a 1-day overlap (the server drops duplicates), oldest first. */
export function pickSales(all: ExtScanSale[], cursor: string | null, limit: number): { sales: ExtScanSale[]; nextCursor: string | null } {
  const since = cursor && !Number.isNaN(Date.parse(cursor)) ? new Date(Date.parse(cursor) - 86_400_000).toISOString().slice(0, 10) : null;
  const sales = all.filter((s) => !since || s.soldAt >= since).sort((a, b) => a.soldAt.localeCompare(b.soldAt)).slice(0, limit);
  const newest = sales.reduce<string | null>((m, s) => (!m || s.soldAt > m ? s.soldAt : m), null);
  return { sales, nextCursor: newest && (!cursor || `${newest}T00:00:00.000Z` > cursor) ? `${newest}T00:00:00.000Z` : null };
}

const checkLogin: ReadOnlyPlan = async ({ page }) => {
  const r = await page(POSHMARK_BOOTSTRAP.url);
  return { ok: true, result: {}, loggedIn: pageAuth(r.raw).loggedIn };
};
const getSales: ReadOnlyPlan = async ({ ctx, get }) => {
  const plan: ReadPlan<{ sales: ExtScanSale[]; more: boolean }> = {
    request: (c) => {
      const uid = c.vars.uid;
      if (c.vars.loggedIn === false) throw new Out("signed_out", "Signed out of Poshmark. Sign in in this browser; waiting jobs then continue by themselves.");
      if (typeof uid !== "string" || !UID.test(uid)) throw new ShapeChanged("no user id on the page");
      return { method: "GET", url: salesUrl(uid) };
    },
    parse: (b) => parseSalesJson(b),
  };
  const r = await get(plan);
  const p = ctx.a.payload;
  const out = pickSales(r.sales, (p.cursor as string | null | undefined) ?? null, (p.limit as number | undefined) ?? 50);
  return { ok: true, result: {}, sales: out.sales, nextCursor: out.nextCursor };
};

export const POSHMARK_REQUEST_SPEC: MarketplaceSpec = {
  marketplace: "poshmark",
  bootstrap: POSHMARK_BOOTSTRAP,
  plans: {}, // writes: waiting for the save recording (see priceChangePlan)
  reads: { checkLogin, getSales },
  enabled: true,
};
