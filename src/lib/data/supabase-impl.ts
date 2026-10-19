// Supabase implementation. THE ONLY FILE IN THE APP THAT IMPORTS @supabase/*.
// Exercised by the shared contract suite with RUN_SUPABASE=1 (see tests/helpers.ts). DATA_BACKEND=supabase selects it.
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import type { CookieJar, DataStore, Services, StorageService, AuthService } from "./interfaces";
import {
  CREDIT_COSTS, InsufficientCreditsError, ITEM_STATUSES, SOURCE_PRIORITY,
  type AuthUser, type ItemStatus,
} from "./types";

type Row = Record<string, unknown>;
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
const fromRow = <T,>(r: Row): T => Object.fromEntries(Object.entries(r).map(([k, v]) => [camel(k), v])) as T;
const toRow = (o: object): Row =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [snake(k), v]));

function env() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required when DATA_BACKEND=supabase");
  return { url, key, bucket: process.env.SUPABASE_PHOTO_BUCKET || "item-photos" };
}

function client(jar: CookieJar): SupabaseClient {
  const { url, key } = env();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (list) => {
        // Server Components cannot set cookies; the proxy refreshes the session instead.
        try {
          list.forEach(({ name, value, options }) => {
            const ss = options?.sameSite;
            jar.set(name, value, { ...options, sameSite: typeof ss === "boolean" ? (ss ? "strict" : undefined) : ss });
          });
        } catch { /* ignore */ }
      },
    },
  }) as unknown as SupabaseClient;
}

// Postgres errors -> the same messages the mock implementation gives (callers/tests match on these).
function friendly(e: { message: string; code?: string }): string {
  if (e.code === "23505" && /items_user_sku_uq/.test(e.message)) return "That SKU already exists";
  return e.message;
}
const must = <T,>(r: { data: T | null; error: { message: string; code?: string } | null }): T => {
  if (r.error) throw new Error(friendly(r.error));
  return r.data as T;
};

