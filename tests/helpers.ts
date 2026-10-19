import { createClient } from "@supabase/supabase-js";
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

const MISSING = new Set(["42P01", "PGRST205"]);
/** True when the 0005 job-queue tables exist on the real project (probes with a signed-in test account). */
export async function jobTablesExist(): Promise<boolean> {
  const { email, password } = testAccount(0);
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) return false;
  const probes = await Promise.all(["jobs", "job_events", "extension_devices", "extension_marketplace_state", "sales_scan_cursors", "item_sync_log", "worker_state"].map((t) => sb.from(t).select("*").limit(1)));
  await sb.auth.signOut();
  return probes.every((r) => !r.error);
}

/** Delete everything the user can delete through RLS so each test starts empty. Credit ledger rows can't be deleted by users (by design). */
export async function wipeSupabaseUser(idx: 0 | 1) {
  const { email, password } = testAccount(idx);
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`test account ${email} cannot sign in: ${error?.message}`);
  const bucket = process.env.SUPABASE_PHOTO_BUCKET || "item-photos";
  const leftovers = await sb.storage.from(bucket).list(data.user.id, { limit: 1000 });
  for (const f of leftovers.data ?? []) {
    const sub = await sb.storage.from(bucket).list(`${data.user.id}/${f.name}`, { limit: 1000 });
    const paths = (sub.data ?? []).map((o) => `${data.user.id}/${f.name}/${o.name}`);
    if (paths.length) await sb.storage.from(bucket).remove(paths);
  }
  // 0005 tables first (they reference items). They may not exist yet if migration 0005 has not been run: that is fine.
  // item_sync_log and job_events are append-only for users, so they cannot be wiped (job_events go with their job by cascade).
  for (const t of ["jobs", "extension_devices", "sales_scan_cursors"]) {
    const r = await sb.from(t).delete().not("id", "is", null);
    if (r.error && !MISSING.has(r.error.code ?? "")) throw new Error(`wipe ${t}: ${r.error.message}`);
  }
  for (const t of ["sales", "sync_log", "marketplace_connections", "items"]) {
    const r = await sb.from(t).delete().not("id", "is", null);
    if (r.error) throw new Error(`wipe ${t}: ${r.error.message}`);
  }
  const p = await sb.from("profiles").update({ theme: "system", display_name: null }).eq("id", data.user.id);
  if (p.error) throw new Error(`wipe profile: ${p.error.message}`);
  await sb.auth.signOut();
}

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
        const s = client();
        const { email, password } = testAccount(idx);
        const r = await s.auth.signIn(email, password);
        if (!r.user) throw new Error(`signIn ${email}: ${r.error}`);
        return s;
      },
    };
  },
};

/** Add new implementations here to run the same contract on them. */
export const backends: Backend[] = supabaseEnabled ? [mock, supabase] : [mock];
