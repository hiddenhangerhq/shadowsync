// Request validation for the dashboard job API. Pure. The client never chooses executor, priority, attempts or timing.
import { JOB_STATUSES, JOB_TYPES, type JobStatus, type JobType, type Marketplace } from "../data/types";

export const MARKETPLACE_IDS: Marketplace[] = ["ebay", "poshmark", "depop", "whatnot", "grailed", "etsy", "mercari", "shopify", "wix", "facebook", "vinted", "other"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export interface CreateJobRequest {
  marketplace: Marketplace;
  jobType: JobType;
  itemId: string | null;
  listingId: string | null;
  idempotencyKey: string | null;
  payload: Record<string, unknown>;
}
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseCreateJob(body: unknown): Parsed<CreateJobRequest> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (!MARKETPLACE_IDS.includes(b.marketplace as Marketplace)) return { ok: false, error: "marketplace is missing or unknown" };
  if (!JOB_TYPES.includes(b.jobType as JobType)) return { ok: false, error: `jobType must be one of ${JOB_TYPES.join(", ")}` };
  const jobType = b.jobType as JobType;
  const opt = (k: string) => (b[k] === undefined || b[k] === null ? null : b[k]);
  const itemId = opt("itemId"), listingId = opt("listingId");
  if (itemId !== null && !isUuid(itemId)) return { ok: false, error: "itemId must be an id" };
  if (listingId !== null && !isUuid(listingId)) return { ok: false, error: "listingId must be an id" };
  if (jobType !== "sync_status" && !itemId) return { ok: false, error: "itemId is required for this job type" };
  if (["delist", "mark_sold", "update_listing"].includes(jobType) && !listingId) return { ok: false, error: "listingId is required for this job type" };
  const key = opt("idempotencyKey");
  if (key !== null && (typeof key !== "string" || !key.trim() || key.length > 200)) return { ok: false, error: "idempotencyKey must be a non-empty string up to 200 characters" };
  const payload = b.payload === undefined ? {} : b.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, error: "payload must be an object" };
  if (JSON.stringify(payload).length > 10_000) return { ok: false, error: "payload is too large (10 KB max)" };
  for (const k of ["executor", "priority", "maxAttempts", "nextRunAt", "status", "attempts"]) {
    if (k in b) return { ok: false, error: `${k} is set by the server` };
  }
  return { ok: true, value: { marketplace: b.marketplace as Marketplace, jobType, itemId: itemId as string | null, listingId: listingId as string | null, idempotencyKey: key as string | null, payload: payload as Record<string, unknown> } };
}

/** `status=queued,failed` -> validated list. Empty / missing = no filter. */
export function parseStatusFilter(raw: string | null | undefined): Parsed<JobStatus[] | undefined> {
  if (!raw) return { ok: true, value: undefined };
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = parts.find((p) => !JOB_STATUSES.includes(p as JobStatus));
  if (bad) return { ok: false, error: `Unknown status "${bad}"` };
  return { ok: true, value: parts as JobStatus[] };
}
export function parseLimit(raw: string | null | undefined, def = 100, max = 500): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
}
