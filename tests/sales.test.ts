import { describe, expect, it } from "vitest";
import {
  daysBetween, dropDuplicates, normalizePlatform, parseDay, parseLegacyEbaySale, parseMoney,
  saleMetrics, summarize, titleMatch, toMarketplace,
} from "../src/lib/sales";

describe("parseMoney (DS_num_)", () => {
  it("handles currency, commas, parentheses, blanks", () => {
    expect(parseMoney("$1,234.50")).toBe(1234.5);
    expect(parseMoney("(12.00)")).toBe(-12);
    expect(parseMoney(" 7 ")).toBe(7);
    expect(parseMoney(3)).toBe(3);
    for (const v of ["", null, undefined, "-", "abc", NaN]) expect(parseMoney(v)).toBeNull();
    expect(parseMoney(0)).toBe(0);
  });
});

describe("parseDay (DS_sheetDateMs_)", () => {
  it("parses m/d/yyyy, m/d/yy, ISO; rejects junk, numbers and impossible dates", () => {
    expect(parseDay("10/4/2026")).toBe("2026-10-04");
    expect(parseDay("1/9/26")).toBe("2026-01-09");
    expect(parseDay("2026-10-04")).toBe("2026-10-04");
    expect(parseDay("2026-10-04T12:00:00")).toBe("2026-10-04");
    expect(parseDay(45000)).toBeNull();
    expect(parseDay("sold")).toBeNull();
    expect(parseDay("2/30/2026")).toBeNull();
    expect(parseDay("")).toBeNull();
  });
  it("reads Date objects in Pacific time", () => {
    expect(parseDay(new Date("2026-10-16T02:00:00Z"))).toBe("2026-10-15"); // 7pm PT the day before
    expect(parseDay(new Date("2026-10-16T18:00:00Z"))).toBe("2026-10-16");
    expect(parseDay(new Date("nope"))).toBeNull();
  });
  it("daysBetween is DST-safe", () => {
    expect(daysBetween("2026-10-31", "2026-11-02")).toBe(2);
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    expect(daysBetween("2026-10-05", "2026-10-01")).toBe(-4);
  });
});

describe("saleMetrics: net = price - fees - promo - shipping; profit = net - cogs; days to sell", () => {
  it("matches the Poshmark example from the sheet (price 30, fee 6, ship 0, cogs 6)", () => {
    expect(saleMetrics({ price: 30, fees: 6, shipCost: 0, cogs: 6, dateListed: "2026-09-25", dateSold: "2026-10-15" }))
      .toEqual({ net: 24, profit: 18, daysToSell: 20 });
  });
  it("subtracts promo and shipping, rounds to cents, treats missing as 0", () => {
    expect(saleMetrics({ price: 12, fees: 3.24, shipCost: 6.34, promo: 0.5, cogs: 3 }))
      .toEqual({ net: 1.92, profit: -1.08, daysToSell: null });
    expect(saleMetrics({ price: 20 })).toEqual({ net: 20, profit: 20, daysToSell: null });
  });
  it("no price -> null net/profit; negative days -> null", () => {
    expect(saleMetrics({ price: null, fees: 5, cogs: 2 })).toEqual({ net: null, profit: null, daysToSell: null });
    expect(saleMetrics({ price: 5, dateListed: "2026-10-10", dateSold: "2026-10-01" }).daysToSell).toBeNull();
    expect(saleMetrics({ price: 5, dateListed: "2026-10-10", dateSold: "2026-10-10" }).daysToSell).toBe(0);
  });
  it("summarize totals the Sale table numbers", () => {
    const s = summarize([
      { price: 30, fees: 6, shipCost: 0, cogs: 6, dateListed: "2026-09-25", dateSold: "2026-10-15" },
      { price: 20, fees: 4, shipCost: 0, cogs: 5, dateListed: "2026-10-10", dateSold: "2026-10-16" },
      { price: null },
    ]);
    expect(s).toMatchObject({ count: 3, gross: 50, fees: 10, net: 40, profit: 29, avgPrice: 25, avgProfit: 14.5, avgDaysToSell: 13, margin: 0.58 });
    expect(summarize([])).toMatchObject({ count: 0, gross: 0, avgPrice: null, avgDaysToSell: null, margin: null });
  });
});

