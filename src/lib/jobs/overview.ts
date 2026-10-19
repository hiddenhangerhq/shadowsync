// One loader for everything the dashboard shows about the queue. NEVER throws: Mission Control must keep working when the 0005 tables
// are missing (David has not run the SQL yet) or anything else goes wrong here.
import type { DataStore } from "../data/interfaces";
import { SchemaMissingError, type ExtensionDevice, type Job, type JobStatus, type MarketplaceLoginState, type NeedsActionEntry } from "../data/types";
import { computeHealth, WORKER_STALE_MS, type Health } from "./health";

export interface Overview {
  ready: boolean;
  schemaMissing: boolean;
  error: string | null;
  health: Health | null;
  needsAction: NeedsActionEntry[];
  counts: Record<JobStatus, number> | null;
  devices: ExtensionDevice[];
  marketplaceState: MarketplaceLoginState[];
  jobs: Job[];
  workerLastRunAt: string | null;
}

export async function loadOverview(store: DataStore, now = new Date(), workerStaleMinutes?: number): Promise<Overview> {
  try {
    const [jobs, devices, marketplaceState, cursors, needsAction, workerLastRunAt, counts] = await Promise.all([
      store.jobs.list({ limit: 500 }), store.devices.list(), store.devices.marketplaceState(), store.cursors.list(),
      store.needsAction.list(now), store.worker.lastRun(), store.jobs.counts(),
    ]);
    const workerStaleMs = workerStaleMinutes && workerStaleMinutes > 0 ? workerStaleMinutes * 60_000 : WORKER_STALE_MS;
    const health = computeHealth({ now, devices, marketplaceState, jobs, cursors, needsAction, workerLastRunAt, workerStaleMs });
    return { ready: true, schemaMissing: false, error: null, health, needsAction, counts, devices, marketplaceState, jobs, workerLastRunAt };
  } catch (e) {
    return {
      ready: false, schemaMissing: e instanceof SchemaMissingError, error: e instanceof Error ? e.message : String(e),
      health: null, needsAction: [], counts: null, devices: [], marketplaceState: [], jobs: [], workerLastRunAt: null,
    };
  }
}
