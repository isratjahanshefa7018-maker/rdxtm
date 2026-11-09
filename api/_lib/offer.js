// api/_lib/offer.js — v5.25.0 (Session 1: automatic company-offer deduction)
// Helper only (not a serverless function → API count stays 12).
//
// Offer per product: for every X cases the shop would get F free bottles + M free money. The shop still
// receives real bottles; we lower the SHOP PRICE instead and the company pays us later.
//   P = price of one case (before manual commission/discount), U = bottles per case
//   f = F/X, m = M/X
//   value per bottle   = P / (U + f)
//   case price (shop)  = value per bottle * U - m
//   deduction per case = P - case price
// Only whole qualifying cases count (loose bottles get nothing). Total is rounded ONCE from the exact
// per-case value (cumulative method), so 10 cases never drift from 10 x a rounded per-case number.
//
// Storage: optional transactions columns (migration 006) — or, when the columns are not there, a compact map
// in the settings store (app_settings.profit_rules._store._offerLines). Old rows / legacy rows simply have
// no entry = no offer.
const { supabase, num } = require('./db');
const snap = require('./snapshot');

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STORE_MAX = 20000;
const OFFER_COLS = 'offer_case_price,offer_deduction_per_case,offer_deduction_total';

// snapshot: { sellPrice(P per case), unitsPerCase, offerCasesReq, offerFreeUnits, offerFreeMoney }
// → { qualifyingCases, exactPerCase, perCase, total, valuePerBottle, shopPricePerCase }
function calcOfferDeduction(snapshot, casesSold) {
  const s = snapshot || {};
  const P = num(s.sellPrice), U = num(s.unitsPerCase) || 0;
  const X = num(s.offerCasesReq), F = num(s.offerFreeUnits), M = num(s.offerFreeMoney);
  const zero = { qualifyingCases: 0, exactPerCase: 0, perCase: 0, total: 0, valuePerBottle: 0, shopPricePerCase: r2(P) };
  if (!(P > 0) || !(U > 0) || !(X > 0) || !(F > 0 || M > 0)) return zero;
  const whole = Math.floor(num(casesSold) + 1e-9);
  const q = X > 1 ? Math.floor(whole / X + 1e-9) * X : whole;      // only full qualifying groups of cases
  const f = F / X, m = M / X;
  const value = P / (U + f);
  const shop = value * U - m;
  const exact = P - shop;                                           // unrounded deduction per case
  if (!(exact > 0) || q <= 0) return Object.assign({}, zero, { exactPerCase: exact > 0 ? exact : 0, perCase: exact > 0 ? r2(exact) : 0, valuePerBottle: r4(value), shopPricePerCase: r2(shop) });
  return { qualifyingCases: q, exactPerCase: exact, perCase: r2(exact), total: r2(exact * q), valuePerBottle: r4(value), shopPricePerCase: r2(shop) };
}

// Reverse part of an earlier deduction (a return): proportional to whole cases returned, from the ORIGINAL snapshot.
// capTotal (optional) = the original line's total, never reversed beyond it.
function reverseOfferDeduction(snapshot, casesReturned, capTotal) {
  const s = snapshot || {};
  const X = num(s.offerCasesReq) || 1;
  const exact = calcOfferDeduction(s, X).exactPerCase;                          // exact rate per case = P - shop price (already /X)
  const whole = Math.floor(num(casesReturned) + 1e-9);
  let total = exact > 0 && whole > 0 ? r2(exact * whole) : 0;
  if (capTotal !== undefined && capTotal !== null && num(capTotal) >= 0) total = Math.min(total, r2(capTotal));
  return { perCase: r2(exact), total, cases: whole };
}

// price of ONE case as charged (before commission/discount): the product's case price, else price/piece x U
function casePriceOf(prod) {
  const cs = num(prod && prod.case_size) || 1;
  return num(prod && prod.case_price) || num(prod && prod.selling_price) * cs;
}

// ── settings: the start date ─────────────────────────────────────────
async function getStartDate() { const st = await snap.storeRead(); const d = st && st.offerStart; return d && DATE_RE.test(d) ? d : ''; }
function applies(date, start) { return !!start && DATE_RE.test(String(date || '').slice(0, 10)) && String(date).slice(0, 10) >= start; }