describe("platforms", () => {
  it("normalizes like DS_normPlatform_", () => {
    expect(normalizePlatform("EBAY store")).toBe("eBay");
    expect(normalizePlatform("poshmark")).toBe("Poshmark");
    expect(normalizePlatform("")).toBe("Other");
    expect(normalizePlatform("Mercari")).toBe("Mercari");
    expect(toMarketplace("Etsy - Golf Courses")).toBe("etsy");
    expect(toMarketplace("shopgolfmaps.com")).toBe("wix");
    expect(toMarketplace("???")).toBe("other");
  });
});

describe("titleMatch (DS_titleMatch_)", () => {
  it("matches eBay-truncated titles and rejects different items", () => {
    const full = "Under Armour 1/4 Zip HeatGear Running Tee Mens Large Black";
    expect(titleMatch(full, "Under Armour 1/4 Zip HeatGear Running Tee Mens...")).toBe(true);
    expect(titleMatch("Banana Republic herringbone suit pants 34x32", "Banana Republic Herringbone Suit Pants")).toBe(true);
    expect(titleMatch(full, "Nike Dri-FIT polo shirt golf large white")).toBe(false);
    expect(titleMatch("", "x")).toBe(false);
  });
});

describe("dropDuplicates (DS_dropDupGtMail_)", () => {
  const known = [{ channel: "eBay", day: "2026-10-16", price: 12, title: "Under Armour 1/4 Zip HeatGear Running Tee Mens Large" }];
  it("drops a candidate that the known list already has (same day or +-1)", () => {
    const c = { channel: "eBay", day: "2026-10-17", price: 12, title: "Under Armour 1/4 Zip HeatGear Running Tee..." };
    expect(dropDuplicates(known, [c])).toEqual([]);
  });
  it("keeps different price, channel, or far-apart day", () => {
    const base = { channel: "eBay", day: "2026-10-16", price: 12, title: "Under Armour 1/4 Zip HeatGear Running Tee Mens Large" };
    expect(dropDuplicates(known, [{ ...base, price: 13 }, { ...base, channel: "Depop" }, { ...base, day: "2026-10-20" }])).toHaveLength(3);
  });
  it("one known row absorbs only one candidate", () => {
    const c = { channel: "eBay", day: "2026-10-16", price: 12, title: "Under Armour 1/4 Zip HeatGear Running Tee Mens Large" };
    expect(dropDuplicates(known, [c, { ...c }])).toHaveLength(1);
  });
});

describe("parseLegacyEbaySale (private legacy import)", () => {
  const body = `Hi,\nGreat news!\nOrder: 13-15297-77056\nSold: $12.00\nQuantity sold: 1\nDate sold: Oct 16, 2026\n[Under Armour 1/4 Zip HeatGear Running Tee Mens Large](https://www.ebay.com/mesh/ord/details?orderid=13-15297-77056)`;
  it("extracts order id, price, qty, title and day", () => {
    expect(parseLegacyEbaySale("You made the sale for Under Armour 1/4 Zip HeatGear...", "ebay@ebay.com", body)).toEqual({
      marketplace: "ebay", orderId: "13-15297-77056", price: 12, qty: 1, soldDay: "2026-10-16",
      title: "Under Armour 1/4 Zip HeatGear Running Tee Mens Large",
    });
  });
  it("ignores non-sale and non-eBay mail", () => {
    expect(parseLegacyEbaySale("Weekly deals", "ebay@ebay.com", body.replace("Great news", "x"))).toBeNull();
    expect(parseLegacyEbaySale("You made the sale for X", "someone@example.com", body)).toBeNull();
    expect(parseLegacyEbaySale("You made the sale for X", "ebay@ebay.com", "no order here")).toBeNull();
  });
});
