// Plain-words labels for jobs and extension actions (David, 2026-10-19), shared by the web app and the extension. Pure.
//   "Set quantity to 2", "Change price: $30.00 -> $25.00", "Change title to 'Black jeans'", "Set Not For Sale", "Delete listing (sold)",
//   "Check sign-in", "Scan sales", "Count listings"; with a status: "Queued: Set quantity to 2 on Poshmark", "Succeeded: Set quantity to 2".
import type { JobStatus, JobType } from "../data/types";
import { actionForJob, type Action } from "../ext/protocol";

/** Values before the change, when known (saved in the job payload as `previous` when the job is queued). */
export interface Previous { price?: number | null; title?: string | null; quantity?: number | null; description?: string | null }

const MP_NAMES: Record<string, string> = {
  ebay: "eBay", poshmark: "Poshmark", depop: "Depop", whatnot: "Whatnot", grailed: "Grailed", etsy: "Etsy", mercari: "Mercari",
  shopify: "Shopify", wix: "Wix", facebook: "Facebook Marketplace", vinted: "Vinted", other: "another marketplace",
};
export const marketplaceName = (m: string | null | undefined) => (m ? MP_NAMES[m] ?? m : "");

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
export const money = (n: number) => `$${n.toFixed(2)}`;
const quote = (s: string) => `'${s.length > 60 ? `${s.slice(0, 57)}...` : s}'`;
/** "to X", or ": old -> new" when the old value is known and different. */
const change = (fmt: (v: never) => string, next: unknown, prev: unknown) =>
  prev !== undefined && prev !== null && prev !== next ? `: ${fmt(prev as never)} -> ${fmt(next as never)}` : ` to ${fmt(next as never)}`;

function previousOf(payload: Record<string, unknown>): Previous {
  const p = payload.previous;
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Previous) : {};
}

/**
 * One action, in plain words. `soldAction` says what a sold-item end does on that marketplace when the payload carries no mode yet
 * (a queued job; the server picks delete vs Not For Sale when the extension claims it). Default "delete", the marketplace default.
 */
export function actionLabel(action: Action, payload: Record<string, unknown> = {}, opts: { soldAction?: "delete" | "not_for_sale" } = {}): string {
  const prev = previousOf(payload);
  switch (action) {
    case "checkLogin": return "Check sign-in";
    case "getSales": return "Scan sales";
    case "getListings": return "Count listings";
    case "updateQuantity": {
      if (!isNum(payload.quantity)) return "Set quantity";
      return `Set quantity${change(String, payload.quantity, prev.quantity)}${payload.quantity === 0 ? " (Not For Sale)" : ""}`;
    }
    case "updateListing": {
      const parts: string[] = [];
      if (isNum(payload.price)) parts.push(`price${change(money, payload.price, prev.price)}`);
      if (isStr(payload.title)) parts.push(`title${change(quote, payload.title, prev.title)}`);
      if (isStr(payload.description)) parts.push("description");
      if (payload.availability === "not_for_sale") parts.push("Not For Sale");
      if (payload.availability === "for_sale") parts.push("For Sale");
      if (isNum(payload.quantity)) parts.push(`quantity${change(String, payload.quantity, prev.quantity)}`);
      return parts.length ? `Change ${parts.join(" and ")}` : "Edit listing";
    }
    case "delist": case "markSold": {
      const sold = isStr(payload.saleId) || action === "markSold";
      const mode = payload.mode === "delete" || payload.mode === "not_for_sale" ? payload.mode : isStr(payload.saleId) ? (opts.soldAction ?? "delete") : "not_for_sale";
      return mode === "delete" ? "Delete listing (sold)" : sold ? "Set Not For Sale (sold)" : "Set Not For Sale";
    }
    case "createListing": {
      const t = isStr(payload.title) ? ` ${quote(payload.title)}` : "";
      return `Create listing draft${t}${isNum(payload.price) ? ` at ${money(payload.price)}` : ""}`;
    }
  }
}

export function jobLabel(job: { jobType: JobType; payload?: Record<string, unknown> | null }, opts: { soldAction?: "delete" | "not_for_sale" } = {}): string {
  const p = job.payload ?? {};
  return actionLabel(actionForJob(job.jobType, p), p, opts);
}

const STATUS_WORDS: Record<JobStatus, string> = {
  queued: "Queued", claimed: "Picked up", running: "Running", succeeded: "Succeeded", retry_wait: "Will retry", failed: "Failed",
  needs_user: "Needs you", canceled: "Canceled",
};
export const statusWord = (s: JobStatus) => STATUS_WORDS[s] ?? s;

/** "Queued: Set quantity to 2 on Poshmark" (the marketplace is named on the queued line), then "Succeeded: Set quantity to 2". */
export function jobEventLabel(status: JobStatus, label: string, marketplace?: string | null): string {
  return `${statusWord(status)}: ${label}${status === "queued" && marketplace ? ` on ${marketplaceName(marketplace)}` : ""}`;
}
