/** Port of DS_num_: "$1,234.50", "(12.00)" -> -12, "" -> null. */
export function parseMoney(v: unknown): number | null {
  if (v === "" || v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (s === "" || s === "-") return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export const round2 = (v: number) => Math.round(v * 100) / 100;
