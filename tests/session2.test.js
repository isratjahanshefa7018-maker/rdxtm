// Session 2 tests — in-memory fake of the Supabase client (no network). Run: node tests/session2.test.js
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
(async () => {
  // ---- pure allocation
  let a = ol.getOfferAllocation([S('2026-11-09', 'A', 1, 33)], [], [{ id: 'p', date: '2026-11-09', amount: 33 }]);
  t('payment 33 settles balance 33 → balance 0, no adjustment (no profit)', a.total.balance === 0 && a.adjustments.length === 0 && a.total.received === 33);
  const s10 = [S('2026-11-09', 'A', 10, 488.46)];
  a = ol.getOfferAllocation(s10, [], [{ id: 'p', date: '2026-11-10', amount: 488.46 }]);
  t('REAL earned 488.46, payment 488.46 → balance 0', a.total.earned === 488.46 && a.total.balance === 0 && a.adjustments.length === 0);
  a = ol.getOfferAllocation(s10, [], [{ id: 'p', date: '2026-11-10', amount: 500 }]);
  t('payment 500 → +11.54 adjustment on the payment date, balance 0', a.adjustments.length === 1 && a.adjustments[0].amount === 11.54 && a.adjustments[0].date === '2026-11-10' && a.total.balance === 0);
  a = ol.getOfferAllocation(s10, [], [{ id: 'p', date: '2026-11-10', amount: 480, close: true }]);
  t('payment 480 + close → −8.46 adjustment on the payment date, balance 0', a.adjustments.length === 1 && a.adjustments[0].amount === -8.46 && a.adjustments[0].date === '2026-11-10' && a.total.balance === 0);
  a = ol.getOfferAllocation(s10, [], [{ id: 'p', date: '2026-11-10', amount: 480 }]);
  t('payment 480 without close → balance 8.46 stays, no adjustment', a.total.balance === 8.46 && a.adjustments.length === 0);
  // FIFO
  const three = [S('2026-11-09', 'A', 1, 100), S('2026-11-10', 'A', 1, 100), S('2026-11-11', 'B', 1, 100)];
  a = ol.getOfferAllocation(three, [], [{ id: 'p', date: '2026-11-12', amount: 150 }]);
  const dm = {}; a.days.forEach(d => { dm[d.date] = d; });
  t('oldest settled first (day1 100 paid, day2 50 paid, day3 untouched)', dm['2026-11-09'].pending === 0 && dm['2026-11-09'].received === 100 && dm['2026-11-10'].received === 50 && dm['2026-11-10'].pending === 50 && dm['2026-11-11'].pending === 100);
  t('payment not tied to a product → per-product balance derived (A 50, B 100)', a.products.A.balance === 50 && a.products.B.balance === 100 && a.total.balance === 150);
  a = ol.getOfferAllocation(three, [], [{ id: 'p', date: '2026-11-12', amount: 100, productIds: ['B'] }]);
  t('payment tied to product B settles only B', a.products.B.balance === 0 && a.products.A.balance === 200);
  a = ol.getOfferAllocation(three, [], [{ id: 'p', date: '2026-11-12', amount: 100, from: '2026-11-10', to: '2026-11-10' }]);
  t('payment with period settles only that period', dm && a.days.find(d => d.date === '2026-11-10').pending === 0 && a.days.find(d => d.date === '2026-11-09').pending === 100);
  // return
  a = ol.getOfferAllocation(s10, [S('2026-11-10', 'A', 2, 97.69)], []);
  t('a return lowers earned and balance (488.46 − 97.69)', near(a.total.earned, 390.77) && near(a.total.balance, 390.77) && a.products.A.cases === 8);
  // since last payment
  a = ol.getOfferAllocation([S('2026-11-09', 'A', 5, 50), S('2026-11-12', 'A', 3, 30)], [], [{ id: 'p', date: '2026-11-10', amount: 50 }]);
  t('cases since the last company payment', a.products.A.casesSincePayment === 3 && a.products.A.cases === 8 && a.products.A.bottlesSincePayment === 72);
  const sm = ol.salesSummary([S('2026-11-09', 'A', 5, 50), S('2026-11-12', 'A', 3, 30)], [], [{ id: 'p', date: '2026-11-10', amount: 50 }], null);
  const sr = ol.salesSummary([S('2026-11-09', 'A', 5, 50), S('2026-11-12', 'A', 3, 30)], [], [], { from: '2026-11-09', to: '2026-11-10' });
  t('send summary: since last payment = 3 cases; date range = 5 cases', sm.rows[0].cases === 3 && sr.rows[0].cases === 5 && sr.rows[0].bottles === 120);

  // ---- real write path + API
  DB.products.push({ id: U1, name: 'Real', sku: 'R1', case_size: 24, case_price: 635, case_purchase_price: 605, selling_price: 26.4583, purchase_price: 25.2083, bonus_free_units: 2, bonus_cases_req: 1, bonus_free_money: 0, current_stock: 1000 });
  await require('../api/_lib/snapshot').storeWrite({ offerStart: '2026-11-09' });
  await doSale('dsr_sale', [{ productId: U1, cases: 10, pcs: 0 }], '2026-11-09');
  const own = { actorId: 'own', actorName: 'Owner', pin: '1111' };
  let r = await call(Object.assign({ action: 'co-ledger' }, own));
  t('API ledger from stored snapshots: earned 488.46 for the REAL product', r.ok && r.alloc.total.earned === 488.46 && r.alloc.products[U1].cases === 10);
  t('DSR rejected by the API (ledger)', (await call({ action: 'co-ledger', actorId: 'dsr1' })).forbidden === true);
  t('SO rejected by the API (ledger)', (await call({ action: 'co-ledger', actorId: 'so1' })).forbidden === true);
  t('unknown caller rejected', (await call({ action: 'co-ledger' })).forbidden === true);
  t('DSR rejected (add payment, even with own PIN)', (await call({ action: 'co-pay-add', actorId: 'dsr1', pin: '3333', date: '2026-11-10', amount: 10 })).forbidden === true);
  t('DSR rejected (send summary)', (await call({ action: 'co-send', actorId: 'dsr1' })).forbidden === true);
  t('manager wrong PIN rejected for add', (await call({ action: 'co-pay-add', actorId: 'mgr', pin: '0000', date: '2026-11-10', amount: 10 })).forbidden === true);
  r = await call({ action: 'co-pay-add', actorId: 'mgr', actorName: 'Mgr', pin: '2222', date: '2026-11-10', amount: 500, note: 'bKash' });
  t('manager can add a payment', r.ok && r.payment.amount === 500);
  const pid = r.payment.id;
  r = await call(Object.assign({ action: 'co-ledger' }, own));
  t('payment 500 → +11.54 adjustment dated on the payment date, balance 0', r.alloc.adjustments[0].amount === 11.54 && r.alloc.adjustments[0].date === '2026-11-10' && r.alloc.total.balance === 0);
  r = await call({ action: 'co-pay-edit', actorId: 'own', pin: '1111', id: pid, date: '2026-11-10', amount: 480, close: true, note: 'x' });
  r = await call(Object.assign({ action: 'co-ledger' }, own));
  t('edit payment to 480 + close → −8.46 adjustment', r.alloc.adjustments[0].amount === -8.46 && r.alloc.total.balance === 0);
  const rawBefore = JSON.stringify(DB.transactions);
  // price / offer change must not move any old ledger figure
  DB.products[0].case_price = 999; DB.products[0].bonus_free_units = 9; DB.products[0].case_size = 12;
  r = await call(Object.assign({ action: 'co-ledger' }, own));
  t('price/offer change alters no old ledger figure', r.alloc.total.earned === 488.46 && r.alloc.adjustments[0].amount === -8.46 && JSON.stringify(DB.transactions) === rawBefore);
  // a return lowers earned
  DB.products[0].case_price = 635; DB.products[0].bonus_free_units = 2; DB.products[0].case_size = 24;
  await doSale('dsr_sale_return', [{ productId: U1, cases: 2, pcs: 0 }], '2026-11-12');
  r = await call(Object.assign({ action: 'co-ledger' }, own));
  t('real return row lowers earned (488.46 − 97.69 = 390.77)', near(r.alloc.total.earned, 390.77));
  r = await call(Object.assign({ action: 'co-send', from: '2026-11-09', to: '2026-11-12' }, own));
  t('send summary via API: net 8 cases, 192 bottles', r.ok && r.summary.rows[0].cases === 8 && r.summary.rows[0].bottles === 192);
  r = await call(Object.assign({ action: 'co-pay-del', id: pid }, own));
  r = await call(Object.assign({ action: 'co-ledger' }, own));
  t('delete payment → balance returns, no adjustments', r.payments.length === 0 && r.alloc.adjustments.length === 0 && near(r.alloc.total.balance, 390.77));
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
