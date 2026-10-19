// Local mock implementation: JSON file db + local folder storage. No network, no Supabase.
// Used for dev/tests until a Supabase project exists. Selected with DATA_BACKEND=mock.
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CookieJar, DataStore, Services, StorageService, AuthService } from "./interfaces";
import {
  CREDIT_COSTS, InsufficientCreditsError, ITEM_STATUSES, JOB_STATUSES, PLAN_ALLOWANCE, SOURCE_PRIORITY,
  type AuthUser, type CreditEntry, type ExtensionDevice, type Item, type ItemStatus, type ItemSyncLogEntry, type Job, type JobEvent, type Listing,
  type MarketplaceConnection, type MarketplaceLoginState, type Photo, type Profile, type Sale, type ScanCursor, type SyncLogEntry,
} from "./types";
import * as sm from "../jobs/state-machine";
import { completeJob, makeNeedsAction } from "../jobs/store-helpers";
import type { DeviceGateway } from "./interfaces";
import { AUTO_PAUSE_REASON, EXT_RATE, PAIRING_MAX_ACTIVE } from "../ext/limits";
import { isDeviceToken, PAIRING_TTL_MS, sha256Hex } from "../ext/tokens";
import { initCursor, processListingsReport, processScanReport } from "../jobs/sale-detection";
import { DeviceAuthError, RelistBlockedError, type AlertPrefs, type MarketplaceSetting } from "./types";
import { DEFAULT_SOLD_ACTION, relistBlocked } from "../jobs/sold";

interface MockUser { id: string; email: string; salt: string; hash: string }
type MockDevice = ExtensionDevice & { tokenHash: string };
type LoginRow = MarketplaceLoginState & { userId: string };
interface MockPairing { id: string; userId: string; codeHash: string; createdAt: string; expiresAt: string; usedAt: string | null; deviceId: string | null }
interface Tables {
  users: MockUser[]; profiles: Profile[]; items: Item[]; photos: Photo[]; listings: Listing[];
  sales: Sale[]; connections: MarketplaceConnection[]; syncLog: SyncLogEntry[]; credits: CreditEntry[];
  jobs: Job[]; jobEvents: JobEvent[]; devices: MockDevice[]; loginState: LoginRow[];
  cursors: ScanCursor[]; itemSyncLog: ItemSyncLogEntry[]; worker: { lastRunAt: string | null };
  pairings: MockPairing[]; alerts: (AlertPrefs & { userId: string })[];
  marketplaceSettings: (MarketplaceSetting & { userId: string })[];
}
const emptyTables = (): Tables => ({
  users: [], profiles: [], items: [], photos: [], listings: [], sales: [], connections: [], syncLog: [], credits: [],
  jobs: [], jobEvents: [], devices: [], loginState: [], cursors: [], itemSyncLog: [], worker: { lastRunAt: null },
  pairings: [], alerts: [], marketplaceSettings: [],
});
/** Rows saved before 0006 have no kill-switch fields. */
const withPauseDefaults = (r: LoginRow): LoginRow => Object.assign(r, { paused: r.paused ?? false, pausedReason: r.pausedReason ?? null, challengeStreak: r.challengeStreak ?? 0 });

export const MOCK_COOKIE = "ss_mock_session";
// Strictly increasing (like Postgres, whose separate statements never share a microsecond), so "happened after" is well defined in tests.
let lastNow = 0;
const now = () => { lastNow = Math.max(Date.now(), lastNow + 1); return new Date(lastNow).toISOString(); };
const hashPw = (pw: string, salt: string) => scryptSync(pw, salt, 32).toString("hex");

/** Shared in-process database, optionally persisted to <dir>/db.json. */
export class MockDb {
  t: Tables = emptyTables();
  /** Request counters for the device API (not persisted), same limits as _ext_rate() in 0006. */
  rate = new Map<string, { start: number; n: number }>();
  constructor(public dir: string | null = null) {
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, "db.json");
      if (fs.existsSync(f)) this.t = { ...emptyTables(), ...JSON.parse(fs.readFileSync(f, "utf8")) };
    }
  }
  save() {
    if (this.dir) fs.writeFileSync(path.join(this.dir, "db.json"), JSON.stringify(this.t));
  }
}

const sessionToken = (userId: string) => `mock.${userId}`;
const parseToken = (v?: string) => (v && v.startsWith("mock.") ? v.slice(5) : null);

function makeAuth(db: MockDb, jar: CookieJar, opts: { seed: boolean }): AuthService {
  const login = (u: MockUser): AuthUser => {
    jar.set(MOCK_COOKIE, sessionToken(u.id), { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 30 });
    return { id: u.id, email: u.email };
  };
  return {
    async signUp(email, password) {
      email = email.trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) return { user: null, error: "Enter a valid email." };
      if (password.length < 8) return { user: null, error: "Password must be at least 8 characters." };
      if (db.t.users.some((u) => u.email === email)) return { user: null, error: "An account with that email already exists." };
      const salt = randomBytes(8).toString("hex");
      const u: MockUser = { id: randomUUID(), email, salt, hash: hashPw(password, salt) };
      db.t.users.push(u);
      db.t.profiles.push({ id: u.id, email, displayName: null, plan: "free", theme: "system", createdAt: now() });
      if (opts.seed) seedDemo(db, u.id);
      db.save();
      return { user: login(u) };
    },
    async signIn(email, password) {
      email = email.trim().toLowerCase();
      const u = db.t.users.find((x) => x.email === email);
      const bad = { user: null, error: "Invalid email or password." };
      if (!u) return bad;
      const a = Buffer.from(hashPw(password, u.salt), "hex");
      const b = Buffer.from(u.hash, "hex");
      if (a.length !== b.length || !timingSafeEqual(a, b)) return bad;
      return { user: login(u) };
    },
    async signOut() { jar.delete(MOCK_COOKIE); },
    async getUser() {
      const id = parseToken(jar.get(MOCK_COOKIE));
      const u = id && db.t.users.find((x) => x.id === id);
      return u ? { id: u.id, email: u.email } : null;
    },
  };
}

