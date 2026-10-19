import { notFound } from "next/navigation";
import Link from "next/link";
import { getServices } from "@/lib/data";
import PhotoUploader from "@/components/PhotoUploader";
import { buildTimeline } from "@/lib/jobs/timeline";
import JobLive from "@/components/JobLive";
import JobMark from "@/components/JobMark";
import { when } from "@/lib/jobs/format";
import { deleteItemAction, deletePhotoAction, linkListingAction, setStatusAction, testAction } from "../actions";
import { isTestItem, LINKABLE_MARKETPLACES } from "@/lib/jobs/test-actions";
import { isExtMarketplace } from "@/lib/ext/protocol";

export const dynamic = "force-dynamic";

export default async function ItemPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const { store, storage } = await getServices();
  const item = await store.items.get(id);
  if (!item) notFound();
  const photos = await store.photos.listForItem(id);
  const urls = await Promise.all(photos.map((p) => storage.getUrl(p.path)));
  // Sync log (spec 6A). If the 0005 tables are missing this stays empty and the page is unchanged.
  const timeline = await (async () => {
    try {
      const [entries, jobs] = await Promise.all([store.itemSyncLog.list({ itemId: id }), store.jobs.list({ itemId: id })]);
      return buildTimeline(entries, jobs, await store.jobs.events(jobs.map((j) => j.id)));
    } catch { return null; }
  })();
  const listings = (await store.listings.list().catch(() => [])).filter((l) => l.itemId === id);
  const test = isTestItem(item);
  const rows: [string, string | number | null][] = [
    ["SKU", item.sku], ["COGS", item.cogs], ["Purchased at", item.purchaseLocation], ["Category", item.category],
    ["Platform", item.platform], ["Asking", item.askingPrice], ["Listed", item.dateListed], ["Sold", item.dateSold], ["Price sold", item.priceSold],
  ];
  return (
    <>
      <Link href={`/items?tab=${item.status === "delisted" ? "draft" : item.status}`} className="muted small">← Items</Link>
      <div className="row between" style={{ margin: "6px 0 10px" }}>
        <h1 style={{ margin: 0 }}>{item.title}</h1><span className={`pill ${item.status}`}>{item.status}</span>
      </div>
      <div className="card">
        <h2>Photos ({photos.length})</h2>
        <PhotoUploader itemId={id} />
        <div className="photos">
          {photos.map((p, i) => (
            <div className="photo" key={p.id}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={urls[i]} alt="" />
              <form action={deletePhotoAction.bind(null, id, p.id)} className="x"><button className="btn sm danger" aria-label="Delete photo">✕</button></form>
            </div>
          ))}
        </div>
      </div>
      <div className="card">
        <h2>Details</h2>
        {rows.filter(([, v]) => v != null && v !== "").map(([k, v]) => (
          <div key={k} className="row between small" style={{ padding: "4px 0" }}><span className="muted">{k}</span><span>{v}</span></div>
        ))}
      </div>
      <div className="card" id="listings">
        <h2>Marketplace listings ({listings.length})</h2>
        {msg && <p className="okmsg small">{msg}</p>}
        {err && <p className="err small">{err}</p>}
        {listings.length === 0 && <p className="muted small">Not linked to any marketplace listing yet.</p>}
        {listings.map((l) => (
          <div key={l.id} className="row between small" style={{ padding: "4px 0" }}>
            <span><b>{l.marketplace}</b> <span className="muted">{l.externalId}</span></span>
            <span>{l.url ? <a href={l.url} target="_blank" rel="noreferrer">open</a> : null} <span className={`pill ${l.status === "active" ? "listed" : "delisted"}`}>{l.status}</span></span>
          </div>
        ))}
        <form action={linkListingAction.bind(null, id)} style={{ marginTop: 10 }}>
          <h3 className="small" style={{ margin: "6px 0" }}>Link existing listing</h3>
          <label className="f">Marketplace
            <select className="input" name="marketplace" defaultValue="poshmark">{LINKABLE_MARKETPLACES.map((m) => <option key={m} value={m}>{m}</option>)}</select>
          </label>
          <label className="f">Listing link or id<input className="input" name="ref" required placeholder="https://poshmark.com/listing/..." /></label>
          <button className="btn sm">Link listing</button>
        </form>
      </div>
      {test && listings.filter((l) => isExtMarketplace(l.marketplace)).map((l) => (
        <div className="card" key={`t-${l.id}`}>
          <h2>Test actions · {l.marketplace}</h2>
          <p className="muted small">Shown because the SKU starts with TEST. Each button queues one normal job; the extension runs it on its next check. Do them top to bottom, one at a time, and wait for each to finish on the Jobs page.</p>
          {([
            ["quantity", "Set quantity", "2", "number"],
            ["price", "Change price ($)", "", "number"],
            ["title", "Change title", "", "text"],
            ["count", "Count my listings", null, null],
            ["not_for_sale", "Set Not For Sale", null, null],
            ["for_sale", "Set For Sale again", null, null],
          ] as const).map(([a, label, def, type]) => (
            <form key={a} action={testAction.bind(null, id, l.id, a)} className="row" style={{ gap: 8, padding: "4px 0" }}>
              {type && <input className="input" name="value" type={type} defaultValue={def ?? ""} required style={{ maxWidth: 200 }} />}
              <button className="btn sm">{label}</button>
            </form>
          ))}
          <form action={testAction.bind(null, id, l.id, "sold_delete")} className="row" style={{ gap: 8, padding: "8px 0 0", borderTop: "1px solid var(--border)", marginTop: 6 }}>
            <input className="input" name="value" required placeholder="type DELETE" style={{ maxWidth: 140 }} />
            <button className="btn sm danger">Record test sale &amp; delete listing</button>
          </form>
          <p className="muted small">Last step only: records a test sale (marketplace &quot;other&quot;), marks this item Sold, and deletes the listing on {l.marketplace}. The item and its history stay in Shadow Sync.</p>
        </div>
      ))}
      {timeline && (
        <div className="card">
          <h2>Sync log</h2>
          <JobLive itemId={id} />
          {timeline.length === 0 && <span className="muted small">Nothing has happened on any marketplace yet.</span>}
          <ul className="tl">
            {timeline.map((r, n) => (
              <li key={n}>
                <span className="when">{when(r.at)}</span>
                <span className="small">
                  {r.outcome && <JobMark status={r.outcome === "success" ? "succeeded" : "failed"} />}<b>{r.label}</b>{r.marketplace && <span className="muted"> · {r.marketplace}</span>}{r.source && <span className="muted"> · {r.source}</span>}
                  {r.detail && <div className="muted">{r.detail}</div>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="card">
        <h2>Move to</h2>
        <div className="row" style={{ flexWrap: "wrap" }}>
          {(["draft", "listed", "sold", "delisted"] as const).filter((s) => s !== item.status).map((s) => (
            <form key={s} action={setStatusAction.bind(null, id, s)}><button className="btn sm">{s}</button></form>
          ))}
          <form action={deleteItemAction.bind(null, id)}><button className="btn sm danger">Delete item</button></form>
        </div>
      </div>
    </>
  );
}
