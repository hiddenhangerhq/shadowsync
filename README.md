# Shadow Sync (web)

Next.js (App Router, TypeScript) app for resellers: items (Draft / Listed / Sold), photo upload from the phone camera,
Mission Control dashboard, sales tracking, and (later) plan-based AI credits. Installable on a phone home screen (PWA).

**Build step 1 = foundation.** Overview is a placeholder; the dashboard port, sale detection and AI credits spending come later.
The existing Apps Script dashboard is untouched and keeps running.

## Run it (no accounts needed)

```bash
npm install
cp .env.example .env.local     # DATA_BACKEND=mock by default
npm run dev                    # http://localhost:3000, sign up with any email + 8+ char password
npm test                       # data-layer contract, themes, sales logic
npm run build && npm start
```

Mock mode stores everything in `.data/` (gitignored): `db.json` plus uploaded photos. New mock accounts get a few demo items
(set `MOCK_SEED=0` to disable).

## Env vars (`.env.example`)

| Var | Needed for | Notes |
|---|---|---|
| `DATA_BACKEND` | always | `mock` (default) or `supabase` |
| `MOCK_DATA_DIR`, `MOCK_SEED` | mock | local db + photos folder, demo data |
| `NEXT_PUBLIC_SUPABASE_URL` | supabase | project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | supabase | public anon key (safe in browser, protected by RLS) |
| `SUPABASE_SERVICE_ROLE_KEY` | later | server only, never in the browser; unused in step 1 |
| `SUPABASE_PHOTO_BUCKET` | supabase | default `item-photos` |

No secrets are committed. `.env*` is gitignored except `.env.example`.

## Architecture

```
src/lib/data/
  types.ts           domain types (Item, Sale, Listing, ... ThemeId, Source, ConnectionType)
  interfaces.ts      DataStore, AuthService, StorageService  <- the ONLY surface the app uses
  mock.ts            local-file implementation (default)
  supabase-impl.ts   Supabase implementation. The only file importing @supabase/* (a test enforces this)
  index.ts           getServices(): picks the backend from DATA_BACKEND
src/lib/sales/       shared TypeScript port of the Dashboard.gs logic (pure, tested; reused in step 2)
src/lib/theme.ts     theme ids, no-flash inline script
src/proxy.ts         redirects signed-out users to /login (Next 16 "proxy", formerly middleware)
supabase/migrations/ SQL schema, RLS, storage bucket
```

Moving to Firebase later = write `firebase-impl.ts` implementing the same three interfaces and register it in `index.ts`.
Pages never import a vendor SDK.

### Data model
`profiles` (plan, theme), `items` (draft/listed/sold/delisted; SKU, title, COGS, purchase location, date listed/sold, price sold,
platform, fees, promo, ship provider/cost, ...), `item_photos`, `marketplace_connections`, `listings`, `sales`, `sync_log`,
`credit_ledger`. Every table has `user_id` with Row Level Security (owner only) so multi-user needs no redesign.
Credit writes go through SECURITY DEFINER functions (`spend_credits`, `ensure_monthly_allowance`); users cannot write the ledger directly.

### How sales get detected (design)
- `sales`, `listings`, `items` carry `source`: `api` | `extension` | `manual` for the product, plus `sheet-import` and `email`,
  which are **private legacy imports of the owner's existing data only** (Google Sheet, old Gmail parsing).
  **Shadow Sync never reads anyone's email**, and there is no email connection option.
