const {
  supabase, cors, num, ds, str, now_, safeErr,
  mapTx, mapPayment, mapProduct, mapSR, mapDue,
  bdtYesterday, fetchAll, computeProfit, getDueTotals, cpSplit, cpGroups, withUnits
} = require('./_lib/db');

const TX_COLS = 'id,tx_id,type,sr_id,sr_name,date,slip_no,product_id,product_name,sku,cases,pcs,total_units,purchase_price,selling_price,total_cost,total_revenue,commission_amt,discount_amt,shop_id,customer_id,note,created_at';
const DUE_COLS = 'id,dsr_id,dsr_name,client_type,shop_id,shop_name,due_date,amount,paid_amount,note,status,cleared_date,created_at,tx_id';


const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ══════════════════════════════════════════════════════════════════
//  V30 — Daily SO Delivery Report + Due Report
//
//  One product-wise "চালান"-style challan per DSR route under an SO
//  (1st/2nd/… loading = each distinct "give" batch that route received
//  that day, ফেরত = unsold stock brought back, বিক্রয় = loading − ফেরত,
//  টাকা = বিক্রয় × দর) plus a companion shop-wise Due Report (today's
//  due, any carried-over previous due, and a per-shop breakdown).
//  Stored in daily_so_reports, newest 60 dates kept per SO.
// ══════════════════════════════════════════════════════════════════

// Build one route's (a DSR, or the SO's own direct activity) product
// challan for a single calendar date.
// V47 update #39: routeRoadName threads the Road (Update #21/#22) this
// route belongs to into the challan, so it can be printed on the report.
// V47 update #40: productMetaMap now carries caseSize alongside unitType
// so the frontend can render "X কেস Y পিস" instead of a raw piece count.
async function buildRouteChallan(routeId, routeName, routePhone, routeArea, reportDate, productMetaMap, routeRoadName) {
  const data = await fetchAll(() => supabase.from('transactions').select(TX_COLS)
    .eq('sr_id', routeId).eq('date', reportDate)
    .in('type', ['give', 'return', 'damage'])
    .order('created_at', { ascending: true }));
  const rows = (data || []).map(mapTx);

  // Group 'give' rows into load batches by tx_id — every van-load-finish
  // (or direct give) call shares one tx_id, so distinct tx_ids ordered by
  // time ARE the day's 1st/2nd/… loading events for this route.
  const giveGroups = {};
  rows.filter(r => r.type === 'give').forEach(r => {
    if (!giveGroups[r.txId]) giveGroups[r.txId] = { createdAt: r.createdAt, items: [] };
    giveGroups[r.txId].items.push(r);
  });
  const loadBatches = Object.values(giveGroups).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const loadCount = loadBatches.length;

  const prodMap = {};
  const order = [];
  function getP(r) {
    if (!prodMap[r.productId]) {
      var meta = (productMetaMap && productMetaMap[r.productId]) || {};
      prodMap[r.productId] = {
        productId: r.productId, name: r.productName, sku: r.sku,
        unitType: meta.unitType || '', caseSize: Number(meta.caseSize) || 1,
        loads: new Array(loadCount).fill(0),
        totalLoad: 0, returned: 0, damage: 0,
        giveUnits: 0, giveRevenue: 0
      };
      order.push(r.productId);
    }
    return prodMap[r.productId];
  }

  loadBatches.forEach((batch, idx) => {
    batch.items.forEach(r => {
      const p = getP(r), u = num(r.totalUnits);
      p.loads[idx] += u; p.totalLoad += u;
      p.giveUnits  += u; p.giveRevenue += num(r.totalRevenue);
    });
  });
  rows.filter(r => r.type === 'return').forEach(r => { getP(r).returned += num(r.totalUnits); });
  rows.filter(r => r.type === 'damage').forEach(r => { getP(r).damage  += num(r.totalUnits); });

  const products = order.map(pid => {
    const p = prodMap[pid];
    const sold = Math.max(0, p.totalLoad - p.returned - p.damage);
    const rate = p.giveUnits > 0 ? +(p.giveRevenue / p.giveUnits).toFixed(4) : 0;
    // V47 update #41: "দর" (unit price) column becomes "কেস দর" (case
    // price) — casePrice is purely a display-time multiple of the same
    // per-piece rate already used for `amount`, so the printed total
    // still reconciles exactly; nothing about the underlying money math
    // changes, only what one column shows per case instead of per piece.
    const casePrice = +(rate * p.caseSize).toFixed(4);
    return {
      productId: p.productId, name: p.name, sku: p.sku, unitType: p.unitType,
      caseSize: p.caseSize,
      loads: p.loads, totalLoad: p.totalLoad, returned: p.returned, damage: p.damage,
      sold, rate, casePrice, amount: +(sold * rate).toFixed(4)
    };
  }).filter(p => p.totalLoad > 0 || p.returned > 0 || p.damage > 0);

  const totals = products.reduce((s, p) => ({
    totalLoad: s.totalLoad + p.totalLoad, returned: s.returned + p.returned,
    damage: s.damage + p.damage, sold: s.sold + p.sold, amount: +(s.amount + p.amount).toFixed(4)
  }), { totalLoad: 0, returned: 0, damage: 0, sold: 0, amount: 0 });

  return { routeId: String(routeId), routeName: routeName || '', routePhone: routePhone || '', routeArea: routeArea || '', routeRoadName: routeRoadName || '', loadCount, products, totals };
}

