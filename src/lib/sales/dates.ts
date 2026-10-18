const TZ = "America/Los_Angeles";

const pad = (n: number) => String(n).padStart(2, "0");
const valid = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

/**
 * Port of DS_sheetDateMs_, returning a calendar day "YYYY-MM-DD" (or null).
 * Accepts Date objects (read in Pacific time, like the sheet), "10/4/2026", "10/4/26", "2026-10-04".
 * Bare numbers are not dates.
 */
export function parseDay(v: unknown): string | null {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(v);
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  let y: number, mo: number, d: number;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) { mo = +m[1]; d = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
  else if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else return null;
  return valid(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
}

/** Whole days from a to b (YYYY-MM-DD), DST-safe. */
export function daysBetween(a: string, b: string): number {
  const t = (k: string) => { const [y, m, d] = k.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
  return Math.round(t(b) - t(a));
}
