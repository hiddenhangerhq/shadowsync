// Supabase implementation. THE ONLY FILE IN THE APP THAT IMPORTS @supabase/*.
// Exercised by the shared contract suite with RUN_SUPABASE=1 (see tests/helpers.ts). DATA_BACKEND=supabase selects it.
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import type { CookieJar, DataStore, DeviceGateway, Services, StorageService, AuthService } from "./interfaces";
import {
  CREDIT_COSTS, DeviceAuthError, InsufficientCreditsError, ITEM_STATUSES, JOB_STATUSES, SchemaMissingError, SOURCE_PRIORITY,
  type DeviceErrorCode, type Marketplace, RelistBlockedError, type SoldAction, type Item,
  type AuthUser, type ExtensionDevice, type ItemStatus, type Job, type JobEvent, type MarketplaceLoginState,
} from "./types";
import * as sm from "../jobs/state-machine";
import { makeNeedsAction } from "../jobs/store-helpers";
import { relistBlocked } from "../jobs/sold";

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
// A table or function from migration 0005 that is not there yet (David has not run the SQL): pages catch this and degrade.
const MISSING_CODES = new Set(["42P01", "42883", "PGRST205", "PGRST202"]);
const raise = (e: { message: string; code?: string }): never => {
  if ((e.code && MISSING_CODES.has(e.code)) || /could not find the (table|function)|relation .* does not exist/i.test(e.message)) throw new SchemaMissingError();
  throw new Error(friendly(e));
};
// Migration 0006 (extension pairing, device API, kill switch, alerts). Device errors come back as "ext:<code>" from the SQL functions.
const MISSING_0006 = new Set([...MISSING_CODES, "42703", "PGRST204"]);
const raise6 = (e: { message: string; code?: string }): never => {
  const m = /ext:([a-z_]+)/.exec(e.message);
  if (m) throw new DeviceAuthError(m[1] as DeviceErrorCode);
  const t = /illegal_transition:([a-z_]+)->([a-z_]+)/.exec(e.message);
  if (t) throw new sm.IllegalTransitionError(t[1] as Job["status"], t[2] as Job["status"]);
  if ((e.code && MISSING_0006.has(e.code)) || /could not find the (table|function)|relation .* does not exist|column .* does not exist/i.test(e.message)) {
    throw new SchemaMissingError("extension pairing and device API", "0006");
  }
  throw new Error(friendly(e));
};
/** 0007 (ext_poll_v2) not applied yet: remember for a while instead of asking every poll. */
let pollV2Missing = 0;
const must6 = <T,>(r: { data: T | null; error: { message: string; code?: string } | null }): T => {
  if (r.error) raise6(r.error);
  return r.data as T;
};
const must = <T,>(r: { data: T | null; error: { message: string; code?: string } | null }): T => {
  if (r.error) raise(r.error);
  return r.data as T;
};
// Postgres timestamptz comes back as "...+00:00"; the app (and the mock) use ISO "...Z". Normalise so both stores return identical strings.
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const normTs = (r: Row): Row => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && TS.test(v) ? new Date(v).toISOString() : v]));
const DEVICE_COLS = "id,user_id,label,extension_version,created_at,last_seen_at,last_poll_at,last_ip_country,revoked_at,paused"; // never token_hash

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
  // RLS would just return no rows when signed out; fail loudly instead (same as the mock). Local session check, no network call.
  const needSession = async () => {
    if (!(await sb.auth.getSession()).data.session) throw new Error("Not signed in");
  };
  // RLS already restricts every query to auth.uid(); user_id is only set on insert.
  const list = async <T,>(table: string, build?: (q: any) => any): Promise<T[]> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    // RLS would just return no rows when signed out; fail loudly instead (same as the mock). Local session check, no network call.
    await needSession();
    const q = sb.from(table).select("*");
    const rows = must(await (build ? build(q) : q)) as Row[];
    return rows.map((r) => fromRow<T>(r));
  };
  const insert = async <T,>(table: string, v: object): Promise<T> =>
    fromRow<T>(must(await sb.from(table).insert({ ...toRow(v), user_id: await uid() }).select().single()) as Row);

  const getJob = async (id: string): Promise<Job | null> => {
    await needSession();
    const r = must(await sb.from("jobs").select("*").eq("id", id).maybeSingle()) as Row | null;
    return r ? (normTs(fromRow<Row>(r)) as unknown as Job) : null;
  };
  const getDevice = async (id: string): Promise<ExtensionDevice> => {
    await needSession();
    const r = must(await sb.from("extension_devices").select(DEVICE_COLS).eq("id", id).maybeSingle()) as Row | null;
    if (!r) throw new Error("Device not found");
    return normTs(fromRow<Row>(r)) as unknown as ExtensionDevice;
  };
  // Read, compute the new state with the pure rules, write only if the job is still in the state we read (optimistic lock), log the event.
  const transition = async (id: string, make: (j: Job) => sm.Transition): Promise<Job> => {
    const cur = await getJob(id);
    if (!cur) throw new Error("Job not found");
    const t = make(cur);
    const upd = must(await sb.from("jobs").update(toRow(t.patch)).eq("id", id).eq("status", cur.status).select().maybeSingle()) as Row | null;
    if (!upd) throw new Error("Job was changed by another worker, try again");
    must(await sb.from("job_events").insert({ job_id: id, user_id: cur.userId, from_status: t.event.fromStatus, to_status: t.event.toStatus, message: t.event.message }));
    return normTs(fromRow<Row>(upd)) as unknown as Job;
  };

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
      list: (f) => list("listings", (q) => (f?.status ? q.eq("status", f.status) : q)),
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
    jobs: {
      list: async (f) => (await list<Row>("jobs", (q) => {
        let x = q.order("created_at", { ascending: false }).order("id", { ascending: false });
        if (f?.status !== undefined) x = Array.isArray(f.status) ? x.in("status", f.status) : x.eq("status", f.status);
        if (f?.itemId) x = x.eq("item_id", f.itemId);
        if (f?.listingId) x = x.eq("listing_id", f.listingId);
        if (f?.limit) x = x.limit(f.limit);
        return x;
      })).map((r) => normTs(r) as unknown as Job),
      async get(id) { return getJob(id); },
      async events(jobIds) {
        if (!jobIds.length) return [];
        const rows = await list<Row>("job_events", (q) => q.in("job_id", jobIds).order("at", { ascending: true }));
        return rows.map((r) => normTs(r) as unknown as JobEvent);
      },
      async enqueue(input) {
        const userId = await uid();
        if (input.itemId) {
          // Relist guard (also enforced by a trigger in 0006).
          const it = must(await sb.from("items").select("status").eq("id", input.itemId).maybeSingle()) as Row | null;
          if (it && relistBlocked(input.jobType, input.payload, it.status as Item["status"])) throw new RelistBlockedError(input.itemId);
        }
        const j = sm.buildNewJob(input, { id: randomUUID(), userId }, new Date());
        const ins = await sb.from("jobs").insert(toRow(j)).select().single();
        if (ins.error && /relist_blocked/.test(ins.error.message) && input.itemId) throw new RelistBlockedError(input.itemId);
        if (ins.error) {
          if (ins.error.code === "23505" && input.idempotencyKey) {
            // The partial unique index (one OPEN job per user + key) refused it: return the job that is already there.
            const open = must(await sb.from("jobs").select("*").eq("idempotency_key", input.idempotencyKey).in("status", [...sm.OPEN_STATUSES]).limit(1)) as Row[];
            if (open[0]) return { job: normTs(fromRow<Row>(open[0])) as unknown as Job, created: false };
          }
          raise(ins.error);
        }
        must(await sb.from("job_events").insert({ job_id: j.id, user_id: userId, from_status: null, to_status: "queued", message: "Queued" }));
        return { job: normTs(fromRow<Row>(ins.data as Row)) as unknown as Job, created: true };
      },
      async claim({ executor, deviceId = null, limit = 1, now = new Date() }) {
        const r = await sb.rpc("claim_jobs", { p_executor: executor, p_device: deviceId, p_limit: limit, p_now: now.toISOString() });
        if (r.error) raise(r.error);
        return ((r.data ?? []) as Row[]).map((x) => normTs(fromRow<Row>(x)) as unknown as Job);
      },
      start: (id, now = new Date()) => transition(id, (j) => sm.start(j, now)),
      extendLease: (id, now = new Date()) => transition(id, (j) => sm.extendLease(j, now)),
      complete: (id, outcome, now = new Date()) => transition(id, (j) => sm.applyOutcome(j, outcome, now)),
      retry: (id, now = new Date()) => transition(id, (j) => sm.manualRetry(j, now)),
      cancel: (id, now = new Date()) => transition(id, (j) => sm.cancel(j, now)),
      async counts() {
        const out = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<(typeof JOB_STATUSES)[number], number>;
        await needSession();
        const r = await sb.rpc("job_counts");
        if (r.error) raise(r.error);
        for (const row of (r.data ?? []) as { status: Job["status"]; n: number | string }[]) out[row.status] = Number(row.n);
        return out;
      },
    },
    devices: {
      list: async () => (await needSession(), must(await sb.from("extension_devices").select(DEVICE_COLS).order("created_at", { ascending: false })) as Row[]).map((r) => normTs(fromRow<Row>(r)) as unknown as ExtensionDevice),
      async register({ label, tokenHash }) {
        const r = await sb.from("extension_devices").insert({ label, token_hash: tokenHash, user_id: await uid() }).select(DEVICE_COLS).single();
        if (r.error?.code === "23505") throw new Error("Device token already registered");
        return normTs(fromRow<Row>(must(r) as Row)) as unknown as ExtensionDevice;
      },
      async heartbeat(id, input = {}) {
        const cur = await getDevice(id);
        if (cur.revokedAt) throw new Error("Device revoked");
        const at = (input.now ?? new Date()).toISOString();
        const patch: Row = { last_seen_at: at };
        if (input.poll !== false) patch.last_poll_at = at;
        if (input.extensionVersion) patch.extension_version = input.extensionVersion;
        if (input.ipCountry !== undefined) patch.last_ip_country = input.ipCountry;
        const d = normTs(fromRow<Row>(must(await sb.from("extension_devices").update(patch).eq("id", id).select(DEVICE_COLS).single()) as Row)) as unknown as ExtensionDevice;
        const rows = Object.entries(input.marketplaces ?? {}).map(([marketplace, loggedIn]) => ({ device_id: id, marketplace, logged_in: loggedIn, checked_at: at, user_id: d.userId }));
        if (rows.length) must(await sb.from("extension_marketplace_state").upsert(rows, { onConflict: "device_id,marketplace" }));
        return d;
      },
      async setPaused(id, paused) {
        return normTs(fromRow<Row>(must(await sb.from("extension_devices").update({ paused }).eq("id", id).select(DEVICE_COLS).single()) as Row)) as unknown as ExtensionDevice;
      },
      async revoke(id) {
        const cur = await getDevice(id);
        if (cur.revokedAt) return cur;
        return normTs(fromRow<Row>(must(await sb.from("extension_devices").update({ revoked_at: new Date().toISOString() }).eq("id", id).select(DEVICE_COLS).single()) as Row)) as unknown as ExtensionDevice;
      },
      async marketplaceState() {
        return (await list<Row>("extension_marketplace_state")).map((r) => {
          const { userId, ...rest } = normTs(r) as Row; void userId;
          // Before 0006 the kill-switch columns do not exist yet.
          return { paused: false, pausedReason: null, challengeStreak: 0, ...rest } as unknown as MarketplaceLoginState;
        });
      },
      async setMarketplacePaused(deviceId, marketplace, paused) {
        const d = await getDevice(deviceId);
        const patch = { paused, paused_reason: paused ? "Paused by you" : null, challenge_streak: 0 };
        let rows = must6(await sb.from("extension_marketplace_state").update(patch).eq("device_id", d.id).eq("marketplace", marketplace).select()) as Row[];
        if (!rows.length) {
          rows = [must6(await sb.from("extension_marketplace_state")
            .insert({ device_id: d.id, marketplace, user_id: d.userId, logged_in: false, checked_at: new Date().toISOString(), ...patch }).select().single()) as Row];
        }
        const { userId, ...rest } = normTs(fromRow<Row>(rows[0])) as Row; void userId;
        return rest as unknown as MarketplaceLoginState;
      },
    },
    pairing: {
      async start(code) {
        await needSession();
        const r = await sb.rpc("ext_pair_start", { p_code: code });
        if (r.error) raise6(r.error);
        return { expiresAt: new Date(r.data as string).toISOString() };
      },
    },
    marketplaceSettings: {
      async list() {
        await needSession();
        const rows = must6(await sb.from("marketplace_settings").select("*")) as Row[];
        return rows.map((r) => ({ marketplace: r.marketplace as Marketplace, soldAction: r.sold_action as SoldAction, updatedAt: new Date(r.updated_at as string).toISOString() }));
      },
      async setSoldAction(marketplace, soldAction) {
        const userId = await uid();
        const r = must6(await sb.from("marketplace_settings").upsert({ user_id: userId, marketplace, sold_action: soldAction, updated_at: new Date().toISOString() }, { onConflict: "user_id,marketplace" }).select().single()) as Row;
        return { marketplace, soldAction: r.sold_action as SoldAction, updatedAt: new Date(r.updated_at as string).toISOString() };
      },
    },
    alerts: {
      async get() {
        await needSession();
        const r = must6(await sb.from("alert_prefs").select("*").maybeSingle()) as Row | null;
        return r ? { smsEnabled: !!r.sms_enabled, phone: (r.phone as string | null) ?? null, updatedAt: new Date(r.updated_at as string).toISOString() } : { smsEnabled: false, phone: null, updatedAt: null };
      },
      async update(patch) {
        const userId = await uid();
        const row: Row = { user_id: userId, updated_at: new Date().toISOString() };
        if (patch.smsEnabled !== undefined) row.sms_enabled = patch.smsEnabled;
        if (patch.phone !== undefined) row.phone = patch.phone;
        const r = must6(await sb.from("alert_prefs").upsert(row, { onConflict: "user_id" }).select().single()) as Row;
        return { smsEnabled: !!r.sms_enabled, phone: (r.phone as string | null) ?? null, updatedAt: new Date(r.updated_at as string).toISOString() };
      },
    },
    cursors: {
      list: async () => (await list<Row>("sales_scan_cursors")).map((r) => normTs(r) as unknown as import("./types").ScanCursor),
      async get(marketplace, scopeKey = "default") {
        await needSession();
        const r = must(await sb.from("sales_scan_cursors").select("*").eq("marketplace", marketplace).eq("scope_key", scopeKey).maybeSingle()) as Row | null;
        return r ? (normTs(fromRow<Row>(r)) as unknown as import("./types").ScanCursor) : null;
      },
      async advance({ marketplace, scopeKey = "default", cursor, now = new Date() }) {
        const at = now.toISOString();
        const r = must(await sb.from("sales_scan_cursors").upsert(
          { user_id: await uid(), marketplace, scope_key: scopeKey, cursor, last_scanned_at: at, last_success_at: at, last_error: null },
          { onConflict: "user_id,marketplace,scope_key" }).select().single()) as Row;
        return normTs(fromRow<Row>(r)) as unknown as import("./types").ScanCursor;
      },
      async fail({ marketplace, scopeKey = "default", error, now = new Date() }) {
        const r = must(await sb.from("sales_scan_cursors").upsert(
          { user_id: await uid(), marketplace, scope_key: scopeKey, last_scanned_at: now.toISOString(), last_error: error },
          { onConflict: "user_id,marketplace,scope_key" }).select().single()) as Row;
        return normTs(fromRow<Row>(r)) as unknown as import("./types").ScanCursor;
      },
    },
    itemSyncLog: {
      async append(e) { return normTs(await insert<Row>("item_sync_log", e)) as unknown as import("./types").ItemSyncLogEntry; },
      list: async (f) => (await list<Row>("item_sync_log", (q) => {
        let x = q.order("at", { ascending: false }).order("id", { ascending: false });
        if (f?.itemId) x = x.eq("item_id", f.itemId);
        if (f?.event) x = x.eq("event", f.event);
        if (f?.limit) x = x.limit(f.limit);
        return x;
      })).map((r) => normTs(r) as unknown as import("./types").ItemSyncLogEntry),
    },
    needsAction: makeNeedsAction(() => store),
    worker: {
      async run() {
        // No sign-in needed: job_maintenance() is SECURITY DEFINER and only does time-driven transitions.
        const r = await sb.rpc("job_maintenance");
        if (r.error) raise(r.error);
        const row = ((r.data ?? []) as { leases_expired: number; requeued: number }[])[0] ?? { leases_expired: 0, requeued: 0 };
        return { leasesExpired: row.leases_expired, requeued: row.requeued, ranAt: new Date().toISOString() };
      },
      async lastRun() {
        const r = must(await sb.from("worker_state").select("last_run_at").eq("id", "worker").maybeSingle()) as { last_run_at: string | null } | null;
        return r?.last_run_at ? new Date(r.last_run_at).toISOString() : null;
      },
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

  return { auth, store, storage, device: createDeviceGateway() };
}

