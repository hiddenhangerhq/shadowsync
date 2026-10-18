-- Row Level Security: every row is visible/writable only by its owner.
alter table profiles enable row level security;
alter table items enable row level security;
alter table item_photos enable row level security;
alter table marketplace_connections enable row level security;
alter table listings enable row level security;
alter table sales enable row level security;
alter table sync_log enable row level security;
alter table credit_ledger enable row level security;

create policy profiles_select on profiles for select using (id = auth.uid());
-- Users may edit display_name/theme but NOT plan (plan changes come from billing, server side).
create policy profiles_update on profiles for update using (id = auth.uid()) with check (id = auth.uid());
revoke update on profiles from authenticated;
grant update (display_name, theme) on profiles to authenticated;

create policy items_all on items for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy photos_all on item_photos for all using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from items i where i.id = item_id and i.user_id = auth.uid()));
create policy conn_all on marketplace_connections for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy listings_all on listings for all using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from items i where i.id = item_id and i.user_id = auth.uid()));
create policy sales_all on sales for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy synclog_all on sync_log for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Credit ledger: users can only READ. All writes go through the SECURITY DEFINER functions
-- ensure_monthly_allowance() and spend_credits(), or the service role (grants). Rows are immutable.
create policy credit_select on credit_ledger for select using (user_id = auth.uid());
revoke insert, update, delete on credit_ledger from authenticated, anon;
