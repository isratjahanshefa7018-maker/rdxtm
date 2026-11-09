-- v5.18.1 performance helpers. Safe to run more than once. The app works without it (it falls back).
-- Run in the Supabase SQL editor.

-- All-time cash received from one or more DSRs, summed in the database instead of in JavaScript.
CREATE OR REPLACE FUNCTION dsr_received_total(p_ids TEXT[])
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(cash_received), 0) FROM dsr_settlements WHERE dsr_id::text = ANY(p_ids);
$$;
GRANT EXECUTE ON FUNCTION dsr_received_total(TEXT[]) TO service_role;

-- Indexes for the date-range lookups the screens run most. IF NOT EXISTS keeps this re-runnable.
CREATE INDEX IF NOT EXISTS idx_tx_date_type    ON transactions (date, type);
CREATE INDEX IF NOT EXISTS idx_tx_sr_date      ON transactions (sr_id, date);
CREATE INDEX IF NOT EXISTS idx_dsr_stl_dsr_date ON dsr_settlements (dsr_id, date);
CREATE INDEX IF NOT EXISTS idx_due_cal_dsr_due ON due_calendar (dsr_id, due_date);
CREATE INDEX IF NOT EXISTS idx_due_col_dsr_date ON due_collections (dsr_id, date);
