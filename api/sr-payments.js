const { supabase, cors, num, now_, mapPayment, mapOrder, safeErr, fetchAll, bdtToday, computeVanStock, computeVanDetail, applyDuePayment, getDueTotals, idemRun, pageParams, blockNegativeStock } = require('./_lib/db');
const { priceItems, txRow, stockShortage, weightedGivePrices, loadProducts, lineMoney, bonusSnapshot, r2: _m2 } = require('./_lib/money');
const { randomUUID } = require('crypto');
const offerLib = require('./_lib/offer');   // v5.25
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAY_COLS = 'id,sr_id,sr_name,date,amount,cash_amount,commission_amt,discount_amt,damage_amt,note,created_at';

// CALC-5 — an order/loading list must carry the REAL prices. The browser's
// numbers are replaced with the products table's values (units re-derived
// from cases/pcs). Other fields on each item (id, thumb, …) are kept.
async function _repriceItems(items) {
  // lines with nothing in them (a removed row on the loading screen) stay as they are
  const idx = [];
  items.forEach((it, i) => { if (num(it.totalUnits) > 0 || num(it.cases) > 0 || num(it.pcs) > 0) idx.push(i); });
  const priced = idx.length ? await priceItems(idx.map(i => items[i]), { type: 'give' }) : { ok: true, lines: [] };
  if (!priced.ok) return priced;
  const out = items.map(it => Object.assign({}, it));
  idx.forEach((i, k) => {
    const l = priced.lines[k];
    Object.assign(out[i], {
      productName: l.productName, sku: l.sku, cases: l.cases, pcs: l.pcs, totalUnits: l.units,
      sellingPrice: l.sellingPrice, purchasePrice: l.purchasePrice
    });
  });
  return { ok: true, items: out, amount: _m2(priced.lines.reduce((s, l) => s + l.revenue, 0)) };
}


// ── v5.7 — payment safety ─────────────────────────────────────────────
// 1) every manual payment / settlement needs the acting user's own password
// 2) a payment can never be larger than what the person actually owes right now
// 3) the same payment cannot be saved twice within a short time (double tap / re-click)
async function _verifyActor(actorId, pin) {
  const p = String(pin == null ? '' : pin).trim();
  if (!actorId || !p) return { ok: false, needPin: true, error: 'পাসওয়ার্ড দিন' };
  const { data, error } = await supabase.from('user_passwords').select('user_key')
    .eq('user_key', String(actorId)).eq('password', p).limit(1);
  if (error) throw error;
  if (!data || !data.length) return { ok: false, badPin: true, error: 'পাসওয়ার্ড ভুল — কিছুই সংরক্ষিত হয়নি' };
  return { ok: true };
}
async function _currentDue(srId) {
  const t = (await getDueTotals([String(srId)]))[String(srId)] || { givenRev: 0, returnRev: 0, payments: 0 };
  return _m2((t.givenRev - t.returnRev) - t.payments);
}
async function _paymentGuard(srId, total, date) {
  const due = await _currentDue(srId);
  if (due <= 0.004) return 'এই ব্যক্তির কোনো বাকি নেই — আর টাকা নেওয়া যাবে না';
  if (total > due + 0.004) return 'বাকি আছে মাত্র ৳' + due.toFixed(2) + ' — এর বেশি নেওয়া যাবে না';
  const since = new Date(Date.now() - 120000).toISOString();
  const { data: dup } = await supabase.from('sr_payments').select('id').eq('sr_id', String(srId))
    .eq('amount', total).gte('created_at', since).limit(1);
  if (dup && dup.length) return 'একই পরিমাণ টাকা এইমাত্র নেওয়া হয়েছে — আবার চাপবেন না। (ভুল হলে ২ মিনিট পর আবার চেষ্টা করুন)';
  return null;
}

// POST actions that move money / stock — protected against double taps (CALC-8).
const IDEM_ACTIONS = new Set(['order_submit', 'give_direct', 'due-collect', 'damage-collect']);


// v5.21 — shared by every due-collection list: groups open due rows by shop and adds the shop's GPS,
// its own DSR and its road, so the app can sort "nearest first" for every role.
async function _dueShopsPayload(rows) {
  const shopIds = [...new Set(rows.map(r => String(r.shop_id || '')).filter(Boolean))];
  const shopMap = {};
  for (let i = 0; i < shopIds.length; i += 80) {
    const { data: sh, error: sErr } = await supabase.from('shops').select('id,shop_no,name,keeper_name,phone,address,road_name,lat,lng,assigned_dsr_id').in('id', shopIds.slice(i, i + 80));
    if (sErr) throw sErr;
    (sh || []).forEach(x => { shopMap[String(x.id)] = x; });
  }
  const dsrIds = [...new Set(Object.values(shopMap).map(x => String(x.assigned_dsr_id || '')).filter(Boolean))];
  const dsrName = {};
  if (dsrIds.length) {
    const { data: ss } = await supabase.from('srs').select('id,name').in('id', dsrIds);
    (ss || []).forEach(x => { dsrName[String(x.id)] = x.name || ''; });
  }
  const grouped = {};
  rows.forEach(r => {
    const sid = String(r.shop_id || '');
    const rem = num(r.amount) - num(r.paid_amount);
    if (rem <= 0.0001) return;
    if (!grouped[sid]) {
      const sh = shopMap[sid] || {};
      grouped[sid] = {
        shopId: sid, shopNo: sh.shop_no || '', shopName: sh.name || r.shop_name || 'অজানা দোকান',
        keeperName: sh.keeper_name || '', phone: sh.phone || '', address: sh.address || '', roadName: sh.road_name || '',
        lat: sh.lat != null ? Number(sh.lat) : null, lng: sh.lng != null ? Number(sh.lng) : null,
        assignedDsrId: String(sh.assigned_dsr_id || ''), assignedDsrName: dsrName[String(sh.assigned_dsr_id || '')] || '',
        totalDue: 0, dues: []
      };
    }
    grouped[sid].totalDue += rem;
    grouped[sid].dues.push({ id: String(r.id), dueDate: String(r.due_date || '').slice(0, 10), amount: num(r.amount), paid: num(r.paid_amount), remaining: rem, note: r.note || '' });
  });
  const shops = Object.values(grouped).sort((x, y) => y.totalDue - x.totalDue);
  shops.forEach(x => x.dues.sort((p, q) => p.dueDate.localeCompare(q.dueDate)));
  return { ok: true, shops, totalDue: shops.reduce((t, x) => t + x.totalDue, 0) };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';
  // a plain POST with no action is the manual payment entry
  if (req.method === 'POST' && (IDEM_ACTIONS.has(action) || action === '')) {
    try { return await idemRun(req, res, 'srpay-' + (action || 'payment'), () => _handle(req, res, action)); }
    catch (e) { return res.json({ ok: false, error: safeErr(e) }); }
  }
  return _handle(req, res, action);
};