/**
 * The extension's side (0006): a client with NO user session (anon key only). Every call passes the raw device token to a token-keyed
 * SECURITY DEFINER function, which hashes it and works only on that device's user's rows. No service-role key is used anywhere.
 */
function createDeviceGateway(): DeviceGateway {
  const { url, key } = env();
  const anon = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const rpc = async <T,>(fn: string, args: Row): Promise<T> => must6(await anon.rpc(fn, args)) as T;
  const job = (r: Row) => normTs(fromRow<Row>(r)) as unknown as Job;
  return {
    async pairComplete({ code, token, label, extensionVersion }) {
      const r = await rpc<Row>("ext_pair_complete", { p_code: code, p_token: token, p_label: label, p_version: extensionVersion });
      if (r.error) throw new DeviceAuthError(r.error as DeviceErrorCode, "That code is wrong, used or expired. Make a new one in Settings > Extension.");
      return { deviceId: r.device_id as string, label: r.label as string };
    },
    async poll(token, input) {
      const base = { p_token: token, p_version: input.extensionVersion, p_states: input.marketplaces ?? {}, p_ready: input.ready ?? [], p_limit: input.limit ?? 3 };
      const urgent = input.urgentOnly ?? [];
      let r: Row;
      if (!urgent.length || pollV2Missing > Date.now()) {
        // Without 0007, a marketplace on a long break is simply left out (delists wait for the break; at most 8 minutes).
        r = await rpc<Row>("ext_poll", urgent.length ? { ...base, p_ready: base.p_ready.filter((m) => !urgent.includes(m)) } : base);
      } else {
        const v2 = await anon.rpc("ext_poll_v2", { ...base, p_urgent: urgent });
        if (v2.error && (v2.error.code === "PGRST202" || /ext_poll_v2/.test(v2.error.message) && /not find|does not exist/i.test(v2.error.message))) {
          pollV2Missing = Date.now() + 5 * 60_000;
          r = await rpc<Row>("ext_poll", { ...base, p_ready: base.p_ready.filter((m) => !urgent.includes(m)) });
        } else r = must6(v2) as Row;
      }
      const dev = r.device as Row;
      return {
        device: { id: dev.id as string, label: dev.label as string, paused: !!dev.paused },
        requeued: Number(r.requeued ?? 0),
        marketplaces: (r.marketplaces as Row[]).map((m) => ({ marketplace: m.marketplace as Marketplace, loggedIn: !!m.logged_in, paused: !!m.paused, pausedReason: (m.paused_reason as string | null) ?? null })),
        jobs: (r.jobs as Row[]).map((x) => {
          const l = x.listing as Row | null, it = x.item as Row | null;
          return {
            job: job(x.job as Row),
            listing: l ? { externalId: (l.external_id as string | null) ?? null, url: (l.url as string | null) ?? null } : null,
            item: it ? {
              title: it.title as string, description: (it.description as string | null) ?? null, brand: (it.brand as string | null) ?? null, size: (it.size as string | null) ?? null,
              askingPrice: it.asking_price === null || it.asking_price === undefined ? null : Number(it.asking_price), status: it.status as Item["status"],
              sku: (it.sku as string | null | undefined) ?? null,
            } : null,
            soldAction: x.sold_action === "not_for_sale" ? "not_for_sale" : "delete",
            saleConfirmed: x.sale_confirmed === true,
          };
        }),
      };
    },
    async scanNext(token, marketplace) {
      const r = await rpc<Row>("ext_scan_next", { p_token: token, p_marketplace: marketplace });
      return { marketplace, scopeKey: r.scope_key as string, cursor: (r.cursor as string | null) ?? null, limit: Number(r.limit), overlapHours: Number(r.overlap_hours) };
    },
    async scanReport(token, report) {
      const r = await rpc<Row>("ext_scan_report", { p_token: token, p_marketplace: report.marketplace, p_sales: report.sales, p_next_cursor: report.nextCursor });
      return {
        ok: !!r.ok, stored: Number(r.stored), duplicates: Number(r.duplicates), jobsCreated: Number(r.jobs_created), unmatched: Number(r.unmatched),
        cancelled: Number(r.cancelled), cursorAdvanced: !!r.cursor_advanced, ...(r.error ? { error: String(r.error) } : {}),
      };
    },
    async listingsReport(token, report) {
      const r = await rpc<Row>("ext_listings_report", { p_token: token, p_marketplace: report.marketplace, p_external_ids: report.externalIds });
      return { seen: Number(r.seen), flagged: Number(r.flagged) };
    },
    jobStart: async (token, id) => job(await rpc<Row>("ext_job_start", { p_token: token, p_job: id })),
    jobProgress: async (token, id, message) => { await rpc("ext_job_progress", { p_token: token, p_job: id, p_message: message }); },
    jobExtend: async (token, id) => job(await rpc<Row>("ext_job_extend", { p_token: token, p_job: id })),
    async jobResult(token, id, outcome) {
      const ok = outcome.kind === "success";
      return job(await rpc<Row>("ext_job_result", {
        p_token: token, p_job: id, p_ok: ok, p_code: ok ? null : outcome.code, p_message: ok ? null : outcome.message,
        p_result: ok ? outcome.result ?? null : null,
      }));
    },
  };
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
