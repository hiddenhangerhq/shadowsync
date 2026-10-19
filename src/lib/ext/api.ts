// Extension API (spec 3 + 4): the device-token endpoints under /api/v1/ext and the dashboard's pairing / kill-switch endpoints.
// Plain functions over Services so they are testable without Next; route files are one-liners. Every body is validated with a strict
// schema (unknown fields are rejected). The device endpoints never look at a user session: only `Authorization: Bearer <device token>`.
import type { Services } from "../data/interfaces";
import { DeviceAuthError, SchemaMissingError, type Marketplace } from "../data/types";
import { IllegalTransitionError, outcomeFromError } from "../jobs/state-machine";
import { isUuid } from "../jobs/validate";
import type { ApiResult } from "../jobs/api";
import { SchemaError, parse, bool, obj } from "./schema";
import {
  isRelistAction, listingsReportSchema,
  buildActionRequest, isExtMarketplace, jobResultSchema, pairCompleteSchema, pollSchema, progressSchema, scanNextSchema, scanReportSchema,
  type ActionRequest, type ExtMarketplace,
} from "./protocol";
import { formatPairingCode, isDeviceToken, newDeviceToken, newPairingCode, normalizePairingCode, sha256Hex } from "./tokens";
import { allow } from "./ratelimit";

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): ApiResult => ({ status, body: { error, ...extra } });
const ok = (body: Record<string, unknown>, status = 200): ApiResult => ({ status, body });

export const MAX_BODY_BYTES = 256 * 1024;
/** Parse a JSON body with a size cap. Returns undefined for an empty body. */
export async function readJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; result: ApiResult }> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return { ok: false, result: fail(413, "Body too large") };
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, result: fail(413, "Body too large") };
  if (!text.trim()) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, result: fail(400, "Body must be JSON") }; }
}
export const bearer = (req: Request): string | null => {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
};
export const clientIp = (req: Request) => (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";

/** Map domain errors to HTTP. Unknown errors are not echoed to the device. */
async function handle(fn: () => Promise<ApiResult>): Promise<ApiResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SchemaError) return fail(400, e.message, { code: "invalid_payload" });
    if (e instanceof DeviceAuthError) return fail(e.status, e.message, { code: e.code });
    if (e instanceof IllegalTransitionError) return fail(409, e.message, { code: "illegal_transition" });
    if (e instanceof SchemaMissingError) return fail(503, e.message, { code: "schema_missing" });
    if (e instanceof Error && /^(Device|Job|Item|Listing) not found$/.test(e.message)) return fail(404, e.message);
    console.error("[ext api]", e instanceof Error ? e.message : e);
    return fail(500, "Server error", { code: "server_error" });
  }
}
/** Device endpoints: token format check and a per-token / per-IP flood guard before anything touches the database. */
function device(token: string | null, ip: string, fn: (token: string) => Promise<ApiResult>): Promise<ApiResult> {
  return handle(async () => {
    if (!isDeviceToken(token)) return fail(401, "Missing or invalid device token", { code: "invalid_token" });
    if (!allow(`t:${sha256Hex(token).slice(0, 16)}`, 120, 60_000) || !allow(`ip:${ip}`, 600, 60_000)) return fail(429, "Too many requests", { code: "rate_limited" });
    return fn(token);
  });
}

// ---------------------------------------------------------------- device endpoints (/api/v1/ext/*)
export const extPairComplete = (svc: Services, body: unknown, ip: string) =>
  handle(async () => {
    if (!allow(`pair:${ip}`, 10, 60_000)) return fail(429, "Too many pairing attempts, wait a minute", { code: "rate_limited" });
    const b = parse(pairCompleteSchema, body);
    const code = normalizePairingCode(b.code);
    if (!code) return fail(400, "That doesn't look like a pairing code", { code: "pairing_invalid" });
    const token = newDeviceToken();
    const r = await svc.device.pairComplete({ code, token, label: b.label ?? "Browser extension", extensionVersion: b.extensionVersion });
    // The ONLY time the raw token leaves the server. The extension keeps it in chrome.storage.local; we keep only its hash.
    return ok({ deviceId: r.deviceId, label: r.label, token }, 201);
  });