- `marketplace_connections.connection_type` is only `oauth_api` (the marketplace's own consent screen; we never store marketplace
  passwords) or `extension` (Chrome extension in the user's own logged-in browser). One marketplace can have both.
- The same sale arriving twice (same marketplace + order id) is stored once; the higher-trust source wins (api > extension > manual > sheet-import > email).
- `sync_log` records detection events and failures (sale detected, duplicate, delist done/failed, sync failed, ...), with the source and level.

### Themes
CSS variables (design tokens) on `<html data-theme>`. System (default) follows `prefers-color-scheme`; Light, Dark, Cyberpunk,
Retro Gaming, Midnight Blue, Forest, Sunset. Saved to `profiles.theme` and localStorage; an inline script in `<head>` sets it before paint.
Components use tokens only (a test fails on hard-coded colors). Marketplace brand colors are data, always drawn with a ring in the text color.

### Photos
Two inputs: "Take photo" (`capture="environment"`, one shot at a time) and "Choose photos" (multi-select). Phones ignore `multiple` when
`capture` is set, so one input cannot do both. Images are resized to 1600px and compressed to JPEG in the browser before upload;
stored through `StorageService` (Supabase Storage bucket `item-photos`, private, per-user folders; local folder in mock mode).

## Going live (not done yet)

1. Create a free Supabase project. Run `supabase/migrations/*.sql` in order (SQL editor, or `supabase db push` with the CLI).
   In Auth settings choose whether email confirmation is required.
2. Set `DATA_BACKEND=supabase`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` in Vercel project env vars.
3. Import the repo into Vercel (free Hobby tier) or deploy with `vercel --prod` using a token.
4. Run the data-layer contract tests against a Supabase test project (add it to `tests/helpers.ts` `backends`) before trusting the Supabase implementation:
   it type-checks but has not been run against a real project yet.

## Job queue (build step: queue, no marketplace calls)
- Migration `supabase/migrations/0005_jobs.sql` (also `/workspace/shadowsync-setup-0005.sql`, one paste for the Supabase SQL editor, re-runnable). Run it BEFORE deploying: until then `/jobs`, Mission Control and item pages degrade to "Job queue not set up yet".
- Pure rules live in `src/lib/jobs/` (state machine, sale detection, needs-action, health, validation). Both data stores obey them.
- Dashboard API: `/api/v1/jobs`, `/api/v1/jobs/:id` (+ `/retry`, `/cancel`), `/api/v1/needs-action`, `/api/v1/items/:id/sync-log`, `/api/v1/extension/status`.
- Worker: `GET|POST /api/cron/worker` with `Authorization: Bearer $CRON_SECRET`. Vercel Hobby only allows daily crons, so no schedule is configured in `vercel.json`.
- Tests: `npm test` (mock + in-process Postgres for the real SQL). Real Supabase run: `RUN_SUPABASE=1 npm test` on **Node 22+** (the job-queue half skips itself until 0005 is applied).

## Browser extension (Chrome and Edge)
Code in `extension/` (MV3, one build for both browsers). The product name lives only in `extension/src/brand.ts` (manifest, popup, and the marked names in this README are filled from it by `npm run build:extension`). The icon is `extension/icon.svg`; re-render the PNGs with `node extension/render-icons.mjs`. Real actions exist for **Poshmark only**; other marketplaces say "not supported yet".
It needs migration `0006_extension.sql` (also `/workspace/shadowsync-setup-0006.sql`) on Supabase before pairing works.

Build it: `npm run build:extension` (optional `SHADOWSYNC_API_ORIGIN=https://your-site.example`, default `https://shadowsync-ruby.vercel.app`).
Output: the folder `extension/dist` and the zip `/workspace/shadowsync-extension.zip`. It is not on the Chrome Web Store.

### Install it (no technical knowledge needed)
1. Unzip `shadowsync-extension.zip` into a folder you will keep (for example "Documents/<!--brand-->Shadow Sync<!--/brand--> extension"). Don't delete that folder later: the browser loads the extension from it.
2. Open your browser's extensions page:
   - **Chrome:** type `chrome://extensions` in the address bar and press Enter.
   - **Edge:** type `edge://extensions` in the address bar and press Enter.
3. Turn on **Developer mode** (a switch at the top right in Chrome, on the left side in Edge).
4. Click **Load unpacked** and choose the folder from step 1 (the one that contains `manifest.json`).
5. Click the puzzle-piece icon in the toolbar and pin **<!--extname-->Shadow Sync Crosslist Extension<!--/extname-->** so its icon (two arrows on a green square) stays visible.
6. Click the <!--brand-->Shadow Sync<!--/brand--> icon, then **Open the pairing page**. Sign in to <!--brand-->Shadow Sync<!--/brand--> if asked and press **Pair this browser**. (Or open Settings > Extension yourself, press Pair, and type the code shown into the popup.)
7. In the popup, press **Connect** next to Poshmark and allow the permission the browser asks for (it covers poshmark.com only). Make sure you are signed in to Poshmark in this same browser.
8. To update later: replace the folder's contents with the new zip, then press the circular **Reload** arrow on the <!--extname-->Shadow Sync Crosslist Extension<!--/extname--> card in the extensions page.

When an item sells (a confirmed, matched sale), the extension **deletes** its other listings on those marketplaces (Settings > Extension can switch a marketplace to "Not For Sale" instead). If a delete is blocked, it sets Not For Sale and the item shows under **Sold but still active**. Nothing is ever deleted inside <!--brand-->Shadow Sync<!--/brand-->, and a Sold item can't be listed again until you undo the sale.

To stop everything at once: **Pause all** in the popup, or Pause in Settings > Extension. To remove it: Remove it in Settings > Extension, then click **Remove** on the extensions page.
