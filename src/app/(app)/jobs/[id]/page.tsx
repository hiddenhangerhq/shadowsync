import Link from "next/link";
import { notFound } from "next/navigation";
import { getServices, type Job, type JobEvent } from "@/lib/data";
import { isUuid } from "@/lib/jobs/validate";
import { when } from "@/lib/jobs/format";
import { jobEventLabel, jobLabel, statusWord } from "@/lib/jobs/labels";
import { cancelJobAction, retryJobAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { store } = await getServices();
  let job: Job | null = null;
  let events: JobEvent[] = [];
  try {
    job = await store.jobs.get(id);
    if (job) events = await store.jobs.events([id]);
  } catch {
    // tables missing or a read error: show the same "not found" page rather than crash
  }
  if (!job) notFound();
  const item = job.itemId ? await store.items.get(job.itemId) : null;
  const rows: [string, string | number | null][] = [
    ["Marketplace", job.marketplace], ["Worker", job.executor === "api" ? "Official API" : "Browser extension"],
    ["Attempts", `${job.attempts} of ${job.maxAttempts}`], ["Next run", job.status === "queued" || job.status === "retry_wait" ? when(job.nextRunAt) : null],
    ["Lease until", job.leaseExpiresAt ? when(job.leaseExpiresAt) : null], ["Created", when(job.createdAt)], ["Finished", job.finishedAt ? when(job.finishedAt) : null],
    ["Last error", job.lastError ? `${job.lastError}${job.lastErrorCode ? ` (${job.lastErrorCode})` : ""}` : null],
  ];
  const open = ["queued", "claimed", "running", "retry_wait", "needs_user"].includes(job.status);
  return (
    <>
      <Link href="/jobs" className="muted small">← Jobs</Link>
      <div className="row between" style={{ margin: "6px 0 10px", flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>{jobLabel(job)}</h1><span className={`pill ${job.status}`}>{statusWord(job.status)}</span>
      </div>
      {item && <p style={{ marginTop: 0 }}>For <Link href={`/items/${item.id}`}>{item.title}</Link>{item.sku && <> · <span className="sku">{item.sku}</span></>}</p>}
      <div className="card">
        {rows.filter(([, v]) => v).map(([k, v]) => <div key={k} className="row between small" style={{ padding: "4px 0" }}><span className="muted">{k}</span><span style={{ textAlign: "right" }}>{v}</span></div>)}
        <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
          {(job.status === "failed" || job.status === "needs_user") && <form action={retryJobAction.bind(null, job.id)}><button className="btn primary">Retry</button></form>}
          {open && <form action={cancelJobAction.bind(null, job.id)}><button className="btn danger">Cancel job</button></form>}
        </div>
      </div>
      <div className="card">
        <h2>Job log</h2>
        <ul className="tl">
          {events.map((e) => (
            <li key={e.id}><span className="when">{when(e.at)}</span><span><span className="small"><b>{jobEventLabel(e.toStatus, jobLabel(job), job.marketplace)}</b>{e.message && !/^queued$/i.test(e.message) ? ` · ${e.message}` : ""}</span></span></li>
          ))}
          {events.length === 0 && <li className="muted small">No events yet.</li>}
        </ul>
      </div>
    </>
  );
}
