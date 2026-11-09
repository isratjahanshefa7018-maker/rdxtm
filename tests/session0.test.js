// Session 0 tests — in-memory fake of the Supabase client (no network). Run: node tests/session0.test.js
const Module = require('module');
const DB = { products: [], transactions: [], app_settings: [{ id: 1, shop_name: '', profit_rules: {} }] };
let seq = 1; const NOTABLES = new Set(['product_price_history']);
function qb(table) {
  const st = { f: [], ord: [], head: false, lim: null, rng: null, op: 'select', pay: null, sel: false };
  const rows = () => {
    let r = (DB[table] || []).filter(x => st.f.every(fn => fn(x)));
    st.ord.forEach(([c, asc]) => r.sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0) * (asc ? 1 : -1)));
    return r;
  };
  const run = () => {
    if (NOTABLES.has(table)) return { data: null, error: { code: '42P01', message: 'relation does not exist' } };
    if (st.op === 'insert') { const a = [].concat(st.pay).map(x => Object.assign({ id: 'id' + (seq++) }, x)); DB[table].push(...a); return { data: a, error: null }; }
    if (st.op === 'update') { const r = rows(); r.forEach(x => Object.assign(x, st.pay)); return { data: st.sel ? r.map(x => ({ id: x.id })) : null, error: null }; }
    let r = rows(); const count = r.length;
    if (st.rng) r = r.slice(st.rng[0], st.rng[1] + 1); if (st.lim != null) r = r.slice(0, st.lim);
    return { data: st.head ? null : r.map(x => Object.assign({}, x)), count, error: null };
  };
  const o = {
    select(c, opt) { if (st.op === 'update') st.sel = true; st.head = !!(opt && opt.head); return o; },
    insert(p) { st.op = 'insert'; st.pay = p; return o; }, update(p) { st.op = 'update'; st.pay = p; return o; }, upsert(p) { st.op = 'insert'; st.pay = p; return o; },
    eq(c, v) { st.f.push(x => String(x[c]) === String(v)); return o; }, neq(c, v) { st.f.push(x => String(x[c]) !== String(v)); return o; },
    in(c, v) { st.f.push(x => v.map(String).includes(String(x[c]))); return o; },
    is(c, v) { st.f.push(x => (x[c] === undefined || x[c] === null) === (v === null)); return o; },
    lte(c, v) { st.f.push(x => String(x[c]) <= String(v)); return o; }, gte(c, v) { st.f.push(x => String(x[c]) >= String(v)); return o; },
    order(c, op) { st.ord.push([c, !(op && op.ascending === false)]); return o; }, limit(n) { st.lim = n; return o; }, range(a, b) { st.rng = [a, b]; return o; },
    maybeSingle() { const r = run(); return Promise.resolve({ data: (r.data || [])[0] || null, error: r.error }); },
    single() { return o.maybeSingle(); }, then(res, rej) { return Promise.resolve(run()).then(res, rej); }
  };
  return o;
}
const orig = Module._load;
Module._load = function (req, ...a) { if (req === '@supabase/supabase-js') return { createClient: () => ({ from: qb, rpc: async () => ({ data: null, error: { message: 'no rpc' } }) }) }; return orig.call(this, req, ...a); };
const { priceItems, txRow } = require('../api/_lib/money');
const snap = require('../api/_lib/snapshot');
const U = '11111111-1111-4111-8111-111111111111';
let pass = 0, fail = 0;
const t = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const sale = async (type, extra) => { const p = await priceItems([{ productId: U, cases: 2, pcs: 0 }], Object.assign({ type }, extra || {})); const rows = p.lines.map(l => txRow(l, Object.assign({ type, date: '2026-11-08', created_at: new Date().toISOString(), shop_id: 'S1', sr_id: 'D1' }, extra && extra.base))); DB.transactions.push(...rows.map(r => Object.assign({ id: 'id' + (seq++) }, r))); return rows; };
(async () => {
  DB.products.push({ id: U, name: 'P', sku: 'P1', case_size: 12, case_price: 1200, case_purchase_price: 1000, selling_price: 100, purchase_price: 83.3333, bonus_free_units: 1, bonus_cases_req: 2, bonus_free_money: 0, current_stock: 1000 });
  const old = (await sale('dsr_sale'))[0];
  const profitBefore = old.total_revenue - old.total_cost;
  // 1/2: change price, buy price and offer; the stored row (= what slips/reprints/profit read) is untouched
  const before = JSON.stringify(DB.transactions[0]);
  const P = DB.products[0]; Object.assign(P, { case_price: 1500, selling_price: 125, case_purchase_price: 1300, purchase_price: 108.3333, bonus_free_units: 5, bonus_cases_req: 1 });
  t('1/2 old row identical after price/buy/offer change (reprint, profit)', JSON.stringify(DB.transactions[0]) === before && DB.transactions[0].total_revenue - DB.transactions[0].total_cost === profitBefore);
  t('1 snapshot stores unitsPerCase + old offer', old.rule_case_size === 12 && old.rule_bonus_free_units === 1 && old.rule_bonus_cases_req === 2);
  const s = snap.snapOfRow(DB.transactions[0]);
  t('1 snapOfRow exposes all snapshot fields', s.sellPrice > 0 && s.buyPrice > 0 && s.unitsPerCase === 12 && s.offerCasesReq === 2 && s.offerFreeUnits === 1 && 'offerDeductionTotal' in s && 'offerDeductionPerCase' in s && s.snapshotAt !== undefined && s.legacy === false);
  // 3 return of old sale uses old price + old cost + old rule
  const ret = (await sale('dsr_sale_return', { shopId: 'S1', srId: 'D1', date: '2026-11-09', base: {} }))[0];
  t('3 return of an old sale uses the OLD sell price and OLD buy price', Math.abs(ret.total_revenue - 2400) < 0.01 && Math.abs(ret.total_cost - 2000) < 0.05 && ret.rule_bonus_cases_req === 2);
  // 4 quantity-only edit of an old sale keeps its snapshot (same path: a return/adjustment reads the original row)
  const ret2 = (await sale('dsr_sale_return', { shopId: 'S1', srId: 'D1' }))[0];
  t('4 further quantity on an old sale still uses the old price', Math.abs(ret2.selling_price - old.selling_price) < 1e-6);
  // 6 new sale uses new price
  const nw = (await sale('dsr_sale'))[0];
  t('6 a NEW sale uses the new price', Math.abs(nw.total_revenue - 3000) < 0.01 && nw.rule_bonus_free_units === 5);
  // 5/7 legacy freeze
  const L = { id: 'legacy1', type: 'give', date: '2026-01-05', product_id: U, selling_price: 90, purchase_price: 70, total_units: 12, total_revenue: 1080, total_cost: 840, created_at: '2026-01-05T05:00:00Z' };
  const L2 = { id: 'legacy2', type: 'give', date: '2026-01-06', product_id: U, selling_price: 0, purchase_price: 0, total_units: 12, total_revenue: 0, total_cost: 0, created_at: '2026-01-06T05:00:00Z' };
  DB.transactions.push(L, L2);
  t('7a legacy status: 2 pending, not done', (await snap.freezeStatus()).pending === 2 && !(await snap.freezeStatus()).done);
  await snap.addPriceHistory([{ productId: U, productName: 'P', field: 'buyPrice', oldValue: 840, newValue: 1000, changedBy: 'owner', at: '2026-06-01T00:00:00Z' }]);
  const r1 = await snap.freezeRun('owner');
  const snapAfter = JSON.stringify(DB.transactions);
  const r2 = await snap.freezeRun('owner');
  t('7 freeze ran once, second run changed nothing', r1.frozen === 2 && r1.done && r2.frozen === 0 && JSON.stringify(DB.transactions) === snapAfter);
  t('7 frozen line: kept its own price, offer cleared, legacy mark', DB.transactions.find(x => x.id === 'legacy1').selling_price === 90 && DB.transactions.find(x => x.id === 'legacy1').rule_bonus_free_units === 0 && snap.snapOfRow(DB.transactions.find(x => x.id === 'legacy1')).legacy === true);
  t('7 frozen line with no price used price history for its date (840/12=70)', Math.abs(DB.transactions.find(x => x.id === 'legacy2').purchase_price - 70) < 0.001);
  t('7 sales with a snapshot were never touched by the freeze', JSON.stringify(DB.transactions[0]) === before);
  const frozenCost = DB.transactions.find(x => x.id === 'legacy1').total_cost;
  P.purchase_price = 999; P.case_purchase_price = 11988;
  t('5 after freeze, changing buy price leaves old profit identical', DB.transactions.find(x => x.id === 'legacy1').total_cost === frozenCost);
  // 8 history without a table
  const ent = snap.diffProduct({ case_price: 1200 }, { case_price: 1500 }, 'owner', U, 'P');
  const res = await snap.addPriceHistory(ent);
  const hist = await snap.readPriceHistory(U);
  t('8 price change creates a dated entry with no product_price_history table', res.table === false && res.stored && hist.some(h => h.field === 'sellPrice' && h.oldValue === 1200 && h.newValue === 1500 && h.changedBy === 'owner' && /^\d{4}-\d\d-\d\dT/.test(h.at)));
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
