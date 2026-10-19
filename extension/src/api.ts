// Talks only to our own API origin, with the device token. Nothing else leaves the extension.
import type { ExtPollResult, ExtScanNext, ExtScanResult, ExtScanSale } from "../../src/lib/data/types";
import type { ResultCode } from "../../src/lib/ext/protocol";
import type { DoneResult } from "./steps";

export class ApiError extends Error {
  constructor(public status: number, public code: string | null, message: string) { super(message); }
}
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type PolledJob = { jobId: string; marketplace: string; action: string; payload: Record<string, unknown>; leaseExpiresAt: string | null; attempt: number };
export type PollResponse = Omit<ExtPollResult, "jobs"> & { jobs: PolledJob[]; pollAgainSeconds: number };

export function makeApi(origin: string, token: () => string | null, f: Fetch = (u, i) => fetch(u, i)) {
  async function post<T>(path: string, body: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const t = token();
    if (auth) { if (!t) throw new ApiError(401, "invalid_token", "Not paired"); headers.authorization = `Bearer ${t}`; }
    let res: Response;
    try { res = await f(`${origin}/api/v1${path}`, { method: "POST", headers, body: JSON.stringify(body ?? {}), credentials: "omit", cache: "no-store" }); }
    catch (e) { throw new ApiError(0, "network", `Can't reach ShadowSync (${(e as Error).message})`); }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new ApiError(res.status, typeof json.code === "string" ? json.code : null, typeof json.error === "string" ? json.error : `HTTP ${res.status}`);
    return json as T;
  }
  return {
    pairComplete: (code: string, label: string, extensionVersion: string) =>
      post<{ deviceId: string; label: string; token: string }>("/ext/pair/complete", { code, label, extensionVersion }, false),
    poll: (body: { extensionVersion: string; marketplaces?: Record<string, boolean>; ready?: string[]; limit?: number }) => post<PollResponse>("/ext/poll", body),
    scanNext: (marketplace: string) => post<ExtScanNext>("/ext/scan/next", { marketplace }),
    scanReport: (marketplace: string, sales: ExtScanSale[], nextCursor: string | null) => post<ExtScanResult>("/ext/scan/report", { marketplace, sales, nextCursor }),
    listingsReport: (marketplace: string, externalIds: string[]) => post<{ seen: number; flagged: number }>("/ext/scan/listings", { marketplace, externalIds: externalIds.slice(0, 1000) }),
    start: (id: string) => post(`/ext/jobs/${id}/start`, {}),
    extend: (id: string) => post(`/ext/jobs/${id}/extend`, {}),
    progress: (id: string, message: string) => post(`/ext/jobs/${id}/progress`, { message: message.slice(0, 300) }),
    result: (id: string, r: { ok: true; result?: DoneResult } | { ok: false; code: ResultCode; message: string }) => post(`/ext/jobs/${id}/result`, r),
  };
}
export type Api = ReturnType<typeof makeApi>;
