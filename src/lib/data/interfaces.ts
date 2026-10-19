// The ONLY surface the app talks to. Implementations live next to this file
// (mock.ts, supabase-impl.ts). To move to Firebase, add firebase-impl.ts and
// register it in index.ts. Nothing else changes.
import type {
  AuthUser, CreditAction, CreditEntry, ExtensionDevice, HeartbeatInput, Item, ItemPatch, ItemStatus, ItemSyncEvent, ItemSyncLogEntry,
  Job, JobEvent, JobExecutor, JobOutcome, JobStatus, Listing, Marketplace, MarketplaceConnection, MarketplaceLoginState,
  NeedsActionEntry, NewConnection, NewDevice, NewItem, NewItemSyncLogEntry, NewJob, NewListing, NewPhoto, NewSale,
  NewSyncLogEntry, Photo, Profile, Sale, ScanCursor, SyncLogEntry, WorkerRun,
  AlertPrefs, ExtPollInput, ExtPollResult, ExtScanNext, ExtScanResult, ExtScanSale,
} from "./types";

/** Minimal cookie access so auth works in Next, in tests, and in the proxy. */
export interface CookieJar {
  get(name: string): string | undefined;
  set(name: string, value: string, opts?: { maxAge?: number; path?: string; httpOnly?: boolean; sameSite?: "lax" | "strict" | "none"; secure?: boolean }): void;
  delete(name: string): void;
  getAll(): { name: string; value: string }[];
}

