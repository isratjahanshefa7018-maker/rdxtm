// api/_lib/money.js — v5.1
// ONE place that turns "what the screen sent" into "what gets stored".
//
//  CALC-5  prices / costs are read from the products table on the server;
//          numbers sent by the browser are ignored (except the buy-price of a
//          purchase, which is genuinely typed in by the owner).
//  CALC-6  money is rounded per bill line to 2 decimals, and whole cases are
//          priced from the case price (406 / 24 = 16.9167 no longer leaves
//          406.0008 behind).
//  CALC-3  every sale row also remembers the bonus rule that was valid on
//          that day, so editing a product later cannot rewrite old bonus.
//
// This file lives in api/_lib/ so it does NOT count as a 13th serverless
// function on the Vercel Hobby plan.
const { supabase, num, fetchAll } = require('./db');
const snap = require('./snapshot');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const r2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
const r4 = (n) => Math.round((num(n) + Number.EPSILON) * 10000) / 10000;

const PRODUCT_COLS = 'id,name,sku,case_size,case_price,case_purchase_price,purchase_price,selling_price,' +
  'bonus_free_units,bonus_cases_req,bonus_free_money,current_stock';

// { [productId]: productRow } for the ids that are real UUIDs.
async function loadProducts(ids) {
  const list = [...new Set((ids || []).map(String).filter(x => UUID_RE.test(x)))];
  const map = {};
  for (let i = 0; i < list.length; i += 100) {
    const { data, error } = await supabase.from('products').select(PRODUCT_COLS).in('id', list.slice(i, i + 100));
    if (error) throw error;
    (data || []).forEach(p => { map[String(p.id)] = p; });
  }
  return map;
}

// Money for `units` pieces of a product.
//   * whole cases are charged at the case price
//   * the loose remainder at the per-piece price
//   * `unitPriceOverride` (used for returns at the price the DSR was charged)
//     simply multiplies.
// Always rounded to 2 decimals per line.
function lineMoney(prod, units, kind /* 'sell' | 'buy' */, unitPriceOverride) {
  units = num(units);
  const cs = num(prod && prod.case_size) || 1;
  const unit = kind === 'buy' ? num(prod && prod.purchase_price) : num(prod && prod.selling_price);
  if (unitPriceOverride !== undefined && unitPriceOverride !== null) return r2(units * num(unitPriceOverride));
  const casePrice = (kind === 'buy' ? num(prod && prod.case_purchase_price) : num(prod && prod.case_price)) || unit * cs;
  const whole = Math.floor(units / cs + 1e-9);
  const rem = units - whole * cs;
  return r2(whole * casePrice + rem * unit);
}

// Pieces for an item. cases/pcs win when present (the screen always sends
// both), otherwise totalUnits is used.
function itemUnits(item, prod) {
  const cs = num(prod && prod.case_size) || 1;
  const cases = num(item.cases), pcs = num(item.pcs);
  if (cases !== 0 || pcs !== 0) return r4(cases * cs + pcs);
  return r4(num(item.totalUnits));
}

// Price the DSR was actually charged for the stock he is handing back:
// the weighted average of his most recent loading day for each product
// (falls back to the current catalogue price).
async function weightedGivePrices(srId, productIds, uptoDate) {
  const out = {};
  const ids = [...new Set((productIds || []).map(String).filter(Boolean))];
  if (!srId || !ids.length) return out;
  const rows = await fetchAll(() => {
    let q = supabase.from('transactions').select('product_id,date,total_units,total_revenue')
      .eq('sr_id', String(srId)).eq('type', 'give').in('product_id', ids);
    if (uptoDate) q = q.lte('date', uptoDate);
    return q.order('date', { ascending: false });
  });
  const latest = {};
  (rows || []).forEach(r => {
    const k = String(r.product_id), d = String(r.date).slice(0, 10);
    if (!latest[k] || d > latest[k]) latest[k] = d;
  });
  const acc = {};
  (rows || []).forEach(r => {
    const k = String(r.product_id), d = String(r.date).slice(0, 10);
    if (d !== latest[k]) return;
    const a = acc[k] || (acc[k] = { u: 0, v: 0 });
    a.u += num(r.total_units); a.v += num(r.total_revenue);
  });
  Object.keys(acc).forEach(k => { if (acc[k].u > 0) out[k] = acc[k].v / acc[k].u; });
  return out;
}

