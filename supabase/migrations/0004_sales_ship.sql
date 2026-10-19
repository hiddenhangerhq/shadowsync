-- Ship queue: each sale carries the SKU (and title) of what was sold, an optional ship-by deadline,
-- and a shipped date (null = still to ship). Existing rows stay "to ship" until marked, so legacy imports
-- should set shipped_at when they bring in already-shipped sales.
alter table sales add column if not exists sku text;
alter table sales add column if not exists title text;
alter table sales add column if not exists ship_by date;
alter table sales add column if not exists shipped_at date;
create index if not exists sales_to_ship_idx on sales (user_id, ship_by) where shipped_at is null;
