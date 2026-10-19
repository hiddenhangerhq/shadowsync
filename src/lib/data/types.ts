// Domain types shared by every data-layer implementation. No vendor imports here.

export type ItemStatus = "draft" | "listed" | "sold" | "delisted";
export const ITEM_STATUSES: ItemStatus[] = ["draft", "listed", "sold", "delisted"];

export type Marketplace =
  | "ebay" | "poshmark" | "depop" | "whatnot" | "grailed"
  | "etsy" | "mercari" | "shopify" | "wix" | "other";

/**
 * How a record got into Shadow Sync. User-facing paths: "api" (marketplace's official API), "extension"
 * (Chrome extension in the user's own browser), "manual". "sheet-import" and "email" are PRIVATE LEGACY imports of
 * David's existing data (Google Sheet, old Gmail parsing). The product never reads anyone's email.
 */
export type Source = "api" | "extension" | "email" | "sheet-import" | "manual";
export const SOURCES: Source[] = ["api", "extension", "email", "sheet-import", "manual"];

/** When the same sale arrives from two paths (same marketplace + order id), the higher-trust source wins. */
export const SOURCE_PRIORITY: Record<Source, number> = { api: 5, extension: 4, manual: 3, "sheet-import": 2, email: 1 };

/**
 * How a marketplace is connected (the only user-facing options):
 *  - oauth_api: the marketplace's own consent screen; we store tokens, never passwords
 *  - extension: our Chrome extension acting in the user's own logged-in browser
 */
export type ConnectionType = "oauth_api" | "extension";
export const CONNECTION_TYPES: ConnectionType[] = ["oauth_api", "extension"];
export type ConnectionStatus = "connected" | "needs_reauth" | "error" | "paused" | "disconnected";

export type Plan = "free" | "starter" | "pro";

export type ThemeId =
  | "system" | "light" | "dark" | "cyberpunk" | "retro"
  | "midnight" | "forest" | "sunset";
export const THEMES: { id: ThemeId; label: string; blurb: string }[] = [
  { id: "system", label: "System", blurb: "Follows your phone or computer (light or dark)" },
  { id: "light", label: "Light", blurb: "Clean, airy, teal accents" },
  { id: "dark", label: "Dark", blurb: "Deep charcoal with teal and green" },
  { id: "cyberpunk", label: "Cyberpunk", blurb: "Neon teal and magenta on near-black" },
  { id: "retro", label: "Retro Gaming", blurb: "Pixel-arcade feel, CRT greens and purples" },
  { id: "midnight", label: "Midnight Blue", blurb: "Navy and ice blue" },
  { id: "forest", label: "Forest", blurb: "Mossy greens and warm earth" },
  { id: "sunset", label: "Sunset", blurb: "Plum and coral dusk" },
];
export const THEME_IDS = THEMES.map((t) => t.id);

export interface AuthUser { id: string; email: string }

export interface Profile {
  id: string;
  email: string;
  displayName: string | null;
  plan: Plan;
  theme: ThemeId;
  createdAt: string;
}

export interface Item {
  id: string;
  userId: string;
  sku: string | null;
  title: string;
  description: string | null;
  status: ItemStatus;
  cogs: number | null;            // GOLFTHRIFT col E
  purchaseLocation: string | null;
  category: string | null;
  brand: string | null;
  size: string | null;
  condition: string | null;
  askingPrice: number | null;
  dateListed: string | null;      // YYYY-MM-DD (col L)
  dateSold: string | null;        // (col P)
  priceSold: number | null;       // (col Q)
  platform: string | null;        // (col R)
  fees: number | null;            // (col T)
  promo: number | null;           // (col U)
  shipProvider: string | null;    // (col V)
  shipCost: number | null;        // (col W)
  notes: string | null;
  source: Source;
  createdAt: string;
  updatedAt: string;
}
export type NewItem = Partial<Omit<Item, "id" | "userId" | "createdAt" | "updatedAt">> & { title: string };
export type ItemPatch = Partial<NewItem>;

export interface Photo {
  id: string;
  userId: string;
  itemId: string;
  path: string;                    // storage path: {userId}/{itemId}/{file}
  position: number;
  width: number | null;
  height: number | null;
  bytes: number | null;
  createdAt: string;
}
export type NewPhoto = Omit<Photo, "id" | "userId" | "createdAt">;

