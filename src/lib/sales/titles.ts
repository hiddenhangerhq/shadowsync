/** Ports of DS_stripEllipsis_, DS_titleNorm_, DS_titleMatch_. Used to match the same item across sources. */
export function stripEllipsis(s: unknown): string {
  return String(s ?? "").replace(/\s*(\.{3,}|…)\s*$/, "").replace(/\s+/g, " ").trim();
}

/** Lower-case letters/digits only (curly quotes, punctuation, spaces, trailing "..." dropped). */
export function titleNorm(s: unknown): string {
  return stripEllipsis(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

const words = (s: string) =>
  stripEllipsis(s).toLowerCase().replace(/[’']/g, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 2);

/**
 * Same item? `a` = full title (sheet/db), `b` = possibly truncated title (eBay truncates with "...").
 * First 40 normalized chars: one starts with the other (>= 12 chars) or share a >= 24-char prefix;
 * else >= 4 shared words covering >= 60% of b's words (the last, possibly cut-off word ignored).
 */
export function titleMatch(a: string, b: string): boolean {
  const na = titleNorm(a).slice(0, 40), nb = titleNorm(b).slice(0, 40);
  if (!na || !nb) return false;
  if (nb.length >= 12 && na.startsWith(nb)) return true;
  if (na.length >= 12 && nb.startsWith(na)) return true;
  let k = 0;
  while (k < na.length && k < nb.length && na[k] === nb[k]) k++;
  if (k >= 24) return true;
  const wa = new Set(words(a));
  let wb = words(b);
  if (/(\.{3,}|…)\s*$/.test(b) || wb.length > 3) wb = wb.slice(0, -1);
  if (!wb.length) return false;
  const hit = wb.filter((w) => wa.has(w)).length;
  return hit >= 4 && hit / wb.length >= 0.6;
}
