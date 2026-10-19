import Link from "next/link";
import { getServices, type Item } from "@/lib/data";
import StatusBar from "@/components/StatusBar";
import StatusBanner from "@/components/StatusBanner";
import NeedsActionPanel from "@/components/NeedsActionPanel";
import { loadOverview } from "@/lib/jobs/overview";
import { brandColor } from "@/lib/brands";

export const dynamic = "force-dynamic";

export default async function MissionControl() {
  const { store } = await getServices();
  const balance = await store.creditLedger.ensureMonthlyAllowance();
  const [counts, recent, profile, log, toShip] = await Promise.all([
    store.items.countsByStatus(), store.items.list({ limit: 4 }), store.profile.get(), store.syncLog.recent(3), store.sales.listToShip(),
  ]);
  // Never throws: if the 0005 tables are missing this is just { ready: false } and the rest of the page is unchanged.
  const queue = await loadOverview(store, new Date(), Number(process.env.WORKER_STALE_MINUTES) || undefined);
  const attention = queue.counts ? queue.counts.failed + queue.counts.needs_user : 0;
  const stat = (href: string, n: number, l: string) => (
    <Link href={href} className="stat"><div className="n">{n}</div><div className="l">{l}</div></Link>
  );
  return (
    <>
      <div className="row between" style={{ marginBottom: 10 }}>
        <h1 style={{ margin: 0 }}>Mission Control</h1>
        <span className="pill gold" title="AI credits left this month">{balance} credits</span>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>Welcome{profile?.displayName ? `, ${profile.displayName}` : ""}. Everything you need to list, ship and track.</p>

      {queue.health && <StatusBanner health={queue.health} compact />}
      <NeedsActionPanel entries={queue.needsAction} />

      <div className="card glow">
        <div className="grid c3">
          {stat("/items?tab=draft", counts.draft, "Drafts")}
          {stat("/items?tab=listed", counts.listed, "Listed")}
          {stat("/items?tab=sold", counts.sold, "Sold")}
        </div>
        <div style={{ marginTop: 12 }}><StatusBar counts={counts} /></div>
      </div>

      <div className="row" style={{ marginBottom: 12, flexWrap: "wrap" }}>
        <Link href="/items/new" className="btn primary">📷 Add item</Link>
        <Link href="/ship" className="btn">🚚 Ship<span className="badge-count">{toShip.length}</span></Link>
        <Link href="/items" className="btn">All items</Link>
        <Link href="/jobs" className="btn">Jobs{queue.counts && <span className="badge-count">{attention || queue.counts.queued + queue.counts.retry_wait + queue.counts.claimed + queue.counts.running}</span>}</Link>
      </div>

      <div className="card">
        <h2>Recent items</h2>
        {recent.length === 0 && <div className="empty">No items yet. Add your first one.</div>}
        {recent.map((i: Item) => (
          <Link key={i.id} href={`/items/${i.id}`} className="item">
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.title}</div>
              <div className="muted small">
                {i.platform && <><span className="dot" style={{ background: brandColor(i.platform) }} />{i.platform} · </>}{i.sku ?? "no SKU"}
              </div>
            </div>
            <span className={`pill ${i.status}`}>{i.status}</span>
          </Link>
        ))}
      </div>

      <div className="grid c2">
        <div className="banner"><b>Offers / Share</b><br />Coming in a later step.</div>
        <div className="card" style={{ margin: 0 }}>
          <h3>Sync log</h3>
          {log.length === 0 ? <span className="muted small">No sync activity yet.</span> : log.map((l) => <div key={l.id} className="small">{l.event}</div>)}
        </div>
      </div>
    </>
  );
}
