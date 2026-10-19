// The extension's brain, with the browser, storage, clock and API injected so it is unit-tested with fakes.
// One job at a time per marketplace, random 20-90 s gaps, daily caps, a pause after an error burst, an automatic pause after
// 2 security checks in a row, and the kill switch (this browser, or one marketplace) are all enforced here before any tab opens.
import { HOST_TABLE, EXT_MARKETPLACES, type ExtMarketplace, type ResultCode } from "../../src/lib/ext/protocol";
import { validateAction } from "./handler";
import { actionLabel } from "../../src/lib/jobs/labels";
import { begin, canRun, clearErrorBursts, emptyPacing, finish, isReady, readiness, setDevicePaused, setMarketplacePaused, type PacingState } from "./pacing";
import { runAction, type Browser, type RunOutcome } from "./runner";
import { ApiError, type Api } from "./api";

export interface LogLine { at: number; text: string }
export interface ExtState {
  token: string | null; deviceId: string | null; deviceLabel: string | null;
  pacing: PacingState;
  /** loggedIn null = checked but could not tell. Only a definite "signed out" holds jobs back. */
  logins: Partial<Record<ExtMarketplace, { loggedIn: boolean | null; at: number }>>;
  /** Last version whose one-time upgrade step ran. */
  upgradedTo?: string;
  server: { devicePaused: boolean; paused: Partial<Record<ExtMarketplace, string | null>> } | null;
  lastPollAt: number | null; lastError: string | null; log: LogLine[];
  /** Last listing scan per marketplace (once a day): flags Sold items still live. */
  listingsScanAt?: Partial<Record<ExtMarketplace, number>>;
}
export const emptyState = (): ExtState => ({
  token: null, deviceId: null, deviceLabel: null, pacing: emptyPacing(), logins: {}, server: null, lastPollAt: null, lastError: null, log: [],
});
export interface Store { load(): Promise<ExtState>; save(s: ExtState): Promise<void> }
export interface Deps { api: Api; browser: Browser; store: Store; now: () => number; rand: () => number; version: string }

const LOG_MAX = 40;
const addLog = (s: ExtState, now: number, text: string) => { s.log = [{ at: now, text: text.slice(0, 200) }, ...s.log].slice(0, LOG_MAX); };
async function update(d: Deps, fn: (s: ExtState) => void | Promise<void>): Promise<ExtState> {
  const s = await d.store.load();
  await fn(s);
  await d.store.save(s);
  return s;
}
/** Marketplaces you connected (granted the site permission) that have action code. */
export async function connected(d: Deps): Promise<ExtMarketplace[]> {
  const out: ExtMarketplace[] = [];
  for (const m of EXT_MARKETPLACES) if (HOST_TABLE[m].supported && (await d.browser.hasPermission(m))) out.push(m);
  return out;
}
const serverPaused = (s: ExtState, m: ExtMarketplace) => !!s.server?.devicePaused || (s.server?.paused[m] ?? null) !== null;

/** Run a local (job-less) action through the same pacing as server jobs. */
async function runLocal(d: Deps, m: ExtMarketplace, action: "checkLogin" | "getSales" | "getListings", payload: Record<string, unknown>): Promise<RunOutcome | { ok: false; code: "deferred"; message: string }> {
  const s0 = await d.store.load();
  const v = canRun(s0.pacing, m, action, d.now());
  if (!v.ok) return { ok: false, code: "deferred", message: v.reason };
  const check = validateAction({ jobId: null, marketplace: m, action, payload });
  if (!check.ok) return { ok: false, code: "deferred", message: check.message };
  await update(d, (s) => { s.pacing = begin(s.pacing, m, action, d.now()); });
  const out = await runAction(d.browser, check.value); // never throws; a crashed worker leaves "busy", which goes stale after 15 min
  await update(d, (s) => {
    // A sign-in check that can't tell or doesn't load is "unknown", never an error (only a security check counts).
    const code = !out.ok && action === "checkLogin" && !["captcha", "challenge", "verification_required"].includes(out.code) ? "deferred" : out.ok ? null : out.code;
    s.pacing = finish(s.pacing, m, code === null ? { ok: true } : { ok: false, code }, d.now(), d.rand());
    if (out.ok && out.loggedIn !== undefined) s.logins[m] = { loggedIn: out.loggedIn, at: d.now() };
    if (!out.ok && out.code === "signed_out") s.logins[m] = { loggedIn: false, at: d.now() };
    if (!out.ok) addLog(s, d.now(), `${HOST_TABLE[m].label}: Failed: ${actionLabel(action, payload)}: ${out.message}`);
  });
  return out;
}

