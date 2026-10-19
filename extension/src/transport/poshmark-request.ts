// Poshmark over requests (David, t433): background calls from the service worker with your own signed-in session (the browser
// sends your poshmark.com cookies by itself; we never read or set cookies), no tab. Built from David's recording of 2026-10-19
// (scrubbed copy only) for reads, and from REA's notes on how other tools talk to Poshmark (ideas only, no code copied) for writes:
//   token     GET /feed (HTML)  -> <meta id="csrftoken" content="..."> ; also tells us signed in or not and your user id
//                                  ("auth":{"isUserLoggedIn":true,"identity":"<24 hex>"}). Poshmark sends it back as the
//                                  x-xsrf-token header on every /vm-rest call, reads included. It rotates, so we re-read it often.
//                                  Fallback: GET /create-listing (what other tools use) when /feed has no token.
//   listing   GET /vm-rest/posts/<id>                       -> {data:{id, title, price_amount:{val}, inventory:{status, multi_item}}}
//   sales     GET /vm-rest/users/<uid>/orders/sales?request={"filters":{},"count":100} -> {data:{sales_summary:[...]}, meta:{next_max_id}}
//   sale detail GET /vm-rest/users/<uid>/orders/sales/<order> -> line_items[].parent_post_id (or product_id) = listing id
//   closet    GET /vm-rest/users/<handle>/posts/filtered     -> data[] of live posts (48 a page)
//   edit      POST /vm-rest/posts/<id>  body {post: <the object we just read, with only our changes>}
//   delete    DELETE /vm-rest/posts/<id>  (refused -> Not For Sale instead, after a fresh read)
// Because those write shapes are unconfirmed, the worker sends writes this way ONLY for test items (SKU starting with TEST)
// unless you widen it in the popup; every other listing keeps the tab path. Any surprise = shape_changed (pause), never a second try.
import { pick, str, num, bool, nullable, SchemaError, parse } from "../../../src/lib/ext/schema";
import type { ExtScanSale } from "../../../src/lib/data/types";
import type { ActionPlan, Bootstrap, FlowPlan, MarketplaceSpec, ReadOnlyPlan, ReadPlan } from "./request";
import { Out, ShapeChanged } from "./request";

export const BASE = "https://poshmark.com";
/** Versions Poshmark's own web app sends (2026-10-19 recording; the delete one from REA's notes). Kept here so they're easy to bump. */
export const POSH_VERSIONS = { pm: "2026.42.00", deleteApp: "2.55" };
const UID = /^[a-f0-9]{24}$/;

