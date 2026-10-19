// Poshmark actions, run inside a Poshmark tab one step at a time. Written defensively: every step first checks where it is
// (signed out? security check? the page we expected?) and stops with a clear "needs you" on anything unexpected. It never solves a
// captcha, never submits a new listing by itself, and only clicks controls it found by their visible text or label.
// NOT live-tested from our servers (nothing may run against marketplaces from there): verified against hand-written HTML fixtures,
// and needs David's manual smoke test with one test item before it is turned on (release-checklist.md).
import type { StepInput, StepResult } from "../steps";
import { stop } from "../steps";
import { byText, click, field, isoDay, money, norm, securityCheck, setValue, textOf } from "./dom";
import type { ExtScanSale } from "../../../src/lib/data/types";

type Page = "login" | "listing" | "edit" | "create" | "sales" | "closet" | "home" | "other";
export function pageOf(url: string): Page {
  let p: string;
  try { p = new URL(url).pathname; } catch { return "other"; }
  if (/^\/(login|signup)(\/|$)/.test(p)) return "login";
  if (/^\/edit-listing\//.test(p)) return "edit";
  if (/^\/listing\//.test(p)) return "listing";
  if (/^\/create-listing(\/|$)/.test(p)) return "create";
  if (/^\/order\/sales(\/|$)/.test(p)) return "sales";
  if (/^\/closet\//.test(p)) return "closet";
  if (p === "/" || /^\/feed(\/|$)/.test(p)) return "home";
  return "other";
}

/** Signed in (true), signed out (false) or can't tell (null), from the page header. */
export function signedIn(doc: Document): boolean | null {
  if (doc.querySelector('a[href*="logout"], a[href^="/user/account"]') || byText(doc, "a", /^my closet$/i).length) return true;
  if (doc.querySelector('a[href^="/login"], a[href*="/login?"]') || byText(doc, "a, button", /^(log ?in|sign ?up)$/i).length) return false;
  return null;
}
const notFound = (doc: Document) => /page (was )?not found|this listing (is )?no longer available|listing not found|we couldn'?t find/i.test(textOf(doc.body));
const soldBadge = (doc: Document) => byText(doc, '[data-test*="sold" i], .sold-tag, .sold, span, div', /^sold$/i).length > 0;
const isNotForSale = (doc: Document) => /\bnot for sale\b/i.test(textOf(doc.body));
const saveButton = (doc: Document) => byText<HTMLElement>(doc, 'button, input[type="submit"], [role="button"]', /^(update|save|save changes|done)$/i)[0]
  ?? Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="submit"]')).find((i) => /^(update|save)$/i.test(i.value)) ?? null;
const formError = (doc: Document) => textOf(doc.querySelector('[role="alert"], .form__error, .error-message, .error'));

/** Set "Availability" to "Not For Sale". Native <select> first, then a custom dropdown (two steps). */
function setNotForSale(doc: Document, phase: string): StepResult | "already" | null {
  const sel = Array.from(doc.querySelectorAll<HTMLSelectElement>("select")).find((s) => Array.from(s.options).some((o) => /not for sale/i.test(o.text)));
  if (sel) {
    const opt = Array.from(sel.options).find((o) => /not for sale/i.test(o.text))!;
    if (sel.selectedOptions[0] && /not for sale/i.test(sel.selectedOptions[0].text)) return "already";
    setValue(sel, opt.value);
    return null;
  }
  const option = byText<HTMLElement>(doc, '[role="option"], li, a, button, div, span', /^not for sale$/i)[0];
  if (phase === "pick") {
    if (!option) return stop("unexpected_page", "Opened the Availability menu but found no \"Not For Sale\" choice");
    click(option);
    return null;
  }
  const cands = byText<HTMLElement>(doc, '[role="combobox"], [role="button"], button, div, span', /^(for sale|not for sale)$/i);
  const current = cands.filter((el) => !cands.some((o) => o !== el && el.contains(o))) // the innermost one is the real control
    .find((el) => /availability/i.test(textOf(el.parentElement?.parentElement ?? el.parentElement)));
  if (current && /^not for sale$/i.test(textOf(current))) return "already";
  if (!current) return stop("unexpected_page", "Could not find the Availability setting on the edit page");
  click(current);
  return { kind: "wait", phase: "pick", ms: 800 };
}

function availabilityStep(doc: Document, page: Page, phase: string, note: string): StepResult {
  if (page === "listing") {
    if (soldBadge(doc)) return { kind: "done", result: { alreadyDone: true, note: "Already sold on Poshmark" } };
    if (phase === "saved" || phase === "start") {
      if (isNotForSale(doc)) return { kind: "done", result: { alreadyDone: phase === "start", note } };
      if (phase === "saved") return stop("unexpected_page", "Saved, but the listing does not show \"Not For Sale\". Please check it.");
    }
    return { kind: "goto", page: "edit", phase: "start" };
  }
  if (page !== "edit") return stop("unexpected_page", `Expected the edit page, got ${page}`);
  if (phase === "saved") {
    const err = formError(doc);
    return err ? stop("rejected", `Poshmark said: ${err.slice(0, 200)}`) : stop("unexpected_page", "Pressed Update but stayed on the edit page");
  }
  const r = setNotForSale(doc, phase);
  if (r === "already") return { kind: "done", result: { alreadyDone: true, note: "Already Not For Sale" } };
  if (r) return r;
  const save = saveButton(doc);
  if (!save) return stop("unexpected_page", "Could not find the Update button");
  click(save);
  return { kind: "wait", phase: "saved", ms: 5000 };
}

function setIfDifferent(el: HTMLInputElement | HTMLTextAreaElement | null, v: unknown): "missing" | "same" | "changed" {
  if (v === undefined || v === null) return "same";
  if (!el) return "missing";
  const s = String(v);
  if (norm(el.value) === norm(s)) return "same";
  setValue(el, s);
  return "changed";
}
const priceField = (doc: Document) =>
  field(doc, "input", /listing price/i) ?? Array.from(doc.querySelectorAll<HTMLInputElement>("input")).find((i) => {
    const hay = `${i.name} ${i.id} ${i.getAttribute("aria-label") ?? ""} ${i.placeholder}`;
    return /price/i.test(hay) && !/original/i.test(hay);
  }) ?? null;

function editFieldsStep(doc: Document, page: Page, phase: string, p: Record<string, unknown>, quantityOnly: boolean): StepResult {
  if (phase === "saved") {
    if (page === "listing") return { kind: "done", result: { note: "Saved" } };
    const err = page === "edit" ? formError(doc) : "";
    return err ? stop("rejected", `Poshmark said: ${err.slice(0, 200)}`) : stop("unexpected_page", "Could not confirm the change was saved");
  }
  if (page === "listing") return { kind: "goto", page: "edit", phase: "start" };
  if (page !== "edit") return stop("unexpected_page", `Expected the edit page, got ${page}`);
  const results = quantityOnly
    ? [setIfDifferent(field(doc, "input", /quantity|qty/i), p.quantity)]
    : [
        setIfDifferent(field(doc, "input", /title|what are you selling/i), p.title),
        setIfDifferent(field<HTMLTextAreaElement>(doc, "textarea", /descri/i), p.description),
        setIfDifferent(priceField(doc), p.price),
      ];
  if (results.includes("missing")) return stop("unexpected_page", "Could not find a field to change on the edit page");
  if (!results.includes("changed")) return { kind: "done", result: { alreadyDone: true, note: "Nothing to change" } };
  const save = saveButton(doc);
  if (!save) return stop("unexpected_page", "Could not find the Update button");
  click(save);
  return { kind: "wait", phase: "saved", ms: 5000 };
}

function createStep(doc: Document, page: Page, p: Record<string, unknown>): StepResult {
  if (page !== "create") return stop("unexpected_page", `Expected the new listing page, got ${page}`);
  const set = (el: HTMLInputElement | HTMLTextAreaElement | null, v: unknown) => { if (el && v !== undefined && v !== null) setValue(el, String(v)); return !!el; };
  if (!set(field(doc, "input", /title|what are you selling/i), p.title)) return stop("unexpected_page", "Could not find the title field");
  set(field<HTMLTextAreaElement>(doc, "textarea", /descri/i), p.description);
  set(priceField(doc), p.price);
  set(field(doc, "input", /original/i), p.originalPrice);
  set(field(doc, "input", /brand/i), p.brand);
  // Never press "List" ourselves: photos, category and size need you, and a new listing is the step to double-check.
  return stop("review_and_submit", "Draft filled in a Poshmark tab: add photos, category and size, check everything, then press List.", true);
}

/** Sales page -> sales newer than the cursor (minus a 1-day overlap; the server drops duplicates). */
export function parseSales(doc: Document, cursor: string | null, limit: number): { sales: ExtScanSale[]; nextCursor: string | null } {
  const seen = new Map<string, ExtScanSale>();
  for (const a of Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href*="/order/sales/"]'))) {
    const id = /\/order\/sales\/([A-Za-z0-9_-]{4,40})/.exec(a.getAttribute("href") ?? "")?.[1];
    if (!id || seen.has(id)) continue;
    let row: Element = a;
    for (let i = 0; i < 6 && row.parentElement && !(money(textOf(row)) !== null && isoDay(textOf(row))); i++) row = row.parentElement;
    const t = textOf(row);
    const soldAt = isoDay(t), price = money(t);
    if (!soldAt || price === null) continue;
    const listing = Array.from(row.querySelectorAll("a[href*='/listing/']")).map((x) => /([a-f0-9]{24})(?:[/?#]|$)/i.exec(x.getAttribute("href") ?? "")?.[1]).find(Boolean) ?? null;
    const title = textOf(row.querySelector('[data-test*="title" i], .title, h3, h4')) || textOf(a) || null;
    seen.set(id, { orderId: id, soldAt, price, title: title ? title.slice(0, 200) : null, externalListingId: listing, ...(/\b(cancel+ed|refunded)\b/i.test(t) ? { cancelled: true } : {}) });
  }
  const since = cursor && !Number.isNaN(Date.parse(cursor)) ? new Date(Date.parse(cursor) - 86_400_000).toISOString().slice(0, 10) : null;
  const sales = [...seen.values()].filter((s) => !since || s.soldAt >= since).sort((a, b) => a.soldAt.localeCompare(b.soldAt)).slice(0, limit);
  const newest = sales.reduce<string | null>((m, s) => (!m || s.soldAt > m ? s.soldAt : m), null);
  const nextCursor = newest && (!cursor || `${newest}T00:00:00.000Z` > cursor) ? `${newest}T00:00:00.000Z` : null;
  return { sales, nextCursor };
}

export function poshmarkStep(doc: Document, input: StepInput): StepResult {
  const page = pageOf(input.url);
  const check = securityCheck(doc);
  if (check) return stop(check, check === "captcha" ? "Poshmark is showing a captcha. Solve it in that tab; we paused instead of trying." : "Poshmark asked to verify it's you. Do that in the tab, then retry.", true);
  if (page === "login") {
    if (input.action === "checkLogin") return { kind: "done", loggedIn: false };
    return stop("signed_out", "Signed out of Poshmark. Sign in in this browser; waiting jobs then continue by themselves.");
  }
  if (notFound(doc)) return stop("listing_not_found", "Poshmark says this page or listing does not exist. Check it, then use Mark delisted or Retry.");
  const auth = signedIn(doc);
  if (input.action === "checkLogin") {
    if (auth === null) return stop("unexpected_page", "Could not tell whether you are signed in to Poshmark");
    return { kind: "done", loggedIn: auth };
  }
  if (auth === false) return stop("signed_out", "Signed out of Poshmark. Sign in in this browser; waiting jobs then continue by themselves.");
  const p = input.payload;
  switch (input.action) {
    case "delist": return availabilityStep(doc, page, input.phase, "Set to Not For Sale");
    case "markSold": return availabilityStep(doc, page, input.phase, "Set to Not For Sale (sold elsewhere)");
    case "updateQuantity":
      return p.quantity === 0 ? availabilityStep(doc, page, input.phase, "Quantity 0: set to Not For Sale") : editFieldsStep(doc, page, input.phase, p, true);
    case "updateListing": return editFieldsStep(doc, page, input.phase, p, false);
    case "createListing": return createStep(doc, page, p);
    case "getSales": {
      if (page !== "sales") return stop("unexpected_page", `Expected your sales page, got ${page}`);
      if (auth === null) return stop("unexpected_page", "Could not tell whether you are signed in to Poshmark");
      const r = parseSales(doc, (p.cursor as string | null | undefined) ?? null, (p.limit as number | undefined) ?? 50);
      return { kind: "done", loggedIn: true, sales: r.sales, nextCursor: r.nextCursor };
    }
    case "getListings": {
      if (page === "home" || page === "other") {
        const href = byText<HTMLAnchorElement>(doc, 'a[href^="/closet/"]', /my closet/i)[0]?.getAttribute("href") ?? doc.querySelector('a[href^="/closet/"]')?.getAttribute("href");
        const user = /^\/closet\/([A-Za-z0-9_.-]{1,60})/.exec(href ?? "")?.[1];
        return user ? { kind: "goto", page: "closet", phase: "list", user } : stop("unexpected_page", "Could not find your closet link");
      }
      if (page !== "closet") return stop("unexpected_page", `Expected your closet, got ${page}`);
      const ids = new Set(Array.from(doc.querySelectorAll("a[href*='/listing/']")).map((a) => /([a-f0-9]{24})(?:[/?#]|$)/i.exec(a.getAttribute("href") ?? "")?.[1]).filter(Boolean));
      return { kind: "done", result: { note: `${ids.size} listings seen on the first closet page` } };
    }
  }
}
