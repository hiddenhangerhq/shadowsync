// Pacing and safety limits (spec 5, account-risk protection). Pure: state in, state out, the caller stores it. No clock reads.
// - one job at a time per marketplace, then a random 20-90 s gap
// - daily caps per marketplace and action (local day)
// - an error burst (3 errors in 15 min) pauses that marketplace for an hour
// - 2 security checks (captcha / challenge) in a row pause that marketplace until you resume it
// - kill switch: the whole browser (device) or one marketplace
import type { Action, ExtMarketplace } from "../../src/lib/ext/protocol";

export const PACING = {
  gapMinMs: 20_000,
  gapMaxMs: 90_000,
  errorBurst: { count: 3, windowMs: 15 * 60_000, pauseMs: 60 * 60_000 },
  challengesInARow: 2,
  /** Per marketplace per local day. Deliberately low; tune with David. */
  dailyCaps: { checkLogin: 100, delist: 100, markSold: 100, updateQuantity: 100, updateListing: 50, createListing: 20, getSales: 150, getListings: 30 } as Record<Action, number>,
} as const;
const CHALLENGE = new Set(["captcha", "challenge", "verification_required"]);
const ERROR_KINDS_IGNORED = new Set(["signed_out", "deferred", "not_supported", "permission_missing", "review_and_submit"]);

export interface MarketplacePacing {
  busy: boolean;
  busySince: number | null;
  nextAt: number;
  day: string;
  counts: Partial<Record<Action, number>>;
  errors: number[];
  challengeStreak: number;
  pausedUntil: number;           // error-burst pause (timed)
  paused: boolean;               // you (popup) or 2 security checks in a row
  pausedReason: string | null;
}
export interface PacingState { devicePaused: boolean; mp: Partial<Record<ExtMarketplace, MarketplacePacing>> }
export const emptyPacing = (): PacingState => ({ devicePaused: false, mp: {} });

/** Local calendar day, so caps reset at the user's midnight. */
export const dayKey = (now: number) => { const d = new Date(now); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const fresh = (now: number): MarketplacePacing => ({
  busy: false, busySince: null, nextAt: 0, day: dayKey(now), counts: {}, errors: [], challengeStreak: 0, pausedUntil: 0, paused: false, pausedReason: null,
});
/** A copy of one marketplace's row, rolled over to today. A busy flag older than 15 min is stale (the worker died mid-job). */
function row(s: PacingState, m: ExtMarketplace, now: number): MarketplacePacing {
  const r: MarketplacePacing = { ...fresh(now), ...(s.mp[m] ?? {}) };
  if (r.day !== dayKey(now)) { r.day = dayKey(now); r.counts = {}; }
  if (r.busy && r.busySince !== null && now - r.busySince > 15 * 60_000) { r.busy = false; r.busySince = null; }
  return { ...r, counts: { ...r.counts }, errors: r.errors.filter((t) => now - t < PACING.errorBurst.windowMs) };
}
const put = (s: PacingState, m: ExtMarketplace, r: MarketplacePacing): PacingState => ({ ...s, mp: { ...s.mp, [m]: r } });

export type Verdict = { ok: true } | { ok: false; reason: string; until?: number };
/** Ready for "a" job: everything except the per-action daily cap (the server picks the job; a capped action is deferred). */
export function readiness(s: PacingState, m: ExtMarketplace, now: number): Verdict {
  if (s.devicePaused) return { ok: false, reason: "This browser is paused" };
  const r = row(s, m, now);
  if (r.paused) return { ok: false, reason: r.pausedReason ?? "Paused" };
  if (r.pausedUntil > now) return { ok: false, reason: r.pausedReason ?? "Paused after several errors", until: r.pausedUntil };
  if (r.busy) return { ok: false, reason: "Another job is running on this marketplace" };
  if (r.nextAt > now) return { ok: false, reason: "Waiting between jobs", until: r.nextAt };
  return { ok: true };
}
export const isReady = (s: PacingState, m: ExtMarketplace, now: number) => readiness(s, m, now).ok;
export function canRun(s: PacingState, m: ExtMarketplace, action: Action, now: number): Verdict {
  const v = readiness(s, m, now);
  if (!v.ok) return v;
  if ((row(s, m, now).counts[action] ?? 0) >= PACING.dailyCaps[action]) return { ok: false, reason: `Daily limit reached for ${action}` };
  return { ok: true };
}
export function begin(s: PacingState, m: ExtMarketplace, action: Action, now: number): PacingState {
  const r = row(s, m, now);
  r.busy = true; r.busySince = now;
  r.counts[action] = (r.counts[action] ?? 0) + 1;
  return put(s, m, r);
}
/** The random gap before the next job on the same marketplace. `rand` in [0, 1). */
export const gapMs = (rand: number) => Math.round(PACING.gapMinMs + Math.min(Math.max(rand, 0), 0.999999) * (PACING.gapMaxMs - PACING.gapMinMs));

export function finish(s: PacingState, m: ExtMarketplace, outcome: { ok: true } | { ok: false; code: string }, now: number, rand: number): PacingState {
  const r = row(s, m, now);
  r.busy = false; r.busySince = null;
  r.nextAt = now + gapMs(rand);
  if (outcome.ok) { r.challengeStreak = 0; return put(s, m, r); }
  if (CHALLENGE.has(outcome.code)) {
    r.challengeStreak++;
    if (r.challengeStreak >= PACING.challengesInARow) { r.paused = true; r.pausedReason = "Paused after 2 security checks in a row. Solve it in your browser, then resume."; }
    return put(s, m, r);
  }
  if (ERROR_KINDS_IGNORED.has(outcome.code)) return put(s, m, r);
  r.errors.push(now);
  if (r.errors.length >= PACING.errorBurst.count) {
    r.pausedUntil = now + PACING.errorBurst.pauseMs;
    r.pausedReason = `Paused for an hour after ${r.errors.length} errors in 15 minutes`;
    r.errors = [];
  }
  return put(s, m, r);
}
export const setDevicePaused = (s: PacingState, paused: boolean): PacingState => ({ ...s, devicePaused: paused });
export function setMarketplacePaused(s: PacingState, m: ExtMarketplace, paused: boolean, now: number, reason = "Paused by you"): PacingState {
  const r = row(s, m, now);
  r.paused = paused; r.pausedReason = paused ? reason : null;
  if (!paused) { r.challengeStreak = 0; r.pausedUntil = 0; r.errors = []; }
  return put(s, m, r);
}
export const todayCounts = (s: PacingState, m: ExtMarketplace, now: number) => row(s, m, now).counts;