// Companion Due Report — today's due, previous carried-over due, and a
// shop-wise breakdown, scoped to an SO + every DSR assigned to it.
async function buildDueReportData(soId, reportDate, allIds) {
  // PERF-4: cleared rows owe nothing — do not download them
  const data = await fetchAll(() => supabase.from('due_calendar').select(DUE_COLS)
    .in('dsr_id', allIds).eq('client_type', 'shop').neq('status', 'cleared'));
  const rows = (data || []).map(mapDue);

  let todayTotal = 0, prevTotal = 0;
  const shopMap = {};
  rows.forEach(r => {
    const remaining = num(r.amount) - num(r.paidAmount);
    if (remaining <= 0) return;
    const isToday = r.dueDate === reportDate;
    const isPrev  = r.dueDate < reportDate;
    if (!isToday && !isPrev) return; // ignore any future-dated stray row
    if (isToday) todayTotal += remaining; else prevTotal += remaining;
    const key = r.shopId || ('_noshop_' + r.dsrId);
    if (!shopMap[key]) shopMap[key] = {
      shopId: r.shopId || '', shopNo: '', shopName: r.shopName || (r.dsrName ? (r.dsrName + ' — সরাসরি বাকি') : 'অজানা'),
      shopPhone: '', todayDue: 0, prevDue: 0
    };
    if (isToday) shopMap[key].todayDue += remaining; else shopMap[key].prevDue += remaining;
  });

  const shopIds = Object.values(shopMap).map(s => s.shopId).filter(Boolean);
  if (shopIds.length) {
    const { data: shopRows, error: shopErr } = await supabase.from('shops').select('id,shop_no,phone').in('id', shopIds);
    if (shopErr) throw shopErr;
    const phoneMap = {}, noMap = {};
    (shopRows || []).forEach(s => { phoneMap[String(s.id)] = s.phone || ''; noMap[String(s.id)] = s.shop_no || ''; });
    Object.values(shopMap).forEach(s => { if (s.shopId) { s.shopPhone = phoneMap[s.shopId] || ''; s.shopNo = noMap[s.shopId] || ''; } });
  }

  const shops = Object.values(shopMap)
    .map(s => ({ ...s, totalDue: +(s.todayDue + s.prevDue).toFixed(4) }))
    .filter(s => s.totalDue > 0)
    .sort((a, b) => b.totalDue - a.totalDue);

  return {
    soId: String(soId), reportDate,
    todayTotal: +todayTotal.toFixed(4), prevTotal: +prevTotal.toFixed(4),
    grandTotal: +(todayTotal + prevTotal).toFixed(4),
    shops
  };
}