export async function checkLogin(d: Deps, m: ExtMarketplace) {
  const r = await runLocal(d, m, "checkLogin", {});
  if (r.ok) await update(d, (s) => addLog(s, d.now(), `${HOST_TABLE[m].label}: Succeeded: ${actionLabel("checkLogin")} (${r.loggedIn === true ? "signed in" : r.loggedIn === false ? "signed out" : "unknown, jobs still run"})`));
  return r;
}
export async function checkAllLogins(d: Deps) {
  const s = await d.store.load();
  if (!s.token || s.pacing.devicePaused) return;
  for (const m of await connected(d)) if (isReady(s.pacing, m, d.now())) await checkLogin(d, m);
}

/** Poll: heartbeat + login states, then run what the server handed us, one at a time. */
/** Signed out for sure (only then are jobs held back). Not checked yet, or checked but unclear, still asks for jobs: a job that meets the
 *  sign-in page stops as "signed_out" and goes back in the queue once you sign in (regression: jobs stayed "queued" forever). */
export const signedOut = (s: ExtState, m: ExtMarketplace) => s.logins[m]?.loggedIn === false;

export async function poll(d: Deps): Promise<{ ran: number; notes?: string[] } | { skipped: string }> {
  await upgrade(d);
  const s = await d.store.load();
  if (!s.token) return { skipped: "not_paired" };
  const mps = await connected(d);
  const now = d.now();
  const marketplaces: Record<string, boolean> = {};
  for (const m of mps) marketplaces[m] = !signedOut(s, m);
  const ready: ExtMarketplace[] = [], urgentOnly: ExtMarketplace[] = [];
  if (!s.pacing.devicePaused) for (const m of mps) {
    if (signedOut(s, m)) continue;
    const v = readiness(s.pacing, m, now);
    if (v.ok) ready.push(m);
    else if (v.urgentOk) { ready.push(m); urgentOnly.push(m); } // long break: only delist / mark sold
  }
  // Why a marketplace is not asking for jobs, for "Check now".
  const notes: string[] = [];
  if (!mps.length) notes.push("No marketplace connected (press Connect)");
  if (s.pacing.devicePaused) notes.push("This browser is paused");
  else for (const m of mps) {
    const v = readiness(s.pacing, m, now);
    if (signedOut(s, m)) notes.push(`${HOST_TABLE[m].label}: signed out (sign in, then press Check sign-in)`);
    else if (!v.ok) notes.push(`${HOST_TABLE[m].label}: ${v.reason}${v.until ? ` (next action around ${new Date(v.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})` : ""}${v.urgentOk ? "; delists still go first" : ""}`);
  }
  let res;
  try { res = await d.api.poll({ extensionVersion: d.version, marketplaces, ready, limit: ready.length, ...(urgentOnly.length ? { urgentOnly } : {}) }); }
  catch (e) { return handleApiError(d, e); }
  await update(d, (st) => {
    st.lastPollAt = now; st.lastError = null; st.deviceLabel = res.device.label;
    st.server = { devicePaused: res.device.paused, paused: Object.fromEntries(res.marketplaces.map((x) => [x.marketplace, x.paused ? (x.pausedReason ?? "Paused") : null])) };
    if (res.requeued) addLog(st, now, `${res.requeued} job(s) back in the queue after signing in`);
  });
  let ran = 0;
  for (const raw of res.jobs) { await runJob(d, raw); ran++; }
  if (res.device.paused) notes.push("Paused on the website (Settings > Extension)");
  for (const x of res.marketplaces) if (x.paused) notes.push(`${HOST_TABLE[x.marketplace as ExtMarketplace]?.label ?? x.marketplace}: paused on the website`);
  return { ran, notes };
}

async function report(d: Deps, jobId: string, r: { ok: true; result?: object } | { ok: false; code: ResultCode; message: string }) {
  try { await d.api.result(jobId, r as never); } catch (e) { await handleApiError(d, e); }
}

export async function runJob(d: Deps, raw: { jobId: string } & Record<string, unknown>) {
  const check = validateAction(raw);
  if (!check.ok) return report(d, raw.jobId, { ok: false, code: check.code, message: check.message });
  const a = check.value, m = a.marketplace;
  const s = await d.store.load();
  // Kill switch and pacing: hold the job (transient "deferred": it goes back in the queue, nothing is lost).
  if (s.pacing.devicePaused) return report(d, raw.jobId, { ok: false, code: "deferred", message: "This browser is paused" });
  const v = canRun(s.pacing, m, a.action, d.now());
  if (!v.ok) return report(d, raw.jobId, { ok: false, code: "deferred", message: v.reason });
  try { await d.api.start(raw.jobId); } catch (e) { return handleApiError(d, e); }
  await update(d, (st) => { st.pacing = begin(st.pacing, m, a.action, d.now()); addLog(st, d.now(), `${HOST_TABLE[m].label}: Running: ${actionLabel(a.action, a.payload)}`); });
  const lease = setInterval(() => { d.api.extend(raw.jobId).catch(() => undefined); }, 60_000);
  let out: RunOutcome;
  try {
    out = await runAction(d.browser, a, { onProgress: (msg) => { d.api.progress(raw.jobId, msg).catch(() => undefined); } });
  } finally { clearInterval(lease); }
  await update(d, (st) => {
    st.pacing = finish(st.pacing, m, out.ok ? { ok: true } : { ok: false, code: out.code }, d.now(), d.rand());
    if (!out.ok && out.code === "signed_out") st.logins[m] = { loggedIn: false, at: d.now() };
    if (out.ok && out.loggedIn !== undefined) st.logins[m] = { loggedIn: out.loggedIn, at: d.now() };
    const label = actionLabel(a.action, a.payload);
    addLog(st, d.now(), `${HOST_TABLE[m].label}: ${out.ok ? `Succeeded: ${label}${out.result.note ? ` (${out.result.note})` : ""}` : `Failed: ${label}: ${out.message}`}`);
  });
  await report(d, raw.jobId, out.ok ? { ok: true, result: out.result } : { ok: false, code: out.code, message: out.message });
}

/** Sales scan: ask the server for the cursor, read the sales page, report. The server dedupes and creates the delists. */
// salesOnly: the popup's "Scan sales now" (skips the daily listing scan so the press always reads the sales page).
export async function scan(d: Deps, opts: { salesOnly?: boolean } = {}): Promise<{ notes: string[] }> {
  const notes: string[] = [];
  const s = await d.store.load();
  if (!s.token) return { notes: ["Not paired"] };
  if (s.pacing.devicePaused) return { notes: ["This browser is paused"] };
  for (const m of await connected(d)) {
    const label = HOST_TABLE[m].label;
    if (signedOut(s, m)) { notes.push(`${label}: signed out (sign in, then press Check sign-in)`); continue; }
    if (serverPaused(s, m)) { notes.push(`${label}: paused`); continue; }
    if (!isReady(s.pacing, m, d.now())) { notes.push(`${label}: ${((v) => (v.ok ? "not ready" : v.reason))(readiness(s.pacing, m, d.now()))}`); continue; }
    try {
      // Once a day, a listing scan instead: the server flags any item Sold in Shadow Sync that is still live here.
      if (!opts.salesOnly && d.now() - (s.listingsScanAt?.[m] ?? 0) > 24 * 3600_000) {
        const r = await runLocal(d, m, "getListings", {});
        if (r.ok) {
          const rep = await d.api.listingsReport(m, r.listingIds ?? []);
          await update(d, (st) => {
            st.listingsScanAt = { ...(st.listingsScanAt ?? {}), [m]: d.now() };
            addLog(st, d.now(), `${HOST_TABLE[m].label}: Succeeded: ${actionLabel("getListings")} (${rep.seen} live${rep.flagged ? `, ${rep.flagged} sold item(s) still live, see Sold but still active` : ""})`);
          });
        }
        continue;
      }
      const next = await d.api.scanNext(m);
      const r = await runLocal(d, m, "getSales", { cursor: next.cursor, limit: Math.min(next.limit, 100) });
      if (!r.ok) { notes.push(`${label}: ${"message" in r ? r.message : "scan failed"}`); continue; }
      const rep = await d.api.scanReport(m, r.sales ?? [], r.nextCursor ?? null);
      const note = `${label}: Succeeded: ${actionLabel("getSales")} (saw ${(r.sales ?? []).length} sale(s), ${rep.stored} new, ${rep.jobsCreated} delist(s) queued)`;
      notes.push(note);
      if (rep.jobsCreated || opts.salesOnly) await update(d, (st) => addLog(st, d.now(), note));
    } catch (e) { notes.push(`${label}: ${(e as Error).message}`); await handleApiError(d, e); }
  }
  return { notes };
}

async function handleApiError(d: Deps, e: unknown): Promise<{ skipped: string }> {
  const code = e instanceof ApiError ? (e.code ?? `http_${e.status}`) : "error";
  await update(d, (s) => {
    s.lastError = (e as Error).message;
    // A revoked or unknown token means this browser was unpaired from the dashboard: forget it.
    if (e instanceof ApiError && e.status === 401) { s.token = null; s.deviceId = null; addLog(s, d.now(), "This browser was unpaired. Pair it again from Settings > Extension."); }
  });
  return { skipped: code };
}

export async function pair(d: Deps, code: string, label: string) {
  const r = await d.api.pairComplete(code, label, d.version);
  await update(d, (s) => { s.token = r.token; s.deviceId = r.deviceId; s.deviceLabel = r.label; s.lastError = null; addLog(s, d.now(), `Paired as "${r.label}"`); });
  return { deviceId: r.deviceId, label: r.label };
}
export const unpair = (d: Deps) => update(d, (s) => { s.token = null; s.deviceId = null; s.deviceLabel = null; s.server = null; addLog(s, d.now(), "Unpaired"); });
export const pauseDevice = (d: Deps, paused: boolean) =>
  update(d, (s) => { s.pacing = setDevicePaused(s.pacing, paused); addLog(s, d.now(), paused ? "Paused this browser" : "Resumed this browser"); });
/** Once per new version (onInstalled, and lazily on poll): clear error-burst pauses left by older builds. */
export async function upgrade(d: Deps) {
  const s = await d.store.load();
  if (s.upgradedTo === d.version) return false;
  await update(d, (st) => {
    const had = Object.values(st.pacing.mp).some((r) => (r?.pausedUntil ?? 0) > d.now() || (r?.errors.length ?? 0) > 0);
    st.pacing = clearErrorBursts(st.pacing);
    st.upgradedTo = d.version;
    if (had) addLog(st, d.now(), `Updated to ${d.version}: cleared the automatic error pause`);
  });
  return true;
}

export const pauseMarketplace = (d: Deps, m: ExtMarketplace, paused: boolean) =>
  update(d, (s) => { s.pacing = setMarketplacePaused(s.pacing, m, paused, d.now()); addLog(s, d.now(), `${paused ? "Paused" : "Resumed"} ${HOST_TABLE[m].label}`); });