async function _handle(req, res, action) {
  try {
    // v5.18 — the owner-approval queue (manager entries waiting for the owner) has been removed:
    // every transaction is saved straight away by whoever enters it.

    // ══════════════════════════════════════════════════
    //  SO ORDERING → APPROVAL → VAN-LOAD WORKFLOW (AXIION §13)
    // ══════════════════════════════════════════════════

    // POST — SO places a new order
    if (req.method === 'POST' && action === 'order_submit') {
      const d = req.body || {};
      const items = Array.isArray(d.items) ? d.items : [];
      if (!d.soId || !items.length) return res.json({ ok: false, error: 'soId ও items প্রয়োজন' });
      const rp = await _repriceItems(items);
      if (!rp.ok) return res.json({ ok: false, error: rp.error });
      items.splice(0, items.length, ...rp.items);
      const requestedAmount = rp.amount;

      // AXIION §17-follow-up / Update #20: auto-carry the SO's
      // same-numbered auto-paired DSR (so_id, set automatically by
      // api/srs.js at registration time — no manual handshake anymore)
      // onto the order at the moment it's placed, so Manager/Owner no
      // longer have to hand-pick a DSR at approval time — they just
      // approve and it's already routed to the paired DSR. If this SO
      // has no same-numbered DSR registered yet, this stays blank and
      // the approver falls back to picking one manually (see order_approve).
      let autoDsrId = '';
      const { data: pairedDsr } = await supabase.from('srs')
        .select('id').eq('so_id', String(d.soId)).eq('role', 'dsr').limit(1);
      if (pairedDsr && pairedDsr.length) autoDsrId = String(pairedDsr[0].id);

      // v60 — SIMPLIFIED FLOW: an SO's order goes STRAIGHT to the paired
      // DSR's van-load list (status 'approved' = ready to load). No
      // manager/owner approval step. Stock only moves when the DSR
      // presses OK after loading (van_load_complete). Owner/manager can
      // still watch everything in the Orders monitor. Only if the SO has
      // no paired DSR yet does the order wait ('pending') for someone to
      // assign one.
      const ts0 = now_();
      const { data, error } = await supabase.from('orders').insert({
        id: randomUUID(), so_id: String(d.soId), so_name: d.soName || '',
        items, original_items: items, requested_amount: requestedAmount,
        status: autoDsrId ? 'approved' : 'pending',
        assigned_dsr_id: autoDsrId, load_status: 'not_started', load_ticks: {},
        approved_by: autoDsrId ? 'auto' : '', approved_at: autoDsrId ? ts0 : null,
        created_at: ts0
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, order: mapOrder(data), autoAssigned: !!autoDsrId });
    }

    // POST — Modify an order's quantities (v60: no approval loop).
    //  Applies immediately for everyone (manager / owner / the DSR who is
    //  about to load it). The first time an order is edited, the original
    //  quantities are kept in original_items so the owner can always see
    //  "ordered X → loaded Y" in the Orders monitor.
    if (req.method === 'POST' && action === 'order_modify') {
      const d = req.body || {};
      if (!d.id || !Array.isArray(d.items)) return res.json({ ok: false, error: 'id ও items প্রয়োজন' });
      const { data: cur, error: curErr } = await supabase.from('orders').select('status,load_status,items,original_items').eq('id', d.id).single();
      if (curErr) throw curErr;
      if (!cur) return res.json({ ok: false, error: 'অর্ডার পাওয়া যায়নি' });
      if (cur.load_status === 'loaded' || cur.status === 'rejected')
        return res.json({ ok: false, error: 'এই অর্ডার আর পরিবর্তন করা যাবে না' });
      const rpM = await _repriceItems(d.items);
      if (!rpM.ok) return res.json({ ok: false, error: rpM.error });
      d.items = rpM.items;
      const modifiedAmount = rpM.amount;
      const who = ['manager', 'owner', 'dsr'].includes(d.requestedBy) ? d.requestedBy : 'manager';
      const { error } = await supabase.from('orders').update({
        items: d.items, modified_by: who, modified_amount: modifiedAmount, proposed_items: null,
        original_items: cur.original_items || cur.items,
        status: cur.status === 'modified_pending' ? 'pending' : cur.status
      }).eq('id', d.id);
      if (error) throw error;
      return res.json({ ok: true, appliedDirectly: true });
    }

    // POST — Manager/Owner finalises an order (accepts any DSR proposal
    // too) and assigns it as a Load Task to a DSR.
    // dsrId is now OPTIONAL — if the SO was connected to a DSR when the
    // order was placed (order_submit auto-fills assigned_dsr_id from that
    // pairing), Manager/Owner just approve as-is. dsrId is only needed
    // as a manual override/fallback when no pairing existed at submit time.
    if (req.method === 'POST' && action === 'order_approve') {
      const { id, dsrId, approvedBy } = req.body || {};
      if (!id) return res.json({ ok: false, error: 'id প্রয়োজন' });
      const { data: row, error: fetchErr } = await supabase.from('orders').select('*').eq('id', id).single();
      if (fetchErr) throw fetchErr;
      if (!row || !['pending', 'modified_pending'].includes(row.status))
        return res.json({ ok: false, error: 'অর্ডার পাওয়া যায়নি বা ইতিমধ্যে প্রক্রিয়া হয়েছে' });

      const finalDsrId = String(dsrId || row.assigned_dsr_id || '');
      if (!finalDsrId)
        return res.json({ ok: false, error: 'এই SO কোনো DSR এর সাথে সংযুক্ত নয় — অনুমোদনের আগে ম্যানুয়ালি একজন DSR নির্বাচন করুন' });

      const finalItems = row.status === 'modified_pending' && row.proposed_items ? row.proposed_items : row.items;
      const { error } = await supabase.from('orders').update({
        items: finalItems, proposed_items: null, original_items: row.original_items || row.items,
        status: 'approved', assigned_dsr_id: finalDsrId, load_status: 'not_started', load_ticks: {},
        approved_by: approvedBy || '', approved_at: now_()
      }).eq('id', id);
      if (error) throw error;
      return res.json({ ok: true, dsrId: finalDsrId });
    }

    // POST — Manager/Owner rejects a pending SO order outright
    if (req.method === 'POST' && action === 'order_reject') {
      const { id } = req.body || {};
      if (!id) return res.json({ ok: false, error: 'id প্রয়োজন' });
      const { data: row, error: fetchErr } = await supabase.from('orders').select('status').eq('id', id).single();
      if (fetchErr) throw fetchErr;
      if (!row || !['pending', 'modified_pending'].includes(row.status))
        return res.json({ ok: false, error: 'অর্ডার পাওয়া যায়নি বা ইতিমধ্যে প্রক্রিয়া হয়েছে' });
      const { error } = await supabase.from('orders').update({ status: 'rejected' }).eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    // POST — Owner/Manager gives stock directly to a DSR. Instead of an
    // instant stock write, this creates an already-approved Load Task
    // exactly like an approved SO order — the DSR must physically tick
    // each item and press "Finish Loading" before stock actually leaves
    // the warehouse. (Owner's give needs no further approval; a
    // Manager's give still goes through the existing approval_submit →
    // Owner-approval queue first — see _doApprove below, which now
    // routes an approved Manager "give" through this same path instead
    // of writing straight to transactions.)
    if (req.method === 'POST' && action === 'give_direct') {
      const d = req.body || {};
      const items = Array.isArray(d.items) ? d.items : [];
      if (!d.dsrId || !items.length) return res.json({ ok: false, error: 'dsrId ও items প্রয়োজন' });
      const rpG = await _repriceItems(items);
      if (!rpG.ok) return res.json({ ok: false, error: rpG.error });
      items.splice(0, items.length, ...rpG.items);
      const requestedAmount = rpG.amount;
      const who = d.requestedBy === 'manager' ? 'ম্যানেজার' : 'মালিক';
      const label = 'দেওয়া (' + who + (d.requestedByName ? ' — ' + d.requestedByName : '') + ')';
      const { data, error } = await supabase.from('orders').insert({
        id: randomUUID(), so_id: '', so_name: label,
        items, original_items: items, requested_amount: requestedAmount,
        status: 'approved', assigned_dsr_id: String(d.dsrId), load_status: 'not_started', load_ticks: {},
        approved_by: d.requestedBy || 'owner', approved_at: now_(), created_at: now_()
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, order: mapOrder(data) });
    }

    // GET — order queue for Manager/Owner (all) or a specific SO (own only)
    if (req.method === 'GET' && action === 'orders_list') {
      const { soId, status } = req.query;
      let q = supabase.from('orders').select('*').order('created_at', { ascending: false });
      if (soId) q = q.eq('so_id', soId);
      if (status) q = q.eq('status', status);
      const { data, error } = await q;
      if (error) throw error;
      return res.json({ ok: true, orders: (data || []).map(mapOrder) });
    }

    // GET — DSR's pending load checklist
    if (req.method === 'GET' && action === 'van_load_list') {
      const { dsrId } = req.query;
      if (!dsrId) return res.json({ ok: false, error: 'dsrId প্রয়োজন' });
      const { data, error } = await supabase.from('orders')
        .select('*').eq('assigned_dsr_id', dsrId).eq('status', 'approved')
        .in('load_status', ['not_started', 'loading']).order('approved_at');
      if (error) throw error;
      return res.json({ ok: true, orders: (data || []).map(mapOrder) });
    }

    // POST — DSR ticks one product line as physically loaded.
    // Kept for backward compatibility only — Update #28 replaced the
    // per-item ticking UI with a single "সম্পন্ন" button (see
    // van_load_complete below), so the front-end no longer calls this.
    if (req.method === 'POST' && action === 'van_load_tick') {
      const { id, itemId, ticked } = req.body || {};
      if (!id || !itemId) return res.json({ ok: false, error: 'id ও itemId প্রয়োজন' });
      const { data: row, error: fetchErr } = await supabase.from('orders').select('load_ticks').eq('id', id).single();
      if (fetchErr) throw fetchErr;
      const ticks = { ...(row.load_ticks || {}), [itemId]: ticked !== false };
      const { error } = await supabase.from('orders')
        .update({ load_ticks: ticks, load_status: 'loading' }).eq('id', id);
      if (error) throw error;
      return res.json({ ok: true, loadTicks: ticks });
    }

    // ══════════════════════════════════════════════════
    //  Update #28 — Simplify DSR Van-Load Completion
    //  Old flow: DSR ticks every product line individually, then presses
    //  "Finish Loading" once every tick is checked, which immediately
    //  wrote the `give` transactions and deducted stock right there.
    //  New flow: DSR sees the whole approved list at once (color-coded
    //  rows, no per-item clicking) and presses one single "সম্পন্ন"
    //  (Complete) button. That only tells the Manager/Owner "this load
    //  is physically complete" (load_status → 'load_complete') — it does
    //  NOT touch stock or write any transaction yet. The real `give`
    //  transactions (and the stock deduction) only happen once
    //  Manager/Owner reviews and confirms the completed load via
    //  van_load_confirm below — same underlying write as the old
    //  van_load_finish, just moved to sit behind an explicit
    //  Manager/Owner approval step instead of the DSR's own tap, so
    //  stock only ever leaves the warehouse with a second set of eyes
    //  on it (consistent with every other stock-affecting action in the
    //  app, which all go through an approval gate before touching stock).
    // ══════════════════════════════════════════════════

    // POST — DSR presses OK after loading the van (v60).
    // THIS is the moment stock leaves the warehouse: the `give`
    // transactions are written right here (DB trigger deducts stock).
    // No manager/owner confirmation any more.
    if (req.method === 'POST' && action === 'van_load_complete') {
      const { id } = req.body || {};
      if (!id) return res.json({ ok: false, error: 'id প্রয়োজন' });
      const r = await _loadAndDeduct(id, ['not_started', 'loading', 'load_complete']);
      return res.json(r);
    }

    // GET — Manager/Owner: queue of DSR-completed loads awaiting confirmation
    if (req.method === 'GET' && action === 'van_load_confirm_list') {
      const { dsrId } = req.query;
      let q = supabase.from('orders').select('*').eq('status', 'approved').eq('load_status', 'load_complete').order('created_at');
      if (dsrId) q = q.eq('assigned_dsr_id', dsrId);
      const { data, error } = await q;
      if (error) throw error;
      return res.json({ ok: true, orders: (data || []).map(mapOrder) });
    }

    // POST — legacy: loads the old flow had left waiting for confirmation.
    // Kept so any order already in 'load_complete' can still be finished.
    if (req.method === 'POST' && (action === 'van_load_confirm' || action === 'van_load_finish')) {
      const { id } = req.body || {};
      if (!id) return res.json({ ok: false, error: 'id প্রয়োজন' });
      const r = await _loadAndDeduct(id, ['load_complete']);
      return res.json(r);
    }

    // ══════════════════════════════════════════════════
    //  DSR RECONCILE (V31) — "how much can we actually collect from him
    //  today, and how much stays as due" — used by the SR পেমেন্ট (Payment)
    //  entry screen. lifetimeDue mirrors the exact give/return/payments
    //  formula used everywhere else in the app (dashboard.js ownDue) so
    //  it always agrees with the DSR's own dashboard figure. The `today`
    //  block additionally breaks out how much of today's given stock he
    //  has actually sold to shops (dsr_sale — doesn't touch stock/due by
    //  itself), how much cash he already collected from those shop sales
    //  (should be handed over now), how much became a fresh shop-credit
    //  due today (visible, but still under his name until collected), and
    //  how much given stock is still unaccounted for (still on the van /
    //  not yet sold, returned, or damaged).
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'dsr-reconcile') {
      const { dsrId, date } = req.query;
      if (!dsrId) return res.json({ ok: false, error: 'dsrId প্রয়োজন' });
      const d = (date && DATE_RE.test(date)) ? date : bdtToday();   // CALC-4: Dhaka day

      // Lifetime due — the ONE shared calculation (Postgres SUM) every panel
      // uses, instead of downloading this DSR's whole history again (PERF-3).
      const _dt = (await getDueTotals([String(dsrId)]))[String(dsrId)] || { givenRev: 0, returnRev: 0, payments: 0 };
      const lifetimeDue = (_dt.givenRev - _dt.returnRev) - _dt.payments;

      // Today's movement — given / returned / damage / sold-to-shops.
      // V35 — damage here uses total_revenue (SELLING price), not
      // total_cost (buying price): this is the DSR Payment page, where
      // damage represents value the DSR is no longer expected to collect
      // from customers (a selling-price figure), NOT the separate
      // buying-price reimbursement claim shown on the Damage Report
      // (dmg_claims / api/claims.js) — those two stay intentionally
      // different. commission_amt/discount_amt (V35 columns, populated
      // on 'dsr_sale' rows) give the DSR Payment page real "today's
      // commission" / "today's discount" totals instead of leaving them
      // for the manager to guess and type manually.
      const { data: dayTx0, error: dayTxErr } = await supabase.from('transactions')
        .select('tx_id,product_id,type,total_revenue,total_cost,commission_amt,discount_amt' + await offerLib.selCols()).eq('sr_id', dsrId).eq('date', d)
        .in('type', ['give', 'return', 'damage', 'dsr_sale']);
      if (dayTxErr) throw dayTxErr;
      const dayTx = await offerLib.hydrate(dayTx0 || []);
      const offerToday = offerLib.netDeduction(dayTx.filter(r => r.type === 'dsr_sale'));   // v5.25 company offer deduction (already inside the reduced bills)
      const sum = (t, f) => (dayTx || []).filter(r => r.type === t).reduce((s, r) => s + num(r[f]), 0);
      const givenToday       = sum('give', 'total_revenue');
      const returnedToday    = sum('return', 'total_revenue');
      const damageToday      = sum('damage', 'total_revenue');
      const soldToShopsToday = sum('dsr_sale', 'total_revenue');
      const commissionToday  = sum('dsr_sale', 'commission_amt');
      const discountToday    = sum('dsr_sale', 'discount_amt');

      // Cash actually collected today vs. fresh shop-credit created today.
      const { data: dueToday, error: dueTodayErr } = await supabase.from('due_calendar')
        .select('amount,paid_amount').eq('dsr_id', dsrId).eq('client_type', 'shop').eq('due_date', d);
      if (dueTodayErr) throw dueTodayErr;
      const cashCollectedToday  = (dueToday || []).reduce((s, r) => s + num(r.paid_amount), 0);
      const shopDueCreatedToday = (dueToday || []).reduce((s, r) => s + (num(r.amount) - num(r.paid_amount)), 0);
      const stillWithDsrToday   = givenToday - returnedToday - damageToday - soldToShopsToday;

      return res.json({
        ok: true, dsrId: String(dsrId), date: d,
        lifetimeDue,
        today: {
          givenToday, returnedToday, damageToday, soldToShopsToday,
          commissionToday, discountToday, offerToday,
          cashCollectedToday, shopDueCreatedToday, stillWithDsrToday
        }
      });
    }

    // ══════════════════════════════════════════════════
    //  v5.2 — DSR "আমার লেনদেন" (My Transactions) day summary
    //  GET dsr-my-day  dsrId, from, to   (from/to default = today, Dhaka)
    //  Five money boxes + the cash the DSR must hand over, each with the
    //  line-by-line history behind it (what product / which shop).
    //
    //    given      Σ 'give' revenue                       (stock loaded)
    //    return     Σ 'return' revenue                     (stock handed back)
    //    damage     van damage + damage taken back from shops (money/exchange)
    //    commission Σ commission_amt on 'dsr_sale' rows    (per shop / product)
    //    discount   Σ discount_amt   on 'dsr_sale' rows    (per shop / product)
    //    todayDue   remaining (unpaid) credit on this DSR's due rows dated inside from..to
    //    prevDue    remaining (unpaid) credit on this DSR's / his shops' due rows dated BEFORE from
    //               (same today/previous split the companion Due Report uses)
    //    cashInHand = cash shops paid at the sale
    //               + old dues collected
    //               − cash paid to shops for damaged goods
    //    (the very same cash formula the end-of-day settlement uses, so the
    //     number the DSR sees here is the number the manager expects)
    //  Read-only: nothing is written, no new table, no new function file.
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'dsr-my-day') {
      const { dsrId } = req.query;
      if (!dsrId) return res.json({ ok: false, error: 'dsrId প্রয়োজন' });
      const today = bdtToday();
      let from = DATE_RE.test(req.query.from || '') ? req.query.from : today;
      let to   = DATE_RE.test(req.query.to   || '') ? req.query.to   : from;
      if (to < from) { const t = from; from = to; to = t; }
      if ((Date.parse(to) - Date.parse(from)) / 86400000 > 92) return res.json({ ok: false, error: 'সর্বোচ্চ ৯৩ দিনের হিসাব দেখা যায়' });
      const isAll = String(dsrId) === 'all';
      // v5.7 — dsrId=all → every DSR together (owner / manager "সব DSR একসাথে")
      let dsrIdsAll = [];
      const nameById = {};
      {
        const { data: srAll } = await supabase.from('srs').select('id,name,role,so_id');
        (srAll || []).forEach(r => { nameById[String(r.id)] = r.name || ''; });
        // v5.15 — optional soId=<SO> narrows 'all' to that SO's own DSRs (SO home grid)
        const _soScope = String(req.query.soId || '');
        if (isAll) dsrIdsAll = (srAll || []).filter(r => (r.role || 'dsr') === 'dsr' && (!_soScope || String(r.so_id || '') === _soScope)).map(r => String(r.id));
      }
      const sid = isAll ? 'all' : String(dsrId);
      const ids = isAll ? dsrIdsAll : [sid];
      if (!ids.length) return res.json({ ok: false, error: 'কোনো DSR পাওয়া যায়নি' });

      const _oc2 = await offerLib.selCols();
      const [txs0, dueRows, dueCols, dmgCols, settled, settledAll] = await Promise.all([
        fetchAll(() => supabase.from('transactions')
          .select('sr_id,tx_id,type,date,product_id,product_name,cases,pcs,total_units,total_revenue,commission_amt,discount_amt,shop_id,created_at' + _oc2)
          .in('sr_id', ids).gte('date', from).lte('date', to).in('type', ['give', 'return', 'damage', 'dsr_sale', 'point_sale', 'point_damage_return', 'dsr_sale_return']).order('created_at')),
        fetchAll(() => supabase.from('due_calendar').select('id,dsr_id,shop_id,shop_name,due_date,amount,paid_amount,created_at')
          .eq('client_type', 'shop').in('dsr_id', ids).gte('due_date', from).lte('due_date', to)),
        fetchAll(() => supabase.from('due_collections').select('due_id,dsr_id,shop_id,shop_name,date,amount,created_at')
          .in('dsr_id', ids).gte('date', from).lte('date', to).order('created_at')),
        fetchAll(() => supabase.from('damage_collections').select('*')
          .in('dsr_id', ids).gte('date', from).lte('date', to).order('created_at')),
        fetchAll(() => supabase.from('dsr_settlements').select('dsr_id,date,cash_received')
          .in('dsr_id', ids).gte('date', from).lte('date', to)),
        // v5.8 — everything ever received from this DSR (all dates) for the red top box.
        // PERF: only the all-time TOTAL is needed — computed in the database (migrations/004_perf.sql);
        // falls back to a one-column fetch if that function is not installed yet.
        (async () => {
          try {
            const { data, error } = await supabase.rpc('dsr_received_total', { p_ids: ids.map(String) });
            if (!error && data !== null && data !== undefined) return Number(Array.isArray(data) ? (data[0] && Object.values(data[0])[0]) : data) || 0;
          } catch (_) {}
          const rows = await fetchAll(() => supabase.from('dsr_settlements').select('cash_received').in('dsr_id', ids));
          return rows.reduce((a, r) => a + num(r.cash_received), 0);
        })()
      ]);

      // shop names for the commission / discount history
      const txs = await offerLib.hydrate(txs0 || []);
      const shopIds = [...new Set((txs || []).filter(r => (r.type === 'dsr_sale' || r.type === 'point_sale') && r.shop_id).map(r => String(r.shop_id)))];
      const shopName = {}, shopPhone = {};
      {
        const allIds = [...new Set([...shopIds, ...(dmgCols || []).filter(r => r.shop_id).map(r => String(r.shop_id)),
          ...(dueRows || []).filter(r => r.shop_id).map(r => String(r.shop_id)), ...(dueCols || []).filter(r => r.shop_id).map(r => String(r.shop_id))])];
        if (allIds.length) {
          const { data: shRows } = await supabase.from('shops').select('id,name,phone').in('id', allIds);
          (shRows || []).forEach(r => { shopName[String(r.id)] = r.name || ''; shopPhone[String(r.id)] = r.phone || ''; });
        }
      }

      // case size per product — lets every line be shown as "X কেস Y পিস"
      // (never a bare total-piece number)
      const csMap = {}, csByName = {};
      {
        const { data: prRows } = await supabase.from('products').select('id,name,case_size');
        (prRows || []).forEach(r => { const c = Math.max(1, Math.round(num(r.case_size)) || 1); csMap[String(r.id)] = c; csByName[String(r.name || '')] = c; });
      }
      const split = (units, pid, pname) => {
        const cs = csMap[String(pid || '')] || csByName[String(pname || '')] || 1;
        const u = Math.max(0, Math.round(num(units)));
        return { cases: Math.floor(u / cs), pcs: u % cs };
      };

      // today's due / previous due (unpaid credit only)
      let myShopIds2 = [];
      {
        const { data: mine } = await supabase.from('shops').select('id').in('assigned_dsr_id', ids);
        myShopIds2 = (mine || []).map(x => String(x.id));
      }
      const DUE_SEL = 'id,dsr_id,shop_id,shop_name,due_date,amount,paid_amount,note,status,created_at';
      const [dueA, dueB] = await Promise.all([
        fetchAll(() => supabase.from('due_calendar').select(DUE_SEL).eq('client_type', 'shop').in('dsr_id', ids).neq('status', 'cleared').lte('due_date', to)),
        myShopIds2.length
          ? fetchAll(() => supabase.from('due_calendar').select(DUE_SEL).eq('client_type', 'shop').in('shop_id', myShopIds2).neq('status', 'cleared').lt('due_date', from))
          : Promise.resolve([])
      ]);
      // phones of shops that only appear in the due lists (not looked up above)
      {
        const need = [...new Set([...(dueA || []), ...(dueB || [])].map(r => String(r.shop_id || '')).filter(x => x && shopPhone[x] === undefined))];
        for (let i = 0; i < need.length; i += 80) {
          const { data: shRows2 } = await supabase.from('shops').select('id,name,phone').in('id', need.slice(i, i + 80));
          (shRows2 || []).forEach(r => { shopName[String(r.id)] = r.name || ''; shopPhone[String(r.id)] = r.phone || ''; });
        }
      }
      const seenDue = {}, todayDueLines = [], prevDueLines = [];
      [...(dueA || []), ...(dueB || [])].forEach(r => {
        if (seenDue[String(r.id)]) return; seenDue[String(r.id)] = 1;
        const rem = num(r.amount) - num(r.paid_amount);
        if (rem <= 0.004) return;
        const dd = String(r.due_date || '').slice(0, 10);
        const line = { dsrId: String(r.dsr_id || ''), dsrName: nameById[String(r.dsr_id)] || '', date: dd, createdAt: r.created_at || '', shopId: r.shop_id || '', shopPhone: shopPhone[String(r.shop_id || '')] || '', shopName: r.shop_name || '', amount: _m2(rem), original: _m2(r.amount), paid: _m2(r.paid_amount), note: r.note || '' };
        if (dd >= from && dd <= to) todayDueLines.push(line); else if (dd < from) prevDueLines.push(line);
      });
      const sumL = (arr) => _m2(arr.reduce((a, r) => a + r.amount, 0));
      // v5.18 — the red top box: a day's unpaid credit only becomes "due" after that day is closed —
      // i.e. it is dated before today, or the owner/manager already registered that DSR's payment for it.
      const _settledDay = new Set((settled || []).map(r => String(r.dsr_id) + '|' + String(r.date || '').slice(0, 10)));
      const dueAllLines = [...prevDueLines, ...todayDueLines].filter(l => l.date < today || _settledDay.has(l.dsrId + '|' + l.date))
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      const _byTime = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
      todayDueLines.sort(_byTime); prevDueLines.sort(_byTime);

      // cash shops handed over AT the sale (same rule as _computeSettlement:
      // paid_amount also grows on later collections, so subtract every logged one)
      let cashAtSale = 0;
      const cashSales = [];
      if ((dueRows || []).length) {
        const ids = dueRows.map(r => String(r.id));
        const logged = await fetchAll(() => supabase.from('due_collections').select('due_id,amount').in('due_id', ids));
        const lm = {}; (logged || []).forEach(r => { lm[String(r.due_id)] = (lm[String(r.due_id)] || 0) + num(r.amount); });
        dueRows.forEach(r => {
          const initial = Math.max(0, num(r.paid_amount) - (lm[String(r.id)] || 0));
          if (initial > 0.004) { cashAtSale += initial; cashSales.push({ dsrName: nameById[String(r.dsr_id)] || '', date: String(r.due_date || '').slice(0, 10), createdAt: r.created_at || '', shopId: r.shop_id || '', shopPhone: shopPhone[String(r.shop_id || '')] || '', shopName: r.shop_name || '', amount: _m2(initial) }); }
        });
      }
      // v5.18 — DATE RULE (replaces the old 24-hour rule). Money taken on the SAME calendar day the
      // sale/due was made is CASH of that day's sale (it joins "আজকের বিক্রয়"). Money taken on any
      // LATER day is an OLD (previous) DUE collected. e.g. due made on the 11th: paid on the 11th = cash,
      // paid on the 12th or later = previous-due collection — whatever the hour. Total cash in hand is
      // unchanged — only which line it is listed under.
      const _bdtDay = (ts) => { const t = Date.parse(ts || ''); return isFinite(t) ? new Date(t + 6 * 3600 * 1000).toISOString().slice(0, 10) : ''; };
      const colDueIds = [...new Set((dueCols || []).map(r => String(r.due_id || '')).filter(Boolean))];
      const dueMadeOn = {};
      for (let i = 0; i < colDueIds.length; i += 80) {
        const { data: dcRows } = await supabase.from('due_calendar').select('id,created_at,due_date').in('id', colDueIds.slice(i, i + 80));
        (dcRows || []).forEach(r => { dueMadeOn[String(r.id)] = _bdtDay(r.created_at) || String(r.due_date || '').slice(0, 10); });
      }
      const colSameDay = (r) => { const made = dueMadeOn[String(r.due_id || '')]; const on = String(r.date || '').slice(0, 10) || _bdtDay(r.created_at); return !!made && !!on && on <= made; };
      const colsFast = (dueCols || []).filter(colSameDay), colsOld = (dueCols || []).filter(r => !colSameDay(r));
      colsFast.forEach(r => {
        cashAtSale += num(r.amount);
        cashSales.push({ dsrName: nameById[String(r.dsr_id)] || '', date: String(r.date || '').slice(0, 10), createdAt: r.created_at || '', shopId: r.shop_id || '', shopPhone: shopPhone[String(r.shop_id || '')] || '', shopName: r.shop_name || '', amount: _m2(r.amount) });
      });
      cashSales.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      const dueCollected = colsOld.reduce((a, r) => a + num(r.amount), 0);
      const damageMoney = (dmgCols || []).filter(r => r.resolution === 'money').reduce((a, r) => a + num(r.refund_amt), 0);
      const damageExchange = (dmgCols || []).filter(r => r.resolution === 'exchange').reduce((a, r) => a + Math.min(num(r.exch_value), num(r.damaged_value)), 0);

      // group stock movements (give / return / van damage) by their slip
      const groupTx = (type) => {
        const g = {};
        (txs || []).filter(r => r.type === type).forEach(r => {
          const k = String(r.tx_id || r.created_at);
          const o = g[k] = g[k] || { date: String(r.date || '').slice(0, 10), total: 0, items: [], createdAt: '', dsrName: nameById[String(r.sr_id)] || '', shopName: r.shop_id ? (shopName[String(r.shop_id)] || '') : '', shopPhone: r.shop_id ? (shopPhone[String(r.shop_id)] || '') : '' };
          o.total += num(r.total_revenue);
          // the slip's time = when the whole slip was saved (latest row of that tx_id)
          if (r.created_at && String(r.created_at) > o.createdAt) o.createdAt = String(r.created_at);
          o.items.push({ productName: r.product_name || '', cases: num(r.cases), pcs: num(r.pcs), units: num(r.total_units), value: _m2(r.total_revenue) });
        });
        return Object.values(g).map(o => ({ date: o.date, createdAt: o.createdAt, dsrName: o.dsrName, shopName: o.shopName, shopPhone: o.shopPhone, total: _m2(o.total), items: o.items }))
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      };
      const given = groupTx('give'), returned = groupTx('return'), vanDamage = groupTx('damage'), pointSlips = groupTx('point_sale'), pointRetSlips = groupTx('point_damage_return'), saleRetSlips = groupTx('dsr_sale_return');
      const sumV = (arr) => _m2(arr.reduce((a, g) => a + g.total, 0));

      // v5.17 — point-sale commission / discount are listed here too, tagged isPoint (shown as "পয়েন্ট সেল")
      const perSale = (field) => (txs || []).filter(r => (r.type === 'dsr_sale' || r.type === 'point_sale') && num(r[field]) > 0.004).map(r => ({
        isPoint: r.type === 'point_sale',
        date: String(r.date || '').slice(0, 10), createdAt: r.created_at, dsrName: nameById[String(r.sr_id)] || '', shopId: r.shop_id || '', shopPhone: shopPhone[String(r.shop_id || '')] || '',
        shopName: shopName[String(r.shop_id || '')] || '', productName: r.product_name || '',
        units: num(r.total_units), ...split(r.total_units, r.product_id, r.product_name), saleValue: _m2(r.total_revenue), amount: _m2(r[field])
      }));
      const commLines = perSale('commission_amt'), discLines = perSale('discount_amt');
      // v5.25 — company offer deduction (already inside the reduced bills; listed for the manager only)
      const offerLines = (txs || []).filter(r => (r.type === 'dsr_sale' || r.type === 'point_sale') && offerLib.dedOf(r) > 0.004).map(r => ({
        isPoint: r.type === 'point_sale', date: String(r.date || '').slice(0, 10), createdAt: r.created_at, dsrName: nameById[String(r.sr_id)] || '', shopId: r.shop_id || '',
        shopName: shopName[String(r.shop_id || '')] || '', productName: r.product_name || '', units: num(r.total_units), saleValue: _m2(r.total_revenue), amount: offerLib.dedOf(r)
      }));

      const damageTotal = _m2(sumV(vanDamage) + damageMoney + damageExchange);
      const cashInHand = _m2(cashAtSale + dueCollected - damageMoney);
      const handedOver = _m2((settled || []).reduce((a, r) => a + num(r.cash_received), 0));
      const receivedAll = _m2(Number(settledAll) || 0);

      const dsrName = isAll ? 'সব DSR একসাথে' : (nameById[sid] || '');

      return res.json({
        ok: true, dsrId: sid, dsrName, isAll, from, to,
        offer: { total: _m2(offerLines.reduce((a, x) => a + x.amount, 0)), lines: offerLines },
        received: { total: receivedAll, period: handedOver },
        txShops: Object.fromEntries(shopIds.map(id => [id, { name: shopName[id] || '', phone: shopPhone[id] || '' }])),
        given:  { total: sumV(given),    slips: given },
        ret:    { total: sumV(returned), slips: returned },
        // v5.13 — point sale booked on this DSR (sold by the manager / owner; the DSR collects the money from them)
        pointSale: { total: sumV(pointSlips), slips: pointSlips },
        pointReturn: { total: sumV(pointRetSlips), slips: pointRetSlips },
        // v5.17 — goods shops handed back to the DSR (বিক্রয় ফেরত): back on the van, shop due lowered
        saleReturn: { total: sumV(saleRetSlips), slips: saleRetSlips },
        // v5.17 — ONE sale figure everywhere: (give + point sale) − (return + point return). Same rule the SO / owner
        // totals use, so a DSR's panel and his SO's panel can never disagree.
        netSale: _m2(sumV(given) + sumV(pointSlips) - sumV(returned) - sumV(pointRetSlips)),
        // v5.13 — every unpaid due the DSR holds (this period + all earlier) — the red top box
        dueAll: { total: sumL(dueAllLines), lines: dueAllLines },
        damage: {
          total: damageTotal,
          vanDamage: { total: sumV(vanDamage), slips: vanDamage },
          shopDamage: (dmgCols || []).map(r => ({
            dsrName: nameById[String(r.dsr_id)] || '', date: String(r.date || '').slice(0, 10), createdAt: r.created_at, shopId: r.shop_id || '', shopPhone: shopPhone[String(r.shop_id || '')] || '',
            shopName: r.shop_name || '', productName: r.product_name || '', units: num(r.units), ...split(r.units, r.product_id, r.product_name),
            damagedValue: _m2(r.damaged_value), resolution: r.resolution,
            refundAmt: _m2(r.refund_amt), exchProductName: r.exch_product_name || '', exchUnits: num(r.exch_units), exch: split(r.exch_units, r.exch_product_id, r.exch_product_name),
            exchValue: _m2(Math.min(num(r.exch_value), num(r.damaged_value)))
          })),
          moneyRefunded: _m2(damageMoney), exchanged: _m2(damageExchange)
        },
        commission: { total: _m2(commLines.reduce((a, r) => a + r.amount, 0)), lines: commLines },
        discount:   { total: _m2(discLines.reduce((a, r) => a + r.amount, 0)), lines: discLines },
        todayDue:   { total: sumL(todayDueLines), lines: todayDueLines },
        prevDue:    { total: sumL(prevDueLines),  lines: prevDueLines },
        cash: {
          cashAtSale: _m2(cashAtSale), dueCollected: _m2(dueCollected), damageMoneyPaid: _m2(damageMoney),
          inHand: cashInHand, handedOver, stillToHandOver: _m2(cashInHand - handedOver),
          saleLines: cashSales,
          dueLines: colsOld.map(r => ({ dsrName: nameById[String(r.dsr_id)] || '', date: String(r.date || '').slice(0, 10), createdAt: r.created_at || '', shopId: r.shop_id || '', shopPhone: shopPhone[String(r.shop_id || '')] || '', shopName: r.shop_name || '', amount: _m2(r.amount) })),
          damageLines: (dmgCols || []).filter(r => r.resolution === 'money' && num(r.refund_amt) > 0)
            .map(r => ({ dsrName: nameById[String(r.dsr_id)] || '', date: String(r.date || '').slice(0, 10), createdAt: r.created_at || '', shopId: r.shop_id || '', shopPhone: shopPhone[String(r.shop_id || '')] || '', shopName: r.shop_name || '', productName: r.product_name || '', amount: _m2(r.refund_amt) }))
        }
      });
    }

    // ══════════════════════════════════════════════════
    //  Updates #32 & #33 — per-product VAN STOCK, day-scoped only
    //
    //  Bug fixed (#32, "Empty Van"): the DSR's sell-to-shop screen used
    //  to filter/display against S.stockMap — the MAIN WAREHOUSE stock
    //  (api/dashboard.js's products.current_stock), not what this DSR
    //  actually has loaded on his van. Since warehouse stock is almost
    //  always > 0, the DSR effectively saw the entire product catalog as
    //  "available to sell", including products he never physically
    //  received that day.
    //
    //  Fix (#33, day-scoped, no carry-over): this endpoint computes,
    //  per product, exactly what's left in THIS dsrId's van for THIS
    //  one date (defaults to today) — nothing from any other day is
    //  ever read, so nothing can carry over:
    //    vanStock[productId] = given(date) − returned(date)
    //                                       − sold-to-shops(date)
    //                                       − damage ALREADY reconciled
    //                                         by the Owner (date)
    //  Damage reported today but still 'pending' (not yet reconciled by
    //  the Owner in the Damage Report) is deliberately NOT subtracted —
    //  those units haven't physically left the DSR's hand yet, so they
    //  still count as "in hand" per Update #33, giving an accurate
    //  running picture of what the DSR currently carries. Once the
    //  Owner clears that claim, it's removed here too.
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'van-stock') {
      const { dsrId, date } = req.query;
      if (!dsrId) return res.json({ ok: false, error: 'dsrId প্রয়োজন' });
      const d = (date && DATE_RE.test(date)) ? date : bdtToday();
      // v4.8.0 — shared helper (api/_lib/db.js computeVanStock): the very
      // same numbers the server uses to REJECT an over-sale in
      // shops.js visit-sale, so the screen and the check can never disagree.
      const stock = await computeVanStock(dsrId, d, { damage: 'cleared' });
      return res.json({ ok: true, dsrId: String(dsrId), date: d, vanStock: stock });
    }

    // ══════════════════════════════════════════════════
    //  v4.8.0 — DSR DUE COLLECTION (বাকি আদায়)
    //  due-shops    GET  dsrId            → every shop with an unpaid due
    //  due-collect  POST shopId, amount   → oldest due first, logged
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'due-shops') {
      const { dsrId } = req.query;
      // v5.21 — scope=all (owner / manager / SO): every shop that owes, not just one DSR's
      const allScope = String(req.query.scope || '') === 'all';
      if (!dsrId && !allScope) return res.json({ ok: false, error: 'dsrId প্রয়োজন' });
      if (allScope) {
        const rowsAll = await fetchAll(() => supabase.from('due_calendar').select('id,dsr_id,dsr_name,client_type,shop_id,shop_name,due_date,amount,paid_amount,note,status,cleared_date,created_at,tx_id').eq('client_type', 'shop').in('status', ['pending', 'partial']));
        return res.json(await _dueShopsPayload(rowsAll));
      }
      const { data: mine, error: mErr } = await supabase.from('shops').select('id').eq('assigned_dsr_id', String(dsrId));
      if (mErr) throw mErr;
      const myShopIds = (mine || []).map(x => String(x.id));
      const [a, b] = await Promise.all([
        supabase.from('due_calendar').select('id,dsr_id,dsr_name,client_type,shop_id,shop_name,due_date,amount,paid_amount,note,status,cleared_date,created_at,tx_id').eq('client_type', 'shop').eq('dsr_id', String(dsrId)).in('status', ['pending', 'partial']),
        myShopIds.length
          ? supabase.from('due_calendar').select('id,dsr_id,dsr_name,client_type,shop_id,shop_name,due_date,amount,paid_amount,note,status,cleared_date,created_at,tx_id').eq('client_type', 'shop').in('shop_id', myShopIds).in('status', ['pending', 'partial'])
          : Promise.resolve({ data: [] })
      ]);
      if (a.error) throw a.error; if (b.error) throw b.error;
      const seen = {}; const rows = [];
      [...(a.data || []), ...(b.data || [])].forEach(r => { if (!seen[r.id]) { seen[r.id] = 1; rows.push(r); } });
      return res.json(await _dueShopsPayload(rows));
    }

    if (req.method === 'POST' && action === 'due-collect') {
      const d = req.body || {};
      const amount = num(d.amount);
      if (!d.shopId || !(d.actorId || d.dsrId)) return res.json({ ok: false, error: 'shopId ও আদায়কারী প্রয়োজন' });
      if (amount <= 0) return res.json({ ok: false, error: 'পরিমাণ ০-এর বেশি হতে হবে' });
      // v5.6 — every collection (full OR partial) needs the DSR's own password.
      // Checked here on the server so it cannot be skipped from the browser.
      {
        const pin = String(d.pin == null ? '' : d.pin).trim();
        if (!pin) return res.json({ ok: false, error: 'আপনার পাসওয়ার্ড দিন', needPin: true });
        const { data: pw, error: pwErr } = await supabase.from('user_passwords').select('user_key,role')
          .eq('user_key', String(d.actorId || d.dsrId)).eq('password', pin).limit(1);   // v5.16: an SO collecting on a DSR's van confirms with his OWN password
        if (pwErr) throw pwErr;
        if (!pw || !pw.length) return res.json({ ok: false, error: 'পাসওয়ার্ড ভুল — আদায় হয়নি', badPin: true });
        d._actorRole = String(pw[0].role || '');
      }
      const { data: dues, error: dErr } = await supabase.from('due_calendar').select('id,dsr_id,dsr_name,client_type,shop_id,shop_name,due_date,amount,paid_amount,note,status,cleared_date,created_at,tx_id')
        .eq('client_type', 'shop').eq('shop_id', String(d.shopId)).in('status', ['pending', 'partial'])
        .order('due_date').order('created_at');
      if (dErr) throw dErr;
      const owed = (dues || []).reduce((t, r) => t + Math.max(0, num(r.amount) - num(r.paid_amount)), 0);
      if (owed <= 0) return res.json({ ok: false, error: 'এই দোকানের কোনো বাকি নেই' });
      if (amount > owed + 0.0001) return res.json({ ok: false, error: 'বাকি আছে মাত্র ৳' + owed.toFixed(2) + ' — এর বেশি নেওয়া যাবে না' });
      let left = amount, collected = 0;
      // v5.21 — ANY role can collect. The credit always goes to the shop's own (registered) DSR automatically;
      // the cash is on the person who really took it: a DSR / SO → his own day-end cash, owner / manager → none.
      const actorId = String(d.actorId || d.dsrId);
      const actorRole = d._actorRole || (d.actorId ? '' : 'dsr');
      let actorName = String(d.actorName || d.dsrName || '');
      const { data: shRow } = await supabase.from('shops').select('assigned_dsr_id,assigned_dsr_name').eq('id', String(d.shopId)).maybeSingle();
      const creditId = String((shRow && shRow.assigned_dsr_id) || (actorRole === 'dsr' ? actorId : '') || '');
      const creditName = String((shRow && shRow.assigned_dsr_name) || (creditId === actorId ? actorName : '') || '');
      const holdsCash = actorRole === 'dsr' || actorRole === 'so';
      const meta = { dsrId: holdsCash ? actorId : '', dsrName: holdsCash ? actorName : '', noCashHolder: !holdsCash, date: bdtToday(),
        creditId, creditName, collectorId: actorId, collectorName: actorName, collectorRole: actorRole };
      for (const r of dues) {
        if (left <= 0.0001) break;
        const rem = Math.max(0, num(r.amount) - num(r.paid_amount));
        const r1 = await applyDuePayment(r.id, Math.min(left, rem), meta);
        if (r1.conflict) return res.json({ ok: false, error: 'অন্য একটি আপডেট চলছিল — আবার চেষ্টা করুন' });
        collected += r1.applied; left -= r1.applied;
      }
      return res.json({ ok: true, collected, remaining: Math.max(0, owed - collected) });
    }

    // ══════════════════════════════════════════════════
    //  v4.8.0 — DSR DAMAGE COLLECTION (ড্যামেজ কালেকশন)
    //  A shop hands back damaged goods; the DSR either pays the shop
    //  cash ('money') or swaps it for any product on his van ('exchange').
    //  Damaged goods never re-enter warehouse stock. Every line also
    //  opens a pending dmg_claims row (tx_id 'dc:<id>') so the Owner's
    //  Damage Report keeps counting the company's purchase-price loss.
    // ══════════════════════════════════════════════════
    if (req.method === 'POST' && action === 'damage-collect') {
      const d = req.body || {};
      const lines = Array.isArray(d.lines) ? d.lines : [];
      if (!d.dsrId || !d.shopId) return res.json({ ok: false, error: 'dsrId ও shopId প্রয়োজন' });
      if (!lines.length) return res.json({ ok: false, error: 'কমপক্ষে একটি ড্যামেজ পণ্য দিন' });
      if (lines.length > 60) return res.json({ ok: false, error: 'একসাথে সর্বোচ্চ ৬০টি লাইন' });
      const date = (d.date && DATE_RE.test(d.date)) ? d.date : bdtToday();

      const { data: shop, error: shErr } = await supabase.from('shops').select('id,name').eq('id', String(d.shopId)).maybeSingle();
      if (shErr) throw shErr;
      if (!shop) return res.json({ ok: false, error: 'দোকান পাওয়া যায়নি' });

      const pids = new Set();
      lines.forEach(l => { if (l.productId) pids.add(String(l.productId)); if (l.exchProductId) pids.add(String(l.exchProductId)); });
      const { data: prods, error: pErr } = await supabase.from('products').select('id,name,sku,selling_price,purchase_price').in('id', [...pids]);
      if (pErr) throw pErr;
      const pm = {}; (prods || []).forEach(x => { pm[String(x.id)] = x; });
      // v5.24 — a damage taken back from a shop is valued at what THAT shop was charged (its latest sale snapshot),
      // not at today's catalogue price. No earlier sale found → current price (new line).
      const _saleSnap = await require('./_lib/snapshot').latestSaleSnapshots({ shopId: String(shop.id) }, ['dsr_sale', 'point_sale'], [...pids], date);
      Object.keys(_saleSnap).forEach(k => { if (pm[k]) { pm[k] = Object.assign({}, pm[k], { selling_price: _saleSnap[k].sp, purchase_price: _saleSnap[k].pp > 0 ? _saleSnap[k].pp : pm[k].purchase_price }); } });

      const van = await computeVanStock(d.dsrId, date, { damage: 'cleared' });
      const needVan = {};
      const colId = randomUUID();
      const ts = now_();
      const colRows = [], claimRows = [];
      for (const l of lines) {
        const p = pm[String(l.productId || '')];
        const units = num(l.units);
        if (!p) return res.json({ ok: false, error: 'পণ্য পাওয়া যায়নি' });
        if (units <= 0) return res.json({ ok: false, error: (p.name || 'পণ্য') + ' — ড্যামেজের পরিমাণ দিন' });
        if (l.resolution !== 'money' && l.resolution !== 'exchange') return res.json({ ok: false, error: (p.name || 'পণ্য') + ' — টাকা ফেরত নাকি বদল, বেছে নিন' });
        const sp = num(p.selling_price), pp = num(p.purchase_price);
        const damagedValue = +(units * sp).toFixed(4);
        const row = {
          col_id: colId, dsr_id: String(d.dsrId), dsr_name: d.dsrName || '',
          shop_id: String(shop.id), shop_name: shop.name || '', date,
          product_id: String(p.id), product_name: p.name || '', sku: p.sku || '',
          units, selling_price: sp, purchase_price: pp, damaged_value: damagedValue,
          resolution: l.resolution, refund_amt: 0, exch_product_id: '', exch_product_name: '', exch_units: 0, exch_value: 0,
          note: String(d.note || '').slice(0, 200), created_at: ts
        };
        if (l.resolution === 'money') {
          const refund = l.refundAmt === undefined || l.refundAmt === '' ? damagedValue : num(l.refundAmt);
          if (refund < 0) return res.json({ ok: false, error: 'টাকার পরিমাণ ঋণাত্মক হতে পারে না' });
          if (refund > damagedValue + 0.0001) return res.json({ ok: false, error: (p.name || 'পণ্য') + ' — ফেরত টাকা (৳' + refund.toFixed(2) + ') ড্যামেজ মূল্যের (৳' + damagedValue.toFixed(2) + ') বেশি হতে পারে না' });
          row.refund_amt = +refund.toFixed(4);
        } else {
          const ep = pm[String(l.exchProductId || '')];
          const eu = num(l.exchUnits);
          if (!ep) return res.json({ ok: false, error: (p.name || 'পণ্য') + ' — বদলে কোন পণ্য দিচ্ছেন তা বাছুন' });
          if (eu <= 0) return res.json({ ok: false, error: (ep.name || 'পণ্য') + ' — বদলের পরিমাণ দিন' });
          needVan[String(ep.id)] = (needVan[String(ep.id)] || 0) + eu;
          row.exch_product_id = String(ep.id); row.exch_product_name = ep.name || '';
          row.exch_units = eu; row.exch_value = +(eu * num(ep.selling_price)).toFixed(4);
        }
        colRows.push(row);
        claimRows.push({
          tx_id: 'dc:' + colId, product_id: String(p.id), product_name: p.name || '', sku: p.sku || '',
          total_units: units, purchase_price: pp, total_cost: +(units * pp).toFixed(4),
          date, sr_id: String(d.dsrId), sr_name: d.dsrName || '', status: 'pending', cleared_date: null, created_at: ts
        });
      }
      for (const pid of Object.keys(needVan)) {
        const have = num(van[pid]);
        if (needVan[pid] > have + 0.0001) {
          const nm = (pm[pid] && pm[pid].name) || 'পণ্য';
          return res.json({ ok: false, error: nm + ' — গাড়িতে আছে মাত্র ' + have + ' পিস, বদলে দিতে চাইছেন ' + needVan[pid] + ' পিস' });
        }
      }
      const { error: iErr } = await supabase.from('damage_collections').insert(colRows);
      if (iErr) throw iErr;
      const { error: cErr } = await supabase.from('dmg_claims').insert(claimRows);
      if (cErr) {
        await supabase.from('damage_collections').delete().eq('col_id', colId);
        throw cErr;
      }
      const refundTotal = colRows.reduce((t, r) => t + num(r.refund_amt), 0);
      const exchTotal = colRows.reduce((t, r) => t + num(r.exch_value), 0);
      return res.json({ ok: true, colId, refundTotal, exchTotal, lines: colRows.length });
    }

    // v5.11 — MANAGER CASH: how much cash each manager has taken from the DSRs (all DSRs together).
    // This is the amount the Owner will receive from that manager. Confirmed = settlements the
    // Owner already approved; pending = settlements the manager submitted that still wait for approval.
    //   GET /api/sr-payments?action=manager-cash[&from=YYYY-MM-DD&to=YYYY-MM-DD]   (no dates = all time)
    if (req.method === 'GET' && action === 'manager-cash') {
      const f = DATE_RE.test(req.query.from || '') ? req.query.from : '';
      const t = DATE_RE.test(req.query.to || '') ? req.query.to : '';
      const [stl, pend, mgrs] = await Promise.all([
        fetchAll(() => { let q = supabase.from('dsr_settlements').select('dsr_id,dsr_name,date,cash_received,received_by_id,received_by_name,received_by_role,created_at').eq('received_by_role', 'manager').order('date', { ascending: false }); if (f) q = q.gte('date', f); if (t) q = q.lte('date', t); return q; }),
        Promise.resolve([]),   // v5.18 — no approval queue any more
        fetchAll(() => supabase.from('user_passwords').select('user_key,user_name').eq('role', 'manager'))
      ]);
      const by = {};
      const slot = (id, name) => (by[id] = by[id] || { managerId: id, managerName: name || '', confirmed: 0, pending: 0, dsrs: {}, lines: [] });
      (mgrs || []).forEach(m => slot(String(m.user_key), m.user_name));
      (stl || []).forEach(r => {
        const x = slot(String(r.received_by_id || r.received_by_name || '—'), r.received_by_name);
        const amt = _m2(r.cash_received);
        x.confirmed += amt;
        x.dsrs[r.dsr_name || r.dsr_id] = (x.dsrs[r.dsr_name || r.dsr_id] || 0) + amt;
        x.lines.push({ date: String(r.date).slice(0, 10), dsrName: r.dsr_name || '', amount: amt, createdAt: r.created_at || '' });
      });
      (pend || []).forEach(r => {
        const d = r.input_data || {}; const dt = DATE_RE.test(d.date || '') ? d.date : String(r.submitted_at || '').slice(0, 10);
        if ((f && dt < f) || (t && dt > t)) return;
        const x = slot(String(r.manager_id), r.manager_name); x.pending += _m2(d.cashReceived);
      });
      const list = Object.values(by).map(x => ({
        managerId: x.managerId, managerName: x.managerName, confirmed: _m2(x.confirmed), pending: _m2(x.pending), total: _m2(x.confirmed + x.pending),
        byDsr: Object.keys(x.dsrs).map(n => ({ dsrName: n, amount: _m2(x.dsrs[n]) })).sort((a, b) => b.amount - a.amount),
        lines: x.lines.slice(0, 200)
      })).sort((a, b) => b.total - a.total);
      return res.json({ ok: true, from: f, to: t, managers: list, grandConfirmed: _m2(list.reduce((a, m) => a + m.confirmed, 0)), grandPending: _m2(list.reduce((a, m) => a + m.pending, 0)), grandTotal: _m2(list.reduce((a, m) => a + m.total, 0)) });
    }

    // Owner / Manager view (and the DSR's own list): what DSRs collected.
    if (req.method === 'GET' && action === 'collections-list') {
      const { dsrId, from, to } = req.query;
      const f = DATE_RE.test(from || '') ? from : bdtToday();
      const t = DATE_RE.test(to || '') ? to : f;
      const [dc, gc] = await Promise.all([
        fetchAll(() => supabase.from('due_collections').select('*').gte('date', f).lte('date', t).order('created_at', { ascending: false })).then(rs => (dsrId ? (rs || []).filter(r => String(r.dsr_id || '') === String(dsrId) || String(r.credit_dsr_id || '') === String(dsrId)) : rs)),   // v5.21 — a DSR also sees what others collected from HIS shops
        fetchAll(() => { let q = supabase.from('damage_collections').select('*').gte('date', f).lte('date', t).order('created_at', { ascending: false }); if (dsrId) q = q.eq('dsr_id', String(dsrId)); return q; })
      ]);
      const shopIds = [...new Set([...(dc || []), ...(gc || [])].map(r => String(r.shop_id || '')).filter(Boolean))];
      const shopMap = {};
      // chunked: a long date range can touch hundreds of shops, and one
      // giant .in() list overflows the request URL.
      for (let i = 0; i < shopIds.length; i += 80) {
        const { data: sh } = await supabase.from('shops').select('id,shop_no,keeper_name,phone,address,road_name').in('id', shopIds.slice(i, i + 80));
        (sh || []).forEach(x => { shopMap[String(x.id)] = x; });
      }
      const shopInfo = id => { const x = shopMap[String(id || '')] || {}; return { shopNo: x.shop_no || '', keeperName: x.keeper_name || '', phone: x.phone || '', address: x.address || '', roadName: x.road_name || '' }; };
      const dues = (dc || []).map(r => ({ id: String(r.id), date: String(r.date).slice(0, 10), dsrId: r.credit_dsr_id || r.dsr_id, dsrName: r.credit_dsr_name || r.dsr_name || '', collectorId: r.collector_id || r.dsr_id || '', collectorName: r.collector_name || r.dsr_name || '', collectorRole: r.collector_role || '', shopId: r.shop_id || '', shopName: r.shop_name || '', amount: num(r.amount), createdAt: r.created_at, ...shopInfo(r.shop_id) }));
      const damages = (gc || []).map(r => ({
        id: String(r.id), colId: r.col_id, date: String(r.date).slice(0, 10), dsrId: r.dsr_id, dsrName: r.dsr_name || '',
        shopId: r.shop_id || '', shopName: r.shop_name || '', productName: r.product_name || '', units: num(r.units),
        damagedValue: num(r.damaged_value), resolution: r.resolution, refundAmt: num(r.refund_amt),
        exchProductName: r.exch_product_name || '', exchUnits: num(r.exch_units), exchValue: num(r.exch_value),
        createdAt: r.created_at, ...shopInfo(r.shop_id)
      }));
      const byDsr = {};
      const slot = (id, name) => (byDsr[id] = byDsr[id] || { dsrId: id, dsrName: name || '', dueCollected: 0, damageValue: 0, refundPaid: 0, exchangeValue: 0 });
      dues.forEach(r => { const x = slot(r.dsrId, r.dsrName); x.dueCollected += r.amount; (x._shops = x._shops || new Set()).add(r.shopId || r.shopName); });
      Object.values(byDsr).forEach(x => { x.shopCount = x._shops ? x._shops.size : 0; delete x._shops; });
      damages.forEach(r => { const x = slot(r.dsrId, r.dsrName); x.damageValue += r.damagedValue; x.refundPaid += r.refundAmt; x.exchangeValue += r.exchValue; });
      return res.json({
        ok: true, from: f, to: t, dues, damages, byDsr: Object.values(byDsr),
        totals: {
          dueCollected: dues.reduce((a, r) => a + r.amount, 0), dueShopCount: new Set(dues.map(r => r.shopId || r.shopName)).size, dueCount: dues.length, damageValue: damages.reduce((a, r) => a + r.damagedValue, 0),
          refundPaid: damages.reduce((a, r) => a + r.refundAmt, 0), exchangeValue: damages.reduce((a, r) => a + r.exchValue, 0)
        }
      });
    }

    // ══════════════════════════════════════════════════
    //  v4.8.0 — END-OF-DAY SETTLEMENT (হিসাব / পেমেন্ট)
    //  settle-preview GET  dsrId, date  → everything still to be settled
    //  settle-confirm POST              → applies it ONCE (see below)
    // ══════════════════════════════════════════════════
    // ══════════════════════════════════════════════════
    //  v5.12 — DAY-CLOSE STATUS + per-SO sale of the day
    //  GET /api/sr-payments?action=day-status[&date=YYYY-MM-DD][&soId=<id>]
    //  A DSR's day is CLOSED when nothing is left to settle for that date: no stock
    //  still on the van (not yet returned), no pending commission / discount / damage
    //  and no cash still expected. Any new loading / sale / collection after the
    //  manager's settlement re-opens the day. A SO's day is closed when ALL his
    //  DSRs are closed. Returns every SO (or just ?soId=) with his net sale of the day.
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'day-status') {
      const realToday = bdtToday();
      const dq = String((req.query && req.query.date) || '');
      const date = (DATE_RE.test(dq) && dq <= realToday) ? dq : realToday;
      const onlySo = String((req.query && req.query.soId) || '');
      const staff = await fetchAll(() => supabase.from('srs').select('id,name,role,so_id'));
      let sos = staff.filter(x => x.role === 'so');
      if (onlySo) sos = sos.filter(x => String(x.id) === onlySo);
      const soIds = new Set(sos.map(x => String(x.id)));
      const dsrs = staff.filter(x => x.role !== 'so' && soIds.has(String(x.so_id || '')));
      const unassigned = onlySo ? [] : staff.filter(x => x.role === 'dsr' && !soIds.has(String(x.so_id || '')));
      const allDsr = dsrs.concat(unassigned);

      // net sale of the day per SO (DSR give − return, + the SO's own point sale) — revenue in ৳
      const ids = sos.map(x => String(x.id)).concat(allDsr.map(x => String(x.id)));
      const saleBySo = {};
      sos.forEach(x => { saleBySo[String(x.id)] = 0; });
      const dsrToSo = {}; dsrs.forEach(x => { dsrToSo[String(x.id)] = String(x.so_id); });
      if (ids.length) {
        const rows = await fetchAll(() => supabase.from('transactions').select('sr_id,type,total_revenue')
          .eq('date', date).in('type', ['give', 'return', 'point_sale', 'point_damage_return']).in('sr_id', ids));
        rows.forEach(r => {
          const sid = String(r.sr_id);
          const plus = (r.type === 'give' || r.type === 'point_sale');
          let owner = null;
          if ((r.type === 'give' || r.type === 'return') && dsrToSo[sid]) owner = dsrToSo[sid];
          else if ((r.type === 'point_sale' || r.type === 'point_damage_return') && soIds.has(sid)) owner = sid;
          else if ((r.type === 'point_sale' || r.type === 'point_damage_return') && dsrToSo[sid]) owner = dsrToSo[sid];   // v5.13: point sale is booked on a DSR
          if (owner === null) return;
          saleBySo[owner] += (plus ? 1 : -1) * num(r.total_revenue);
        });
      }

      // settlement status per DSR — small batches so a big team never floods the database
      const status = {};
      for (let i = 0; i < allDsr.length; i += 6) {
        await Promise.all(allDsr.slice(i, i + 6).map(async (x) => {
          try {
            const c = await _computeSettlement(String(x.id), date, { light: true });
            const why = [];
            if (c.returnItems.length) why.push('ভ্যানে মাল আছে');
            if (c.pending.cashExpected > 0.005) why.push('নগদ বাকি');
            if (c.pending.commission > 0 || c.pending.discount > 0) why.push('কমিশন/ছাড় বাকি');
            if (c.pending.damage > 0) why.push('ড্যামেজ বাকি');
            if (!why.length && c.hasPending) why.push('হিসাব বাকি');
            status[String(x.id)] = { id: String(x.id), name: x.name || '', closed: !c.hasPending, why };
          } catch (e) {
            status[String(x.id)] = { id: String(x.id), name: x.name || '', closed: false, why: ['যাচাই করা যায়নি'] };
          }
        }));
      }

      const out = sos.map(so => {
        const mine = dsrs.filter(x => String(x.so_id) === String(so.id)).map(x => status[String(x.id)]);
        return {
          soId: String(so.id), soName: so.name || '',
          sale: +num(saleBySo[String(so.id)]).toFixed(2),
          dsrCount: mine.length, closedCount: mine.filter(m => m.closed).length,
          closed: mine.every(m => m.closed),
          open: mine.filter(m => !m.closed).map(m => ({ id: m.id, name: m.name, why: m.why }))
        };
      });
      const openAll = out.flatMap(o => o.open).concat(unassigned.map(x => status[String(x.id)]).filter(m => m && !m.closed));
      const totalDsr = allDsr.length;
      return res.json({
        ok: true, date, isToday: date === realToday, sos: out,
        all: { dsrCount: totalDsr, closedCount: totalDsr - openAll.length, closed: openAll.length === 0, open: openAll, sale: +out.reduce((a, o) => a + o.sale, 0).toFixed(2) }
      });
    }

    if (req.method === 'GET' && action === 'settle-preview') {
      const { dsrId, date } = req.query;
      if (!dsrId) return res.json({ ok: false, error: 'dsrId প্রয়োজন' });
      const d = (date && DATE_RE.test(date)) ? date : bdtToday();
      const c = await _computeSettlement(String(dsrId), d);
      return res.json({ ok: true, ...c });
    }

    if (req.method === 'POST' && action === 'settle-confirm') {
      { const a = await _verifyActor((req.body || {}).actorId, (req.body || {}).pin); if (!a.ok) return res.json(a); }
      let _role = 'owner';
      try { const { data: u } = await supabase.from('user_passwords').select('role').eq('user_key', String((req.body || {}).actorId)).maybeSingle(); if (u && u.role) _role = u.role; } catch (_) { }
      const r = await _performSettlement(Object.assign({}, req.body || {}, { byRole: _role }), (req.body && req.body.byName) || '');
      return res.json(r);
    }

    // ══════════════════════════════════════════════════
    //  EXISTING PAYMENT LOGIC (unchanged)
    // ══════════════════════════════════════════════════

    if (req.method === 'GET') {
      const { srId, from, to } = req.query;
      const pg = pageParams(req.query, 50);
      if (pg) {
        let q = supabase.from('sr_payments').select(PAY_COLS, { count: 'exact' }).order('created_at', { ascending: false }).order('id');
        if (srId) q = q.eq('sr_id', srId);
        if (from) q = q.gte('date', from);
        if (to)   q = q.lte('date', to);
        const { data, error, count } = await q.range(pg.from, pg.to);
        if (error) throw error;
        return res.json({ ok: true, rows: (data || []).map(mapPayment), page: pg.page, pageSize: pg.pageSize, total: count || 0, hasMore: pg.to + 1 < (count || 0) });
      }
      const data = await fetchAll(() => {
        let q = supabase.from('sr_payments').select(PAY_COLS).order('created_at');
        if (srId) q = q.eq('sr_id', srId);
        if (from) q = q.gte('date', from);
        if (to)   q = q.lte('date', to);
        return q;
      });
      return res.json((data || []).map(mapPayment));
    }

    if (req.method === 'POST') {
      const d = req.body || {};
      const cashAmt   = _m2(d.cashAmount);
      const commAmt   = _m2(d.commissionAmt);
      const discAmt   = _m2(d.discountAmt);
      const dmgAmt    = _m2(d.damageAmt);
      if (cashAmt < 0 || commAmt < 0 || discAmt < 0 || dmgAmt < 0) return res.json({ ok: false, error: 'পরিমাণ ঋণাত্মক হতে পারবে না' });
      const total = _m2(cashAmt + commAmt + discAmt + dmgAmt || num(d.amount));
      if (total <= 0) return res.json({ ok: false, error: 'পরিমাণ ০-এর বেশি হতে হবে' });
      if (!d.srId) return res.json({ ok: false, error: 'srId প্রয়োজন' });
      { const a = await _verifyActor(d.actorId, d.pin); if (!a.ok) return res.json(a); }
      { const g = await _paymentGuard(d.srId, total, d.date); if (g) return res.json({ ok: false, error: g }); }
      const { error } = await supabase.from('sr_payments').insert({
        sr_id:          d.srId    || '',
        sr_name:        d.srName  || '',
        date:           (d.date && DATE_RE.test(d.date)) ? d.date : bdtToday(),
        amount:         total,
        cash_amount:    cashAmt,
        commission_amt: commAmt,
        discount_amt:   discAmt,
        damage_amt:     dmgAmt,
        note:           d.note    || '',
        created_at:     now_()
      });
      if (error) throw error;
      return res.json({ ok: true });
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
}

