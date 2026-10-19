// Poshmark over requests (David, t433): background calls with your signed-in session, no tab. NOT ENABLED: the endpoints, the token
// and the response shapes get filled in from David's sanitized HAR (edit price on TEST-1, open My Sales) and tested against it.
// Until then `enabled` is false and every Poshmark action keeps using the tab (DOM) transport.
import { pick, str, num, SchemaError, parse } from "../../../src/lib/ext/schema";
import type { ActionPlan, Bootstrap, MarketplaceSpec } from "./request";

/** Page-token bootstrap STUB: a page we GET to find the token the site sends back on writes. Candidates until the HAR says which:
 *  a <meta name="csrf-token"> tag, or a "csrfToken" / "csrf_token" value in the page's inline state. */
export function findPageToken(html: string): string | null {
  const meta = /<meta[^>]+name=["'](?:csrf-token|csrf_token|_csrf)["'][^>]*content=["']([^"']{8,200})["']/i.exec(html)
    ?? /<meta[^>]+content=["']([^"']{8,200})["'][^>]*name=["'](?:csrf-token|csrf_token|_csrf)["']/i.exec(html);
  if (meta) return meta[1];
  const inline = /["'](?:csrfToken|csrf_token|csrf)["']\s*:\s*["']([A-Za-z0-9+/=_\-.:]{8,200})["']/.exec(html);
  return inline ? inline[1] : null;
}
export const POSHMARK_BOOTSTRAP: Bootstrap = { url: "https://poshmark.com/feed", token: findPageToken, header: "x-csrf-token" /* HAR: real header name */ };

/** What we need to know about one listing (shape checked on every read). Field paths are placeholders until the HAR. */
export interface PoshListing { id: string; price: number; title: string; status: string }
const listingShape = pick({ id: str({ min: 24, max: 24 }), price: num({ min: 0, max: 100000 }), title: str({ max: 200 }), status: str({ max: 40 }) });
export const parseListing = (body: unknown): PoshListing => {
  const b = body as { data?: unknown } | null;
  if (!b || typeof b !== "object") throw new SchemaError("$", "must be an object");
  return parse(listingShape, (b as { data?: unknown }).data ?? b) as PoshListing;
};

/** updateListing (price only, first): plan shape ready; URL / body come from the HAR. */
export const priceChangePlan = (endpoints: { read: (id: string) => string; write: (id: string) => string; body: (l: PoshListing, price: number) => unknown }): ActionPlan<PoshListing> => ({
  read: { request: (c) => ({ method: "GET", url: endpoints.read(c.externalId!) }), parse: (b) => parseListing(b) },
  decide(cur, a) {
    const p = a.payload.price;
    if (typeof p !== "number" || !Number.isInteger(p) || p < 3) return { refuse: "Poshmark prices are whole dollars of at least $3", code: "invalid_payload" };
    if (Object.keys(a.payload).some((k) => !["externalId", "price", "previous"].includes(k))) return { refuse: "Only price changes go over requests so far", code: "not_supported" };
    if (cur.price === p) return null;
    return { write: { method: "POST", url: endpoints.write(cur.id), body: endpoints.body(cur, p) }, note: `Price ${cur.price} -> ${p}` };
  },
  verified: (after, a) => after.price === a.payload.price,
});

export const POSHMARK_REQUEST_SPEC: MarketplaceSpec = {
  marketplace: "poshmark",
  bootstrap: POSHMARK_BOOTSTRAP,
  plans: {}, // HAR: { updateListing: priceChangePlan({...}), getSales: ... }
  enabled: false,
};
