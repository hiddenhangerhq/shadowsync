// Status banner logic (spec section 6): a pure function of data, so every state is unit-testable and nothing is hard-coded in the UI.
import { isOpen } from "./state-machine";
import type { ExtensionDevice, Job, Marketplace, MarketplaceLoginState, NeedsActionEntry, ScanCursor } from "../data/types";

export type HealthLevel = "green" | "yellow" | "red";
export interface HealthItem { key: string; level: HealthLevel; title: string; detail?: string }
export interface Health { level: HealthLevel; items: HealthItem[] }

export const EXT_GREEN_MS = 10 * 60_000;
export const EXT_RED_MS = 30 * 60_000;
export const WORKER_STALE_MS = 15 * 60_000;
export const CURSOR_STUCK_MS = 60 * 60_000;
export const OVERSELL_RISK_MS = 60 * 60_000;

export interface HealthInput {
  now: Date;
  devices: ExtensionDevice[];
  marketplaceState: MarketplaceLoginState[];
  jobs: Job[];
  cursors: ScanCursor[];
  needsAction: NeedsActionEntry[];
  workerLastRunAt: string | null;
  workerStaleMs?: number;
}

export function formatAge(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}
const RANK: Record<HealthLevel, number> = { green: 0, yellow: 1, red: 2 };
const label = (m: Marketplace) => m.charAt(0).toUpperCase() + m.slice(1);

export function computeHealth(i: HealthInput): Health {
  const t = i.now.getTime();
  const age = (iso: string | null) => (iso ? t - new Date(iso).getTime() : Infinity);
  const items: HealthItem[] = [];

  // ---- browser extension
  const extWaiting = i.jobs.filter((j) => j.executor === "extension" && ["queued", "claimed", "running", "retry_wait"].includes(j.status)).length;
  const waitingNote = extWaiting ? `${extWaiting} job${extWaiting === 1 ? "" : "s"} waiting` : undefined;
  const live = i.devices.filter((d) => !d.revokedAt);
  if (!i.devices.length) {
    if (extWaiting) items.push({ key: "extension", level: "red", title: "No browser extension is paired", detail: waitingNote });
  } else if (!live.length) {
    items.push({ key: "extension", level: extWaiting ? "red" : "yellow", title: "Extension access was revoked", detail: waitingNote });
  } else {
    const active = live.filter((d) => !d.paused);
    if (!active.length) {
      items.push({ key: "extension", level: "yellow", title: "Extension is paused", detail: waitingNote });
    } else {
      const seen = Math.min(...active.map((d) => age(d.lastSeenAt)));
      if (seen < EXT_GREEN_MS) items.push({ key: "extension", level: "green", title: "Extension connected", detail: `Checked in ${formatAge(seen)} ago` });
      else if (seen <= EXT_RED_MS) items.push({ key: "extension", level: "yellow", title: `Extension hasn't checked in for ${formatAge(seen)}`, detail: ["Your browser may be asleep or closed", waitingNote].filter(Boolean).join(". ") });
      else items.push({
        key: "extension", level: extWaiting ? "red" : "yellow", title: "Extension not running or signed out",
        detail: [Number.isFinite(seen) ? `Last seen ${formatAge(seen)} ago` : "Never checked in", waitingNote].filter(Boolean).join(". "),
      });
    }
    // Per marketplace: the newest yes/no from any live device.
    const latest = new Map<Marketplace, MarketplaceLoginState>();
    for (const s of i.marketplaceState) {
      if (!live.some((d) => d.id === s.deviceId)) continue;
      const cur = latest.get(s.marketplace);
      if (!cur || s.checkedAt > cur.checkedAt) latest.set(s.marketplace, s);
    }
    for (const s of latest.values()) if (!s.loggedIn) items.push({ key: `signed_out:${s.marketplace}`, level: "yellow", title: `Signed out of ${label(s.marketplace)} in your browser`, detail: "Its jobs wait until you sign in again" });
  }

  // ---- server worker
  const staleMs = i.workerStaleMs ?? WORKER_STALE_MS;
  const workerAge = age(i.workerLastRunAt);
  const pending = i.jobs.filter((j) =>
    j.status === "retry_wait" || (j.status === "queued" && j.executor === "api") ||
    ((j.status === "claimed" || j.status === "running") && j.leaseExpiresAt !== null && new Date(j.leaseExpiresAt).getTime() <= t)).length;
  if (workerAge > staleMs) {
    if (pending) items.push({ key: "worker", level: "red", title: Number.isFinite(workerAge) ? `Background worker hasn't run for ${formatAge(workerAge)}` : "Background worker has never run",
      detail: `${pending} job${pending === 1 ? "" : "s"} need it (retries, expired leases)` });
    else if (Number.isFinite(workerAge)) items.push({ key: "worker", level: "green", title: "Background worker idle", detail: `Last ran ${formatAge(workerAge)} ago, nothing waiting` });
  } else items.push({ key: "worker", level: "green", title: "Background worker running", detail: `Last ran ${formatAge(workerAge)} ago` });

  // ---- sales scan cursors
  for (const c of i.cursors) {
    const sinceOk = age(c.lastSuccessAt ?? c.createdAt);
    if (sinceOk > CURSOR_STUCK_MS) items.push({ key: `cursor:${c.marketplace}:${c.scopeKey}`, level: "red", title: `${label(c.marketplace)} sales scan is stuck`, detail: `No successful scan for ${formatAge(sinceOk)}${c.lastError ? `. Last error: ${c.lastError}` : ""}` });
    else if (c.lastError) items.push({ key: `cursor:${c.marketplace}:${c.scopeKey}`, level: "yellow", title: `${label(c.marketplace)} sales scan had an error`, detail: c.lastError });
  }

  // ---- overselling risk
  const stale = i.jobs.filter((j) => (j.jobType === "delist" || j.jobType === "mark_sold") && isOpen(j.status) && t - new Date(j.createdAt).getTime() > OVERSELL_RISK_MS);
  if (stale.length) items.push({ key: "oversell", level: "red", title: `${stale.length} delist${stale.length === 1 ? "" : "s"} unfinished for over an hour`, detail: "Risk of overselling" });
  const failed = i.needsAction.filter((n) => n.kind === "delist_failed").length;
  if (failed) items.push({ key: "delist_failed", level: "red", title: `${failed} failed delist${failed === 1 ? "" : "s"}`, detail: "Fix them in the Sold but still listed list" });

  items.sort((a, b) => RANK[b.level] - RANK[a.level]);
  const level = items.reduce<HealthLevel>((m, x) => (RANK[x.level] > RANK[m] ? x.level : m), "green");
  return { level, items };
}
