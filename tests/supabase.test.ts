// Real-project checks that go beyond the shared contract: auth behaviour with email confirmation ON, RLS as the anon role and as
// a signed-in user, and the private photo bucket. Opt-in: RUN_SUPABASE=1 (needs .env.local + .env.test.local). Uses only the anon key.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryJar, supabaseEnabled, testAccount, wipeSupabaseUser } from "./helpers";
import { createSupabaseServices } from "../src/lib/data/supabase-impl";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const TABLES = ["profiles", "items", "item_photos", "marketplace_connections", "listings", "sales", "sync_log", "credit_ledger"];
const fresh = () => createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

describe.runIf(supabaseEnabled)("supabase: anon role (no login) sees and does nothing", () => {
  // Seed real rows as user A so "reads nothing" is meaningful (tables are not just empty).
  beforeAll(async () => {
    await wipeSupabaseUser(0);
    const s = createSupabaseServices(memoryJar());
    await s.auth.signIn(testAccount(0).email, testAccount(0).password);
    const it = await s.store.items.create({ title: "seed", sku: "RLS1" });
    await s.store.sales.record({ itemId: it.id, marketplace: "ebay", orderId: "rls", soldAt: "2026-10-01", price: 1, fees: null, promo: null, shipProvider: null, shipCost: null, source: "manual" });
    await s.store.syncLog.append({ marketplace: "ebay", itemId: it.id, source: "api", event: "sale_detected", level: "info", detail: null });
    await s.store.creditLedger.ensureMonthlyAllowance();
  });
  afterAll(() => wipeSupabaseUser(0));
  it("reads zero rows from every table", async () => {
    for (const t of TABLES) {
      const r = await fresh().from(t).select("*");
      expect(r.error, t).toBeNull();
      expect(r.data, t).toEqual([]);
    }
  });
  it("cannot insert anywhere", async () => {
    const z = "00000000-0000-0000-0000-000000000000";
    const sb = fresh();
    expect((await sb.from("items").insert({ title: "x", user_id: z })).error).not.toBeNull();
    expect((await sb.from("sales").insert({ marketplace: "ebay", sold_at: "2026-10-01", price: 1, user_id: z })).error).not.toBeNull();
    expect((await sb.from("credit_ledger").insert({ kind: "grant", amount: 999, user_id: z })).error).not.toBeNull();
  });
  it("cannot call the credit functions", async () => {
    const sb = fresh();
    expect((await sb.rpc("spend_credits", { p_action: "description", p_cost: 1 })).error?.message).toMatch(/permission denied/);
    expect((await sb.rpc("ensure_monthly_allowance", { p_period: "2026-10" })).error?.message).toMatch(/permission denied/);
  });
  it("photo bucket is private: no listing, no public URL, no upload", async () => {
    const sb = fresh();
    expect((await sb.storage.from("item-photos").list("")).data ?? []).toEqual([]);
    const pub = sb.storage.from("item-photos").getPublicUrl("x/y.jpg").data.publicUrl;
    expect((await fetch(pub)).ok).toBe(false);
    expect((await sb.storage.from("item-photos").upload("anon/x.jpg", new Uint8Array([1]), { contentType: "image/jpeg" })).error).not.toBeNull();
  });
});

