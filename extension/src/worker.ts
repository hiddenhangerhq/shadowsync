// The extension's brain, with the browser, storage, clock and API injected so it is unit-tested with fakes.
// One job at a time per marketplace, random 20-90 s gaps, daily caps, a pause after an error burst, an automatic pause after
// 2 security checks in a row, and the kill switch (this browser, or one marketplace) are all enforced here before any tab opens.
import { HOST_TABLE, EXT_MARKETPLACES, type ExtMarketplace, type ResultCode } from "../../src/lib/ext/protocol";
import { validateAction } from "./handler";
import { begin, canRun, emptyPacing, finish, isReady, setDevicePaused, setMarketplacePaused, type PacingState } from "./pacing";
import { runAction, type Browser, type RunOutcome } from "./runner";
import { ApiError, type Api } from "./api";

export interface LogLine { at: number; text: string }
export interface ExtState {
  token: string | null; deviceId: string | null; deviceLabel: string | null;
  pacing: PacingState;
  logins: Partial<Record<ExtMarketplace, { loggedIn: boolean; at: number }>>;
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
    s.pacing = finish(s.pacing, m, out.ok ? { ok: true } : { ok: false, code: out.code }, d.now(), d.rand());
    if (out.ok && typeof out.loggedIn === "boolean") s.logins[m] = { loggedIn: out.loggedIn, at: d.now() };
    if (!out.ok && out.code === "signed_out") s.logins[m] = { loggedIn: false, at: d.now() };
    if (!out.ok) addLog(s, d.now(), `${HOST_TABLE[m].label} ${action}: ${out.message}`);
  });
  return out;
}

export async function checkLogin(d: Deps, m: ExtMarketplace) {
  const r = await runLocal(d, m, "checkLogin", {});
  if (r.ok) await update(d, (s) => addLog(s, d.now(), `${HOST_TABLE[m].label}: ${r.loggedIn ? "signed in" : "signed out"}`));
  return r;
}
export async function checkAllLogins(d: Deps) {
  const s = await d.store.load();
  if (!s.token || s.pacing.devicePaused) return;
  for (const m of await connected(d)) if (isReady(s.pacing, m, d.now())) await checkLogin(d, m);
}

/** Poll: heartbeat + login states, then run what the server handed us, one at a time. */
export async function poll(d: Deps): Promise<{ ran: number } | { skipped: string }> {
  const s = await d.store.load();
  if (!s.token) return { skipped: "not_paired" };
  const mps = await connected(d);
  const now = d.now();
  const marketplaces: Record<string, boolean> = {};
  for (const m of mps) if (s.logins[m]) marketplaces[m] = s.logins[m]!.loggedIn;
  const ready = s.pacing.devicePaused ? [] : mps.filter((m) => s.logins[m]?.loggedIn && isReady(s.pacing, m, now));
  let res;
  try { res = await d.api.poll({ extensionVersion: d.version, marketplaces, ready, limit: ready.length }); }
  catch (e) { return handleApiError(d, e); }
  await update(d, (st) => {
    st.lastPollAt = now; st.lastError = null; st.deviceLabel = res.device.label;
    st.server = { devicePaused: res.device.paused, paused: Object.fromEntries(res.marketplaces.map((x) => [x.marketplace, x.paused ? (x.pausedReason ?? "Paused") : null])) };
    if (res.requeued) addLog(st, now, `${res.requeued} job(s) back in the queue after signing in`);
  });
  let ran = 0;
  for (const raw of res.jobs) { await runJob(d, raw); ran++; }
  return { ran };
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
  await update(d, (st) => { st.pacing = begin(st.pacing, m, a.action, d.now()); });
  const lease = setInterval(() => { d.api.extend(raw.jobId).catch(() => undefined); }, 60_000);
  let out: RunOutcome;
  try {
    out = await runAction(d.browser, a, { onProgress: (msg) => { d.api.progress(raw.jobId, msg).catch(() => undefined); } });
  } finally { clearInterval(lease); }
  await update(d, (st) => {
    st.pacing = finish(st.pacing, m, out.ok ? { ok: true } : { ok: false, code: out.code }, d.now(), d.rand());
    if (!out.ok && out.code === "signed_out") st.logins[m] = { loggedIn: false, at: d.now() };
    if (out.ok && typeof out.loggedIn === "boolean") st.logins[m] = { loggedIn: out.loggedIn, at: d.now() };
    addLog(st, d.now(), `${HOST_TABLE[m].label} ${a.action}: ${out.ok ? (out.result.note ?? "done") : out.message}`);
  });
  await report(d, raw.jobId, out.ok ? { ok: true, result: out.result } : { ok: false, code: out.code, message: out.message });
}

/** Sales scan: ask the server for the cursor, read the sales page, report. The server dedupes and creates the delists. */
export async function scan(d: Deps) {
  const s = await d.store.load();
  if (!s.token || s.pacing.devicePaused) return;
  for (const m of await connected(d)) {
    if (!s.logins[m]?.loggedIn || serverPaused(s, m) || !isReady(s.pacing, m, d.now())) continue;
    try {
      // Once a day, a listing scan instead: the server flags any item Sold in Shadow Sync that is still live here.
      if (d.now() - (s.listingsScanAt?.[m] ?? 0) > 24 * 3600_000) {
        const r = await runLocal(d, m, "getListings", {});
        if (r.ok) {
          const rep = await d.api.listingsReport(m, r.listingIds ?? []);
          await update(d, (st) => {
            st.listingsScanAt = { ...(st.listingsScanAt ?? {}), [m]: d.now() };
            if (rep.flagged) addLog(st, d.now(), `${HOST_TABLE[m].label}: ${rep.flagged} sold item(s) still live, see Sold but still active`);
          });
        }
        continue;
      }
      const next = await d.api.scanNext(m);
      const r = await runLocal(d, m, "getSales", { cursor: next.cursor, limit: Math.min(next.limit, 100) });
      if (!r.ok) continue;
      const rep = await d.api.scanReport(m, r.sales ?? [], r.nextCursor ?? null);
      if (rep.jobsCreated) await update(d, (st) => addLog(st, d.now(), `${HOST_TABLE[m].label}: ${rep.stored} new sale(s), ${rep.jobsCreated} delist(s) queued`));
    } catch (e) { await handleApiError(d, e); }
  }
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
export const pauseMarketplace = (d: Deps, m: ExtMarketplace, paused: boolean) =>
  update(d, (s) => { s.pacing = setMarketplacePaused(s.pacing, m, paused, d.now()); addLog(s, d.now(), `${paused ? "Paused" : "Resumed"} ${HOST_TABLE[m].label}`); });
