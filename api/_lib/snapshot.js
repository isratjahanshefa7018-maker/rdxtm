// api/_lib/snapshot.js — v5.24.0 (Session 0: price-change safety)
// Lives in api/_lib so it is NOT a serverless function (limit stays at 12).
//
// 1. SNAPSHOT  — every sale / point-sale / return row carries the prices + offer rule of the moment it was
//                written (selling_price, purchase_price, rule_case_size, rule_bonus_*; snapshotAt = created_at).
//                History reads ONLY these. A row whose rule_case_size is NULL is a LEGACY row (pre-v5.1).
//                A frozen legacy row has rule_bonus_cases_req = 0 (the "legacy" mark) and no offer.
// 2. HISTORY   — product_price_history table when it exists, otherwise a capped array in the settings store.
// 3. FREEZE    — one-time, owner-confirmed write of prices/case size into legacy rows. Idempotent.
// 4. STORE     — tiny key/value kept inside app_settings.profit_rules._store (JSONB, already in the schema),
//                so no migration is needed.
const { supabase, num, now_, fetchAll } = require('./db');

const noTable = (e) => /42P01|PGRST205|does not exist|schema cache|PGRST204|42703/i.test(String((e && (e.code || '')) + ' ' + String((e && e.message) || '')));
const RULE_COLS = 'rule_case_size,rule_bonus_cases_req,rule_bonus_free_units,rule_bonus_free_money';
const HIST_MAX = 3000;

// ── settings store ───────────────────────────────────────────────────
async function _readPR() {
  try {
    const { data, error } = await supabase.from('app_settings').select('profit_rules').eq('id', 1).maybeSingle();
    if (error) return null;
    return (data && data.profit_rules) || {};
  } catch (e) { return null; }
}
async function storeRead() { const pr = await _readPR(); return (pr && pr._store) || {}; }
async function storeWrite(patch) {
  const pr = await _readPR();
  if (pr === null) return false;                       // column not there → silently skip (app still works)
  const next = Object.assign({}, pr, { _store: Object.assign({}, pr._store || {}, patch) });
  try {
    const { data: ex } = await supabase.from('app_settings').select('id').eq('id', 1).maybeSingle();
    const r = ex ? await supabase.from('app_settings').update({ profit_rules: next }).eq('id', 1)
                 : await supabase.from('app_settings').insert({ id: 1, shop_name: '', profit_rules: next });
    return !r.error;
  } catch (e) { return false; }
}

