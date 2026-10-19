// Pacing and safety limits (spec 5, account-risk protection). Pure: state in, state out, the caller stores it. No clock reads.
// - one job at a time per marketplace, then a random gap (speed "normal": 2-10 s, like Vendoo; "careful": 20-90 s, the 1.0.3 pace)
// - daily caps per marketplace and action (local day)
// - an error burst (3 errors in 15 min) pauses that marketplace for an hour
// - 2 security checks (captcha / challenge) in a row pause that marketplace until you resume it
// - kill switch: the whole browser (device) or one marketplace
// - breaks: "normal" pauses 20-40 s after ~25 actions in a row; "careful" takes 3-8 minutes after every 5-8 actions
// - an hourly cap per marketplace as a backstop ("normal" Poshmark 100/hour; "careful" 30/hour; overridable per browser)
// - delist / mark sold skip the breaks (overselling is worse) but keep the short gap and every cap
// Speed is per marketplace, per browser (PacingState.speed), set from Settings > Extension; default "normal" (David, 1.0.4).
import type { Action, ExtMarketplace } from "../../src/lib/ext/protocol";

export type Speed = "normal" | "careful";
export const SPEEDS: readonly Speed[] = ["normal", "careful"];
type Profile = {
  gapMinMs: number; gapMaxMs: number;
  /** A break after every `everyMin`-`everyMax` actions in a row, `minMs`-`maxMs` long. */
  longBreak: { everyMin: number; everyMax: number; minMs: number; maxMs: number };
  /** Actions per marketplace per rolling hour. Override per browser with PacingState.hourlyCaps. */
  hourlyCaps: Record<ExtMarketplace, number>;
};
export const PROFILES: Record<Speed, Profile> = {
  // Vendoo-like: a few seconds between actions, a short breather after a long run, a high hourly backstop.
  normal: {
    gapMinMs: 2_000, gapMaxMs: 10_000,
    longBreak: { everyMin: 25, everyMax: 25, minMs: 20_000, maxMs: 40_000 },
    hourlyCaps: { poshmark: 100, facebook: 60, depop: 100, grailed: 100, mercari: 100, vinted: 100 },
  },
  // The 1.0.3 pace.
  careful: {
    gapMinMs: 20_000, gapMaxMs: 90_000,
    longBreak: { everyMin: 5, everyMax: 8, minMs: 3 * 60_000, maxMs: 8 * 60_000 },
    hourlyCaps: { poshmark: 30, facebook: 20, depop: 30, grailed: 30, mercari: 30, vinted: 30 },
  },
};
export const PACING = {
  ...PROFILES.normal,
  errorBurst: { count: 3, windowMs: 15 * 60_000, pauseMs: 60 * 60_000 },
  challengesInARow: 2,
  /** Per marketplace per local day. */
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
  rateStreak?: number;           // "slow down" (429) answers in a row, for the growing back-off
  paused: boolean;               // you (popup) or 2 security checks in a row
  pausedReason: string | null;
  /** Actions since the last long break, and after how many the next one comes (5-8, random). */
  sinceBreak?: number;
  breakAfter?: number;
  breakUntil?: number;
  /** Start times of actions in the last hour (hourly cap). */
  hour?: number[];
}
export interface PacingState {
  devicePaused: boolean; mp: Partial<Record<ExtMarketplace, MarketplacePacing>>;
  hourlyCaps?: Partial<Record<ExtMarketplace, number>>;
  speed?: Partial<Record<ExtMarketplace, Speed>>;
}
/** Line-jumpers: they skip the long break (not the short gap or the caps). */
export const URGENT_ACTIONS: ReadonlySet<Action> = new Set<Action>(["delist", "markSold"]);
export const speedOf = (s: PacingState, m: ExtMarketplace): Speed => (s.speed?.[m] === "careful" ? "careful" : "normal");
const profile = (s: PacingState, m: ExtMarketplace) => PROFILES[speedOf(s, m)];
export const hourlyCap = (s: PacingState, m: ExtMarketplace) => s.hourlyCaps?.[m] ?? profile(s, m).hourlyCaps[m] ?? 30;
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
export const gapMs = (rand: number, speed: Speed = "normal") => {
  const p = PROFILES[speed];
  return Math.round(p.gapMinMs + Math.min(Math.max(rand, 0), 0.999999) * (p.gapMaxMs - p.gapMinMs));
};