// Generates (or regenerates) one SO's full daily snapshot — the product
// challan for every route under it, plus the due report — and stores it,
// pruning that SO's history down to the newest 60 dates.
async function generateDailyReportForSO(soRow, reportDate, generatedBy, productMetaMap) {
  const { data: dsrsData, error: dsrErr } = await supabase.from('srs').select('*').eq('so_id', soRow.id);
  if (dsrErr) throw dsrErr;
  const dsrs = dsrsData || [];
  const allIds = [String(soRow.id), ...dsrs.map(d => String(d.id))];

  const routes = [];
  const soChallan = await buildRouteChallan(String(soRow.id), (soRow.name || '') + ' (SO সরাসরি)', soRow.phone || '', soRow.area || '', reportDate, productMetaMap, soRow.road_name || '');
  if (soChallan.totals.totalLoad > 0 || soChallan.totals.returned > 0 || soChallan.totals.damage > 0) routes.push(soChallan);
  for (const dsr of dsrs) {
    routes.push(await buildRouteChallan(String(dsr.id), dsr.name || '', dsr.phone || '', dsr.area || '', reportDate, productMetaMap, dsr.road_name || ''));
  }

  const soTotals = routes.reduce((s, r) => ({
    totalLoad: s.totalLoad + r.totals.totalLoad, returned: s.returned + r.totals.returned,
    damage: s.damage + r.totals.damage, sold: s.sold + r.totals.sold,
    amount: +(s.amount + r.totals.amount).toFixed(4)
  }), { totalLoad: 0, returned: 0, damage: 0, sold: 0, amount: 0 });

  // Update #45 — one line: how many DISTINCT SKUs were actually sold
  // that day, across every route (SO's own direct activity + every DSR
  // under them). Counted from the same per-route `products` list already
  // built above, so it always matches what the challan itself shows.
  const soldSkuIds = new Set();
  routes.forEach(rt => (rt.products || []).forEach(p => { if (p.sold > 0) soldSkuIds.add(p.productId); }));
  soTotals.skuCount = soldSkuIds.size;

  const reportData = {
    soId: String(soRow.id), soName: soRow.name || '', soPhone: soRow.phone || '', soArea: soRow.area || '',
    soRoadName: soRow.road_name || '',
    reportDate, generatedAt: now_(), routes, soTotals
  };
  const dueData = await buildDueReportData(String(soRow.id), reportDate, allIds);

  const { data: upserted, error: upErr } = await supabase.from('daily_so_reports').upsert({
    so_id: String(soRow.id), so_name: soRow.name || '', report_date: reportDate,
    generated_at: now_(), generated_by: generatedBy || '',
    report_data: reportData, due_data: dueData
  }, { onConflict: 'so_id,report_date' }).select().single();
  if (upErr) throw upErr;

  // Prune to the newest 60 dates for this SO.
  const { data: allDates, error: listErr } = await supabase
    .from('daily_so_reports').select('id').eq('so_id', String(soRow.id))
    .order('report_date', { ascending: false });
  if (!listErr && allDates && allDates.length > 60) {
    const toDeleteIds = allDates.slice(60).map(r => r.id);
    if (toDeleteIds.length) await supabase.from('daily_so_reports').delete().in('id', toDeleteIds);
  }
  return upserted;
}

// V47 update #43: "two due totals in every report" — for the date-range
// analytics report this means (a) due newly created inside [from,to]
// (the period's own due), and (b) the cumulative company-wide due
// outstanding as of `to` (everything unpaid with due_date <= to,
// regardless of when it started) — same today-vs-cumulative shape the
// daily SO/Due report already gives via buildDueReportData above, just
// company-wide instead of scoped to one SO's routes.
async function computePeriodDueTotals(from, to) {
  // PERF-3/4: summed in Postgres over OPEN rows only; same numbers as before.
  try {
    const { data, error } = await supabase.rpc('period_due', { p_from: from, p_to: to });
    if (error) throw error;
    const r = (data && data[0]) || {};
    return { periodDue: +num(r.period_due).toFixed(4), cumulativeDue: +num(r.cumulative_due).toFixed(4) };
  } catch (e) {
    const rows = await fetchAll(() => supabase.from('due_calendar')
      .select('due_date,amount,paid_amount').lte('due_date', to).neq('status', 'cleared'));
    let periodDue = 0, cumulativeDue = 0;
    (rows || []).forEach(r => {
      const remaining = num(r.amount) - num(r.paid_amount);
      if (remaining <= 0) return;
      cumulativeDue += remaining;
      if (r.due_date >= from && r.due_date <= to) periodDue += remaining;
    });
    return { periodDue: +periodDue.toFixed(4), cumulativeDue: +cumulativeDue.toFixed(4) };
  }
}

