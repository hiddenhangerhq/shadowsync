import { notFound } from "next/navigation";
import Link from "next/link";
import { getServices } from "@/lib/data";
import PhotoUploader from "@/components/PhotoUploader";
import { buildTimeline } from "@/lib/jobs/timeline";
import { when } from "@/lib/jobs/format";
import { deleteItemAction, deletePhotoAction, setStatusAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
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
      {timeline && (
        <div className="card">
          <h2>Sync log</h2>
          {timeline.length === 0 && <span className="muted small">Nothing has happened on any marketplace yet.</span>}
          <ul className="tl">
            {timeline.map((r, n) => (
              <li key={n}>
                <span className="when">{when(r.at)}</span>
                <span className="small">
                  <b>{r.label}</b>{r.marketplace && <span className="muted"> · {r.marketplace}</span>}{r.source && <span className="muted"> · {r.source}</span>}
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
