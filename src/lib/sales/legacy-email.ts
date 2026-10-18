// PRIVATE LEGACY IMPORT ONLY. Shadow Sync never reads users' email; this exists so David's existing eBay
// "You made the sale" emails (already parsed by the Apps Script dashboard) can be imported once with source "email".
import { parseMoney } from "./money";
import { stripEllipsis, titleNorm } from "./titles";

export interface LegacyEbaySale {
  marketplace: "ebay";
  orderId: string;
  price: number | null;
  qty: number;
  title: string;
  soldDay: string | null; // YYYY-MM-DD
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Port of DS_parseEbay_ (sale fields only; no Gmail/link handling). Returns null if it is not a sale email. */
export function parseLegacyEbaySale(subject: string, from: string, body: string): LegacyEbaySale | null {
  const fwd = body.match(/Forwarded message[\s\S]{0,200}?^\s*From:\s*([^\n]+)/im)?.[1]?.trim() ?? "";
  const text = subject + "\n" + body;
  const isEbay = /ebay\.com/i.test(from) || /ebay\.com/i.test(fwd);
  if (!isEbay) return null;
  if (!/you made the sale|your item has sold/i.test(text)) return null;

  const idm = text.match(/Order\s*:\s*\|?\s*(\d{2}-\d+-\d+)/i) || body.match(/orderid=(\d{2}-\d+-\d+)/i) || body.match(/\/lbr\/go\?t=(\d{2}-\d+-\d+)/i);
  if (!idm) return null;

  const pm = body.match(/(?:^|[\n|*])[ \t*]*Sold\s*:\s*\|?\s*(?:US\s*)?\$\s?([\d,]+(?:\.\d{1,2})?)/i); // not "Date sold:"
  const price = pm ? parseMoney(pm[1]) : null;
  const qm = body.match(/Quantity(?:\s*sold)?\s*:\s*\|?\s*(\d{1,4})\b/i);
  const qty = qm ? parseInt(qm[1], 10) || 1 : 1;

  let title = "";
  const tm = subject.replace(/^\s*((fwd?|fw|re)\s*:\s*)+/i, "").match(/you made the sale for\s+(.+)$/i);
  if (tm) title = stripEllipsis(tm[1]);
  const md = body.match(/\[([^\]]{6,200})\]\(https?:[^)]*(?:mesh\/ord\/details|lbr\/go\?t=|orderid=)[^)]*\)/i);
  if (md) {
    const bt = stripEllipsis(md[1]);
    if (!title || (bt.length > title.length && titleNorm(bt).startsWith(titleNorm(title)))) title = bt;
  }

  let soldDay: string | null = null;
  const dm = body.match(/Date\s*sold\s*:\s*\|?\s*([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/i);
  if (dm) {
    const mi = MONTHS.indexOf(dm[1].slice(0, 3).toLowerCase());
    if (mi >= 0) soldDay = `${dm[3]}-${String(mi + 1).padStart(2, "0")}-${String(+dm[2]).padStart(2, "0")}`;
  }
  return { marketplace: "ebay", orderId: idm[1], price, qty, title, soldDay };
}