// ── price history ────────────────────────────────────────────────────
// entry: { productId, productName, field, oldValue, newValue, changedBy, at }
// fields: sellPrice, buyPrice (per case/jar/poly), unitsPerCase, offerFreeUnits, offerCasesReq, offerFreeMoney,
//         commission, discount
async function addPriceHistory(entries) {
  entries = (entries || []).filter(Boolean);
  if (!entries.length) return { table: false, stored: false };
  try {
    const rows = entries.map(e => ({ product_id: String(e.productId), product_name: e.productName || '', field: e.field,
      old_value: num(e.oldValue), new_value: num(e.newValue), changed_by: e.changedBy || '', changed_at: e.at || now_() }));
    const { error } = await supabase.from('product_price_history').insert(rows);
    if (!error) return { table: true, stored: true };
  } catch (e) { /* fall through to the settings store */ }
  const st = await storeRead();
  const arr = Array.isArray(st._priceHistory) ? st._priceHistory : [];
  const add = entries.map(e => ({ p: String(e.productId), n: e.productName || '', f: e.field, o: num(e.oldValue), v: num(e.newValue), by: e.changedBy || '', at: e.at || now_() }));
  const ok = await storeWrite({ _priceHistory: add.concat(arr).slice(0, HIST_MAX) });
  return { table: false, stored: ok };
}
async function readPriceHistory(productId) {
  const out = [];
  try {
    let q = supabase.from('product_price_history').select('*').order('changed_at', { ascending: false }).limit(2000);
    if (productId) q = q.eq('product_id', String(productId));
    const { data, error } = await q;
    if (!error) (data || []).forEach(r => out.push({ productId: String(r.product_id), productName: r.product_name || '', field: r.field,
      oldValue: num(r.old_value), newValue: num(r.new_value), changedBy: r.changed_by || '', at: r.changed_at }));
  } catch (e) { /* no table */ }
  const st = await storeRead();
  (Array.isArray(st._priceHistory) ? st._priceHistory : []).forEach(r => {
    if (productId && String(r.p) !== String(productId)) return;
    out.push({ productId: String(r.p), productName: r.n || '', field: r.f, oldValue: num(r.o), newValue: num(r.v), changedBy: r.by || '', at: r.at });
  });
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// diff of a product row before/after an edit → history entries
function diffProduct(before, after, who, productId, name) {
  const f = [['sellPrice', 'case_price'], ['buyPrice', 'case_purchase_price'], ['unitsPerCase', 'case_size'],
    ['offerFreeUnits', 'bonus_free_units'], ['offerCasesReq', 'bonus_cases_req'], ['offerFreeMoney', 'bonus_free_money'],
    ['commission', 'commission'], ['discount', 'discount']];
  const at = now_(), out = [];
  f.forEach(([field, col]) => {
    if (before[col] === undefined || after[col] === undefined) return;
    const o = num(before[col]), n = num(after[col]);
    if (Math.abs(o - n) > 1e-9) out.push({ productId, productName: name, field, oldValue: o, newValue: n, changedBy: who || '', at });
  });
  return out;
}

// value of a product field as it was ON a date: the OLD value of the first change after that date, else current
function valueOnDate(hist, productId, field, date, current) {
  const end = String(date).slice(0, 10) + 'T23:59:59.999Z';
  let best = null;
  hist.forEach(h => { if (h.productId === String(productId) && h.field === field && String(h.at) > end && (!best || String(h.at) < String(best.at))) best = h; });
  return best ? best.oldValue : current;
}

// ── snapshot of a stored row (what every history screen should read) ──
function snapOfRow(r) {
  if (!r) return null;
  const cs = r.rule_case_size, legacyUnfrozen = (cs === undefined || cs === null);
  const req = num(r.rule_bonus_cases_req), free = num(r.rule_bonus_free_units), money = num(r.rule_bonus_free_money);
  const units = num(r.total_units), unitsPerCase = num(cs) || 1;
  const mult = req > 0 ? Math.floor(Math.floor(units / unitsPerCase + 1e-9) / req + 1e-9) : 0;
  return {
    sellPrice: num(r.selling_price), buyPrice: num(r.purchase_price), unitsPerCase: legacyUnfrozen ? null : unitsPerCase,
    offerCasesReq: legacyUnfrozen ? 0 : req, offerFreeUnits: legacyUnfrozen ? 0 : free, offerFreeMoney: legacyUnfrozen ? 0 : money,
    offerDeductionPerCase: legacyUnfrozen || req <= 0 ? 0 : Math.round(money / req * 100) / 100,
    offerDeductionTotal: legacyUnfrozen ? 0 : Math.round(mult * money * 100) / 100,
    snapshotAt: r.created_at || '', legacy: legacyUnfrozen || req === 0
  };
}

// latest snapshot per product for the ORIGINAL sale of a return.
//   where: { shopId, customerId, srId }  types: ['dsr_sale'] etc.   → { [productId]: {sp, pp, cs, rule, from} }
async function latestSaleSnapshots(where, types, productIds, uptoDate) {
  const out = {}, ids = [...new Set((productIds || []).map(String).filter(Boolean))];
  if (!ids.length) return out;
  const run = async (cols) => fetchAll(() => {
    let q = supabase.from('transactions').select(cols).in('type', types).in('product_id', ids);
    if (where.shopId) q = q.eq('shop_id', String(where.shopId));
    if (where.customerId) q = q.eq('customer_id', String(where.customerId));
    if (where.srId) q = q.eq('sr_id', String(where.srId));
    if (uptoDate) q = q.lte('date', uptoDate);
    return q.order('date', { ascending: false }).order('created_at', { ascending: false });
  }, { tiebreak: null });
  let rows;
  try { rows = await run('product_id,date,created_at,selling_price,purchase_price,' + RULE_COLS); }
  catch (e) { try { rows = await run('product_id,date,created_at,selling_price,purchase_price'); } catch (e2) { rows = []; } }
  (rows || []).forEach(r => {
    const k = String(r.product_id); if (out[k] || num(r.selling_price) <= 0) return;
    const has = r.rule_case_size !== undefined && r.rule_case_size !== null;
    out[k] = { sp: num(r.selling_price), pp: num(r.purchase_price), cs: has ? num(r.rule_case_size) : 0,
      rule: has ? { rule_case_size: num(r.rule_case_size), rule_bonus_cases_req: r.rule_bonus_cases_req, rule_bonus_free_units: r.rule_bonus_free_units, rule_bonus_free_money: r.rule_bonus_free_money } : null,
      from: 'sale' };
  });
  return out;
}

// ── FREEZE ───────────────────────────────────────────────────────────
async function freezeStatus() {
  const st = await storeRead();
  let pending = null;
  try {
    const { count, error } = await supabase.from('transactions').select('id', { count: 'exact', head: true }).is('rule_case_size', null);
    if (!error) pending = count || 0;
  } catch (e) { /* rule columns missing */ }
  return { done: !!(st.freeze && st.freeze.done) && pending === 0, flagDone: !!(st.freeze && st.freeze.done), frozenAt: (st.freeze && st.freeze.at) || '',
    frozenBy: (st.freeze && st.freeze.by) || '', pending, available: pending !== null, remindAfter: st.freezeRemindAt || '' };
}

async function freezeRun(who) {
  const before = await freezeStatus();
  if (!before.available) return { ok: false, error: 'ডাটাবেসে rule_* কলাম নেই (migrations/001_v5_1_fixes.sql আগে চালান)' };
  const startedAt = now_();
  const [prods, hist] = await Promise.all([fetchAll(() => supabase.from('products').select('id,case_size,case_price,case_purchase_price,selling_price,purchase_price')), readPriceHistory()]);
  const pm = {}; (prods || []).forEach(p => { pm[String(p.id)] = p; });
  let frozen = 0;
  for (let guard = 0; guard < 200; guard++) {                // pages of 1000, re-read each time (rows already frozen drop out)
    const { data: rows, error } = await supabase.from('transactions')
      .select('id,type,date,product_id,selling_price,purchase_price').is('rule_case_size', null).order('id').limit(1000);
    if (error) throw error;
    if (!rows || !rows.length) break;
    const groups = {};
    rows.forEach(r => {
      const p = pm[String(r.product_id)], d = String(r.date).slice(0, 10);
      const cs = Math.max(1, Math.round(num(p ? valueOnDate(hist, r.product_id, 'unitsPerCase', d, p.case_size) : 1)) || 1);
      let sp = num(r.selling_price), pp = num(r.purchase_price);
      if (p && sp <= 0 && r.type !== 'buy' && r.type !== 'return_company') sp = +(num(valueOnDate(hist, r.product_id, 'sellPrice', d, p.case_price || num(p.selling_price) * cs)) / cs).toFixed(4);
      if (p && pp <= 0) pp = +(num(valueOnDate(hist, r.product_id, 'buyPrice', d, p.case_purchase_price || num(p.purchase_price) * cs)) / cs).toFixed(4);
      const k = [cs, sp, pp].join('|');
      (groups[k] || (groups[k] = { cs, sp, pp, ids: [] })).ids.push(r.id);
    });
    let progressed = 0;
    for (const g of Object.values(groups)) {
      for (let i = 0; i < g.ids.length; i += 200) {
        // guarded write: only rows that STILL have no snapshot are touched (two tabs / two users are safe)
        const { data: upd, error: ue } = await supabase.from('transactions')
          .update({ rule_case_size: g.cs, rule_bonus_cases_req: 0, rule_bonus_free_units: 0, rule_bonus_free_money: 0, selling_price: g.sp, purchase_price: g.pp })
          .in('id', g.ids.slice(i, i + 200)).is('rule_case_size', null).select('id');
        if (ue) throw ue;
        progressed += (upd || []).length; frozen += (upd || []).length;
      }
    }
    if (!progressed) break;
  }
  const after = await freezeStatus();
  if (after.pending === 0) await storeWrite({ freeze: { done: true, at: startedAt, by: who || '', count: frozen + num(((await storeRead()).freeze || {}).count) } });
  return { ok: true, frozen, pending: after.pending, done: after.pending === 0, frozenAt: startedAt };
}

module.exports = { noTable, RULE_COLS, storeRead, storeWrite, addPriceHistory, readPriceHistory, diffProduct, valueOnDate, snapOfRow, latestSaleSnapshots, freezeStatus, freezeRun };