function seedDemo(db: MockDb, userId: string) {
  const d = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const mk = (o: Partial<Item> & { title: string; status: ItemStatus }): Item => ({
    id: randomUUID(), userId, sku: null, description: null, cogs: null, purchaseLocation: null, category: null,
    brand: null, size: null, condition: null, askingPrice: null, dateListed: null, dateSold: null, priceSold: null,
    platform: null, fees: null, promo: null, shipProvider: null, shipCost: null, notes: null, source: "manual",
    createdAt: now(), updatedAt: now(), ...o,
  });
  db.t.items.push(
    mk({ title: "Demo: Nike Dri-FIT polo, L", status: "draft", sku: "D-1001", cogs: 4 }),
    mk({ title: "Demo: Titleist hat, white", status: "draft", sku: "D-1002", cogs: 2 }),
    mk({ title: "Demo: Adidas track pants, L", status: "listed", sku: "D-1003", cogs: 5, askingPrice: 28, platform: "poshmark", dateListed: d(6) }),
    mk({ title: "Demo: Patagonia fleece, M", status: "listed", sku: "D-1004", cogs: 9, askingPrice: 55, platform: "ebay", dateListed: d(12) }),
    mk({ title: "Demo: Under Armour 1/4 zip", status: "listed", sku: "D-1005", cogs: 3, askingPrice: 18, platform: "depop", dateListed: d(3) }),
    mk({ title: "Demo: Banana Republic pants", status: "sold", sku: "D-1006", cogs: 6, priceSold: 30, fees: 6, shipCost: 0, shipProvider: "Poshmark", platform: "poshmark", dateListed: d(20), dateSold: d(2) }),
  );
  const sale = (it: Item, o: Partial<Sale>): Sale => ({
    id: randomUUID(), userId, itemId: it.id, marketplace: (it.platform ?? "other") as Sale["marketplace"], orderId: null,
    soldAt: d(1), price: it.priceSold ?? 0, fees: null, promo: null, shipProvider: null, shipCost: null,
    sku: it.sku, title: it.title, shipBy: null, shippedAt: null, source: "manual", createdAt: now(), ...o,
  });
  const sold = db.t.items.find((x) => x.sku === "D-1006")!;
  const e1 = mk({ title: "Demo: Nike Tech fleece, L", status: "sold", sku: "D-1007", cogs: 8, priceSold: 42, platform: "ebay", dateSold: d(1) });
  const e2 = mk({ title: "Demo: Lululemon shorts, 8", status: "sold", sku: "D-1008", cogs: 5, priceSold: 26, platform: "depop", dateSold: d(0) });
  db.t.items.push(e1, e2);
  db.t.sales.push(
    sale(sold, { orderId: "P-3001", soldAt: d(2), shippedAt: d(1) }),
    sale(e1, { orderId: "13-00001-00001", shipBy: d(-1) }),
    sale(e2, { orderId: "DP-5521", soldAt: d(0), shipBy: d(-3) }),
  );
}