export interface Listing {
  id: string;
  userId: string;
  itemId: string;
  marketplace: Marketplace;
  externalId: string | null;
  url: string | null;
  price: number | null;
  status: "active" | "ended" | "sold" | "error";
  listedAt: string | null;
  endedAt: string | null;
  source: Source;
  createdAt: string;
}
export type NewListing = Omit<Listing, "id" | "userId" | "createdAt">;

export interface Sale {
  id: string;
  userId: string;
  itemId: string | null;
  marketplace: Marketplace;
  orderId: string | null;
  soldAt: string;                  // YYYY-MM-DD
  price: number;
  fees: number | null;
  promo: number | null;
  shipProvider: string | null;
  shipCost: number | null;
  /** SKU of the item sold (shown next to the order in Ship). Falls back to the linked item's SKU in the UI. */
  sku: string | null;
  title: string | null;            // item title as the marketplace reported it
  shipBy: string | null;           // YYYY-MM-DD ship-by deadline, when the marketplace gives one
  shippedAt: string | null;        // YYYY-MM-DD; null = still to ship
  source: Source;                  // how this sale was detected
  createdAt: string;
}
export type NewSale = Omit<Sale, "id" | "userId" | "createdAt" | "sku" | "title" | "shipBy" | "shippedAt"> &
  Partial<Pick<Sale, "sku" | "title" | "shipBy" | "shippedAt">>;

export interface MarketplaceConnection {
  id: string;
  userId: string;
  marketplace: Marketplace;
  connectionType: ConnectionType;  // one marketplace may have both (e.g. eBay oauth_api + extension)
  accountLabel: string | null;
  status: ConnectionStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
}
export type NewConnection = Omit<MarketplaceConnection, "id" | "userId" | "createdAt">;

export type SyncEvent =
  | "sale_detected" | "sale_duplicate" | "listing_ended" | "delist_requested" | "delist_done" | "delist_failed"
  | "listing_created" | "connection_connected" | "connection_failed" | "sync_started" | "sync_finished" | "sync_failed"
  | "legacy_import" | "other";

export interface SyncLogEntry {
  id: string;
  userId: string;
  marketplace: Marketplace | null;
  itemId: string | null;
  source: Source | null;           // which detection path produced this event
  event: SyncEvent;
  level: "info" | "warn" | "error";
  detail: string | null;
  createdAt: string;
}
export type NewSyncLogEntry = Omit<SyncLogEntry, "id" | "userId" | "createdAt">;

export type CreditAction = "bg_removal" | "description" | "listing_create";
export type CreditKind = "reset" | "spend" | "grant";

export interface CreditEntry {
  id: string;
  userId: string;
  kind: CreditKind;
  action: CreditAction | null;
  amount: number;                  // positive adds, negative spends
  period: string | null;           // YYYY-MM for resets
  note: string | null;
  createdAt: string;
}

// Placeholder numbers. Single-user for now; real plan pricing is a later decision.
export const PLAN_ALLOWANCE: Record<Plan, number> = { free: 25, starter: 150, pro: 600 };
export const CREDIT_COSTS: Record<CreditAction, number> = { bg_removal: 1, description: 1, listing_create: 3 };

export class InsufficientCreditsError extends Error {
  constructor(public balance: number, public cost: number) {
    super(`Insufficient credits: have ${balance}, need ${cost}`);
  }
}

// ---------------------------------------------------------------- job queue (spec: job-queue-extension-spec.md sections 2, 3A, 6, 6A)

/** Thrown when a table or function from migration 0005 is missing (David has not run the SQL yet). Pages degrade instead of crashing. */
export class SchemaMissingError extends Error {
  constructor(what = "job queue tables") {
    super(`Not set up yet: ${what} (run migration 0005 in Supabase)`);
    this.name = "SchemaMissingError";
  }
}

export type JobType = "create_listing" | "update_listing" | "delist" | "mark_sold" | "sync_status";
export const JOB_TYPES: JobType[] = ["create_listing", "update_listing", "delist", "mark_sold", "sync_status"];
export type JobExecutor = "api" | "extension";
export const JOB_EXECUTORS: JobExecutor[] = ["api", "extension"];
export type JobStatus = "queued" | "claimed" | "running" | "succeeded" | "retry_wait" | "failed" | "needs_user" | "canceled";
export const JOB_STATUSES: JobStatus[] = ["queued", "claimed", "running", "succeeded", "retry_wait", "failed", "needs_user", "canceled"];

