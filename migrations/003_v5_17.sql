-- v5.17 — run this ONLY when upgrading an existing database (a brand-new deploy uses schema_fresh.sql,
-- which already contains this). Safe to run more than once. Never deletes data.
--
-- Adds the new transaction type 'dsr_sale_return' (বিক্রয় ফেরত): a shop hands goods back to the DSR,
-- the goods go back onto the DSR's van and the shop's due goes down.

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('give','return','damage','buy','point_sale','point_damage_return','dsr_sale','dsr_sale_return','return_company'));

-- Van stock: a sale-return puts the goods back on the van (+), exactly like 'give'.
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