// ── v60 — write the `give` rows for an order and mark it loaded ─────
// Claims the order first with a conditional UPDATE so a double-tap or two
// devices can never deduct stock twice; releases the claim if the insert fails.
async function _loadAndDeduct(id, allowedLoadStatuses) {
  const { data: row, error: fetchErr } = await supabase.from('orders').select('*').eq('id', id).single();
  if (fetchErr) throw fetchErr;
  if (!row || row.status !== 'approved') return { ok: false, error: 'অর্ডার পাওয়া যায়নি' };
  if (row.load_status === 'loaded') return { ok: false, error: 'এই লোড ইতিমধ্যে সম্পন্ন হয়ে গেছে' };
  if (!allowedLoadStatuses.includes(row.load_status)) return { ok: false, error: 'এই লোড এখন সম্পন্ন করা যাবে না' };
  const rawItems = (row.items || []).filter(it => num(it.totalUnits) > 0 || num(it.cases) > 0 || num(it.pcs) > 0);
  if (!rawItems.length) return { ok: false, error: 'অর্ডারে কোনো পণ্য নেই' };

  // CALC-5 — the DSR is charged the products table's price at the moment the
  // stock leaves the warehouse (numbers stored in the order are not trusted).
  const loadDate = bdtToday();                       // CALC-4: Asia/Dhaka calendar day
  const priced = await priceItems(rawItems, { type: 'give', srId: row.assigned_dsr_id, date: loadDate });
  if (!priced.ok) return { ok: false, error: priced.error };
  // CALC-9 — refuse BEFORE claiming the order, with a readable message.
  if (await blockNegativeStock()) {
    const short = stockShortage(priced.lines);
    if (short) return { ok: false, error: short };
  }

  const prevStatus = row.load_status;
  const loadedAt = now_();
  const { data: claimed, error: claimErr } = await supabase.from('orders')
    .update({ load_status: 'loaded', loaded_at: loadedAt })
    .eq('id', id).eq('status', 'approved').eq('load_status', prevStatus).select('id');
  if (claimErr) throw claimErr;
  if (!claimed || !claimed.length) return { ok: false, error: 'এই লোড ইতিমধ্যে সম্পন্ন হয়েছে' };

  let dsrName = '';
  try {
    const { data: sr } = await supabase.from('srs').select('name').eq('id', row.assigned_dsr_id).maybeSingle();
    dsrName = (sr && sr.name) || '';
  } catch (_) {}

  const txId = randomUUID();
  const date = loadDate;
  const rows = priced.lines.map(l => txRow(l, {
    tx_id: txId, type: 'give', sr_id: row.assigned_dsr_id, sr_name: dsrName,
    date, slip_no: '',
    note: 'ভ্যান-লোড অর্ডার #' + String(row.id).slice(0, 8), created_at: loadedAt
  }));
  const { error: txErr } = await supabase.from('transactions').insert(rows);
  if (txErr) {
    await supabase.from('orders').update({ load_status: prevStatus, loaded_at: null }).eq('id', id);
    throw txErr;
  }
  return { ok: true, txId };
}

