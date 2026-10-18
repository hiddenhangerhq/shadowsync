import { notFound } from "next/navigation";
import Link from "next/link";
import { getServices } from "@/lib/data";
import PhotoUploader from "@/components/PhotoUploader";
import { deleteItemAction, deletePhotoAction, setStatusAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store, storage } = await getServices();
  const item = await store.items.get(id);
  if (!item) notFound();
  const photos = await store.photos.listForItem(id);
  const urls = await Promise.all(photos.map((p) => storage.getUrl(p.path)));
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
