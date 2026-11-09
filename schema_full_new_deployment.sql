-- =====================================================================
-- AXIION DMS v5.27.0 -- FULL SCHEMA FOR A NEW DEPLOYMENT (schema_full_new_deployment.sql)
--   Complete and current: everything from schema_fresh.sql (v5.12) PLUS the
--   v5.24-v5.27 additions (company-offer snapshot columns on transactions,
--   product price history). Migrations 001-006 are already contained here.
--   BRAND-NEW, EMPTY Supabase project ONLY (it refuses to run if data exists).
--   Existing database? Do NOT run this -- use the files in /migrations.
--   Run once in the Supabase SQL editor.
-- =====================================================================
DO $$
DECLARE n BIGINT;
BEGIN
  IF to_regclass('public.transactions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.transactions' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'STOP: this database already contains transactions. schema_fresh.sql would erase everything. Use migrations/001_v5_1_fixes.sql instead.';
    END IF;
  END IF;
  IF to_regclass('public.srs') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.srs' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'STOP: this database already contains staff (srs). schema_fresh.sql would erase everything. Use migrations/001_v5_1_fixes.sql instead.';
    END IF;
  END IF;
END
$$;


DROP TABLE IF EXISTS user_passwords  CASCADE;
DROP TABLE IF EXISTS due_calendar    CASCADE;
DROP TABLE IF EXISTS exp_records     CASCADE;
DROP TABLE IF EXISTS exp_cats        CASCADE;
DROP TABLE IF EXISTS sr_payments     CASCADE;
DROP TABLE IF EXISTS bonus           CASCADE;
DROP TABLE IF EXISTS dmg_claims      CASCADE;
DROP TABLE IF EXISTS transactions    CASCADE;
DROP TABLE IF EXISTS srs             CASCADE;
DROP TABLE IF EXISTS products        CASCADE;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE products (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL,
  sku              TEXT        NOT NULL,
  case_size        INTEGER     DEFAULT 1,
  unit_type        TEXT        DEFAULT 'কেস',
  case_price          NUMERIC(14,4) DEFAULT 0,
  case_purchase_price NUMERIC(14,4) DEFAULT 0,
  purchase_price   NUMERIC(14,4) DEFAULT 0,
  selling_price    NUMERIC(14,4) DEFAULT 0,
  bonus_free_units NUMERIC(14,4) DEFAULT 0,
  bonus_cases_req  NUMERIC(10,2) DEFAULT 1,
  bonus_free_money NUMERIC(14,4) DEFAULT 0,
  low_stock_alert  NUMERIC(10,2) DEFAULT 0,
  thumb            TEXT        DEFAULT '',
  category         TEXT        DEFAULT '',
  sort_order       INTEGER     DEFAULT 0,
  current_stock    NUMERIC(14,4) DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_products_category   ON products(category);
CREATE INDEX idx_products_sort_order ON products(sort_order);

CREATE TABLE srs (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT        NOT NULL,
  phone          TEXT        DEFAULT '',
  area           TEXT        DEFAULT '',
  role           TEXT        DEFAULT 'dsr' CHECK (role IN ('dsr', 'so', 'driver')),
  thumb          TEXT        DEFAULT '',
  so_id          TEXT        DEFAULT '',
  so_name        TEXT        DEFAULT '',
  display_no     INTEGER,
  road_id        TEXT        DEFAULT '',
  road_name      TEXT        DEFAULT '',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_srs_so_id      ON srs(so_id);
CREATE INDEX idx_srs_role       ON srs(role);
CREATE INDEX idx_srs_road_id    ON srs(road_id);
CREATE UNIQUE INDEX idx_srs_role_display_no ON srs(role, display_no);

DROP TABLE IF EXISTS sr_display_seq CASCADE;
CREATE TABLE sr_display_seq (
  role    TEXT    PRIMARY KEY,
  next_no INTEGER NOT NULL DEFAULT 1
);
INSERT INTO sr_display_seq (role, next_no) VALUES ('dsr', 1), ('so', 1);

CREATE OR REPLACE FUNCTION next_sr_display_no(p_role TEXT) RETURNS INTEGER AS $$
DECLARE v INTEGER;
BEGIN
  UPDATE sr_display_seq SET next_no = next_no + 1 WHERE role = p_role RETURNING next_no - 1 INTO v;
  IF v IS NULL THEN
    INSERT INTO sr_display_seq(role, next_no) VALUES (p_role, 2) RETURNING next_no - 1 INTO v;
  END IF;
  RETURN v;
END;
$$ LANGUAGE plpgsql;
GRANT EXECUTE ON FUNCTION next_sr_display_no(TEXT) TO service_role;

CREATE TABLE transactions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_id          UUID        NOT NULL,
  type           TEXT        NOT NULL CHECK (type IN ('give','return','damage','buy','point_sale','point_damage_return','dsr_sale','dsr_sale_return','return_company')),
  sr_id          TEXT        DEFAULT '',
  sr_name        TEXT        DEFAULT '',
  date           DATE        NOT NULL,
  slip_no        TEXT        DEFAULT '',
  product_id     TEXT        NOT NULL,
  product_name   TEXT        DEFAULT '',
  sku            TEXT        DEFAULT '',
  cases          NUMERIC(10,2) DEFAULT 0,
  pcs            NUMERIC(10,2) DEFAULT 0,
  total_units    NUMERIC(14,4) DEFAULT 0,
  purchase_price NUMERIC(14,4) DEFAULT 0,
  selling_price  NUMERIC(14,4) DEFAULT 0,
  total_cost     NUMERIC(14,4) DEFAULT 0,
  total_revenue  NUMERIC(14,4) DEFAULT 0,
  commission_amt NUMERIC(14,4) DEFAULT 0,
  discount_amt   NUMERIC(14,4) DEFAULT 0,
  shop_id        TEXT        DEFAULT '',
  customer_id    TEXT        DEFAULT '',
  note           TEXT        DEFAULT '',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_tx_type    ON transactions(type);
CREATE INDEX idx_tx_date    ON transactions(date);
CREATE INDEX idx_tx_sr_id   ON transactions(sr_id);
CREATE INDEX idx_tx_shop_id ON transactions(shop_id);
CREATE INDEX idx_tx_customer_id ON transactions(customer_id);

CREATE TABLE dmg_claims (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_id          TEXT        DEFAULT '',
  product_id     TEXT        NOT NULL,
  product_name   TEXT        DEFAULT '',
  sku            TEXT        DEFAULT '',
  total_units    NUMERIC(12,2) DEFAULT 0,
  purchase_price NUMERIC(12,2) DEFAULT 0,
  total_cost     NUMERIC(14,2) DEFAULT 0,
  date           DATE,
  sr_id          TEXT        DEFAULT '',
  sr_name        TEXT        DEFAULT '',
  status         TEXT        DEFAULT 'pending' CHECK (status IN ('pending','cleared')),
  cleared_date   DATE,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_dmg_product ON dmg_claims(product_id);
CREATE INDEX idx_dmg_status  ON dmg_claims(status);
CREATE INDEX idx_dmg_sr_id   ON dmg_claims(sr_id);

CREATE TABLE bonus (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    TEXT        NOT NULL,
  product_name  TEXT        DEFAULT '',
  sku           TEXT        DEFAULT '',
  from_date     DATE,
  to_date       DATE,
  given_units   NUMERIC(12,2) DEFAULT 0,
  bonus_amount  NUMERIC(14,2) DEFAULT 0,
  status        TEXT        DEFAULT 'cleared',
  cleared_date  DATE,
  note          TEXT        DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sr_payments (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sr_id          TEXT        NOT NULL,
  sr_name        TEXT        DEFAULT '',
  date           DATE        NOT NULL,
  amount         NUMERIC(14,4) DEFAULT 0,
  cash_amount    NUMERIC(14,4) DEFAULT 0,
  commission_amt NUMERIC(14,4) DEFAULT 0,
  discount_amt   NUMERIC(14,4) DEFAULT 0,
  damage_amt     NUMERIC(14,4) DEFAULT 0,
  note           TEXT        DEFAULT '',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_pay_sr   ON sr_payments(sr_id);
CREATE INDEX idx_pay_date ON sr_payments(date);

CREATE TABLE exp_cats (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE exp_records (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id   TEXT        NOT NULL,
  category_name TEXT        DEFAULT '',
  date          DATE        NOT NULL,
  amount        NUMERIC(14,2) DEFAULT 0,
  note          TEXT        DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_exp_date ON exp_records(date);

CREATE TABLE due_calendar (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  dsr_id       TEXT        DEFAULT '',
  dsr_name     TEXT        DEFAULT '',
  client_type  TEXT        DEFAULT 'dsr',   -- 'dsr' | 'shop'
  shop_id      TEXT        DEFAULT '',      -- set when client_type='shop' (§11/§12)
  shop_name    TEXT        DEFAULT '',
  due_date     DATE        NOT NULL,
  amount       NUMERIC(14,4) DEFAULT 0,
  paid_amount  NUMERIC(14,4) DEFAULT 0,
  note         TEXT        DEFAULT '',
  status       TEXT        DEFAULT 'pending' CHECK (status IN ('pending','partial','cleared')),
  cleared_date DATE,
  tx_id        TEXT        DEFAULT '',      -- v5.0: the sale (transactions.tx_id) this due came from — feeds the shop ledger
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_due_date    ON due_calendar(due_date);
CREATE INDEX idx_due_status  ON due_calendar(status);
CREATE INDEX idx_due_dsr_id  ON due_calendar(dsr_id);
CREATE INDEX idx_due_shop_id ON due_calendar(shop_id);

CREATE TABLE user_passwords (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key       TEXT        NOT NULL UNIQUE,
  user_name      TEXT        DEFAULT '',
  role           TEXT        NOT NULL CHECK (role IN ('owner','manager','so','dsr','driver')),
  password       TEXT        NOT NULL UNIQUE,
  thumb          TEXT        DEFAULT '',   -- V25: Manager's individual profile photo (Owner-set), same base64-thumb pattern as srs.thumb
  must_change_pw BOOLEAN     NOT NULL DEFAULT false,  -- V44 #18: forces a mandatory password-set screen on next login; only ever true for the freshly-seeded Owner row
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_up_password ON user_passwords(password);

ALTER TABLE products       ENABLE ROW LEVEL SECURITY;
ALTER TABLE srs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE dmg_claims     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bonus          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sr_payments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE exp_cats       ENABLE ROW LEVEL SECURITY;
ALTER TABLE exp_records    ENABLE ROW LEVEL SECURITY;
ALTER TABLE due_calendar   ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_passwords ENABLE ROW LEVEL SECURITY;

CREATE POLICY "srv_products"       ON products       FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "srv_srs"            ON srs            FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "srv_transactions"   ON transactions   FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "srv_dmg_claims"     ON dmg_claims     FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "srv_bonus"          ON bonus          FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "srv_sr_payments"    ON sr_payments    FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "srv_exp_cats"       ON exp_cats       FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "srv_exp_records"    ON exp_records    FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "srv_due_calendar"   ON due_calendar   FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "srv_user_passwords" ON user_passwords FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "anon_deny_products"       ON products       FOR ALL TO anon USING (false);
CREATE POLICY "anon_deny_srs"            ON srs            FOR ALL TO anon USING (false);
CREATE POLICY "anon_deny_transactions"   ON transactions   FOR ALL TO anon USING (false);
CREATE POLICY "anon_deny_dmg_claims"     ON dmg_claims     FOR ALL TO anon USING (false);
CREATE POLICY "anon_deny_bonus"          ON bonus          FOR ALL TO anon USING (false);
CREATE POLICY "anon_deny_sr_payments"    ON sr_payments    FOR ALL TO anon USING (false);
CREATE POLICY "anon_deny_exp_cats"       ON exp_cats       FOR ALL TO anon USING (false);
CREATE POLICY "anon_deny_exp_records"    ON exp_records    FOR ALL TO anon USING (false);
CREATE POLICY "anon_deny_due_calendar"   ON due_calendar   FOR ALL TO anon USING (false);
CREATE POLICY "anon_deny_user_passwords" ON user_passwords FOR ALL TO anon USING (false);

INSERT INTO user_passwords (user_key, user_name, role, password, must_change_pw)
VALUES ('owner', 'Owner', 'owner', '12345', true);

DROP TABLE IF EXISTS group_chat_messages CASCADE;

CREATE TABLE group_chat_messages (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id   TEXT        NOT NULL DEFAULT '',
  sender_name TEXT        NOT NULL DEFAULT '',
  sender_role TEXT        NOT NULL DEFAULT '',
  message     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_gcm_created_at ON group_chat_messages(created_at);

ALTER TABLE group_chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "srv_chat"
  ON group_chat_messages FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "anon_chat_read"
  ON group_chat_messages FOR SELECT TO anon
  USING (true);

ALTER PUBLICATION supabase_realtime ADD TABLE group_chat_messages;

DROP TABLE IF EXISTS manager_pending_approvals CASCADE;

CREATE TABLE manager_pending_approvals (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id   TEXT        NOT NULL DEFAULT '',
  manager_name TEXT        NOT NULL DEFAULT '',
  input_type   TEXT        NOT NULL DEFAULT '' CHECK (input_type IN ('transaction','payment','expense','settlement')),
  input_data   JSONB       NOT NULL DEFAULT '{}',
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  status       TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  approved_at  TIMESTAMPTZ,
  approved_by  TEXT        DEFAULT ''
);

CREATE INDEX idx_mpa_manager_id   ON manager_pending_approvals(manager_id);
CREATE INDEX idx_mpa_status       ON manager_pending_approvals(status);
CREATE INDEX idx_mpa_submitted_at ON manager_pending_approvals(submitted_at);

ALTER TABLE manager_pending_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_mpa" ON manager_pending_approvals FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_mpa" ON manager_pending_approvals FOR ALL TO anon USING (false);

DROP TABLE IF EXISTS notices CASCADE;

CREATE TABLE notices (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  content    TEXT        NOT NULL DEFAULT '',
  is_active  BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE notices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_notices"       ON notices FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_notices" ON notices FOR ALL TO anon USING (false);

DROP TABLE IF EXISTS important_contacts CASCADE;

CREATE TABLE important_contacts (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL DEFAULT '',
  role         TEXT        NOT NULL DEFAULT '',
  phone_number TEXT        NOT NULL DEFAULT '',
  special_note TEXT        NOT NULL DEFAULT '',
  created_by   TEXT        NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ic_created_at ON important_contacts(created_at);

ALTER TABLE important_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_important_contacts"       ON important_contacts FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_important_contacts" ON important_contacts FOR ALL TO anon          USING (false);

DROP TABLE IF EXISTS office_location CASCADE;

CREATE TABLE app_settings (
  id                INTEGER     PRIMARY KEY DEFAULT 1,
  shop_name         TEXT        NOT NULL DEFAULT '',
  -- V59 — printed-document identity fields (challan/report/slip letterhead).
  -- All owner-editable from the app's Settings page; every value defaults
  -- to '' so a fresh install still prints (the letterhead lines just stay
  -- blank/hidden until the owner fills them in).
  shop_address      TEXT        DEFAULT '',
  shop_phone        TEXT        DEFAULT '',
  distributor_name  TEXT        DEFAULT '',
  logo_text         TEXT        DEFAULT '',
  set_by            TEXT        DEFAULT '',
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT app_settings_single_row CHECK (id = 1)
);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_app_settings"       ON app_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_app_settings" ON app_settings FOR ALL TO anon          USING (false);

CREATE TABLE office_location (
  id         INTEGER       PRIMARY KEY DEFAULT 1,
  lat        NUMERIC(10,7) NOT NULL,
  lng        NUMERIC(10,7) NOT NULL,
  radius_m   INTEGER       NOT NULL DEFAULT 150,
  set_by     TEXT          DEFAULT '',
  set_at     TIMESTAMPTZ   DEFAULT NOW(),
  CONSTRAINT office_location_single_row CHECK (id = 1)
);

ALTER TABLE office_location ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_office_location"       ON office_location FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_office_location" ON office_location FOR ALL TO anon          USING (false);

DROP TABLE IF EXISTS live_locations CASCADE;

CREATE TABLE live_locations (
  user_key   TEXT          PRIMARY KEY,
  user_name  TEXT          DEFAULT '',
  role       TEXT          DEFAULT '',
  lat        NUMERIC(10,7),
  lng        NUMERIC(10,7),
  updated_at TIMESTAMPTZ   DEFAULT NOW()
);

ALTER TABLE live_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_live_locations"       ON live_locations FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_live_locations" ON live_locations FOR ALL TO anon          USING (false);

DROP TABLE IF EXISTS attendance CASCADE;

CREATE TABLE attendance (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key    TEXT          NOT NULL,
  user_name   TEXT          DEFAULT '',
  role        TEXT          NOT NULL,
  punch_date  DATE          NOT NULL,   -- the WORKDAY this punch belongs to (not necessarily the calendar date it was tapped on, for late-night "out" punches)
  punch_type  TEXT          NOT NULL DEFAULT 'in' CHECK (punch_type IN ('in','out')),
  punch_time  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  status      TEXT          CHECK (status IS NULL OR status IN ('present','late')), -- only meaningful for punch_type='in'
  lat         NUMERIC(10,7),
  lng         NUMERIC(10,7),
  at_office   BOOLEAN,
  distance_m  NUMERIC(10,1),
  created_at  TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE (user_key, punch_date, punch_type)
);
CREATE INDEX idx_att_user ON attendance(user_key);
CREATE INDEX idx_att_date ON attendance(punch_date);

ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_attendance"       ON attendance FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_attendance" ON attendance FOR ALL TO anon          USING (false);

DROP TABLE IF EXISTS salary_settings CASCADE;

CREATE TABLE salary_settings (
  user_key          TEXT          NOT NULL,
  month             TEXT          NOT NULL, -- 'YYYY-MM'
  user_name         TEXT          DEFAULT '',
  salary_per_day    NUMERIC(14,2) NOT NULL DEFAULT 0,
  bonus_enabled     BOOLEAN       NOT NULL DEFAULT false,
  daily_bonus_amt   NUMERIC(10,2) NOT NULL DEFAULT 20,
  perfect_bonus_amt NUMERIC(10,2) NOT NULL DEFAULT 500,
  late_penalty_amt  NUMERIC(10,2) NOT NULL DEFAULT 500,
  no_gap_bonus_amt  NUMERIC(10,2) NOT NULL DEFAULT 0,
  set_by            TEXT          DEFAULT '',
  set_at            TIMESTAMPTZ   DEFAULT NOW(),
  PRIMARY KEY (user_key, month)
);

ALTER TABLE salary_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_salary_settings"       ON salary_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_salary_settings" ON salary_settings FOR ALL TO anon          USING (false);

DROP TABLE IF EXISTS salary_ledger CASCADE;

CREATE TABLE salary_ledger (
  user_key    TEXT          NOT NULL,
  month       TEXT          NOT NULL, -- 'YYYY-MM'
  user_name   TEXT          DEFAULT '',
  paid_at     TIMESTAMPTZ,
  paid_amount NUMERIC(14,2) DEFAULT 0,
  paid_by     TEXT          DEFAULT '',
  updated_at  TIMESTAMPTZ   DEFAULT NOW(),
  PRIMARY KEY (user_key, month)
);

ALTER TABLE salary_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_salary_ledger"       ON salary_ledger FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_salary_ledger" ON salary_ledger FOR ALL TO anon          USING (false);

DROP TABLE IF EXISTS salary_day_override CASCADE;

CREATE TABLE salary_day_override (
  user_key      TEXT        NOT NULL,
  workday_date  DATE        NOT NULL,
  reason        TEXT        DEFAULT '',
  approved_by   TEXT        DEFAULT '',
  approved_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_key, workday_date)
);

ALTER TABLE salary_day_override ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_salary_day_override"       ON salary_day_override FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_salary_day_override" ON salary_day_override FOR ALL TO anon          USING (false);

DROP TABLE IF EXISTS advance_requests CASCADE;

CREATE TABLE advance_requests (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key     TEXT          NOT NULL,
  user_name    TEXT          DEFAULT '',
  role         TEXT          DEFAULT '',
  amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  month        TEXT          NOT NULL, -- 'YYYY-MM' — the salary month it will be deducted from
  note         TEXT          DEFAULT '',
  status       TEXT          NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_at TIMESTAMPTZ   DEFAULT NOW(),
  decided_at   TIMESTAMPTZ,
  decided_by   TEXT          DEFAULT ''
);
CREATE INDEX idx_advance_requests_user_month ON advance_requests(user_key, month);
CREATE INDEX idx_advance_requests_status     ON advance_requests(status);

ALTER TABLE advance_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_advance_requests"       ON advance_requests FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_advance_requests" ON advance_requests FOR ALL TO anon          USING (false);

DROP TABLE IF EXISTS shops CASCADE;

CREATE TABLE shops (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_no            TEXT          NOT NULL UNIQUE,   -- e.g. SHOP-0001
  name               TEXT          NOT NULL,
  keeper_name        TEXT          DEFAULT '',        -- shopkeeper's own name, captured at registration
  phone              TEXT          DEFAULT '',
  address            TEXT          DEFAULT '',        -- optional free-form / reverse-geocoded (§14 bonus)
  lat                NUMERIC(10,7),
  lng                NUMERIC(10,7),
  assigned_dsr_id    TEXT          NOT NULL,           -- srs.id of the owning DSR (stable — never a name)
  assigned_dsr_name  TEXT          DEFAULT '',
  road_id            TEXT          DEFAULT '',
  road_name          TEXT          DEFAULT '',
  created_at         TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX idx_shops_dsr   ON shops(assigned_dsr_id);
CREATE INDEX idx_shops_phone ON shops(phone);
CREATE INDEX idx_shops_road  ON shops(road_id);

ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_shops"       ON shops FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_shops" ON shops FOR ALL TO anon          USING (false);

DROP SEQUENCE IF EXISTS shop_no_seq;
CREATE SEQUENCE shop_no_seq START 1;

CREATE OR REPLACE FUNCTION next_shop_no() RETURNS INTEGER AS $$
BEGIN
  RETURN nextval('shop_no_seq');
END;
$$ LANGUAGE plpgsql;
GRANT EXECUTE ON FUNCTION next_shop_no() TO service_role;

DROP TABLE IF EXISTS pos_customers CASCADE;

CREATE TABLE pos_customers (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT          NOT NULL,
  keeper_name  TEXT          DEFAULT '',
  phone        TEXT          DEFAULT '',
  address      TEXT          DEFAULT '',
  created_at   TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX idx_pos_cust_phone ON pos_customers(phone);

ALTER TABLE pos_customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_pos_customers"       ON pos_customers FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_pos_customers" ON pos_customers FOR ALL TO anon          USING (false);

DROP TABLE IF EXISTS orders CASCADE;

CREATE TABLE orders (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  so_id             TEXT          NOT NULL,
  so_name           TEXT          DEFAULT '',
  items             JSONB         NOT NULL DEFAULT '[]',
  requested_amount  NUMERIC(14,4) DEFAULT 0,
  status            TEXT          NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','modified_pending','approved','rejected')),
  modified_by       TEXT          DEFAULT '',
  modified_amount   NUMERIC(14,4),
  proposed_items    JSONB,
  assigned_dsr_id   TEXT          DEFAULT '',
  load_status       TEXT          NOT NULL DEFAULT 'not_started'
                      CHECK (load_status IN ('not_started','loading','load_complete','loaded')),
  load_ticks        JSONB         NOT NULL DEFAULT '{}',
  approved_by       TEXT          DEFAULT '',
  approved_at       TIMESTAMPTZ,
  original_items    JSONB,
  loaded_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX idx_orders_so_id  ON orders(so_id);
CREATE INDEX idx_orders_dsr_id ON orders(assigned_dsr_id);
CREATE INDEX idx_orders_status ON orders(status);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_orders"       ON orders FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_orders" ON orders FOR ALL TO anon          USING (false);

DROP TABLE IF EXISTS personal_ledger CASCADE;

CREATE TABLE personal_ledger (
  id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key   TEXT          NOT NULL,
  type       TEXT          NOT NULL CHECK (type IN ('received','given')),
  amount     NUMERIC(14,4) DEFAULT 0,
  note       TEXT          DEFAULT '',
  date       DATE          NOT NULL,
  created_at TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX idx_pl_user ON personal_ledger(user_key);

ALTER TABLE personal_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_personal_ledger"       ON personal_ledger FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_personal_ledger" ON personal_ledger FOR ALL TO anon          USING (false);

DROP TABLE IF EXISTS so_daily_quota CASCADE;
DROP TABLE IF EXISTS online_deposit CASCADE;

CREATE TABLE online_deposit (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  date           DATE          NOT NULL,
  amount         NUMERIC(14,4) DEFAULT 0,
  deposit_method TEXT          NOT NULL CHECK (deposit_method IN ('bank','depot')),
  set_by         TEXT          DEFAULT '',
  set_at         TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX idx_online_deposit_date ON online_deposit(date);

ALTER TABLE online_deposit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_online_deposit"       ON online_deposit FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_online_deposit" ON online_deposit FOR ALL TO anon          USING (false);

DROP TABLE IF EXISTS targets CASCADE;

CREATE TABLE targets (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key      TEXT          NOT NULL,               -- = srs.id (DSR or SO), or 'COMPANY_TOTAL'
  user_name     TEXT          DEFAULT '',
  role          TEXT          DEFAULT '' CHECK (role IN ('', 'dsr', 'so', 'company')),
  period        TEXT          NOT NULL,               -- 'YYYY-MM'
  target_amount NUMERIC(14,4) DEFAULT 0,               -- money target (৳)
  target_boxes  NUMERIC(14,4) DEFAULT 0,               -- BOX target (1 box = 1 full case of any SKU) — the company's real measure
  set_by        TEXT          DEFAULT '',
  set_at        TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE (user_key, period)
);
CREATE INDEX idx_targets_period   ON targets(period);
CREATE INDEX idx_targets_userkey  ON targets(user_key);

ALTER TABLE targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_targets"       ON targets FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_targets" ON targets FOR ALL TO anon          USING (false);

DROP TABLE IF EXISTS target_bonuses CASCADE;

CREATE TABLE target_bonuses (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key     TEXT          NOT NULL,           -- = srs.id (SO, typically)
  user_name    TEXT          DEFAULT '',
  period       TEXT          NOT NULL,           -- 'YYYY-MM'
  amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  status       TEXT          NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'settled')),
  set_by       TEXT          DEFAULT '',
  set_at       TIMESTAMPTZ   DEFAULT NOW(),
  settled_by   TEXT          DEFAULT '',
  settled_at   TIMESTAMPTZ,
  UNIQUE (user_key, period)
);
CREATE INDEX idx_target_bonuses_period ON target_bonuses(period);

ALTER TABLE target_bonuses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_target_bonuses"       ON target_bonuses FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_target_bonuses" ON target_bonuses FOR ALL TO anon          USING (false);

DROP TABLE IF EXISTS product_targets CASCADE;

CREATE TABLE product_targets (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  period      TEXT          NOT NULL,               -- 'YYYY-MM'
  product_id  TEXT          NOT NULL,
  target_qty  NUMERIC(14,4) DEFAULT 0,
  set_by      TEXT          DEFAULT '',
  set_at      TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE (period, product_id)
);
CREATE INDEX idx_prod_targets_period ON product_targets(period);
CREATE INDEX idx_prod_targets_pid    ON product_targets(product_id);

ALTER TABLE product_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_product_targets"       ON product_targets FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_product_targets" ON product_targets FOR ALL TO anon          USING (false);

DROP TABLE IF EXISTS daily_so_reports CASCADE;

CREATE TABLE daily_so_reports (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  so_id         TEXT          NOT NULL,
  so_name       TEXT          DEFAULT '',
  report_date   DATE          NOT NULL,
  generated_at  TIMESTAMPTZ   DEFAULT NOW(),
  generated_by  TEXT          DEFAULT '',   -- 'auto' (cron) or the Owner's user_name
  report_data   JSONB         NOT NULL DEFAULT '{}',
  due_data      JSONB         NOT NULL DEFAULT '{}',
  UNIQUE (so_id, report_date)
);
CREATE INDEX idx_dsr_so_id ON daily_so_reports(so_id);
CREATE INDEX idx_dsr_date  ON daily_so_reports(report_date);

ALTER TABLE daily_so_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_daily_so_reports"       ON daily_so_reports FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_daily_so_reports" ON daily_so_reports FOR ALL TO anon          USING (false);

CREATE OR REPLACE FUNCTION apply_stock_delta() RETURNS TRIGGER AS $$
DECLARE
  delta NUMERIC(14,4);
BEGIN
  delta := CASE NEW.type
    WHEN 'buy'                  THEN  NEW.total_units
    WHEN 'give'                 THEN -NEW.total_units
    WHEN 'return'                THEN  NEW.total_units
    WHEN 'point_sale'            THEN -NEW.total_units
    WHEN 'point_damage_return'   THEN  NEW.total_units
    WHEN 'return_company'        THEN -NEW.total_units
    ELSE 0
  END;
  IF delta <> 0 AND NEW.product_id IS NOT NULL AND NEW.product_id <> '' THEN
    UPDATE products SET current_stock = current_stock + delta
      WHERE id::text = NEW.product_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_apply_stock_delta ON transactions;
CREATE TRIGGER trg_apply_stock_delta
  AFTER INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION apply_stock_delta();

DROP TABLE IF EXISTS roads CASCADE;

CREATE TABLE roads (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  so_id      TEXT        DEFAULT '',
  so_name    TEXT        DEFAULT '',
  dsr_id     TEXT        DEFAULT '',
  dsr_name   TEXT        DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_roads_so_id  ON roads(so_id);
CREATE INDEX idx_roads_dsr_id ON roads(dsr_id);

ALTER TABLE roads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_roads"       ON roads FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_roads" ON roads FOR ALL TO anon          USING (false);

DROP TABLE IF EXISTS road_visit_plans CASCADE;

CREATE TABLE road_visit_plans (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  road_id        TEXT        NOT NULL,
  road_name      TEXT        DEFAULT '',
  so_id          TEXT        DEFAULT '',
  so_name        TEXT        DEFAULT '',
  dsr_id         TEXT        DEFAULT '',
  dsr_name       TEXT        DEFAULT '',
  so_visit_date  DATE        NOT NULL,   -- day 1 — SO visits shops
  dsr_visit_date DATE        NOT NULL,   -- day 2 (so_visit_date + 1) — DSR delivers
  created_by     TEXT        DEFAULT '',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_rvp_road          ON road_visit_plans(road_id);
CREATE INDEX idx_rvp_so_date       ON road_visit_plans(so_id, so_visit_date);
CREATE INDEX idx_rvp_dsr_date      ON road_visit_plans(dsr_id, dsr_visit_date);

ALTER TABLE road_visit_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_road_visit_plans"       ON road_visit_plans FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_road_visit_plans" ON road_visit_plans FOR ALL TO anon          USING (false);

DROP TABLE IF EXISTS road_weekly_plans CASCADE;

CREATE TABLE road_weekly_plans (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  road_id      TEXT        NOT NULL,
  road_name    TEXT        DEFAULT '',
  so_id        TEXT        DEFAULT '',
  so_name      TEXT        DEFAULT '',
  dsr_id       TEXT        DEFAULT '',
  dsr_name     TEXT        DEFAULT '',
  weekday      SMALLINT    NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=Sunday..6=Saturday
  active_from  DATE        NOT NULL DEFAULT CURRENT_DATE,
  created_by   TEXT        DEFAULT '',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (road_id, weekday)
);
CREATE INDEX idx_rwp_so      ON road_weekly_plans(so_id, weekday);
CREATE INDEX idx_rwp_dsr     ON road_weekly_plans(dsr_id, weekday);
CREATE INDEX idx_rwp_road    ON road_weekly_plans(road_id);

ALTER TABLE road_weekly_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_road_weekly_plans"       ON road_weekly_plans FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_road_weekly_plans" ON road_weekly_plans FOR ALL TO anon          USING (false);

DROP TABLE IF EXISTS shop_visits CASCADE;

CREATE TABLE shop_visits (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      TEXT        NOT NULL,
  visit_role   TEXT        NOT NULL CHECK (visit_role IN ('so', 'dsr')),
  visitor_id   TEXT        DEFAULT '',
  visitor_name TEXT        DEFAULT '',
  visit_date   DATE        NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_shop_visits_date      ON shop_visits(visit_date);
CREATE INDEX idx_shop_visits_shop_date ON shop_visits(shop_id, visit_date);

ALTER TABLE shop_visits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_shop_visits"       ON shop_visits FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_shop_visits" ON shop_visits FOR ALL TO anon          USING (false);



-- ── v4.8.0 — end-of-day settlement, due collection, damage collection ──
DROP TABLE IF EXISTS due_collections CASCADE;
DROP TABLE IF EXISTS damage_collections CASCADE;
DROP TABLE IF EXISTS dsr_settlements CASCADE;
-- 1) Due collected by a DSR from a shop (one row per collection event)
CREATE TABLE IF NOT EXISTS due_collections (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  due_id      TEXT          NOT NULL,
  shop_id     TEXT          DEFAULT '',
  shop_name   TEXT          DEFAULT '',
  dsr_id      TEXT          NOT NULL,
  dsr_name    TEXT          DEFAULT '',
  date        DATE          NOT NULL,
  amount      NUMERIC(14,4) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ   DEFAULT NOW(),
  credit_dsr_id   TEXT DEFAULT '',   -- v5.21: the shop's own DSR (gets the credit)
  credit_dsr_name TEXT DEFAULT '',
  collector_id    TEXT DEFAULT '',   -- v5.21: who really took the money (any role)
  collector_name  TEXT DEFAULT '',
  collector_role  TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_duecol_dsr_date ON due_collections(dsr_id, date);
CREATE INDEX IF NOT EXISTS idx_duecol_due      ON due_collections(due_id);
ALTER TABLE due_collections ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "srv_due_collections" ON due_collections FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_deny_due_collections" ON due_collections FOR ALL TO anon USING (false);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) Damaged goods a DSR collected back from a shop (money refund OR exchange)
CREATE TABLE IF NOT EXISTS damage_collections (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  col_id             TEXT          NOT NULL,            -- groups the lines of one submission
  dsr_id             TEXT          NOT NULL,
  dsr_name           TEXT          DEFAULT '',
  shop_id            TEXT          DEFAULT '',
  shop_name          TEXT          DEFAULT '',
  date               DATE          NOT NULL,
  product_id         TEXT          NOT NULL,
  product_name       TEXT          DEFAULT '',
  sku                TEXT          DEFAULT '',
  units              NUMERIC(14,4) DEFAULT 0,
  selling_price      NUMERIC(14,4) DEFAULT 0,
  purchase_price     NUMERIC(14,4) DEFAULT 0,
  damaged_value      NUMERIC(14,4) DEFAULT 0,           -- units * selling_price
  resolution         TEXT          NOT NULL CHECK (resolution IN ('money','exchange')),
  refund_amt         NUMERIC(14,4) DEFAULT 0,           -- cash the DSR paid the shop (money)
  exch_product_id    TEXT          DEFAULT '',
  exch_product_name  TEXT          DEFAULT '',
  exch_units         NUMERIC(14,4) DEFAULT 0,
  exch_value         NUMERIC(14,4) DEFAULT 0,           -- replacement value at selling price
  note               TEXT          DEFAULT '',
  created_at         TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dmgcol_dsr_date ON damage_collections(dsr_id, date);
ALTER TABLE damage_collections ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "srv_damage_collections" ON damage_collections FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_deny_damage_collections" ON damage_collections FOR ALL TO anon USING (false);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3) One row per end-of-day settlement press. `token` is UNIQUE so a
--    double tap / retry can never apply the same calculation twice.
CREATE TABLE IF NOT EXISTS dsr_settlements (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  token          TEXT          NOT NULL UNIQUE,
  dsr_id         TEXT          NOT NULL,
  dsr_name       TEXT          DEFAULT '',
  date           DATE          NOT NULL,
  comm_amt       NUMERIC(14,4) DEFAULT 0,
  disc_amt       NUMERIC(14,4) DEFAULT 0,
  dmg_amt        NUMERIC(14,4) DEFAULT 0,
  return_amt     NUMERIC(14,4) DEFAULT 0,
  cash_expected  NUMERIC(14,4) DEFAULT 0,
  cash_received  NUMERIC(14,4) DEFAULT 0,
  note           TEXT          DEFAULT '',
  created_by     TEXT          DEFAULT '',
  created_at     TIMESTAMPTZ   DEFAULT NOW(),
  -- v5.11 — who actually took the cash from the DSR ('manager' or 'owner'); powers the Owner's "cash with managers" total
  received_by_id   TEXT        DEFAULT '',
  received_by_name TEXT        DEFAULT '',
  received_by_role TEXT        DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_settle_dsr_date ON dsr_settlements(dsr_id, date);
CREATE INDEX IF NOT EXISTS idx_settle_recv ON dsr_settlements(received_by_role, received_by_id, date);
ALTER TABLE dsr_settlements ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "srv_dsr_settlements" ON dsr_settlements FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_deny_dsr_settlements" ON dsr_settlements FOR ALL TO anon USING (false);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;



-- ═════════════════════════════════════════════════════════════════
-- Storage bucket for product / staff photos (public, name must be "thumbs")
-- Created here so a brand-new deployment needs no manual dashboard step.
-- ═════════════════════════════════════════════════════════════════
INSERT INTO storage.buckets (id, name, public)
VALUES ('thumbs', 'thumbs', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- ── v60 — 35 default products (name, prices, bonus & low-stock settings) ──
-- Starting stock is 0 for a fresh setup; record real stock with "কেনা" (buy).
-- Every row is fully editable / deletable from the Products screen.
-- Safe to re-run: rows are matched by id and never overwritten.
INSERT INTO products (id,name,sku,case_size,unit_type,case_price,case_purchase_price,purchase_price,selling_price,bonus_free_units,bonus_cases_req,bonus_free_money,low_stock_alert,thumb,category,sort_order,current_stock) VALUES
  ('b8306428-3cfd-4dae-94b7-215a139a1022','স্পীড ২৫০ মিলি','597',24,'কেস',597.0000,558.4640,23.2693,24.8750,1.5000,1.00,0.0000,24000.00,'','',1,0),
  ('06964bc8-61fe-45ff-b4ca-17620962be3b','স্প্রীড ২০০ মিলি','493.84',24,'কেস',493.8400,470.7600,19.6150,20.5767,2.0000,1.00,0.0000,4800.00,'','',2,0),
  ('06995d74-8d0c-4b09-9549-59690bc996c8','মোজো ২০০০ মিলি','594',6,'কেস',594.0000,581.5380,96.9230,99.0000,0.0000,1.00,0.0000,600.00,'','',3,0),
  ('cd6b9e26-e997-40b2-9558-a35fd57c34ff','ক্লেমন ২০০০ মিলি','587',6,'কেস',587.0000,581.5380,96.9230,97.8333,0.0000,1.00,0.0000,300.00,'','',4,0),
  ('ade16f1a-19a6-4e59-98f0-b2d341a8e72b','আফি অরেঞ্জ ২৫০ মিলি','406',24,'কেস',406.0000,383.0760,15.9615,16.9167,2.0000,1.00,0.0000,600.00,'','',5,0),
  ('3162952c-7017-4fa5-84be-d3a233d654b3','ক্লিয়ার আপ ২৫০ মিলি','406',24,'কেস',406.0000,383.0760,15.9615,16.9167,2.0000,1.00,0.0000,1200.00,'','',6,0),
  ('cb7782a3-d78d-4247-b539-b4e5a2281a4d','লেমু ২৫০ মিলি','410',24,'কেস',410.0000,387.6920,16.1538,17.0833,2.0000,1.00,0.0000,600.00,'','',7,0),
  ('df14f162-9d22-4abe-8716-3c91a7c9e3f7','ফিজো ২৫০ মিলি','600',24,'কেস',600.0000,565.8460,23.5769,25.0000,2.0000,1.00,0.0000,600.00,'','',8,0),
  ('72f2c73d-25cf-475f-9bc0-5d1987c87db5','প্যাকেট জুস ১৮০ মিলি','748',48,'কেস',748.0000,706.0000,14.7083,15.5833,4.0000,1.00,0.0000,480.00,'','',9,0),
  ('73b12f3b-9b31-4ae8-a5af-de47d90e2261','আফি জুস ১৮০ মিলি','392',24,'কেস',392.0000,369.2300,15.3846,16.3333,2.0000,1.00,0.0000,240.00,'','',10,0),
  ('47bac1ed-2b93-4a6d-8a6b-ee5cfce0f352','আফি জুস ২৫০ মিলি','457',24,'কেস',457.0000,430.1880,17.9245,19.0417,2.5000,1.00,0.0000,600.00,'','',11,0),
  ('0e582280-af50-4d72-a80f-014c81dae6ae','আফি জুস ৫০০ মিলি','443',12,'কেস',443.0000,417.2300,34.7692,36.9167,1.0000,1.00,0.0000,120.00,'','',12,0),
  ('1a034f0d-6c3d-49ec-94ce-9a50c9094fdc','আফি জুস ১০০০ মিলি','420',6,'কেস',420.0000,496.0000,82.6667,70.0000,0.5000,1.00,0.0000,60.00,'','',13,0),
  ('90e5121d-5890-4431-928e-ecb91a250eae','স্পা ৩৩০ মিলি','170',24,'কেস',170.0000,158.0000,6.5833,7.0833,0.0000,1.00,0.0000,120.00,'','',14,0),
  ('faa00431-e1eb-42f8-9ce6-49e249267c5f','স্পা ৫০০ মিলি','220',24,'কেস',220.0000,206.0000,8.5833,9.1667,0.0000,1.00,0.0000,1200.00,'','',15,0),
  ('dfbbb78f-dd1a-4765-9e17-b1b4d2a563f8','স্পা ১০০০ মিলি','220',12,'কেস',220.0000,204.0000,17.0000,18.3333,1.0000,1.00,0.0000,600.00,'','',16,0),
  ('84fda4fe-3d3f-4428-8f3c-21ec5913ea32','স্পা ২০০০ মিলি','157',6,'কেস',157.0000,144.9230,24.1538,26.1667,0.5000,1.00,0.0000,300.00,'','',17,0),
  ('686921f3-ada3-4a30-bf5a-7cd767b7a89d','স্পা ৫০০০ মিলি','130',2,'কেস',130.0000,120.0000,60.0000,65.0000,0.0000,1.00,0.0000,20.00,'','',18,0),
  ('45c90f8c-00c9-4640-84d0-0d6ea29f1a51','মোজোরেলা চিপস','384',48,'পলি',384.0000,372.9230,7.7692,8.0000,4.0000,1.00,0.0000,720.00,'','',19,0),
  ('f04d48a7-ff2a-4c85-9f4d-6679a3350508','ও পটাটা চিপস','310',20,'পলি',310.0000,291.8180,14.5909,15.5000,2.0000,1.00,0.0000,100.00,'','',20,0),
  ('e8269625-67d3-4a5c-94dc-7a084346f387','সুইট টোস্ট','300',6,'কার্টুন',300.0000,288.0000,48.0000,50.0000,0.5000,1.00,0.0000,30.00,'','',21,0),
  ('e3bf2bd6-f5b0-4bde-9e8a-89603f17fb96','প্লেইন টোস্ট','276',6,'কার্টুন',276.0000,261.2300,43.5383,46.0000,0.5000,1.00,0.0000,30.00,'','',22,0),
  ('4e4b3a38-10af-41ac-b187-df8fd044dda6','আফি ম্যাংগো চাটনি','48',12,'ডজন',48.0000,46.0270,3.8356,4.0000,0.5000,1.00,0.0000,420.00,'','',23,0),
  ('9007f250-440d-45cf-a977-34487a00f7b7','আফি জলপাই চাটনি','48',12,'ডজন',48.0000,46.0270,3.8356,4.0000,0.5000,1.00,0.0000,840.00,'','',24,0),
  ('b179345d-d5c6-4214-9734-09592384eed3','আফি তেতুল চাটনি','48',12,'ডজন',48.0000,46.0270,3.8356,4.0000,0.5000,1.00,0.0000,840.00,'','',25,0),
  ('a3a4403d-5916-41be-b2b7-7d1779e5e330','আফি ম্যাঙ্গো বার','120',30,'কেস',120.0000,115.9090,3.8636,4.0000,3.0000,1.00,0.0000,1500.00,'','',26,0),
  ('a382406c-e2cc-42ce-8f28-7d115389d83a','আভি ডাল ভাজা','192',48,'কেস',192.0000,47.2500,0.9844,4.0000,0.0000,1.00,0.0000,384.00,'','',27,0),
  ('5848e8c6-dc19-4da0-86d0-41fc6bfb088f','আফি চানাচুর','752',96,'পলি',752.0000,710.7690,7.4038,7.8333,4.0000,1.00,0.0000,288.00,'','',28,0),
  ('d5734163-8e6e-4620-8646-1210f7bd54ba','মোজো ৩৩০ মিলি ক্যান','1152',24,'কেস',1152.0000,1089.2300,45.3846,48.0000,2.0000,1.00,0.0000,72.00,'','',29,0),
  ('3461f836-14af-4152-b8aa-d9e73bcd5a7c','ওয়াইল্ড ব্রু ২৫০ মিলি','1329',24,'কেস',1329.0000,1240.6150,51.6923,55.3750,2.0000,1.00,0.0000,72.00,'','',30,0),
  ('f508de87-672f-4395-ac4e-807c5a7580cb','ওয়াইল্ড ব্রু ৩৩০ মিলি','1883',24,'কেস',1883.0000,1772.3070,73.8461,78.4583,2.0000,1.00,0.0000,72.00,'','',31,0),
  ('566f8b93-31bc-4da7-8cf6-b7c5f9bb0e1c','ওয়াইল্ড ব্রু ৩৩০ মিলি পিচ মল্ট','1883',24,'কেস',1883.0000,1772.3070,73.8461,78.4583,2.0000,1.00,0.0000,72.00,'','',32,0),
  ('5c4b207c-3c7e-43b5-b031-210569a91287','ওয়াইল্ড ব্রু ৩৩০ মিলি অ্যাপেল মল্ড','1883',24,'কেস',1883.0000,1772.3070,73.8461,78.4583,2.0000,1.00,0.0000,72.00,'','',33,0),
  ('b20eb0f7-ebec-4fd5-9f60-115cbd37927e','গ্রীন অ্যাপেল ২৫০ মিলি','1190',24,'কেস',1190.0000,1130.7690,47.1154,49.5833,2.0000,1.00,0.0000,120.00,'','',34,0),
  ('898f20a4-20f0-4ae1-9690-b32d7dfce32b','জিন্জার ২৫০ মিলি','1190',24,'কেস',1190.0000,1130.7690,47.1154,49.5833,2.0000,1.00,0.0000,120.00,'','',35,0)
ON CONFLICT (id) DO NOTHING;

-- ═══ v4.9 — speed + DU consistency ═══
-- 1) One exact, fast lifetime-due query used by EVERY panel
--    (Owner / Manager / SO / DSR) — replaces downloading the whole
--    transactions + payments tables into the server on each page load.
CREATE OR REPLACE FUNCTION dsr_due_totals(p_sr_ids TEXT[] DEFAULT NULL)
RETURNS TABLE (
  sr_id        TEXT,
  given_rev    NUMERIC,
  return_rev   NUMERIC,
  given_units  NUMERIC,
  return_units NUMERIC,
  paid         NUMERIC
)
LANGUAGE sql STABLE AS $$
  WITH t AS (
    SELECT tx.sr_id,
           COALESCE(SUM(CASE WHEN tx.type = 'give'   THEN tx.total_revenue END), 0) AS given_rev,
           COALESCE(SUM(CASE WHEN tx.type = 'return' THEN tx.total_revenue END), 0) AS return_rev,
           COALESCE(SUM(CASE WHEN tx.type = 'give'   THEN tx.total_units   END), 0) AS given_units,
           COALESCE(SUM(CASE WHEN tx.type = 'return' THEN tx.total_units   END), 0) AS return_units
      FROM transactions tx
     WHERE tx.type IN ('give', 'return')
       AND tx.sr_id <> ''
       AND (p_sr_ids IS NULL OR tx.sr_id = ANY (p_sr_ids))
     GROUP BY tx.sr_id
  ), p AS (
    SELECT sp.sr_id, COALESCE(SUM(sp.amount), 0) AS paid
      FROM sr_payments sp
     WHERE sp.sr_id <> ''
       AND (p_sr_ids IS NULL OR sp.sr_id = ANY (p_sr_ids))
     GROUP BY sp.sr_id
  )
  SELECT COALESCE(t.sr_id, p.sr_id),
         COALESCE(t.given_rev, 0),  COALESCE(t.return_rev, 0),
         COALESCE(t.given_units, 0), COALESCE(t.return_units, 0),
         COALESCE(p.paid, 0)
    FROM t FULL OUTER JOIN p ON p.sr_id = t.sr_id;
$$;
GRANT EXECUTE ON FUNCTION dsr_due_totals(TEXT[]) TO service_role;

-- 2) Composite indexes for the queries that run on every screen load.
CREATE INDEX IF NOT EXISTS idx_tx_sr_type_date   ON transactions(sr_id, type, date);
CREATE INDEX IF NOT EXISTS idx_tx_date_type      ON transactions(date, type);
CREATE INDEX IF NOT EXISTS idx_pay_sr_date       ON sr_payments(sr_id, date);
CREATE INDEX IF NOT EXISTS idx_due_dsr_client    ON due_calendar(dsr_id, client_type, status);
CREATE INDEX IF NOT EXISTS idx_due_shop_status   ON due_calendar(shop_id, status);
CREATE INDEX IF NOT EXISTS idx_due_created       ON due_calendar(created_at);
CREATE INDEX IF NOT EXISTS idx_shops_created     ON shops(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shops_name_lower  ON shops(lower(name));
CREATE INDEX IF NOT EXISTS idx_tx_created        ON transactions(created_at);

-- ═══ v5.0 — Shop ledger (লেনদেন খাতা) ═══
-- 1) each shop due remembers which sale created it, so a memo can list the products.
--    Older dues without it are still matched automatically by shop + date + amount.
ALTER TABLE due_calendar ADD COLUMN IF NOT EXISTS tx_id TEXT DEFAULT '';
-- 2) indexes so opening one shop's ledger stays fast with years of history
CREATE INDEX IF NOT EXISTS idx_due_tx            ON due_calendar(tx_id);
CREATE INDEX IF NOT EXISTS idx_tx_shop_type      ON transactions(shop_id, type, created_at);
CREATE INDEX IF NOT EXISTS idx_tx_txid           ON transactions(tx_id);
CREATE INDEX IF NOT EXISTS idx_duecol_shop       ON due_collections(shop_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dmgcol_shop       ON damage_collections(shop_id, created_at);

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
           SUM(CASE WHEN tx.type IN ('give','dsr_sale_return') THEN tx.total_units ELSE -tx.total_units END) AS q,
           SUM(CASE WHEN tx.type = 'give' THEN tx.total_units   ELSE 0 END) AS gu,
           SUM(CASE WHEN tx.type = 'give' THEN tx.total_revenue ELSE 0 END) AS gr
      FROM transactions tx
     WHERE tx.sr_id = p_dsr_id AND tx.date <= p_upto AND tx.type IN ('give','return','dsr_sale','dsr_sale_return')
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


-- ===== v5.18.1 performance helpers (same as migrations/004_perf.sql) =====
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


-- =====================================================================
-- v5.24 - v5.27 additions (offer snapshot, price history)
-- =====================================================================
-- v5.25: company-offer snapshot on every sale/return line (same as migrations/006_v5_25_offer.sql)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS offer_case_price         NUMERIC(14,4);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS offer_deduction_per_case NUMERIC(14,4);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS offer_deduction_total    NUMERIC(14,4);

-- v5.24: price / offer change history (the app also works without this table)
CREATE TABLE IF NOT EXISTS product_price_history (
  id           BIGSERIAL PRIMARY KEY,
  product_id   TEXT NOT NULL,
  product_name TEXT DEFAULT '',
  field        TEXT NOT NULL,
  old_value    NUMERIC(14,4) DEFAULT 0,
  new_value    NUMERIC(14,4) DEFAULT 0,
  changed_by   TEXT DEFAULT '',
  changed_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pph_product ON product_price_history (product_id, changed_at DESC);
ALTER TABLE product_price_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "srv_product_price_history" ON product_price_history;
CREATE POLICY "srv_product_price_history" ON product_price_history FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Company offer payments, the offer start date and the legacy-freeze flag live in
-- app_settings.profit_rules._store (JSONB) -- nothing else to create.