describe.runIf(supabaseEnabled)("supabase: signed-in user A cannot bypass the rules", () => {
  let a: SupabaseClient;
  let aId: string;
  beforeAll(async () => {
    await wipeSupabaseUser(0);
    a = fresh();
    const r = await a.auth.signInWithPassword(testAccount(0));
    expect(r.error).toBeNull();
    aId = r.data.user!.id;
  });

  it("cannot write the credit ledger directly (insert/update/delete)", async () => {
    expect((await a.from("credit_ledger").insert({ kind: "grant", amount: 9999, note: "cheat" })).error).not.toBeNull();
    const upd = await a.from("credit_ledger").update({ amount: 9999 }).not("id", "is", null).select();
    expect(upd.error !== null || (upd.data ?? []).length === 0).toBe(true);
    const del = await a.from("credit_ledger").delete().not("id", "is", null).select();
    expect(del.error !== null || (del.data ?? []).length === 0).toBe(true);
  });
  it("cannot change own plan (billing only) but can change theme", async () => {
    expect((await a.from("profiles").update({ plan: "pro" }).eq("id", aId)).error).not.toBeNull();
    expect((await a.from("profiles").select("plan").single()).data?.plan).toBe("free");
    expect((await a.from("profiles").update({ theme: "dark" }).eq("id", aId)).error).toBeNull();
    await a.from("profiles").update({ theme: "system" }).eq("id", aId);
  });
  it("cannot create rows owned by someone else", async () => {
    const z = "00000000-0000-0000-0000-000000000000";
    expect((await a.from("items").insert({ title: "x", user_id: z })).error).not.toBeNull();
    expect((await a.from("sales").insert({ marketplace: "ebay", sold_at: "2026-10-01", price: 1, user_id: z })).error).not.toBeNull();
  });
  it("sees only its own profile row", async () => {
    const r = await a.from("profiles").select("id");
    expect(r.data).toEqual([{ id: aId }]);
  });
  it("storage: own folder works, signed URL works, other folders and non-images are refused, URL is not public", async () => {
    const bucket = a.storage.from("item-photos");
    const mine = `${aId}/rls-check/own.jpg`;
    expect((await bucket.upload(mine, new Uint8Array([1, 2, 3]), { contentType: "image/jpeg" })).error).toBeNull();
    const signed = await bucket.createSignedUrl(mine, 60);
    expect(signed.error).toBeNull();
    expect((await fetch(signed.data!.signedUrl)).ok).toBe(true);
    const pub = bucket.getPublicUrl(mine).data.publicUrl;
    expect((await fetch(pub)).ok).toBe(false);
    const other = "00000000-0000-0000-0000-000000000000/rls-check/theirs.jpg";
    expect((await bucket.upload(other, new Uint8Array([1]), { contentType: "image/jpeg" })).error).not.toBeNull();
    expect((await bucket.upload(`${aId}/rls-check/x.txt`, new Uint8Array([1]), { contentType: "text/plain" })).error).not.toBeNull();
    expect((await bucket.remove([mine])).error).toBeNull();
  });
  it("RLS-bypass attempt through the app layer: foreign photo path is not readable", async () => {
    const s = createSupabaseServices(memoryJar());
    await s.auth.signIn(testAccount(0).email, testAccount(0).password);
    await expect(s.storage.getUrl("00000000-0000-0000-0000-000000000000/none/x.jpg")).rejects.toThrow();
  });
});

describe.runIf(supabaseEnabled)("supabase: auth with email confirmation ON", () => {
  it("wrong password and unknown user are refused with a message", async () => {
    const s = createSupabaseServices(memoryJar());
    const bad = await s.auth.signIn(testAccount(0).email, "definitely-wrong-pw");
    expect(bad.user).toBeNull();
    expect(bad.error).toBeTruthy();
    expect((await s.auth.getUser())).toBeNull();
  });
  it("signIn, getUser and signOut round-trip", async () => {
    const s = createSupabaseServices(memoryJar());
    const r = await s.auth.signIn(testAccount(0).email, testAccount(0).password);
    expect(r.user?.email).toBe(testAccount(0).email);
    expect((await s.auth.getUser())?.email).toBe(testAccount(0).email);
    await s.auth.signOut();
    expect(await s.auth.getUser()).toBeNull();
  });
  it("signUp with an existing address gives no session (and does not leak that the address exists)", async () => {
    const s = createSupabaseServices(memoryJar());
    const r = await s.auth.signUp(testAccount(0).email, "another-password-1");
    expect(await s.auth.getUser()).toBeNull(); // no session either way
    expect(r).toMatchObject({ user: null, needsConfirmation: true }); // app shows "check your email", no redirect into a dead session
  });
  it("signUp rejects invalid email and short password", async () => {
    const s = createSupabaseServices(memoryJar());
    expect((await s.auth.signUp("not-an-email", "correct horse")).user).toBeNull();
    expect((await s.auth.signUp("x@y.co", "short")).user).toBeNull();
  });
});