// ══════════════════════════════════════════════════════════════════════
//  v4.8.0 — END-OF-DAY SETTLEMENT ENGINE
//
//  Everything the DSR's day produced is calculated FROM THE DATABASE, so
//  nobody has to type damage / return / commission numbers any more:
//
//    cash expected = cash shops paid at the counter (P)
//                  + old dues he collected today (Q)
//                  − cash he paid shops for damaged goods (M)
//    due reduction = cash received + commission + discount + damage
//                    + value of unsold stock returned to the warehouse
//
//  DELTA-BASED, so pressing twice can never double-count: each confirmed
//  settlement stores what it consumed (dsr_settlements); the next preview
//  only shows what is NOT yet settled for that date. Unsold van stock is
//  read live from the van, so once returned it is simply gone.
//  Whatever cash is short simply stays in the DSR's due (due = given −
//  returned − payments) and can be collected later.
// ══════════════════════════════════════════════════════════════════════
const _r2 = n => Math.round((num(n) + Number.EPSILON) * 100) / 100;

async function _computeSettlement(dsrId, date, opts) {
  const light = !!(opts && opts.light);   // v5.12 — status checks skip price lookups (only 'is anything left?' matters)
  const _oc = await offerLib.selCols();
  const [dayTx0, dueRows, dueColsToday, dmgCols, settled, vanDetail, dsrRow, dueTotals] = await Promise.all([
    fetchAll(() => supabase.from('transactions').select('tx_id,type,product_id,total_units,total_revenue,commission_amt,discount_amt' + _oc)
      .eq('sr_id', dsrId).eq('date', date).in('type', ['give', 'return', 'damage', 'dsr_sale'])),
    fetchAll(() => supabase.from('due_calendar').select('id,amount,paid_amount').eq('client_type', 'shop').eq('dsr_id', dsrId).eq('due_date', date)),
    fetchAll(() => supabase.from('due_collections').select('shop_name,amount').eq('dsr_id', dsrId).eq('date', date)),
    fetchAll(() => supabase.from('damage_collections').select('*').eq('dsr_id', dsrId).eq('date', date).order('created_at')),
    fetchAll(() => supabase.from('dsr_settlements').select('*').eq('dsr_id', dsrId).eq('date', date).order('created_at')),
    // CALC-2 — the van carries stock over from earlier days, so the
    // settlement hands back EVERYTHING still on the van, not just today's.
    computeVanDetail(dsrId, date, { damage: 'all' }),
    supabase.from('srs').select('name').eq('id', dsrId).maybeSingle(),
    getDueTotals([String(dsrId)])
  ]);
  const van = vanDetail.stock;

  const dayTx = await offerLib.hydrate(dayTx0 || []);
  const sum = (t, f) => (dayTx || []).filter(r => r.type === t).reduce((a, r) => a + num(r[f]), 0);
  const givenToday = sum('give', 'total_revenue'), returnedToday = sum('return', 'total_revenue');
  const soldValue = sum('dsr_sale', 'total_revenue');
  // v5.25 — the company-offer deduction lowered the shops' bills; the DSR's own due (full price) is cleared by it,
  // so it travels with the discount (company-borne) in the settlement. Shown separately as summary.offerToday.
  const offerToday = offerLib.netDeduction(dayTx.filter(r => r.type === 'dsr_sale'));
  const commission = sum('dsr_sale', 'commission_amt'), discount = _r2(sum('dsr_sale', 'discount_amt') + offerToday);
  const vanDamageTx = sum('damage', 'total_revenue');

  // P — cash shops handed over AT the sale. paid_amount on a due row also
  // grows when the shop pays later, so subtract every logged later collection.
  let cashAtSale = 0, creditToday = 0;
  if ((dueRows || []).length) {
    const ids = dueRows.map(r => String(r.id));
    const logged = await fetchAll(() => supabase.from('due_collections').select('due_id,amount').in('due_id', ids));
    const lm = {}; (logged || []).forEach(r => { lm[String(r.due_id)] = (lm[String(r.due_id)] || 0) + num(r.amount); });
    dueRows.forEach(r => {
      const initial = Math.max(0, num(r.paid_amount) - (lm[String(r.id)] || 0));
      cashAtSale += initial;
      creditToday += Math.max(0, num(r.amount) - initial);
    });
  }
  const dueCollected = (dueColsToday || []).reduce((a, r) => a + num(r.amount), 0);

  const damageMoney = (dmgCols || []).filter(r => r.resolution === 'money').reduce((a, r) => a + num(r.refund_amt), 0);
  const damageExchange = (dmgCols || []).filter(r => r.resolution === 'exchange').reduce((a, r) => a + Math.min(num(r.exch_value), num(r.damaged_value)), 0);
  const damageTotal = vanDamageTx + damageMoney + damageExchange;

  const done = { comm: 0, disc: 0, dmg: 0, cash: 0 };
  (settled || []).forEach(r => { done.comm += num(r.comm_amt); done.disc += num(r.disc_amt); done.dmg += num(r.dmg_amt); done.cash += num(r.cash_expected); });

  const cashExpectedRaw = _r2(cashAtSale + dueCollected - damageMoney - done.cash);
  const pend = {
    commission: Math.max(0, _r2(commission - done.comm)),
    discount:   Math.max(0, _r2(discount - done.disc)),
    damage:     Math.max(0, _r2(damageTotal - done.dmg))
  };

  // Unsold stock still on the van → goes back to the warehouse.
  const pids = Object.keys(van).filter(k => num(van[k]) > 0);
  const returnItems = [];
  if (pids.length && light) {
    pids.forEach(pid => returnItems.push({ productId: String(pid), totalUnits: num(van[pid]), value: 0 }));
  } else if (pids.length) {
    const prodMap = await loadProducts(pids);
    // price the DSR was actually charged (his latest loading of that product)
    const _gs = await require('./_lib/money').weightedGiveSnap(dsrId, pids, date);
    const givePrice = {}; Object.keys(_gs).forEach(k => { givePrice[k] = _gs[k].sp; });
    pids.forEach(pid => {
      const p = prodMap[pid]; if (!p) return;
      const units = num(van[pid]);
      const sp = givePrice[pid] !== undefined ? givePrice[pid] : num(p.selling_price);
      const _pp = _gs[pid] && num(_gs[pid].pp) > 0 ? num(_gs[pid].pp) : num(p.purchase_price);
      const cs = num(p.case_size) || 1;
      const whole = Math.floor(units / cs + 1e-9);
      returnItems.push({
        productId: String(p.id), productName: p.name || '', sku: p.sku || '', totalUnits: units,
        cases: whole, pcs: +(units - whole * cs).toFixed(4),
        sellingPrice: sp, purchasePrice: _pp,
        value: lineMoney(p, units, 'sell', sp), cost: lineMoney(p, units, 'buy', _pp),
        _rule: (_gs[pid] && _gs[pid].rule) || bonusSnapshot(p)
      });
    });
  }
  const returnValue = _r2(returnItems.reduce((a, i) => a + i.value, 0));

  const _dt = dueTotals[String(dsrId)] || { givenRev: 0, returnRev: 0, payments: 0 };
  const lifetimeDue = _r2((_dt.givenRev - _dt.returnRev) - _dt.payments);

  const pendingCash = Math.max(0, cashExpectedRaw);
  const hasPending = returnItems.length > 0 || pend.commission > 0 || pend.discount > 0 || pend.damage > 0 || Math.abs(cashExpectedRaw) > 0.005;
  return {
    dsrId, dsrName: (dsrRow && dsrRow.data && dsrRow.data.name) || '', date,
    summary: { givenToday: _r2(givenToday), returnedToday: _r2(returnedToday), soldValue: _r2(soldValue), offerToday, cashAtSale: _r2(cashAtSale), creditToday: _r2(creditToday) },
    dueCollected: _r2(dueCollected),
    dueCollections: (dueColsToday || []).map(r => ({ shopName: r.shop_name || '', amount: num(r.amount) })),
    damage: {
      total: _r2(damageTotal), vanDamage: _r2(vanDamageTx), moneyRefunded: _r2(damageMoney), exchanged: _r2(damageExchange),
      lines: (dmgCols || []).map(r => ({
        shopName: r.shop_name || '', productName: r.product_name || '', units: num(r.units), damagedValue: num(r.damaged_value),
        resolution: r.resolution, refundAmt: num(r.refund_amt), exchProductName: r.exch_product_name || '', exchUnits: num(r.exch_units), exchValue: num(r.exch_value)
      }))
    },
    returnItems, returnValue,
    pending: { commission: pend.commission, discount: pend.discount, damage: pend.damage, cashExpected: pendingCash, cashExpectedRaw },
    ownPocketShortfall: cashExpectedRaw < -0.005 ? _r2(-cashExpectedRaw) : 0,
    alreadySettledTimes: (settled || []).length,
    alreadySettledCash: _r2(done.cash),
    hasPending, lifetimeDue
  };
}

