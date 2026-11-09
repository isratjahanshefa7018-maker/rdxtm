-- v5.25 — OPTIONAL. The app works without this file (offer lines are then kept in the settings store).
-- Run it once in the Supabase SQL editor to keep the company-offer snapshot on the transaction rows themselves.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS offer_case_price         NUMERIC(14,4);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS offer_deduction_per_case NUMERIC(14,4);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS offer_deduction_total    NUMERIC(14,4);
