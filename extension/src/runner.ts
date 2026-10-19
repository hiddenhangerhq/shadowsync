// Runs ONE validated action in a marketplace tab, step by step. Browser access goes through the small `Browser` interface so the
// rules are unit-tested with a fake. Rules: URLs come only from the host table; the tab must stay on an allowed host; a sign-in page
// means signed_out; a step limit and timeouts stop runaway pages; tabs we opened are closed (unless you need to finish something).
import { HOST_TABLE, POSHMARK, isAllowedUrl, type ActionRequest, type ExtMarketplace, type ResultCode } from "../../src/lib/ext/protocol";
import type { ExtScanSale } from "../../src/lib/data/types";
import type { DoneResult, PageName, StepInput, StepResult } from "./steps";

export interface Browser {
  /** Open a background tab (never steals focus). */
  open(url: string): Promise<number>;
  navigate(tabId: number, url: string): Promise<void>;
  /** Resolves when the tab finished loading; rejects on timeout. */
  waitLoaded(tabId: number, timeoutMs: number): Promise<void>;
  url(tabId: number): Promise<string>;
  step(tabId: number, input: Omit<StepInput, "url">): Promise<StepResult>;
  close(tabId: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  hasPermission(m: ExtMarketplace): Promise<boolean>;
}
export type RunOutcome =
  | { ok: true; result: DoneResult; loggedIn?: boolean; sales?: ExtScanSale[]; nextCursor?: string | null }
  | { ok: false; code: ResultCode; message: string };

export const MAX_STEPS = 8;
const LOAD_TIMEOUT_MS = 45_000;

/** The page an action starts on. */
function firstPage(a: ActionRequest): PageName {
  switch (a.action) {
    case "checkLogin": case "getListings": return "home";
    case "createListing": return "create";
    case "getSales": return "sales";
    default: return "edit";
  }
}
/** URL for a named page, built from the table (Poshmark is the only marketplace with action code so far). */
export function pageUrl(m: ExtMarketplace, page: PageName, a: ActionRequest, user?: string): string | null {
  if (m !== "poshmark") return null;
  const id = typeof a.payload.externalId === "string" ? a.payload.externalId : null;
  switch (page) {
    case "home": return POSHMARK.home();
    case "create": return POSHMARK.create();
    case "sales": return POSHMARK.sales();
    case "closet": return user ? POSHMARK.closet(user) : null;
    case "edit": return id ? POSHMARK.edit(id) : null;
    case "listing": return id ? POSHMARK.listing(id) : null;
  }
}

export async function runAction(b: Browser, a: ActionRequest, opts: { onProgress?: (m: string) => void } = {}): Promise<RunOutcome> {
  const m = a.marketplace;
  if (!HOST_TABLE[m].supported) return { ok: false, code: "not_supported", message: `${HOST_TABLE[m].label} is not supported by the extension yet` };
  if (!(await b.hasPermission(m))) return { ok: false, code: "permission_missing", message: `Press Connect for ${HOST_TABLE[m].label} in the extension popup` };
  const start = pageUrl(m, firstPage(a), a);
  if (!start || !isAllowedUrl(m, start)) return { ok: false, code: "url_not_allowed", message: "No allowed page for this action" };
  let tab: number | null = null;
  let keep = false;
  try {
    tab = await b.open(start);
    let phase = "start";
    for (let i = 0; i < MAX_STEPS; i++) {
      try { await b.waitLoaded(tab, LOAD_TIMEOUT_MS); } catch { return { ok: false, code: "timeout", message: `${HOST_TABLE[m].label} took too long to load` }; }
      const here = await b.url(tab);
      if (!isAllowedUrl(m, here)) return { ok: false, code: "unexpected_page", message: `The tab left ${HOST_TABLE[m].label} (now on another site). Stopped.` };
      const r = await b.step(tab, { action: a.action, marketplace: m, payload: a.payload, phase });
      if (r.kind === "done") return { ok: true, result: r.result ?? {}, loggedIn: r.loggedIn, sales: r.sales, nextCursor: r.nextCursor };
      if (r.kind === "stop") { keep = !!r.keepTab; return { ok: false, code: r.code, message: r.message }; }
      if (r.kind === "goto") {
        const next = pageUrl(m, r.page, a, r.user);
        if (!next || !isAllowedUrl(m, next)) return { ok: false, code: "url_not_allowed", message: `No allowed URL for page "${r.page}"` };
        opts.onProgress?.(`Opening ${r.page}`);
        await b.navigate(tab, next);
        phase = r.phase;
        continue;
      }
      opts.onProgress?.(`Waiting (${r.phase})`);
      await b.sleep(Math.min(Math.max(r.ms, 200), 10_000));
      phase = r.phase;
    }
    return { ok: false, code: "unexpected_page", message: `Gave up after ${MAX_STEPS} steps without a clear result` };
  } catch (e) {
    return { ok: false, code: "action_failed", message: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  } finally {
    if (tab !== null && !keep) await b.close(tab).catch(() => undefined);
  }
}
