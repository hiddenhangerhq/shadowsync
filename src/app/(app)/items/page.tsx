import Link from "next/link";
import { getServices, ITEM_STATUSES, type ItemStatus } from "@/lib/data";
import { brandColor } from "@/lib/brands";
import { loadSoldViews } from "@/lib/jobs/sold";
import { HOST_TABLE, isExtMarketplace } from "@/lib/ext/protocol";

export const dynamic = "force-dynamic";
type Tab = ItemStatus | "sold_active";
const TABS: Tab[] = ["draft", "listed", "sold_active", "sold"];
const LABEL: Record<string, string> = { draft: "Draft", listed: "Listed", sold: "Sold", sold_active: "Sold but still active" };
const mpName = (m: string) => (isExtMarketplace(m) ? HOST_TABLE[m].label : m.charAt(0).toUpperCase() + m.slice(1));
const money = (n: number | null) => (n == null ? "" : `$${n.toFixed(2)}`);

export default async function Items({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const active: Tab = tab === "sold_active" || ((ITEM_STATUSES as string[]).includes(tab ?? "") && tab !== "delisted") ? (tab as Tab) : "draft";
  const { store, storage } = await getServices();
  const status: ItemStatus = active === "sold_active" ? "sold" : active;
  const [rawCounts, all, views] = await Promise.all([store.items.countsByStatus(), store.items.list({ status }), loadSoldViews(store)]);
  // A sold item is only "Sold" once it is delisted or deleted everywhere; until then it is "Sold but still active" (and moves back by itself).
  const stillActive = [...views.values()].filter((v) => v.state === "sold_still_active").length;
  const counts: Record<string, number> = { ...rawCounts, sold: rawCounts.sold - stillActive, sold_active: stillActive };
  const items = status !== "sold" ? all : all.filter((i) => (views.get(i.id)?.state === "sold_still_active") === (active === "sold_active"));
  const covers = await store.photos.coverByItem(items.map((i) => i.id));
  const urls = Object.fromEntries(await Promise.all(Object.entries(covers).map(async ([id, p]) => [id, await storage.getUrl(p.path)] as const)));
  return (
    <>
      <div className="row between"><h1 style={{ margin: 0 }}>Items</h1><Link href="/items/new" className="btn primary sm">＋ Add</Link></div>
      <div className="tabs" role="tablist" style={{ marginTop: 12 }}>
        {TABS.map((t) => (
          <Link key={t} href={`/items?tab=${t}`} role="tab" aria-selected={t === active} className={"tab" + (t === active ? " on" : "")}>
            {LABEL[t]}<span className="badge-count">{counts[t]}</span>
          </Link>
        ))}
      </div>
      {items.length === 0 && <div className="card empty">Nothing in {LABEL[active]} yet.</div>}
      {items.map((i) => (
        <Link key={i.id} href={`/items/${i.id}`} className="item">
          {urls[i.id] ? /* eslint-disable-next-line @next/next/no-img-element */ <img className="thumb" src={urls[i.id]} alt="" /> : <div className="thumb">no photo</div>}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.title}</div>
            <div className="muted small">
              {i.platform && <><span className="dot" style={{ background: brandColor(i.platform) }} />{i.platform} · </>}
              {i.sku ?? "no SKU"}
              {i.status === "sold" ? ` · sold ${money(i.priceSold)}` : i.askingPrice != null ? ` · ${money(i.askingPrice)}` : ""}
            </div>
            {views.get(i.id)?.state === "sold_still_active" && (
              <div className="small" style={{ color: "var(--warn)" }}>Still active on {views.get(i.id)!.marketplaces.map(mpName).join(", ")}</div>
            )}
          </div>
        </Link>
      ))}
    </>
  );
}
