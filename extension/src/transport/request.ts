// The generic request engine (no marketplace specifics). A write action = fresh page token -> read (GET, check its shape) -> already
// right? done -> ONE write -> verify with a fresh read. Anything unexpected (status, content type, JSON shape, an error object in a
// 200 answer, a verify that does not show the change) is "shape_changed": the worker pauses that marketplace and the dashboard says so.
// There is never a second write in one action, except a flow's declared fallback (Poshmark: delete refused -> Not For Sale), and
// only when a fresh read shows the first write changed nothing. A write whose verify fails is reported, not retried.
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
export type Decision = { write: Http; note: string } | null | { refuse: string; code?: ResultCode };
export interface ActionPlan<S> {
  read: ReadPlan<S>;
  /** null = already in the wanted state (done, nothing written). refuse = needs you (e.g. Single Item quantity). */
  decide(current: S, a: ActionRequest): Decision;
  /** Does a fresh read show the change? */
  verified(after: S, a: ActionRequest): boolean;
}
export interface Bootstrap {
  url: string;
  /** Tried when `url` has no token (e.g. a page redesign). */
  fallbackUrl?: string;
  /** Pull the token out of the page; null when it is not there (= shape changed). */
  token(html: string): string | null;
  /** Other facts from the same page (e.g. your user id, signed in or not). */
  vars?(html: string): Record<string, string | boolean | null>;
  header: string;
  /** "all": the site wants the token on every API call, reads too (Poshmark). Default: writes only. */
  sendOn?: "all" | "writes";
}
/** A read-only action (sign-in check, sales scan, listing check): no write, so nothing can be left half done. */
export type ReadOnlyPlan = (io: { ctx: Ctx; get<S>(p: ReadPlan<S>): Promise<S>; tryGet<S>(p: ReadPlan<S>): Promise<S | null>; page(url: string): Promise<{ raw: string; url: string }>; sleep(ms: number): Promise<void> }) => Promise<RunOutcome>;
/** A write flow with its own steps (delete with a Not For Sale fallback). Same rules: fresh reads around every write. */
export type FlowPlan = (io: {
  ctx: Ctx; a: ActionRequest;
  get<S>(p: ReadPlan<S>): Promise<S>;
  /** null when the thing is gone (404). */
  tryGet<S>(p: ReadPlan<S>): Promise<S | null>;
  /** One write. Returns null when the site refused it (4xx or an error answer) so the flow may fall back; throws on anything else. */
  write(h: Http, opts?: { refusable?: boolean }): Promise<{ refused: string } | null>;
  sleep(ms: number): Promise<void>;
  progress(m: string): void;
}) => Promise<RunOutcome>;
export interface MarketplaceSpec {
  marketplace: ExtMarketplace;
  bootstrap: Bootstrap | null;
  plans: Partial<Record<ActionRequest["action"], ActionPlan<unknown>>>;
  flows?: Partial<Record<ActionRequest["action"], FlowPlan>>;
  reads?: Partial<Record<ActionRequest["action"], ReadOnlyPlan>>;
  /** An error object inside a 2xx answer -> what it means (null = not an error). */
  bodyError?(json: unknown): { code: ResultCode | "shape_changed"; message: string } | null;
  /** Hard off switch per marketplace. */
  enabled: boolean;
}
export interface Ctx { token: string | null; vars: Record<string, string | boolean | null>; a: ActionRequest; externalId: string | null }