async function fetchProductMetaMap() {
  const { data, error } = await supabase.from('products').select('id,unit_type,case_size');
  if (error) throw error;
  const m = {};
  (data || []).forEach(p => { m[String(p.id)] = { unitType: p.unit_type || '', caseSize: Number(p.case_size) || 1 }; });
  return m;
}

// GET ?action=cron-generate — Vercel Cron hits this at 02:00 Asia/Dhaka
// (see vercel.json). Auth via CRON_SECRET (Vercel sends it automatically
// as an Authorization: Bearer header — see README).
async function handleCronGenerate(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const authHeader = req.headers.authorization || '';
  const cronSecret = process.env.CRON_SECRET || '';
  // header only — a secret in the URL ends up in logs
  const authed = !!cronSecret && authHeader === 'Bearer ' + cronSecret;
  if (!authed) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const reportDate = (req.query.date && DATE_RE.test(req.query.date)) ? req.query.date : bdtYesterday();
  const { data: soRows, error } = await supabase.from('srs').select('*').eq('role', 'so');
  if (error) throw error;
  const productMetaMap = await fetchProductMetaMap();
  const results = [];
  // PERF-8: a few SOs at a time (was one after another) so the 30-second
  // limit is not hit as the business grows; every failure is recorded.
  const list = soRows || [];
  for (let i = 0; i < list.length; i += 3) {
    await Promise.all(list.slice(i, i + 3).map(async (so) => {
      try {
        await generateDailyReportForSO(so, reportDate, 'auto', productMetaMap);
        results.push({ soId: so.id, soName: so.name, ok: true });
      } catch (e) {
        results.push({ soId: so.id, soName: so.name, ok: false, error: safeErr(e) });
      }
    }));
  }
  try {
    await supabase.from('cron_runs').insert({
      report_date: reportDate, ok_count: results.filter(r => r.ok).length,
      fail_count: results.filter(r => !r.ok).length, details: results
    });
    await supabase.from('cron_runs').delete().lt('ran_at', new Date(Date.now() - 60 * 86400000).toISOString());
  } catch (e) { /* log table not installed yet */ }
  return res.json({ ok: true, reportDate, count: results.length, results });
}

// GET ?action=cron-status — the owner can see whether last night's reports ran.
async function handleCronStatus(req, res) {
  const { data, error } = await supabase.from('cron_runs').select('ran_at,report_date,ok_count,fail_count,details')
    .order('ran_at', { ascending: false }).limit(5);
  if (error) return res.json({ ok: true, runs: [], note: 'cron_runs table not installed' });
  return res.json({ ok: true, runs: data || [] });
}

// POST ?action=daily-generate — Owner-triggered manual (re)generate.
// Body: { ownerPin, soId? ('all' or omitted = every SO), date? }
async function handleDailyGenerate(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const d = req.body || {};
  const ownerPin = str(d.ownerPin || '', 20);
  if (!ownerPin) return res.json({ ok: false, error: 'Owner PIN প্রয়োজন' });

  const { data: ownerRow, error: pinErr } = await supabase
    .from('user_passwords').select('id,user_name').eq('role', 'owner').eq('password', ownerPin).limit(1);
  if (pinErr) throw pinErr;
  if (!ownerRow || !ownerRow.length) return res.json({ ok: false, error: 'ভুল Owner PIN' });
  const generatedBy = ownerRow[0].user_name || 'Owner';

  const reportDate = (d.date && DATE_RE.test(d.date)) ? d.date : bdtYesterday();

  let soRows;
  if (d.soId && d.soId !== 'all') {
    const { data, error } = await supabase.from('srs').select('*').eq('id', d.soId).maybeSingle();
    if (error) throw error;
    if (!data) return res.json({ ok: false, error: 'SO পাওয়া যায়নি' });
    soRows = [data];
  } else {
    const { data, error } = await supabase.from('srs').select('*').eq('role', 'so');
    if (error) throw error;
    soRows = data || [];
  }
  if (!soRows.length) return res.json({ ok: false, error: 'কোনো SO পাওয়া যায়নি — আগে DSR/SO পেজ থেকে একজন SO যোগ করুন' });

  const productMetaMap = await fetchProductMetaMap();
  const results = [];
  for (const so of soRows) {
    const row = await generateDailyReportForSO(so, reportDate, generatedBy, productMetaMap);
    results.push({
      soId: String(so.id), soName: so.name, reportDate,
      generatedAt: row.generated_at, generatedBy: row.generated_by,
      reportData: row.report_data, dueData: row.due_data
    });
  }
  return res.json({ ok: true, reportDate, results });
}