/** Poll: heartbeat + claim. Each claimed job goes out as a fixed action built from OUR data (never a URL or code to run). */
export const extPoll = (svc: Services, token: string | null, body: unknown, ip: string) =>
  device(token, ip, async (t) => {
    const b = parse(pollSchema, body);
    const r = await svc.device.poll(t, { extensionVersion: b.extensionVersion, marketplaces: b.marketplaces, ready: b.ready, limit: b.limit });
    const actions: (ActionRequest & { leaseExpiresAt: string | null; attempt: number })[] = [];
    for (const c of r.jobs) {
      const a = buildActionRequest(c.job, { listing: c.listing, item: c.item, soldAction: c.soldAction, saleConfirmed: c.saleConfirmed });
      if (!a) {
        await svc.device.jobResult(t, c.job.id, outcomeFromError("not_supported", `${c.job.marketplace} is not handled by the extension`)).catch(() => undefined);
        continue;
      }
      // Relist guard: a job queued before the item sold is never sent out.
      if (a.itemSold && isRelistAction(a.action, a.payload)) {
        await svc.device.jobResult(t, c.job.id, outcomeFromError("relist_blocked", "This item is Sold in Shadow Sync; undo the sale to list it again")).catch(() => undefined);
        continue;
      }
      actions.push({ ...a, leaseExpiresAt: c.job.leaseExpiresAt, attempt: c.job.attempts });
    }
    return ok({ device: r.device, marketplaces: r.marketplaces, requeued: r.requeued, jobs: actions, pollAgainSeconds: 300 });
  });

export const extScanNext = (svc: Services, token: string | null, body: unknown, ip: string) =>
  device(token, ip, async (t) => {
    const b = parse(scanNextSchema, body);
    return ok({ ...(await svc.device.scanNext(t, b.marketplace)) });
  });

export const extScanReport = (svc: Services, token: string | null, body: unknown, ip: string) =>
  device(token, ip, async (t) => {
    const b = parse(scanReportSchema, body);
    return ok({ ...(await svc.device.scanReport(t, { marketplace: b.marketplace, sales: b.sales, nextCursor: b.nextCursor })) });
  });

export const extListingsReport = (svc: Services, token: string | null, body: unknown, ip: string) =>
  device(token, ip, async (t) => {
    const b = parse(listingsReportSchema, body);
    return ok({ ...(await svc.device.listingsReport(t, { marketplace: b.marketplace, externalIds: b.externalIds })) });
  });

type JobVerb = "start" | "progress" | "extend" | "result";
export const extJob = (svc: Services, verb: JobVerb, token: string | null, id: string, body: unknown, ip: string) =>
  device(token, ip, async (t) => {
    if (!isUuid(id)) return fail(404, "Job not found for this browser", { code: "not_your_job" });
    switch (verb) {
      case "start": parse(obj({}), body); return ok({ job: await svc.device.jobStart(t, id) });
      case "extend": parse(obj({}), body); return ok({ job: await svc.device.jobExtend(t, id) });
      case "progress": await svc.device.jobProgress(t, id, parse(progressSchema, body).message); return ok({ ok: true });
      case "result": {
        const r = parse(jobResultSchema, body);
        // The server decides retry / needs-you / failed from the code (state machine), not the extension.
        const outcome = r.ok ? { kind: "success" as const, result: r.result ?? {} } : outcomeFromError(r.code ?? "action_failed", r.message ?? "Failed");
        const job = await svc.device.jobResult(t, id, outcome);
        return ok({ job: { id: job.id, status: job.status, nextRunAt: job.nextRunAt, lastErrorCode: job.lastErrorCode } });
      }
    }
  });

// ---------------------------------------------------------------- dashboard endpoints (signed-in session)
async function signedIn(svc: Services, fn: () => Promise<ApiResult>) {
  if (!(await svc.auth.getUser())) return fail(401, "Not signed in");
  return handle(fn);
}
/** Settings > Extension > Pair this browser: a one-time code, valid 5 minutes. Only its hash is stored. */
export const pairStart = (svc: Services) =>
  signedIn(svc, async () => {
    const code = newPairingCode();
    const { expiresAt } = await svc.store.pairing.start(code);
    return ok({ code: formatPairingCode(code), expiresAt }, 201);
  });

const pauseBody = obj({ paused: bool });
export const devicePause = (svc: Services, id: string, body: unknown) =>
  signedIn(svc, async () => {
    if (!isUuid(id)) return fail(404, "Device not found");
    const b = parse(pauseBody, body);
    return ok({ device: await svc.store.devices.setPaused(id, b.paused) });
  });
export const deviceRevoke = (svc: Services, id: string) =>
  signedIn(svc, async () => {
    if (!isUuid(id)) return fail(404, "Device not found");
    return ok({ device: await svc.store.devices.revoke(id) });
  });
export const marketplacePause = (svc: Services, id: string, marketplace: string, body: unknown) =>
  signedIn(svc, async () => {
    if (!isUuid(id)) return fail(404, "Device not found");
    if (!isExtMarketplace(marketplace)) return fail(400, "Not an extension marketplace");
    const b = parse(pauseBody, body);
    return ok({ state: await svc.store.devices.setMarketplacePaused(id, marketplace as ExtMarketplace as Marketplace, b.paused) });
  });
