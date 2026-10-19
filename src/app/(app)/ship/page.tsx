import Link from "next/link";
import { getServices } from "@/lib/data";
import { brandColor } from "@/lib/brands";
import { shipRows } from "@/lib/ship";
import { markShippedAction } from "./actions";

export const dynamic = "force-dynamic";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());

export default async function Ship() {
  const { store } = await getServices();
  const [sales, items] = await Promise.all([store.sales.listToShip(), store.items.list({ status: "sold" })]);
  const rows = shipRows(sales, items, today());
  return (
    <>
      <div className="row between">
        <h1 style={{ margin: 0 }}>Ship</h1>
        <Link href="/" className="btn sm">← Mission Control</Link>
      </div>
      <p className="muted small">Sold items waiting to go out, earliest ship-by first.</p>
      {rows.length === 0 && <div className="card empty">Nothing to ship. 🎉</div>}
      {rows.map((r) => (
        <div key={r.id} className="item ship-row" data-testid="ship-row">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <span className="sku" data-testid="ship-sku">{r.sku ? `SKU ${r.sku}` : "no SKU"}</span>
              {r.orderId && <span className="muted small">Order {r.orderId}</span>}
            </div>
            <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</div>
            <div className="muted small">
              <span className="dot" style={{ background: brandColor(r.marketplace) }} />{r.marketplace}
              {r.shipBy && <> · ship by {r.shipBy}{r.daysLeft != null && (
                <span className={r.daysLeft < 0 ? "late" : r.daysLeft <= 1 ? "soon" : ""}> ({r.daysLeft < 0 ? `${-r.daysLeft}d overdue` : r.daysLeft === 0 ? "today" : `${r.daysLeft}d left`})</span>
              )}</>}
            </div>
          </div>
          <form action={markShippedAction.bind(null, r.id, true)}><button className="btn sm primary" type="submit">Shipped</button></form>
        </div>
      ))}
    </>
  );
}
