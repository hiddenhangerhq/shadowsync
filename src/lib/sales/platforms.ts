import type { Marketplace } from "../data/types";

/** Port of DS_normPlatform_: tidy display name; unknown platforms keep their own name. */
export function normalizePlatform(v: unknown): string {
  const s = String(v ?? "").trim();
  const l = s.toLowerCase();
  if (!l) return "Other";
  if (l.includes("ebay")) return "eBay";
  if (l.includes("posh")) return "Poshmark";
  if (l.includes("depop")) return "Depop";
  if (l.includes("whatnot")) return "Whatnot";
  if (l.includes("grailed")) return "Grailed";
  return s;
}

/** Map a sheet/platform label to a Marketplace id for the database. */
export function toMarketplace(v: unknown): Marketplace {
  const l = String(v ?? "").toLowerCase();
  if (l.includes("ebay")) return "ebay";
  if (l.includes("posh")) return "poshmark";
  if (l.includes("depop")) return "depop";
  if (l.includes("whatnot")) return "whatnot";
  if (l.includes("grailed")) return "grailed";
  if (l.includes("mercari")) return "mercari";
  if (l.includes("etsy")) return "etsy";
  if (l.includes("shopify") || l.includes("coursecandles")) return "shopify";
  if (l.includes("wix") || l.includes("shopgolfmaps")) return "wix";
  return "other";
}
