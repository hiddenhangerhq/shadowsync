// The generic request engine (no marketplace specifics). One action = bootstrap (get the page token) -> read (GET, check its shape)
// -> already right? done -> ONE write -> verify with a fresh read. Anything unexpected (status, content type, JSON shape, a verify
// that does not show the change) is "shape_changed": the worker pauses that marketplace and the dashboard says so. There is never a
// second write in one action, so nothing is left half done by us; a write whose verify fails is reported, not retried.
import { HOST_TABLE, isAllowedUrl, type ActionRequest, type ExtMarketplace, type ResultCode } from "../../../src/lib/ext/protocol";
import { SchemaError } from "../../../src/lib/ext/schema";
import type { RunOutcome } from "../runner";
import { SHAPE_CHANGED_MESSAGE, type Transport } from "./types";

/** The subset of fetch we use (injected, so tests run with a mock). */
export type Fetcher = (url: string, init: { method: string; credentials: "include"; redirect: "manual" | "follow"; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ status: number; url: string; headers: { get(n: string): string | null }; text(): Promise<string> }>;

export interface Http { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; headers?: Record<string, string>; body?: unknown; /** follow redirects (HTML pages only) */ follow?: boolean }
/** A parsed, schema-checked response. `parse` throws SchemaError (or anything) when the shape is not what the plan expects. */
export interface ReadPlan<S> { request(ctx: Ctx): Http; parse(body: unknown, raw: string): S }
export interface ActionPlan<S> {
  read: ReadPlan<S>;
  /** null = already in the wanted state (done, nothing written). A string = refuse for you (needs you), e.g. Single Item quantity. */
  decide(current: S, a: ActionRequest): { write: Http; note: string } | null | { refuse: string; code?: ResultCode };
  /** Does a fresh read show the change? */
  verified(after: S, a: ActionRequest): boolean;
}
export interface Bootstrap {
  url: string;
  /** Pull the token out of the page; null when it is not there (= shape changed). */
  token(html: string): string | null;
  /** Other facts from the same page (e.g. your user id, signed in or not). */
  vars?(html: string): Record<string, string | boolean | null>;
  header: string;
  /** "all": the site wants the token on every API call, reads too (Poshmark). Default: writes only. */
  sendOn?: "all" | "writes";
}
/** A read-only action (sign-in check, sales scan): no write, so nothing can be left half done. */
export type ReadOnlyPlan = (io: { ctx: Ctx; get<S>(p: ReadPlan<S>): Promise<S>; page(url: string): Promise<{ raw: string; url: string }> }) => Promise<RunOutcome>;
export interface MarketplaceSpec {
  marketplace: ExtMarketplace;
  bootstrap: Bootstrap | null;
  plans: Partial<Record<ActionRequest["action"], ActionPlan<unknown>>>;
  reads?: Partial<Record<ActionRequest["action"], ReadOnlyPlan>>;
  /** Hard off switch per marketplace (ships false until the plans are verified against a real recording). */
  enabled: boolean;
}
export interface Ctx { token: string | null; vars: Record<string, string | boolean | null>; a: ActionRequest; externalId: string | null }

export class ShapeChanged extends Error {}
const TIMEOUT_MS = 20_000;
const LOGIN = /\/(login|signup)(\/|\?|$)/i;

export function requestTransport(spec: MarketplaceSpec, fetcher: Fetcher, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Transport {
  const label = HOST_TABLE[spec.marketplace].label;
  let token: { v: string; vars: Ctx["vars"]; at: number } | null = null;

  async function call(h: Http, ctx: Ctx): Promise<{ status: number; raw: string; json: unknown }> {
    if (!isAllowedUrl(spec.marketplace, h.url)) throw new ShapeChanged(`refused a URL outside ${label}: ${h.url.slice(0, 80)}`);
    const headers: Record<string, string> = { accept: "application/json, text/html;q=0.8", ...(h.headers ?? {}) };
    if (spec.bootstrap && ctx.token && h.url !== spec.bootstrap.url && (h.method !== "GET" || spec.bootstrap.sendOn === "all")) headers[spec.bootstrap.header] = ctx.token;
    let body: string | undefined;
    if (h.body !== undefined) { body = JSON.stringify(h.body); headers["content-type"] = "application/json"; }
    const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = setTimeout(() => ac?.abort(), TIMEOUT_MS);
    try {
      const r = await fetcher(h.url, { method: h.method, credentials: "include", redirect: h.follow ? "follow" : "manual", headers, body, signal: ac?.signal });
      const raw = await r.text();
      const loc = r.headers.get("location") ?? "";
      // status 0 = an opaque redirect (redirect:"manual" in a browser hides where to); on an API call that is the login bounce.
      if (r.status === 0 || r.status === 401 || r.status === 403 || ((r.status === 301 || r.status === 302 || r.status === 303) && LOGIN.test(loc)) || LOGIN.test(r.url)) throw new Out("signed_out", `Signed out of ${label}. Sign in in this browser; waiting jobs then continue by themselves.`);
      if (r.status === 429) throw new Out("rate_limited", `${label} asked us to slow down`);
      if (r.status >= 500) throw new Out("unavailable", `${label} had a server problem (${r.status}); will retry`);
      if (r.status === 404) throw new Out("listing_not_found", `${label} says this listing does not exist`);
      if (r.status < 200 || r.status >= 300) throw new ShapeChanged(`${h.method} answered ${r.status}`);
      let json: unknown = null;
      if (/json/i.test(r.headers.get("content-type") ?? "")) { try { json = JSON.parse(raw); } catch { throw new ShapeChanged("bad JSON"); } }
      return { status: r.status, raw, json };
    } catch (e) {
      if (e instanceof Out || e instanceof ShapeChanged) throw e;
      if ((e as Error)?.name === "AbortError") throw new Out("timeout", `${label} took too long to answer`);
      throw new Out("network", `Could not reach ${label}: ${(e as Error)?.message ?? e}`);
    } finally { clearTimeout(t); }
  }
  async function bootstrap(ctx: Ctx) {
    const b = spec.bootstrap;
    if (!b) return;
    if (token && Date.now() - token.at < 10 * 60_000) { ctx.token = token.v; ctx.vars = token.vars; return; }
    const r = await call({ method: "GET", url: b.url, headers: { accept: "text/html" }, follow: true }, ctx);
    learn(r.raw, ctx);
  }
  function learn(raw: string, ctx: Ctx) {
    const b = spec.bootstrap!;
    const v = b.token(raw);
    if (!v) throw new ShapeChanged("no page token");
    const vars = b.vars?.(raw) ?? {};
    token = { v, vars, at: Date.now() }; ctx.token = v; ctx.vars = vars;
  }
  const read = async <S>(p: ReadPlan<S>, ctx: Ctx): Promise<S> => {
    const r = await call(p.request(ctx), ctx);
    try { return p.parse(r.json, r.raw); } catch (e) { throw new ShapeChanged(e instanceof SchemaError ? `unexpected answer: ${e.message}` : "unexpected answer"); }
  };

  return {
    name: "request",
    supports: (a) => spec.enabled && a.marketplace === spec.marketplace && !!(spec.plans[a.action] ?? spec.reads?.[a.action]),
    async run(a, opts = {}) {
      const plan = spec.plans[a.action];
      const ro = spec.reads?.[a.action];
      if (!spec.enabled || !(plan || ro)) return { ok: false, code: "not_supported", message: `No request plan for ${a.action}` };
      const ctx: Ctx = { token: null, vars: {}, a, externalId: typeof a.payload.externalId === "string" ? a.payload.externalId : null };
      let wrote = false;
      try {
        if (ro) {
          return await ro({
            ctx,
            get: (p) => bootstrap(ctx).then(() => read(p, ctx)),
            // A fresh page load (never cached); if it carries the token, remember it.
            page: async (url) => { const r = await call({ method: "GET", url, headers: { accept: "text/html" }, follow: true }, ctx); if (spec.bootstrap && url === spec.bootstrap.url) { try { learn(r.raw, ctx); } catch { /* the plan decides */ } } return { raw: r.raw, url }; },
          });
        }
        if (!plan) throw new ShapeChanged("no plan");
        await bootstrap(ctx);
        const before = await read(plan.read, ctx);
        const d = plan.decide(before, a);
        if (d === null) return { ok: true, result: { alreadyDone: true, note: "Already that way" } };
        if ("refuse" in d) return { ok: false, code: d.code ?? "unexpected_page", message: d.refuse };
        opts.onProgress?.("Saving");
        const w = await call(d.write, ctx);
        void w;
        wrote = true;
        // Verify with a fresh read (once more after a short pause: some sites save asynchronously).
        let after = await read(plan.read, ctx);
        if (!plan.verified(after, a)) { await sleep(1500); after = await read(plan.read, ctx); }
        if (!plan.verified(after, a)) throw new ShapeChanged("the change did not show after saving");
        return { ok: true, result: { note: `${d.note} (checked)` } };
      } catch (e) {
        if (e instanceof Out) return a.action === "checkLogin" && e.code === "signed_out" ? { ok: true, result: {}, loggedIn: false } : { ok: false, code: e.code, message: e.message };
        if (e instanceof ShapeChanged) {
          token = null;
          return { ok: false, code: "shape_changed", message: `${SHAPE_CHANGED_MESSAGE(label)} (${wrote ? "after a save; please check the listing" : "nothing was changed"}: ${e.message})`.slice(0, 480) };
        }
        return { ok: false, code: "action_failed", message: String((e as Error)?.message ?? e).slice(0, 300) };
      }
    },
  };
}
export class Out extends Error { constructor(readonly code: ResultCode, message: string) { super(message); } }
