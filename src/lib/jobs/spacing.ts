// Spreading big batches over time (David, 2026-10-19): when many non-urgent extension jobs are already waiting on a marketplace, a new one
// gets a later next_run_at instead of joining a back-to-back run. Delist / mark sold are never pushed back. Pure.
import type { JobType } from "../data/types";

export const SPREAD = { backToBack: 5, gapMinMs: 30_000, gapMaxMs: 90_000, breakEvery: 6, breakMinMs: 3 * 60_000, breakMaxMs: 8 * 60_000 } as const;
export const isUrgentJob = (t: JobType) => t === "delist" || t === "mark_sold";

/** next_run_at for a new job, given the open (queued / retry wait) non-urgent jobs already on that marketplace. undefined = run now. */
export function spreadNextRunAt(waiting: { nextRunAt: string }[], now: Date, rand: () => number = Math.random): string | undefined {
  const n = waiting.length;
  if (n < SPREAD.backToBack) return undefined;
  const latest = Math.max(now.getTime(), ...waiting.map((j) => Date.parse(j.nextRunAt)).filter(Number.isFinite));
  const gap = SPREAD.gapMinMs + rand() * (SPREAD.gapMaxMs - SPREAD.gapMinMs);
  const brk = n % SPREAD.breakEvery === 0 ? SPREAD.breakMinMs + rand() * (SPREAD.breakMaxMs - SPREAD.breakMinMs) : 0;
  return new Date(latest + Math.round(gap + brk)).toISOString();
}