export function createSupabaseServices(jar: CookieJar): Services {
  const sb = client(jar);
  const { bucket } = env();

  const auth: AuthService = {
    async signUp(email, password) {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) return { user: null, error: error.message };
      // With email confirmation ON there is no session yet: do not report the user as signed in.
      if (!data.session) return { user: null, needsConfirmation: true };
      return { user: data.user?.email ? { id: data.user.id, email: data.user.email } : null };
    },
    async signIn(email, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      return { user: data.user?.email ? { id: data.user.id, email: data.user.email } : null, error: error?.message };
    },
    async signOut() { await sb.auth.signOut(); },
    async getUser() {
      const { data } = await sb.auth.getUser();
      return data.user?.email ? { id: data.user.id, email: data.user.email } : null;
    },
  };

  const uid = async () => {
    const u = await auth.getUser();
    if (!u) throw new Error("Not signed in");
    return u.id;
  };
  // RLS already restricts every query to auth.uid(); user_id is only set on insert.
  const list = async <T,>(table: string, build?: (q: any) => any): Promise<T[]> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    // RLS would just return no rows when signed out; fail loudly instead (same as the mock). Local session check, no network call.
    if (!(await sb.auth.getSession()).data.session) throw new Error("Not signed in");
    const q = sb.from(table).select("*");
    const rows = must(await (build ? build(q) : q)) as Row[];
    return rows.map((r) => fromRow<T>(r));
  };
  const insert = async <T,>(table: string, v: object): Promise<T> =>
    fromRow<T>(must(await sb.from(table).insert({ ...toRow(v), user_id: await uid() }).select().single()) as Row);

  const store: DataStore = {
    profile: {
      async get() {
        const r = must(await sb.from("profiles").select("*").maybeSingle()) as Row | null;
        return r ? fromRow(r) : null;
      },
      async update(patch) {
        return fromRow(must(await sb.from("profiles").update(toRow(patch)).eq("id", await uid()).select().single()) as Row);
      },
    },
    items: {
      list: (f) => list("items", (q) => {
        let x = q.order("created_at", { ascending: false });
        if (f?.status) x = x.eq("status", f.status);
        if (f?.limit) x = x.limit(f.limit);
        return x;
      }),
      async get(id) {
        const r = must(await sb.from("items").select("*").eq("id", id).maybeSingle()) as Row | null;
        return r ? fromRow(r) : null;
      },
      create: (i) => insert("items", i),
      async update(id, patch) {
        return fromRow(must(await sb.from("items").update(toRow(patch)).eq("id", id).select().single()) as Row);
      },
      async remove(id) { must(await sb.from("items").delete().eq("id", id)); },
      async countsByStatus() {
        const out = Object.fromEntries(ITEM_STATUSES.map((s) => [s, 0])) as Record<ItemStatus, number>;
        const rows = must(await sb.from("items").select("status")) as { status: ItemStatus }[];
        for (const r of rows) out[r.status]++;
        return out;
      },
    },
    photos: {
      listForItem: (itemId) => list("item_photos", (q) => q.eq("item_id", itemId).order("position")),
      async coverByItem(itemIds) {
        if (!itemIds.length) return {};
        const rows = await list<import("./types").Photo>("item_photos", (q) => q.in("item_id", itemIds).order("position"));
        const out: Record<string, import("./types").Photo> = {};
        for (const p of rows) if (!out[p.itemId]) out[p.itemId] = p;
        return out;
      },
      add: (p) => insert("item_photos", p),
      async remove(id) {
        const r = must(await sb.from("item_photos").delete().eq("id", id).select().maybeSingle()) as Row | null;
        return r ? fromRow(r) : null;
      },
    },
    listings: {
      listForItem: (itemId) => list("listings", (q) => q.eq("item_id", itemId)),
      async upsert(l) {
        return fromRow(must(await sb.from("listings").upsert({ ...toRow(l), user_id: await uid() }, { onConflict: "item_id,marketplace" }).select().single()) as Row);
      },
    },
    sales: {
      list: (o) => list("sales", (q) => {
        let x = q.order("sold_at", { ascending: false });
        if (o?.since) x = x.gte("sold_at", o.since);
        if (o?.limit) x = x.limit(o.limit);
        return x;
      }),
      async record(s) {
        if (s.orderId) {
          const ex = must(await sb.from("sales").select("*").eq("marketplace", s.marketplace).eq("order_id", s.orderId).maybeSingle()) as Row | null;
          if (ex) {
            const cur = fromRow<import("./types").Sale>(ex);
            if (SOURCE_PRIORITY[s.source] <= SOURCE_PRIORITY[cur.source]) {
              // lower-trust source may only fill blank ship fields
              const fill: Row = {};
              if (!cur.sku && s.sku) fill.sku = s.sku;
              if (!cur.title && s.title) fill.title = s.title;
              if (!cur.shipBy && s.shipBy) fill.ship_by = s.shipBy;
              if (!Object.keys(fill).length) return cur;
              return fromRow(must(await sb.from("sales").update(fill).eq("id", cur.id).select().single()) as Row);
            }
            return fromRow(must(await sb.from("sales").update(toRow(s)).eq("id", cur.id).select().single()) as Row);
          }
        }
        return insert("sales", s);
      },
      listToShip: () => list("sales", (q) => q.is("shipped_at", null).order("ship_by", { ascending: true, nullsFirst: false }).order("sold_at", { ascending: false })),
      async markShipped(id, on, day) {
        const shippedAt = on ? day ?? new Date().toISOString().slice(0, 10) : null;
        return fromRow(must(await sb.from("sales").update({ shipped_at: shippedAt }).eq("id", id).select().single()) as Row);
      },
    },
    connections: {
      list: () => list("marketplace_connections"),
      async upsert(c) {
        return fromRow(must(await sb.from("marketplace_connections").upsert({ ...toRow(c), user_id: await uid() }, { onConflict: "user_id,marketplace,connection_type" }).select().single()) as Row);
      },
    },
    syncLog: {
      append: (e) => insert("sync_log", e),
      recent: (limit = 20) => list("sync_log", (q) => q.order("created_at", { ascending: false }).limit(limit)),
    },
    creditLedger: {
      async balance() {
        const rows = must(await sb.from("credit_ledger").select("amount")) as { amount: number }[];
        return rows.reduce((s, r) => s + r.amount, 0);
      },
      entries: (limit = 50) => list("credit_ledger", (q) => q.order("created_at", { ascending: false }).limit(limit)),
      async ensureMonthlyAllowance(at = new Date()) {
        return must(await sb.rpc("ensure_monthly_allowance", { p_period: at.toISOString().slice(0, 7) })) as number;
      },
      async spend(action, cost = CREDIT_COSTS[action], note) {
        const { data, error } = await sb.rpc("spend_credits", { p_action: action, p_cost: cost, p_note: note ?? null });
        if (error) {
          if (/insufficient_credits/.test(error.message)) throw new InsufficientCreditsError(await store.creditLedger.balance(), cost);
          throw new Error(error.message);
        }
        return data as number;
      },
      async grant(amount, note) {
        void amount; void note;
        // Bonus credits are server-side only (service role). Users cannot write the ledger directly.
        throw new Error("creditLedger.grant is not available from a user session");
      },
    },
  };

  const storage: StorageService = {
    async upload(path, data, contentType) {
      must(await sb.storage.from(bucket).upload(path, data, { contentType, upsert: false }) as never);
    },
    async getUrl(path) {
      const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, 3600);
      if (error) throw new Error(error.message);
      return data.signedUrl;
    },
    async remove(paths) { if (paths.length) await sb.storage.from(bucket).remove(paths); },
  };

  return { auth, store, storage };
}

/** Used by proxy.ts: refreshes the Supabase session cookie and reports the user. */
export async function updateSupabaseSession(request: NextRequest): Promise<{ response: NextResponse; user: AuthUser | null }> {
  const { url, key } = env();
  let response = NextResponse.next({ request });
  const sb = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  const { data } = await sb.auth.getUser();
  const user = data.user?.email ? { id: data.user.id, email: data.user.email } : null;
  return { get response() { return response; }, user } as { response: NextResponse; user: AuthUser | null };
}