export class ShapeChanged extends Error {}
export class Out extends Error { constructor(readonly code: ResultCode, message: string, readonly retryAfterMs: number | null = null) { super(message); } }
class Refused extends Error {}
const TIMEOUT_MS = 20_000;
const LOGIN = /\/(login|signup)(\/|\?|$)/i;
/** Retry-After: seconds or an HTTP date -> ms (null if absent or nonsense). */
export function retryAfterMs(h: string | null, now = Date.now()): number | null {
  if (!h) return null;
  if (/^\d{1,6}$/.test(h.trim())) return Number(h.trim()) * 1000;
  const t = Date.parse(h);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

export function requestTransport(spec: MarketplaceSpec, fetcher: Fetcher, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Transport {
  const label = HOST_TABLE[spec.marketplace].label;
  let token: { v: string; vars: Ctx["vars"]; at: number } | null = null;

  async function call(h: Http, ctx: Ctx, opts: { refusable?: boolean } = {}): Promise<{ status: number; raw: string; json: unknown }> {
    if (!isAllowedUrl(spec.marketplace, h.url)) throw new ShapeChanged(`refused a URL outside ${label}: ${h.url.slice(0, 80)}`);
    const headers: Record<string, string> = { accept: "application/json, text/html;q=0.8", ...(h.headers ?? {}) };
    const b = spec.bootstrap;
    if (b && ctx.token && h.url !== b.url && h.url !== b.fallbackUrl && (h.method !== "GET" || b.sendOn === "all")) headers[b.header] = ctx.token;
    let body: string | undefined;
    if (h.body !== undefined) { body = JSON.stringify(h.body); headers["content-type"] = "application/json"; }
    const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = setTimeout(() => ac?.abort(), TIMEOUT_MS);
    try {
      const r = await fetcher(h.url, { method: h.method, credentials: "include", redirect: h.follow ? "follow" : "manual", headers, body, signal: ac?.signal });
      const raw = await r.text();
      const loc = r.headers.get("location") ?? "";
      const out = `Signed out of ${label}. Sign in in this browser; waiting jobs then continue by themselves.`;
      // status 0 = an opaque redirect (redirect:"manual" in a browser hides where to); on an API call that is the login bounce.
      if (r.status === 0 || r.status === 401 || ((r.status === 301 || r.status === 302 || r.status === 303) && LOGIN.test(loc)) || LOGIN.test(r.url)) throw new Out("signed_out", out);
      // 403 while the page said you are signed in = the site refused this call (not a sign-out): treat as changed, never as "signed out".
      if (r.status === 403) { if (ctx.vars.loggedIn === true) { if (opts.refusable) throw new Refused("refused (403)"); throw new ShapeChanged(`${h.method} refused (403)`); } throw new Out("signed_out", out); }
      if (r.status === 429) { const ms = retryAfterMs(r.headers.get("retry-after")); throw new Out("rate_limited", `${label} asked us to slow down${ms ? ` (wait ${Math.ceil(ms / 60_000)} min)` : ""}`, ms); }
      if (r.status >= 500) throw new Out("unavailable", `${label} had a server problem (${r.status}); will retry`);
      if (r.status === 404) throw new Out("listing_not_found", `${label} says this listing does not exist`);
      if (r.status < 200 || r.status >= 300) { if (opts.refusable && r.status >= 400) throw new Refused(`answered ${r.status}`); throw new ShapeChanged(`${h.method} answered ${r.status}`); }
      let json: unknown = null;
      if (/json/i.test(r.headers.get("content-type") ?? "")) { try { json = JSON.parse(raw); } catch { throw new ShapeChanged("bad JSON"); } }
      const err = json !== null ? spec.bodyError?.(json) : null;
      if (err) {
        if (opts.refusable && err.code === "shape_changed") throw new Refused(err.message);
        if (err.code === "shape_changed") throw new ShapeChanged(err.message);
        throw new Out(err.code, err.message);
      }
      return { status: r.status, raw, json };
    } catch (e) {
      if (e instanceof Out || e instanceof ShapeChanged || e instanceof Refused) throw e;
      if ((e as Error)?.name === "AbortError") throw new Out("timeout", `${label} took too long to answer`);
      throw new Out("network", `Could not reach ${label}: ${(e as Error)?.message ?? e}`);
    } finally { clearTimeout(t); }
  }
  /** fresh = always load the page (every write gets a token read just before it; reads may reuse one for 10 minutes). */
  async function bootstrap(ctx: Ctx, fresh = false) {
    const b = spec.bootstrap;
    if (!b) return;
    if (!fresh && token && Date.now() - token.at < 10 * 60_000) { ctx.token = token.v; ctx.vars = token.vars; return; }
    const r = await call({ method: "GET", url: b.url, headers: { accept: "text/html" }, follow: true }, ctx);
    if (b.token(r.raw) || !b.fallbackUrl) return learn(r.raw, ctx);
    const r2 = await call({ method: "GET", url: b.fallbackUrl, headers: { accept: "text/html" }, follow: true }, ctx);
    learn(r2.raw, ctx);
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
  const tryRead = async <S>(p: ReadPlan<S>, ctx: Ctx): Promise<S | null> => {
    try { return await read(p, ctx); } catch (e) { if (e instanceof Out && e.code === "listing_not_found") return null; throw e; }
  };

  return {
    name: "request",
    supports: (a) => spec.enabled && a.marketplace === spec.marketplace && !!(spec.plans[a.action] ?? spec.flows?.[a.action] ?? spec.reads?.[a.action]),
    async run(a, opts = {}) {
      const plan = spec.plans[a.action], flow = spec.flows?.[a.action], ro = spec.reads?.[a.action];
      if (!spec.enabled || !(plan || flow || ro)) return { ok: false, code: "not_supported", message: `No request plan for ${a.action}` };
      const ctx: Ctx = { token: null, vars: {}, a, externalId: typeof a.payload.externalId === "string" ? a.payload.externalId : null };
      let wrote = false;
      try {
        if (ro) {
          return await ro({
            ctx, sleep,
            get: (p) => bootstrap(ctx).then(() => read(p, ctx)),
            tryGet: (p) => bootstrap(ctx).then(() => tryRead(p, ctx)),
            // A fresh page load (never cached); if it carries the token, remember it.
            page: async (url) => { const r = await call({ method: "GET", url, headers: { accept: "text/html" }, follow: true }, ctx); if (spec.bootstrap && url === spec.bootstrap.url) { try { learn(r.raw, ctx); } catch { /* the plan decides */ } } return { raw: r.raw, url }; },
          });
        }
        await bootstrap(ctx, true);
        if (flow) {
          let writes = 0;
          return await flow({
            ctx, a, sleep, progress: (m) => opts.onProgress?.(m),
            get: (p) => read(p, ctx), tryGet: (p) => tryRead(p, ctx),
            async write(h, o = {}) {
              if (++writes > 2) throw new ShapeChanged("a flow tried a third write");
              try { await call(h, ctx, { refusable: !!o.refusable }); wrote = true; return null; }
              catch (e) { if (e instanceof Refused) return { refused: e.message }; wrote = true; throw e; }
            },
          });
        }
        if (!plan) throw new ShapeChanged("no plan");
        const before = await read(plan.read, ctx);
        const d = plan.decide(before, a);
        if (d === null) return { ok: true, result: { alreadyDone: true, note: "Already that way" } };
        if ("refuse" in d) return { ok: false, code: d.code ?? "unexpected_page", message: d.refuse };
        opts.onProgress?.("Saving");
        wrote = true;
        await call(d.write, ctx);
        // Verify with a fresh read (once more after a short pause: some sites save asynchronously).
        let after = await read(plan.read, ctx);
        if (!plan.verified(after, a)) { await sleep(1500); after = await read(plan.read, ctx); }
        if (!plan.verified(after, a)) throw new ShapeChanged("the change did not show after saving");
        return { ok: true, result: { note: `${d.note} (checked)` } };
      } catch (e) {
        if (e instanceof Out) {
          if (a.action === "checkLogin" && e.code === "signed_out") return { ok: true, result: {}, loggedIn: false };
          return { ok: false, code: e.code, message: wrote && e.code !== "rate_limited" ? `${e.message} (after a save; please check the listing)` : e.message, ...(e.retryAfterMs !== null ? { retryAfterMs: e.retryAfterMs } : {}) };
        }
        if (e instanceof ShapeChanged) {
          token = null;
          return { ok: false, code: "shape_changed", message: `${SHAPE_CHANGED_MESSAGE(label)} (${wrote ? "after a save; please check the listing" : "nothing was changed"}: ${e.message})`.slice(0, 480) };
        }
        return { ok: false, code: "action_failed", message: String((e as Error)?.message ?? e).slice(0, 300) };
      }
    },
  };
}
