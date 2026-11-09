-- AXIION DMS v5.1 — UPGRADE for an EXISTING, LIVE database.
-- Safe to run more than once. It never drops a table and never deletes data.
-- BEFORE running: export your data (Supabase → Table editor → Export, or pg_dump).
-- Run the whole file once in the Supabase SQL editor.
-- ═════════════════════════════════════════════════════════════════
-- v5.1 — accuracy + speed fixes   (every statement is idempotent:
-- CREATE ... IF NOT EXISTS / CREATE OR REPLACE / ADD COLUMN IF NOT EXISTS)
-- ═════════════════════════════════════════════════════════════════

-- ── CALC-6: damage claims keep 4 decimals (was 2) ──
ALTER TABLE dmg_claims
  ALTER COLUMN total_units    TYPE NUMERIC(14,4),
  ALTER COLUMN purchase_price TYPE NUMERIC(14,4),
  ALTER COLUMN total_cost     TYPE NUMERIC(14,4);

-- ── CALC-3: every sale row remembers the bonus rule of THAT day ──
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS rule_case_size        NUMERIC(10,2);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS rule_bonus_cases_req  NUMERIC(10,2);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS rule_bonus_free_units NUMERIC(14,4);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS rule_bonus_free_money NUMERIC(14,4);

-- ── Owner switches (Settings page) ──
-- block_negative_stock : refuse give / point-sale / return-to-company when stock is short (CALC-9)
-- profit_rules         : which items reduce NET profit (CALC-1)
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS block_negative_stock BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS profit_rules JSONB NOT NULL
  DEFAULT '{"commission":true,"discount":true,"damage":true,"bonus":true,"expenses":true}'::jsonb;

-- ── CALC-7: audit trail for due edits / deletes ──
CREATE TABLE IF NOT EXISTS audit_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  at         TIMESTAMPTZ DEFAULT NOW(),
  actor_id   TEXT DEFAULT '',
  actor_role TEXT DEFAULT '',
  action     TEXT DEFAULT '',
  table_name TEXT DEFAULT '',
  row_id     TEXT DEFAULT '',
  old_data   JSONB,
  new_data   JSONB
);
CREATE INDEX IF NOT EXISTS idx_audit_at  ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_row ON audit_log(table_name, row_id);

-- ── CALC-8: double-tap / retry protection ──
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        TEXT PRIMARY KEY,
  response   JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_idem_created ON idempotency_keys(created_at);

-- ── PERF-8: did last night's report job run? ──
CREATE TABLE IF NOT EXISTS cron_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at      TIMESTAMPTZ DEFAULT NOW(),
  report_date DATE,
  ok_count    INT DEFAULT 0,
  fail_count  INT DEFAULT 0,
  details     JSONB
);

DO $$ BEGIN
  ALTER TABLE audit_log        ENABLE ROW LEVEL SECURITY;
  ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
  ALTER TABLE cron_runs        ENABLE ROW LEVEL SECURITY;
END $$;
DO $$ BEGIN CREATE POLICY "srv_audit_log"        ON audit_log        FOR ALL TO service_role USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "srv_idempotency_keys" ON idempotency_keys FOR ALL TO service_role USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "srv_cron_runs"        ON cron_runs        FOR ALL TO service_role USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon_deny_audit_log"        ON audit_log        FOR ALL TO anon USING (false); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon_deny_idempotency_keys" ON idempotency_keys FOR ALL TO anon USING (false); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon_deny_cron_runs"        ON cron_runs        FOR ALL TO anon USING (false); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── CALC-9: stock can never go negative (race-proof; switch in app_settings) ──
CREATE OR REPLACE FUNCTION apply_stock_delta() RETURNS TRIGGER AS $$
DECLARE
  delta NUMERIC(14,4);
  guard BOOLEAN;
