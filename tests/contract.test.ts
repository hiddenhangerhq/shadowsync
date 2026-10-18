import { describe, expect, it } from "vitest";
import { backends } from "./helpers";
import { CREDIT_COSTS, InsufficientCreditsError, PLAN_ALLOWANCE } from "../src/lib/data/types";

describe.each(backends)("data layer contract: $name", ({ make }) => {
  const signedIn = async (email = "david@example.com") => {
    const { client } = make();
    const s = client();
    const r = await s.auth.signUp(email, "correct horse");
    expect(r.user?.email).toBe(email);
    return s;
  };

  it("auth: signup, signout, wrong password, signin", async () => {
    const s = await signedIn();
    expect((await s.auth.getUser())?.email).toBe("david@example.com");
    await s.auth.signOut();
    expect(await s.auth.getUser()).toBeNull();
    expect((await s.auth.signIn("david@example.com", "nope nope nope")).user).toBeNull();
    expect((await s.auth.signIn("david@example.com", "correct horse")).user?.id).toBeTruthy();
    expect((await s.auth.signUp("david@example.com", "correct horse")).error).toMatch(/exists/);
    expect((await s.auth.signUp("bad", "correct horse")).user).toBeNull();
    expect((await s.auth.signUp("x@y.co", "short")).user).toBeNull();
  });

  it("store rejects calls when signed out", async () => {
    const { client } = make();
    await expect(client().store.items.list()).rejects.toThrow(/signed in/i);
  });

  it("profile defaults and theme persistence", async () => {
    const s = await signedIn();
    const p = await s.store.profile.get();
    expect(p).toMatchObject({ email: "david@example.com", plan: "free", theme: "system" });
    for (const theme of ["light", "dark", "cyberpunk", "retro", "midnight", "forest", "sunset", "system"] as const) {
      expect((await s.store.profile.update({ theme })).theme).toBe(theme);
      expect((await s.store.profile.get())?.theme).toBe(theme);
    }
  });

  it("items: create/list/filter/update/counts/delete + unique SKU", async () => {
    const { store } = await signedIn();
    const a = await store.items.create({ title: "Polo", sku: "1001", cogs: 4 });
    const b = await store.items.create({ title: "Hat", sku: "1002", status: "listed", platform: "ebay", askingPrice: 20 });
    expect(a.status).toBe("draft");
    await expect(store.items.create({ title: "Dup", sku: "1001" })).rejects.toThrow(/SKU/);
    expect((await store.items.list({ status: "listed" })).map((i) => i.id)).toEqual([b.id]);
    const sold = await store.items.update(a.id, { status: "sold", priceSold: 30, fees: 6, dateSold: "2026-10-15", platform: "poshmark" });
    expect(sold).toMatchObject({ status: "sold", priceSold: 30, fees: 6, cogs: 4, title: "Polo" });
    expect(await store.items.countsByStatus()).toEqual({ draft: 0, listed: 1, sold: 1, delisted: 0 });
    await store.items.remove(b.id);
    expect(await store.items.get(b.id)).toBeNull();
    await expect(store.items.update("missing", { title: "x" })).rejects.toThrow();
  });

  it("photos + storage: add, order, cover, remove; cascade on item delete", async () => {
    const { store, storage } = await signedIn();
    const it1 = await store.items.create({ title: "Jacket" });
    const path = (n: number) => `u/${it1.id}/${n}.jpg`;
    for (let n = 0; n < 3; n++) {
      await storage.upload(path(n), new Uint8Array([n]), "image/jpeg");
      await store.photos.add({ itemId: it1.id, path: path(n), position: n, width: 10, height: 10, bytes: 1 });
    }
    const list = await store.photos.listForItem(it1.id);
    expect(list.map((p) => p.position)).toEqual([0, 1, 2]);
    expect((await store.photos.coverByItem([it1.id]))[it1.id].path).toBe(path(0));
    expect(await storage.getUrl(path(0))).toContain(path(0));
    expect((await store.photos.remove(list[0].id))?.path).toBe(path(0));
    expect(await store.photos.remove(list[0].id)).toBeNull();
    await store.items.remove(it1.id);
    expect(await store.photos.listForItem(it1.id)).toEqual([]);
    await expect(store.photos.add({ itemId: "nope", path: "x", position: 0, width: null, height: null, bytes: null })).rejects.toThrow();
  });

  it("listings, sales, connections, sync log", async () => {
    const { store } = await signedIn();
    const it1 = await store.items.create({ title: "Pants" });
    const l1 = await store.listings.upsert({ itemId: it1.id, marketplace: "ebay", externalId: "1", url: null, price: 25, status: "active", listedAt: null, endedAt: null, source: "api" });
    const l2 = await store.listings.upsert({ itemId: it1.id, marketplace: "ebay", externalId: "1", url: null, price: 22, status: "active", listedAt: null, endedAt: null, source: "api" });
    expect(l2.id).toBe(l1.id);
    expect((await store.listings.listForItem(it1.id))[0].price).toBe(22);
    await store.sales.record({ itemId: it1.id, marketplace: "ebay", orderId: "A", soldAt: "2026-10-01", price: 12, fees: 1, promo: null, shipProvider: "USPS", shipCost: 6, source: "api" });
    await store.sales.record({ itemId: null, marketplace: "poshmark", orderId: "B", soldAt: "2026-10-10", price: 30, fees: 6, promo: null, shipProvider: null, shipCost: 0, source: "extension" });
    expect((await store.sales.list()).map((s) => s.orderId)).toEqual(["B", "A"]);
    expect(await store.sales.list({ since: "2026-10-05" })).toHaveLength(1);
    await store.connections.upsert({ marketplace: "ebay", connectionType: "oauth_api", accountLabel: "a", status: "needs_reauth", lastSyncAt: null, lastError: "token expired" });
    await store.connections.upsert({ marketplace: "ebay", connectionType: "oauth_api", accountLabel: "b", status: "connected", lastSyncAt: null, lastError: null });
    await store.connections.upsert({ marketplace: "poshmark", connectionType: "extension", accountLabel: "p", status: "connected", lastSyncAt: null, lastError: null });
    await store.connections.upsert({ marketplace: "ebay", connectionType: "extension", accountLabel: null, status: "paused", lastSyncAt: null, lastError: null });
    const conns = await store.connections.list();
    expect(conns).toHaveLength(3); // unique per marketplace + connection type
    expect(conns.find((c) => c.marketplace === "ebay" && c.connectionType === "oauth_api")).toMatchObject({ accountLabel: "b", status: "connected", lastError: null });
await store.syncLog.append({ marketplace: "ebay", itemId: it1.id, source: "api", event: "sale_detected", level: "info", detail: "order A" });
    await store.syncLog.append({ marketplace: "poshmark", itemId: null, source: "extension", event: "sync_failed", level: "error", detail: "session expired" });
    const log = await store.syncLog.recent(5);
    expect(log).toHaveLength(2);
    expect(log.find((l) => l.level === "error")).toMatchObject({ source: "extension", event: "sync_failed" });
    expect((await store.syncLog.recent(1)).length).toBe(1);
  });

  it("sales: same order from two sources is one sale; higher-trust source wins, lower never overwrites", async () => {
    const { store } = await signedIn();
    const base = { itemId: null, marketplace: "ebay" as const, orderId: "13-1-2", soldAt: "2026-10-16", price: 12, fees: 3.24, promo: null, shipProvider: null, shipCost: 6.34 };
    const legacy = await store.sales.record({ ...base, source: "email", fees: null });
    const api = await store.sales.record({ ...base, source: "api", fees: 1.5 });
    expect(api.id).toBe(legacy.id);
    expect(api).toMatchObject({ source: "api", fees: 1.5 });
    const again = await store.sales.record({ ...base, source: "email", fees: 9 });
    expect(again).toMatchObject({ source: "api", fees: 1.5 });
    expect(await store.sales.list()).toHaveLength(1);
    await store.sales.record({ ...base, orderId: null, source: "manual" });
    await store.sales.record({ ...base, orderId: null, source: "manual" }); // no order id: no dedupe
    expect(await store.sales.list()).toHaveLength(3);
    await store.sales.record({ ...base, marketplace: "etsy", source: "api" }); // same order id on another marketplace is distinct
    expect(await store.sales.list()).toHaveLength(4);
  });

  it("credits: monthly allowance is idempotent, spend is checked, month rollover resets", async () => {
    const { store } = await signedIn();
    const oct = new Date("2026-10-10T12:00:00Z");
    expect(await store.creditLedger.ensureMonthlyAllowance(oct)).toBe(PLAN_ALLOWANCE.free);
    expect(await store.creditLedger.ensureMonthlyAllowance(oct)).toBe(PLAN_ALLOWANCE.free);
    expect(await store.creditLedger.spend("listing_create")).toBe(PLAN_ALLOWANCE.free - CREDIT_COSTS.listing_create);
    expect(await store.creditLedger.spend("bg_removal", 2, "two")).toBe(PLAN_ALLOWANCE.free - 5);
    expect(await store.creditLedger.ensureMonthlyAllowance(oct)).toBe(PLAN_ALLOWANCE.free - 5);
    await expect(store.creditLedger.spend("description", 9999)).rejects.toBeInstanceOf(InsufficientCreditsError);
    await expect(store.creditLedger.spend("description", 0)).rejects.toThrow();
    expect(await store.creditLedger.balance()).toBe(PLAN_ALLOWANCE.free - 5);
    expect(await store.creditLedger.ensureMonthlyAllowance(new Date("2026-11-01T08:00:00Z"))).toBe(PLAN_ALLOWANCE.free);
    expect(await store.creditLedger.grant(10, "bonus")).toBe(PLAN_ALLOWANCE.free + 10);
    const e = await store.creditLedger.entries();
    expect(e.map((x) => x.kind).sort()).toEqual(["grant", "reset", "reset", "spend", "spend"]);
  });

  it("isolation: user B cannot see or touch user A's rows", async () => {
    const { client } = make();
    const a = client(), b = client();
    await a.auth.signUp("a@x.com", "password-a1");
    await b.auth.signUp("b@x.com", "password-b1");
    const it1 = await a.store.items.create({ title: "A's item", sku: "S1" });
    await a.store.photos.add({ itemId: it1.id, path: "p", position: 0, width: null, height: null, bytes: null });
    await a.store.sales.record({ itemId: it1.id, marketplace: "ebay", orderId: "o", soldAt: "2026-10-01", price: 1, fees: null, promo: null, shipProvider: null, shipCost: null, source: "manual" });
    await a.store.creditLedger.ensureMonthlyAllowance();
    expect(await b.store.items.list()).toEqual([]);
    expect(await b.store.items.get(it1.id)).toBeNull();
    await expect(b.store.items.update(it1.id, { title: "hacked" })).rejects.toThrow();
    expect(await b.store.photos.listForItem(it1.id)).toEqual([]);
    await expect(b.store.photos.add({ itemId: it1.id, path: "q", position: 0, width: null, height: null, bytes: null })).rejects.toThrow();
    expect(await b.store.sales.list()).toEqual([]);
    expect(await b.store.creditLedger.balance()).toBe(0);
    expect((await b.store.profile.get())?.email).toBe("b@x.com");
    await b.store.items.remove(it1.id); // silently a no-op for foreign rows
    expect(await a.store.items.get(it1.id)).not.toBeNull();
    expect((await b.store.items.create({ title: "B", sku: "S1" })).sku).toBe("S1"); // SKU unique per user, not global
  });
});
