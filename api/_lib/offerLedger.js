// api/_lib/offerLedger.js — v5.26.0 (Session 2: company offer ledger)
// Helper only (lives in api/_lib → NOT a serverless function, API count stays 12).
//
// Everything here is DERIVED from stored snapshots (offer_deduction_total on sale / return rows). Current product
// prices / offers are never read. Company payments live in the settings store (app_settings.profit_rules._store
// ._offerPayments) so no migration is needed. Settlement is display-only: payments settle the OLDEST earned
// offers first (FIFO by sale date) and nothing old is ever rewritten.
const { supabase, num, fetchAll } = require('./db');
const snap = require('./snapshot');
const offer = require('./offer');

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAY_MAX = 5000;
const SALE_TYPES = ['dsr_sale', 'point_sale'];
const RET_TYPES = ['dsr_sale_return', 'point_damage_return'];

// ── pure: getOfferAllocation(sales, returns, payments) ───────────────────────────────────────────────
// sales / returns: [{ date:'YYYY-MM-DD', productId, productName?, cases, units(bottles), offerDeductionTotal }]
//   rows whose offerDeductionTotal is 0 are ignored (no offer was earned on them).
// payments: [{ id, date, amount, productIds?:[], from?, to?, close?:bool }]
//   productIds empty/missing = not tied to a product (settles all products, oldest first).
//   from/to (optional) = only offers EARNED in that period are settled by this payment.
//   close = owner chose "সমন্বয় সহ বন্ধ করুন" for an underpayment.
// Events are processed by date (same day: sales, then returns, then payments).
//   • sale          → new earned bucket (product, sale date)
//   • return        → lowers the oldest pending bucket(s) of that product (no pending left → credit that
//                     later sales absorb)
//   • payment       → settles the oldest pending buckets (sale date <= payment date, inside product/period scope)
//       amount > pending in scope  → POSITIVE adjustment (excess) on the payment date
//       amount < pending + close   → NEGATIVE adjustment (shortfall written off) on the payment date
//       otherwise                  → no adjustment, the rest stays pending
// Returns:
// { days:[{date, sold, returned, earned, received, adjusted, pending}],     // by SALE date, all products
//   products:{ [pid]:{productId, name, cases, bottles, soldCases, soldBottles, returnedCases, returnedBottles,
//                     earned, returned, received, adjusted, pending, balance, casesSincePayment, bottlesSincePayment,
//                     lastPaymentDate, daily:[{date,sold,returned,earned,received,adjusted,pending}] }},
//   total:{ sold, returned, earned, received, adjusted, pending, balance, adjustmentNet },
//   adjustments:[{ paymentId, date, amount(+/−), kind:'over'|'close', productId|null }],
//   payments:[{ id, date, amount, applied, over, writtenOff, adjustment, unsettledBefore }] }
//   earned = sold − returned (after FIFO offset) ; balance = pending (= earned − received − adjusted)
function getOfferAllocation(sales, returns, payments) {
  const ev = [];
  let seq = 0;
  (sales || []).forEach(s => { const d = r2(num(s.offerDeductionTotal)); if (d > 0 && s.productId) ev.push({ k: 0, seq: seq++, date: String(s.date || '').slice(0, 10), s, d }); });
  (returns || []).forEach(s => { const d = r2(num(s.offerDeductionTotal)); if (d > 0 && s.productId) ev.push({ k: 1, seq: seq++, date: String(s.date || '').slice(0, 10), s, d }); });
  (payments || []).forEach(p => { ev.push({ k: 2, seq: seq++, date: String(p.date || '').slice(0, 10), p }); });
  ev.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.k - b.k || a.seq - b.seq));

  const P = {};                       // product ledger
  const names = {};
  const prod = (pid, name) => {
    pid = String(pid); if (name && !names[pid]) names[pid] = name;
    return P[pid] || (P[pid] = { productId: pid, name: '', buckets: [], credit: 0, soldCases: 0, soldBottles: 0, returnedCases: 0, returnedBottles: 0, sold: 0, adj: 0, rows: [], lastPay: '' });
  };
  const pend = (b) => r2(b.sold - b.ret - b.rec - b.wo);
  const bucketOf = (pr, date) => { let b = pr.buckets.find(x => x.date === date); if (!b) { b = { date, sold: 0, ret: 0, rec: 0, wo: 0 }; pr.buckets.push(b); } return b; };

  const adjustments = [], payOut = [];
  let allLastPay = '';
  ev.forEach(e => {
    if (e.k === 0) {                                   // sale
      const pr = prod(e.s.productId, e.s.productName), b = bucketOf(pr, e.date);
      b.sold = r2(b.sold + e.d); pr.sold = r2(pr.sold + e.d);
      pr.soldCases += num(e.s.cases); pr.soldBottles += num(e.s.units);
      pr.rows.push({ date: e.date, cases: num(e.s.cases), bottles: num(e.s.units), sign: 1 });
      if (pr.credit > 0) { const c = Math.min(pr.credit, e.d); b.ret = r2(b.ret + c); pr.credit = r2(pr.credit - c); }   // an earlier "over-return" absorbs new earnings
    } else if (e.k === 1) {                            // return
      const pr = prod(e.s.productId, e.s.productName); let left = e.d;
      pr.returnedCases += num(e.s.cases); pr.returnedBottles += num(e.s.units);
      pr.rows.push({ date: e.date, cases: num(e.s.cases), bottles: num(e.s.units), sign: -1 });
      pr.buckets.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).forEach(b => { if (left <= 0) return; const p = pend(b); if (p <= 0) return; const t = Math.min(p, left); b.ret = r2(b.ret + t); left = r2(left - t); });
      if (left > 0) pr.credit = r2(pr.credit + left);
    } else {                                           // payment
      const p = e.p, amount = r2(num(p.amount));
      const scope = (p.productIds && p.productIds.length ? p.productIds.map(String) : Object.keys(P));
      const inPeriod = (d) => (!p.from || d >= p.from) && (!p.to || d <= p.to);
      const list = [];
      scope.forEach(pid => { const pr = P[pid]; if (!pr) return; pr.buckets.forEach(b => { if (b.date <= e.date && inPeriod(b.date) && pend(b) > 0) list.push({ pr, b }); }); });
      list.sort((a, b) => (a.b.date < b.b.date ? -1 : a.b.date > b.b.date ? 1 : String(a.pr.productId) < String(b.pr.productId) ? -1 : 1));
      const pendingBefore = r2(list.reduce((s, x) => s + pend(x.b), 0));
      let left = amount, applied = 0;
      list.forEach(x => { if (left <= 0) return; const t = Math.min(pend(x.b), left); x.b.rec = r2(x.b.rec + t); left = r2(left - t); applied = r2(applied + t); });
      let over = 0, written = 0, adjustment = 0;
      const single = (p.productIds && p.productIds.length === 1) ? String(p.productIds[0]) : null;
      if (left > 0.004) {                              // overpayment → positive adjustment
        over = r2(left); adjustment = over;
        adjustments.push({ paymentId: p.id, date: e.date, amount: over, kind: 'over', productId: single });
        if (single && P[single]) P[single].adj = r2(P[single].adj + over);
      } else if (p.close && pendingBefore - applied > 0.004) {   // underpayment closed with adjustment → negative
        list.forEach(x => { const q = pend(x.b); if (q > 0) { x.b.wo = r2(x.b.wo + q); written = r2(written + q); } });
        adjustment = -written;
        adjustments.push({ paymentId: p.id, date: e.date, amount: -written, kind: 'close', productId: single });
        if (single && P[single]) P[single].adj = r2(P[single].adj - written);
      }
      scope.forEach(pid => { if (P[pid] && (!p.productIds || !p.productIds.length || p.productIds.map(String).includes(pid))) P[pid].lastPay = e.date > P[pid].lastPay ? e.date : P[pid].lastPay; });
      if (!(p.productIds && p.productIds.length) && e.date > allLastPay) allLastPay = e.date;
      payOut.push({ id: p.id, date: e.date, amount, applied, over, writtenOff: written, adjustment, unsettledBefore: pendingBefore });
    }
  });

  // payments tied to a product that has no sales yet still need a last-payment date
  (payments || []).forEach(p => { (p.productIds || []).forEach(pid => { const pr = prod(pid, ''); const d = String(p.date || '').slice(0, 10); if (d > pr.lastPay) pr.lastPay = d; }); });

  const dayMap = {};
  const add = (m, d, f, v) => { const o = m[d] || (m[d] = { date: d, sold: 0, returned: 0, earned: 0, received: 0, adjusted: 0, pending: 0 }); o[f] = r2(o[f] + v); };
  const out = {}, tot = { sold: 0, returned: 0, earned: 0, received: 0, adjusted: 0, pending: 0, balance: 0, adjustmentNet: 0 };
  const allLast = allLastPay;
  Object.keys(P).forEach(pid => {
    const pr = P[pid], m = {};
    pr.buckets.forEach(b => {
      [m, dayMap].forEach(mm => { add(mm, b.date, 'sold', b.sold); add(mm, b.date, 'returned', b.ret); add(mm, b.date, 'received', b.rec); add(mm, b.date, 'adjusted', b.wo); add(mm, b.date, 'pending', pend(b)); });
    });
    const daily = Object.values(m).sort((a, b) => (a.date < b.date ? -1 : 1)); daily.forEach(d => { d.earned = r2(d.sold - d.returned); });
    const sum = (f) => r2(daily.reduce((s, d) => s + d[f], 0));
    const credit = pr.credit;                               // negative balance = we owe the company back (late return)
    const last = pr.lastPay > allLast ? pr.lastPay : allLast;
    let sc = 0, sb = 0; pr.rows.forEach(r => { if (!last || r.date > last) { sc += r.sign * r.cases; sb += r.sign * r.bottles; } });
    const o = {
      productId: pid, name: names[pid] || '', soldCases: pr.soldCases, soldBottles: pr.soldBottles, returnedCases: pr.returnedCases, returnedBottles: pr.returnedBottles,
      cases: pr.soldCases - pr.returnedCases, bottles: pr.soldBottles - pr.returnedBottles,
      sold: sum('sold'), returned: sum('returned'), earned: r2(sum('sold') - sum('returned') - credit), received: sum('received'), adjusted: sum('adjusted'),
      pending: r2(sum('pending') - credit), adjustmentNet: pr.adj, casesSincePayment: sc, bottlesSincePayment: sb, lastPaymentDate: last, daily
    };
    o.balance = o.pending; out[pid] = o;
    tot.sold = r2(tot.sold + o.sold); tot.returned = r2(tot.returned + o.returned + credit); tot.received = r2(tot.received + o.received); tot.adjusted = r2(tot.adjusted + o.adjusted); tot.pending = r2(tot.pending + o.pending);
  });
  tot.earned = r2(tot.sold - tot.returned); tot.balance = tot.pending; tot.adjustmentNet = r2(adjustments.reduce((s, a) => s + a.amount, 0));
  const days = Object.values(dayMap).sort((a, b) => (a.date < b.date ? -1 : 1)); days.forEach(d => { d.earned = r2(d.sold - d.returned); });
  return { days, products: out, total: tot, adjustments, payments: payOut, lastPaymentDate: allLast };
}

