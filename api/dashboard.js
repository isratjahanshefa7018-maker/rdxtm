const {
  supabase, cors, num, ds,
  mapProduct, mapSR, mapTx, mapPayment,
  mapRoad, mapRoadPlan, mapRoadWeeklyPlan, bdtToday, bdtYesterday, weekdayOf, addDaysStr,
  safeErr, fetchAll, cyclePeriodForDate, cyclePeriodBounds, getDueTotals,
  computeProfit, computeBonusRangeSummary, getSrSalesTotals, getProductNetUnits, getPaymentsTotal, getStockMovement,
  cpGroups, getCaseTotals, cpSplit, withUnits
} = require('./_lib/db');
const offerLedger = require('./_lib/offerLedger');

// PERF-5 — only the columns the screens read
const TX_FULL = 'id,tx_id,type,sr_id,sr_name,date,slip_no,product_id,product_name,sku,cases,pcs,total_units,purchase_price,selling_price,total_cost,total_revenue,commission_amt,discount_amt,shop_id,customer_id,note,created_at';
const TX_LITE = 'id,type,sr_id,date,product_id,product_name,total_units,total_revenue,total_cost,created_at';
const PAY_COLS = 'id,sr_id,sr_name,date,amount,cash_amount,commission_amt,discount_amt,damage_amt,note,created_at';

