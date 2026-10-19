import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CookieJar, Services } from "../src/lib/data/interfaces";
import { createMockServices, MockDb } from "../src/lib/data/mock";
import { createSupabaseServices } from "../src/lib/data/supabase-impl";

export function memoryJar(): CookieJar {
  const m = new Map<string, string>();
  return {
    get: (n) => m.get(n),
    set: (n, v) => void m.set(n, v),
    delete: (n) => void m.delete(n),
    getAll: () => [...m].map(([name, value]) => ({ name, value })),
  };
}

export interface BackendEnv {
  /** A fresh, signed-out client (own cookie jar). */
  client: () => Services;
  /** Signed-in client for fixture user `idx` (0 or 1) with EMPTY data. Mock: new account. Supabase: pre-confirmed test account, wiped first. */
  user: (idx: 0 | 1) => Promise<Services>;
}
export interface Backend {
  name: string;
  make: () => BackendEnv;
  /** Supabase users cannot grant themselves credits, and a real project keeps ledger history between runs. */
  canGrant: boolean;
  /** Year used for credit-period dates; random per run on a real project so reset periods never collide with earlier runs. */
  creditYear: number;
}

const mock: Backend = {
  name: "mock",
  canGrant: true,
  creditYear: 2026,
  make: () => {
    const db = new MockDb(null);
    const client = () => createMockServices(memoryJar(), db);
    return {
      client,
      user: async (idx) => {
        const s = client();
        await s.auth.signUp(idx === 0 ? "david@example.com" : "b@x.com", "correct horse");
        return s;
      },
    };
  },
};

// ---- real Supabase project (opt-in: RUN_SUPABASE=1; needs .env.local + .env.test.local) ----
export const supabaseEnabled = process.env.RUN_SUPABASE === "1";
export function testAccount(idx: 0 | 1) {
  const email = process.env[idx === 0 ? "TEST_USER_A_EMAIL" : "TEST_USER_B_EMAIL"];
  const password = process.env.TEST_USER_PASSWORD;
  if (!email || !password) throw new Error("TEST_USER_*_EMAIL / TEST_USER_PASSWORD missing (.env.test.local)");
  return { email, password };
}

// Supabase Auth rate-limits password sign-ins per IP, so each test file signs each account in ONCE and reuses the session.
// (Module state is per test file under vitest isolation.)
const rawSessions = new Map<number, Promise<{ sb: SupabaseClient; userId: string }>>();
function rawSignedIn(idx: 0 | 1, fresh = false) {
  if (fresh) rawSessions.delete(idx);
  let p = rawSessions.get(idx);
  if (!p) {
    p = (async () => {
      const { email, password } = testAccount(idx);
      const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error || !data.user) throw new Error(`test account ${email} cannot sign in: ${error?.message}`);
      return { sb, userId: data.user.id };
    })();
    p.catch(() => rawSessions.delete(idx));
    rawSessions.set(idx, p);
  }
  return p;
}

/** True when migration 0006 (device API functions + alert_prefs) is on the real project. */
export async function extTablesExist(): Promise<boolean> {
  let sb: SupabaseClient;
  try { ({ sb } = await rawSignedIn(0)); } catch { return false; }
  const fn = await sb.rpc("ext_poll", { p_token: "ssd_" + "x".repeat(43), p_version: "0.0.1" });
  const t = await sb.from("alert_prefs").select("*").limit(1);
  return !!fn.error && /ext:invalid_token/.test(fn.error.message) && !t.error;
}

const MISSING = new Set(["42P01", "PGRST205"]);
/** True when the 0005 job-queue tables exist on the real project (probes with a signed-in test account). */
export async function jobTablesExist(): Promise<boolean> {
  let sb: SupabaseClient;
  try { ({ sb } = await rawSignedIn(0)); } catch { return false; }
  const probes = await Promise.all(["jobs", "job_events", "extension_devices", "extension_marketplace_state", "sales_scan_cursors", "item_sync_log", "worker_state"].map((t) => sb.from(t).select("*").limit(1)));
  return probes.every((r) => !r.error);
}

/** Delete everything the user can delete through RLS so each test starts empty. Credit ledger rows can't be deleted by users (by design). */
export async function wipeSupabaseUser(idx: 0 | 1) {
  try {
    await wipeWith(await rawSignedIn(idx));
  } catch {
    // The cached session may have been revoked (a test signed out globally): sign in again once.
    await wipeWith(await rawSignedIn(idx, true));
  }
}

async function wipeWith({ sb, userId }: { sb: SupabaseClient; userId: string }) {
  const data = { user: { id: userId } };
  const bucket = process.env.SUPABASE_PHOTO_BUCKET || "item-photos";
  const leftovers = await sb.storage.from(bucket).list(data.user.id, { limit: 1000 });
  for (const f of leftovers.data ?? []) {
    const sub = await sb.storage.from(bucket).list(`${data.user.id}/${f.name}`, { limit: 1000 });
    const paths = (sub.data ?? []).map((o) => `${data.user.id}/${f.name}/${o.name}`);
    if (paths.length) await sb.storage.from(bucket).remove(paths);
  }
  // 0005 tables first (they reference items). They may not exist yet if migration 0005 has not been run: that is fine.
  // item_sync_log and job_events are append-only for users, so they cannot be wiped (job_events go with their job by cascade).
  for (const t of ["jobs", "extension_devices", "sales_scan_cursors", "alert_prefs"]) {
    const r = await sb.from(t).delete().not(t === "alert_prefs" ? "user_id" : "id", "is", null);
    if (r.error && !MISSING.has(r.error.code ?? "")) throw new Error(`wipe ${t}: ${r.error.message}`);
  }
  for (const t of ["sales", "sync_log", "marketplace_connections", "items"]) {
    const r = await sb.from(t).delete().not("id", "is", null);
    if (r.error) throw new Error(`wipe ${t}: ${r.error.message}`);
  }
  const p = await sb.from("profiles").update({ theme: "system", display_name: null }).eq("id", data.user.id);
  if (p.error) throw new Error(`wipe profile: ${p.error.message}`);
}

const sessionCookies = new Map<number, { name: string; value: string }[]>();
const supabase: Backend = {
  name: "supabase",
  canGrant: false,
  creditYear: 3000 + Math.floor(Math.random() * 6000),
  make: () => {
    const client = () => createSupabaseServices(memoryJar());
    return {
      client,
      user: async (idx) => {
        await wipeSupabaseUser(idx);
        let cookies = sessionCookies.get(idx);
        if (!cookies) {
          const jar = memoryJar();
          const s = createSupabaseServices(jar);
          const { email, password } = testAccount(idx);
          const r = await s.auth.signIn(email, password);
          if (!r.user) throw new Error(`signIn ${email}: ${r.error}`);
          cookies = jar.getAll();
          sessionCookies.set(idx, cookies);
        }
        // A fresh jar holding a copy of the saved session cookies: independent client, no new sign-in.
        const jar = memoryJar();
        for (const c of cookies) jar.set(c.name, c.value);
        return createSupabaseServices(jar);
      },
    };
  },
};

/** Add new implementations here to run the same contract on them. */
export const backends: Backend[] = supabaseEnabled ? [mock, supabase] : [mock];