function makeStore(db: MockDb, auth: AuthService): DataStore {
  const uid = async () => {
    const u = await auth.getUser();
    if (!u) throw new Error("Not signed in");
    return u.id;
  };
  const commit = <T,>(v: T): T => { db.save(); return v; };
  const mine = async <T extends { userId: string }>(rows: T[]) => { const id = await uid(); return rows.filter((r) => r.userId === id); };
  const nz = <T,>(o: Partial<T>, defaults: T): T => ({ ...defaults, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) } as T);

  const balanceFor = (id: string) => db.t.credits.filter((c) => c.userId === id).reduce((s, c) => s + c.amount, 0);
  const addCredit = (c: Omit<CreditEntry, "id" | "createdAt">) => {
    db.t.credits.push({ id: randomUUID(), createdAt: now(), ...c });
  };

  // Log events are stamped with the real write time (like the database default), not the injected `now` the state rules use.
  const logEvent = (j: Job, from: Job["status"] | null, to: Job["status"], message: string) => {
    db.t.jobEvents.push({ id: randomUUID(), jobId: j.id, userId: j.userId, at: now(), fromStatus: from, toStatus: to, message });
  };
  const applyTransition = (j: Job, t: sm.Transition) => {
    Object.assign(j, t.patch);
    logEvent(j, t.event.fromStatus, t.event.toStatus, t.event.message);
  };
  const ownJob = async (id: string) => {
    const j = (await mine(db.t.jobs)).find((x) => x.id === id);
    if (!j) throw new Error("Job not found");
    return j;
  };
  const publicDevice = ({ tokenHash, ...d }: MockDevice): ExtensionDevice => (void tokenHash, { ...d });
  const ownDevice = async (id: string) => {
    const d = (await mine(db.t.devices)).find((x) => x.id === id);
    if (!d) throw new Error("Device not found");
    return d;
  };
  const cursorRow = async (marketplace: ScanCursor["marketplace"], scopeKey: string) => {
    const userId = await uid();
    let c = db.t.cursors.find((x) => x.userId === userId && x.marketplace === marketplace && x.scopeKey === scopeKey);
    if (!c) {
      c = { id: randomUUID(), userId, marketplace, scopeKey, cursor: null, lastScannedAt: null, lastSuccessAt: null, lastError: null, createdAt: now() };
      db.t.cursors.push(c);
    }
    return c;
  };

  const store: DataStore = {
    profile: {
      async get() { const id = await uid(); return db.t.profiles.find((p) => p.id === id) ?? null; },
      async update(patch) {
        const id = await uid();
        const p = db.t.profiles.find((x) => x.id === id)!;
        Object.assign(p, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
        return commit({ ...p });
      },
    },
    items: {
      async list(filter) {
        let r = (await mine(db.t.items)).filter((i) => !filter?.status || i.status === filter.status);
        r = r.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
        return (filter?.limit ? r.slice(0, filter.limit) : r).map((x) => ({ ...x }));
      },
      async get(id) { const i = (await mine(db.t.items)).find((x) => x.id === id); return i ? { ...i } : null; },
      async create(input) {
        const userId = await uid();
        if (input.sku && db.t.items.some((i) => i.userId === userId && i.sku === input.sku)) throw new Error(`SKU ${input.sku} already exists`);
        const item = nz<Item>(input, {
          id: randomUUID(), userId, sku: null, title: input.title, description: null, status: "draft", cogs: null,
          purchaseLocation: null, category: null, brand: null, size: null, condition: null, askingPrice: null,
          dateListed: null, dateSold: null, priceSold: null, platform: null, fees: null, promo: null,
          shipProvider: null, shipCost: null, notes: null, source: "manual", createdAt: now(), updatedAt: now(),
        });
        db.t.items.push(item);
        return commit({ ...item });
      },
      async update(id, patch) {
        const i = (await mine(db.t.items)).find((x) => x.id === id);
        if (!i) throw new Error("Item not found");
        Object.assign(i, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), { updatedAt: now() });
        return commit({ ...i });
      },
      async remove(id) {
        const userId = await uid();
        db.t.items = db.t.items.filter((i) => !(i.userId === userId && i.id === id));
        db.t.photos = db.t.photos.filter((p) => !(p.userId === userId && p.itemId === id));
        const gone = new Set(db.t.listings.filter((l) => l.userId === userId && l.itemId === id).map((l) => l.id));
        db.t.listings = db.t.listings.filter((l) => !gone.has(l.id));
        // Same as the database: history rows keep existing, they just lose the link (on delete set null).
        for (const j of db.t.jobs) { if (j.itemId === id) j.itemId = null; if (j.listingId && gone.has(j.listingId)) j.listingId = null; }
        for (const e of db.t.itemSyncLog) { if (e.itemId === id) e.itemId = null; if (e.listingId && gone.has(e.listingId)) e.listingId = null; }
        db.save();
      },
      async countsByStatus() {
        const c = Object.fromEntries(ITEM_STATUSES.map((s) => [s, 0])) as Record<ItemStatus, number>;
        for (const i of await mine(db.t.items)) c[i.status]++;
        return c;
      },
    },
    photos: {
      async listForItem(itemId) {
        return (await mine(db.t.photos)).filter((p) => p.itemId === itemId).sort((a, b) => a.position - b.position).map((p) => ({ ...p }));
      },
      async coverByItem(itemIds) {
        const out: Record<string, Photo> = {};
        for (const p of (await mine(db.t.photos)).sort((a, b) => a.position - b.position))
          if (itemIds.includes(p.itemId) && !out[p.itemId]) out[p.itemId] = { ...p };
        return out;
      },
      async add(input) {
        const userId = await uid();
        if (!db.t.items.some((i) => i.id === input.itemId && i.userId === userId)) throw new Error("Item not found");
        const p: Photo = { id: randomUUID(), userId, createdAt: now(), ...input };
        db.t.photos.push(p);
        return commit({ ...p });
      },
      async remove(id) {
        const userId = await uid();
        const p = db.t.photos.find((x) => x.id === id && x.userId === userId);
        if (!p) return null;
        db.t.photos = db.t.photos.filter((x) => x !== p);
        return commit({ ...p });
      },
    },
    listings: {
      async listForItem(itemId) { return (await mine(db.t.listings)).filter((l) => l.itemId === itemId).map((l) => ({ ...l })); },
      async list(filter) { return (await mine(db.t.listings)).filter((l) => !filter?.status || l.status === filter.status).map((l) => ({ ...l })); },
      async upsert(input) {
        const userId = await uid();
        let l = db.t.listings.find((x) => x.userId === userId && x.itemId === input.itemId && x.marketplace === input.marketplace);
        if (l) Object.assign(l, input);
        else { l = { id: randomUUID(), userId, createdAt: now(), ...input }; db.t.listings.push(l); }
        return commit({ ...l });
      },
    },
    sales: {
      async list(opts) {
        let r = (await mine(db.t.sales)).filter((s) => !opts?.since || s.soldAt >= opts.since);
        r = r.sort((a, b) => b.soldAt.localeCompare(a.soldAt));
        return (opts?.limit ? r.slice(0, opts.limit) : r).map((s) => ({ ...s }));
      },
      async record(input) {
        const userId = await uid();
        const dup = input.orderId
          ? db.t.sales.find((x) => x.userId === userId && x.marketplace === input.marketplace && x.orderId === input.orderId)
          : undefined;
        if (dup) {
          if (SOURCE_PRIORITY[input.source] > SOURCE_PRIORITY[dup.source]) Object.assign(dup, Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)));
          else for (const k of ["sku", "title", "shipBy"] as const) if (!dup[k] && input[k]) dup[k] = input[k]!; // lower source may only fill blanks
          return commit({ ...dup });
        }
        const s: Sale = { id: randomUUID(), userId, createdAt: now(), sku: null, title: null, shipBy: null, shippedAt: null, ...input };
        db.t.sales.push(s);
        return commit({ ...s });
      },
      async listToShip() {
        const r = (await mine(db.t.sales)).filter((s) => !s.shippedAt);
        r.sort((a, b) => (a.shipBy ?? "9999-99-99").localeCompare(b.shipBy ?? "9999-99-99") || b.soldAt.localeCompare(a.soldAt));
        return r.map((s) => ({ ...s }));
      },
      async markShipped(id, on, day) {
        const userId = await uid();
        const s = db.t.sales.find((x) => x.id === id && x.userId === userId);
        if (!s) throw new Error("Sale not found");
        s.shippedAt = on ? day ?? new Date().toISOString().slice(0, 10) : null;
        return commit({ ...s });
      },
    },
    connections: {
      async list() { return (await mine(db.t.connections)).map((c) => ({ ...c })); },
      async upsert(input) {
        const userId = await uid();
        let c = db.t.connections.find((x) => x.userId === userId && x.marketplace === input.marketplace && x.connectionType === input.connectionType);
        if (c) Object.assign(c, input);
        else { c = { id: randomUUID(), userId, createdAt: now(), ...input }; db.t.connections.push(c); }
        return commit({ ...c });
      },
    },
    syncLog: {
      async append(entry) {
        const userId = await uid();
        const e: SyncLogEntry = { id: randomUUID(), userId, createdAt: now(), ...entry };
        db.t.syncLog.push(e);
        return commit({ ...e });
      },
      async recent(limit = 20) {
        return (await mine(db.t.syncLog)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
      },
    },
    jobs: {
      async list(f) {
        const statuses = f?.status === undefined ? null : Array.isArray(f.status) ? f.status : [f.status];
        const r = (await mine(db.t.jobs))
          .filter((j) => (!statuses || statuses.includes(j.status)) && (!f?.itemId || j.itemId === f.itemId) && (!f?.listingId || j.listingId === f.listingId))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
        return (f?.limit ? r.slice(0, f.limit) : r).map((j) => ({ ...j }));
      },
      async get(id) { const j = (await mine(db.t.jobs)).find((x) => x.id === id); return j ? { ...j } : null; },
      async events(jobIds) {
        const ids = new Set(jobIds);
        return (await mine(db.t.jobEvents)).filter((e) => ids.has(e.jobId)).sort((a, b) => a.at.localeCompare(b.at)).map((e) => ({ ...e }));
      },
      async enqueue(input) {
        const userId = await uid();
        const item = input.itemId ? db.t.items.find((i) => i.id === input.itemId && i.userId === userId) : undefined;
        if (item && relistBlocked(input.jobType, input.payload, item.status)) throw new RelistBlockedError(item.id);
        const dup = sm.findOpenDuplicate(db.t.jobs.filter((j) => j.userId === userId), input.idempotencyKey);
        if (dup) return { job: { ...dup }, created: false };
        if (input.itemId && !db.t.items.some((i) => i.id === input.itemId && i.userId === userId)) throw new Error("Item not found");
        if (input.listingId && !db.t.listings.some((l) => l.id === input.listingId && l.userId === userId)) throw new Error("Listing not found");
        const j = sm.buildNewJob(input, { id: randomUUID(), userId }, new Date());
        db.t.jobs.push(j);
        logEvent(j, null, "queued", "Queued");
        return { job: commit({ ...j }), created: true };
      },
      async claim({ executor, deviceId = null, limit = 1, now = new Date() }) {
        const userId = await uid();
        if (deviceId) {
          const d = db.t.devices.find((x) => x.id === deviceId && x.userId === userId);
          if (!d || d.revokedAt || d.paused) return [];
        }
        const picked = sm.pickClaimable(db.t.jobs.filter((j) => j.userId === userId), executor, now, limit);
        for (const j of picked) applyTransition(j, sm.claim(j, deviceId, now));
        db.save();
        return picked.map((j) => ({ ...j }));
      },
      async start(id, now = new Date()) { const j = await ownJob(id); applyTransition(j, sm.start(j, now)); return commit({ ...j }); },
      async extendLease(id, now = new Date()) { const j = await ownJob(id); applyTransition(j, sm.extendLease(j, now)); return commit({ ...j }); },
      async complete(id, outcome, now = new Date()) { const j = await ownJob(id); applyTransition(j, sm.applyOutcome(j, outcome, now)); return commit({ ...j }); },
      async retry(id, now = new Date()) { const j = await ownJob(id); applyTransition(j, sm.manualRetry(j, now)); return commit({ ...j }); },
      async cancel(id, now = new Date()) { const j = await ownJob(id); applyTransition(j, sm.cancel(j, now)); return commit({ ...j }); },
      async counts() {
        const c = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<(typeof JOB_STATUSES)[number], number>;
        for (const j of await mine(db.t.jobs)) c[j.status]++;
        return c;
      },
    },
    devices: {
      async list() { return (await mine(db.t.devices)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicDevice); },
      async register({ label, tokenHash }) {
        const userId = await uid();
        if (db.t.devices.some((d) => d.tokenHash === tokenHash)) throw new Error("Device token already registered");
        const d: MockDevice = { id: randomUUID(), userId, label, tokenHash, extensionVersion: null, createdAt: now(), lastSeenAt: null, lastPollAt: null, lastIpCountry: null, revokedAt: null, paused: false };
        db.t.devices.push(d);
        return commit(publicDevice(d));
      },
      async heartbeat(id, input = {}) {
        const d = await ownDevice(id);
        if (d.revokedAt) throw new Error("Device revoked");
        const at = (input.now ?? new Date()).toISOString();
        d.lastSeenAt = at;
        if (input.poll !== false) d.lastPollAt = at;
        if (input.extensionVersion) d.extensionVersion = input.extensionVersion;
        if (input.ipCountry !== undefined) d.lastIpCountry = input.ipCountry;
        for (const [mp, loggedIn] of Object.entries(input.marketplaces ?? {}) as [MarketplaceLoginState["marketplace"], boolean][]) {
          const cur = db.t.loginState.find((x) => x.deviceId === id && x.marketplace === mp);
          if (cur) { cur.loggedIn = loggedIn; cur.checkedAt = at; }
          else db.t.loginState.push({ userId: d.userId, deviceId: id, marketplace: mp, loggedIn, checkedAt: at, paused: false, pausedReason: null, challengeStreak: 0 });
        }
        return commit(publicDevice(d));
      },
      async setPaused(id, paused) { const d = await ownDevice(id); d.paused = paused; return commit(publicDevice(d)); },
      async revoke(id) { const d = await ownDevice(id); d.revokedAt ??= now(); return commit(publicDevice(d)); },
      async marketplaceState() {
        return (await mine(db.t.loginState)).map((r) => { const { userId, ...rest } = withPauseDefaults(r); void userId; return { ...rest }; });
      },
      async setMarketplacePaused(deviceId, marketplace, paused) {
        const d = await ownDevice(deviceId);
        let r = db.t.loginState.find((x) => x.deviceId === d.id && x.marketplace === marketplace);
        if (!r) { r = { userId: d.userId, deviceId: d.id, marketplace, loggedIn: false, checkedAt: now(), paused: false, pausedReason: null, challengeStreak: 0 }; db.t.loginState.push(r); }
        withPauseDefaults(r);
        r.paused = paused; r.pausedReason = paused ? "Paused by you" : null; r.challengeStreak = 0;
        const { userId, ...rest } = r; void userId;
        return commit({ ...rest });
      },
    },
    pairing: {
      async start(code, at = new Date()) {
        const userId = await uid();
        const active = db.t.pairings.filter((p) => p.userId === userId && !p.usedAt && p.expiresAt > at.toISOString());
        if (active.length >= PAIRING_MAX_ACTIVE) throw new DeviceAuthError("too_many_codes", "Too many open pairing codes. Wait 5 minutes or use one of them.");
        const p: MockPairing = { id: randomUUID(), userId, codeHash: sha256Hex(code), createdAt: at.toISOString(), expiresAt: new Date(at.getTime() + PAIRING_TTL_MS).toISOString(), usedAt: null, deviceId: null };
        db.t.pairings.push(p);
        db.save();
        return { expiresAt: p.expiresAt };
      },
    },
    marketplaceSettings: {
      async list() {
        const userId = await uid();
        return (db.t.marketplaceSettings ?? []).filter((x) => x.userId === userId).map(({ marketplace, soldAction, updatedAt }) => ({ marketplace, soldAction, updatedAt }));
      },
      async setSoldAction(marketplace, soldAction) {
        const userId = await uid();
        db.t.marketplaceSettings ??= [];
        let r = db.t.marketplaceSettings.find((x) => x.userId === userId && x.marketplace === marketplace);
        if (!r) { r = { userId, marketplace, soldAction: DEFAULT_SOLD_ACTION, updatedAt: null }; db.t.marketplaceSettings.push(r); }
        r.soldAction = soldAction; r.updatedAt = now();
        return commit({ marketplace, soldAction, updatedAt: r.updatedAt });
      },
    },
    alerts: {
      async get() {
        const userId = await uid();
        const a = db.t.alerts.find((x) => x.userId === userId);
        return a ? { smsEnabled: a.smsEnabled, phone: a.phone, updatedAt: a.updatedAt } : { smsEnabled: false, phone: null, updatedAt: null };
      },
      async update(patch) {
        const userId = await uid();
        let a = db.t.alerts.find((x) => x.userId === userId);
        if (!a) { a = { userId, smsEnabled: false, phone: null, updatedAt: null }; db.t.alerts.push(a); }
        if (patch.smsEnabled !== undefined) a.smsEnabled = patch.smsEnabled;
        if (patch.phone !== undefined) a.phone = patch.phone;
        a.updatedAt = now();
        return commit({ smsEnabled: a.smsEnabled, phone: a.phone, updatedAt: a.updatedAt });
      },
    },
    cursors: {
      async list() { return (await mine(db.t.cursors)).map((c) => ({ ...c })); },
      async get(marketplace, scopeKey = "default") {
        const c = (await mine(db.t.cursors)).find((x) => x.marketplace === marketplace && x.scopeKey === scopeKey);
        return c ? { ...c } : null;
      },
      async advance({ marketplace, scopeKey = "default", cursor, now: at = new Date() }) {
        const c = await cursorRow(marketplace, scopeKey);
        c.cursor = cursor; c.lastScannedAt = at.toISOString(); c.lastSuccessAt = at.toISOString(); c.lastError = null;
        return commit({ ...c });
      },
      async fail({ marketplace, scopeKey = "default", error, now: at = new Date() }) {
        const c = await cursorRow(marketplace, scopeKey);
        c.lastScannedAt = at.toISOString(); c.lastError = error;
        return commit({ ...c });
      },
    },
    itemSyncLog: {
      async append(entry) {
        const userId = await uid();
        if (entry.itemId && !db.t.items.some((i) => i.id === entry.itemId && i.userId === userId)) throw new Error("Item not found");
        const e: ItemSyncLogEntry = { id: randomUUID(), userId, at: now(), itemId: null, listingId: null, marketplace: null, jobId: null, detail: null, ref: null, ...entry };
        db.t.itemSyncLog.push(e);
        return commit({ ...e });
      },
      async list(f) {
        const r = (await mine(db.t.itemSyncLog))
          .filter((e) => (!f?.itemId || e.itemId === f.itemId) && (!f?.event || e.event === f.event))
          .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
        return (f?.limit ? r.slice(0, f.limit) : r).map((e) => ({ ...e }));
      },
    },
    needsAction: makeNeedsAction(() => store),
    worker: {
      async run(at = new Date()) {
        // Time-driven transitions for EVERY user's jobs, no sign-in needed (mirrors job_maintenance() in 0005).
        let leasesExpired = 0, requeued = 0;
        for (const j of db.t.jobs) {
          const exp = sm.expireLease(j, at);
          if (exp) { applyTransition(j, exp); leasesExpired++; continue; }
          const due = sm.requeueIfDue(j, at);
          if (due) { applyTransition(j, due); requeued++; }
        }
        db.t.worker.lastRunAt = at.toISOString();
        db.save();
        return { leasesExpired, requeued, ranAt: db.t.worker.lastRunAt };
      },
      async lastRun() { await uid(); return db.t.worker.lastRunAt; },
    },
    creditLedger: {
      async balance() { return balanceFor(await uid()); },
      async entries(limit = 50) {
        return (await mine(db.t.credits)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
      },
      async ensureMonthlyAllowance(at = new Date()) {
        const userId = await uid();
        const period = at.toISOString().slice(0, 7);
        if (!db.t.credits.some((c) => c.userId === userId && c.kind === "reset" && c.period === period)) {
          const plan = db.t.profiles.find((p) => p.id === userId)?.plan ?? "free";
          addCredit({ userId, kind: "reset", action: null, amount: PLAN_ALLOWANCE[plan] - balanceFor(userId), period, note: `Monthly allowance (${plan})` });
          db.save();
        }
        return balanceFor(userId);
      },
      async spend(action, cost = CREDIT_COSTS[action], note) {
        const userId = await uid();
        const bal = balanceFor(userId);
        if (cost <= 0) throw new Error("cost must be positive");
        if (bal < cost) throw new InsufficientCreditsError(bal, cost);
        addCredit({ userId, kind: "spend", action, amount: -cost, period: null, note: note ?? null });
        db.save();
        return bal - cost;
      },
      async grant(amount, note) {
        const userId = await uid();
        addCredit({ userId, kind: "grant", action: null, amount, period: null, note: note ?? null });
        db.save();
        return balanceFor(userId);
      },
    },
  };
  return store;
}