BEGIN
  delta := CASE NEW.type
    WHEN 'buy'                  THEN  NEW.total_units
    WHEN 'give'                 THEN -NEW.total_units
    WHEN 'return'               THEN  NEW.total_units
    WHEN 'point_sale'           THEN -NEW.total_units
    WHEN 'point_damage_return'  THEN  NEW.total_units
    WHEN 'return_company'       THEN -NEW.total_units
    ELSE 0
  END;
  IF delta <> 0 AND NEW.product_id IS NOT NULL AND NEW.product_id <> '' THEN
    guard := COALESCE((SELECT block_negative_stock FROM app_settings WHERE id = 1), TRUE);
    IF delta < 0 AND guard THEN
      UPDATE products SET current_stock = current_stock + delta
        WHERE id::text = NEW.product_id AND current_stock + delta >= 0;
      IF NOT FOUND AND EXISTS (SELECT 1 FROM products WHERE id::text = NEW.product_id) THEN
        RAISE EXCEPTION 'STOCK_NEGATIVE: not enough stock for product %', NEW.product_id;
      END IF;
    ELSE
      UPDATE products SET current_stock = current_stock + delta WHERE id::text = NEW.product_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_apply_stock_delta ON transactions;
CREATE TRIGGER trg_apply_stock_delta
  AFTER INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION apply_stock_delta();