// V41 update 7 — every "this month" figure on the dashboard is scoped to
// the company pay cycle (26th of previous month → 25th of current month),
// not the plain calendar month. See cyclePeriodBounds in _lib/db.js.
function _cycleMonthStart(todayStr) {
  return cyclePeriodBounds(cyclePeriodForDate(todayStr)).start;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const { role, userId, action } = req.query;

    // ══════════════════════════════════════════════════════
    //  APP-BOOT LOAD-ALL — merged in from the old load-all.js
    //  (AXIION Blueprint §3 — load-all.js folded into dashboard.js)
    // ══════════════════════════════════════════════════════
    if (action === 'load-all') {
      const [pRes, sRes, rRes, setRes] = await Promise.all([
        supabase.from('products').select('*').order('sort_order').order('created_at'),
        supabase.from('srs').select('*').order('created_at'),
        supabase.from('roads').select('*').order('created_at'),
        // V58/V59 — the owner's own business identity (name, address,
        // phone, distributor line, logo initials) for printed documents,
        // fetched once at boot alongside everything else so every screen
        // that prints something already has it cached in S.shopName etc.
        supabase.from('app_settings').select('shop_name, shop_address, shop_phone, distributor_name, logo_text').eq('id', 1).maybeSingle()
      ]);
      const products = (pRes.data || []).map(mapProduct);
      const srsAll   = (sRes.data || []).map(mapSR);
      const roads    = (rRes.data || []).map(mapRoad);
      const shopName        = (setRes.data && setRes.data.shop_name)        || '';
      const shopAddress     = (setRes.data && setRes.data.shop_address)     || '';
      const shopPhone       = (setRes.data && setRes.data.shop_phone)       || '';
      const distributorName = (setRes.data && setRes.data.distributor_name) || '';
      const logoText        = (setRes.data && setRes.data.logo_text)        || '';
      // V40: stock comes straight from products.current_stock (kept in
      // sync by a DB trigger on every transaction insert) instead of
      // re-fetching + re-summing the ENTIRE lifetime transactions table
      // on every app boot — that old pattern got linearly more expensive
      // in Supabase egress as the table grew year over year. See
      // migration_v40_stock_balance.sql.
      const stockMap = {};
      products.forEach(p => { stockMap[p.id] = p.currentStock; });
      return res.json({ ok: true, products, srs: srsAll, roads, stockMap, shopName, shopAddress, shopPhone, distributorName, logoText });
    }

    // ══════════════════════════════════════════════════════
    //  v60 — SR-PERF: DSR / SO performance for the home-screen tracker.
    //  Lives on this existing route (never a 13th api/*.js file).
    //  GET /api/dashboard?action=sr-perf[&period=YYYY-MM]
    //  Per person, for the pay-cycle: achieved = net sales (give − return),
    //  target = SO's own target; a DSR's target is his paired SO's target
    //  split evenly across that SO's DSRs (a DSR has no target row of his
    //  own — see attendance.js target-set). Also returns the share of the
    //  company total so the UI can compare people against each other.
    // ══════════════════════════════════════════════════════
    if (action === 'sr-perf') {
      const period = /^\d{4}-\d{2}$/.test(req.query.period || '') ? req.query.period : cyclePeriodForDate(bdtToday());
      const { start, end } = cyclePeriodBounds(period);
      const [srRes, tgRes, totals] = await Promise.all([
        supabase.from('srs').select('id,name,role,so_id,so_name,thumb,area,display_no').in('role', ['dsr', 'so']),
        supabase.from('targets').select('user_key,target_amount,target_boxes').eq('period', period),
        getSrSalesTotals(start, end)       // PERF-3: summed in Postgres
      ]);
      // v5.16 — same box maths as the SO target page, so a DSR's % and his SO's % are measured the same way
      let _st = { bySo: {}, byId: {} };
      try { _st = await require('./attendance')._targetStats(period); } catch (e) {}
      if (srRes.error) throw srRes.error;
      const people = srRes.data || [];
      const tMap = {}, tBox = {};
      (tgRes.data || []).forEach(t => { tMap[String(t.user_key)] = num(t.target_amount); tBox[String(t.user_key)] = num(t.target_boxes); });

      const own = {};   // sr_id → { rev, units }
      Object.keys(totals).forEach(id => {
        const t = totals[id];
        own[id] = { rev: t.outRev - t.inRev, units: t.outUnits - t.inUnits };
      });

      const dsrsBySo = {};
      people.filter(p => p.role === 'dsr').forEach(d => {
        const k = String(d.so_id || ''); if (!k) return;
        (dsrsBySo[k] = dsrsBySo[k] || []).push(d);
      });

      const list = people.map(p => {
        const id = String(p.id);
        let achieved, target;
        if (p.role === 'so') {
          achieved = (own[id] ? own[id].rev : 0) + (dsrsBySo[id] || []).reduce((s, d) => s + (own[String(d.id)] ? own[String(d.id)].rev : 0), 0);
          target = tMap[id] || 0;
        } else {
          achieved = own[id] ? own[id].rev : 0;
          const soKey = String(p.so_id || '');
          const n = (dsrsBySo[soKey] || []).length || 1;
          target = soKey ? (tMap[soKey] || 0) / n : 0;
        }
        achieved = Math.round(achieved * 100) / 100;
        target = Math.round(target * 100) / 100;
        // boxes (the company's real measure) — SO: own + his DSRs · DSR: own, against his share of the SO box target
        let boxA, boxT;
        if (p.role === 'so') { boxA = (_st.bySo[id] || {}).boxes || 0; boxT = tBox[id] || 0; }
        else { boxA = (_st.byId[id] || {}).boxes || 0; const sk = String(p.so_id || ''); const n2 = (dsrsBySo[sk] || []).length || 1; boxT = sk ? (tBox[sk] || 0) / n2 : 0; }
        boxA = Math.round(boxA * 100) / 100; boxT = Math.round(boxT * 100) / 100;
        const pctMoney = target > 0 ? Math.round((achieved / target) * 1000) / 10 : null;
        const pctBoxes = boxT > 0 ? Math.round((boxA / boxT) * 1000) / 10 : null;
        return {
          achievedBoxes: boxA, targetBoxes: boxT, pctBoxes, pctMoney, basis: boxT > 0 ? 'boxes' : 'money',
          srId: id, name: p.name || '', role: p.role, area: p.area || '', thumb: p.thumb || '',
          displayNo: p.display_no, soName: p.so_name || '', soId: String(p.so_id || ''),
          units: own[id] ? own[id].units : 0,
          achieved, target,
          pct: boxT > 0 ? pctBoxes : pctMoney,   // same primary basis as the SO's own % on the target page
          remaining: Math.max(0, target - achieved)
        };
      });

      const rank = role => {
        const rows = list.filter(x => x.role === role).sort((a, b) => b.achieved - a.achieved);
        const total = rows.reduce((s, x) => s + Math.max(0, x.achieved), 0);
        rows.forEach((x, i) => { x.rank = i + 1; x.share = total > 0 ? Math.round((Math.max(0, x.achieved) / total) * 1000) / 10 : 0; });
        return { rows, total };
      };
      const d = rank('dsr'), so = rank('so');
      return res.json({ ok: true, period, dsr: d.rows, so: so.rows, totals: { dsr: d.total, so: so.total } });
    }

    // ══════════════════════════════════════════════════════
    //  SALES-RANGE — the hero "আজ বিক্রি" card's small range picker
    //  (আজ/৭ দিন/এই মাস/এই বছর/কাস্টম). Kept as its own lightweight
    //  action on the existing dashboard.js route (never a 13th api/*.js
    //  file — see SETUP.md §5 on the Vercel Hobby 12-function cap) so
    //  the Owner dashboard can re-query just the sales/profit figures
    //  for an arbitrary window without re-loading the whole dashboard.
    //  GET /api/dashboard?action=sales-range&range=today|7d|30d|month|year|custom&from=&to=
    // ══════════════════════════════════════════════════════
    if (action === 'sales-range') {
      const today = bdtToday();
      const range = String(req.query.range || 'today');
      let from = today, to = today, label = 'আজ';
      if (range === '7d') {
        from = addDaysStr(today, -6); label = 'গত ৭ দিন';
      } else if (range === '30d') {
        from = addDaysStr(today, -29); label = 'গত ৩০ দিন';
      } else if (range === 'month') {
        from = _cycleMonthStart(today); label = 'এই মাস';
      } else if (range === 'year') {
        from = today.slice(0, 4) + '-01-01'; label = 'এই বছর';
      } else if (range === 'custom') {
        from = String(req.query.from || today).slice(0, 10);
        to   = String(req.query.to   || today).slice(0, 10);
        label = 'কাস্টম';
      }
      if (from > to) { const t = from; from = to; to = t; } // guard against a swapped custom range

      // CALC-1 — ONE profit definition for every screen (see computeProfit in _lib/db.js).
      // `profit` is now the NET profit; the full breakdown rides along.
      const _okP = await offerLedger.profitAllowed(req.query);
      const P = await computeProfit(from, to);
      const out = {
        ok: true, range, label, from, to,
        revenue: P.revenue, givenUnits: P.givenUnits, returnUnits: P.returnUnits
      };
      // v5.27 — profit / offer data only for a verified owner or manager (DSR / SO never get it)
      if (_okP) Object.assign(out, {
        profit: P.netProfit, netProfit: P.netProfit, grossProfit: P.grossProfit,
        commission: P.commission, discount: P.discount, damageLoss: P.damageLoss, bonus: P.bonus, expenses: P.expenses,
        profitRules: P.rules, breakdown: P
      });
      return res.json(out);
    }

    // ══════════════════════════════════════════════════════
    //  v5.7 — SALES PANEL  (owner · manager · DSR · SO)
    //  GET /api/dashboard?action=sales-panel&scope=so&soId=<id>   one SO's sale (bonus pieces removed)
    //  GET /api/dashboard?action=sales-panel&scope=total          whole shop's sale (free/bonus pieces INCLUDED)
    //  Every product is listed in the same order as the product/inventory page (sort_order);
    //  a product that was not sold shows 0. Columns: stock before the day · that day's sale · stock after.
    //  v5.11 — &date=YYYY-MM-DD shows any PAST day (back dates) for every role; omitted = today.
    //  Stock for a past day is rebuilt from today's stock minus every movement after that day.
    // ══════════════════════════════════════════════════════
    if (action === 'sales-panel') {
      const realToday = bdtToday();
      const _dq = String(req.query.date || '');
      const today = (/^\d{4}-\d{2}-\d{2}$/.test(_dq) && _dq <= realToday) ? _dq : realToday;   // "today" below = the day being viewed
      const isToday = today === realToday;
      if (!isToday && (Date.parse(realToday) - Date.parse(today)) / 86400000 > 366) return res.json({ ok: false, error: 'সর্বোচ্চ ১ বছর আগের তারিখ দেখা যায়' });
      const _sc = String(req.query.scope || 'so'), scope = (_sc === 'total' || _sc === 'dsr') ? _sc : 'so';   // v5.13: 'dsr' = one DSR's own sale
      const [pRes, sRes] = await Promise.all([
        supabase.from('products').select('*').order('sort_order').order('created_at'),
        supabase.from('srs').select('*').order('created_at')
      ]);
      if (pRes.error) throw pRes.error; if (sRes.error) throw sRes.error;
      const products = (pRes.data || []).map(mapProduct);
      const staff = (sRes.data || []).map(mapSR);
      const soList = staff.filter(x => x.role === 'so').map(x => ({ id: x.id, name: x.name }));
      const dsrList = staff.filter(x => (x.role || 'dsr') === 'dsr').map(x => ({ id: x.id, name: x.name, soId: String(x.soId || '') }));

      let soId = String(req.query.soId || '');
      if (scope === 'so' && !soId && role === 'so') soId = String(userId || '');
      if (scope === 'so' && !soId && soList.length) soId = soList[0].id;

      let ids = null, dsrIds = [];
      if (scope === 'dsr') {
        const one = String(req.query.dsrId || '');
        if (!one) return res.json({ ok: false, error: 'DSR বাছাই করুন' });
        dsrIds = [one]; ids = [one]; soId = '';
      } else if (scope === 'so') {
        dsrIds = staff.filter(x => String(x.soId || '') === soId && x.role !== 'so').map(x => x.id);
        ids = [soId, ...dsrIds];
      }
      const rows = (await fetchAll(() => {
        let q = supabase.from('transactions').select(TX_LITE).eq('date', today).in('type', ['give', 'return', 'point_sale', 'point_damage_return']).order('created_at');
        if (ids) q = q.in('sr_id', ids);
        return q;
      })).map(mapTx);

      const net = {};
      rows.forEach(r => {
        const pid = String(r.productId || ''); if (!pid) return;
        if (scope === 'so' || scope === 'dsr') {
          const isDsrLeg  = dsrIds.indexOf(r.srId) !== -1 && (r.type === 'give' || r.type === 'return');
          const isSoPoint = ((soId && r.srId === soId) || dsrIds.indexOf(r.srId) !== -1) && (r.type === 'point_sale' || r.type === 'point_damage_return');   // v5.13: point sale is booked on a DSR
          if (!isDsrLeg && !isSoPoint) return;
        }
        net[pid] = (net[pid] || 0) + ((r.type === 'give' || r.type === 'point_sale') ? num(r.totalUnits) : -num(r.totalUnits));
      });

      // damage swapped for product (shown separately, same as the SO tab always did)
      const exchMap = {};
      {
        const exIds = scope !== 'total' ? dsrIds : null;
        if (!exIds || exIds.length) {
          const exRows = await fetchAll(() => {
            let q = supabase.from('damage_collections').select('exch_product_id,exch_units').eq('date', today).eq('resolution', 'exchange');
            if (exIds) q = q.in('dsr_id', exIds.map(String));
            return q;
          });
          (exRows || []).forEach(r => { const k = String(r.exch_product_id || ''); if (k) exchMap[k] = (exchMap[k] || 0) + num(r.exch_units); });
        }
      }
      let dayMove, afterMove = {};
      if (isToday) dayMove = await getStockMovement(today);
      else {
        // movements of the viewed day and of every later day (warehouse view: buy/return in, give/point sale out)
        const SIGN = { buy: 1, give: -1, return: 1, point_sale: -1, point_damage_return: 1, return_company: -1 };
        const mv = await fetchAll(() => supabase.from('transactions').select('product_id,type,total_units,date').gte('date', today).lte('date', realToday).in('type', Object.keys(SIGN)));
        dayMove = {};
        (mv || []).forEach(r => {
          const k = String(r.product_id || ''); if (!k) return;
          const v = SIGN[r.type] * num(r.total_units);
          if (String(r.date).slice(0, 10) === today) dayMove[k] = (dayMove[k] || 0) + v; else afterMove[k] = (afterMove[k] || 0) + v;
        });
      }

      const list = products.map(p => {
        const pid = String(p.id);
        const raw = Math.max(0, net[pid] || 0);
        let sold = raw, bonusPieces = 0;
        if (scope !== 'total') {
          const cs = num(p.caseSize) || 1, req_ = num(p.bonusCasesReq) || 1, free = num(p.bonusFreeUnits) || 0;
          bonusPieces = Math.floor(Math.floor(raw / cs) / req_) * free;
          sold = Math.max(0, raw - bonusPieces);
        }
        const exch = Math.min(exchMap[pid] || 0, sold);
        const cur = +(num(p.currentStock) - (afterMove[pid] || 0)).toFixed(4);   // stock at the END of the viewed day
        return {
          productId: p.id, productName: p.name || '', thumb: p.thumb || '', caseSize: num(p.caseSize) || 1, unitType: p.unitType || 'কেস',
          sold, bonusPieces, exchangeUnits: exch,
          prevStock: +(cur - (dayMove[pid] || 0)).toFixed(4), currentStock: cur
        };
      });
      return res.json({ ok: true, scope, soId, dsrId: scope === 'dsr' ? dsrIds[0] : '', sos: soList, dsrs: dsrList, date: today, isToday, list });
    }

    // ══════════════════════════════════════════════════════
    //  v5.7 — LOW-STOCK ALERT for every role
    //  GET /api/dashboard?action=low-stock
    // ══════════════════════════════════════════════════════
    if (action === 'low-stock') {
      const { data, error } = await supabase.from('products').select('*').order('sort_order').order('created_at');
      if (error) throw error;
      const list = (data || []).map(mapProduct)
        .filter(p => num(p.lowStockAlert) > 0 && num(p.currentStock) <= num(p.lowStockAlert))
        .map(p => ({ id: p.id, name: p.name, sku: p.sku, thumb: p.thumb || '', units: num(p.currentStock), alertAt: num(p.lowStockAlert), caseSize: num(p.caseSize) || 1, unitType: p.unitType || 'কেস' }));
      return res.json({ ok: true, list });
    }

    // ══════════════════════════════════════════════════════
    //  SO DASHBOARD — isolated to SO's own data + assigned DSRs
    // ══════════════════════════════════════════════════════
    if (role === 'so' && userId) {
      const today = bdtToday();
      const monthStart = _cycleMonthStart(today);
      // Optional custom date-range for full sales visibility (AXIION §17)
      const rangeFrom = req.query.from || '';
      const rangeTo   = req.query.to   || '';

      // Assigned DSRs for this SO
      const { data: dsrsData } = await supabase.from('srs').select('*').eq('so_id', userId).order('created_at');
      const assignedDsrs = (dsrsData || []).map(mapSR);
      const dsrIds = assignedDsrs.map(d => d.id);
      // All IDs: SO + their DSRs
      const allIds = [userId, ...dsrIds];

      // Products & stock (read-only, all products visible to SO)
      // V40: stock read straight from products.current_stock — see
      // migration_v40_stock_balance.sql — no more full transaction
      // history refetch on every SO dashboard load.
      const { data: prodData } = await supabase.from('products').select('*').order('sort_order').order('created_at');
      const products = (prodData || []).map(mapProduct);
      const stockMap = {};
      products.forEach(p => { stockMap[p.id] = p.currentStock; });

      // Transactions: SO + DSRs, today and this month
      // NOTE (pagination fix): "today" and "this month" are date-scoped,
      // not lifetime, but a busy shop can still push a MONTH'S worth of
      // transactions past PostgREST's silent 1000-row cap well before any
      // lifetime table does — that's what caused last month's numbers to
      // go quietly wrong. All three of these must go through fetchAll,
      // exactly like the lifetime "due calculation" query below already
      // does, or the cap will just as silently reappear.
      const txTodayFactory = () => {
        let q = supabase.from('transactions').select(TX_LITE).eq('date', today).order('created_at');
        if (allIds.length) q = q.in('sr_id', allIds);
        return q;
      };
      const txMonthFactory = () => {
        let q = supabase.from('transactions').select(TX_LITE).gte('date', monthStart).lte('date', today).order('created_at');
        if (allIds.length) q = q.in('sr_id', allIds);
        return q;
      };
      // Custom range query — only fired when both from/to are supplied
      const hasRange = !!(allIds.length && rangeFrom && rangeTo);
      const txRangeFactory = () => supabase.from('transactions').select(TX_LITE)
        .gte('date', rangeFrom).lte('date', rangeTo).in('sr_id', allIds).order('created_at');

      // Lifetime due is now computed by the shared getDueTotals() helper
      // (Postgres SUM — same numbers every panel shows). Only today /
      // month / range rows are still downloaded.
      const [txToday, txMonth, txRange, dueTotals] = await Promise.all([
        allIds.length ? fetchAll(txTodayFactory) : [],
        allIds.length ? fetchAll(txMonthFactory) : [],
        hasRange ? fetchAll(txRangeFactory) : [],
        getDueTotals(allIds)
      ]).then(([a, b, c, d]) => [a.map(mapTx), b.map(mapTx), c.map(mapTx), d]);

      // ── Full sales visibility, split regular (DSR-given) vs SO's own
      //    point-sale, for any date range (AXIION §17) ──────────────
      const _csSo = {};
      try { const { data: _pr } = await supabase.from('products').select('id,case_size,unit_type'); (_pr || []).forEach(p => { _csSo[String(p.id)] = num(p.case_size) || 1; }); withUnits(_csSo, _pr); } catch (_) { }
      function buildSalesSplit(txList) {
        const regular = txList.filter(r => dsrIds.indexOf(r.srId) !== -1 && (r.type === 'give' || r.type === 'return'));
        const point   = txList.filter(r => (r.srId === userId || dsrIds.indexOf(r.srId) !== -1) && (r.type === 'point_sale' || r.type === 'point_damage_return'));   // v5.13: point sale is booked on a DSR
        const regularRevenue = regular.filter(r => r.type === 'give').reduce((s, r) => s + num(r.totalRevenue), 0)
                              - regular.filter(r => r.type === 'return').reduce((s, r) => s + num(r.totalRevenue), 0);
        const pointRevenue   = point.filter(r => r.type === 'point_sale').reduce((s, r) => s + num(r.totalRevenue), 0)
                              - point.filter(r => r.type === 'point_damage_return').reduce((s, r) => s + num(r.totalRevenue), 0);
        const regularUnits   = regular.filter(r => r.type === 'give').reduce((s, r) => s + num(r.totalUnits), 0)
                              - regular.filter(r => r.type === 'return').reduce((s, r) => s + num(r.totalUnits), 0);
        const pointUnits     = point.filter(r => r.type === 'point_sale').reduce((s, r) => s + num(r.totalUnits), 0)
                              - point.filter(r => r.type === 'point_damage_return').reduce((s, r) => s + num(r.totalUnits), 0);
        // v5.4 — exact cases + pcs (net per product, then split by that product's case size)
        const net = (list, plus, minus) => { const m = {}; list.forEach(r => { const k = String(r.productId || ''); if (r.type === plus) m[k] = (m[k] || 0) + num(r.totalUnits); else if (r.type === minus) m[k] = (m[k] || 0) - num(r.totalUnits); }); return m; };
        const _rm = net(regular, 'give', 'return'), _pm = net(point, 'point_sale', 'point_damage_return'), _tm = Object.assign({}, _rm);
        Object.keys(_pm).forEach(k => { _tm[k] = (_tm[k] || 0) + _pm[k]; });
        return { regularRevenue, pointRevenue, regularUnits, pointUnits, regularCP: cpSplit(_rm, _csSo), pointCP: cpSplit(_pm, _csSo), totalCP: cpSplit(_tm, _csSo), totalRevenue: regularRevenue + pointRevenue };
      }
      const todaySplit = buildSalesSplit(txToday);
      const monthSplit = buildSalesSplit(txMonth);
      const rangeSplit = (rangeFrom && rangeTo) ? { from: rangeFrom, to: rangeTo, ...buildSalesSplit(txRange) } : null;

      // SO's own payments — fetchAll: a bare query is capped at 1000 rows.
      // PERF-1/3: only the newest 30 are listed, the lifetime total comes from
      // the shared Postgres SUM (dueTotals) — no download of the whole history.
      const { data: soPayData, error: soPayErr } = await supabase.from('sr_payments').select(PAY_COLS).eq('sr_id', userId)
        .order('date', { ascending: false }).order('created_at', { ascending: false }).limit(30);
      if (soPayErr) throw soPayErr;
      const soPayments = (soPayData || []).map(mapPayment);
      const soTotalPaid = (dueTotals[String(userId)] || { payments: 0 }).payments;

      // DSR month payments
      let dsrPayMonthData = { data: [] };
      if (dsrIds.length) {
        dsrPayMonthData = { data: await fetchAll(() => supabase.from('sr_payments').select('amount')
          .in('sr_id', dsrIds).gte('date', monthStart).lte('date', today).order('date')) };
      }
      const dsrPayMonth = (dsrPayMonthData.data || []).map(mapPayment);

      // SO own stats (point_sale only — direct sales by SO)
      const soTxToday = txToday.filter(r => r.srId === userId);
      const soTxMonth = txMonth.filter(r => r.srId === userId);
      const _own = dueTotals[String(userId)] || { givenRev: 0, returnRev: 0 };
      const soOwnDue = (_own.givenRev - _own.returnRev) - soTotalPaid;

      // DSR due map
      const dueMap = {};
      assignedDsrs.forEach(dsr => {
        const t = dueTotals[String(dsr.id)] || { givenRev: 0, returnRev: 0, payments: 0 };
        dueMap[dsr.id] = { srId: dsr.id, name: dsr.name, area: dsr.area || '', phone: dsr.phone || '', thumb: dsr.thumb || '', givenRev: t.givenRev, returnRev: t.returnRev, payments: t.payments };
      });
      const dsrDueList = Object.values(dueMap).map(d => ({ ...d, due: (d.givenRev - d.returnRev) - d.payments }));
      const totalDsrDue = dsrDueList.reduce((s, d) => s + (d.due > 0 ? d.due : 0), 0);

      // Today stats (SO + DSRs combined)
      const todayGiven  = txToday.filter(r => r.type === 'give' || r.type === 'point_sale').reduce((s, r) => s + num(r.totalRevenue), 0);
      const todayReturn = txToday.filter(r => r.type === 'return' || r.type === 'point_damage_return').reduce((s, r) => s + num(r.totalRevenue), 0);
      // V44 #31 — "আজকের বিক্রয়" summary cards: damage cost reported
      // today across the SO + their assigned DSRs (uses purchase-price
      // based total_cost, same figure the damage/claims screens use).
      const vanDamageToday = txToday.filter(r => r.type === 'damage').reduce((s, r) => s + num(r.totalCost), 0);
      // v5.6 — damage a DSR collects FROM SHOPS (ড্যামেজ কালেকশন) lives in its own
      // table (damage_collections), not in `transactions`, so it never reached this
      // card. Add it (same purchase-price basis as the damage claims).
      let shopDamageToday = 0;
      if (dsrIds.length) {
        const dcRows = await fetchAll(() => supabase.from('damage_collections')
          .select('units,purchase_price').in('dsr_id', dsrIds.map(String)).eq('date', today));
        shopDamageToday = (dcRows || []).reduce((s, r) => s + num(r.units) * num(r.purchase_price), 0);
      }
      const todayDamage = vanDamageToday + shopDamageToday;
      const monthGiven  = txMonth.filter(r => r.type === 'give' || r.type === 'point_sale').reduce((s, r) => s + num(r.totalRevenue), 0);
      const monthReturn = txMonth.filter(r => r.type === 'return' || r.type === 'point_damage_return').reduce((s, r) => s + num(r.totalRevenue), 0);
      const monthDsrPay = dsrPayMonth.reduce((s, r) => s + num(r.amount), 0);

      // V56 §4 — "you're due at [road] today" (day 1: SO visits), now
      // resolved LIVE from the weekly recurring rule instead of a
      // pre-inserted date row: does today's weekday match a rule for a
      // road assigned to me, and has that rule been active since on/
      // before today (active_from <= today)?
      const todayStr = bdtToday();
      // v5.23 — Friday is the weekly holiday: nobody visits on a Friday.
      let roadDuty = [];
      if (weekdayOf(todayStr) !== 5) {
        const { data: roadDutyRows } = await supabase.from('road_weekly_plans')
          .select('*').eq('so_id', userId).eq('weekday', weekdayOf(todayStr)).lte('active_from', todayStr);
        roadDuty = (roadDutyRows || []).map(mapRoadWeeklyPlan);
      }

      // ── V55 #56 / V57 — "আজকের মোট বিক্রয়" (Today's Total Sale) widget ──
      // Pieces sold today by this SO's assigned DSRs (give − return), PLUS
      // any point-sale attributed to this SO (the SO's own counter sale, or
      // an Owner/Manager point-sale where this SO was picked as the seller
      // — V57 point-sale SO-select), minus point-sale damage returns. The
      // raw total is then reduced by that day's *bonus* pieces earned per
      // product — the buy-X-get-Y free units the Owner set on the product
      // (bonus_free_units / bonus_cases_req / case_size) — using the same
      // case-math as computeBonusRangeSummary in _lib/db.js, scoped to
      // today only. So the number shown here is the NET real sale
      // (freebie giveaway pieces excluded), not the gross pieces moved.
      // Only the net figure is returned (V57 — no separate gross field).
      const productThumbMap = {}, productNameMap = {}, productBonusMap = {};
      products.forEach(p => {
        productThumbMap[p.id] = p.thumb || '';
        productNameMap[p.id] = p.name || '';
        productBonusMap[p.id] = {
          caseSize: num(p.caseSize) || 1,
          bonusCasesReq: num(p.bonusCasesReq) || 1,
          bonusFreeUnits: num(p.bonusFreeUnits) || 0
        };
      });
      const todayProdMap = {};
      txToday.forEach(r => {
        const isDsrLeg  = dsrIds.indexOf(r.srId) !== -1 && (r.type === 'give' || r.type === 'return');
        const isSoPoint = (r.srId === userId || dsrIds.indexOf(r.srId) !== -1) && (r.type === 'point_sale' || r.type === 'point_damage_return');
        if (!isDsrLeg && !isSoPoint) return;
        const pid = r.productId; if (!pid) return;
        if (!todayProdMap[pid]) {
          todayProdMap[pid] = {
            productId: pid,
            productName: r.productName || productNameMap[pid] || '',
            thumb: productThumbMap[pid] || '',
            sold: 0
          };
        }
        const units = num(r.totalUnits);
        const isPositive = (r.type === 'give' || r.type === 'point_sale');
        todayProdMap[pid].sold += (isPositive ? units : -units);
      });
      // Reduce each product's raw today-total by that day's earned bonus
      // pieces (same floor-division formula used everywhere else bonus is
      // calculated); only the net number goes to the client as `sold`.
      const soldNetMap = {};
      Object.values(todayProdMap).forEach(p => {
        const raw = p.sold;
        const bp = productBonusMap[p.productId] || { caseSize: 1, bonusCasesReq: 1, bonusFreeUnits: 0 };
        const cases = Math.floor(raw / bp.caseSize);
        const bonusPieces = Math.floor(cases / bp.bonusCasesReq) * bp.bonusFreeUnits;
        soldNetMap[p.productId] = Math.max(0, raw - bonusPieces);
      });

      // ── Damage swapped for PRODUCT today (display-only, company match) ──
      // A replacement pack handed to a shop leaves the van and is never
      // returned, so it is already inside give − return above: the SO
      // panel therefore shows it as a sale, exactly like the company
      // profile. It is NOT real revenue, so we also report it separately
      // (`exchangeUnits`) and the "pure" sale = shown sale − exchange.
      // Stock and DSR due are untouched by this figure.
      const exchMap = {};
      if (dsrIds.length) {
        const exchRows = await fetchAll(() => supabase.from('damage_collections')
          .select('exch_product_id,exch_units').in('dsr_id', dsrIds.map(String)).eq('date', today).eq('resolution', 'exchange'));
        (exchRows || []).forEach(r => {
          const k = String(r.exch_product_id || ''); if (!k) return;
          exchMap[k] = (exchMap[k] || 0) + num(r.exch_units);
        });
      }

      // ── Stock columns for the SO "আজকের মোট বিক্রয়" table ──
      // Warehouse stock is global, so "yesterday's closing stock" is the
      // live stock with today's warehouse movement (all users) reversed.
      // Movement signs mirror the apply_stock_delta trigger in schema.sql.
      // PERF-3: the day's warehouse movement per product, summed in Postgres.
      const dayMove = await getStockMovement(today);

      // ALL SKUs, zero when nothing sold today (sold desc, then catalogue order).
      const todayProductSales = products.map((p, idx) => {
        const pid = String(p.id);
        const shown = soldNetMap[pid] || 0;
        const exch = Math.min(exchMap[pid] || 0, shown);
        const cur = num(p.currentStock);
        return {
          productId: p.id, productName: p.name || '', thumb: p.thumb || '', sold: shown,
          exchangeUnits: exch, pureSold: shown - exch,
          prevStock: +(cur - (dayMove[pid] || 0)).toFixed(4), currentStock: cur, _i: idx
        };
      }).sort((a, b) => (b.sold - a.sold) || (a._i - b._i)).map(x => { delete x._i; return x; });

      return res.json({
        ok: true,
        assignedDsrs,
        dsrDues: { total: totalDsrDue, list: dsrDueList },
        soPayments: soPayments.slice(0, 30),
        soOwnDue,
        products,
        stockMap,
        todayProductSales,
        // V44 #31 — `saleGross` (before returns), `damage`, `returns` are
        // the three "আজকের বিক্রয়" card figures; `revenue` (net) is kept
        // unchanged for everything else already reading it.
        today: { revenue: todayGiven - todayReturn, saleGross: todayGiven, damage: todayDamage, vanDamage: vanDamageToday, shopDamage: shopDamageToday, returns: todayReturn, split: todaySplit },
        month: { revenue: monthGiven - monthReturn, dsrPayments: monthDsrPay, split: monthSplit },
        range: rangeSplit,
        roadDuty
      });
    }

    // ══════════════════════════════════════════════════════
    //  DSR DASHBOARD — strictly isolated to own data
    // ══════════════════════════════════════════════════════
    if (role === 'dsr' && userId) {
      const today = bdtToday();
      const monthStart = _cycleMonthStart(today);

      // V40: stock read straight from products.current_stock — see
      // migration_v40_stock_balance.sql — no more full transaction
      // history refetch on every DSR dashboard load. The lifetime
      // txAll fetch below is still needed (and still paginated) — it's
      // scoped to just this one DSR's own history for their own due
      // calculation, which is much smaller than the whole table.
      const [prodRes, dueTotals, paymentsList, txMonthList, payMonthList] = await Promise.all([
        supabase.from('products').select('*').order('sort_order').order('created_at'),
        // Lifetime due — same shared helper as the Owner/Manager/SO panels,
        // so a DSR's own "মোট বাকি" can never differ from what the owner sees.
        getDueTotals([String(userId)]),
        // fetchAll (was a bare query, silently capped at 1000 rows → the
        // DSR's total-paid was understated and his due showed too high).
        // only the newest 30 are listed — the lifetime total is in dueTotals
        supabase.from('sr_payments').select(PAY_COLS).eq('sr_id', userId).order('date', { ascending: false }).order('created_at', { ascending: false }).limit(30).then(r => { if (r.error) throw r.error; return r.data || []; }),
        fetchAll(() => supabase.from('transactions').select(TX_FULL).eq('sr_id', userId).gte('date', monthStart).lte('date', today).order('created_at')),
        fetchAll(() => supabase.from('sr_payments').select('amount').eq('sr_id', userId).gte('date', monthStart).lte('date', today).order('date'))
      ]);

      const products = (prodRes.data || []).map(mapProduct);
      const stockMap = {};
      products.forEach(p => { stockMap[p.id] = p.currentStock; });
      const payments = (paymentsList || []).map(mapPayment);
      const txMonth  = (txMonthList || []).map(mapTx);
      const payMonth = (payMonthList || []).map(mapPayment);

      // Own due calculation (Σgive − Σreturn − Σpayments, from the shared helper)
      const _t = dueTotals[String(userId)] || { givenRev: 0, returnRev: 0, payments: 0 };
      const givenRev  = _t.givenRev;
      const returnRev = _t.returnRev;
      const totalPaid = _t.payments;
      const ownDue    = (givenRev - returnRev) - totalPaid;

      // Month summary
      const mGiven   = txMonth.filter(r => r.type === 'give' || r.type === 'point_sale').reduce((s, r)   => s + num(r.totalRevenue), 0);
      const mReturn  = txMonth.filter(r => r.type === 'return' || r.type === 'point_damage_return').reduce((s, r) => s + num(r.totalRevenue), 0);
      const mGivenU  = txMonth.filter(r => r.type === 'give').reduce((s, r) => s + num(r.totalUnits), 0);
      const mReturnU = txMonth.filter(r => r.type === 'return').reduce((s, r) => s + num(r.totalUnits), 0);
      const mPayAmt  = payMonth.reduce((s, r) => s + num(r.amount), 0);
      const _csM = {}; (products || []).forEach(p => { _csM[String(p.id)] = num(p.caseSize) || 1; }); withUnits(_csM, products);
      const mCP = cpGroups(txMonth, _csM, { given: ['give'], returned: ['return'] });   // v5.4: exact cases + pcs

      // ── V31 reconcile — today's given vs. sold-to-shops vs. still on
      //    van, plus cash actually collected today from shop sales. Pure
      //    visibility: does NOT feed into ownDue (see shops.js visit-sale
      //    comment for why 'dsr_sale' never touches stock or due itself).
      const dsrSaleToday    = txMonth.filter(r => r.type === 'dsr_sale' && r.date === today).reduce((s, r) => s + num(r.totalRevenue), 0);
      const givenTodayRev   = txMonth.filter(r => r.type === 'give'     && r.date === today).reduce((s, r) => s + num(r.totalRevenue), 0);
      const returnTodayRev  = txMonth.filter(r => r.type === 'return'   && r.date === today).reduce((s, r) => s + num(r.totalRevenue), 0);
      const damageTodayCost = txMonth.filter(r => r.type === 'damage'   && r.date === today).reduce((s, r) => s + num(r.totalCost), 0);
      // Same price basis as given/return/sold (SELLING price). The old
      // formula subtracted the purchase-price cost here — mixed bases.
      const damageTodayRev  = txMonth.filter(r => r.type === 'damage'   && r.date === today).reduce((s, r) => s + num(r.totalRevenue), 0);
      const { data: shopDueTodayData } = await supabase.from('due_calendar')
        .select('amount,paid_amount').eq('dsr_id', userId).eq('client_type', 'shop').eq('due_date', today);
      const shopDueToday        = shopDueTodayData || [];
      const cashCollectedToday  = shopDueToday.reduce((s, r) => s + num(r.paid_amount), 0);
      const shopDueCreatedToday = shopDueToday.reduce((s, r) => s + (num(r.amount) - num(r.paid_amount)), 0);
      const stillWithDsrToday   = givenTodayRev - returnTodayRev - damageTodayRev - dsrSaleToday;

      // V56 §4 — "you're due at [road] today" (day 2: paired DSR
      // delivers, always the day AFTER the SO's visit — unchanged rule).
      // Resolved LIVE: did YESTERDAY's weekday match a rule for a road
      // this DSR is paired to, and was that rule active by yesterday?
      const yesterdayStr = bdtYesterday();
      // v5.7 — resolve through the DSR's SO as well (the copy of dsr_id stored on a weekly rule can be
      // stale or empty — e.g. the DSR was paired after the road was assigned), so DSR duty = every road
      // his SO visited yesterday.
      let _mySoId = '';
      try { const { data: _me } = await supabase.from('srs').select('so_id').eq('id', userId).maybeSingle(); _mySoId = String((_me && _me.so_id) || ''); } catch (_) { }
      const _dutyFilter = _mySoId ? ('dsr_id.eq.' + userId + ',so_id.eq.' + _mySoId) : ('dsr_id.eq.' + userId);
      // v5.23 — the DSR follows the SO by one WORKING day: Friday is a holiday, so on Saturday the DSR
      // goes to the road the SO visited on THURSDAY, and on Friday there is no delivery duty at all.
      let roadDuty = [];
      const _todayWd = weekdayOf(bdtToday());
      if (_todayWd !== 5) {
        let _visitDay = yesterdayStr;
        if (weekdayOf(_visitDay) === 5) _visitDay = addDaysStr(_visitDay, -1);
        const { data: roadDutyRows } = await supabase.from('road_weekly_plans')
          .select('*').or(_dutyFilter).eq('weekday', weekdayOf(_visitDay)).lte('active_from', _visitDay);
        roadDuty = (roadDutyRows || []).map(mapRoadWeeklyPlan);
      }

      return res.json({
        ok: true,
        products,
        stockMap,
        ownDue,
        givenRev,
        returnRev,
        totalPaid,
        payments: payments.slice(0, 30),
        month: { revenue: mGiven - mReturn, givenUnits: mGivenU, returnUnits: mReturnU, givenCP: mCP.given, returnCP: mCP.returned, payments: mPayAmt },
        txMonth: txMonth.slice(0, 60),
        reconcile: {
          givenTodayRev, returnTodayRev, damageTodayCost, soldToShopsToday: dsrSaleToday,
          cashCollectedToday, shopDueCreatedToday, stillWithDsrToday
        },
        roadDuty
      });
    }

    // ══════════════════════════════════════════════════════
    //  OWNER / MANAGER DASHBOARD — full data
    // ══════════════════════════════════════════════════════
    const today = bdtToday();
    const monthStart = _cycleMonthStart(today);

    // V40: the old 'txAll' full-lifetime-transactions fetch below used
    // to serve TWO purposes at once — computing the stock map, and
    // feeding the bonus "units given since last cleared" calc further
    // down. Stock now comes straight from products.current_stock (kept
    // in sync by a DB trigger — see migration_v40_stock_balance.sql),
    // so we only still need the full-history fetch for the bonus calc,
    // which genuinely does need lifetime data (it looks back to each
    // product's own last-cleared date, which can be any date in the
    // past). This alone removes the single most expensive, most
    // frequently-repeated full-table fetch in the whole app.
    // NOTE (pagination fix): txToday/txMonth used to be bare `.select('*')`
    // queries with only a date filter. Bare queries are silently capped at
    // PostgREST's default 1000 rows — no error, just a truncated result —
    // and a "this month" window crosses that cap far sooner than a lifetime
    // table does once daily transaction volume grows, which is exactly what
    // made last month's revenue/profit figures go quietly wrong. Both now
    // go through fetchAll, same as the lifetime bonus/dues queries already
    // did.
    // v5.1 (PERF-3): no raw transaction rows are downloaded any more. Every
    // total below is summed inside Postgres (see the SQL functions in
    // schema_fresh.sql / migrations/001) and arrives as a handful of numbers.
    const [pRes, sRes, todaySales, monthSales, todayProfitP, monthProfitP, srToday, srMonth, prodToday, prodMonth, payToday, payMonthTotal, dmgPendRows] = await Promise.all([
      supabase.from('products').select('*').order('sort_order').order('created_at'),
      supabase.from('srs').select('*').order('created_at'),
      getSrSalesTotals(today, today),
      getSrSalesTotals(monthStart, today),
      computeProfit(today, today),
      computeProfit(monthStart, today),
      Promise.resolve(null), Promise.resolve(null),
      getProductNetUnits(today, today),
      getProductNetUnits(monthStart, today),
      getPaymentsTotal(today, today),
      getPaymentsTotal(monthStart, today),
      fetchAll(() => supabase.from('dmg_claims').select('total_cost,status,date').or('status.eq.pending,date.eq.' + today))
    ]);

    const products    = (pRes.data  || []).map(mapProduct);
    const srs         = (sRes.data  || []).map(mapSR);

    // ── Stock map — straight from products.current_stock ───────────
    const stockMap = {};
    products.forEach(p => { stockMap[p.id] = p.currentStock; });

    // ── TODAY / MONTH stats (CALC-1: profit is NET profit now) ─────
    const sumT = (m, f) => Object.keys(m).reduce((s, k) => s + num(m[k][f]), 0);
    const gU  = sumT(todaySales, 'outUnits'), rtU = sumT(todaySales, 'inUnits');
    const todayCP = await getCaseTotals(today, today, { given: ['give', 'point_sale'], returned: ['return', 'point_damage_return'] });   // v5.4: exact cases + pcs
    const todayRevenue = todayProfitP.revenue;
    const todayProfit  = todayProfitP.netProfit;
    const monthRevenue = monthProfitP.revenue;
    const monthProfit  = monthProfitP.netProfit;
    const monthPayments = payMonthTotal;

    // ── STOCK list ─────────────────────────────────────────
    const stockList = products.map(p => {
      const units = stockMap[p.id] || 0;
      return {
        id: p.id, name: p.name, sku: p.sku,
        caseSize: num(p.caseSize) || 1,
        unitType: p.unitType || 'কেস',
        lowStockAlert: num(p.lowStockAlert),
        thumb: p.thumb || '',
        units,
        sellValue: units * num(p.sellingPrice)
      };
    });
    const totalSell = stockList.reduce((s,p)=>s+p.sellValue,0);

    // ── DUES (SR-wise) ─────────────────────────────────────
    const srDueMap = {};
    srs.forEach(sr => {
      srDueMap[sr.id] = {
        srId: sr.id, name: sr.name, area: sr.area,
        phone: sr.phone, thumb: sr.thumb || '',
        givenUnits: 0, returnUnits: 0,
        givenRev: 0, returnRev: 0, payments: 0
      };
    });

    // One shared, exact lifetime-due source (Postgres SUM) — identical to
    // what each DSR sees on his own panel.
    const _dueTotals = await getDueTotals(null);
    Object.keys(_dueTotals).forEach(sid => {
      if (!srDueMap[sid]) srDueMap[sid] = { srId:sid, name:'', area:'', phone:'', thumb:'', givenUnits:0, returnUnits:0, givenRev:0, returnRev:0, payments:0 };
      const t = _dueTotals[sid];
      srDueMap[sid].givenUnits = t.givenUnits; srDueMap[sid].returnUnits = t.returnUnits;
      srDueMap[sid].givenRev = t.givenRev;     srDueMap[sid].returnRev = t.returnRev;
      srDueMap[sid].payments = t.payments;
    });

    const duesList = Object.values(srDueMap).map(sr => ({
      ...sr,
      due: (sr.givenRev - sr.returnRev) - sr.payments
    }));
    const totalDue = duesList.reduce((s,sr)=>s+(sr.due>0?sr.due:0),0);

    // ── TODAY'S NEW DUE — same formula, filtered to today (AXIION §6) ──
    const todayGivenRev  = sumT(todaySales, 'giveRev');
    const todayReturnRev = sumT(todaySales, 'retRev');
    const todayPayAmt    = payToday;
    const todayNewDue    = (todayGivenRev - todayReturnRev) - todayPayAmt;

    // ── DAMAGE pending ─────────────────────────────────────
    const dmgPendingAmt = dmgPendRows.filter(r => r.status === 'pending').reduce((s,r)=>s+num(r.total_cost),0);
    const dmgTodayAmt   = dmgPendRows.filter(r => String(r.date || '').slice(0, 10) === today).reduce((s,r)=>s+num(r.total_cost),0);

    // ── BONUS (CALC-3) — earned this pay cycle, one shared calculation ──
    // (The old "pending" figure compared a since-last-clear amount with an
    // ALL-TIME received total and came out too low after the first clearing.)
    const bonusRows = await computeBonusRangeSummary(monthStart, today);
    const bonusPendingAmt = bonusRows.reduce((s, b) => s + num(b.amount), 0);

    // ── TOTAL STOCK VALUES ─────────────────────────────────
    // (Update #48 — the old "Recent Transactions" widget and its backing
    // query were removed entirely from the Owner/Manager dashboard.)
    const totalBuyValue  = stockList.reduce((s,p)=>s+(p.units*(products.find(pr=>pr.id===p.id)?num(products.find(pr=>pr.id===p.id).purchasePrice):0)),0);
    const totalSellValue = totalSell;
    const estimatedProfit = totalSellValue - totalBuyValue;

    // ── LOW STOCK ──────────────────────────────────────────
    const lowStockList = stockList.filter(p=>num(p.lowStockAlert)>0&&p.units<=num(p.lowStockAlert));

    // ── FULL RANKED SKU LIST — Today & Month, ranked in CASES ───────
    //    (Update #47 — replaced the old "Top 4 Products" widget, which
    //    hid every SKU past 4th place. Now returns EVERY product that
    //    exists, ranked #1 (best-selling) down to the lowest — including
    //    SKUs with zero sales that day/month, so the owner sees the
    //    complete picture, not just the winners. Ranking + case-
    //    conversion math is unchanged from the old buildTopSellers.)
    function buildRankedSellers(netByProduct) {
      const sales = {};
      products.forEach(p => { sales[p.id] = { productId: p.id, productName: p.name, units: 0 }; });
      Object.keys(netByProduct).forEach(pid => {
        if (!sales[pid]) sales[pid] = { productId: pid, productName: '', units: 0 };
        sales[pid].units += num(netByProduct[pid]);
      });
      return Object.values(sales).sort((a, b) => b.units - a.units)
        .map((p, i) => {
          const prod = products.find(pr => pr.id === p.productId) || {};
          const cs = num(prod.caseSize) || 1;
          const exactCases = p.units / cs;
          return {
            rank: i + 1,
            productId: p.productId,
            productName: p.productName,
            units: p.units,
            caseSize: cs,
            unitType: prod.unitType || 'কেস',
            cases: Math.round(exactCases),          // whole-case ranking figure
            exactCases: +exactCases.toFixed(4),      // precise value, shown on tap
            thumb: (stockList.find(s => s.id === p.productId) || {}).thumb || ''
          };
        });
    }
    const rankedToday = buildRankedSellers(prodToday);
    const rankedMonth = buildRankedSellers(prodMonth);

    // ── SR PERFORMANCE (this month) ────────────────────────
    const srPerf = {};
    srs.forEach(sr=>{ srPerf[sr.id]={srId:sr.id,name:sr.name,area:sr.area||'',thumb:sr.thumb||'',soldUnits:0,returnUnits:0,revenue:0,due:0}; });
    Object.keys(monthSales).forEach(sid => {
      const t = monthSales[sid];
      if (!srPerf[sid]) srPerf[sid]={srId:sid,name:'',area:'',thumb:'',soldUnits:0,returnUnits:0,revenue:0,due:0};
      srPerf[sid].soldUnits += t.giveUnits; srPerf[sid].returnUnits += t.retUnits;
      srPerf[sid].revenue += t.giveRev - t.retRev;
    });
    duesList.forEach(d=>{ if(srPerf[d.srId]) srPerf[d.srId].due=d.due; });
    const srPerfList = Object.values(srPerf).filter(s=>s.soldUnits>0||s.returnUnits>0).sort((a,b)=>b.revenue-a.revenue);

    const _okMain = await offerLedger.profitAllowed(req.query);
    let _offerDue = null;
    if (_okMain) { try { const L = await offerLedger.ledger(); _offerDue = { pending: L.alloc.total.balance, earned: L.alloc.total.earned, received: L.alloc.total.received, adjustmentNet: L.alloc.total.adjustmentNet, lastPaymentDate: L.alloc.lastPaymentDate || '', payments: (L.payments || []).slice(-5).reverse() }; } catch (e) {} }
    const _strip = (b) => { if (_okMain) return b; return undefined; };
    res.json({
      ok: true,
      offerDue: _offerDue,
      // `profit` = NET profit (CALC-1). The pieces are returned too so a screen
      // can show: gross − commission − discount − damage − bonus − expenses.
      today: Object.assign({ revenue: todayRevenue, givenUnits: gU, returnUnits: rtU, givenCP: todayCP.given, returnCP: todayCP.returned }, _okMain ? { profit: todayProfit, breakdown: todayProfitP } : {}),
      month: Object.assign({ revenue: monthRevenue, payments: monthPayments }, _okMain ? { profit: monthProfit, breakdown: monthProfitP } : {}),
      stock: Object.assign({ list: stockList, totalSell, totalBuyValue, totalSellValue }, _okMain ? { estimatedProfit } : {}),
      dues:  { total: totalDue, todayNew: todayNewDue, list: duesList },
      damage: { pendingAmt: dmgPendingAmt, todayAmt: dmgTodayAmt },
      bonus:  { pendingAmt: bonusPendingAmt, from: monthStart, to: today, byProduct: bonusRows.filter(b => num(b.amount) > 0) },
      lowStock: lowStockList,
      rankedToday,
      rankedMonth,
      srPerformance: srPerfList
    });

  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};
