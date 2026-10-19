// Small, defensive DOM helpers used inside marketplace pages. They only read the page and act on elements they found themselves.
export const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
/** Visible-ish text with a space between elements (textContent glues "Polo</h1><span>Sold" into "PoloSold"). */
export function textOf(el: Node | null | undefined): string {
  if (!el) return "";
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) out.push(n.textContent ?? "");
    else if (n.nodeType === 1 || n.nodeType === 9 || n.nodeType === 11) {
      const tag = (n as Element).tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE") return;
      n.childNodes.forEach((c) => { walk(c); out.push(" "); });
    }
  };
  walk(el);
  return norm(out.join(""));
}
const visible = (el: Element) => !(el as HTMLElement).hidden && el.getAttribute("aria-hidden") !== "true" && (el as HTMLElement).style?.display !== "none";

/** Captcha / bot check / "verify it's you" on the page. We stop and hand over to you; we never try to solve or bypass it. */
export function securityCheck(doc: Document): "captcha" | "challenge" | null {
  if (doc.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="captcha"], iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], [id*="captcha" i], [class*="captcha" i], .g-recaptcha, .h-captcha')) return "captcha";
  const body = textOf(doc.body).toLowerCase();
  if (/verify (that )?you('| a)re (a )?human|are you a robot|press and hold|i'?m not a robot/.test(body)) return "captcha";
  if (/unusual activity|security check|verify it'?s you|confirm it'?s you|enter the code we sent|two-step verification/.test(body)) return "challenge";
  return null;
}
/** Elements by visible text (exact, case-insensitive), among the given selector. */
export function byText<T extends Element = HTMLElement>(root: ParentNode, selector: string, re: RegExp): T[] {
  return Array.from(root.querySelectorAll<T>(selector)).filter((el) => visible(el) && re.test(textOf(el)));
}
/** A form control found by its label text, aria-label, name, id or placeholder. */
export function field<T extends HTMLElement = HTMLInputElement>(doc: Document, selector: string, re: RegExp): T | null {
  for (const el of Array.from(doc.querySelectorAll<T>(selector))) {
    const id = el.getAttribute("id");
    const label = id ? doc.querySelector(`label[for="${id.replace(/["\\]/g, "\\$&")}"]`) : el.closest("label");
    const hay = [el.getAttribute("aria-label"), el.getAttribute("name"), id, el.getAttribute("placeholder"), textOf(label), el.getAttribute("data-test")].join(" ");
    if (re.test(hay)) return el;
  }
  return null;
}
/** Set a value the way typing would (works with React-style controlled inputs) and fire input + change. */
export function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
export const click = (el: HTMLElement) => el.click();
/** "$1,234.50" -> 1234.5 */
export function money(s: string): number | null {
  const m = /\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(s);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** "Oct 18, 2026" / "10/18/2026" / "2026-10-18" -> "2026-10-18" (or null). */
export function isoDay(s: string): string | null {
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2}),? (\d{4})\b/i.exec(s);
  if (m) return `${m[3]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}
