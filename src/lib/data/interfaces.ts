// The ONLY surface the app talks to. Implementations live next to this file
// (mock.ts, supabase-impl.ts). To move to Firebase, add firebase-impl.ts and
// register it in index.ts. Nothing else changes.
import type {
  AuthUser, CreditAction, CreditEntry, Item, ItemPatch, ItemStatus, Listing,
  MarketplaceConnection, NewConnection, NewItem, NewListing, NewPhoto, NewSale,
  NewSyncLogEntry, Photo, Profile, Sale, SyncLogEntry,
} from "./types";

/** Minimal cookie access so auth works in Next, in tests, and in the proxy. */
export interface CookieJar {
  get(name: string): string | undefined;
  set(name: string, value: string, opts?: { maxAge?: number; path?: string; httpOnly?: boolean; sameSite?: "lax" | "strict" | "none"; secure?: boolean }): void;
  delete(name: string): void;
  getAll(): { name: string; value: string }[];
}

export interface AuthService {
  signUp(email: string, password: string): Promise<{ user: AuthUser | null; error?: string }>;
  signIn(email: string, password: string): Promise<{ user: AuthUser | null; error?: string }>;
  signOut(): Promise<void>;
  /** Current user from the session cookie, or null. */
  getUser(): Promise<AuthUser | null>;
}

export interface StorageService {
  upload(path: string, data: Uint8Array, contentType: string): Promise<void>;
  /** Browser-loadable URL for a stored object (signed URL in Supabase, API route in mock). */
  getUrl(path: string): Promise<string>;
  remove(paths: string[]): Promise<void>;
}

/** All methods are implicitly scoped to the signed-in user (RLS in Supabase, filter in mock). */
export interface DataStore {
  profile: {
    get(): Promise<Profile | null>;
    update(patch: Partial<Pick<Profile, "displayName" | "plan" | "theme">>): Promise<Profile>;
  };
  items: {
    list(filter?: { status?: ItemStatus; limit?: number }): Promise<Item[]>;
    get(id: string): Promise<Item | null>;
    create(input: NewItem): Promise<Item>;
    update(id: string, patch: ItemPatch): Promise<Item>;
    remove(id: string): Promise<void>;
    countsByStatus(): Promise<Record<ItemStatus, number>>;
  };
  photos: {
    listForItem(itemId: string): Promise<Photo[]>;
    /** First photo per item, for list thumbnails. */
    coverByItem(itemIds: string[]): Promise<Record<string, Photo>>;
    add(input: NewPhoto): Promise<Photo>;
    remove(id: string): Promise<Photo | null>;
  };
  listings: {
    listForItem(itemId: string): Promise<Listing[]>;
    upsert(input: NewListing): Promise<Listing>;
  };
  sales: {
    list(opts?: { since?: string; limit?: number }): Promise<Sale[]>;
    /**
     * Idempotent per (marketplace, orderId) when orderId is set: a repeat returns the existing row, and a
     * higher-trust source (api > extension > manual > sheet-import > email) replaces a lower one's data.
     */
    record(input: NewSale): Promise<Sale>;
  };
  connections: {
    list(): Promise<MarketplaceConnection[]>;
    upsert(input: NewConnection): Promise<MarketplaceConnection>;
  };
  syncLog: {
    append(entry: NewSyncLogEntry): Promise<SyncLogEntry>;
    recent(limit?: number): Promise<SyncLogEntry[]>;
  };
  creditLedger: {
    balance(): Promise<number>;
    entries(limit?: number): Promise<CreditEntry[]>;
    /** Idempotent: if this month has no reset yet, set balance to the plan allowance. Returns balance. */
    ensureMonthlyAllowance(now?: Date): Promise<number>;
    /** Atomic. Throws InsufficientCreditsError. Returns new balance. */
    spend(action: CreditAction, cost?: number, note?: string): Promise<number>;
    grant(amount: number, note?: string): Promise<number>;
  };
}

export interface Services {
  auth: AuthService;
  store: DataStore;
  storage: StorageService;
}
