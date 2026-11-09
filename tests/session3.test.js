// Session 3 tests — profit panel, payments neutrality, roles. Run: node tests/session3.test.js
const Module = require('module');
const DB = { products: [], transactions: [], user_passwords: [{ user_key: 'own', role: 'owner', password: '1111' }, { user_key: 'mgr', role: 'manager', password: '2222' }, { user_key: 'dsr1', role: 'dsr', password: '3333' }, { user_key: 'so1', role: 'so', password: '4444' }], app_settings: [{ id: 1, shop_name: '', profit_rules: {} }] };
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
const offer = require('../api/_lib/offer');
const { priceItems, txRow } = require('../api/_lib/money');
const U1 = '11111111-1111-4111-8111-111111111111', U2 = '22222222-2222-4222-8222-222222222222';

const ol = require('../api/_lib/offerLedger');
const handler = require('../api/products');
let pass = 0, fail = 0;
const t = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const near = (a, b) => Math.abs(a - b) < 0.0051;
const call = async (body) => { let out; await handler({ method: 'POST', body, query: {}, headers: {} }, { setHeader() {}, status() { return this; }, end() {}, json(x) { out = x; return this; } }); return out; };
const doSale = async (type, items, date) => {
  const p = await priceItems(items, { type });
  const total = type === 'dsr_sale' ? offer.applyOffers(p.lines, { date, start: await offer.getStartDate() }) : offer.applyReturnOffers(p.lines, await offer.sourceOffers({ shopId: 'S1', srId: 'D1' }, ['dsr_sale'], p.lines.map(l => l.productId), date));
  const txId = 'tx' + Math.random().toString(16).slice(2);
  DB.transactions.push(...p.lines.map(l => txRow(l, { tx_id: txId, type, date, shop_id: 'S1', sr_id: 'D1', created_at: new Date().toISOString() })));
  await offer.persist(txId, p.lines);
  return total;
};
const S = (date, pid, cases, ded, name) => ({ date, productId: pid, productName: name || pid, cases, units: cases * 24, offerDeductionTotal: ded });
const snapMod = require('../api/_lib/snapshot');
const { computeProfit } = require('../api/_lib/db');
const dash = require('../api/dashboard');
const mk = (extra) => Object.assign({ id: 'x' + (seq++) }, extra);
const give = (date, rev, cost) => DB.transactions.push(mk({ type: 'give', date, product_id: 'P', product_name: 'P', total_units: 24, total_revenue: rev, total_cost: cost }));
const shopSale = (date, rev, cost, ded, cases) => DB.transactions.push(mk({ tx_id: 'tx' + seq, type: 'dsr_sale', date, product_id: 'P', product_name: 'P', cases, total_units: cases * 24, total_revenue: rev, total_cost: cost, offer_deduction_total: ded }));
const run = async (h, req) => { let out; await h(Object.assign({ method: 'GET', body: {}, query: {}, headers: {} }, req), { setHeader() {}, status() { return this; }, end() {}, json(x) { out = x; return this; } }); return out; };
(async () => {
  DB.products.push({ id: 'P', name: 'P', sku: 'P', case_size: 24, selling_price: 18.75, purchase_price: 12.5, current_stock: 1000 });
  await snapMod.storeWrite({ offerStart: '2026-11-01' });
  // day 1: 450/300/33 × 10 cases
  give('2026-11-09', 4500, 3000); shopSale('2026-11-09', 4500, 3000, 330, 10);
  let P = await computeProfit('2026-11-09', '2026-11-09');
  t('panel total 1,500 = cash 1,170 + offer 330 (বাকি)', P.netProfit === 1500 && P.cashProfit === 1170 && P.offerProfit === 330 && P.offerPending === 330 && P.offerReceived === 0);
  t('details: normal 4,500, offer deduction 330, actual 4,170, purchase 3,000', P.normalSales === 4500 && P.offerDeduction === 330 && P.actualSales === 4170 && P.cost === 3000);
  // REAL: 635/605/24/2 free, 10 cases
  give('2026-11-10', 6350, 6050); shopSale('2026-11-10', 6350, 6050, 488.46, 10);
  P = await computeProfit('2026-11-10', '2026-11-10');
  t('REAL actual sales 5,861.54 · purchase 6,050.00 · cash −188.46 · offer 488.46 · TOTAL 300.00', P.actualSales === 5861.54 && P.cost === 6050 && P.cashProfit === -188.46 && P.offerProfit === 488.46 && P.netProfit === 300);
  // earlier big offer day so a 3,000 payment can settle something
  give('2026-11-05', 30000, 20000); shopSale('2026-11-05', 30000, 20000, 3000, 100);
  const days = ['2026-11-05', '2026-11-09', '2026-11-10'];
  const daily = async () => { const o = {}; for (const d of days) o[d] = await computeProfit(d, d); return o; };
  const before = await daily(); const monthBefore = await computeProfit('2026-11-01', '2026-11-30');
  t('month total = sum of daily totals (before payment)', Math.abs(monthBefore.netProfit - days.reduce((s, d) => s + before[d].netProfit, 0)) < 0.011);
  const bal0 = (await require('../api/_lib/offerLedger').ledger()).alloc.total.balance;
  await snapMod.storeWrite({ _offerPayments: [{ id: 'p1', date: '2026-11-09', amount: 3000, productIds: [], from: '', to: '', close: false }] });
  const after = await daily(); const monthAfter = await computeProfit('2026-11-01', '2026-11-30');
  const bal1 = (await require('../api/_lib/offerLedger').ledger()).alloc.total.balance;
  t('company payment 3,000 the same day → today profit still 1,500', after['2026-11-09'].netProfit === 1500 && after['2026-11-09'].cashProfit === 1170);
  t('payment does not change any day profit', days.every(d => after[d].netProfit === before[d].netProfit && after[d].cashProfit === before[d].cashProfit));
  t('offer balance goes down by 3,000', Math.abs((bal0 - bal1) - 3000) < 0.011);
  t('label only changes: the settled day shows প্রাপ্ত, no total change', after['2026-11-05'].offerPending === 0 && after['2026-11-05'].offerReceived === 3000 && after['2026-11-05'].netProfit === before['2026-11-05'].netProfit);
  t('month total unchanged by the payment and still = sum of dailies', monthAfter.netProfit === monthBefore.netProfit && Math.abs(monthAfter.netProfit - days.reduce((s, d) => s + after[d].netProfit, 0)) < 0.011);
  t('company payment listed for the range but not in profit', monthAfter.companyPayments.length === 1 && monthAfter.adjustment === 0);
  // price change tomorrow → yesterday identical
  DB.products[0].selling_price = 99; DB.products[0].purchase_price = 77;
  const again = await computeProfit('2026-11-09', '2026-11-09');
  t('price change → past day profit identical (stored snapshots only)', again.netProfit === 1500 && again.cashProfit === 1170 && again.actualSales === 4170);
  // overpayment → adjustment only on the payment date
  await snapMod.storeWrite({ _offerPayments: [{ id: 'p2', date: '2026-11-12', amount: 3500, productIds: [], from: '', to: '', close: false }] });
  const o9 = await computeProfit('2026-11-09', '2026-11-09'), o12 = await computeProfit('2026-11-12', '2026-11-12');
  t('overpayment 3,500 vs 3,818.46 owed is NOT an adjustment; sale days unchanged', o9.netProfit === 1500 && o12.adjustment === 0);
  await snapMod.storeWrite({ _offerPayments: [{ id: 'p3', date: '2026-11-12', amount: 4000, productIds: [], from: '', to: '', close: false }] });
  const q9 = await computeProfit('2026-11-09', '2026-11-09'), q12 = await computeProfit('2026-11-12', '2026-11-12'), qm = await computeProfit('2026-11-01', '2026-11-30');
  t('overpayment 4,000 → +181.54 adjustment on 12 Nov only', q12.adjustment === 181.54 && q12.netProfit === 181.54 && q9.netProfit === 1500 && Math.abs(qm.netProfit - (monthBefore.netProfit + 181.54)) < 0.011);
  await snapMod.storeWrite({ _offerPayments: [{ id: 'p4', date: '2026-11-12', amount: 3000, close: true, productIds: [], from: '', to: '' }] });
  const u12 = await computeProfit('2026-11-12', '2026-11-12'), u9 = await computeProfit('2026-11-09', '2026-11-09');
  t('underpayment 3,000 + close → −818.46 adjustment on 12 Nov only', u12.adjustment === -818.46 && u12.netProfit === -818.46 && u9.netProfit === 1500);
  await snapMod.storeWrite({ _offerPayments: [] });
  // roles — API responses
  let r = await run(dash, { query: { action: 'sales-range', range: 'custom', from: '2026-11-09', to: '2026-11-09', actorId: 'own' } });
  t('owner API sales-range has profit + breakdown', r.ok && r.profit === 1500 && r.breakdown && r.breakdown.cashProfit === 1170);
  r = await run(dash, { query: { action: 'sales-range', range: 'custom', from: '2026-11-09', to: '2026-11-09', actorId: 'mgr' } });
  t('manager API sales-range has profit', r.ok && r.profit === 1500);
  for (const q of [{ actorId: 'dsr1' }, { actorId: 'so1' }, { actorId: 'dsr1', role: 'dsr' }, { role: 'so' }, {}]) {
    r = await run(dash, { query: Object.assign({ action: 'sales-range', range: 'custom', from: '2026-11-09', to: '2026-11-09' }, q) });
    t('no profit data for ' + JSON.stringify(q), r.ok && r.profit === undefined && r.netProfit === undefined && r.breakdown === undefined && r.grossProfit === undefined && r.revenue === 4500);
  }
  const OLm = require('../api/_lib/offerLedger');
  t('profitAllowed: owner/manager yes, dsr/so/none no', (await OLm.profitAllowed({ actorId: 'own' })) && (await OLm.profitAllowed({ actorId: 'mgr' })) && !(await OLm.profitAllowed({ actorId: 'dsr1' })) && !(await OLm.profitAllowed({ actorId: 'so1' })) && !(await OLm.profitAllowed({})));
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('CRASH', e.stack); process.exit(1); });