// ── memo / WhatsApp: cases + bottles per product for a date range ─────────────────────────────────────
// range { from, to } (inclusive) ; when absent → since the last company payment of each product.
function salesSummary(sales, returns, payments, range) {
  const a = getOfferAllocation(sales, returns, payments);
  const rows = [];
  const inR = (d) => range && (range.from || range.to) ? (!range.from || d >= range.from) && (!range.to || d <= range.to) : null;
  const agg = {};
  const take = (r, sign) => {
    const pid = String(r.productId); if (!(num(r.offerDeductionTotal) > 0) || !pid) return;
    const pa = a.products[pid]; if (!pa) return;
    const d = String(r.date || '').slice(0, 10);
    const ok = inR(d) === null ? (!pa.lastPaymentDate || d > pa.lastPaymentDate) : inR(d);
    if (!ok) return;
    const x = agg[pid] || (agg[pid] = { productId: pid, name: r.productName || pa.name, cases: 0, bottles: 0 });
    x.cases += sign * num(r.cases); x.bottles += sign * num(r.units);
  };
  (sales || []).forEach(r => take(r, 1)); (returns || []).forEach(r => take(r, -1));
  Object.values(agg).forEach(x => { if (x.cases || x.bottles) rows.push(x); });
  rows.sort((p, q) => String(p.name).localeCompare(String(q.name), 'bn'));
  return { rows, totalCases: rows.reduce((s, x) => s + x.cases, 0), totalBottles: rows.reduce((s, x) => s + x.bottles, 0), from: range && range.from || '', to: range && range.to || '' };
}