-- ── indexes (PERF-1 / PERF-4) ──
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_due_open          ON due_calendar(due_date) WHERE status <> 'cleared';
CREATE INDEX IF NOT EXISTS idx_due_open_shop     ON due_calendar(shop_id)  WHERE status <> 'cleared';
CREATE INDEX IF NOT EXISTS idx_shops_name_trgm   ON shops USING gin (name        gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_shops_phone_trgm  ON shops USING gin (phone       gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_shops_keeper_trgm ON shops USING gin (keeper_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_tx_sr_date        ON transactions(sr_id, date);
CREATE INDEX IF NOT EXISTS idx_dmg_date          ON dmg_claims(date);
CREATE INDEX IF NOT EXISTS idx_gcm_created_desc  ON group_chat_messages(created_at DESC);

-- ═════════ SQL functions (PERF-3: sums happen inside Postgres) ═════════

-- revenue / cost / pieces: out = give + point_sale, in = return + point_damage_return
CREATE OR REPLACE FUNCTION sales_summary(p_from DATE, p_to DATE)
RETURNS TABLE (out_rev NUMERIC, in_rev NUMERIC, out_cost NUMERIC, in_cost NUMERIC, out_units NUMERIC, in_units NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE(SUM(CASE WHEN t.type IN ('give','point_sale') THEN t.total_revenue END), 0),
    COALESCE(SUM(CASE WHEN t.type IN ('return','point_damage_return') THEN t.total_revenue END), 0),
    COALESCE(SUM(CASE WHEN t.type IN ('give','point_sale') THEN t.total_cost END), 0),
    COALESCE(SUM(CASE WHEN t.type IN ('return','point_damage_return') THEN t.total_cost END), 0),
    COALESCE(SUM(CASE WHEN t.type IN ('give','point_sale') THEN t.total_units END), 0),
    COALESCE(SUM(CASE WHEN t.type IN ('return','point_damage_return') THEN t.total_units END), 0)
  FROM transactions t
  WHERE t.date BETWEEN p_from AND p_to
    AND t.type IN ('give','return','point_sale','point_damage_return');
$$;
GRANT EXECUTE ON FUNCTION sales_summary(DATE, DATE) TO service_role;

-- the deductions of NET profit (CALC-1)
CREATE OR REPLACE FUNCTION profit_extras(p_from DATE, p_to DATE)
RETURNS TABLE (commission NUMERIC, discount NUMERIC, damage_loss NUMERIC, expenses NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT
    (SELECT COALESCE(SUM(p.commission_amt), 0) FROM sr_payments p WHERE p.date BETWEEN p_from AND p_to),
    (SELECT COALESCE(SUM(p.discount_amt),   0) FROM sr_payments p WHERE p.date BETWEEN p_from AND p_to),
    (SELECT COALESCE(SUM(c.total_cost),     0) FROM dmg_claims  c WHERE c.date BETWEEN p_from AND p_to),
    (SELECT COALESCE(SUM(e.amount),         0) FROM exp_records e WHERE e.date BETWEEN p_from AND p_to);
$$;
GRANT EXECUTE ON FUNCTION profit_extras(DATE, DATE) TO service_role;

-- net pieces per product + the bonus rule that was valid on each row (CALC-3)
CREATE OR REPLACE FUNCTION bonus_net_units(p_from DATE, p_to DATE)
RETURNS TABLE (product_id TEXT, case_size NUMERIC, bonus_cases_req NUMERIC, bonus_free_units NUMERIC,
               bonus_free_money NUMERIC, net_units NUMERIC, out_units NUMERIC, out_cost NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT t.product_id, t.rule_case_size, t.rule_bonus_cases_req, t.rule_bonus_free_units, t.rule_bonus_free_money,
         SUM(CASE WHEN t.type IN ('give','point_sale') THEN t.total_units ELSE -t.total_units END),
         SUM(CASE WHEN t.type IN ('give','point_sale') THEN t.total_units ELSE 0 END),
         SUM(CASE WHEN t.type IN ('give','point_sale') THEN t.total_cost  ELSE 0 END)
    FROM transactions t
   WHERE t.date BETWEEN p_from AND p_to
     AND t.type IN ('give','return','point_sale','point_damage_return')
   GROUP BY 1, 2, 3, 4, 5;
$$;
GRANT EXECUTE ON FUNCTION bonus_net_units(DATE, DATE) TO service_role;

-- per SR totals for a date range
CREATE OR REPLACE FUNCTION sr_sales_totals(p_from DATE, p_to DATE)
RETURNS TABLE (sr_id TEXT, out_rev NUMERIC, in_rev NUMERIC, out_units NUMERIC, in_units NUMERIC,
               give_rev NUMERIC, give_units NUMERIC, ret_rev NUMERIC, ret_units NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT t.sr_id,
    COALESCE(SUM(CASE WHEN t.type IN ('give','point_sale') THEN t.total_revenue END), 0),
    COALESCE(SUM(CASE WHEN t.type IN ('return','point_damage_return') THEN t.total_revenue END), 0),
    COALESCE(SUM(CASE WHEN t.type IN ('give','point_sale') THEN t.total_units END), 0),
    COALESCE(SUM(CASE WHEN t.type IN ('return','point_damage_return') THEN t.total_units END), 0),
    COALESCE(SUM(CASE WHEN t.type = 'give'   THEN t.total_revenue END), 0),
    COALESCE(SUM(CASE WHEN t.type = 'give'   THEN t.total_units   END), 0),
    COALESCE(SUM(CASE WHEN t.type = 'return' THEN t.total_revenue END), 0),
    COALESCE(SUM(CASE WHEN t.type = 'return' THEN t.total_units   END), 0)
  FROM transactions t
  WHERE t.date BETWEEN p_from AND p_to AND t.sr_id <> ''
    AND t.type IN ('give','return','point_sale','point_damage_return')
  GROUP BY t.sr_id;
$$;
GRANT EXECUTE ON FUNCTION sr_sales_totals(DATE, DATE) TO service_role;

-- net pieces per product for a date range
CREATE OR REPLACE FUNCTION product_sales_totals(p_from DATE, p_to DATE)
RETURNS TABLE (product_id TEXT, net_units NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT t.product_id,
         SUM(CASE WHEN t.type IN ('give','point_sale') THEN t.total_units ELSE -t.total_units END)
    FROM transactions t
   WHERE t.date BETWEEN p_from AND p_to
     AND t.type IN ('give','return','point_sale','point_damage_return')
   GROUP BY t.product_id;
$$;
GRANT EXECUTE ON FUNCTION product_sales_totals(DATE, DATE) TO service_role;

CREATE OR REPLACE FUNCTION payments_total(p_from DATE, p_to DATE)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(p.amount), 0) FROM sr_payments p WHERE p.date BETWEEN p_from AND p_to;
$$;
GRANT EXECUTE ON FUNCTION payments_total(DATE, DATE) TO service_role;

-- warehouse movement of ONE day per product (yesterday's closing stock)
CREATE OR REPLACE FUNCTION stock_movement(p_date DATE)
RETURNS TABLE (product_id TEXT, delta NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT t.product_id,
         SUM(CASE t.type WHEN 'buy' THEN t.total_units WHEN 'return' THEN t.total_units
                         WHEN 'point_damage_return' THEN t.total_units ELSE -t.total_units END)
    FROM transactions t
   WHERE t.date = p_date AND t.type IN ('buy','give','return','point_sale','point_damage_return','return_company')
   GROUP BY t.product_id;
$$;
GRANT EXECUTE ON FUNCTION stock_movement(DATE) TO service_role;

-- period due + cumulative due, OPEN rows only (PERF-4)
CREATE OR REPLACE FUNCTION period_due(p_from DATE, p_to DATE)
RETURNS TABLE (period_due NUMERIC, cumulative_due NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE(SUM(CASE WHEN d.due_date >= p_from THEN d.amount - d.paid_amount END), 0),
    COALESCE(SUM(d.amount - d.paid_amount), 0)
  FROM due_calendar d
  WHERE d.status <> 'cleared' AND d.due_date <= p_to AND d.amount - d.paid_amount > 0;
$$;
GRANT EXECUTE ON FUNCTION period_due(DATE, DATE) TO service_role;

-- open shop due per shop (optionally for some shops / one DSR)
CREATE OR REPLACE FUNCTION shop_due_totals(p_shop_ids TEXT[] DEFAULT NULL, p_dsr_id TEXT DEFAULT NULL)
RETURNS TABLE (shop_id TEXT, due NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT d.shop_id, SUM(GREATEST(0, d.amount - d.paid_amount))
    FROM due_calendar d
   WHERE d.client_type = 'shop' AND d.status <> 'cleared'
     AND (p_shop_ids IS NULL OR d.shop_id = ANY (p_shop_ids))
     AND (p_dsr_id   IS NULL OR p_dsr_id = '' OR d.dsr_id = p_dsr_id)
   GROUP BY d.shop_id;
$$;
GRANT EXECUTE ON FUNCTION shop_due_totals(TEXT[], TEXT) TO service_role;

-- shop buying totals for the "top shops" card
CREATE OR REPLACE FUNCTION shop_buying_totals(p_from DATE, p_to DATE)
RETURNS TABLE (shop_id TEXT, buy NUMERIC, orders BIGINT, last_buy DATE)
LANGUAGE sql STABLE AS $$
  SELECT t.shop_id,
         SUM(CASE WHEN t.type = 'point_damage_return' THEN -t.total_revenue ELSE t.total_revenue END),
         COUNT(DISTINCT CASE WHEN t.type <> 'point_damage_return' THEN t.tx_id END),
         MAX(CASE WHEN t.type <> 'point_damage_return' THEN t.date END)
    FROM transactions t
   WHERE t.shop_id <> '' AND t.type IN ('dsr_sale','point_sale','point_damage_return')
     AND t.date BETWEEN p_from AND p_to
   GROUP BY t.shop_id;
$$;
GRANT EXECUTE ON FUNCTION shop_buying_totals(DATE, DATE) TO service_role;

-- What is on ONE DSR's van, CARRIED OVER across days (CALC-2).
--   given − returned − sold-to-shops − damage − damage-exchange replacements, all days up to p_upto.
-- Damage-collection claims (tx_id 'dc:…') came from a shop, not the van, so they are ignored.
CREATE OR REPLACE FUNCTION van_stock_totals(p_dsr_id TEXT, p_upto DATE, p_all_damage BOOLEAN DEFAULT FALSE)
RETURNS TABLE (product_id TEXT, qty NUMERIC, give_units NUMERIC, give_rev NUMERIC)
LANGUAGE sql STABLE AS $$
  WITH t AS (
    SELECT tx.product_id,
           SUM(CASE WHEN tx.type = 'give' THEN tx.total_units ELSE -tx.total_units END) AS q,
           SUM(CASE WHEN tx.type = 'give' THEN tx.total_units   ELSE 0 END) AS gu,
           SUM(CASE WHEN tx.type = 'give' THEN tx.total_revenue ELSE 0 END) AS gr
      FROM transactions tx
     WHERE tx.sr_id = p_dsr_id AND tx.date <= p_upto AND tx.type IN ('give','return','dsr_sale')
     GROUP BY tx.product_id
  ), d AS (
    SELECT c.product_id, SUM(c.total_units) AS q
      FROM dmg_claims c
     WHERE c.sr_id = p_dsr_id AND c.date <= p_upto
       AND COALESCE(c.tx_id, '') NOT LIKE 'dc:%'
       AND (p_all_damage OR c.status = 'cleared')
     GROUP BY c.product_id
  ), e AS (
    SELECT x.exch_product_id AS product_id, SUM(x.exch_units) AS q
      FROM damage_collections x
     WHERE x.dsr_id = p_dsr_id AND x.date <= p_upto AND x.resolution = 'exchange' AND x.exch_product_id <> ''
     GROUP BY x.exch_product_id
  )
  SELECT t.product_id, GREATEST(0, t.q - COALESCE(d.q, 0) - COALESCE(e.q, 0)), t.gu, t.gr
    FROM t LEFT JOIN d ON d.product_id = t.product_id LEFT JOIN e ON e.product_id = t.product_id;
$$;
GRANT EXECUTE ON FUNCTION van_stock_totals(TEXT, DATE, BOOLEAN) TO service_role;

-- CALC-7: sale rows + due row + visit are written in ONE transaction
CREATE OR REPLACE FUNCTION create_shop_sale(p_rows JSONB, p_due JSONB, p_visit JSONB)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_due due_calendar%ROWTYPE;
  v_has BOOLEAN := FALSE;
BEGIN
  INSERT INTO transactions (tx_id, type, sr_id, sr_name, date, slip_no, product_id, product_name, sku,
      cases, pcs, total_units, purchase_price, selling_price, total_cost, total_revenue,
      commission_amt, discount_amt, shop_id, customer_id, note, created_at,
      rule_case_size, rule_bonus_cases_req, rule_bonus_free_units, rule_bonus_free_money)
  SELECT (r->>'tx_id')::uuid, r->>'type', COALESCE(r->>'sr_id',''), COALESCE(r->>'sr_name',''),
         (r->>'date')::date, COALESCE(r->>'slip_no',''), r->>'product_id', COALESCE(r->>'product_name',''), COALESCE(r->>'sku',''),
         COALESCE((r->>'cases')::numeric,0), COALESCE((r->>'pcs')::numeric,0), COALESCE((r->>'total_units')::numeric,0),
         COALESCE((r->>'purchase_price')::numeric,0), COALESCE((r->>'selling_price')::numeric,0),
         COALESCE((r->>'total_cost')::numeric,0), COALESCE((r->>'total_revenue')::numeric,0),
         COALESCE((r->>'commission_amt')::numeric,0), COALESCE((r->>'discount_amt')::numeric,0),
         COALESCE(r->>'shop_id',''), COALESCE(r->>'customer_id',''), COALESCE(r->>'note',''),
         COALESCE((r->>'created_at')::timestamptz, NOW()),
         (r->>'rule_case_size')::numeric, (r->>'rule_bonus_cases_req')::numeric,
         (r->>'rule_bonus_free_units')::numeric, (r->>'rule_bonus_free_money')::numeric
    FROM jsonb_array_elements(p_rows) AS r;

  IF p_due IS NOT NULL AND jsonb_typeof(p_due) = 'object' THEN
    INSERT INTO due_calendar (id, tx_id, dsr_id, dsr_name, client_type, shop_id, shop_name, due_date,
        amount, paid_amount, note, status, cleared_date, created_at)
    VALUES ((p_due->>'id')::uuid, p_due->>'tx_id', COALESCE(p_due->>'dsr_id',''), COALESCE(p_due->>'dsr_name',''),
        COALESCE(p_due->>'client_type','shop'), COALESCE(p_due->>'shop_id',''), COALESCE(p_due->>'shop_name',''),
        (p_due->>'due_date')::date, COALESCE((p_due->>'amount')::numeric,0), COALESCE((p_due->>'paid_amount')::numeric,0),
        COALESCE(p_due->>'note',''), COALESCE(p_due->>'status','pending'),
        (p_due->>'cleared_date')::date, COALESCE((p_due->>'created_at')::timestamptz, NOW()))
    RETURNING * INTO v_due;
    v_has := TRUE;
  END IF;

  IF p_visit IS NOT NULL AND jsonb_typeof(p_visit) = 'object' THEN
    BEGIN
      INSERT INTO shop_visits (shop_id, visit_role, visitor_id, visitor_name, visit_date, created_at)
      VALUES (p_visit->>'shop_id', COALESCE(p_visit->>'visit_role','dsr'), COALESCE(p_visit->>'visitor_id',''),
              COALESCE(p_visit->>'visitor_name',''), (p_visit->>'visit_date')::date, COALESCE((p_visit->>'created_at')::timestamptz, NOW()));
    EXCEPTION WHEN OTHERS THEN NULL;   -- a visit log failure must never undo the sale
    END;
  END IF;

  IF v_has THEN RETURN to_jsonb(v_due); END IF;
  RETURN NULL;
END;
$$;
GRANT EXECUTE ON FUNCTION create_shop_sale(JSONB, JSONB, JSONB) TO service_role;