async function _performSettlement(d, byName) {
  const dsrId = String(d.dsrId || '');
  const token = String(d.token || '').trim();
  const date = (d.date && DATE_RE.test(d.date)) ? d.date : bdtToday();
  if (!dsrId) return { ok: false, error: 'DSR বাছাই করুন' };
  if (token.length < 8) return { ok: false, error: 'অনুরোধ যাচাই করা যায়নি — পেজ রিফ্রেশ করে আবার হিসাব দেখুন' };

  // Fast duplicate guard (double tap / retry) before any calculation.
  const dupe = await supabase.from('dsr_settlements').select('id').eq('token', token).maybeSingle();
  if (dupe.data) return { ok: false, duplicate: true, error: 'এই হিসাব আগেই সংরক্ষিত হয়েছে — দ্বিতীয়বার চাপলে হিসাব দ্বিগুণ হয় না।' };

  const c = await _computeSettlement(dsrId, date);
  const ap = d.apply || {};
  const doReturn = ap.return !== false && c.returnItems.length > 0;
  const comm = ap.commission !== false ? c.pending.commission : 0;
  const disc = ap.discount   !== false ? c.pending.discount   : 0;
  const dmg  = ap.damage     !== false ? c.pending.damage     : 0;
  const cashRecv = Math.max(0, _r2(c.pending.cashExpected));   // v5.21 — payment is always exactly the cash in hand (no editing)

  if (!c.hasPending) return { ok: false, duplicate: true, error: 'নতুন কোনো হিসাব বাকি নেই — আগের হিসাব ইতিমধ্যে সংরক্ষিত আছে।' };
  if (!doReturn && comm + disc + dmg + cashRecv <= 0 && Math.abs(c.pending.cashExpectedRaw) <= 0.005)
    return { ok: false, error: 'কিছুই বাছাই করা হয়নি' };

  const returnAmt = doReturn ? c.returnValue : 0;
  const payTotal = _r2(cashRecv + comm + disc + dmg);
  // v5.7 — never settle more than the DSR actually owes (cash + deductions + returned stock).
  if (_r2(payTotal + returnAmt) > _r2(c.lifetimeDue) + 0.01)
    return { ok: false, error: 'হিসাব বাকির চেয়ে বেশি হয়ে যাচ্ছে (বর্তমান বাকি ৳' + _r2(c.lifetimeDue).toFixed(2) + ') — পেজ রিফ্রেশ করে আবার দেখুন' };
  const ts = now_();

  // 1) Claim — UNIQUE(token) makes a concurrent second press fail right here.
  const _stlRow = {
    token, dsr_id: dsrId, dsr_name: c.dsrName || d.dsrName || '', date,
    comm_amt: comm, disc_amt: disc, dmg_amt: dmg, return_amt: returnAmt,
    cash_expected: c.pending.cashExpectedRaw, cash_received: cashRecv,
    note: String(d.note || '').slice(0, 200), created_by: byName || '', created_at: ts,
    received_by_id: String(d._recvId || d.actorId || ''), received_by_name: String(d._recvName || d.byName || byName || ''), received_by_role: String(d._recvRole || d.byRole || 'owner')
  };
  let { error: claimErr } = await supabase.from('dsr_settlements').insert(_stlRow);
  // database not upgraded yet (migrations/002_v5_11.sql not run) → save the settlement anyway, without the collector columns
  if (claimErr && /received_by/i.test(String(claimErr.message || ''))) {
    ['received_by_id', 'received_by_name', 'received_by_role'].forEach(k => delete _stlRow[k]);
    ({ error: claimErr } = await supabase.from('dsr_settlements').insert(_stlRow));
  }
  if (claimErr) {
    if (String(claimErr.code) === '23505' || /duplicate|unique/i.test(String(claimErr.message)))
      return { ok: false, duplicate: true, error: 'এই হিসাব আগেই সংরক্ষিত হয়েছে — দ্বিতীয়বার চাপলে হিসাব দ্বিগুণ হয় না।' };
    throw claimErr;
  }
  const release = async () => { try { await supabase.from('dsr_settlements').delete().eq('token', token); } catch (_) {} };

  // 2) Payment (cash + commission + discount + damage).
  let payId = null;
  try {
    if (payTotal > 0) {
      payId = randomUUID();
      const { error: payErr } = await supabase.from('sr_payments').insert({
        id: payId, sr_id: dsrId, sr_name: c.dsrName || '', date, amount: payTotal,
        cash_amount: cashRecv, commission_amt: comm, discount_amt: disc, damage_amt: dmg,
        note: ('দিনশেষ হিসাব' + (d.note ? ' — ' + String(d.note).slice(0, 100) : '')), created_at: ts
      });
      if (payErr) throw payErr;
    }
    // 3) Unsold van stock → 'return' rows (same as the ফেরত entry; DB
    //    trigger puts the stock back in the warehouse, due drops by value).
    if (doReturn) {
      const txId = randomUUID();
      const rows = c.returnItems.map(i => Object.assign({
        tx_id: txId, type: 'return', sr_id: dsrId, sr_name: c.dsrName || '', date, slip_no: '',
        product_id: i.productId, product_name: i.productName, sku: i.sku,
        cases: i.cases, pcs: i.pcs, total_units: i.totalUnits,
        purchase_price: i.purchasePrice, selling_price: i.sellingPrice,
        total_cost: i.cost, total_revenue: i.value,
        note: 'দিনশেষ হিসাব — অবিক্রিত মাল ফেরত', created_at: ts
      }, i._rule || {}));
      const { error: retErr } = await supabase.from('transactions').insert(rows);
      if (retErr) throw retErr;
    }
  } catch (e) {
    if (payId) { try { await supabase.from('sr_payments').delete().eq('id', payId); } catch (_) {} }
    await release();
    throw e;
  }

  const c2 = await _computeSettlement(dsrId, date);
  return {
    ok: true,
    applied: { cash: cashRecv, commission: comm, discount: disc, damage: dmg, returnValue: returnAmt, returnLines: doReturn ? c.returnItems.length : 0, paymentTotal: payTotal },
    cashShort: Math.max(0, _r2(c.pending.cashExpected - cashRecv)),
    lifetimeDue: c2.lifetimeDue
  };
}