export interface Job {
  id: string;
  userId: string;
  itemId: string | null;
  listingId: string | null;
  marketplace: Marketplace;
  jobType: JobType;
  executor: JobExecutor;
  status: JobStatus;
  priority: number;                 // lower runs first
  payload: Record<string, unknown>;
  idempotencyKey: string | null;
  attempts: number;                 // counted when a worker claims the job
  maxAttempts: number;
  nextRunAt: string;
  leaseExpiresAt: string | null;
  claimedByDevice: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface NewJob {
  marketplace: Marketplace;
  jobType: JobType;
  executor: JobExecutor;
  itemId?: string | null;
  listingId?: string | null;
  payload?: Record<string, unknown>;
  idempotencyKey?: string | null;
  /** Defaults from the job type (delist / mark_sold first). */
  priority?: number;
  maxAttempts?: number;
  nextRunAt?: string;
}

export interface JobEvent {
  id: string;
  jobId: string;
  userId: string;
  at: string;
  fromStatus: JobStatus | null;
  toStatus: JobStatus;
  message: string | null;
}

/** What a worker reports for a job it ran. */
export type JobOutcome =
  | { kind: "success"; result?: Record<string, unknown> }
  | { kind: "transient"; code: string; message: string }   // timeout, 5xx, rate limit: retried with backoff
  | { kind: "hard"; code: string; message: string }        // rejected / validation: failed at once
  | { kind: "needs_user"; code: string; message: string }; // captcha, signed out, challenge: waits for the user

export interface ExtensionDevice {
  id: string;
  userId: string;
  label: string;
  extensionVersion: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  lastPollAt: string | null;
  lastIpCountry: string | null;
  revokedAt: string | null;
  paused: boolean;
}
export interface NewDevice { label: string; tokenHash: string }
export interface HeartbeatInput {
  extensionVersion?: string;
  /** Per-marketplace "signed in" yes/no as the extension sees it. Nothing else leaves the browser. */
  marketplaces?: Partial<Record<Marketplace, boolean>>;
  ipCountry?: string | null;
  /** Poll heartbeat (true, default) also stamps last_poll_at. */
  poll?: boolean;
  now?: Date;
}
export interface MarketplaceLoginState { deviceId: string; marketplace: Marketplace; loggedIn: boolean; checkedAt: string }

export interface ScanCursor {
  id: string;
  userId: string;
  marketplace: Marketplace;
  scopeKey: string;                 // connection id for API marketplaces, "device:<id>" for the extension
  cursor: string | null;
  lastScannedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export type ItemSyncEvent =
  | "listed" | "delisted" | "marked_sold" | "sale_detected" | "sale_unmatched" | "sale_cancelled"
  | "delist_queued" | "delist_failed" | "relisted" | "linked" | "reconciled" | "needs_action_ignored" | "job_failed";
export type ItemSyncSource = "api" | "extension" | "reconcile" | "manual";
export interface ItemSyncLogEntry {
  id: string;
  userId: string;
  itemId: string | null;
  listingId: string | null;
  marketplace: Marketplace | null;
  at: string;
  event: ItemSyncEvent;
  source: ItemSyncSource;
  jobId: string | null;
  detail: string | null;
  /** Stable reference such as "sale:<id>", used to ignore a needs-action entry. */
  ref: string | null;
}
export type NewItemSyncLogEntry = Partial<Omit<ItemSyncLogEntry, "id" | "userId" | "at">> & { event: ItemSyncEvent; source: ItemSyncSource };

export interface WorkerRun { leasesExpired: number; requeued: number; ranAt: string }

/** One row of the "Sold but still listed" queue (spec 6A). Computed from data, so it empties itself when the delist is confirmed. */
export type NeedsActionKind = "sold_still_listed" | "delist_failed" | "delist_stuck" | "unmatched_sale" | "sale_cancelled";
export type NeedsActionButton = "retry" | "open_listing" | "mark_delisted" | "ignore";
export interface NeedsActionEntry {
  key: string;                      // stable; what "Ignore" stores
  kind: NeedsActionKind;
  itemId: string | null;
  sku: string | null;
  title: string | null;
  marketplace: Marketplace | null;
  listingId: string | null;
  jobId: string | null;
  url: string | null;
  since: string;                    // ISO time the problem started
  overdueMs: number;
  message: string;
  actions: NeedsActionButton[];
}