// GET ?action=daily-list&soId= — last 60 stored report dates for one SO.
async function handleDailyList(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const { soId } = req.query;
  if (!soId) return res.json({ ok: false, error: 'soId প্রয়োজন' });
  const { data, error } = await supabase.from('daily_so_reports')
    .select('id,so_id,so_name,report_date,generated_at,generated_by,report_data,due_data')
    .eq('so_id', soId).order('report_date', { ascending: false }).limit(60);
  if (error) throw error;
  const list = (data || []).map(r => ({
    id: r.id, soId: r.so_id, soName: r.so_name, reportDate: ds(r.report_date),
    generatedAt: r.generated_at, generatedBy: r.generated_by,
    soTotals: (r.report_data && r.report_data.soTotals) || {},
    dueGrandTotal: (r.due_data && r.due_data.grandTotal) || 0
  }));
  return res.json({ ok: true, list });
}

// GET ?action=daily-get&soId=&date= — one full stored snapshot (for print/share).
async function handleDailyGet(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const { soId, date } = req.query;
  if (!soId || !date) return res.json({ ok: false, error: 'soId ও date প্রয়োজন' });
  const { data, error } = await supabase.from('daily_so_reports').select('*')
    .eq('so_id', soId).eq('report_date', date).maybeSingle();
  if (error) throw error;
  if (!data) return res.json({ ok: false, error: 'এই তারিখের রিপোর্ট পাওয়া যায়নি' });
  return res.json({
    ok: true, reportDate: ds(data.report_date), soId: data.so_id, soName: data.so_name,
    generatedAt: data.generated_at, generatedBy: data.generated_by,
    reportData: data.report_data, dueData: data.due_data
  });
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';

  try {
    if (action === 'cron-generate')   return await handleCronGenerate(req, res);
    if (action === 'cron-status')     return await handleCronStatus(req, res);
    if (action === 'daily-generate')  return await handleDailyGenerate(req, res);
    if (action === 'daily-list')      return await handleDailyList(req, res);
    if (action === 'daily-get')       return await handleDailyGet(req, res);

    // ── Existing date-range analytics report (unchanged) ──────────────
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });
    const { from, to } = req.query;
    if (!from || !to) return res.json({ ok: false, error: 'from/to প্রয়োজন' });

    // Paginated: a wide owner-picked range (e.g. a full month/year report)
    // can pass 1000 transaction rows well within the business's first year.
    const _offerLedger = require('./_lib/offerLedger');
    const _okProfit = await _offerLedger.profitAllowed(req.query);
    const [txRows, payRows, srRes, prodRes, dueTotals, claimRows, lifeDue, profitP] = await Promise.all([
      fetchAll(() => supabase.from('transactions').select(TX_COLS).gte('date', from).lte('date', to).order('date')),
      fetchAll(() => supabase.from('sr_payments').select('id,sr_id,sr_name,date,amount,cash_amount,commission_amt,discount_amt,damage_amt,note,created_at').gte('date', from).lte('date', to).order('date')),
      supabase.from('srs').select('*').order('created_at'),
      supabase.from('products').select('*').order('sort_order').order('created_at'),
      computePeriodDueTotals(from, to),
      // Every damage claim in the window — van damage AND damage-collection
      // (tx_id 'dc:…') — the complete company loss, purchase-price based.
      fetchAll(() => supabase.from('dmg_claims').select('total_units,total_cost').gte('date', from).lte('date', to)),
      getDueTotals(null),
      computeProfit(from, to)      // CALC-1: the SAME definition the dashboard uses
    ]);

    const txs   = (txRows  || []).map(mapTx);
    const pays  = (payRows || []).map(mapPayment);
    const srs   = (srRes.data  || []).map(mapSR);
    const prods = (prodRes.data|| []).map(mapProduct);

    // Update #44 — every generated report/sheet carries a generation
    // timestamp; this date-range analytics report previously had none.
    const generatedAt = now_();

    if (!txs.length && !pays.length) return res.json({ ok: true, empty: true, from, to, generatedAt, dueTotals });

    // ── Summary totals ──────────────────────────────────────
    const sU = (a, t) => a.filter(r => r.type === t).reduce((s, r) => s + num(r.totalUnits), 0);
    const sR = (a, t) => a.filter(r => r.type === t).reduce((s, r) => s + num(r.totalRevenue), 0);
    const sC = (a, t) => a.filter(r => r.type === t).reduce((s, r) => s + num(r.totalCost), 0);

    const gU  = sU(txs,'give')+sU(txs,'point_sale'), rtU = sU(txs,'return')+sU(txs,'point_damage_return'), dmgU = sU(txs,'damage'), byU = sU(txs,'buy');
    const gR  = sR(txs,'give')+sR(txs,'point_sale'), rtR = sR(txs,'return')+sR(txs,'point_damage_return');
    const gC  = sC(txs,'give')+sC(txs,'point_sale'), rtC = sC(txs,'return')+sC(txs,'point_damage_return'), dmgC = sC(txs,'damage');
    // Complete damage loss = all claims (van damage + shop damage collection).
    const claimUnits = (claimRows || []).reduce((a, r) => a + num(r.total_units), 0);
    const claimCost  = (claimRows || []).reduce((a, r) => a + num(r.total_cost), 0);
    const netRev  = gR - rtR, netCost = gC - rtC;
    const totalPay = pays.reduce((s, r) => s + num(r.amount), 0);

    // v5.4 — exact "cases + loose pieces" for every quantity total (per-product split)
    const _cs = {}; prods.forEach(p => { _cs[String(p.id)] = num(p.caseSize) || 1; }); withUnits(_cs, prods);
    const _cpT = cpGroups(txs, _cs, { given: ['give', 'point_sale'], returned: ['return', 'point_damage_return'], damage: ['damage'], buy: ['buy'] });
    const _soldBy = {}; txs.forEach(r => { const k = String(r.productId || ''), u = num(r.totalUnits); if (r.type === 'give' || r.type === 'point_sale') _soldBy[k] = (_soldBy[k] || 0) + u; else if (r.type === 'return' || r.type === 'point_damage_return' || r.type === 'damage') _soldBy[k] = (_soldBy[k] || 0) - u; });
    const totals = {
      givenCP: _cpT.given, returnCP: _cpT.returned, dmgCP: _cpT.damage, buyCP: _cpT.buy, soldCP: cpSplit(_soldBy, _cs),
      givenUnits: gU, returnUnits: rtU, dmgUnits: dmgU, buyUnits: byU,
      // sold = given − returned − damaged (same rule as the SR / product rows)
      soldUnits: gU - rtU - dmgU, netRevenue: netRev, netCost,
      grossProfit: netRev - netCost,
      // CALC-1 — net profit and each deduction (same numbers as the dashboard)
      netProfit: profitP.netProfit, commission: profitP.commission, discount: profitP.discount,
      damageLoss: profitP.damageLoss, bonus: profitP.bonus, expenses: profitP.expenses, profitRules: profitP.rules,
      // v5.27 — offer split + company payments (cash/bank received, never sales or profit)
      normalSales: profitP.normalSales, offerDeduction: profitP.offerDeduction, actualSales: profitP.actualSales,
      cashProfit: profitP.cashProfit, offerProfit: profitP.offerProfit, offerReceived: profitP.offerReceived, offerPending: profitP.offerPending,
      adjustment: profitP.adjustment, adjustments: profitP.adjustments, companyPayments: profitP.companyPayments,
      companyPaymentsTotal: Math.round(((profitP.companyPayments || []).reduce((a, x) => a + num(x.amount), 0)) * 100) / 100,
      offerBalanceAll: profitP.offerBalanceAll,
      dmgLoss: claimCost, dmgClaimUnits: claimUnits, payments: totalPay,
      // Update #43 — two due figures: this period's own due, and the
      // running cumulative due outstanding as of the period's end date.
      periodDue: dueTotals.periodDue, cumulativeDue: dueTotals.cumulativeDue
    };

    // ── SR-wise ─────────────────────────────────────────────
    const srMap = {};
    srs.forEach(sr => {
      srMap[sr.id] = {
        srId: sr.id, name: sr.name, phone: sr.phone, area: sr.area, thumb: sr.thumb || '',
        givenUnits: 0, returnUnits: 0, dmgUnits: 0, soldUnits: 0,
        givenRev: 0, returnRev: 0, givenCost: 0, returnCost: 0,
        netRev: 0, netCost: 0, profit: 0, payments: 0, due: 0, products: {}
      };
    });

    txs.forEach(r => {
      if (!r.srId || !['give','return','damage'].includes(r.type)) return;
      if (!srMap[r.srId]) srMap[r.srId] = {
        srId: r.srId, name: r.srName, phone: '', area: '', thumb: '',
        givenUnits: 0, returnUnits: 0, dmgUnits: 0, soldUnits: 0,
        givenRev: 0, returnRev: 0, givenCost: 0, returnCost: 0,
        netRev: 0, netCost: 0, profit: 0, payments: 0, due: 0, products: {}
      };
      const sr = srMap[r.srId];
      const u = num(r.totalUnits), rev = num(r.totalRevenue), cost = num(r.totalCost);
      if (!sr.products[r.productId]) sr.products[r.productId] = {
        name: r.productName, sku: r.sku,
        given: 0, returned: 0, damage: 0,
        givenRev: 0, returnRev: 0, givenCost: 0, returnCost: 0
      };
      const p = sr.products[r.productId];
      if (r.type === 'give')   { sr.givenUnits += u; sr.givenRev  += rev; sr.givenCost  += cost; p.given    += u; p.givenRev  += rev; p.givenCost  += cost; }
      if (r.type === 'return') { sr.returnUnits+= u; sr.returnRev += rev; sr.returnCost += cost; p.returned += u; p.returnRev += rev; p.returnCost += cost; }
      if (r.type === 'damage') { sr.dmgUnits   += u; p.damage += u; }
    });

    pays.forEach(r => { if (srMap[r.srId]) srMap[r.srId].payments += num(r.amount); });

    Object.values(srMap).forEach(sr => {
      sr.soldUnits = sr.givenUnits - sr.returnUnits - sr.dmgUnits;
      sr.netRev  = sr.givenRev  - sr.returnRev;
      sr.netCost = sr.givenCost - sr.returnCost;
      sr.profit  = sr.netRev  - sr.netCost;
      sr.due     = sr.netRev  - sr.payments;          // PERIOD figure (this date range only)
      sr.periodDue = sr.due;
      { const t = lifeDue[sr.srId]; sr.lifetimeDue = t ? (t.givenRev - t.returnRev) - t.payments : 0; }   // CALC-10: all-time due
      { const g = {}, r = {}, d = {}, so = {}; Object.keys(sr.products).forEach(k => { const q = sr.products[k]; g[k] = q.given; r[k] = q.returned; d[k] = q.damage; so[k] = q.given - q.returned - q.damage; });
        sr.givenCP = cpSplit(g, _cs); sr.returnCP = cpSplit(r, _cs); sr.dmgCP = cpSplit(d, _cs); sr.soldCP = cpSplit(so, _cs); }
      Object.values(sr.products).forEach(p => {
        p.sold    = p.given - p.returned - p.damage;
        p.netRev  = p.givenRev  - p.returnRev;
        p.netCost = p.givenCost - p.returnCost;
        p.profit  = p.netRev - p.netCost;
      });
    });

    // ── Product-wise ────────────────────────────────────────
    const prodMap = {};
    txs.forEach(r => {
      if (!prodMap[r.productId]) {
        const pi = prods.find(p => p.id === r.productId);
        prodMap[r.productId] = {
          name: r.productName, sku: r.sku,
          thumb: pi ? pi.thumb || '' : '',
          // v5.24 — prices come from the transactions themselves (latest in the range), never from today's product
          purchasePrice: num(r.purchasePrice) || (pi ? num(pi.purchasePrice) : 0),
          sellingPrice:  num(r.sellingPrice)  || (pi ? num(pi.sellingPrice)  : 0),
          buy: 0, given: 0, returned: 0, damage: 0, sold: 0,
          caseSize: pi ? (num(pi.caseSize) || 1) : 1, unitType: pi ? (pi.unitType || '') : '',
          revenue: 0, cost: 0, profit: 0
        };
      }
      const p = prodMap[r.productId], u = num(r.totalUnits);
      if (r.type === 'buy')    p.buy      += u;
      if (r.type === 'give'   || r.type === 'point_sale')          { p.given   += u; p.revenue += num(r.totalRevenue); p.cost += num(r.totalCost); }
      if (r.type === 'return' || r.type === 'point_damage_return') { p.returned+= u; p.revenue -= num(r.totalRevenue); p.cost -= num(r.totalCost); }
      if (r.type === 'damage') p.damage   += u;
    });
    Object.values(prodMap).forEach(p => { p.sold = p.given - p.returned - p.damage; p.profit = p.revenue - p.cost; });

    // ── Date-wise ───────────────────────────────────────────
    const dayMap = {};
    txs.forEach(r => {
      const d = ds(r.date);
      if (!dayMap[d]) dayMap[d] = { date: d, givenUnits: 0, returnUnits: 0, dmgUnits: 0, revenue: 0, cost: 0, profit: 0, _g: {}, _r: {} };
      const day = dayMap[d], u = num(r.totalUnits), _pk = String(r.productId || '');
      if (r.type === 'give' || r.type === 'point_sale') day._g[_pk] = (day._g[_pk] || 0) + u;
      if (r.type === 'return' || r.type === 'point_damage_return') day._r[_pk] = (day._r[_pk] || 0) + u;
      if (r.type === 'give'   || r.type === 'point_sale')          { day.givenUnits  += u; day.revenue += num(r.totalRevenue); day.cost += num(r.totalCost); }
      if (r.type === 'return' || r.type === 'point_damage_return') { day.returnUnits += u; day.revenue -= num(r.totalRevenue); day.cost -= num(r.totalCost); }
      if (r.type === 'damage')   day.dmgUnits    += u;
    });
    Object.values(dayMap).forEach(d => { d.profit = d.revenue - d.cost; d.givenCP = cpSplit(d._g, _cs); d.returnCP = cpSplit(d._r, _cs); delete d._g; delete d._r; });

    const byDate  = Object.values(dayMap).sort((a, b) => b.date.localeCompare(a.date));
    const srPerf  = Object.values(srMap).filter(sr => sr.givenUnits + sr.payments > 0).sort((a, b) => b.soldUnits - a.soldUnits);
    const bySR    = Object.values(srMap).filter(s => s.givenUnits + s.payments > 0);
    const byProduct = Object.values(prodMap);

    // per day (SALE date): offer earned that day, cash profit = actual sales − purchase cost, total = cash + offer
    try {
      const _od = (await _offerLedger.profitOffer(from, to)).days || {};
      byDate.forEach(d => { const o = _od[d.date] || {}; d.offerDeduction = num(o.earned); d.offerPending = num(o.pending); d.cashProfit = Math.round((d.revenue - d.offerDeduction - d.cost) * 100) / 100; d.totalProfit = Math.round((d.cashProfit + d.offerDeduction) * 100) / 100; });
    } catch (e) {}
    if (!_okProfit) {
      // DSR / SO never get profit, cost, ledger, payments or offer balance
      ['netCost', 'grossProfit', 'netProfit', 'commission', 'discount', 'damageLoss', 'bonus', 'expenses', 'profitRules', 'normalSales', 'offerDeduction',
        'actualSales', 'cashProfit', 'offerProfit', 'offerReceived', 'offerPending', 'adjustment', 'adjustments', 'companyPayments', 'companyPaymentsTotal', 'offerBalanceAll'].forEach(k => { delete totals[k]; });
      bySR.forEach(x => { delete x.profit; delete x.netCost; }); srPerf.forEach(x => { delete x.profit; delete x.netCost; });
      byProduct.forEach(x => { delete x.profit; delete x.cost; });
      byDate.forEach(x => { delete x.profit; delete x.cost; delete x.cashProfit; delete x.totalProfit; delete x.offerDeduction; delete x.offerPending; });
    }
    res.json({ ok: true, from, to, generatedAt, totals, bySR, byProduct, byDate, srPerformance: srPerf });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};
