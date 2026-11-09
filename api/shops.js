// shops.js — AXIION Blueprint §3 + §11 route surface (v5.0: + shop ledger / memo history)
//
// Backend surface for the Shop Registry / Point-of-Sale module. This
// file wires up every action listed in §3's API map so the 12-file
// structure is complete and testable; the dedicated §11 UI screens
// (nearest-shop picker, visit workflow) are a separate front-end
// phase that will call straight into these same endpoints.
const { randomUUID } = require('crypto');
const {
  supabase, cors, num, now_, str, safeErr,
  mapShop, mapDue, mapTx, fetchAll, mapShopVisit, mapPosCustomer, bdtToday, computeVanStock,
  addDaysStr, cyclePeriodBounds, cyclePeriodToday, pageParams, idemRun, blockNegativeStock
} = require('./_lib/db');
const { priceItems, txRow, stockShortage, r2: _money2 } = require('./_lib/money');
const offerLib = require('./_lib/offer');   // v5.25 — automatic company-offer deduction

const DATE_RE_ = /^\d{4}-\d{2}-\d{2}$/;
// PERF-5 — explicit column lists (no select('*'))
const SHOP_COLS = 'id,shop_no,name,keeper_name,phone,address,lat,lng,assigned_dsr_id,assigned_dsr_name,road_id,road_name,created_at';
const DUE_COLS_ = 'id,dsr_id,dsr_name,client_type,shop_id,shop_name,due_date,amount,paid_amount,note,status,cleared_date,created_at,tx_id';
const TX_COLS_ = 'tx_id,type,sr_id,sr_name,date,slip_no,product_id,product_name,sku,cases,pcs,total_units,purchase_price,selling_price,total_cost,total_revenue,commission_amt,discount_amt,shop_id,customer_id,note,created_at,id';

// Open shop due per shop, summed INSIDE Postgres (PERF-3). Falls back to the
// old in-memory sum if the SQL function is not installed yet.
async function _shopDueMap(shopIds, dsrId) {
  const map = {};
  try {
    const { data, error } = await supabase.rpc('shop_due_totals', { p_shop_ids: shopIds && shopIds.length ? shopIds.map(String) : null, p_dsr_id: dsrId || null });
    if (error) throw error;
    (data || []).forEach(r => { map[String(r.shop_id || '')] = num(r.due); });
    return map;
  } catch (e) {
    const rows = await fetchAll(() => {
      let dq = supabase.from('due_calendar').select('shop_id,amount,paid_amount')
        .eq('client_type', 'shop').neq('status', 'cleared');
      if (dsrId) dq = dq.eq('dsr_id', dsrId);
      return dq;
    });
    rows.forEach(r => { const sid = String(r.shop_id || ''); map[sid] = (map[sid] || 0) + Math.max(0, num(r.amount) - num(r.paid_amount)); });
    return map;
  }
}


// V48 update #37/#38 — re-verifies an Owner PIN server-side (never trust
// a client-side role flag alone). Same table/pattern already used by
// api/attendance.js/_verifyOwnerPin, api/sr-payments.js action=
// approval_edit, and api/report.js action=daily-generate.
async function _verifyOwnerPin(pin) {
  const p = String(pin || '').trim();
  if (!/^\d{5}$/.test(p)) return false;
  const { data } = await supabase.from('user_passwords').select('id').eq('role', 'owner').eq('password', p).limit(1);
  return !!(data && data.length);
}

// V48 update #38 — blocks registering/renaming a shop to the exact same
// name (trimmed, case-insensitive) as an existing shop, so the owner is
// forced to add a distinguishing number/suffix instead of silently
// getting an identical duplicate. `excludeId` lets the edit action check
// against every OTHER shop without tripping on the shop's own row.
async function _isDuplicateShopName(name, excludeId) {
  const needle = String(name || '').trim().toLowerCase();
  if (!needle) return false;
  // Was a bare `select('id,name')` of the WHOLE shops table — silently capped
  // at 1000 rows, so with 1000+ shops a duplicate name past row 1000 slipped
  // through. Now asks the database only for names containing this text
  // (a tiny result set), then does the exact trimmed/case-insensitive match.
  const esc = needle.replace(/[\\%_,()]/g, ' ').replace(/\s+/g, ' ').trim();
  const { data, error } = await supabase.from('shops').select('id,name').ilike('name', '%' + esc + '%').limit(500);
  if (error) throw error;
  return (data || []).some(s => String(s.id) !== String(excludeId || '') && String(s.name || '').trim().toLowerCase() === needle);
}

// ══════════════════════════════════════════════════════════════════════
//  v5.0 — SHOP LEDGER (লেনদেন খাতা)
//  One running "khata" per shop, built purely from data that already
//  exists (transactions + due_calendar + due_collections + damage_collections):
//    • sale   — goods given (total, discount/commission, paid now, due added)
//    • pay    — a later due collection
//    • dmg/ret— damaged goods taken back (information only, never moves the due)
//  Events are replayed oldest → newest with a running balance. A "memo"
//  (cycle) OPENS on the first sale after the balance was zero and CLOSES
//  the moment the balance returns to zero — however many days that takes.
//  Closed memos become history; the open memo is the live one.
//  The final balance always equals Σ(amount − paid) of the shop's open
//  dues — the same number the rest of the app shows as "মোট বাকি".
// ══════════════════════════════════════════════════════════════════════
const _r2 = (n) => Math.round(num(n) * 100) / 100;
const _ms = (v) => { const t = new Date(v).getTime(); return isFinite(t) ? t : 0; };
const _d10 = (v) => (v ? String(v).slice(0, 10) : '');
function _dayDiff(a, b) {
  const x = new Date(_d10(a) + 'T00:00:00Z').getTime(), y = new Date(_d10(b) + 'T00:00:00Z').getTime();
  return (isFinite(x) && isFinite(y)) ? Math.max(0, Math.round((y - x) / 86400000)) : 0;
}