// ── roles ─────────────────────────────────────────────────────────────────────────────────────────────
// read: the caller must be a known owner / manager (actorId looked up in user_passwords)
// write: the caller's OWN password (pin) must match and the role must be owner / manager
async function roleOf(actorId) {
  const id = String(actorId || '').trim(); if (!id) return '';
  try { const { data } = await supabase.from('user_passwords').select('role').eq('user_key', id).limit(1); return (data && data[0] && data[0].role) || ''; } catch (e) { return ''; }
}
async function canRead(d) { const r = await roleOf(d && d.actorId); return r === 'owner' || r === 'manager' ? r : ''; }
async function canWrite(d) {
  const id = String((d && d.actorId) || '').trim(), pin = String((d && d.pin) || '').trim(); if (!id || !pin) return '';
  try {
    const { data } = await supabase.from('user_passwords').select('role').eq('user_key', id).eq('password', pin).limit(1);
    const r = data && data[0] && data[0].role; return r === 'owner' || r === 'manager' ? r : '';
  } catch (e) { return ''; }
}

// ── data ──────────────────────────────────────────────────────────────────────────────────────────────
function norm(r) { return { date: String(r.date || '').slice(0, 10), productId: String(r.product_id || ''), productName: r.product_name || '', cases: num(r.cases), units: num(r.total_units), offerDeductionTotal: offer.dedOf(r), type: r.type }; }
async function loadRows() {
  const start = await offer.getStartDate();
  if (!start) return { sales: [], returns: [], start: '' };
  const oc = await offer.selCols();
  const rows0 = await fetchAll(() => supabase.from('transactions').select('tx_id,type,date,product_id,product_name,cases,total_units' + oc).in('type', SALE_TYPES.concat(RET_TYPES)).gte('date', start));
  const rows = (await offer.hydrate(rows0 || [])).map(norm).filter(r => r.offerDeductionTotal > 0);
  return { sales: rows.filter(r => SALE_TYPES.includes(r.type)), returns: rows.filter(r => RET_TYPES.includes(r.type)), start };
}

