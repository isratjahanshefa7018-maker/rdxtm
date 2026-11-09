-- v5.21 — due collection by ANY role, credited to the shop's own DSR.
-- Supabase → SQL editor → run once (safe to run twice). The app keeps working without it
-- (collections are still saved), but the "collected by" / "credited to" detail needs these columns.
alter table due_collections add column if not exists credit_dsr_id   text default '';
alter table due_collections add column if not exists credit_dsr_name text default '';
alter table due_collections add column if not exists collector_id    text default '';
alter table due_collections add column if not exists collector_name  text default '';
alter table due_collections add column if not exists collector_role  text default '';
create index if not exists due_collections_credit_idx on due_collections (credit_dsr_id, date);