/** Second random number from the first (keeps the signature small and the tests deterministic). */
const rand2 = (rand: number) => (Math.min(Math.max(rand, 0), 0.999999) * 7919.123) % 1;
/** Back-off after a "slow down" (429): 2, 4, 8 ... up to 60 minutes, or longer if the site's Retry-After says so (capped at 6 h). */
export const rateBackoffMs = (streak: number, retryAfterMs?: number | null) =>
  Math.min(6 * 3_600_000, Math.max(retryAfterMs ?? 0, Math.min(60 * 60_000, 2 * 60_000 * 2 ** Math.max(0, streak - 1))));
export function finish(s: PacingState, m: ExtMarketplace, outcome: { ok: true } | { ok: false; code: string; retryAfterMs?: number | null }, now: number, rand: number): PacingState {
  const r = row(s, m, now);
  r.busy = false; r.busySince = null;
  r.nextAt = now + gapMs(rand, speedOf(s, m));
  // A break after a run of actions (a delist or mark sold still counts, it just doesn't wait for the break).
  const lb = profile(s, m).longBreak;
  if (r.breakAfter !== undefined && (r.breakAfter < lb.everyMin || r.breakAfter > lb.everyMax)) r.breakAfter = undefined; // speed changed
  r.breakAfter ??= lb.everyMin + Math.floor(rand2(rand) * (lb.everyMax - lb.everyMin + 1));
  r.sinceBreak = (r.sinceBreak ?? 0) + 1;
  if (r.sinceBreak >= r.breakAfter) {
    r.breakUntil = now + Math.round(lb.minMs + rand2(rand) * (lb.maxMs - lb.minMs));
    r.sinceBreak = 0;
    r.breakAfter = lb.everyMin + Math.floor(rand * (lb.everyMax - lb.everyMin + 1));
  }
  if (outcome.ok) { r.challengeStreak = 0; r.rateStreak = 0; return put(s, m, r); }
  if (outcome.code === "rate_limited") {
    r.rateStreak = (r.rateStreak ?? 0) + 1;
    const wait = rateBackoffMs(r.rateStreak, outcome.retryAfterMs);
    r.pausedUntil = Math.max(r.pausedUntil, now + wait);
    r.pausedReason = `The site asked us to slow down; waiting ${Math.ceil(wait / 60_000)} min`;
    return put(s, m, r);
  }
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
/** Change one marketplace's speed. Waits that the old speed set (a long break, a long gap) are cut to the new speed's maximum. */
export function setSpeed(s: PacingState, m: ExtMarketplace, speed: Speed, now: number): PacingState {
  const r = row(s, m, now), p = PROFILES[speed];
  r.nextAt = Math.min(r.nextAt, now + p.gapMaxMs);
  if ((r.breakUntil ?? 0) > now + p.longBreak.maxMs) r.breakUntil = now + p.longBreak.maxMs;
  r.breakAfter = undefined;
  if ((r.sinceBreak ?? 0) >= p.longBreak.everyMax) r.sinceBreak = 0;
  return { ...put(s, m, r), speed: { ...s.speed, [m]: speed } };
}
/** All marketplaces re-fitted to their current speed (the 1.0.4 upgrade: 1.0.3 left 3-8 minute breaks and 20-90 s gaps behind). */
export function refitSpeeds(s: PacingState, now: number): PacingState {
  let out = s;
  for (const m of Object.keys(s.mp) as ExtMarketplace[]) out = setSpeed(out, m, speedOf(s, m), now);
  return { ...out, speed: s.speed };
}
export const todayCounts = (s: PacingState, m: ExtMarketplace, now: number) => row(s, m, now).counts;
/** Popup line: seconds away -> "Next action in about 7 s"; further -> "Next action around 4:12 PM". */
export function nextActionText(until: number, now: number): string {
  const ms = until - now;
  if (ms < 60_000) return `Next action in about ${Math.max(1, Math.ceil(ms / 1000))} s`;
  return `Next action around ${new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