function makeStorage(db: MockDb, auth: AuthService): StorageService {
  const root = () => path.join(db.dir ?? path.join(process.cwd(), ".data"), "uploads");
  const safe = (p: string) => {
    const full = path.resolve(root(), p);
    if (!full.startsWith(path.resolve(root()) + path.sep)) throw new Error("Bad path");
    return full;
  };
  const memory = db.dir === null ? new Map<string, Uint8Array>() : null;
  void auth;
  return {
    async upload(p, data) {
      if (memory) { memory.set(p, data); return; }
      const f = safe(p);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, data);
    },
    async getUrl(p) { return `/api/files/${p.split("/").map(encodeURIComponent).join("/")}`; },
    async remove(paths) {
      for (const p of paths) {
        if (memory) memory.delete(p);
        else fs.rmSync(safe(p), { force: true });
      }
    },
    // test/route helper
    ...({ async read(p: string) { return memory ? memory.get(p) ?? null : fs.existsSync(safe(p)) ? new Uint8Array(fs.readFileSync(safe(p))) : null; } } as object),
  };
}

/**
 * The extension's API in mock mode. Mirrors the token-keyed SQL functions in 0006: the raw token is hashed and matched to a device that is
 * not revoked (and not paused, except for poll), and everything runs as that device's user only. Rules come from the shared modules.
 */
