import { describe, expect, it } from "vitest";
import { backends, memoryJar } from "./helpers";
import { createMockServices, MockDb } from "../src/lib/data/mock";
import { shipRows } from "../src/lib/ship";

const base = { itemId: null, marketplace: "ebay" as const, orderId: "A", soldAt: "2026-10-16", price: 12, fees: null, promo: null, shipProvider: null, shipCost: null, source: "api" as const };

describe.each(backends)("ship queue ($name)", (b) => {
  const signedIn = async () => {
    return b.make().user(0);
  };
  it("to-ship list carries SKU, sorts by ship-by, and shipped sales drop off (undo restores)", async () => {
    const { store } = await signedIn();
    const it = await store.items.create({ title: "Nike polo", sku: "2013", status: "sold" });
    const late = await store.sales.record({ ...base, orderId: "L", itemId: it.id, sku: "2013", shipBy: "2026-10-20" });
    await store.sales.record({ ...base, orderId: "E", sku: "1891", title: "Pants", shipBy: "2026-10-18" });
    await store.sales.record({ ...base, orderId: "N" }); // no deadline: last
    expect((await store.sales.listToShip()).map((s) => s.orderId)).toEqual(["E", "L", "N"]);
    expect((await store.sales.listToShip())[1].sku).toBe("2013");
    await store.sales.markShipped(late.id, true, "2026-10-18");
    expect((await store.sales.listToShip()).map((s) => s.orderId)).toEqual(["E", "N"]);
    expect((await store.sales.list()).find((s) => s.id === late.id)?.shippedAt).toBe("2026-10-18");
    await store.sales.markShipped(late.id, false);
    expect(await store.sales.listToShip()).toHaveLength(3);
  });
  it("older callers without ship fields still work (defaults null); lower-trust source only fills blanks", async () => {
    const { store } = await signedIn();
    const a = await store.sales.record({ ...base, source: "email" });
    expect(a).toMatchObject({ sku: null, title: null, shipBy: null, shippedAt: null });
    const b2 = await store.sales.record({ ...base, source: "email", sku: "77", shipBy: "2026-10-30" });
    expect(b2).toMatchObject({ id: a.id, sku: "77", shipBy: "2026-10-30" });
    await store.sales.markShipped(a.id, true);
    await store.sales.record({ ...base, source: "api", fees: 2 }); // higher source must not un-ship or wipe the SKU
    const cur = (await store.sales.list())[0];
    expect(cur).toMatchObject({ source: "api", fees: 2, sku: "77" });
    expect(cur.shippedAt).not.toBeNull();
  });
  it("a user cannot mark someone else's sale shipped", async () => {
    const db = new MockDb(null);
    const a = createMockServices(memoryJar(), db), c = createMockServices(memoryJar(), db);
    await a.auth.signUp("a@x.com", "password1"); await c.auth.signUp("c@x.com", "password1");
    const s = await a.store.sales.record(base);
    await expect(c.store.sales.markShipped(s.id, true)).rejects.toThrow();
    expect(await c.store.sales.listToShip()).toEqual([]);
  });
});

describe("shipRows", () => {
  it("falls back to the linked item's SKU and computes days left", () => {
    const sale = (o: object) => ({ id: "s", userId: "u", itemId: null, marketplace: "ebay", orderId: "O1", soldAt: "2026-10-16", price: 1, fees: null, promo: null, shipProvider: null, shipCost: null, sku: null, title: null, shipBy: null, shippedAt: null, source: "api", createdAt: "", ...o }) as never;
    const items = [{ id: "i1", sku: "2013", title: "Polo" }];
    const rows = shipRows([sale({ itemId: "i1", shipBy: "2026-10-17" }), sale({ sku: "9", title: "T" })], items, "2026-10-18");
    expect(rows[0]).toMatchObject({ sku: "2013", title: "Polo", daysLeft: -1 });
    expect(rows[1]).toMatchObject({ sku: "9", daysLeft: null });
    expect(shipRows([sale({})], [], "2026-10-18")[0].sku).toBeNull();
  });
});
