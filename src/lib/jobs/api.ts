// Dashboard job API (spec section 3), as plain functions over Services so they are testable without Next. The route files are one-liners
// around these. Auth is the logged-in session (the data layer's auth). The extension's /ext/* endpoints are a later step.
import type { Services } from "../data/interfaces";
import { IllegalTransitionError } from "./state-machine";
import { SchemaMissingError, type Job } from "../data/types";
import { executorFor } from "./sale-detection";
import { parseCreateJob, parseLimit, parseStatusFilter, isUuid } from "./validate";
import { buildTimeline } from "./timeline";
import { loadOverview } from "./overview";

export interface ApiResult { status: number; body: Record<string, unknown> }
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): ApiResult => ({ status, body: { error, ...extra } });
const ok = (body: Record<string, unknown>, status = 200): ApiResult => ({ status, body });

/** Common wrapper: 401 when signed out, and domain errors mapped to clean statuses. */
async function guard(svc: Services, fn: () => Promise<ApiResult>): Promise<ApiResult> {
  if (!(await svc.auth.getUser())) return fail(401, "Not signed in");
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SchemaMissingError) return fail(503, e.message, { code: "schema_missing" });
    if (e instanceof IllegalTransitionError) return fail(409, e.message, { code: "illegal_transition", from: e.from, to: e.to });
    const m = e instanceof Error ? e.message : String(e);
    if (/not found/i.test(m)) return fail(404, m);
    if (/changed by another worker/i.test(m)) return fail(409, m);
    throw e;
  }
}

export const listJobs = (svc: Services, q: { status?: string | null; limit?: string | null; itemId?: string | null }) =>
  guard(svc, async () => {
    const status = parseStatusFilter(q.status);
    if (!status.ok) return fail(400, status.error);
    if (q.itemId && !isUuid(q.itemId)) return fail(400, "itemId must be an id");
    const jobs = await svc.store.jobs.list({ status: status.value, itemId: q.itemId ?? undefined, limit: parseLimit(q.limit) });
    return ok({ jobs });
  });

export const createJob = (svc: Services, body: unknown) =>
  guard(svc, async () => {
    const p = parseCreateJob(body);
    if (!p.ok) return fail(400, p.error);
    const r = p.value;
    if (r.itemId && !(await svc.store.items.get(r.itemId))) return fail(404, "Item not found");
    if (r.listingId) {
      const l = (await svc.store.listings.list()).find((x) => x.id === r.listingId);
      if (!l) return fail(404, "Listing not found");
      if (l.marketplace !== r.marketplace || (r.itemId && l.itemId !== r.itemId)) return fail(400, "Listing does not belong to that item and marketplace");
    }
    const executor = executorFor(r.marketplace, await svc.store.connections.list());
    const { job, created } = await svc.store.jobs.enqueue({
      marketplace: r.marketplace, jobType: r.jobType, executor, itemId: r.itemId, listingId: r.listingId, payload: r.payload,
      idempotencyKey: r.idempotencyKey ?? `manual:${r.jobType}:${r.listingId ?? `${r.itemId}:${r.marketplace}`}`,
    });
    if (created && (r.jobType === "delist" || r.jobType === "mark_sold")) {
      await svc.store.itemSyncLog.append({ event: "delist_queued", source: "manual", itemId: job.itemId, listingId: job.listingId,
        marketplace: job.marketplace, jobId: job.id, detail: `${job.jobType} queued by you` }).catch(() => undefined);
    }
    return ok({ job, created, deduped: !created }, created ? 201 : 200);
  });

export const getJobDetail = (svc: Services, id: string) =>
  guard(svc, async () => {
    if (!isUuid(id)) return fail(404, "Job not found");
    const job = await svc.store.jobs.get(id);
    if (!job) return fail(404, "Job not found");
    return ok({ job, events: await svc.store.jobs.events([id]) });
  });

const act = (verb: "retry" | "cancel") => (svc: Services, id: string) =>
  guard(svc, async () => {
    if (!isUuid(id)) return fail(404, "Job not found");
    const job: Job = await svc.store.jobs[verb](id);
    return ok({ job });
  });
export const retryJob = act("retry");
export const cancelJob = act("cancel");

export const getNeedsAction = (svc: Services) => guard(svc, async () => ok({ entries: await svc.store.needsAction.list() }));

export const getItemSyncLog = (svc: Services, itemId: string) =>
  guard(svc, async () => {
    if (!isUuid(itemId)) return fail(404, "Item not found");
    const item = await svc.store.items.get(itemId);
    if (!item) return fail(404, "Item not found");
    const [entries, jobs] = await Promise.all([svc.store.itemSyncLog.list({ itemId }), svc.store.jobs.list({ itemId })]);
    const events = await svc.store.jobs.events(jobs.map((j) => j.id));
    return ok({ item: { id: item.id, sku: item.sku, title: item.title }, timeline: buildTimeline(entries, jobs, events) });
  });

export const getExtensionStatus = (svc: Services, workerStaleMinutes?: number) =>
  guard(svc, async () => {
    const o = await loadOverview(svc.store, new Date(), workerStaleMinutes);
    if (!o.ready) return fail(503, o.error ?? "Not set up yet", { code: o.schemaMissing ? "schema_missing" : "error" });
    return ok({ devices: o.devices, marketplaces: o.marketplaceState, health: o.health, workerLastRunAt: o.workerLastRunAt });
  });
