import Link from "next/link";
import { getServices, type Job, type JobStatus } from "@/lib/data";
import StatusBanner from "@/components/StatusBanner";
import NeedsActionPanel from "@/components/NeedsActionPanel";
import { loadOverview } from "@/lib/jobs/overview";
import { when, words } from "@/lib/jobs/format";
import { retryJobAction, cancelJobAction } from "./actions";

export const dynamic = "force-dynamic";

const TABS: { id: string; label: string; statuses?: JobStatus[] }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active", statuses: ["queued", "claimed", "running", "retry_wait"] },
  { id: "attention", label: "Needs you", statuses: ["needs_user", "failed"] },
  { id: "done", label: "Done", statuses: ["succeeded"] },
  { id: "canceled", label: "Canceled", statuses: ["canceled"] },
];

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab = "all" } = await searchParams;
  const current = TABS.find((t) => t.id === tab) ?? TABS[0];
  const { store } = await getServices();
  const overview = await loadOverview(store, new Date(), Number(process.env.WORKER_STALE_MINUTES) || undefined);
  let jobs: Job[] = [];
  let loadError: string | null = overview.ready ? null : overview.error;
  if (overview.ready) {
    try { jobs = await store.jobs.list({ status: current.statuses, limit: 200 }); }
    catch (e) { loadError = e instanceof Error ? e.message : String(e); }
  }
  const missing = !overview.ready && overview.schemaMissing;
  return (
    <>
      <div className="row between" style={{ marginBottom: 10 }}>
        <h1 style={{ margin: 0 }}>Jobs</h1>
        <Link href="/" className="muted small">← Mission Control</Link>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>The to-do list behind your listings: delists, mark-sold and listing jobs, with retries and a log for each.</p>

      {missing && (
        <div className="setup"><b>Job queue not set up yet.</b><br /><span className="small muted">Run the 0005 SQL once in Supabase (SQL editor), then reload this page.</span></div>
      )}
      {!missing && loadError && <p className="err">Could not load jobs: {loadError}</p>}
      {overview.health && <StatusBanner health={overview.health} />}
      <NeedsActionPanel entries={overview.needsAction} />

      {overview.ready && (
        <>
          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <Link key={t.id} href={t.id === "all" ? "/jobs" : `/jobs?tab=${t.id}`} className={"tab" + (t.id === current.id ? " on" : "")}>
                {t.label}
                {t.statuses && overview.counts && <span className="badge-count">{t.statuses.reduce((n, s) => n + overview.counts![s], 0)}</span>}
              </Link>
            ))}
          </div>
          {jobs.length === 0 && !loadError && <div className="card empty">No jobs here yet. They appear when a sale needs a delist or you queue a listing.</div>}
          {jobs.map((j) => (
            <div key={j.id} className="item jobrow">
              <Link href={`/jobs/${j.id}`} style={{ minWidth: 0, flex: "1 1 220px", color: "var(--text)" }}>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <b>{words(j.jobType)}</b><span className="muted small">· {j.marketplace} · {j.executor === "api" ? "official API" : "browser extension"}</span>
                  <span className={`pill ${j.status}`}>{words(j.status)}</span>
                </div>
                <div className="muted small">
                  {when(j.createdAt)} · attempt {j.attempts}/{j.maxAttempts}
                  {j.status === "retry_wait" && ` · retries ${when(j.nextRunAt)}`}
                  {j.lastError && ` · ${j.lastError}`}
                </div>
              </Link>
              <div className="row" style={{ gap: 6 }}>
                {(j.status === "failed" || j.status === "needs_user") && <form action={retryJobAction.bind(null, j.id)}><button className="btn sm primary">Retry</button></form>}
                {["queued", "claimed", "running", "retry_wait", "needs_user"].includes(j.status) && <form action={cancelJobAction.bind(null, j.id)}><button className="btn sm danger">Cancel</button></form>}
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}

