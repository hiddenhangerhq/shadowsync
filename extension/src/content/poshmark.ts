// Poshmark actions, run inside a Poshmark tab one step at a time. Written defensively: every step first checks where it is
// (signed out? security check? the page we expected?) and stops with a clear "needs you" on anything unexpected. It never solves a
// captcha, never submits a new listing by itself, and only clicks controls it found by their visible text or label.
// NOT live-tested from our servers (nothing may run against marketplaces from there): verified against hand-written HTML fixtures,
// and needs David's manual smoke test with one test item before it is turned on (release-checklist.md).
import type { StepInput, StepResult } from "../steps";
import { stop } from "../steps";
import { byText, click, field, isoDay, money, norm, securityCheck, setValue, textOf, typeValue } from "./dom";
import type { ExtScanSale } from "../../../src/lib/data/types";

type Page = "login" | "listing" | "edit" | "create" | "sales" | "closet" | "home" | "other";
export function pageOf(url: string): Page {
  let p: string, qs: URLSearchParams;
  try { const u = new URL(url); p = u.pathname.replace(/\/+$/, "") || "/"; qs = u.searchParams; } catch { return "other"; }
  if (/^\/(login|signup)(\/|$)/.test(p)) return "login";
  if (/^\/edit-listing\//.test(p)) return "edit";
  if (/^\/listing\//.test(p)) return "listing";
  if (/^\/create-listing(\/|$)/.test(p)) return "create";
  // My Sales: /order/sales (and any redirect variant: /order/sales?..., /my-sales, /account/sales, /sales). The closet's sold view
  // (/closet/<you>?availability=sold_out) counts as the sales page too, but carries no order links, so it simply reports none.
  if (/^\/(order\/sales|sales|my-?sales|account\/sales|order\/my-?sales)(\/|$)/i.test(p)) return "sales";
  if (/^\/closet\//.test(p) && /^sold/i.test(qs.get("availability") ?? "")) return "sales";
  if (/^\/closet\//.test(p)) return "closet";
  if (p === "/" || /^\/feed(\/|$)/.test(p)) return "home";
  return "other";
}

/** Signed in (true), signed out (false) or can't tell (null), from the page header. */
const pathOf = (url: string) => { try { return new URL(url).pathname.slice(0, 80); } catch { return "an unknown page"; } };
export function signedIn(doc: Document): boolean | null {
  if (doc.querySelector('a[href*="logout"], a[href^="/user/account"], a[href="/news"]')
      || byText(doc, 'a, button, [role="menuitem"]', /^(my closet|my likes|log ?out|sign ?out|account settings|my sales)$/i).length) return true;
  if (doc.querySelector('a[href^="/login"], a[href*="/login?"]') || byText(doc, "a, button", /^(log ?in|sign ?up)$/i).length) return false;
  return null;
}
// ---- The real Edit Listing page (saved by David, Oct 2026; scrubbed copy in tests/fixtures/poshmark/edit-real.html). A Vue form:
// fields carry data-vv-name, buttons and menu items carry data-et-name (analytics names, stable across restyles), and every modal is
// rendered up front, closed, and gets the class "modal--in" when it opens. We key on those attributes, never on layout classes.
// Quantity: a "Single Item" listing has NO quantity field at all (only the Single/Multi Item buttons); a quantity box exists only
// for Multi Item listings (not in the saved page, so it is matched loosely and anything odd stops for you).
const REAL = {
  title: 'input[data-vv-name="title"]',
  description: 'textarea[data-vv-name="description"]',
  price: 'input[data-vv-name="listingPrice"]', // the Listing Price (never data-vv-name="originalPrice")
  /** Focusing the Listing Price opens a "Listing Price" window (Smart Sell) with its own box and a Done button. */
  priceModalInput: '#listing-price-modal-listing-price-input',
  quantity: 'input[data-vv-name*="quantity" i], input[name*="quantity" i], input[aria-label*="quantity" i]',
  qtySection: '[data-et-name="listingEditorQuanititySection"], [data-et-name="listingEditorQuantitySection"]',
  single: 'button[data-et-name="one"]',
  multi: 'button[data-et-name="multiple"]',
  availability: '[data-et-name="listingEditorAvailabilitySection"]',
  notForSale: '[data-et-name="not_for_sale"]',
  update: 'button[data-et-name="update"]',
  del: '[data-et-name="delete"]',
} as const;
const q = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel);
const MODAL = '[data-test="modal-container"]';
/** The open modal: on the real page the one with "modal--in"; on simpler pages a dialog that is not hidden. */
const openModal = (doc: Document): HTMLElement | null => {
  const real = Array.from(doc.querySelectorAll<HTMLElement>(MODAL));
  if (real.length) return real.find((m) => m.classList.contains("modal--in")) ?? null;
  return Array.from(doc.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], .modal')).find((d) => !d.hidden) ?? null;
};
/** Page text without closed modals and closed menus (the real page carries "Not For Sale", "Delete" and error texts in them). */
function pageText(doc: Document): string {
  if (!doc.body) return "";
  const c = doc.body.cloneNode(true) as HTMLElement;
  c.querySelectorAll(`${MODAL}:not(.modal--in), [data-test="modal"]:not(.modal-backdrop--in), [data-test="dropdown_menu_list"]`).forEach((e) => e.remove());
  return textOf(c);
}
const modalSays = (m: HTMLElement) => {
  const t = textOf(m.querySelector('[data-test="modal-title"]')), b = textOf(m.querySelector('[data-test="modal-body"]')) || textOf(m);
  return (t && !b.startsWith(t) ? `${t}: ${b}` : b).slice(0, 220);
};
/** Current Availability on the real page ("For Sale" / "Not For Sale"), or null when the control is not there. */
const availabilityNow = (doc: Document) => { const s = q(doc, REAL.availability); return s ? textOf(q(s, '[data-test="dropdown-container"]') ?? s) : null; };
const num = (v: string) => { const n = Number(v.replace(/[^0-9.]/g, "")); return v.trim() && Number.isFinite(n) ? n : null; };

const notFound = (doc: Document) => /page (was )?not found|this listing (is )?no longer available|listing not found|we couldn'?t find/i.test(pageText(doc));
const soldBadge = (doc: Document) => byText(doc, '[data-test*="sold" i], .sold-tag, .sold, span, div', /^sold$/i).length > 0;
const isNotForSale = (doc: Document) => /\bnot for sale\b/i.test(pageText(doc));
const saveButton = (doc: Document) => q<HTMLElement>(doc, REAL.update) ?? byText<HTMLElement>(doc, 'button, input[type="submit"], [role="button"]', /^(update|save|save changes|done)$/i)[0]
  ?? Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="submit"]')).find((i) => /^(update|save)$/i.test(i.value)) ?? null;
/** A visible form error: the real page keeps its ".form__error-message" lines hidden with display:none until one applies. */
const formError = (doc: Document) => {
  const el = Array.from(doc.querySelectorAll<HTMLElement>('[role="alert"], .form__error, .form__error-message, .error-message, .error'))
    .find((e) => e.style.display !== "none" && !e.hidden && textOf(e));
  return el ? textOf(el) : "";
};

/** Set "Availability" to "Not For Sale". Native <select> first, then a custom dropdown (two steps). */
function setNotForSale(doc: Document, phase: string): StepResult | "already" | null {
  const section = q(doc, REAL.availability);
  if (section) {
    if (phase === "picked") return null; // the caller checks it took, then saves
    if (/^not for sale$/i.test(availabilityNow(doc) ?? "")) return "already";
    const opt = q<HTMLElement>(section, REAL.notForSale);
    if (!opt) return stop("unexpected_page", "Found the Availability menu but no \"Not For Sale\" choice");
    if (phase !== "pick") { click(q<HTMLElement>(section, '[data-test="dropdown"]') ?? section); return { kind: "wait", phase: "pick", ms: 800 }; }
    click(opt);
    return { kind: "wait", phase: "picked", ms: 700 };
  }
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

// ---- Delete (after a confirmed sale) with a Not For Sale fallback. Phases: start -> del_confirm -> del_done; a fallback re-opens the edit
// page with phase "fb-<reason>-start" and runs the Not For Sale steps, reporting `fallback` so the server lists it as "Sold but still active".
const FALLBACK: Record<string, string> = {
  offer: "Poshmark blocked the delete (an offer, order or sold lock is pending)",
  nodelete: "Poshmark showed no Delete option for this listing",
  refused: "Poshmark refused the delete",
};
const BLOCKED = /\b(active|pending|open) offers?\b|offer (is )?pending|can'?t (be )?delete|cannot (be )?delete|unable to delete|not able to delete|has (an )?(open|pending) order/i;
const deleteButton = (doc: Document) => q<HTMLElement>(doc, REAL.del) ?? byText<HTMLElement>(doc, 'button, a, [role="button"]', /^delete( (this )?listing)?$/i)[0] ?? null;
const dialog = openModal;
const fallbackTo = (code: keyof typeof FALLBACK): StepResult => ({ kind: "goto", page: "edit", phase: `fb-${code}-start` });

function deleteStep(doc: Document, page: Page, phase: string): StepResult {
  if (phase === "del_done") {
    // Gone: Poshmark sends you to your closet/feed, or the listing page no longer exists.
    if (page === "closet" || page === "home" || (page === "listing" && notFound(doc))) return { kind: "done", result: { deleted: true, note: "Deleted on Poshmark" } };
    if (BLOCKED.test(pageText(doc))) return fallbackTo("offer");
    if (page === "edit" && formError(doc)) return fallbackTo("refused");
    return stop("unexpected_page", "Pressed Delete but could not confirm the listing is gone. Please check it.");
  }
  if (page === "listing") {
    if (soldBadge(doc)) return { kind: "done", result: { alreadyDone: true, note: "Already sold on Poshmark (sold listings can't be deleted)" } };
    return { kind: "goto", page: "edit", phase: "start" };
  }
  if (page !== "edit") return stop("unexpected_page", `Expected the edit page, got ${page}`);
  if (BLOCKED.test(pageText(doc))) return fallbackTo("offer");
  if (phase === "del_confirm") {
    const d = dialog(doc);
    if (d && BLOCKED.test(textOf(d))) return fallbackTo("offer");
    const yes = d ? byText<HTMLElement>(d, 'button, [role="button"]', /^(yes|delete|yes,? delete( it)?|confirm)$/i)[0] : undefined;
    if (!yes) return stop("unexpected_page", "Pressed Delete but no confirmation appeared. Nothing was deleted.");
    click(yes);
    return { kind: "wait", phase: "del_done", ms: 4000 };
  }
  const del = deleteButton(doc);
  if (!del) return fallbackTo("nodelete");
  click(del);
  return { kind: "wait", phase: "del_confirm", ms: 800 };
}

function endStep(doc: Document, page: Page, phase: string, mode: unknown, note: string): StepResult {
  const fb = /^fb-([a-z]+)-(\w+)$/.exec(phase);
  if (fb) {
    const r = availabilityStep(doc, page, fb[2], note);
    const reason = FALLBACK[fb[1]] ?? FALLBACK.refused;
    if (r.kind === "done") return { kind: "done", result: { ...r.result, alreadyDone: false, fallback: reason, note: `${reason}; set to Not For Sale instead` } };
    if (r.kind === "wait") return { ...r, phase: `fb-${fb[1]}-${r.phase}` };
    if (r.kind === "goto") return { ...r, phase: `fb-${fb[1]}-${r.phase}` };
    return r;
  }
  return mode === "delete" ? deleteStep(doc, page, phase) : availabilityStep(doc, page, phase, note);
}

/** After pressing Update. A result when we can tell (an open modal, a form error, still on the edit page); null when Poshmark left the
 * edit page cleanly, in which case the caller re-opens the edit page ("verify") and checks the saved values for itself. */
function afterUpdate(doc: Document, page: Page, phase: string): StepResult | null {
  if (page !== "edit") return null;
  const m = openModal(doc);
  if (m) return stop("rejected", `Poshmark showed: ${modalSays(m)}`, true);
  const err = formError(doc);
  if (err) return stop("rejected", `Poshmark said: ${err.slice(0, 200)}`);
  if (phase === "saved") return { kind: "wait", phase: "saved2", ms: 5000 };
  return stop("unexpected_page", "Pressed Update, but Poshmark stayed on the edit page with no message. Please check the tab.", true);
}
const SAVED = new Set(["saved", "saved2"]), VERIFY = new Set(["verify", "verify2"]);
/** Not For Sale on this edit page? true/false, or null when there is no Availability control we know. */
function editPageNotForSale(doc: Document): boolean | null {
  const now = availabilityNow(doc);
  if (now !== null) return /^not for sale$/i.test(now);
  const sel = Array.from(doc.querySelectorAll<HTMLSelectElement>("select")).find((x) => Array.from(x.options).some((o) => /not for sale/i.test(o.text)));
  return sel ? /not for sale/i.test(sel.selectedOptions[0]?.text ?? "") : null;
}

function availabilityStep(doc: Document, page: Page, phase: string, note: string): StepResult {
  if (SAVED.has(phase)) {
    const r = afterUpdate(doc, page, phase);
    if (r) return r;
    if (page === "listing" && isNotForSale(doc)) return { kind: "done", result: { alreadyDone: false, note } };
    return { kind: "goto", page: "edit", phase: "verify" };
  }
  if (page === "listing") {
    if (soldBadge(doc)) return { kind: "done", result: { alreadyDone: true, note: "Already sold on Poshmark" } };
    if (phase === "start" && isNotForSale(doc)) return { kind: "done", result: { alreadyDone: true, note } };
    return { kind: "goto", page: "edit", phase: VERIFY.has(phase) ? phase : "start" };
  }
  if (page !== "edit") return stop("unexpected_page", `Expected the edit page, got ${page}`);
  if (VERIFY.has(phase)) {
    const nfs = editPageNotForSale(doc);
    if (nfs) return { kind: "done", result: { alreadyDone: false, note: `${note} (checked)` } };
    if (nfs === null && phase === "verify") return { kind: "wait", phase: "verify2", ms: 1500 };
    return stop("unexpected_page", "Pressed Update, but the listing does not show \"Not For Sale\". Please check it.", true);
  }
  const r = setNotForSale(doc, phase);
  if (r === "already") return { kind: "done", result: { alreadyDone: phase === "start", note: phase === "start" ? "Already Not For Sale" : note } };
  if (r) return r;
  if (phase === "picked" && editPageNotForSale(doc) === false) return stop("unexpected_page", "Picked \"Not For Sale\" but the Availability setting did not change", true);
  const save = saveButton(doc);
  if (!save) return stop("unexpected_page", "Could not find the Update button");
  click(save);
  return { kind: "wait", phase: "saved", ms: 5000 };
}

const isPrice = (el: Element) => /price/i.test(`${el.getAttribute("data-vv-name") ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("name") ?? ""} ${el.id}`);
function sameValue(el: HTMLInputElement | HTMLTextAreaElement, v: unknown): boolean {
  const s = String(v);
  if (isPrice(el) || el.type === "number" || /quantity|qty/i.test(el.getAttribute("data-vv-name") ?? el.name ?? "")) { const a = num(el.value), b = num(s); if (a !== null && b !== null) return a === b; }
  return norm(el.value) === norm(s);
}
const priceField = (doc: Document) => q<HTMLInputElement>(doc, REAL.price) ??
  field(doc, "input", /listing price/i) ?? Array.from(doc.querySelectorAll<HTMLInputElement>("input")).find((i) => {
    const hay = `${i.name} ${i.id} ${i.getAttribute("aria-label") ?? ""} ${i.placeholder}`;
    return /price/i.test(hay) && !/original/i.test(hay);
  }) ?? null;

type Quantity = { el: HTMLInputElement | null; single: boolean; multi: boolean };
/** The quantity box, and whether this is a Single Item listing (which has no quantity box at all on Poshmark). */
function quantityOf(doc: Document): Quantity {
  const el = q<HTMLInputElement>(doc, REAL.quantity) ?? field(doc, "input", /quantity|qty/i);
  const sec = q(doc, REAL.qtySection);
  const one = sec ? q(sec, REAL.single) : null, many = sec ? q(sec, REAL.multi) : null;
  const picked = (b: Element | null) => !!b && /\bbtn--primary\b/.test(b.className); // the chosen button is the filled one
  const multi = !!many && picked(many) && !picked(one);
  return { el, single: !el && !!one && !multi, multi };
}
function editFields(doc: Document, p: Record<string, unknown>, quantityOnly: boolean) {
  return quantityOnly
    ? [{ name: "quantity", el: quantityOf(doc).el, want: p.quantity }]
    : [
        { name: "title", el: q<HTMLInputElement>(doc, REAL.title) ?? field(doc, "input", /title|what are you selling/i), want: p.title },
        { name: "description", el: q<HTMLTextAreaElement>(doc, REAL.description) ?? field<HTMLTextAreaElement>(doc, "textarea", /descri/i), want: p.description },
        { name: "price", el: priceField(doc), want: p.price },
      ].filter((f) => f.want !== undefined && f.want !== null);
}

function editFieldsStep(doc: Document, page: Page, phase: string, p: Record<string, unknown>, quantityOnly: boolean): StepResult {
  if (SAVED.has(phase)) return afterUpdate(doc, page, phase) ?? { kind: "goto", page: "edit", phase: "verify" };
  if (page === "listing") return { kind: "goto", page: "edit", phase: VERIFY.has(phase) ? phase : "start" };
  if (page !== "edit") return stop("unexpected_page", `Expected the edit page, got ${page}`);
  if (quantityOnly && !VERIFY.has(phase)) {
    const qty = quantityOf(doc), want = Number(p.quantity);
    if (!qty.el && qty.single) {
      if (want === 1) return { kind: "done", result: { alreadyDone: true, note: "Single Item listing: quantity is already 1" } };
      return stop("unexpected_page", `This is a Single Item listing on Poshmark, so it has no quantity box. To sell ${want}, open it on Poshmark, choose Multi Item and set the quantity for each size (Shadow Sync won't switch that by itself).`);
    }
    if (!qty.el) return stop("unexpected_page", qty.multi ? "Multi Item listing, but no quantity box was found on the edit page" : "Could not find the quantity setting on the edit page");
  }
  const fields = editFields(doc, p, quantityOnly);
  if (VERIFY.has(phase)) {
    // A fresh edit page shows what Poshmark saved. Empty boxes usually mean it has not finished loading: look once more.
    if (phase === "verify" && fields.some((f) => !f.el || !f.el.value)) return { kind: "wait", phase: "verify2", ms: 1500 };
    const off = fields.filter((f) => !f.el || !sameValue(f.el, f.want)).map((f) => f.name);
    if (!off.length) return { kind: "done", result: { note: "Saved (checked on a fresh edit page)" } };
    return stop("unexpected_page", `Pressed Update, but Poshmark still shows a different ${off.join(", ")}. Please check it.`, true);
  }
  const missing = fields.filter((f) => !f.el).map((f) => f.name);
  if (missing.length) return stop("unexpected_page", `Could not find the ${missing.join(", ")} field on the edit page`);
  const price = fields.find((f) => f.name === "price");
  const digits = price ? priceDigits(price.want) : null;
  if (price && digits === null) return stop("invalid_payload", `Poshmark prices are whole dollars of at least $3 (got ${String(price.want)}). Nothing was changed.`);

  if (phase === "start") {
    let changed = false;
    for (const f of fields) {
      if (sameValue(f.el!, f.want)) continue;
      changed = true;
      if (f === price) { click(f.el!); typeValue(f.el!, digits!); } // a click may open the Listing Price window (next phase)
      else typeValue(f.el!, String(f.want));
    }
    if (!changed) return { kind: "done", result: { alreadyDone: true, note: "Nothing to change" } };
    return price ? { kind: "wait", phase: "price", ms: 800 } : { kind: "wait", phase: "check", ms: 600 };
  }
  const box = priceModalBox(doc);
  if (phase === "price" && box) { typeValue(box, digits!); return { kind: "wait", phase: "pricedone", ms: 600 }; }
  if (phase === "pricedone") {
    if (!box) return stop("unexpected_page", "The Listing Price window closed before we could press Done. Nothing was saved.", true);
    const m = box.closest<HTMLElement>(MODAL)!, err = visibleError(m);
    if (num(box.value) !== Number(digits) || err) return stop("unexpected_page", `The new price did not stick in the Listing Price window${err ? ` (Poshmark: ${err})` : ""}. Nothing was saved.`, true);
    const done = byText<HTMLElement>(m, 'button, [role="button"]', /^(done|apply|save|ok)$/i)[0];
    if (!done) return stop("unexpected_page", "Could not find Done in the Listing Price window. Nothing was saved.", true);
    click(done);
    return { kind: "wait", phase: "check", ms: 800 };
  }
  // "check" (or "price" with no window): the boxes must show exactly what we typed, with no error, before Update is pressed.
  if (box) return stop("unexpected_page", "The Listing Price window is still open. Nothing was saved.", true);
  const off = fields.filter((f) => !sameValue(f.el!, f.want) || (f === price && !f.el!.value.trim())).map((f) => f.name);
  if (off.length) return stop("unexpected_page", `The ${off.join(", ")} did not stick on the edit page (the box shows "${fields.find((f) => f.name === off[0])!.el!.value.slice(0, 40)}"). Nothing was saved.`, true);
  const err = formError(doc);
  if (err) return stop("unexpected_page", `Poshmark shows "${err.slice(0, 160)}" on the edit page. Nothing was saved.`, true);
  const save = saveButton(doc);
  if (!save) return stop("unexpected_page", "Could not find the Update button");
  click(save);
  return { kind: "wait", phase: "saved", ms: 5000 };
}
/** Poshmark takes whole dollars, digits only ("25", never "$25.00"); at least $3. */
function priceDigits(v: unknown): string | null {
  const n = typeof v === "number" ? v : num(String(v ?? ""));
  if (n === null || !Number.isFinite(n) || n < 3 || Math.abs(n - Math.round(n)) > 1e-9) return null;
  return String(Math.round(n));
}
const priceModalBox = (doc: Document) => {
  const b = q<HTMLInputElement>(doc, REAL.priceModalInput);
  const m = b?.closest<HTMLElement>(MODAL);
  return b && m && m.classList.contains("modal--in") ? b : null;
};
const visibleError = (root: ParentNode) => {
  const e = Array.from(root.querySelectorAll<HTMLElement>(".form__error-message, [role='alert']")).find((x) => x.style.display !== "none" && !x.hidden && textOf(x));
  return e ? textOf(e) : "";
};

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
  if (input.phase === "del_done" && (input.action === "delist" || input.action === "markSold") && notFound(doc)) return { kind: "done", result: { deleted: true, note: "Deleted on Poshmark" } };
  if (notFound(doc)) return stop("listing_not_found", "Poshmark says this page or listing does not exist. Check it, then use Mark delisted or Retry.");
  const auth = signedIn(doc);
  if (input.action === "checkLogin") {
    // Can't tell: say so, but it is not an error (an error here used to count toward the error-burst pause and left jobs waiting).
    if (auth === null) return { kind: "done", loggedIn: null, result: { note: "Could not tell whether you are signed in; jobs will try and stop if Poshmark asks you to sign in" } };
    return { kind: "done", loggedIn: auth };
  }
  if (auth === false) return stop("signed_out", "Signed out of Poshmark. Sign in in this browser; waiting jobs then continue by themselves.");
  const p = input.payload;
  switch (input.action) {
    case "delist": return endStep(doc, page, input.phase, p.mode, "Set to Not For Sale");
    case "markSold": return endStep(doc, page, input.phase, p.mode, "Set to Not For Sale (sold elsewhere)");
    case "updateQuantity":
      return p.quantity === 0 ? availabilityStep(doc, page, input.phase, "Quantity 0: set to Not For Sale") : editFieldsStep(doc, page, input.phase, p, true);
    case "updateListing": return editFieldsStep(doc, page, input.phase, p, false);
    case "createListing": return createStep(doc, page, p);
    case "getSales": {
      if (page !== "sales") {
        // Mid-redirect or an odd landing page: open My Sales once more before giving up.
        if (input.phase !== "again") return { kind: "goto", page: "sales", phase: "again" };
        return stop("unexpected_page", `Expected your Poshmark sales page, but the tab is on ${pathOf(input.url)}`);
      }
      // A signed-out visit is redirected to /login (handled above), so an unclear header here is fine.
      const r = parseSales(doc, (p.cursor as string | null | undefined) ?? null, (p.limit as number | undefined) ?? 50);
      return { kind: "done", loggedIn: auth ?? true, sales: r.sales, nextCursor: r.nextCursor };
    }
    case "getListings": {
      if (page === "home" || page === "other") {
        const href = byText<HTMLAnchorElement>(doc, 'a[href^="/closet/"]', /my closet/i)[0]?.getAttribute("href") ?? doc.querySelector('a[href^="/closet/"]')?.getAttribute("href");
        const user = /^\/closet\/([A-Za-z0-9_.-]{1,60})/.exec(href ?? "")?.[1];
        return user ? { kind: "goto", page: "closet", phase: "list", user } : stop("unexpected_page", "Could not find your closet link");
      }
      if (page !== "closet") return stop("unexpected_page", `Expected your closet, got ${page}`);
      // Only tiles that are still for sale count as live (sold / Not For Sale tiles are skipped).
      const ids = new Set<string>();
      for (const a of Array.from(doc.querySelectorAll("a[href*='/listing/']"))) {
        const id = /([a-f0-9]{24})(?:[/?#]|$)/i.exec(a.getAttribute("href") ?? "")?.[1];
        if (!id) continue;
        const tile = a.closest('[data-test*="tile" i], .tile, .card, li, article') ?? a;
        if (/\bsold\b|not for sale/i.test(textOf(tile))) continue;
        ids.add(id.toLowerCase());
      }
      return { kind: "done", listingIds: [...ids], result: { note: `${ids.size} live listings seen on the first closet page` } };
    }
  }
}
