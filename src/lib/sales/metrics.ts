import { parseMoney, round2 } from "./money";
import { daysBetween } from "./dates";

export interface SaleInput {
  price: number | null;
  fees?: number | null;
  promo?: number | null;
  shipCost?: number | null;
  cogs?: number | null;
  dateListed?: string | null;   // YYYY-MM-DD
  dateSold?: string | null;
}

export interface SaleMetrics {
  /** price - fees - promo - shipping (null when there is no price) */
  net: number | null;
  /** net - cogs (missing cogs counts as 0, same as the dashboard) */
  profit: number | null;
  /** date sold - date listed in whole days; null if unknown or negative */
  daysToSell: number | null;
}

const n = (v: number | null | undefined) => v ?? 0;

/** Port of the per-row math in DS_readSheetSales_. */
export function saleMetrics(s: SaleInput): SaleMetrics {
  const price = s.price;
  const net = price === null ? null : round2(price - n(s.fees) - n(s.promo) - n(s.shipCost));
  const profit = net === null ? null : round2(net - n(s.cogs));
  let daysToSell: number | null = null;
  if (s.dateListed && s.dateSold) {
    const d = daysBetween(s.dateListed, s.dateSold);
    daysToSell = d >= 0 ? d : null;
  }
  return { net, profit, daysToSell };
}

export interface Summary {
  count: number;
  gross: number;
  fees: number;
  promo: number;
  shipping: number;
  net: number;
  profit: number;
  avgPrice: number | null;
  avgProfit: number | null;
  avgDaysToSell: number | null;
  /** profit / gross, 0..1 (null if no gross) */
  margin: number | null;
}

/** Totals for a set of sales (the Sale table / Summary numbers). Rows without a price count but add 0. */
export function summarize(sales: SaleInput[]): Summary {
  let gross = 0, fees = 0, promo = 0, shipping = 0, net = 0, profit = 0, dts = 0, dtsN = 0, priced = 0;
  for (const s of sales) {
    const m = saleMetrics(s);
    if (s.price !== null) { gross += s.price; priced++; }
    fees += n(s.fees); promo += n(s.promo); shipping += n(s.shipCost);
    net += m.net ?? 0; profit += m.profit ?? 0;
    if (m.daysToSell !== null) { dts += m.daysToSell; dtsN++; }
  }
  return {
    count: sales.length,
    gross: round2(gross), fees: round2(fees), promo: round2(promo), shipping: round2(shipping),
    net: round2(net), profit: round2(profit),
    avgPrice: priced ? round2(gross / priced) : null,
    avgProfit: priced ? round2(profit / priced) : null,
    avgDaysToSell: dtsN ? Math.round((dts / dtsN) * 10) / 10 : null,
    margin: gross ? Math.round((profit / gross) * 1000) / 1000 : null,
  };
}

export { parseMoney };
