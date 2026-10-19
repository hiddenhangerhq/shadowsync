// Pure helpers for the Ship queue (no I/O, no framework imports).
import type { Item, Sale } from "@/lib/data/types";
import { daysBetween } from "@/lib/sales";

export interface ShipRow {
  id: string;
  orderId: string | null;
  marketplace: string;
  /** SKU shown next to the order: the sale's own SKU, else the linked item's, else null. */
  sku: string | null;
  title: string;
  shipBy: string | null;
  /** days until ship-by (negative = overdue); null when there is no deadline */
  daysLeft: number | null;
  itemId: string | null;
}

export function shipRows(sales: Sale[], items: Pick<Item, "id" | "sku" | "title">[], today: string): ShipRow[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return sales.map((s) => {
    const it = s.itemId ? byId.get(s.itemId) : undefined;
    return {
      id: s.id, orderId: s.orderId, marketplace: s.marketplace,
      sku: s.sku?.trim() || it?.sku?.trim() || null,
      title: s.title || it?.title || "Sold item",
      shipBy: s.shipBy, daysLeft: s.shipBy ? daysBetween(today, s.shipBy) : null, itemId: s.itemId,
    };
  });
}