function makeDeviceGateway(db: MockDb): DeviceGateway {
  const rate = (key: string, max: number, windowMs: number) => {
    const t = Date.now();
    const r = db.rate.get(key);
    if (!r || t - r.start >= windowMs) { db.rate.set(key, { start: t, n: 1 }); return; }
    if (++r.n > max) throw new DeviceAuthError("rate_limited", "Too many requests, slow down");
  };
  const asUser = (userId: string): AuthService => ({
    signUp: async () => ({ user: null, error: "not available" }), signIn: async () => ({ user: null, error: "not available" }), signOut: async () => undefined,
    getUser: async () => { const u = db.t.users.find((x) => x.id === userId); return u ? { id: u.id, email: u.email } : null; },
  });
  const authDevice = (token: string, allowPaused = false) => {
    if (!isDeviceToken(token)) throw new DeviceAuthError("invalid_token");
    const d = db.t.devices.find((x) => x.tokenHash === sha256Hex(token));
    if (!d) throw new DeviceAuthError("invalid_token");
    if (d.revokedAt) throw new DeviceAuthError("device_revoked", "This browser was disconnected from Shadow Sync. Pair it again.");
    if (!allowPaused && d.paused) throw new DeviceAuthError("device_paused", "Paused from the dashboard");
    rate(`device:${d.id}`, EXT_RATE.device.max, EXT_RATE.device.windowMs);
    return { d, store: makeStore(db, asUser(d.userId)) };
  };
  const stateRow = (d: MockDevice, marketplace: Job["marketplace"]) => {
    let r = db.t.loginState.find((x) => x.deviceId === d.id && x.marketplace === marketplace);
    if (!r) { r = { userId: d.userId, deviceId: d.id, marketplace, loggedIn: false, checkedAt: now(), paused: false, pausedReason: null, challengeStreak: 0 }; db.t.loginState.push(r); }
    return withPauseDefaults(r);
  };
  const deviceJob = (d: MockDevice, id: string) => {
    const j = db.t.jobs.find((x) => x.id === id && x.userId === d.userId);
    if (!j || j.claimedByDevice !== d.id || (j.status !== "claimed" && j.status !== "running")) throw new DeviceAuthError("not_your_job", "Job not found for this browser");
    return j;
  };
  const event = (j: Job, message: string) => {
    db.t.jobEvents.push({ id: randomUUID(), jobId: j.id, userId: j.userId, at: now(), fromStatus: j.status, toStatus: j.status, message });
  };
  const apply = (j: Job, t: sm.Transition) => {
    Object.assign(j, t.patch);
    db.t.jobEvents.push({ id: randomUUID(), jobId: j.id, userId: j.userId, at: now(), fromStatus: t.event.fromStatus, toStatus: t.event.toStatus, message: t.event.message });
  };
  return {
    async pairComplete({ code, token, label, extensionVersion, now: at = new Date() }) {
      rate("pair", EXT_RATE.pair.max, EXT_RATE.pair.windowMs);
      if (!isDeviceToken(token)) throw new DeviceAuthError("bad_request", "bad token");
      const p = db.t.pairings.find((x) => x.codeHash === sha256Hex(code) && !x.usedAt && x.expiresAt > at.toISOString());
      if (!p) throw new DeviceAuthError("pairing_invalid", "That code is wrong, used or expired. Make a new one in Settings > Extension.");
      const d: MockDevice = {
        id: randomUUID(), userId: p.userId, label: label.trim().slice(0, 80) || "Browser extension", tokenHash: sha256Hex(token), extensionVersion,
        createdAt: now(), lastSeenAt: now(), lastPollAt: null, lastIpCountry: null, revokedAt: null, paused: false,
      };
      db.t.devices.push(d);
      p.usedAt = at.toISOString(); p.deviceId = d.id;
      db.save();
      return { deviceId: d.id, label: d.label };
    },
    async poll(token, input) {
      const { d } = authDevice(token, true);
      const at = input.now ?? new Date();
      d.lastSeenAt = at.toISOString(); d.lastPollAt = at.toISOString(); d.extensionVersion = input.extensionVersion;
      let requeued = 0;
      for (const [mp, loggedIn] of Object.entries(input.marketplaces ?? {}) as [Job["marketplace"], boolean][]) {
        const r = stateRow(d, mp);
        r.loggedIn = loggedIn; r.checkedAt = at.toISOString();
        if (!loggedIn) continue;
        for (const j of db.t.jobs) {
          if (j.userId !== d.userId || j.marketplace !== mp || j.executor !== "extension") continue;
          const t = sm.requeueAfterSignIn(j, at);
          if (t) { apply(j, t); requeued++; }
        }
      }
      const states = db.t.loginState.filter((x) => x.deviceId === d.id).map(withPauseDefaults);
      const claimed: Job[] = [];
      if (!d.paused) {
        const busy = new Set(db.t.jobs.filter((j) => j.claimedByDevice === d.id && (j.status === "claimed" || j.status === "running")).map((j) => j.marketplace));
        const ready = [...new Set(input.ready ?? [])].filter((mp) => {
          const r = states.find((x) => x.marketplace === mp);
          return r && r.loggedIn && !r.paused && !busy.has(mp);
        });
        const firsts = ready
          .map((mp) => sm.pickClaimable(db.t.jobs.filter((j) => j.userId === d.userId && j.marketplace === mp
            && (!(input.urgentOnly ?? []).includes(mp) || j.jobType === "delist" || j.jobType === "mark_sold")), "extension", at, 1)[0])
          .filter((j): j is Job => !!j)
          .sort(sm.claimOrder)
          .slice(0, Math.max(0, Math.min(input.limit ?? 3, 6)));
        for (const j of firsts) { apply(j, sm.claim(j, d.id, at)); claimed.push(j); }
      }
      db.save();
      return {
        device: { id: d.id, label: d.label, paused: d.paused },
        marketplaces: states.map((r) => ({ marketplace: r.marketplace, loggedIn: r.loggedIn, paused: r.paused, pausedReason: r.pausedReason })),
        requeued,
        jobs: claimed.map((j) => {
          const l = j.listingId ? db.t.listings.find((x) => x.id === j.listingId) : undefined;
          const it = j.itemId ? db.t.items.find((x) => x.id === j.itemId) : undefined;
          return {
            job: { ...j },
            listing: l ? { externalId: l.externalId, url: l.url } : null,
            item: it ? { title: it.title, description: it.description, askingPrice: it.askingPrice, brand: it.brand, size: it.size, status: it.status, sku: it.sku } : null,
            soldAction: (db.t.marketplaceSettings ?? []).find((x) => x.userId === d.userId && x.marketplace === j.marketplace)?.soldAction ?? DEFAULT_SOLD_ACTION,
            saleConfirmed: typeof j.payload?.saleId === "string" && !!j.itemId && db.t.sales.some((x) => x.id === j.payload.saleId && x.userId === d.userId && x.itemId === j.itemId),
          };
        }),
      };
    },
    async scanNext(token, marketplace, at = new Date()) {
      const { d, store } = authDevice(token);
      const scopeKey = `device:${d.id}`;
      const c = await initCursor(store, marketplace, scopeKey, at.toISOString());
      return { marketplace, scopeKey, cursor: c.cursor, limit: 50, overlapHours: 24 };
    },
    async scanReport(token, report, at = new Date()) {
      const { d, store } = authDevice(token);
      const r = await processScanReport(store, { marketplace: report.marketplace, scopeKey: `device:${d.id}`, source: "extension", sales: report.sales, nextCursor: report.nextCursor }, at);
      return { ok: r.ok, stored: r.stored, duplicates: r.duplicates, jobsCreated: r.jobsCreated, unmatched: r.unmatched, cancelled: r.cancelled, cursorAdvanced: r.cursorAdvanced, ...(r.error ? { error: r.error } : {}) };
    },
    async listingsReport(token, report, at = new Date()) {
      const { store } = authDevice(token);
      return processListingsReport(store, { marketplace: report.marketplace, externalIds: report.externalIds, source: "extension" }, at);
    },
    async jobStart(token, id, at = new Date()) {
      const { d } = authDevice(token);
      const j = deviceJob(d, id);
      apply(j, sm.start(j, at));
      db.save();
      return { ...j };
    },
    async jobProgress(token, id, message) {
      const { d } = authDevice(token);
      event(deviceJob(d, id), message.slice(0, 300));
      db.save();
    },
    async jobExtend(token, id, at = new Date()) {
      const { d } = authDevice(token);
      const j = deviceJob(d, id);
      apply(j, sm.extendLease(j, at));
      db.save();
      return { ...j };
    },
    async jobResult(token, id, outcome, at = new Date()) {
      const { d, store } = authDevice(token);
      const marketplace = deviceJob(d, id).marketplace;
      const done = await completeJob(store, id, outcome, at);
      const r = stateRow(d, marketplace);
      if (outcome.kind === "success") r.challengeStreak = 0;
      else if (outcome.kind === "needs_user" && sm.CHALLENGE_CODES.has(outcome.code)) {
        r.challengeStreak++;
        if (r.challengeStreak >= 2) { r.paused = true; r.pausedReason = AUTO_PAUSE_REASON; }
      }
      if (outcome.kind === "needs_user" && sm.SIGNED_OUT_CODES.has(outcome.code)) { r.loggedIn = false; r.checkedAt = at.toISOString(); }
      db.save();
      return done;
    },
  };
}

export function createMockServices(jar: CookieJar, db: MockDb, opts: { seed?: boolean } = {}): Services {
  const auth = makeAuth(db, jar, { seed: opts.seed ?? false });
  return { auth, store: makeStore(db, auth), storage: makeStorage(db, auth), device: makeDeviceGateway(db) };
}

/** Read bytes back from mock storage (used by the file-serving route in mock mode only). */
export async function mockRead(services: Services, p: string): Promise<Uint8Array | null> {
  const s = services.storage as unknown as { read?: (p: string) => Promise<Uint8Array | null> };
  return s.read ? s.read(p) : null;
}