export interface AuthService {
  /** `needsConfirmation`: account created (or already exists) but no session until the emailed link is clicked (Supabase email confirmation ON). */
  signUp(email: string, password: string): Promise<{ user: AuthUser | null; error?: string; needsConfirmation?: boolean }>;
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
    /** Every listing of the signed-in user (used by sale detection and the needs-action list). */
    list(filter?: { status?: Listing["status"] }): Promise<Listing[]>;
    upsert(input: NewListing): Promise<Listing>;
  };
  sales: {
    list(opts?: { since?: string; limit?: number }): Promise<Sale[]>;
    /**
     * Idempotent per (marketplace, orderId) when orderId is set: a repeat returns the existing row, and a
     * higher-trust source (api > extension > manual > sheet-import > email) replaces a lower one's data.
     */
    record(input: NewSale): Promise<Sale>;
    /** Sales not yet shipped (shippedAt is null), earliest ship-by first (no deadline last). */
    listToShip(): Promise<Sale[]>;
    /** Mark shipped (today, or the given YYYY-MM-DD) or undo with on=false. */
    markShipped(id: string, on: boolean, day?: string): Promise<Sale>;
  };
  connections: {
    list(): Promise<MarketplaceConnection[]>;
    upsert(input: NewConnection): Promise<MarketplaceConnection>;
  };
  syncLog: {
    append(entry: NewSyncLogEntry): Promise<SyncLogEntry>;
    recent(limit?: number): Promise<SyncLogEntry[]>;
  };
  /**
   * Job queue (spec section 2). State changes go through the pure rules in lib/jobs/state-machine.ts, so every implementation
   * obeys the same transitions. Illegal transitions throw IllegalTransitionError. Missing 0005 tables throw SchemaMissingError.
   */
  jobs: {
    /** Newest first. */
    list(filter?: { status?: JobStatus | JobStatus[]; itemId?: string; listingId?: string; limit?: number }): Promise<Job[]>;
    get(id: string): Promise<Job | null>;
    /** The user-visible job log for the given jobs, oldest first. */
    events(jobIds: string[]): Promise<JobEvent[]>;
    /** Idempotent: an OPEN job with the same idempotencyKey is returned instead of creating a duplicate (created=false). */
    enqueue(input: NewJob): Promise<{ job: Job; created: boolean }>;
    /** Atomic. Takes due queued jobs for the executor: delist / mark_sold first, 10-minute lease, attempt counted. A paused or revoked device gets none. */
    claim(opts: { executor: JobExecutor; deviceId?: string | null; limit?: number; now?: Date }): Promise<Job[]>;
    start(id: string, now?: Date): Promise<Job>;
    extendLease(id: string, now?: Date): Promise<Job>;
    /** Report a result: success, transient (backoff retry), hard (failed) or needs_user. */
    complete(id: string, outcome: JobOutcome, now?: Date): Promise<Job>;
    /** failed / needs_user back to queued with a fresh round of attempts. */
    retry(id: string, now?: Date): Promise<Job>;
    cancel(id: string, now?: Date): Promise<Job>;
    counts(): Promise<Record<JobStatus, number>>;
  };
  devices: {
    list(): Promise<ExtensionDevice[]>;
    register(input: NewDevice): Promise<ExtensionDevice>;
    /** Stamps last_seen_at (and last_poll_at) and stores the per-marketplace signed-in yes/no. Throws for a revoked device. */
    heartbeat(id: string, input?: HeartbeatInput): Promise<ExtensionDevice>;
    setPaused(id: string, paused: boolean): Promise<ExtensionDevice>;
    revoke(id: string): Promise<ExtensionDevice>;
    marketplaceState(): Promise<MarketplaceLoginState[]>;
    /** Kill switch for one marketplace on one device. Resuming also clears the security-check streak. (0006) */
    setMarketplacePaused(deviceId: string, marketplace: Marketplace, paused: boolean): Promise<MarketplaceLoginState>;
  };
  /** Extension pairing, dashboard side (0006). The caller makes the code (lib/ext/tokens); only its hash is stored. Valid 5 minutes, single use. */
  pairing: {
    start(code: string, now?: Date): Promise<{ expiresAt: string }>;
  };
  /** Settings > Alerts (0006). Stored preference only; no SMS provider is connected. */
  alerts: {
    get(): Promise<AlertPrefs>;
    update(patch: Partial<Pick<AlertPrefs, "smsEnabled" | "phone">>): Promise<AlertPrefs>;
  };
  /** Server-held sales-scan position per connection (spec 3A). `scopeKey` defaults to "default". */
  cursors: {
    list(): Promise<ScanCursor[]>;
    get(marketplace: Marketplace, scopeKey?: string): Promise<ScanCursor | null>;
    /** Creates or moves the cursor and stamps last_scanned_at + last_success_at. Call it only after the scanned sales are stored. */
    advance(input: { marketplace: Marketplace; scopeKey?: string; cursor: string | null; now?: Date }): Promise<ScanCursor>;
    /** A scan failed: keep the cursor, stamp last_scanned_at and last_error. */
    fail(input: { marketplace: Marketplace; scopeKey?: string; error: string; now?: Date }): Promise<ScanCursor>;
  };
  /** Append-only per-item timeline (spec 6A). Entries are never edited or deleted. */
  itemSyncLog: {
    append(entry: NewItemSyncLogEntry): Promise<ItemSyncLogEntry>;
    /** Newest first. */
    list(filter?: { itemId?: string; event?: ItemSyncEvent; limit?: number }): Promise<ItemSyncLogEntry[]>;
  };
  /** The "Sold but still listed" queue (spec 6A), computed from data so it empties itself once a delist is confirmed. */
  needsAction: {
    list(now?: Date): Promise<NeedsActionEntry[]>;
    /** Hide one entry (by its key). Logged, never deletes anything. */
    ignore(key: string, note?: string): Promise<void>;
    /** The user ended the listing by hand: listing -> ended, open delist jobs canceled, logged. */
    markDelisted(listingId: string): Promise<void>;
  };
  /** Server worker. run() needs no signed-in user: it only does time-driven transitions for everyone (see job_maintenance in 0005). */
  worker: {
    /** Expire leases, requeue retry_wait jobs that are due, stamp the heartbeat. `now` is honoured by the mock only. */
    run(now?: Date): Promise<WorkerRun>;
    lastRun(): Promise<string | null>;
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

/**
 * The extension's side (spec 4 and 5): every call carries the RAW device token, never a user session. The token is hashed (sha256) and
 * matched to a device that is not revoked; every call is confined to that device's user. Paused devices may only poll (heartbeat).
 * Supabase: token-keyed SECURITY DEFINER functions in migration 0006 (no service-role key). Throws DeviceAuthError.
 */
export interface DeviceGateway {
  /** Swap a pairing code (from the dashboard) for a device; `token` is the new raw device token made by the caller. */
  pairComplete(input: { code: string; token: string; label: string; extensionVersion: string; now?: Date }): Promise<{ deviceId: string; label: string }>;
  /** Heartbeat + signed-in states + claim up to `limit` jobs (one per ready marketplace, delist / mark_sold first). */
  poll(token: string, input: ExtPollInput): Promise<ExtPollResult>;
  /** Server-held cursor for this device's scan of one marketplace (starts at "now" on first use). */
  scanNext(token: string, marketplace: Marketplace, now?: Date): Promise<ExtScanNext>;
  /** Store the sales, create delist / mark_sold jobs, and only then move the cursor (spec 3A). */
  scanReport(token: string, report: { marketplace: Marketplace; sales: ExtScanSale[]; nextCursor: string | null }, now?: Date): Promise<ExtScanResult>;
  jobStart(token: string, jobId: string, now?: Date): Promise<Job>;
  jobProgress(token: string, jobId: string, message: string): Promise<void>;
  jobExtend(token: string, jobId: string, now?: Date): Promise<Job>;
  /** The server turns the outcome into the next state (state machine) and applies side effects; 2 security checks in a row pause that marketplace. */
  jobResult(token: string, jobId: string, outcome: JobOutcome, now?: Date): Promise<Job>;
}

export interface Services {
  auth: AuthService;
  store: DataStore;
  storage: StorageService;
  device: DeviceGateway;
}
