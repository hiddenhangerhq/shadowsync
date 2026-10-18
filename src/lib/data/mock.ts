// Local mock implementation: JSON file db + local folder storage. No network, no Supabase.
// Used for dev/tests until a Supabase project exists. Selected with DATA_BACKEND=mock.
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CookieJar, DataStore, Services, StorageService, AuthService } from "./interfaces";
import {
  CREDIT_COSTS, InsufficientCreditsError, ITEM_STATUSES, PLAN_ALLOWANCE, SOURCE_PRIORITY,
  type AuthUser, type CreditEntry, type Item, type ItemStatus, type Listing,
  type MarketplaceConnection, type Photo, type Profile, type Sale, type SyncLogEntry,
} from "./types";

interface MockUser { id: string; email: string; salt: string; hash: string }
interface Tables {
  users: MockUser[]; profiles: Profile[]; items: Item[]; photos: Photo[]; listings: Listing[];
  sales: Sale[]; connections: MarketplaceConnection[]; syncLog: SyncLogEntry[]; credits: CreditEntry[];
}
const emptyTables = (): Tables => ({
  users: [], profiles: [], items: [], photos: [], listings: [], sales: [], connections: [], syncLog: [], credits: [],
});

export const MOCK_COOKIE = "ss_mock_session";
const now = () => new Date().toISOString();
const hashPw = (pw: string, salt: string) => scryptSync(pw, salt, 32).toString("hex");

/** Shared in-process database, optionally persisted to <dir>/db.json. */
export class MockDb {
  t: Tables = emptyTables();
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

  return {
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
        db.t.listings = db.t.listings.filter((l) => !(l.userId === userId && l.itemId === id));
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
          if (SOURCE_PRIORITY[input.source] > SOURCE_PRIORITY[dup.source]) Object.assign(dup, input);
          return commit({ ...dup });
        }
        const s: Sale = { id: randomUUID(), userId, createdAt: now(), ...input };
        db.t.sales.push(s);
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

export function createMockServices(jar: CookieJar, db: MockDb, opts: { seed?: boolean } = {}): Services {
  const auth = makeAuth(db, jar, { seed: opts.seed ?? false });
  return { auth, store: makeStore(db, auth), storage: makeStorage(db, auth) };
}

/** Read bytes back from mock storage (used by the file-serving route in mock mode only). */
export async function mockRead(services: Services, p: string): Promise<Uint8Array | null> {
  const s = services.storage as unknown as { read?: (p: string) => Promise<Uint8Array | null> };
  return s.read ? s.read(p) : null;
}