// v5.24 — same as weightedGivePrices but ALSO returns the buy price (cost) and the offer rule of that loading day,
// so a return never re-prices cost / case size at today's product values.
async function weightedGiveSnap(srId, productIds, uptoDate) {
  const out = {};
  const ids = [...new Set((productIds || []).map(String).filter(Boolean))];
  if (!srId || !ids.length) return out;
  const run = (cols) => fetchAll(() => {
    let q = supabase.from('transactions').select(cols).eq('sr_id', String(srId)).eq('type', 'give').in('product_id', ids);
    if (uptoDate) q = q.lte('date', uptoDate);
    return q.order('date', { ascending: false });
  });
  let rows;
  try { rows = await run('product_id,date,total_units,total_revenue,total_cost,rule_case_size,rule_bonus_cases_req,rule_bonus_free_units,rule_bonus_free_money'); }
  catch (e) { rows = await run('product_id,date,total_units,total_revenue,total_cost'); }
  const latest = {};
  (rows || []).forEach(r => { const k = String(r.product_id), d = String(r.date).slice(0, 10); if (!latest[k] || d > latest[k]) latest[k] = d; });
  const acc = {};
  (rows || []).forEach(r => {
    const k = String(r.product_id), d = String(r.date).slice(0, 10);
    if (d !== latest[k]) return;
    const a = acc[k] || (acc[k] = { u: 0, v: 0, c: 0, rule: null });
    a.u += num(r.total_units); a.v += num(r.total_revenue); a.c += num(r.total_cost);
    if (!a.rule && r.rule_case_size != null) a.rule = { rule_case_size: num(r.rule_case_size), rule_bonus_cases_req: r.rule_bonus_cases_req, rule_bonus_free_units: r.rule_bonus_free_units, rule_bonus_free_money: r.rule_bonus_free_money };
  });
  Object.keys(acc).forEach(k => { if (acc[k].u > 0) out[k] = { sp: acc[k].v / acc[k].u, pp: acc[k].c / acc[k].u, rule: acc[k].rule, cs: acc[k].rule ? num(acc[k].rule.rule_case_size) : 0 }; });
  return out;
}