// ── probe: do the optional columns exist? (cached) ───────────────────
let _colsOk = null;
async function columnsOk() {
  if (_colsOk === null) { const { error } = await supabase.from('transactions').select('offer_deduction_total').limit(1); _colsOk = !error; }
  return _colsOk;
}
function _resetProbe() { _colsOk = null; }
function _setColumns(v) { _colsOk = v; }   // tests

// ── apply to freshly priced lines (money.js priceItems output) ────────
// opts: { type, date, start }. Adds line.offer = { casePrice, perCase, total, ... } and returns the sum.
// Only 'dsr_sale' and 'point_sale' get a NEW deduction. Returns are handled by applyReturnOffers.
function applyOffers(lines, opts) {
  opts = opts || {};
  let sum = 0;
  (lines || []).forEach(l => {
    l.offer = null;
    if (!applies(opts.date, opts.start)) return;
    const p = l.prod || {}, cs = num(p.case_size) || 1;
    const rule = l.rule || {};   // sale lines: rule = null (txRow uses the product's bonusSnapshot) → use the product
    const X = rule.rule_bonus_cases_req !== undefined ? num(rule.rule_bonus_cases_req) : (num(p.bonus_cases_req) || 1);
    const F = rule.rule_bonus_free_units !== undefined ? num(rule.rule_bonus_free_units) : num(p.bonus_free_units);
    const M = rule.rule_bonus_free_money !== undefined ? num(rule.rule_bonus_free_money) : num(p.bonus_free_money);
    const P = casePriceOf(p);
    const c = calcOfferDeduction({ sellPrice: P, unitsPerCase: cs, offerCasesReq: X, offerFreeUnits: F, offerFreeMoney: M }, l.cases);
    if (c.total > 0) { l.offer = { casePrice: r2(P), perCase: c.perCase, total: c.total, qualifyingCases: c.qualifyingCases, exactPerCase: c.exactPerCase }; sum += c.total; }
  });
  return r2(sum);
}

// Returns: reverse the deduction of the ORIGINAL sale snapshot. src = { [productId]: {casePrice, units, cs, X, F, M, perCase, total, casesSold} }
// (built by sourceOffers). Lines without a source get nothing.
function applyReturnOffers(lines, src) {
  let sum = 0;
  (lines || []).forEach(l => {
    l.offer = null;
    const s = src && src[l.productId]; if (!s || !(s.total > 0)) return;
    const snapshot = { sellPrice: s.casePrice, unitsPerCase: s.cs, offerCasesReq: s.X, offerFreeUnits: s.F, offerFreeMoney: s.M };
    const rv = reverseOfferDeduction(snapshot, l.cases);   // rate comes from the original snapshot; the return-quantity check already limits cases
    if (rv.total > 0) { l.offer = { casePrice: r2(s.casePrice), perCase: rv.perCase, total: rv.total, qualifyingCases: rv.cases, exactPerCase: 0, returned: true }; sum += rv.total; }
  });
  return r2(sum);
}

// ── write: remember the offer snapshot of every row ───────────────────
// rows were just inserted (tx_id + product_id identify a line). Updates the columns, or the store when no columns.
async function persist(txId, lines) {
  const by = {};
  (lines || []).filter(l => l.offer && l.offer.total > 0).forEach(l => {           // same product twice on one bill → one entry (summed)
    const b = by[l.productId] || (by[l.productId] = { productId: l.productId, offer: { casePrice: l.offer.casePrice, perCase: l.offer.perCase, total: 0 } });
    b.offer.total = r2(b.offer.total + l.offer.total);
  });
  const list = Object.values(by);
  if (!list.length) return { ok: true, n: 0 };
  if (await columnsOk()) {
    for (const l of list) {
      let ok = false;
      for (let t = 0; t < 2 && !ok; t++) {
        const { error } = await supabase.from('transactions').update({
          offer_case_price: l.offer.casePrice, offer_deduction_per_case: l.offer.perCase, offer_deduction_total: l.offer.total
        }).eq('tx_id', txId).eq('product_id', l.productId);
        ok = !error;
      }
      if (!ok) return { ok: false, n: 0 };
    }
    return { ok: true, n: list.length, mode: 'columns' };
  }
  const st = await snap.storeRead();
  const m = Object.assign({}, st._offerLines || {});
  list.forEach(l => { m[txId + '|' + l.productId] = [l.offer.casePrice, l.offer.perCase, l.offer.total]; });
  const keys = Object.keys(m);
  if (keys.length > STORE_MAX) keys.slice(0, keys.length - STORE_MAX).forEach(k => delete m[k]);
  const ok = await snap.storeWrite({ _offerLines: m });
  return { ok, n: list.length, mode: 'store' };
}