// ── payments store ────────────────────────────────────────────────────────────────────────────────────
async function readPayments() { const st = await snap.storeRead(); return Array.isArray(st._offerPayments) ? st._offerPayments : []; }
async function writePayments(list) { return snap.storeWrite({ _offerPayments: list.slice(-PAY_MAX) }); }
function cleanPayment(d, id, by) {
  const date = String(d.date || '').slice(0, 10), amount = r2(num(d.amount));
  if (!DATE_RE.test(date)) return { error: 'তারিখ সঠিক নয়' };
  if (!(amount > 0)) return { error: 'টাকার পরিমাণ লিখুন' };
  const ids = Array.isArray(d.productIds) ? [...new Set(d.productIds.map(String).filter(Boolean))] : [];
  const from = DATE_RE.test(String(d.from || '')) ? String(d.from) : '', to = DATE_RE.test(String(d.to || '')) ? String(d.to) : '';
  if (from && to && from > to) return { error: 'সময়কাল সঠিক নয়' };
  return { p: { id, date, amount, note: String(d.note || '').slice(0, 300), productIds: ids, from, to, close: !!d.close, by: by || '', at: new Date().toISOString() } };
}
async function ledger() {
  const [rows, payments] = await Promise.all([loadRows(), readPayments()]);
  return { start: rows.start, payments, alloc: getOfferAllocation(rows.sales, rows.returns, payments), rows };
}


// ── Session 3: offer figures for a profit period (sale-date based) ───────────────────────────────────
// earned/sold/returned/received/pending are the sum of the DAYS (by sale date) inside [from,to];
// adjustments (সমন্বয়) are counted on the PAYMENT date inside [from,to] — the only payment effect on profit.
function profitOfferFrom(a, payments, from, to) {
  const inR = d => d >= from && d <= to;
  const o = { sold: 0, returned: 0, earned: 0, received: 0, pending: 0, adjustment: 0, adjustments: [], payments: [], days: {} };
  (a.days || []).forEach(d => {
    o.days[d.date] = d;
    if (!inR(d.date)) return;
    o.sold = r2(o.sold + num(d.sold)); o.returned = r2(o.returned + num(d.returned)); o.earned = r2(o.earned + num(d.earned));
    o.received = r2(o.received + num(d.received)); o.pending = r2(o.pending + num(d.pending));
  });
  (a.adjustments || []).forEach(x => { if (inR(x.date)) { o.adjustment = r2(o.adjustment + num(x.amount)); o.adjustments.push(x); } });
  (payments || []).forEach(p => { if (inR(String(p.date || '').slice(0, 10))) o.payments.push({ id: p.id, date: p.date, amount: num(p.amount), note: p.note || '' }); });
  // which payment settled the offer of a sale day in range (for the detail view)
  o.settledBy = [];
  (a.payments || []).forEach(p => { if (num(p.applied) > 0) { const pp = (payments || []).find(x => x.id === p.id); o.settledBy.push({ id: p.id, date: p.date, amount: num(p.amount), applied: num(p.applied) }); } });
  o.balanceAll = num(a.total && a.total.balance);
  return o;
}
async function profitOffer(from, to) {
  try { const L = await ledger(); return profitOfferFrom(L.alloc, L.payments, from, to); }
  catch (e) { return profitOfferFrom({ days: [], adjustments: [], payments: [], total: {} }, [], from, to); }
}
// one owner/manager check shared by dashboard.js / report.js (profit & offer data never goes to anyone else)
async function profitAllowed(q) {
  const role = String((q && q.role) || '');
  if (role === 'dsr' || role === 'so' || role === 'driver') return false;
  return !!(await canRead({ actorId: q && (q.actorId || q.userId) }));
}

module.exports = { profitOffer, profitOfferFrom, profitAllowed, getOfferAllocation, salesSummary, roleOf, canRead, canWrite, loadRows, readPayments, writePayments, cleanPayment, ledger, r2 };