// Turn the items array of a request into trusted lines.
//   opts.type            transaction type (decides which prices are used)
//   opts.srId / opts.date  needed for 'return' (price-at-give lookup)
// Returns { ok:true, lines, products } or { ok:false, error }.
async function priceItems(items, opts) {
  opts = opts || {};
  const type = opts.type || '';
  if (!Array.isArray(items) || !items.length) return { ok: false, error: 'কমপক্ষে একটি আইটেম দিন' };
  const prods = await loadProducts(items.map(i => i && i.productId));
  // v5.24 — a RETURN is priced from the ORIGINAL sale's snapshot, never from today's product fields.
  //   return               → the DSR's latest loading (give rows)
  //   dsr_sale_return      → latest dsr_sale of that shop (+DSR)
  //   point_damage_return  → latest point_sale of that shop / customer
  // Nothing found → falls back to the current product values (a brand-new line).
  let snaps = {};
  if (type === 'return' && opts.srId) snaps = await weightedGiveSnap(opts.srId, Object.keys(prods), opts.date);
  else if (type === 'dsr_sale_return' && opts.shopId) snaps = await snap.latestSaleSnapshots({ shopId: opts.shopId, srId: opts.srId }, ['dsr_sale'], Object.keys(prods), opts.date);
  else if (type === 'point_damage_return' && (opts.shopId || opts.customerId)) snaps = await snap.latestSaleSnapshots({ shopId: opts.shopId, customerId: opts.shopId ? '' : opts.customerId }, ['point_sale'], Object.keys(prods), opts.date);
  const givePrice = {}; Object.keys(snaps).forEach(k => { givePrice[k] = snaps[k].sp; });
  const lines = [];
  for (const item of items) {
    const pid = String((item && item.productId) || '');
    const prod = prods[pid];
    if (!prod) return { ok: false, error: 'পণ্য পাওয়া যায়নি' };
    const name = prod.name || 'পণ্য';
    const rawU = num(item.totalUnits), rawC = num(item.cases), rawP = num(item.pcs);
    if (rawU < 0 || rawC < 0 || rawP < 0) return { ok: false, error: name + ' — ঋণাত্মক পরিমাণ দেওয়া যাবে না' };
    const units = itemUnits(item, prod);
    if (units <= 0) return { ok: false, error: name + ' — পরিমাণ ০-এর বেশি হতে হবে' };

    let spOverride = null, revenue, cost, sp, pp;
    if (givePrice[pid] !== undefined) spOverride = givePrice[pid];   // v5.24: every return type prices from the original sale
    if (spOverride !== null) { sp = spOverride; revenue = lineMoney(prod, units, 'sell', spOverride); }
    else { sp = num(prod.selling_price); revenue = lineMoney(prod, units, 'sell'); }

    const sn = snaps[pid] || null;
    if (sn && type !== 'buy' && num(sn.pp) > 0) { pp = num(sn.pp); cost = r2(units * pp); }
    else if (type === 'buy' && num(item.purchasePrice) > 0) {
      // the owner types the real invoice price of a purchase
      pp = num(item.purchasePrice); cost = r2(units * pp);
    } else {
      pp = num(prod.purchase_price); cost = lineMoney(prod, units, 'buy');
    }
    const cs = num(prod.case_size) || 1;
    lines.push({
      prod, productId: pid, productName: prod.name || '', sku: prod.sku || '',
      units, cases: Math.floor(units / cs + 1e-9), pcs: r4(units - Math.floor(units / cs + 1e-9) * cs),
      sellingPrice: r4(sp), purchasePrice: r4(pp), revenue, cost,
      commission: num(item.commission), discount: num(item.discount),
      // rule of the original sale (returns). A legacy source (no snapshot) → no offer, case size kept.
      rule: sn ? (sn.rule || { rule_case_size: sn.cs || num(prod.case_size) || 1, rule_bonus_cases_req: 0, rule_bonus_free_units: 0, rule_bonus_free_money: 0 }) : null
    });
  }
  return { ok: true, lines, products: prods };
}

// Columns every sale-type row carries so bonus uses the rule of THAT day.
function bonusSnapshot(prod) {
  return {
    rule_case_size: num(prod.case_size) || 1,
    rule_bonus_cases_req: num(prod.bonus_cases_req) || 1,
    rule_bonus_free_units: num(prod.bonus_free_units),
    rule_bonus_free_money: num(prod.bonus_free_money)
  };
}

// Base transaction row from a priced line.
function txRow(line, base) {
  return Object.assign({
    product_id: line.productId, product_name: line.productName, sku: line.sku,
    cases: line.cases, pcs: line.pcs, total_units: line.units,
    purchase_price: line.purchasePrice, selling_price: line.sellingPrice,
    total_cost: line.cost, total_revenue: line.revenue
  }, line.rule || bonusSnapshot(line.prod), base);
}

// Stock check for outgoing movements (give / point_sale / return_company).
// Returns an error string or ''. The database trigger is the real guard
// (race-proof); this gives a readable message before anything is written.
function stockShortage(lines) {
  const want = {};
  lines.forEach(l => { want[l.productId] = (want[l.productId] || 0) + l.units; });
  for (const l of lines) {
    const have = num(l.prod.current_stock);
    if (want[l.productId] > have + 0.0001) {
      return (l.prod.name || 'পণ্য') + ' — স্টকে আছে ' + have + ' পিস, কিন্তু ' + want[l.productId] + ' পিস লাগবে';
    }
  }
  return '';
}

module.exports = { weightedGiveSnap, r2, r4, UUID_RE, loadProducts, lineMoney, itemUnits, weightedGivePrices, priceItems, bonusSnapshot, txRow, stockShortage };