/** The page token: <meta id="csrftoken" content="..."> (attribute order free), or an inline "csrftoken":"..." value. */
export function findPageToken(html: string): string | null {
  const meta = /<meta\b[^>]*\bid=["']csrftoken["'][^>]*\bcontent=["']([A-Za-z0-9_\-.:+/=]{16,200})["']/i.exec(html)
    ?? /<meta\b[^>]*\bcontent=["']([A-Za-z0-9_\-.:+/=]{16,200})["'][^>]*\bid=["']csrftoken["']/i.exec(html);
  if (meta) return meta[1];
  const inline = /["']csrf_?token["']\s*:\s*["']([A-Za-z0-9_\-.:+/=]{16,200})["']/i.exec(html);
  return inline ? inline[1] : null;
}
/** Signed in or not, and your user id / handle, from the page's inline state. loggedIn null = the page did not say. */
export function pageAuth(html: string): { loggedIn: boolean | null; uid: string | null; handle: string | null } {
  const m = /"isUserLoggedIn"\s*:\s*(true|false)/.exec(html);
  const id = /"auth"\s*:\s*\{[^{}]*?"identity"\s*:\s*"([a-f0-9]{24})"/.exec(html)?.[1]
    ?? /"userInfo"\s*:\s*\{[^{}]*?"uid"\s*:\s*"([a-f0-9]{24})"/.exec(html)?.[1] ?? null;
  const dh = /"userInfo"\s*:\s*\{[^{}]*?"dh"\s*:\s*"([A-Za-z0-9_.-]{1,60})"/.exec(html)?.[1] ?? null;
  const signedIn = m?.[1] === "true";
  return { loggedIn: m ? signedIn : null, uid: signedIn ? id : null, handle: signedIn ? dh : null };
}
export const POSHMARK_BOOTSTRAP: Bootstrap = {
  url: `${BASE}/feed`, fallbackUrl: `${BASE}/create-listing`, token: findPageToken, header: "x-xsrf-token", sendOn: "all",
  vars: (html) => { const a = pageAuth(html); return { loggedIn: a.loggedIn, uid: a.uid, handle: a.handle }; },
};

/** One listing, shape checked on every read. `raw` is the untouched object we may POST back with only our changes. */
export interface PoshListing {
  id: string; title: string; price: number; status: string; multiItem: boolean;
  description?: string | null; sizes?: { quantity: number | null }[]; raw?: Record<string, unknown>;
}
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
  const raw = d as Record<string, unknown>;
  const inv = raw.inventory as { size_quantities?: unknown };
  const sizes = Array.isArray(inv?.size_quantities)
    ? inv.size_quantities.map((x) => ({ quantity: typeof (x as { quantity_available?: unknown })?.quantity_available === "number" ? (x as { quantity_available: number }).quantity_available : null }))
    : undefined;
  return {
    id: p.id, title: p.title, price, status: p.inventory.status, multiItem: p.inventory.multi_item,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(sizes ? { sizes } : {}), raw,
  };
}
export const postUrl = (id: string) => `${BASE}/vm-rest/posts/${encodeURIComponent(id)}`;
export const readListing: ReadPlan<PoshListing> = {
  request: (c) => { if (!c.externalId || !UID.test(c.externalId)) throw new ShapeChanged("bad listing id"); return { method: "GET", url: postUrl(c.externalId) }; },
  parse: (b) => parseListing(b),
};

/** @deprecated kept for the engine tests that inject a pretend write URL; production uses editPlan / quantityPlan. */
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

// ---- Writes ----
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const norm = (t: unknown) => String(t ?? "").replace(/\s+/g, " ").trim();
export const editUrl = (id: string) => `${postUrl(id)}?pm_version=${POSH_VERSIONS.pm}`;
export const deleteUrl = (id: string) => `${postUrl(id)}?app_version=${POSH_VERSIONS.deleteApp}&app_type=web&pm_version=${POSH_VERSIONS.pm}`;
/** The safest body we can make without a recording: the object we just read, with ONLY our changes applied. */
export function editBody(cur: PoshListing, change: (post: Record<string, unknown>) => void): { post: Record<string, unknown> } {
  if (!cur.raw) throw new ShapeChanged("no listing object to send back");
  const post = clone(cur.raw);
  change(post);
  return { post };
}
const setPrice = (post: Record<string, unknown>, p: number) => {
  const pa = post.price_amount as { val: string } | undefined;
  if (!pa || typeof pa.val !== "string") throw new ShapeChanged("no price_amount.val");
  const dec = /\.(\d+)$/.exec(pa.val)?.[1].length ?? 0;
  pa.val = dec ? p.toFixed(dec) : String(p);
  if (typeof post.price === "number") post.price = p;
};
export const NFS = "not_for_sale", FOR_SALE = "available";
const isSoldStatus = (st: string) => /sold/i.test(st) && st !== NFS;

/** updateListing: price / title / description / availability (For Sale <-> Not For Sale), one POST, verified by a fresh GET. */
export const editPlan: ActionPlan<PoshListing> = {
  read: readListing,
  decide(cur, a) {
    const p = a.payload;
    if (p.price !== undefined && (typeof p.price !== "number" || !Number.isInteger(p.price) || p.price < 3)) return { refuse: "Poshmark prices are whole dollars of at least $3", code: "invalid_payload" };
    if (p.availability !== undefined && p.availability !== "for_sale" && p.availability !== "not_for_sale") return { refuse: "Unknown availability", code: "invalid_payload" };
    if (isSoldStatus(cur.status)) return { refuse: "This listing is Sold on Poshmark; Shadow Sync won't change it", code: "unexpected_page" };
    const wantTitle = typeof p.title === "string" ? p.title : undefined;
    const wantDesc = typeof p.description === "string" ? p.description : undefined;
    const wantPrice = typeof p.price === "number" ? p.price : undefined;
    const wantAvail = p.availability === "not_for_sale" ? NFS : p.availability === "for_sale" ? FOR_SALE : undefined;
    const same =
      (wantTitle === undefined || norm(cur.title) === norm(wantTitle)) &&
      (wantDesc === undefined || norm(cur.description) === norm(wantDesc)) &&
      (wantPrice === undefined || cur.price === wantPrice) &&
      (wantAvail === undefined || cur.status === wantAvail);
    if (same) return null;
    const bits: string[] = [];
    if (wantPrice !== undefined && cur.price !== wantPrice) bits.push(`Price ${cur.price} -> ${wantPrice}`);
    if (wantTitle !== undefined && norm(cur.title) !== norm(wantTitle)) bits.push("Title");
    if (wantDesc !== undefined && norm(cur.description) !== norm(wantDesc)) bits.push("Description");
    if (wantAvail === NFS && cur.status !== NFS) bits.push("Not For Sale");
    if (wantAvail === FOR_SALE && cur.status !== FOR_SALE) bits.push("For Sale");
    return {
      write: {
        method: "POST", url: editUrl(cur.id),
        body: editBody(cur, (post) => {
          if (wantPrice !== undefined) setPrice(post, wantPrice);
          if (wantTitle !== undefined) post.title = wantTitle;
          if (wantDesc !== undefined) post.description = wantDesc;
          if (wantAvail !== undefined) (post.inventory as Record<string, unknown>).status = wantAvail;
        }),
      },
      note: bits.join("; ") || "Updated",
    };
  },
  verified(after, a) {
    const p = a.payload;
    if (typeof p.price === "number" && after.price !== p.price) return false;
    if (typeof p.title === "string" && norm(after.title) !== norm(p.title)) return false;
    if (typeof p.description === "string" && norm(after.description) !== norm(p.description)) return false;
    if (p.availability === "not_for_sale" && after.status !== NFS) return false;
    if (p.availability === "for_sale" && after.status !== FOR_SALE) return false;
    return true;
  },
};

/** updateQuantity: set quantity_available on every size (and multi_item). Single Item with quantity ≠ 1 needs you. */
export const quantityPlan: ActionPlan<PoshListing> = {
  read: readListing,
  decide(cur, a) {
    const q = a.payload.quantity;
    if (typeof q !== "number" || !Number.isInteger(q) || q < 0 || q > 999) return { refuse: "Quantity must be a whole number from 0 to 999", code: "invalid_payload" };
    if (q === 0) return { refuse: "Quantity 0 is Not For Sale; use that action", code: "not_supported" };
    if (isSoldStatus(cur.status)) return { refuse: "This listing is Sold on Poshmark; Shadow Sync won't change it", code: "unexpected_page" };
    if (!cur.multiItem && q !== 1) return { refuse: `This is a Single Item listing on Poshmark, so it has no quantity box. To sell ${q}, open it on Poshmark, choose Multi Item and set the quantity for each size (Shadow Sync won't switch that by itself).`, code: "unexpected_page" };
    if (!cur.sizes?.length) return { refuse: "Could not find the quantity setting on this listing", code: "unexpected_page" };
    if (cur.sizes.every((s) => s.quantity === q) && cur.status === FOR_SALE) return null;
    return {
      write: {
        method: "POST", url: editUrl(cur.id),
        body: editBody(cur, (post) => {
          const inv = post.inventory as Record<string, unknown>;
          inv.status = FOR_SALE;
          inv.multi_item = q > 1 || cur.multiItem;
          const sq = inv.size_quantities as Record<string, unknown>[];
          for (const row of sq) row.quantity_available = q;
        }),
      },
      note: `Quantity -> ${q}`,
    };
  },
  verified(after, a) {
    const q = a.payload.quantity as number;
    return after.status === FOR_SALE && !!after.sizes?.length && after.sizes.every((s) => s.quantity === q);
  },
};

/** delist / markSold: delete when the job says so (with Not For Sale as the only fallback if delete is refused); otherwise Not For Sale. */
export const delistFlow: FlowPlan = async ({ a, get, tryGet, write, sleep, progress }) => {
  const mode = a.payload.mode === "delete" ? "delete" : "not_for_sale";
  const before = await tryGet(readListing);
  if (before === null) return { ok: true, result: { alreadyDone: true, note: "Already gone" } };
  if (mode === "not_for_sale" && before.status === NFS) return { ok: true, result: { alreadyDone: true, note: "Already Not For Sale" } };
  if (isSoldStatus(before.status) && mode === "not_for_sale") return { ok: true, result: { alreadyDone: true, note: "Already Sold on Poshmark" } };

  if (mode === "delete") {
    progress("Deleting");
    const refused = await write({ method: "DELETE", url: deleteUrl(before.id) }, { refusable: true });
    const gone = await tryGet(readListing);
    if (gone === null) return { ok: true, result: { note: "Deleted (checked)" } };
    if (!refused) { await sleep(1500); if ((await tryGet(readListing)) === null) return { ok: true, result: { note: "Deleted (checked)" } }; }
    // Delete refused or the listing is still there: fall back to Not For Sale (one more write, after a fresh read).
    progress("Setting Not For Sale");
    const cur = gone ?? (await get(readListing));
    if (cur.status === NFS) return { ok: true, result: { note: "Delete refused; already Not For Sale" } };
    await write({
      method: "POST", url: editUrl(cur.id),
      body: editBody(cur, (post) => { (post.inventory as Record<string, unknown>).status = NFS; }),
    });
    let after = await get(readListing);
    if (after.status !== NFS) { await sleep(1500); after = await get(readListing); }
    if (after.status !== NFS) throw new ShapeChanged("delete refused and Not For Sale did not stick");
    return { ok: true, result: { note: "Delete refused; set Not For Sale (checked)" } };
  }

  progress("Setting Not For Sale");
  await write({
    method: "POST", url: editUrl(before.id),
    body: editBody(before, (post) => { (post.inventory as Record<string, unknown>).status = NFS; }),
  });
  let after = await get(readListing);
  if (after.status !== NFS) { await sleep(1500); after = await get(readListing); }
  if (after.status !== NFS) throw new ShapeChanged("Not For Sale did not stick");
  return { ok: true, result: { note: "Not For Sale (checked)" } };
};

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
    const day = /^\d{4}-\d{2}-\d{2}/.exec(s.inventory_booked_at)?.[0];
    const price = Number(s.total_price_amount.val);
    if (!day || !Number.isFinite(price)) throw new SchemaError(`data.sales_summary[${i}]`, "bad date or price");
    const earn = Number((x as RawSale).seller_earning_amount?.val);
    const disp = typeof (x as RawSale).display_status === "string" ? String((x as RawSale).display_status) : "";
    return {
      orderId: s.id, soldAt: day, price, fees: Number.isFinite(earn) && earn <= price ? Math.round((price - earn) * 100) / 100 : null,
      title: s.title ? s.title.slice(0, 200) : null, externalListingId: null,
      ...(/cancel/i.test(s.state) || /cancel/i.test(disp) ? { cancelled: true } : {}),
    };
  });
  return { sales, more: typeof b?.meta?.next_max_id === "string" && b.meta.next_max_id !== "" };
}
export const salesUrl = (uid: string) => `${BASE}/vm-rest/users/${uid}/orders/sales?request=${encodeURIComponent(JSON.stringify({ filters: {}, count: 100 }))}`;
export const saleDetailUrl = (uid: string, orderId: string) => `${BASE}/vm-rest/users/${uid}/orders/sales/${encodeURIComponent(orderId)}`;

/** Same cursor rule as the tab path: newer than the cursor minus a 1-day overlap (the server drops duplicates), oldest first. */
export function pickSales(all: ExtScanSale[], cursor: string | null, limit: number): { sales: ExtScanSale[]; nextCursor: string | null } {
  const since = cursor && !Number.isNaN(Date.parse(cursor)) ? new Date(Date.parse(cursor) - 86_400_000).toISOString().slice(0, 10) : null;
  const sales = all.filter((s) => !since || s.soldAt >= since).sort((a, b) => a.soldAt.localeCompare(b.soldAt)).slice(0, limit);
  const newest = sales.reduce<string | null>((m, s) => (!m || s.soldAt > m ? s.soldAt : m), null);
  return { sales, nextCursor: newest && (!cursor || `${newest}T00:00:00.000Z` > cursor) ? `${newest}T00:00:00.000Z` : null };
}

/** Order detail -> listing id (parent_post_id, else product_id). Null when the answer has no usable line. */
export function listingIdFromOrder(body: unknown): string | null {
  const d = (body as { data?: { line_items?: unknown } } | null)?.data;
  const items = Array.isArray(d?.line_items) ? d!.line_items as Record<string, unknown>[] : null;
  if (!items?.length) return null;
  for (const li of items) {
    for (const k of ["parent_post_id", "product_id"] as const) {
      const v = li[k];
      if (typeof v === "string" && UID.test(v)) return v;
    }
  }
  return null;
}

// ---- Closet ----
export const closetUrl = (handle: string, maxId?: string) => {
  const request: Record<string, unknown> = { filters: { inventory_status: ["available", "published", "for_review"] }, sort_by: "added_desc", count: 48 };
  if (maxId) request.max_id = maxId;
  return `${BASE}/vm-rest/users/${encodeURIComponent(handle)}/posts/filtered?request=${encodeURIComponent(JSON.stringify(request))}&summarize=true`;
};
export function parseClosetPage(body: unknown): { ids: string[]; next: string | null } {
  const b = body as { data?: unknown; more?: { next_max_id?: unknown } } | null;
  const list = Array.isArray(b?.data) ? b!.data as unknown[] : (b?.data as { posts?: unknown })?.posts;
  if (!Array.isArray(list)) throw new SchemaError("data", "must be a list of posts");
  const ids: string[] = [];
  for (const x of list) {
    const id = (x as { id?: unknown })?.id;
    if (typeof id === "string" && UID.test(id)) ids.push(id.toLowerCase());
  }
  const next = typeof b?.more?.next_max_id === "string" && b.more.next_max_id !== "" ? b.more.next_max_id : null;
  return { ids, next };
}

/** Poshmark puts {error:{errorType,statusCode,userMessage}} even on HTTP 200. */
export function bodyError(json: unknown): { code: "signed_out" | "listing_not_found" | "shape_changed" | "verification_required"; message: string } | null {
  const e = (json as { error?: { errorType?: unknown; statusCode?: unknown; userMessage?: unknown } } | null)?.error;
  if (!e || typeof e !== "object") return null;
  const type = String(e.errorType ?? "");
  const msg = typeof e.userMessage === "string" && e.userMessage ? e.userMessage : (type || "Poshmark refused");
  const code = Number(e.statusCode);
  if (/auth|login|session|token/i.test(type) || code === 401) return { code: "signed_out", message: msg };
  if (/not.?found|404/i.test(type) || code === 404) return { code: "listing_not_found", message: msg };
  if (/phone|verif/i.test(type)) return { code: "verification_required", message: msg };
  return { code: "shape_changed", message: msg };
}

const needUid = (c: { vars: Record<string, string | boolean | null> }) => {
  if (c.vars.loggedIn === false) throw new Out("signed_out", "Signed out of Poshmark. Sign in in this browser; waiting jobs then continue by themselves.");
  const uid = c.vars.uid;
  if (typeof uid !== "string" || !UID.test(uid)) throw new ShapeChanged("no user id on the page");
  return uid;
};

const checkLogin: ReadOnlyPlan = async ({ page }) => {
  const r = await page(POSHMARK_BOOTSTRAP.url);
  return { ok: true, result: {}, loggedIn: pageAuth(r.raw).loggedIn };
};

const getSales: ReadOnlyPlan = async ({ ctx, get, tryGet, sleep }) => {
  // List first (cheap), then detail only the ones we keep after the cursor filter (capped), so a long history does not fan out.
  const list = await get({ request: (c) => ({ method: "GET", url: salesUrl(needUid(c)) }), parse: (b) => parseSalesJson(b) });
  const uid = needUid(ctx); // set by the bootstrap inside get()
  const p = ctx.a.payload;
  const out = pickSales(list.sales, (p.cursor as string | null | undefined) ?? null, (p.limit as number | undefined) ?? 50);
  const detailCap = Math.min(out.sales.length, 25);
  for (let i = 0; i < detailCap; i++) {
    const s = out.sales[i];
    if (s.cancelled || s.externalListingId) continue;
    const id = await tryGet({
      request: () => ({ method: "GET", url: saleDetailUrl(uid, s.orderId) }),
      parse: (b) => { const v = listingIdFromOrder(b); if (!v) throw new SchemaError("data.line_items", "no parent_post_id"); return v; },
    }).catch(() => null);
    if (id) s.externalListingId = id;
    if (i + 1 < detailCap) await sleep(600);
  }
  return { ok: true, result: {}, sales: out.sales, nextCursor: out.nextCursor };
};

const getListings: ReadOnlyPlan = async ({ ctx, get }) => {
  const ids: string[] = [];
  let maxId: string | undefined;
  for (let page = 0; page < 10 && ids.length < 500; page++) {
    const r = await get({
      request: (c) => {
        if (c.vars.loggedIn === false) throw new Out("signed_out", "Signed out of Poshmark. Sign in in this browser; waiting jobs then continue by themselves.");
        const handle = c.vars.handle;
        if (typeof handle !== "string" || !/^[A-Za-z0-9_.-]{1,60}$/.test(handle)) throw new ShapeChanged("no closet handle on the page");
        return { method: "GET", url: closetUrl(handle, maxId) };
      },
      parse: (b) => parseClosetPage(b),
    });
    for (const id of r.ids) if (!ids.includes(id)) ids.push(id);
    if (!r.next) break;
    maxId = r.next;
  }
  return { ok: true, result: { note: `${ids.length} live listings seen` }, listingIds: ids };
};

export const POSHMARK_REQUEST_SPEC: MarketplaceSpec = {
  marketplace: "poshmark",
  bootstrap: POSHMARK_BOOTSTRAP,
  plans: { updateListing: editPlan, updateQuantity: quantityPlan },
  flows: { delist: delistFlow, markSold: delistFlow },
  reads: { checkLogin, getSales, getListings },
  bodyError,
  enabled: true,
};
