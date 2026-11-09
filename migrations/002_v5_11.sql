-- v5.11 — run this ONLY when upgrading an existing v5.10 database.
-- (A brand-new deploy uses schema_fresh.sql, which already contains this.)
-- Safe to run more than once.

ALTER TABLE dsr_settlements ADD COLUMN IF NOT EXISTS received_by_id   TEXT DEFAULT '';
ALTER TABLE dsr_settlements ADD COLUMN IF NOT EXISTS received_by_name TEXT DEFAULT '';
ALTER TABLE dsr_settlements ADD COLUMN IF NOT EXISTS received_by_role TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_settle_recv ON dsr_settlements(received_by_role, received_by_id, date);

-- Settlements saved before this version have no collector recorded. They stay
-- as they are (counted nowhere in the manager total) — only new settlements
-- are attributed to the manager who took the cash.
