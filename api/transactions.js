const { supabase, cors, num, now_, mapTx, safeErr, fetchAll, pageParams, idemRun, blockNegativeStock, bdtToday, cpGroups, withUnits } = require('./_lib/db');
const { priceItems, txRow, stockShortage, r2, r4 } = require('./_lib/money');
const { randomUUID } = require('crypto');
const offerLib = require('./_lib/offer');   // v5.25

// Movements that take stock OUT of the warehouse (CALC-9).
const OUTGOING = new Set(['give', 'point_sale', 'return_company']);

const VALID_TYPES = new Set(['buy','give','return','damage','point_sale','point_damage_return','dsr_sale','dsr_sale_return','return_company']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// PERF-5 — only the columns the screens use (mapTx reads exactly these)
const TX_COLS_BASE = 'tx_id,type,sr_id,sr_name,date,slip_no,product_id,product_name,sku,cases,pcs,total_units,purchase_price,selling_price,total_cost,total_revenue,commission_amt,discount_amt,shop_id,customer_id,note,created_at,id';

// v5.24 — snapshot columns are added only when the database has them (cached probe), so an old database still works
let _ruleOk = null;
async function txCols() {
  if (_ruleOk === null) { const { error } = await supabase.from('transactions').select('rule_case_size').limit(1); _ruleOk = !error; }
  return (_ruleOk ? TX_COLS_BASE + ',rule_case_size,rule_bonus_cases_req,rule_bonus_free_units,rule_bonus_free_money' : TX_COLS_BASE) + await offerLib.selCols();
}

// Update #49 — DSR/SO due-history modal: given a set of transaction
// rows (already filtered to one sr_id) that have a shop_id set, resolve
// those ids to shop names in one batched query instead of one lookup
// per row.
async function _resolveShopNames(shopIds) {
  const ids = [...new Set(shopIds.filter(Boolean))];
  if (!ids.length) return {};
  const { data, error } = await supabase.from('shops').select('id,name').in('id', ids);
  if (error) throw error;
  const map = {};
  (data || []).forEach(s => { map[String(s.id)] = s.name || ''; });
  return map;
}


// ── POST: one or many items sharing one txId ─────────────────────────────
// CALC-5  prices/costs come from the products table, never from the browser.
// CALC-6  each bill line is rounded to 2 decimals (whole cases at case price).
// CALC-9  outgoing movements are refused when the warehouse does not have
//         the stock (the database trigger enforces the same rule race-free).
async function _addTransaction(req, res) {
  const d = req.body || {};
  if (!VALID_TYPES.has(d.type)) return res.json({ ok: false, error: 'অবৈধ লেনদেনের ধরন' });
  if (!d.date || !DATE_RE.test(d.date)) return res.json({ ok: false, error: 'বৈধ তারিখ দিন (YYYY-MM-DD)' });
  if (!Array.isArray(d.items) || !d.items.length) return res.json({ ok: false, error: 'কমপক্ষে একটি আইটেম দিন' });
  if (d.items.length > 100) return res.json({ ok: false, error: 'একসাথে সর্বোচ্চ ১০০টি আইটেম' });

  const priced = await priceItems(d.items, { type: d.type, srId: d.srId, date: d.date, shopId: d.shopId, customerId: d.customerId });
  if (!priced.ok) return res.json({ ok: false, error: priced.error });
  const lines = priced.lines;

  if (OUTGOING.has(d.type) && await blockNegativeStock()) {
    const msg = stockShortage(lines);
    if (msg) return res.json({ ok: false, error: msg });
  }

  // v5.25 — automatic company-offer deduction (new sales) / proportional reversal (returns of a shop sale)
  let offerTotal = 0;
  if (d.type === 'dsr_sale' || d.type === 'point_sale') offerTotal = offerLib.applyOffers(lines, { date: d.date, start: await offerLib.getStartDate() });
  else if (d.type === 'point_damage_return' && (d.shopId || d.customerId)) {
    const _so = await offerLib.sourceOffers({ shopId: d.shopId || '' }, ['point_sale'], lines.map(l => l.productId), d.date);
    offerTotal = offerLib.applyReturnOffers(lines, _so);
  }
  const txId = randomUUID();
  const ts   = now_();
  const rows = lines.map(l => txRow(l, {
    tx_id: txId, type: d.type,
    sr_id: d.srId || '', sr_name: d.srName || '',
    date: d.date, slip_no: d.slipNo || '',
    // Update #51 — point-sale rows carry a real shop_id / customer_id.
    shop_id: d.shopId || '', customer_id: d.customerId || '',
    note: d.note || '', created_at: ts
  }));

  // v5.17 — a POINT SALE can carry a commission and a discount (per line and/or one flat amount for
  // the whole slip), stored on the rows exactly like a DSR shop sale so the DSR panel can list them.
  if (d.type === 'point_sale') {
    const m2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
    lines.forEach((l, i) => {
      rows[i].commission_amt = m2(Math.max(0, num(l.commission)));
      rows[i].discount_amt   = m2(Math.max(0, num(l.discount)));
    });
    if (rows.length) {
      const gross = rows.reduce((a, r) => a + num(r.total_revenue), 0);
      const cSum = rows.reduce((a, r) => a + num(r.commission_amt), 0);
      const dSum = rows.reduce((a, r) => a + num(r.discount_amt), 0);
      const wantC = Math.max(0, num(d.commissionAmt)), wantD = Math.max(0, num(d.discountAmt));
      if (wantC > cSum + 0.004) rows[0].commission_amt = m2(num(rows[0].commission_amt) + (wantC - cSum));
      if (wantD > dSum + 0.004) rows[0].discount_amt   = m2(num(rows[0].discount_amt) + (wantD - dSum));
      const totC = rows.reduce((a, r) => a + num(r.commission_amt), 0), totD = rows.reduce((a, r) => a + num(r.discount_amt), 0);
      if (totC + totD > gross - offerTotal + 0.004) return res.json({ ok: false, error: 'কমিশন ও ছাড়ের যোগফল (৳' + m2(totC + totD) + ') বিক্রয়ের মোট (৳' + m2(gross) + ') এর বেশি হতে পারে না' });
    }
  }

  const { error: txErr } = await supabase.from('transactions').insert(rows);
  if (txErr) throw txErr;
  if (offerTotal > 0) await offerLib.persist(txId, lines);

  // Auto-create damage claims for 'damage' type
  if (d.type === 'damage') {
    const dmgRows = lines.map(l => ({
      tx_id: txId, product_id: l.productId, product_name: l.productName, sku: l.sku,
      total_units: l.units, purchase_price: l.purchasePrice, total_cost: l.cost,
      date: d.date, sr_id: d.srId || '', sr_name: d.srName || '',
      status: 'pending', cleared_date: null, created_at: ts
    }));
    const { error: dmgErr } = await supabase.from('dmg_claims').insert(dmgRows);
    if (dmgErr) {
      // keep the two tables in step: no damage claim → no damage row either
      await supabase.from('transactions').delete().eq('tx_id', txId);
      throw dmgErr;
    }
  }
  return res.json({ ok: true, txId, offerTotal, offerLines: lines.filter(l => l.offer).map(l => ({ productId: l.productId, perCase: l.offer.perCase, total: l.offer.total })) });
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const action = (req.query && req.query.action) || '';
    const TX_COLS_X = await txCols();

    // ══════════════════════════════════════════════════
    //  Update #49 — DSR/SO due transaction history
    //  GET /api/transactions?action=due-history&srId=<id>
    //  Returns every give/return transaction (the same rows that make
    //  up that SR's due total on the dashboard) plus every payment made
    //  against them, newest first — source, date, product, shop (when
    //  set) and amount for each — so tapping the due figure shows the
    //  full "why" behind the number, not just the total.
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'due-history') {
      const srId = String(req.query.srId || '');
      if (!srId) return res.json({ ok: false, error: 'srId আবশ্যক' });

      // v60 — detailed history: besides give/return (which make up the
      // due) we now also pull shop sales and damage so the owner sees
      // everything the person took and did. Only give/return/payments
      // change the due figure (affectsDue flag) — the rest is context.
      const [txRows, payRows] = await Promise.all([
        fetchAll(() => supabase.from('transactions').select(TX_COLS_X).eq('sr_id', srId).in('type', ['give', 'return', 'damage', 'dsr_sale']).order('date', { ascending: false }).order('created_at', { ascending: false })),
        fetchAll(() => supabase.from('sr_payments').select('id,sr_id,date,amount,cash_amount,commission_amt,discount_amt,damage_amt,note,created_at').eq('sr_id', srId).order('date', { ascending: false }))
      ]);
      const txs  = (await offerLib.hydrate(txRows || [])).map(mapTx);
      const pays = (payRows || []);

      const shopMap = await _resolveShopNames(txs.map(t => t.shopId));

      const rows = [];
      txs.forEach(t => {
        rows.push({
          source: t.type,                                   // give | return | damage | dsr_sale
          affectsDue: t.type === 'give' || t.type === 'return',
          date: t.date,
          txId: t.txId,
          createdAt: t.createdAt || '',
          productId: t.productId,
          productName: t.productName,
          cases: num(t.cases),
          pcs: num(t.pcs),
          totalUnits: num(t.totalUnits),
          unitPrice: num(t.sellingPrice),
          shopName: t.shopId ? (shopMap[t.shopId] || '') : '',
          note: t.note || '',
          amount: num(t.totalRevenue)
        });
      });
      pays.forEach(p => {
        rows.push({
          source: 'payment',
          affectsDue: true,
          date: p.date ? String(p.date).slice(0, 10) : '',
          txId: '',
          createdAt: p.created_at || '',
          productName: '', cases: 0, pcs: 0, totalUnits: 0, unitPrice: 0, shopName: '',
          cash: num(p.cash_amount), commission: num(p.commission_amt),
          discount: num(p.discount_amt), damage: num(p.damage_amt),
          note: p.note || '',
          amount: num(p.amount)
        });
      });
      rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

      const sumRev = t => txs.filter(x => x.type === t).reduce((s, x) => s + num(x.totalRevenue), 0);
      const sumUn  = t => txs.filter(x => x.type === t).reduce((s, x) => s + num(x.totalUnits), 0);
      const givenRev  = sumRev('give');
      const returnRev = sumRev('return');
      const payments  = pays.reduce((s, p) => s + num(p.amount), 0);
      const due       = (givenRev - returnRev) - payments;

      // Per-product summary: what he took, gave back, and what is still with him.
      const pm = {};
      txs.forEach(t => {
        if (t.type !== 'give' && t.type !== 'return' && t.type !== 'dsr_sale' && t.type !== 'damage') return;
        const k = t.productId || t.productName;
        if (!pm[k]) pm[k] = { productId: t.productId, productName: t.productName, givenUnits: 0, returnedUnits: 0, soldUnits: 0, damageUnits: 0, givenAmt: 0, returnedAmt: 0 };
        const u = num(t.totalUnits), a = num(t.totalRevenue);
        if (t.type === 'give')     { pm[k].givenUnits += u;    pm[k].givenAmt += a; }
        if (t.type === 'return')   { pm[k].returnedUnits += u; pm[k].returnedAmt += a; }
        if (t.type === 'dsr_sale') { pm[k].soldUnits += u; }
        if (t.type === 'damage')   { pm[k].damageUnits += u; }
      });
      const products = Object.values(pm).sort((a, b) => b.givenAmt - a.givenAmt);
      // v5.4 — case size per product so the client can show cases (+ loose pcs), never bare pieces
      const _csMap = {};
      try { const { data: _pr } = await supabase.from('products').select('id,case_size,unit_type'); (_pr || []).forEach(p => { _csMap[String(p.id)] = num(p.case_size) || 1; }); withUnits(_csMap, _pr); products.forEach(p => { p.caseSize = _csMap[String(p.productId)] || 1; const x = (_pr || []).find(z => String(z.id) === String(p.productId)); p.unitType = x ? (x.unit_type || '') : ''; }); } catch (_) { }
      const _cpR = cpGroups(txs, _csMap, { given: ['give'], returned: ['return'], shop: ['dsr_sale'], damage: ['damage'] });

      const totals = {
        givenRev, returnRev, payments, due,
        givenUnits: sumUn('give'), returnUnits: sumUn('return'),
        givenCP: _cpR.given, returnCP: _cpR.returned, shopSalesCP: _cpR.shop, damageCP: _cpR.damage,
        shopSalesRev: sumRev('dsr_sale'), shopSalesUnits: sumUn('dsr_sale'),
        damageRev: sumRev('damage'), damageUnits: sumUn('damage'),
        cash: pays.reduce((s, p) => s + num(p.cash_amount), 0),
        commission: pays.reduce((s, p) => s + num(p.commission_amt), 0),
        discount: pays.reduce((s, p) => s + num(p.discount_amt), 0),
        damagePaid: pays.reduce((s, p) => s + num(p.damage_amt), 0)
      };

      return res.json({ ok: true, srId, rows, products, totals });
    }

    // POST — add transaction (one or many items share same txId).
    // v5.1: runs inside the idempotency guard (a double tap / retry carrying
    // the same requestId returns the first answer instead of writing twice).
    if (req.method === 'POST') return idemRun(req, res, 'tx', () => _addTransaction(req, res));

    // GET — list transactions with optional filters
    // ?srId=<id>   → filter by a single sr_id (DSR isolation)
    // ?soId=<id>   → filter by SO: includes SO's own tx + all assigned DSRs' tx
    // ?from=&to=   → date range filter
    if (req.method === 'GET') {
      const { from, to, srId, soId } = req.query;

      if (soId) {
        // Resolve DSRs assigned to this SO
        const { data: dsrsData } = await supabase
          .from('srs').select('id').eq('so_id', soId);
        const dsrIds = (dsrsData || []).map(d => d.id);
        // Include the SO's own transactions as well
        const allIds = [soId, ...dsrIds];

        const pg = pageParams(req.query, 50);
        if (pg) {
          let q = supabase.from('transactions').select(TX_COLS_X, { count: 'exact' }).order('created_at', { ascending: false }).order('id');
          if (from) q = q.gte('date', from);
          if (to)   q = q.lte('date', to);
          q = q.in('sr_id', allIds.map(String));
          if (req.query.type) q = q.eq('type', String(req.query.type));
          const { data, error, count } = await q.range(pg.from, pg.to);
          if (error) throw error;
          return res.json({ ok: true, rows: (await offerLib.hydrate(data || [])).map(mapTx), page: pg.page, pageSize: pg.pageSize, total: count || 0, hasMore: pg.to + 1 < (count || 0) });
        }
        const rows = await fetchAll(() => {
          let q = supabase.from('transactions').select(TX_COLS_X).order('created_at', { ascending: false });
          if (from) q = q.gte('date', from);
          if (to)   q = q.lte('date', to);
          if (allIds.length) q = q.in('sr_id', allIds);
          if (req.query.type) q = q.eq('type', String(req.query.type));
          return q;
        });
        return res.json((await offerLib.hydrate(rows || [])).map(mapTx));
      }

      // AXIION §8 — newest transaction first (was ascending, causing
      // today's newest entry to appear at the very bottom of the list).
      // Paginated (fetchAll): without from/to this is a full-table list,
      // which would otherwise silently truncate at 1000 rows.
      const pg = pageParams(req.query, 50);
      if (pg) {
        let q = supabase.from('transactions').select(TX_COLS_X, { count: 'exact' }).order('created_at', { ascending: false }).order('id');
        if (from) q = q.gte('date', from);
        if (to)   q = q.lte('date', to);
        if (srId) q = q.eq('sr_id', srId);
        if (req.query.type) q = q.eq('type', String(req.query.type));
        const { data, error, count } = await q.range(pg.from, pg.to);
        if (error) throw error;
        return res.json({ ok: true, rows: (await offerLib.hydrate(data || [])).map(mapTx), page: pg.page, pageSize: pg.pageSize, total: count || 0, hasMore: pg.to + 1 < (count || 0) });
      }
      const rows = await fetchAll(() => {
        let q = supabase.from('transactions').select(TX_COLS_X).order('created_at', { ascending: false });
        if (from) q = q.gte('date', from);
        if (to)   q = q.lte('date', to);
        if (srId) q = q.eq('sr_id', srId);
        // v5.10 — optional ?type= filter (the ফেরত পণ্য page asks for type=return)
        if (req.query.type) q = q.eq('type', String(req.query.type));
        return q;
      });
      return res.json((await offerLib.hydrate(rows || [])).map(mapTx));
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};
