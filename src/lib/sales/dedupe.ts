import { daysBetween } from "./dates";
import { titleMatch } from "./titles";

export interface DedupeRow { channel: string; day: string; price: number | null; title: string }

/**
 * Port of DS_dropDupGtMail_ (generalized): returns the `candidates` that are NOT already represented in
 * `known` (e.g. rows from a lower-trust source vs. the sheet/db). A known row matches when the channel is the same,
 * the day is the same or +-1 (exact day tried first), the price matches to the cent and titleMatch agrees.
 * Each known row absorbs at most one candidate, so two identical items sold the same day are not both hidden.
 */
export function dropDuplicates<T extends DedupeRow>(known: DedupeRow[], candidates: T[]): T[] {
  const idx = new Map<string, { row: DedupeRow; used: boolean }[]>();
  for (const k of known) {
    if (k.price === null) continue;
    const key = `${k.channel}|${Math.round(k.price * 100)}`;
    (idx.get(key) ?? idx.set(key, []).get(key)!).push({ row: k, used: false });
  }
  return candidates.filter((c) => {
    if (c.price === null) return true;
    const list = idx.get(`${c.channel}|${Math.round(c.price * 100)}`);
    if (!list) return true;
    for (const pass of [0, 1]) {
      for (const e of list) {
        if (e.used || Math.abs(daysBetween(e.row.day, c.day)) !== pass || !titleMatch(e.row.title, c.title)) continue;
        e.used = true;
        return false;
      }
    }
    return true;
  });
}