// ── read: fill raw transaction rows (snake_case) with offer_* fields ──
// Rows that already carry the column value keep it; others are looked up in the store. Never throws.
async function hydrate(rows) {
  rows = rows || [];
  try {
    const need = rows.filter(r => r && (r.type === 'dsr_sale' || r.type === 'point_sale' || r.type === 'dsr_sale_return' || r.type === 'point_damage_return') && r.offer_deduction_total === undefined);
    if (!need.length) return rows;
    const st = await snap.storeRead(), m = st._offerLines || {};
    need.forEach(r => {
      const v = m[String(r.tx_id) + '|' + String(r.product_id)];
      r.offer_case_price = v ? v[0] : 0; r.offer_deduction_per_case = v ? v[1] : 0; r.offer_deduction_total = v ? v[2] : 0;
    });
  } catch (e) { /* no store → no offer */ }
  return rows;
}
const dedOf = (r) => (r && r.offer_deduction_total != null ? r2(num(r.offer_deduction_total)) : 0);
// sign: sale rows add, return rows subtract
function netDeduction(rows) {
  let s = 0;
  (rows || []).forEach(r => { const d = dedOf(r); if (!d) return; s += (r.type === 'dsr_sale_return' || r.type === 'point_damage_return') ? -d : d; });
  return r2(s);
}

// ── source snapshots for returns: { [productId]: {...} } ──────────────
// Uses the latest sale of that shop (+ DSR) for each product (the "original sale" fallback of the spec).
async function sourceOffers(where, types, productIds, uptoDate) {
  const out = {}, ids = [...new Set((productIds || []).map(String).filter(Boolean))];
  if (!ids.length) return out;
  const cols = await columnsOk();
  let q = supabase.from('transactions').select('tx_id,product_id,type,date,created_at,cases,rule_case_size,rule_bonus_cases_req,rule_bonus_free_units,rule_bonus_free_money' + (cols ? ',' + OFFER_COLS : ''))
    .in('type', types).in('product_id', ids);
  if (where.shopId) q = q.eq('shop_id', String(where.shopId));
  if (where.srId) q = q.eq('sr_id', String(where.srId));
  if (uptoDate) q = q.lte('date', uptoDate);
  const { data, error } = await q.order('date', { ascending: false }).order('created_at', { ascending: false }).limit(2000);
  if (error) return out;
  const rows = await hydrate(data || []);
  rows.forEach(r => {
    const k = String(r.product_id); if (out[k]) return;
    const total = dedOf(r);
    out[k] = { total, perCase: r2(num(r.offer_deduction_per_case)), casePrice: num(r.offer_case_price), casesSold: num(r.cases),
      cs: num(r.rule_case_size) || 1, X: num(r.rule_bonus_cases_req) || 1, F: num(r.rule_bonus_free_units), M: num(r.rule_bonus_free_money), txId: String(r.tx_id) };
  });
  return out;
}

// columns for a row insert / the extra fields of a mapped row
async function selCols() { return (await columnsOk()) ? ',' + OFFER_COLS : ''; }
function rowFields(line) {
  return line && line.offer ? { offer_case_price: line.offer.casePrice, offer_deduction_per_case: line.offer.perCase, offer_deduction_total: line.offer.total } : {};
}

module.exports = { calcOfferDeduction, reverseOfferDeduction, casePriceOf, getStartDate, applies, columnsOk, _resetProbe, _setColumns, applyOffers, applyReturnOffers,
  persist, hydrate, selCols, dedOf, netDeduction, sourceOffers, rowFields, OFFER_COLS, r2 };
