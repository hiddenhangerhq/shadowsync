// Pacing and safety limits (spec 5, account-risk protection). Pure: state in, state out, the caller stores it. No clock reads.
// - one job at a time per marketplace, then a random 20-90 s gap
// - daily caps per marketplace and action (local day)
// - an error burst (3 errors in 15 min) pauses that marketplace for an hour
// - 2 security checks (captcha / challenge) in a row pause that marketplace until you resume it
// - kill switch: the whole browser (device) or one marketplace
// - human-like spacing (David, 2026-10-19): a 3-8 minute break after every 5-8 actions, and an hourly cap per marketplace
//   (Poshmark 30/hour). Delist / mark sold skip the long break (overselling is worse) but keep the short gap and every cap.
import type { Action, ExtMarketplace } from "../../src/lib/ext/protocol";

export const PACING = {
  gapMinMs: 20_000,
  gapMaxMs: 90_000,
  errorBurst: { count: 3, windowMs: 15 * 60_000, pauseMs: 60 * 60_000 },
  challengesInARow: 2,
  /** Per marketplace per local day. Deliberately low; tune with David. */
  longBreak: { everyMin: 5, everyMax: 8, minMs: 3 * 60_000, maxMs: 8 * 60_000 },
  /** Actions per marketplace per rolling hour. Override per browser with PacingState.hourlyCaps. */
  hourlyCaps: { poshmark: 30, facebook: 20, depop: 30, grailed: 30, mercari: 30, vinted: 30 } as Record<ExtMarketplace, number>,
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
  /** Actions since the last long break, and after how many the next one comes (5-8, random). */
  sinceBreak?: number;
  breakAfter?: number;
  breakUntil?: number;
  /** Start times of actions in the last hour (hourly cap). */
  hour?: number[];
}
export interface PacingState { devicePaused: boolean; mp: Partial<Record<ExtMarketplace, MarketplacePacing>>; hourlyCaps?: Partial<Record<ExtMarketplace, number>> }
/** Line-jumpers: they skip the long break (not the short gap or the caps). */
export const URGENT_ACTIONS: ReadonlySet<Action> = new Set<Action>(["delist", "markSold"]);
export const hourlyCap = (s: PacingState, m: ExtMarketplace) => s.hourlyCaps?.[m] ?? PACING.hourlyCaps[m] ?? 30;
const HOUR = 3600_000;
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
  return { ...r, counts: { ...r.counts }, errors: r.errors.filter((t) => now - t < PACING.errorBurst.windowMs), hour: (r.hour ?? []).filter((t) => now - t < HOUR) };
}
const put = (s: PacingState, m: ExtMarketplace, r: MarketplacePacing): PacingState => ({ ...s, mp: { ...s.mp, [m]: r } });

/** spacing: just pacing (shown as "Next action around HH:MM"). urgentOk: on a long break, so delist / mark sold may still run. */
export type Verdict = { ok: true } | { ok: false; reason: string; until?: number; spacing?: boolean; urgentOk?: boolean };
/** Ready for "a" job: everything except the per-action daily cap (the server picks the job; a capped action is deferred). */
export function readiness(s: PacingState, m: ExtMarketplace, now: number): Verdict {
  if (s.devicePaused) return { ok: false, reason: "This browser is paused" };
  const r = row(s, m, now);
  if (r.paused) return { ok: false, reason: r.pausedReason ?? "Paused" };
  if (r.pausedUntil > now) return { ok: false, reason: r.pausedReason ?? "Paused after several errors", until: r.pausedUntil };
  if (r.busy) return { ok: false, reason: "Another job is running on this marketplace" };
  if (r.nextAt > now) return { ok: false, reason: "Waiting between jobs", until: r.nextAt, spacing: true };
  const cap = hourlyCap(s, m), hour = r.hour ?? [];
  if (hour.length >= cap) return { ok: false, reason: `Hourly limit reached (${cap} an hour)`, until: Math.min(...hour) + HOUR, spacing: true };
  if ((r.breakUntil ?? 0) > now) return { ok: false, reason: "Taking a short break", until: r.breakUntil, spacing: true, urgentOk: true };
  return { ok: true };
}
export const isReady = (s: PacingState, m: ExtMarketplace, now: number) => readiness(s, m, now).ok;
export function canRun(s: PacingState, m: ExtMarketplace, action: Action, now: number): Verdict {
  const v = readiness(s, m, now);
  if (!v.ok && !(v.urgentOk && URGENT_ACTIONS.has(action))) return v;
  if ((row(s, m, now).counts[action] ?? 0) >= PACING.dailyCaps[action]) return { ok: false, reason: `Daily limit reached for ${action}` };
  return { ok: true };
}
export function begin(s: PacingState, m: ExtMarketplace, action: Action, now: number): PacingState {
  const r = row(s, m, now);
  r.busy = true; r.busySince = now;
  r.counts[action] = (r.counts[action] ?? 0) + 1;
  r.hour = [...(r.hour ?? []), now];
  return put(s, m, r);
}
/** The random gap before the next job on the same marketplace. `rand` in [0, 1). */
export const gapMs = (rand: number) => Math.round(PACING.gapMinMs + Math.min(Math.max(rand, 0), 0.999999) * (PACING.gapMaxMs - PACING.gapMinMs));

/** Second random number from the first (keeps the signature small and the tests deterministic). */
const rand2 = (rand: number) => (Math.min(Math.max(rand, 0), 0.999999) * 7919.123) % 1;
export function finish(s: PacingState, m: ExtMarketplace, outcome: { ok: true } | { ok: false; code: string }, now: number, rand: number): PacingState {
  const r = row(s, m, now);
  r.busy = false; r.busySince = null;
  r.nextAt = now + gapMs(rand);
  // Long break after every 5-8 actions (a delist or mark sold still counts, it just doesn't wait for the break).
  const lb = PACING.longBreak;
  r.breakAfter ??= lb.everyMin + Math.floor(rand2(rand) * (lb.everyMax - lb.everyMin + 1));
  r.sinceBreak = (r.sinceBreak ?? 0) + 1;
  if (r.sinceBreak >= r.breakAfter) {
    r.breakUntil = now + Math.round(lb.minMs + rand2(rand) * (lb.maxMs - lb.minMs));
    r.sinceBreak = 0;
    r.breakAfter = lb.everyMin + Math.floor(rand * (lb.everyMax - lb.everyMin + 1));
  }
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
/** Drop error-burst counters and the timed error-burst pause (1.0.3 upgrade: old builds counted unclear sign-in checks as errors).
 *  A pause you set, and the security-check pause (solve it yourself), stay. */
export function clearErrorBursts(s: PacingState): PacingState {
  const mp: PacingState["mp"] = {};
  for (const [m, r] of Object.entries(s.mp) as [ExtMarketplace, MarketplacePacing][]) {
    mp[m] = { ...r, errors: [], pausedUntil: 0, pausedReason: r.paused ? r.pausedReason : null };
  }
  return { ...s, mp };
}
export const todayCounts = (s: PacingState, m: ExtMarketplace, now: number) => row(s, m, now).counts;
