// Session 1 tests — in-memory fake of the Supabase client (no network). Run: node tests/session1.test.js
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
const offer = require('../api/_lib/offer');
const { priceItems, txRow } = require('../api/_lib/money');
const U1 = '11111111-1111-4111-8111-111111111111', U2 = '22222222-2222-4222-8222-222222222222';
let pass = 0, fail = 0;
const t = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const near = (a, b) => Math.abs(a - b) < 0.0051;
const calc = offer.calcOfferDeduction;
// writes a sale like shops.js visit-sale does
const doSale = async (type, items, date, extra) => {
  const p = await priceItems(items, Object.assign({ type }, extra || {}));
  const total = type === 'dsr_sale' || type === 'point_sale' ? offer.applyOffers(p.lines, { date, start: await offer.getStartDate() }) : offer.applyReturnOffers(p.lines, await offer.sourceOffers({ shopId: 'S1', srId: 'D1' }, ['dsr_sale'], p.lines.map(l => l.productId), date));
  const txId = 'tx' + Math.random().toString(16).slice(2);
  const rows = p.lines.map(l => txRow(l, { tx_id: txId, type, date, shop_id: 'S1', sr_id: 'D1', created_at: new Date().toISOString() }));
  DB.transactions.push(...rows);
  await offer.persist(txId, p.lines);
  return { txId, total, lines: p.lines, rows };
};
(async () => {
  // ---- pure formula
  const a = calc({ sellPrice: 450, unitsPerCase: 24, offerCasesReq: 1, offerFreeUnits: 1, offerFreeMoney: 15 }, 1);
  t('450/24/1 free/15 money → deduction 33.00, shop pays 417.00', near(a.total, 33) && near(a.shopPricePerCase, 417));
  const b = calc({ sellPrice: 635, unitsPerCase: 24, offerCasesReq: 1, offerFreeUnits: 2, offerFreeMoney: 0 }, 1);
  t('REAL 635/24/2 free → 48.85 per case, shop pays 586.15', near(b.perCase, 48.85) && near(b.shopPricePerCase, 586.15));
  const b10 = calc({ sellPrice: 635, unitsPerCase: 24, offerCasesReq: 1, offerFreeUnits: 2, offerFreeMoney: 0 }, 10);
  t('10 cases → deduction exactly 488.46 (no drift), shop pays 5,861.54', b10.total === 488.46 && Math.round((6350 - b10.total) * 100) / 100 === 5861.54);
  const b25 = calc({ sellPrice: 635, unitsPerCase: 24, offerCasesReq: 1, offerFreeUnits: 2, offerFreeMoney: 0 }, 2.5);
  t('2.5 cases → deduction on 2 cases only', b25.qualifyingCases === 2 && b25.total === offer.r2(b.exactPerCase * 2));
  const x2 = calc({ sellPrice: 600, unitsPerCase: 12, offerCasesReq: 2, offerFreeUnits: 1, offerFreeMoney: 20 }, 5);
  t('X=2: only full groups of 2 cases qualify (5 cases → 4)', x2.qualifyingCases === 4);
  t('no offer / loose bottles only → 0', calc({ sellPrice: 600, unitsPerCase: 12, offerCasesReq: 1, offerFreeUnits: 0, offerFreeMoney: 0 }, 3).total === 0 && calc({ sellPrice: 635, unitsPerCase: 24, offerCasesReq: 1, offerFreeUnits: 2 }, 0.9).total === 0);

  // ---- through the real write path
  DB.products.push({ id: U1, name: 'Real', sku: 'R1', case_size: 24, case_price: 635, case_purchase_price: 605, selling_price: 26.4583, purchase_price: 25.2083, bonus_free_units: 2, bonus_cases_req: 1, bonus_free_money: 0, current_stock: 1000 });
  DB.products.push({ id: U2, name: 'Test', sku: 'T1', case_size: 24, case_price: 450, case_purchase_price: 400, selling_price: 18.75, purchase_price: 16.6667, bonus_free_units: 1, bonus_cases_req: 1, bonus_free_money: 15, current_stock: 1000 });
  // legacy-looking old sale before start date is untouched
  const early = await doSale('dsr_sale', [{ productId: U1, cases: 3, pcs: 0 }], '2026-11-01');
  t('no start date set → no offer applied (legacy unchanged)', early.total === 0 && offer.dedOf(DB.transactions[0]) === 0);
  await require('../api/_lib/snapshot').storeWrite({ offerStart: '2026-11-09' });
  const before = await doSale('dsr_sale', [{ productId: U1, cases: 3, pcs: 0 }], '2026-11-08');
  t('sale dated before the start date → no offer', before.total === 0);
  const s10 = await doSale('dsr_sale', [{ productId: U1, cases: 10, pcs: 0 }], '2026-11-09');
  t('write path: 10 cases deduction 488.46, bill 5,861.54', s10.total === 488.46 && Math.round((s10.lines[0].revenue - s10.total) * 100) / 100 === 5861.54);
  t('gross revenue + stock rows untouched (stock drops by real bottles: 240)', s10.rows[0].total_revenue === 6350 && s10.rows[0].total_units === 240);
  t('snapshot stored on the row (case price, per case, total)', DB.transactions.at(-1).offer_deduction_total === 488.46 && DB.transactions.at(-1).offer_case_price === 635 && near(DB.transactions.at(-1).offer_deduction_per_case, 48.85));
  const s25 = await doSale('dsr_sale', [{ productId: U1, cases: 2, pcs: 12 }], '2026-11-09');
  t('2 cases + 12 loose → deduction on 2 cases only (97.69)', s25.total === 97.69);
  const tst = await doSale('point_sale', [{ productId: U2, cases: 1, pcs: 0 }], '2026-11-09');
  t('point sale 450/24/1+15 → 33.00', tst.total === 33);

  // price/offer change later: old rows identical
  const snapRow = JSON.stringify(DB.transactions.at(-1));
  Object.assign(DB.products[0], { case_price: 700, selling_price: 29.1667, bonus_free_units: 5 });
  t('price/offer change → stored old row identical', JSON.stringify(DB.transactions.at(-1)) === snapRow && offer.dedOf(s10.rows[0].created_at ? DB.transactions.find(r => r.tx_id === s10.txId) : null) === 488.46);
  Object.assign(DB.products[0], { case_price: 635, selling_price: 26.4583, bonus_free_units: 2 });

  // returns: proportional from the original snapshot, not today's price/offer
  Object.assign(DB.products[0], { case_price: 900, selling_price: 37.5, bonus_free_units: 0 });
  const ret = await doSale('dsr_sale_return', [{ productId: U1, cases: 4, pcs: 0 }], '2026-11-10', { shopId: 'S1', srId: 'D1', date: '2026-11-10' });
  t('return reverses deduction proportionally from the original snapshot (4 cases → 195.38)', ret.total === 195.38);
  const fullBack = await doSale('dsr_sale_return', [{ productId: U1, cases: 10, pcs: 0 }], '2026-11-10', { shopId: 'S1', srId: 'D1', date: '2026-11-10' });
  t('return of 10 cases reverses exactly 488.46 (same rate, no drift)', fullBack.total === 488.46);
  // legacy rows: no offer
  DB.transactions.push({ id: 'leg', tx_id: 'legtx', type: 'dsr_sale', product_id: U1, date: '2026-01-01', total_units: 24, total_revenue: 635 });
  const raw = await offer.hydrate([DB.transactions.at(-1)]);
  t('legacy line → no offer, untouched', offer.dedOf(raw[0]) === 0 && offer.netDeduction(raw) === 0);

  // fallback: no migration (columns missing) → settings store
  offer._setColumns(false);   // simulate a database without migration 006
  const ns = await doSale('dsr_sale', [{ productId: U2, cases: 2, pcs: 0 }], '2026-11-09');
  const stored = await require('../api/_lib/snapshot').storeRead();
  t('no migration: deduction kept in settings store, 66.00', ns.total === 66 && stored._offerLines && stored._offerLines[ns.txId + '|' + U2][2] === 66);
  const rows = DB.transactions.filter(r => r.tx_id === ns.txId).map(r => { const c = Object.assign({}, r); delete c.offer_deduction_total; return c; });
  t('no migration: hydrate restores it for reads', offer.netDeduction(await offer.hydrate(rows)) === 66);
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