async function _buildShopLedger(shopId) {
  const sid = String(shopId);
  const _oc = await offerLib.selCols();
  const [txRows0, dueRows, colRows, dmgRows] = await Promise.all([
    fetchAll(() => supabase.from('transactions')
      .select('id,tx_id,type,date,created_at,sr_name,slip_no,total_units,total_revenue,commission_amt,discount_amt,note,product_name,product_id,cases,pcs' + _oc)
      .eq('shop_id', sid).in('type', ['dsr_sale', 'dsr_sale_return', 'point_sale', 'point_damage_return'])),
    fetchAll(() => supabase.from('due_calendar').select(DUE_COLS_).eq('shop_id', sid).eq('client_type', 'shop')),
    fetchAll(() => supabase.from('due_collections').select('*').eq('shop_id', sid)),
    fetchAll(() => supabase.from('damage_collections').select('*').eq('shop_id', sid))
  ]);

  const txRows = await offerLib.hydrate(txRows0 || []);
  // 1) group transaction rows into bills (one bill = one tx_id)
  const bills = {};
  (txRows || []).forEach(r => {
    const k = String(r.tx_id || r.id);
    const b = bills[k] || (bills[k] = { txId: k, type: r.type, date: _d10(r.date), at: r.created_at, dsrName: r.sr_name || '',
      slipNo: r.slip_no || '', note: r.note || '', rev: 0, comm: 0, disc: 0, off: 0, units: 0, lines: 0, items: [] });
    b.items.push({ n: r.product_name || '', c: num(r.cases), p: num(r.pcs), u: num(r.total_units), v: _r2(r.total_revenue), cm: _r2(r.commission_amt), ds: _r2(r.discount_amt), of: offerLib.dedOf(r) });   // v5.21 — tally-book rows list the goods
    b.rev += num(r.total_revenue); b.comm += num(r.commission_amt); b.disc += num(r.discount_amt); b.off += offerLib.dedOf(r);
    b.units += num(r.total_units); b.lines += 1;
    if (_ms(r.created_at) && _ms(r.created_at) < _ms(b.at)) b.at = r.created_at;
  });

  // 2) link each bill to its due row — by tx_id (v5.0+) or, for older
  //    data, by same shop + same date + same payable amount.
  const dues = (dueRows || []).map(r => ({ ...r, _used: false }));
  const dueByTx = {};
  dues.forEach(d => { if (d.tx_id) dueByTx[String(d.tx_id)] = d; });
  const colByDue = {};
  (colRows || []).forEach(c => { const k = String(c.due_id); (colByDue[k] = colByDue[k] || []).push(c); });
  const loggedFor = (d) => (colByDue[String(d.id)] || []).reduce((t, c) => t + num(c.amount), 0);

  const billList = Object.values(bills).sort((a, b) => _ms(a.at) - _ms(b.at));
  billList.forEach(b => {
    b.payable = _r2(b.rev - b.comm - b.disc - b.off);
    if (b.type !== 'dsr_sale') return;
    let d = dueByTx[b.txId];
    if (!d) {
      let best = null, bestGap = Infinity;
      dues.forEach(x => {
        if (x._used || x.tx_id) return;
        if (_d10(x.due_date) !== b.date) return;
        if (Math.abs(num(x.amount) - b.payable) > 0.02) return;
        const gap = Math.abs(_ms(x.created_at) - _ms(b.at));
        if (gap < bestGap) { best = x; bestGap = gap; }
      });
      d = best;
    }
    if (d) { d._used = true; b.due = d; }
  });

  // 3) build events
  const ev = [];
  billList.forEach(b => {
    if (b.type === 'point_damage_return' || b.type === 'dsr_sale_return') {
      ev.push({ kind: 'ret', key: b.txId, txId: b.txId, at: b.at, date: b.date, dsrName: b.dsrName, value: _r2(b.rev - b.off), offer: _r2(b.off), units: b.units, note: b.note, items: b.items, saleReturn: b.type === 'dsr_sale_return' });
      return;
    }
    let billed = b.payable, paid = b.payable;         // counter sales are settled on the spot
    if (b.type === 'dsr_sale') {
      if (b.due) {
        billed = _r2(num(b.due.amount));
        paid = _r2(Math.min(billed, Math.max(0, num(b.due.paid_amount) - loggedFor(b.due))));
      } else { paid = b.payable; }                     // no due row was ever opened → fully paid
    }
    ev.push({ kind: 'sale', key: b.txId, txId: b.txId, dueId: b.due ? String(b.due.id) : '', saleType: b.type,
      at: b.at, date: b.date, slipNo: b.slipNo, dsrName: b.dsrName,
      gross: _r2(b.rev), discount: _r2(b.disc), commission: _r2(b.comm), offer: _r2(b.off), billed, paid, dueAdded: _r2(billed - paid),
      units: b.units, itemCount: b.lines, note: b.note, items: b.items, affects: true });
  });
  // due rows that belong to no bill (manually added dues, or very old data)
  dues.filter(d => !d._used).forEach(d => {
    const billed = _r2(num(d.amount));
    const paid = _r2(Math.min(billed, Math.max(0, num(d.paid_amount) - loggedFor(d))));
    ev.push({ kind: 'sale', key: 'due:' + d.id, txId: '', dueId: String(d.id), saleType: 'manual',
      at: d.created_at, date: _d10(d.due_date), slipNo: '', dsrName: d.dsr_name || '',
      gross: billed, discount: 0, commission: 0, billed, paid, dueAdded: _r2(billed - paid),
      units: 0, itemCount: 0, note: d.note || 'হাতে লেখা বাকি', affects: true });
  });
  const keyOfDue = {};
  ev.forEach(e => { if (e.kind === 'sale' && e.dueId) keyOfDue[e.dueId] = e; });
  (colRows || []).forEach(c => {
    const sale = keyOfDue[String(c.due_id)];
    ev.push({ kind: 'pay', key: 'c:' + c.id, at: c.created_at, date: _d10(c.date), amount: _r2(c.amount), byName: c.collector_name || c.dsr_name || c.credit_dsr_name || '',
      forKey: sale ? sale.key : '', forDate: sale ? sale.date : '', forSlip: sale ? sale.slipNo : '', affects: !!sale });
  });
  const dmgGroups = {};
  (dmgRows || []).forEach(r => {
    const g = dmgGroups[r.col_id] || (dmgGroups[r.col_id] = { kind: 'dmg', key: 'g:' + r.col_id, at: r.created_at, date: _d10(r.date),
      dsrName: r.dsr_name || '', lines: [], value: 0, refund: 0, exch: 0 });
    g.lines.push({ productName: r.product_name || '', units: num(r.units), value: _r2(r.damaged_value), resolution: r.resolution,
      refund: _r2(r.refund_amt), exchProductName: r.exch_product_name || '', exchUnits: num(r.exch_units), exchValue: _r2(r.exch_value) });
    g.value += num(r.damaged_value); g.refund += num(r.refund_amt); g.exch += num(r.exch_value);
  });
  Object.values(dmgGroups).forEach(g => { g.value = _r2(g.value); g.refund = _r2(g.refund); g.exch = _r2(g.exch); ev.push(g); });

  const rank = { sale: 0, pay: 1, ret: 2, dmg: 3 };
  ev.sort((a, b) => (_ms(a.at) - _ms(b.at)) || (rank[a.kind] - rank[b.kind]) || String(a.key).localeCompare(String(b.key)));

  // 4) replay → running balance → memos
  const cycles = [];
  let cur = null, bal = 0, pendingInfo = [];
  const open = (e) => {
    cur = { no: cycles.length + 1, status: 'open', startAt: e.at, startDate: e.date, endAt: '', endDate: '',
      events: [], given: 0, paidNow: 0, collected: 0, saleCount: 0, payCount: 0, due: 0 };
    cycles.push(cur);
    if (pendingInfo.length) { cur.events.push(...pendingInfo); pendingInfo = []; }
  };
  ev.forEach(e => {
    if (e.kind === 'ret' || e.kind === 'dmg') {          // information only
      if (cur) cur.events.push(e);
      else if (cycles.length) cycles[cycles.length - 1].events.push(e);
      else pendingInfo.push(e);
      return;
    }
    if (e.kind === 'sale') {
      if (!cur) open(e);
      bal = _r2(bal + e.dueAdded);
      cur.given = _r2(cur.given + e.billed); cur.paidNow = _r2(cur.paidNow + e.paid); cur.saleCount += 1;
    } else { // pay
      if (!cur) { e.affects = false; (cycles.length ? cycles[cycles.length - 1] : (open(e), cur)).events.push(e); return; }
      if (e.affects) { bal = _r2(bal - e.amount); cur.collected = _r2(cur.collected + e.amount); cur.payCount += 1; }
    }
    e.balance = bal;
    cur.events.push(e);
    if (bal <= 0.009) {                                    // due hit zero → memo closes
      cur.status = 'closed'; cur.endAt = e.at; cur.endDate = e.date; cur.due = 0; cur = null; bal = 0;
    }
  });
  if (cur) cur.due = _r2(bal);
  cycles.forEach(c => { c.days = _dayDiff(c.startDate, c.endDate || bdtToday()); });

  const sum = (f) => _r2(cycles.reduce((t, c) => t + f(c), 0));
  const allPay = ev.filter(e => e.kind === 'pay' && e.affects);
  const currentDue = cur ? _r2(bal) : 0;
  return {
    cycles: cycles.slice().reverse(),                      // newest first (open memo on top)
    summary: {
      totalGiven: sum(c => c.given), paidAtDelivery: sum(c => c.paidNow), collectedLater: sum(c => c.collected),
      currentDue, memoCount: cycles.length, closedCount: cycles.filter(c => c.status === 'closed').length,
      hasOpen: !!cur, saleCount: sum(c => c.saleCount),
      firstAt: ev.length ? ev[0].at : '', lastAt: ev.length ? ev[ev.length - 1].at : '',
      lastPayAt: allPay.length ? allPay[allPay.length - 1].at : ''
    }
  };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';

  try {
    // ══════════════════════════════════════════════════
    //  REGISTER — Owner registers a shop under a DSR
    // ══════════════════════════════════════════════════
    if (req.method === 'POST' && action === 'register') {
      const d = req.body;
      if (!String(d.name || '').trim()) return res.json({ ok: false, error: 'দোকানের নাম আবশ্যক' });

      // Update #38 — block an exact-name duplicate; ask for a
      // distinguishing number/suffix instead of a silent identical row.
      if (await _isDuplicateShopName(d.name)) {
        return res.json({ ok: false, error: 'এই নামে ইতিমধ্যে একটি শপ নিবন্ধিত আছে — আলাদা করতে নামের সাথে একটি নম্বর/সংযোজন যোগ করুন (যেমন: "মা স্টোর ২")' });
      }

      // ══════════════════════════════════════════════════
      //  ROAD → AUTO-FILL SO/DSR (Update #23)
      //  Registering a shop now picks a Road; that road's currently
      //  assigned DSR (Update #22) is derived automatically — assignedDsrId
      //  is no longer chosen by hand once a road is picked. A bare
      //  assignedDsrId with no roadId is still accepted for backward
      //  compatibility (older clients / one-off shops with no road).
      // ══════════════════════════════════════════════════
      let assignedDsrId = d.assignedDsrId ? String(d.assignedDsrId) : '';
      let assignedDsrName = '';
      let roadId = '', roadName = '';
      if (d.roadId) {
        const { data: road, error: roadErr } = await supabase.from('roads').select('*').eq('id', d.roadId).single();
        if (roadErr || !road) return res.json({ ok: false, error: 'রোড পাওয়া যায়নি' });
        if (!road.dsr_id) return res.json({ ok: false, error: 'এই রোডে এখনো DSR নেই — আগে SO নিয়োগ করুন' });
        roadId = String(road.id); roadName = road.name || '';
        assignedDsrId = road.dsr_id; assignedDsrName = road.dsr_name || '';
      } else {
        // v4.8.0 — every shop must belong to a road so shops can be
        // filtered/planned by road. (A DSR id alone is no longer enough.)
        return res.json({ ok: false, error: 'রোড নির্বাচন আবশ্যক — দোকানটি কোন রোডের অধীনে তা বেছে নিন' });
      }

      const { data: seq, error: seqErr } = await supabase.rpc('next_shop_no');
      if (seqErr) throw seqErr;
      const shopNo = 'SHOP-' + String(seq).padStart(4, '0');

      const { data, error } = await supabase.from('shops').insert({
        id:               randomUUID(),
        shop_no:          shopNo,
        name:             str(d.name, 200),
        keeper_name:      str(d.keeperName, 200),
        phone:            str(d.phone, 30),
        address:          str(d.address, 300),
        lat:              d.lat != null ? num(d.lat) : null,
        lng:              d.lng != null ? num(d.lng) : null,
        assigned_dsr_id:  assignedDsrId,
        assigned_dsr_name: assignedDsrName,
        road_id:          roadId,
        road_name:        roadName,
        created_at:       now_()
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, shop: mapShop(data) });
    }

    // ══════════════════════════════════════════════════
    //  EDIT — Owner-only. Name + phone number only (Update #37).
    //  GPS location stays locked once captured — if a shop truly needs
    //  to move, the owner deletes it and re-registers on the spot so the
    //  new GPS point is captured fresh, rather than letting a stale
    //  coordinate be hand-typed here.
    // ══════════════════════════════════════════════════
    if (req.method === 'POST' && action === 'edit') {
      const d = req.body || {};
      if (!d.shopId) return res.json({ ok: false, error: 'shopId প্রয়োজন' });
      // v5.16 — Owner OR Manager may edit, confirming with their OWN password (verified here).
      {
        const pin = String(d.pin || d.ownerPin || '').trim();
        const aid = String(d.actorId || '').trim();
        let okAct = false;
        if (aid && pin) {
          const { data: pw } = await supabase.from('user_passwords').select('role').eq('user_key', aid).eq('password', pin).limit(1);
          okAct = !!(pw && pw.length && (pw[0].role === 'owner' || pw[0].role === 'manager'));
        } else if (pin) {
          okAct = await _verifyOwnerPin(pin);      // older clients: owner PIN only
        }
        if (!okAct) return res.json({ ok: false, error: 'ভুল পাসওয়ার্ড (শুধু Owner / Manager সম্পাদনা করতে পারেন)' });
      }

      const name = String(d.name || '').trim();
      if (!name) return res.json({ ok: false, error: 'দোকানের নাম আবশ্যক' });
      if (await _isDuplicateShopName(name, d.shopId)) {
        return res.json({ ok: false, error: 'এই নামে ইতিমধ্যে অন্য একটি শপ আছে — আলাদা করতে নামের সাথে একটি নম্বর/সংযোজন যোগ করুন' });
      }

      const update = { name: str(name, 200), phone: str(d.phone, 30) };
      // other non-sensitive details (GPS lat/lng is NEVER touched here)
      if (d.keeperName !== undefined) update.keeper_name = str(d.keeperName, 200);
      if (d.address !== undefined)    update.address     = str(d.address, 300);

      // ── Road / DSR reassignment — Owner can move a shop to a different
      //    road (and its paired DSR come along automatically) after
      //    registration, or manually detach it from any road entirely.
      //    d.roadId === undefined  -> road left untouched (old clients).
      //    d.roadId === '' (empty) -> road explicitly cleared.
      //    d.roadId === '<id>'     -> shop moves to that road's DSR.
      if (d.roadId !== undefined) {
        const roadId = String(d.roadId || '').trim();
        if (roadId) {
          const { data: road, error: roadErr } = await supabase.from('roads').select('*').eq('id', roadId).single();
          if (roadErr || !road) return res.json({ ok: false, error: 'রোড পাওয়া যায়নি' });
          if (!road.dsr_id) return res.json({ ok: false, error: 'এই রোডে এখনো DSR নেই — আগে SO নিয়োগ করুন' });
          update.road_id = String(road.id);
          update.road_name = road.name || '';
          update.assigned_dsr_id = road.dsr_id;
          update.assigned_dsr_name = road.dsr_name || '';
        } else {
          update.road_id = '';
          update.road_name = '';
        }
      }

      const { data, error } = await supabase.from('shops')
        .update(update)
        .eq('id', d.shopId).select().single();
      if (error) throw error;
      if (!data) return res.json({ ok: false, error: 'দোকান পাওয়া যায়নি' });
      return res.json({ ok: true, shop: mapShop(data) });
    }

    // ══════════════════════════════════════════════════
    //  DELETE — Owner-only (Update #37). Removes the shop row; since
    //  every map/list view is re-fetched from `list`/`search` above, the
    //  deleted shop's marker simply stops appearing — no separate
    //  "remove marker" step needed. Due/sales history rows are left
    //  intact for bookkeeping continuity; they just lose a live shop to
    //  point back to.
    // ══════════════════════════════════════════════════
    if (req.method === 'POST' && action === 'delete') {
      const d = req.body || {};
      if (!d.shopId) return res.json({ ok: false, error: 'shopId প্রয়োজন' });
      if (!(await _verifyOwnerPin(d.ownerPin))) return res.json({ ok: false, error: 'ভুল Owner PIN' });

      const { error } = await supabase.from('shops').delete().eq('id', d.shopId);
      if (error) throw error;
      return res.json({ ok: true });
    }

    // ══════════════════════════════════════════════════
    //  LIST / SEARCH — by number, name, DSR, or GPS proximity
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && (action === 'list' || action === 'search')) {
      const { q, dsrId, dsrIds, roadId, lat, lng, limit } = req.query;
      const dsrList = String(dsrIds || '').split(',').map(x => x.trim()).filter(Boolean);

      // PERF-1 — the search text is matched INSIDE the database (trigram
      // index on name/phone/keeper), and the list is cut into pages there too.
      const needle = String(q || '').trim().replace(/[\\%_,()*]/g, ' ').replace(/\s+/g, ' ').trim();
      const applyFilters = (qb) => {
        if (dsrId) qb = qb.eq('assigned_dsr_id', dsrId);
        if (dsrList.length) qb = qb.in('assigned_dsr_id', dsrList);
        if (roadId) qb = qb.eq('road_id', roadId);
        if (needle) {
          const like = '%' + needle + '%';
          qb = qb.or(['shop_no', 'name', 'keeper_name', 'phone', 'assigned_dsr_name', 'address'].map(c => c + '.ilike.' + like).join(','));
        }
        return qb;
      };

      // Paged mode (?page=1&pageSize=100): one small page + its due totals.
      const pg = pageParams(req.query, 100);
      if (pg && !(lat && lng)) {
        const { data, error, count } = await applyFilters(supabase.from('shops').select(SHOP_COLS, { count: 'exact' })
          .order('created_at', { ascending: false }).order('id')).range(pg.from, pg.to);
        if (error) throw error;
        const pageShops = (data || []).map(mapShop);
        const dueMap = pageShops.length ? await _shopDueMap(pageShops.map(x => x.id), dsrId || '') : {};
        const shops = pageShops.map(x => ({ ...x, totalDue: dueMap[x.id] || 0 }));
        return res.json({ ok: true, shops, page: pg.page, pageSize: pg.pageSize, total: count || 0, hasMore: pg.to + 1 < (count || 0) });
      }

      // Full-list mode (kept for the nearest-shop picker, which needs every
      // shop of one DSR to sort by distance). Still much lighter than before:
      // explicit columns, search done by the database, dues summed by Postgres.
      const data = await fetchAll(() => applyFilters(supabase.from('shops').select(SHOP_COLS).order('created_at', { ascending: false })));
      let shops = (data || []).map(mapShop);
      if (shops.length) {
        const dueMap = await _shopDueMap(shops.length <= 150 ? shops.map(x => x.id) : null, dsrId || '');
        shops = shops.map(x => ({ ...x, totalDue: dueMap[x.id] || 0 }));
      }

      // Free GPS-proximity sort — simple haversine, no paid "nearby search" API
      if (lat && lng) {
        const la = num(lat), ln = num(lng);
        const dist = (a, b) => {
          if (a.lat == null || a.lng == null) return Infinity;
          const R = 6371000;
          const dLat = (a.lat - b.lat) * Math.PI / 180;
          const dLng = (a.lng - b.lng) * Math.PI / 180;
          const s = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
          return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
        };
        shops = shops
          .map(s => ({ ...s, distanceM: dist(s, { lat: la, lng: ln }) }))
          .sort((a, b) => a.distanceM - b.distanceM);
      }

      if (limit) shops = shops.slice(0, num(limit));
      return res.json({ ok: true, shops });
    }


    // ══════════════════════════════════════════════════
    //  TOP-SHOPS — Owner dashboard "সেরা ৫০ দোকান"
    //  GET /api/shops?action=top-shops&range=cycle|30|90|all&sort=best|buy|lowdue&limit=50
    //  Ranks the shops the dealer actually does business with:
    //    buy   = Σ dsr_sale + point_sale − point_damage_return revenue in the window
    //    due   = the shop's CURRENT unpaid due (all open due_calendar rows)
    //    score = buy × (1 − min(1, due ÷ buy))  → big buyers who also PAY rank
    //            first; a shop that buys a lot but owes nearly all of it drops.
    //  sort=buy → highest buying only; sort=lowdue → lowest due first among
    //  shops with real buying. Every row carries the phone for one-tap call.
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'top-shops') {
      const range = String(req.query.range || 'cycle');
      const sort  = String(req.query.sort  || 'best');
      const limit = Math.max(1, Math.min(100, num(req.query.limit) || 50));
      const today = bdtToday();
      let from = null, to = today;
      if (range === '30')      from = addDaysStr(today, -29);
      else if (range === '90') from = addDaysStr(today, -89);
      else if (range === 'all') from = null;
      else { const b = cyclePeriodBounds(cyclePeriodToday()); from = b.start; to = b.end < today ? b.end : today; }

      // PERF-3 — buying totals and open dues are summed inside Postgres.
      // (The old code downloaded every sale row of the window — for
      // "all time" that is the whole sales history.)
      const agg = {};
      const dueMap = await _shopDueMap(null, '');
      let aggOk = false;
      try {
        const { data, error } = await supabase.rpc('shop_buying_totals', { p_from: from || '1900-01-01', p_to: to });
        if (error) throw error;
        (data || []).forEach(r => {
          const sid = String(r.shop_id || ''); if (!sid) return;
          agg[sid] = { shopId: sid, buy: num(r.buy), orders: { size: num(r.orders) }, lastBuy: String(r.last_buy || '').slice(0, 10) };
        });
        aggOk = true;
      } catch (e) { aggOk = false; }
      if (!aggOk) {
        const txRows = await fetchAll(() => {
          let q = supabase.from('transactions').select('shop_id,type,tx_id,date,total_revenue')
            .in('type', ['dsr_sale', 'point_sale', 'point_damage_return']).neq('shop_id', '');
          if (from) q = q.gte('date', from);
          return q.lte('date', to);
        });
        (txRows || []).forEach(r => {
          const sid = String(r.shop_id || ''); if (!sid) return;
          const a = agg[sid] || (agg[sid] = { shopId: sid, buy: 0, orders: new Set(), lastBuy: '' });
          const rev = num(r.total_revenue);
          if (r.type === 'point_damage_return') { a.buy -= rev; return; }
          a.buy += rev; a.orders.add(String(r.tx_id || ''));
          const d = String(r.date || '').slice(0, 10); if (d > a.lastBuy) a.lastBuy = d;
        });
      }

      let list = Object.values(agg).filter(a => a.buy > 0).map(a => {
        const due = +(dueMap[a.shopId] || 0).toFixed(2);
        const buy = +a.buy.toFixed(2);
        const dueRatio = buy > 0 ? Math.min(1, due / buy) : 1;
        return { shopId: a.shopId, buy, due, orders: a.orders.size, lastBuy: a.lastBuy,
                 dueRatio: +dueRatio.toFixed(4), score: +(buy * (1 - dueRatio)).toFixed(2) };
      });
      if (sort === 'buy')         list.sort((x, y) => y.buy - x.buy);
      else if (sort === 'lowdue') list.sort((x, y) => (x.due - y.due) || (y.buy - x.buy));
      else                        list.sort((x, y) => (y.score - x.score) || (y.buy - x.buy));

      // Shop details (name/phone/…) for just the winners — a few .in() chunks.
      const top = list.slice(0, limit + 20);            // small spare in case a shop was deleted
      const info = {};
      for (let i = 0; i < top.length; i += 50) {
        const ids = top.slice(i, i + 50).map(x => x.shopId);
        const { data: sh, error: shErr } = await supabase.from('shops')
          .select('id,shop_no,name,keeper_name,phone,address,road_name,assigned_dsr_name').in('id', ids);
        if (shErr) throw shErr;
        (sh || []).forEach(x => { info[String(x.id)] = x; });
      }
      const shops = top.filter(x => info[x.shopId]).slice(0, limit).map((x, i) => {
        const sh = info[x.shopId];
        return { rank: i + 1, ...x, shopNo: sh.shop_no || '', name: sh.name || '', keeperName: sh.keeper_name || '',
                 phone: sh.phone || '', address: sh.address || '', roadName: sh.road_name || '', dsrName: sh.assigned_dsr_name || '' };
      });
      return res.json({ ok: true, range, sort, from: from || '', to, totalShopsBuying: list.length, shops });
    }

    // ══════════════════════════════════════════════════
    //  v5.0 — LEDGER: the shop's full lenden khata, grouped into memos
    //  GET /api/shops?action=ledger&shopId=…
    //  GET /api/shops?action=ledger-sale&shopId=…&txId=…  (item detail of one bill)
    //  Read-only; every role (Owner / Manager / SO / DSR) can open it.
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'ledger') {
      const { shopId } = req.query;
      if (!shopId) return res.json({ ok: false, error: 'shopId প্রয়োজন' });
      const { data: shopRow, error: shopErr } = await supabase.from('shops').select(SHOP_COLS).eq('id', shopId).maybeSingle();
      if (shopErr) throw shopErr;
      if (!shopRow) return res.json({ ok: false, error: 'দোকান পাওয়া যায়নি' });
      const L = await _buildShopLedger(shopId);
      return res.json({ ok: true, shop: mapShop(shopRow), ...L });
    }

    if (req.method === 'GET' && action === 'ledger-sale') {
      const { shopId, txId } = req.query;
      if (!shopId || !txId) return res.json({ ok: false, error: 'shopId ও txId প্রয়োজন' });
      const rows = await fetchAll(() => supabase.from('transactions').select('*').eq('tx_id', String(txId)).eq('shop_id', String(shopId)));
      if (!rows.length) return res.json({ ok: false, error: 'বিল পাওয়া যায়নি' });
      const items = rows.map(r => ({
        productName: r.product_name || '', sku: r.sku || '', cases: num(r.cases), pcs: num(r.pcs), units: num(r.total_units),
        price: num(r.selling_price), total: _r2(r.total_revenue), commission: _r2(r.commission_amt), discount: _r2(r.discount_amt)
      }));
      const gross = _r2(items.reduce((t, i) => t + i.total, 0));
      const commission = _r2(items.reduce((t, i) => t + i.commission, 0));
      const discount = _r2(items.reduce((t, i) => t + i.discount, 0));
      return res.json({ ok: true, txId: String(txId), type: rows[0].type, date: _d10(rows[0].date), at: rows[0].created_at,
        slipNo: rows[0].slip_no || '', dsrName: rows[0].sr_name || '', items, gross, commission, discount,
        payable: _r2(gross - commission - discount) });
    }

    // ══════════════════════════════════════════════════
    //  v5.17 — বিক্রয় ফেরত (SALE RETURN)
    //  A shop that was given goods but cannot pay hands them back to the DSR.
    //    sale-return-info  GET  shopId, dsrId → what this shop bought from this DSR (minus what it
    //                                            already returned) + the shop's open due
    //    sale-return       POST shopId, dsrId, items[] → rows of type 'dsr_sale_return' (the goods
    //                                            go back on the DSR's van) and the shop's due goes
    //                                            down by the value (oldest due first)
    //    sale-return-list  GET  dsrId|all, from, to → every return, newest first
    //  Warehouse stock is NOT touched (the goods never left the DSR); the DSR's own due is NOT touched
    //  (he still holds the goods, now as van stock instead of as a shop's debt).
    // ══════════════════════════════════════════════════
    const _soldReturned = async (shopId, dsrId) => {
      const rows = await fetchAll(() => supabase.from('transactions')
        .select('product_id,product_name,type,total_units,selling_price')
        .eq('shop_id', String(shopId)).eq('sr_id', String(dsrId)).in('type', ['dsr_sale', 'dsr_sale_return']));
      const m = {};
      rows.forEach(r => {
        const k = String(r.product_id || ''); if (!k) return;
        const o = m[k] || (m[k] = { productId: k, productName: r.product_name || '', sold: 0, returned: 0, price: 0 });
        if (r.type === 'dsr_sale') { o.sold += num(r.total_units); if (num(r.selling_price) > 0) o.price = num(r.selling_price); }
        else o.returned += num(r.total_units);
      });
      return m;
    };
    const _shopOpenDues = async (shopId) => {
      const rows = await fetchAll(() => supabase.from('due_calendar').select(DUE_COLS_)
        .eq('client_type', 'shop').eq('shop_id', String(shopId)).neq('status', 'cleared'));
      return (rows || []).filter(r => num(r.amount) - num(r.paid_amount) > 0.004)
        .sort((a, b) => String(a.due_date || '').localeCompare(String(b.due_date || '')) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
    };

    if (req.method === 'GET' && action === 'sale-return-info') {
      const { shopId, dsrId } = req.query;
      if (!shopId || !dsrId) return res.json({ ok: false, error: 'shopId ও dsrId প্রয়োজন' });
      const [m, dues, shopRes] = await Promise.all([
        _soldReturned(shopId, dsrId), _shopOpenDues(shopId),
        supabase.from('shops').select('id,name,phone').eq('id', String(shopId)).maybeSingle()
      ]);
      const products = Object.values(m).map(o => ({ ...o, sold: num(o.sold), returned: num(o.returned), returnable: Math.max(0, +(o.sold - o.returned).toFixed(4)) }))
        .filter(o => o.returnable > 0);
      const due = _money2(dues.reduce((a, r) => a + (num(r.amount) - num(r.paid_amount)), 0));
      return res.json({ ok: true, shop: shopRes && shopRes.data ? { id: String(shopRes.data.id), name: shopRes.data.name || '', phone: shopRes.data.phone || '' } : null, due, products });
    }

    if (req.method === 'POST' && action === 'sale-return') return idemRun(req, res, 'sale-return', async () => {
      const d = req.body || {};
      if (!d.shopId || !d.dsrId) return res.json({ ok: false, error: 'দোকান ও DSR প্রয়োজন' });
      const items = Array.isArray(d.items) ? d.items : [];
      if (!items.length) return res.json({ ok: false, error: 'অন্তত একটি পণ্য প্রয়োজন' });
      const date = (d.date && DATE_RE_.test(d.date)) ? d.date : bdtToday();

      const priced = await priceItems(items, { type: 'dsr_sale_return', shopId: d.shopId, srId: d.dsrId, date });
      if (!priced.ok) return res.json({ ok: false, error: priced.error });
      const lines = priced.lines;

      // 1) never return more than this shop bought from this DSR (minus earlier returns)
      const sr = await _soldReturned(d.shopId, d.dsrId);
      const want = {};
      lines.forEach(l => { want[l.productId] = (want[l.productId] || 0) + l.units; });
      for (const pid of Object.keys(want)) {
        const o = sr[pid]; const left = o ? num(o.sold) - num(o.returned) : 0;
        const nm = (lines.find(l => l.productId === pid) || {}).productName || 'পণ্য';
        if (want[pid] > left + 0.0001) return res.json({ ok: false, error: nm + ' — এই দোকান এই DSR থেকে ফেরতযোগ্য মাত্র ' + left + ' পিস নিয়েছে, কিন্তু ' + want[pid] + ' পিস ফেরত দিচ্ছেন' });
      }

      // v5.25 — reverse the offer deduction of the ORIGINAL sale, proportionally (whole cases returned)
      const _srcOff = await offerLib.sourceOffers({ shopId: d.shopId, srId: d.dsrId }, ['dsr_sale'], lines.map(l => l.productId), date);
      const offerBack = offerLib.applyReturnOffers(lines, _srcOff);
      // 2) the value comes off the shop's due, so it can never be more than the due
      const value = _money2(lines.reduce((a, l) => a + num(l.revenue), 0) - offerBack);
      const dues = await _shopOpenDues(d.shopId);
      const dueTotal = _money2(dues.reduce((a, r) => a + (num(r.amount) - num(r.paid_amount)), 0));
      if (value > dueTotal + 0.009) return res.json({ ok: false, error: 'ফেরতের মূল্য ৳' + value + ' — কিন্তু দোকানের বাকি মাত্র ৳' + dueTotal + '। বাকির চেয়ে বেশি মূল্যের পণ্য ফেরত নেওয়া যাবে না।' });

      const txId = randomUUID(), ts = now_();
      const rows = lines.map(l => txRow(l, {
        tx_id: txId, type: 'dsr_sale_return', sr_id: String(d.dsrId), sr_name: d.dsrName || '',
        date, slip_no: d.slipNo || '', shop_id: String(d.shopId), note: d.note || 'দোকান থেকে বিক্রয় ফেরত', created_at: ts
      }));
      const { error: insErr } = await supabase.from('transactions').insert(rows);
      if (insErr) {
        if (/transactions_type_check|violates check constraint/i.test(String(insErr.message || ''))) return res.json({ ok: false, error: 'ডাটাবেস আপডেট বাকি — migrations/003_v5_17.sql একবার Supabase-এ চালান, তারপর আবার চেষ্টা করুন' });
        throw insErr;
      }

      if (offerBack > 0) await offerLib.persist(txId, lines);
      // 3) lower the shop's due, oldest first; roll the return back if a due row changed under us
      let left = value; const done = [];
      try {
        for (const r of dues) {
          if (left <= 0.004) break;
          const rem = _money2(num(r.amount) - num(r.paid_amount));
          const take = _money2(Math.min(rem, left));
          const newAmt = _money2(num(r.amount) - take);
          const cleared = _money2(newAmt - num(r.paid_amount)) < 0.01;
          const { data: upd, error: uErr } = await supabase.from('due_calendar').update({
            amount: cleared ? _money2(num(r.paid_amount)) : newAmt,
            status: cleared ? 'cleared' : r.status,
            cleared_date: cleared ? date : null
          }).eq('id', r.id).eq('amount', r.amount).select('id');
          if (uErr) throw uErr;
          if (!upd || !upd.length) throw new Error('due changed');
          done.push({ id: r.id, amount: r.amount, status: r.status, cleared_date: r.cleared_date || null });
          left = _money2(left - take);
        }
        if (left > 0.01) throw new Error('due short');
      } catch (e) {
        for (const x of done) { try { await supabase.from('due_calendar').update({ amount: x.amount, status: x.status, cleared_date: x.cleared_date }).eq('id', x.id); } catch (_) {} }
        await supabase.from('transactions').delete().eq('tx_id', txId);
        return res.json({ ok: false, error: 'বাকির হিসাব এইমাত্র বদলে গেছে — পেজ রিফ্রেশ করে আবার চেষ্টা করুন' });
      }
      return res.json({ ok: true, txId, value, dueBefore: dueTotal, dueAfter: _money2(dueTotal - value) });
    });

    if (req.method === 'GET' && action === 'sale-return-list') {
      const today = bdtToday();
      let from = DATE_RE_.test(req.query.from || '') ? req.query.from : today;
      let to = DATE_RE_.test(req.query.to || '') ? req.query.to : from;
      if (to < from) { const t = from; from = to; to = t; }
      const dsrId = String(req.query.dsrId || '');
      const rows = await fetchAll(() => {
        let q = supabase.from('transactions')
          .select('tx_id,sr_id,sr_name,date,shop_id,product_name,cases,pcs,total_units,total_revenue,created_at,note')
          .eq('type', 'dsr_sale_return').gte('date', from).lte('date', to).order('created_at', { ascending: false });
        if (dsrId && dsrId !== 'all') q = q.eq('sr_id', dsrId);
        return q;
      });
      const sids = [...new Set(rows.map(r => String(r.shop_id || '')).filter(Boolean))];
      const names = {};
      for (let i = 0; i < sids.length; i += 80) {
        const { data } = await supabase.from('shops').select('id,name,phone').in('id', sids.slice(i, i + 80));
        (data || []).forEach(r => { names[String(r.id)] = { name: r.name || '', phone: r.phone || '' }; });
      }
      const g = {};
      rows.forEach(r => {
        const k = String(r.tx_id);
        const o = g[k] || (g[k] = { txId: k, date: _d10(r.date), createdAt: r.created_at || '', dsrName: r.sr_name || '', shopId: String(r.shop_id || ''),
          shopName: (names[String(r.shop_id || '')] || {}).name || '', shopPhone: (names[String(r.shop_id || '')] || {}).phone || '', total: 0, units: 0, items: [] });
        o.total += num(r.total_revenue); o.units += num(r.total_units);
        o.items.push({ productName: r.product_name || '', cases: num(r.cases), pcs: num(r.pcs), units: num(r.total_units), value: _money2(r.total_revenue) });
      });
      const slips = Object.values(g).map(o => ({ ...o, total: _money2(o.total) })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return res.json({ ok: true, from, to, total: _money2(slips.reduce((a, o) => a + o.total, 0)), slips });
    }

    // ══════════════════════════════════════════════════
    //  DETAIL — full shop profile: due history + sales history
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'detail') {
      const { shopId } = req.query;
      if (!shopId) return res.json({ ok: false, error: 'shopId প্রয়োজন' });
      const { data: shopRow, error: shopErr } = await supabase.from('shops').select(SHOP_COLS).eq('id', shopId).single();
      if (shopErr) throw shopErr;
      if (!shopRow) return res.json({ ok: false, error: 'দোকান পাওয়া যায়নি' });

      const [dueRes, txRows] = await Promise.all([
        supabase.from('due_calendar').select(DUE_COLS_).eq('shop_id', shopId).order('due_date', { ascending: false }),
        (async () => { const _oc = await offerLib.selCols(); return fetchAll(() => supabase.from('transactions').select(TX_COLS_ + _oc).eq('shop_id', shopId).order('created_at', { ascending: false })); })()
      ]);
      const dues  = (dueRes.data || []).map(mapDue);
      const sales = (await offerLib.hydrate(txRows || [])).map(mapTx);
      const totalDue = dues.filter(d => d.status !== 'cleared').reduce((s, d) => s + (num(d.amount) - num(d.paidAmount)), 0);

      return res.json({ ok: true, shop: mapShop(shopRow), dues, sales, totalDue });
    }

    // ══════════════════════════════════════════════════
    //  VISIT-SALE — DSR sells to a shop: due reminder already shown
    //  client-side from `detail`; this records the sale + payment split
    //
    //  LOGIC FIX (V31): this sale is made from stock the DSR ALREADY
    //  physically took from the warehouse (a 'give' transaction already
    //  deducted it from company stock, and already registered the full
    //  value against the DSR's own due at that moment). So this row must
    //  NOT touch stock again — it is recorded as its own type ('dsr_sale')
    //  which calcStock() deliberately does not subtract, unlike
    //  'point_sale' (a true walk-in/counter sale straight out of the
    //  warehouse, which correctly still deducts stock). It also must NOT
    //  reduce the DSR's own due — per business rule, the DSR's due only
    //  goes down when he actually hands over cash (sr_payments) or
    //  physically returns unsold stock ('return'); a credit sale to a shop
    //  just moves the "who owes it" bookkeeping into due_calendar
    //  (client_type='shop') for visibility, while the amount stays under
    //  the DSR's name until collected/handed over.
    // ══════════════════════════════════════════════════
    if (req.method === 'POST' && action === 'visit-sale') return idemRun(req, res, 'visit-sale', async () => {
      const d = req.body || {};
      if (!d.shopId || !d.dsrId) return res.json({ ok: false, error: 'shopId ও dsrId প্রয়োজন' });
      const items = Array.isArray(d.items) ? d.items : [];
      if (!items.length) return res.json({ ok: false, error: 'অন্তত একটি পণ্য প্রয়োজন' });

      const txId = randomUUID();
      // CALC-4 — the sale date is the Asia/Dhaka calendar day (never the UTC date)
      const date = (d.date && DATE_RE_.test(d.date)) ? d.date : bdtToday();

      // CALC-5 / CALC-6 — prices come from the products table; every line is
      // rounded to 2 decimals (whole cases at the case price).
      const priced = await priceItems(items, { type: 'dsr_sale' });
      if (!priced.ok) return res.json({ ok: false, error: priced.error });
      const lines = priced.lines;
      // v5.25 — company-offer deduction (only when the product has an offer and date >= start date)
      const offerTotal = offerLib.applyOffers(lines, { date, start: await offerLib.getStartDate() });

      // v4.8.0 — a DSR can never sell more than is on his van. v5.1: the van
      // stock now CARRIES OVER from earlier days (CALC-2), so stock left
      // from yesterday can still be sold today.
      {
        const want = {}, names = {};
        lines.forEach(l => { want[l.productId] = (want[l.productId] || 0) + l.units; names[l.productId] = l.productName || 'পণ্য'; });
        const van = await computeVanStock(String(d.dsrId), date, { damage: 'cleared' });
        for (const pid of Object.keys(want)) {
          const have = num(van[pid]);
          if (want[pid] > have + 0.0001)
            return res.json({ ok: false, error: names[pid] + ' — গাড়িতে আছে মাত্র ' + have + ' পিস, কিন্তু ' + want[pid] + ' পিস বিক্রি করতে চাইছেন। গাড়ির স্টকের বেশি বিক্রি করা যাবে না।' });
        }
      }

      const ts = now_();
      const rows = lines.map(l => txRow(l, {
        tx_id: txId, type: 'dsr_sale',
        sr_id: String(d.dsrId), sr_name: d.dsrName || '',
        date, slip_no: d.slipNo || '',
        // V35 — persist this item's own commission/discount (per-case
        // rate × cases sold) so the DSR Payment page can total them.
        commission_amt: _money2(l.commission), discount_amt: _money2(l.discount),
        shop_id: String(d.shopId), note: d.note || '', created_at: ts
      }));
      // The bill's grand totals also include any flat invoice-level discount
      // that isn't tied to one product line. Reconcile the gap onto the first
      // row so the sum across the sale's rows equals the bill's exact amounts.
      if (rows.length) {
        const itemCommSum = rows.reduce((s, r) => s + num(r.commission_amt), 0);
        const itemDiscSum = rows.reduce((s, r) => s + num(r.discount_amt), 0);
        const extraComm = _money2(num(d.commissionAmt || 0) - itemCommSum);
        const extraDisc = _money2(num(d.discountAmt || 0) - itemDiscSum);
        rows[0].commission_amt = _money2(num(rows[0].commission_amt) + extraComm);
        rows[0].discount_amt   = _money2(num(rows[0].discount_amt) + extraDisc);
      }

      const payable  = _money2(rows.reduce((s, r) => s + num(r.total_revenue), 0) - offerTotal - num(d.discountAmt || 0) - num(d.commissionAmt || 0));
      const paidNow  = _money2(num(d.paidAmount));
      const shortfall = _money2(payable - paidNow);

      // §12 — every shop visit leaves a due_calendar trace: a shortfall opens
      // a pending entry; a fully paid visit writes an already-cleared row so
      // the shop's history is complete.
      let dueRowIn = null;
      if (payable > 0) {
        const { data: shopRow } = await supabase.from('shops').select('name').eq('id', d.shopId).single();
        const isCleared = shortfall <= 0.009;
        dueRowIn = {
          id: randomUUID(), tx_id: txId, dsr_id: String(d.dsrId), dsr_name: d.dsrName || '',
          client_type: 'shop', shop_id: String(d.shopId), shop_name: shopRow ? shopRow.name : '',
          due_date: date, amount: payable, paid_amount: isCleared ? payable : Math.max(0, Math.min(payable, paidNow)),
          note: 'দোকান বিক্রয়' + (isCleared ? ' (সম্পূর্ণ পরিশোধিত)' : ' বাকি'),
          status: isCleared ? 'cleared' : (paidNow > 0 ? 'partial' : 'pending'),
          cleared_date: isCleared ? date : null,
          created_at: ts
        };
        // keep the old behaviour: a sale with some cash down starts as 'pending'
        if (!isCleared) dueRowIn.status = 'pending';
      }
      const visitIn = { shop_id: String(d.shopId), visit_role: 'dsr', visitor_id: String(d.dsrId), visitor_name: d.dsrName || '', visit_date: date, created_at: ts };

      // CALC-7 — sale rows + due row + visit are written in ONE database
      // transaction (SQL function create_shop_sale): either all of it
      // exists or none of it. Falls back to a compensating cleanup if the
      // function is not installed yet.
      let due = null;
      let rpcDone = false;
      {
        const { data, error } = await supabase.rpc('create_shop_sale', { p_rows: rows, p_due: dueRowIn, p_visit: visitIn });
        if (!error) { rpcDone = true; due = data ? mapDue(data) : null; }
        else if (!/create_shop_sale|PGRST202|42883|schema cache/i.test(String(error.code || '') + ' ' + String(error.message || ''))) throw error;
      }
      if (!rpcDone) {
        const { error: txErr } = await supabase.from('transactions').insert(rows);
        if (txErr) throw txErr;
        if (dueRowIn) {
          const { data: dueRow, error: dueErr } = await supabase.from('due_calendar').insert(dueRowIn).select().single();
          if (dueErr) { await supabase.from('transactions').delete().eq('tx_id', txId); throw dueErr; }
          due = mapDue(dueRow);
        }
        try { await supabase.from('shop_visits').insert(visitIn); } catch (ve) { /* non-fatal */ }
      }

      if (offerTotal > 0) await offerLib.persist(txId, lines);
      return res.json({ ok: true, payable, paidNow, shortfall: Math.max(0, shortfall), due, offerTotal, offerLines: lines.filter(l => l.offer).map(l => ({ productId: l.productId, perCase: l.offer.perCase, total: l.offer.total })) });
    });

    // ══════════════════════════════════════════════════
    //  MAP — DAILY VISIT TRACKING (Update #26)
    //  visit-log: the SO taps "visited" on a shop from their road view
    //  (SOs don't carry stock, so there's no sale to auto-log from).
    //  visit-log-list: today's ticks for the map — colour-coded so/dsr.
    //  No cleanup job needed for the "auto-reset at midnight" rule: every
    //  read below is filtered to a single calendar date, so yesterday's
    //  ticks simply stop matching once the date rolls over on its own.
    // ══════════════════════════════════════════════════
    if (req.method === 'POST' && action === 'visit-log') {
      const d = req.body;
      if (!d.shopId || !d.role) return res.json({ ok: false, error: 'shopId ও role প্রয়োজন' });
      if (d.role !== 'so' && d.role !== 'dsr') return res.json({ ok: false, error: 'role শুধু so অথবা dsr হতে পারে' });
      const date = d.date || bdtToday();
      const { data, error } = await supabase.from('shop_visits').insert({
        shop_id: String(d.shopId), visit_role: d.role,
        visitor_id: String(d.visitorId || ''), visitor_name: d.visitorName || '',
        visit_date: date, created_at: now_()
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, visit: mapShopVisit(data) });
    }

    if (req.method === 'GET' && action === 'visit-log-list') {
      const { date, roadId } = req.query;
      const d = date || bdtToday();
      // Today's visits are few; filter by road in memory instead of putting
      // every shop id of the road into one giant `.in()` URL.
      const data = await fetchAll(() => supabase.from('shop_visits').select('*').eq('visit_date', d));
      let visitRows = data || [];
      if (roadId) {
        const roadShops = await fetchAll(() => supabase.from('shops').select('id').eq('road_id', roadId));
        const set = new Set((roadShops || []).map(s => String(s.id)));
        visitRows = visitRows.filter(v => set.has(String(v.shop_id)));
      }
      return res.json({ ok: true, visits: visitRows.map(mapShopVisit) });
    }

    // ══════════════════════════════════════════════════
    //  CLEAR-PLATE — today's outstanding shop dues for one DSR
    //  (AXIION §12 — the "Clear Plate" system)
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'clear-plate') {
      const { dsrId } = req.query;
      if (!dsrId) return res.json({ ok: false, error: 'dsrId প্রয়োজন' });
      // §12 (merged শপ ডেলিভারি) — the plate is a rolling 12-hour window
      // from when each due was created, NOT the calendar day. This way a
      // DSR who visits shops across midnight (or just runs long) doesn't
      // lose or duplicate entries at the day boundary, and the entry
      // simply disappears from THIS list on its own 12h later — the
      // underlying due_calendar row is never deleted, only this view.
      const windowStart = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase.from('due_calendar')
        .select('*')
        .eq('client_type', 'shop').eq('dsr_id', dsrId)
        .gte('created_at', windowStart)
        .in('status', ['pending', 'partial'])
        .order('created_at');
      if (error) throw error;
      let plate = (data || []).map(mapDue);

      // Attach each shop's phone number so the DSR can tap-to-call
      // straight from the plate before/while collecting (§20 spirit).
      if (plate.length) {
        const shopIds = [...new Set(plate.map(p => p.shopId).filter(Boolean))];
        if (shopIds.length) {
          const { data: shopRows, error: shopErr } = await supabase
            .from('shops').select('id,phone').in('id', shopIds);
          if (shopErr) throw shopErr;
          const phoneMap = {};
          (shopRows || []).forEach(s => { phoneMap[String(s.id)] = s.phone || ''; });
          plate = plate.map(p => ({ ...p, shopPhone: phoneMap[p.shopId] || '' }));
        }
      }

      const totalAmount = plate.reduce((s, p) => s + (num(p.amount) - num(p.paidAmount)), 0);
      return res.json({ ok: true, plate, totalAmount, shopCount: plate.length });
    }

    // ══════════════════════════════════════════════════
    //  CLEAR-PLATE-ALL — company-wide today's outstanding shop dues,
    //  grouped by DSR (Owner/Manager overview of the §12 Clear Plate)
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'clear-plate-all') {
      // Same rolling 12-hour window as the per-DSR plate above, kept
      // consistent so the Owner/Manager overview always matches what
      // each DSR currently sees on their own plate.
      const windowStart = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase.from('due_calendar')
        .select('*')
        .eq('client_type', 'shop')
        .gte('created_at', windowStart)
        .in('status', ['pending', 'partial'])
        .order('dsr_name');
      if (error) throw error;
      const rows = (data || []).map(mapDue);

      const byDsr = {};
      rows.forEach(r => {
        const key = r.dsrId || '—';
        if (!byDsr[key]) byDsr[key] = { dsrId: r.dsrId, dsrName: r.dsrName || 'অজানা', shopCount: 0, totalAmount: 0, items: [] };
        const rem = num(r.amount) - num(r.paidAmount);
        byDsr[key].shopCount += 1;
        byDsr[key].totalAmount += rem;
        byDsr[key].items.push(r);
      });
      const dsrs = Object.values(byDsr).sort((a, b) => b.totalAmount - a.totalAmount);
      const totalAmount = dsrs.reduce((s, x) => s + x.totalAmount, 0);
      const shopCount   = dsrs.reduce((s, x) => s + x.shopCount, 0);
      return res.json({ ok: true, dsrs, totalAmount, shopCount });
    }

    // ══════════════════════════════════════════════════
    //  Update #52 — POINT-SALE CUSTOMER SEARCH
    //  GET /api/shops?action=pos-customer-search&q=<text>
    //  Searches both registered shops (§11) and pos_customers (§51) by
    //  name/phone, merged into one result list, so a repeat point-sale
    //  customer (sale OR damage/return, per Update #53) can be found and
    //  auto-filled instead of retyping their details every visit. Each
    //  result carries shopId or customerId (never both) so the caller
    //  can pass the right hint straight back into pos-customer-save.
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'pos-customer-search') {
      const q = str(req.query.q, 100).trim();
      if (q.length < 2) return res.json({ ok: true, results: [] });
      const like = '%' + q.replace(/[%_,()]/g, ' ').trim() + '%';

      const [{ data: shopRows, error: shopErr }, { data: custRows, error: custErr }] = await Promise.all([
        supabase.from('shops').select('id,name,keeper_name,phone,address')
          .or(`name.ilike.${like},phone.ilike.${like}`).limit(10),
        supabase.from('pos_customers').select('id,name,keeper_name,phone,address')
          .or(`name.ilike.${like},phone.ilike.${like}`).limit(10)
      ]);
      if (shopErr) throw shopErr;
      if (custErr) throw custErr;

      const results = [
        ...(shopRows || []).map(r => ({
          source: 'shop', shopId: String(r.id), customerId: '',
          name: r.name || '', keeperName: r.keeper_name || '', phone: r.phone || '', address: r.address || ''
        })),
        ...(custRows || []).map(r => ({
          source: 'customer', shopId: '', customerId: String(r.id),
          name: r.name || '', keeperName: r.keeper_name || '', phone: r.phone || '', address: r.address || ''
        }))
      ].slice(0, 15);

      return res.json({ ok: true, results });
    }

    // ══════════════════════════════════════════════════
    //  Update #51 — POINT-SALE CUSTOMER CAPTURE
    //  Full customer details (shop name, phone, address, keeper name —
    //  the same basic fields as normal shop registration), stored as a
    //  proper record instead of a bare free-text name. Called by the
    //  Point-Sale wizard right before the actual sale transaction is
    //  saved; returns whichever id (an existing registered shop, or a
    //  pos_customers record) the transaction should be tagged with.
    //  Update #53 — the same endpoint is now also called by the
    //  point-sale damage/return sub-flow, so those rows get a real
    //  shop_id/customer_id too instead of only a free-text name.
    // ══════════════════════════════════════════════════
    if (req.method === 'POST' && action === 'pos-customer-save') {
      const d = req.body;
      const name = str(d.name, 200);
      if (!name) return res.json({ ok: false, error: 'কাস্টমারের/দোকানের নাম আবশ্যক' });
      const phone      = str(d.phone, 30);
      const address    = str(d.address, 300);
      const keeperName = str(d.keeperName, 200);

      // Update #52 — if the customer was picked from the search
      // dropdown, reuse that exact record instead of re-matching by
      // phone, so editing a phone-less repeat customer's details on a
      // later visit updates the same row instead of creating a
      // duplicate.
      const selShopId = str(d.selectedShopId, 60);
      const selCustId = str(d.selectedCustomerId, 60);
      if (selShopId) {
        const { data: shopRow, error: shopErr } = await supabase.from('shops').select('id,name').eq('id', selShopId).limit(1);
        if (shopErr) throw shopErr;
        if (shopRow && shopRow.length) return res.json({ ok: true, shopId: shopRow[0].id, shopName: shopRow[0].name, customerId: '' });
      }
      if (selCustId) {
        const { data: custRow, error: updErr } = await supabase.from('pos_customers').update({
          name, keeper_name: keeperName, phone, address
        }).eq('id', selCustId).select('id').limit(1);
        if (updErr) throw updErr;
        if (custRow && custRow.length) return res.json({ ok: true, shopId: '', customerId: custRow[0].id, customerName: name });
      }

      // 1) A phone that matches an existing REGISTERED SHOP wins first —
      //    reuse that shop's real record/history instead of creating a
      //    parallel customer record for the same real-world shop.
      if (phone) {
        const { data: shopMatch } = await supabase.from('shops').select('id,name').eq('phone', phone).limit(1);
        if (shopMatch && shopMatch.length) {
          return res.json({ ok: true, shopId: shopMatch[0].id, shopName: shopMatch[0].name, customerId: '' });
        }
      }

      // 2) A phone that matches an existing pos_customers record →
      //    update it in place (repeat walk-in customer) instead of
      //    growing a duplicate row every visit.
      if (phone) {
        const { data: custMatch } = await supabase.from('pos_customers').select('id').eq('phone', phone).limit(1);
        if (custMatch && custMatch.length) {
          const { error: updErr } = await supabase.from('pos_customers').update({
            name, keeper_name: keeperName, address
          }).eq('id', custMatch[0].id);
          if (updErr) throw updErr;
          return res.json({ ok: true, shopId: '', customerId: custMatch[0].id, customerName: name });
        }
      }

      // 3) No match (or no phone at all) → brand-new customer record.
      const { data: inserted, error: insErr } = await supabase.from('pos_customers').insert({
        name, keeper_name: keeperName, phone, address
      }).select('id').single();
      if (insErr) throw insErr;
      return res.json({ ok: true, shopId: '', customerId: inserted.id, customerName: name });
    }

    // ══════════════════════════════════════════════════
    //  POINT-SALE — walk-in / phone-number counter sale
    // ══════════════════════════════════════════════════
    if (req.method === 'POST' && action === 'point-sale') return idemRun(req, res, 'point-sale', async () => {
      const d = req.body || {};
      const items = Array.isArray(d.items) ? d.items : [];
      if (!items.length) return res.json({ ok: false, error: 'অন্তত একটি পণ্য প্রয়োজন' });

      // Look up an existing shop by phone number first (reuse §11 registry)
      let shopId = '', shopName = d.customerName || '';
      if (d.phone) {
        const { data: match } = await supabase.from('shops').select('id,name').eq('phone', String(d.phone)).limit(1);
        if (match && match.length) { shopId = match[0].id; shopName = match[0].name; }
      }

      const priced = await priceItems(items, { type: 'point_sale' });
      if (!priced.ok) return res.json({ ok: false, error: priced.error });
      const _psDate = (d.date && DATE_RE_.test(d.date)) ? d.date : bdtToday();
      const offerTotal = offerLib.applyOffers(priced.lines, { date: _psDate, start: await offerLib.getStartDate() });   // v5.25
      // CALC-9 — a counter sale cannot sell stock the warehouse does not have
      if (await blockNegativeStock()) {
        const msg = stockShortage(priced.lines);
        if (msg) return res.json({ ok: false, error: msg });
      }

      const txId = randomUUID();
      const date = (d.date && DATE_RE_.test(d.date)) ? d.date : bdtToday();   // CALC-4
      const ts = now_();
      const rows = priced.lines.map(l => txRow(l, {
        tx_id: txId, type: 'point_sale',
        sr_id: String(d.handledBy || ''), sr_name: d.handledByName || '',
        date, slip_no: d.slipNo || '',
        shop_id: shopId, note: shopName ? ('গ্রাহক: ' + shopName) : (d.note || ''),
        created_at: ts
      }));
      const { error } = await supabase.from('transactions').insert(rows);
      if (error) throw error;
      if (offerTotal > 0) await offerLib.persist(txId, priced.lines);
      return res.json({ ok: true, offerTotal, matchedShop: shopId ? { id: shopId, name: shopName } : null });
    });

    res.status(405).json({ ok: false, error: 'Method not allowed অথবা ভুল action' });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};
