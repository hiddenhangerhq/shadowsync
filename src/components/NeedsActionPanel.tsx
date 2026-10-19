import Link from "next/link";
import type { NeedsActionEntry } from "@/lib/data/types";
import { formatAge } from "@/lib/jobs/health";
import { ignoreNeedsActionAction, markDelistedAction, retryJobAction } from "@/app/(app)/jobs/actions";

const KIND: Record<NeedsActionEntry["kind"], string> = {
  delist_failed: "Delist failed", delist_stuck: "Delist stuck", sold_still_listed: "Sold, still listed",
  unmatched_sale: "Unknown item", sale_cancelled: "Sale cancelled",
};

/** "Sold but still listed" (spec 6A). Renders nothing when there is nothing to do, so a healthy account stays clean. */
export default function NeedsActionPanel({ entries }: { entries: NeedsActionEntry[] }) {
  if (!entries.length) return null;
  return (
    <section className="card na" aria-label="Sold but still listed">
      <div className="row between"><h2 style={{ margin: 0 }}>Sold but still listed<span className="badge-count">{entries.length}</span></h2></div>
      <p className="muted small" style={{ margin: "4px 0 8px" }}>These need you. Each row clears itself once the delist is confirmed.</p>
      {entries.map((e) => (
        <div key={e.key} className={`na-row ${e.kind}`}>
          <div style={{ minWidth: 0, flex: "1 1 220px" }}>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <span className="pill late">{KIND[e.kind]}</span>
              {e.sku && <span className="sku">{e.sku}</span>}
              {e.itemId ? <Link href={`/items/${e.itemId}`}>{e.title ?? "item"}</Link> : <span>{e.title ?? ""}</span>}
              {e.marketplace && <span className="muted small">· {e.marketplace}</span>}
            </div>
            <div className="small">{e.message}</div>
            <div className="small muted">Overdue {formatAge(e.overdueMs)}</div>
          </div>
          <div className="row" style={{ flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
            {e.actions.includes("retry") && e.jobId && <form action={retryJobAction.bind(null, e.jobId)}><button className="btn sm primary">Retry</button></form>}
            {e.actions.includes("open_listing") && e.url && <a className="btn sm" href={e.url} target="_blank" rel="noopener noreferrer">Open listing</a>}
            {e.actions.includes("mark_delisted") && e.listingId && <form action={markDelistedAction.bind(null, e.listingId)}><button className="btn sm">Mark delisted</button></form>}
            {e.actions.includes("ignore") && <form action={ignoreNeedsActionAction.bind(null, e.key)}><button className="btn sm">Ignore</button></form>}
          </div>
        </div>
      ))}
    </section>
  );
}
