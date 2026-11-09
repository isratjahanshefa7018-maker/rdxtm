const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Pagination-safe full-table fetch ──────────────────────────────────
// PostgREST (Supabase's REST layer) silently caps any query at 1000 rows
// by default — no error, it just returns the first page. Anything that
// needs an ALL-TIME aggregate MUST use this instead of a bare
// `await supabase.from(...).select(...)`.
// `queryFactory` must be a FUNCTION that returns a fresh query builder
// each call (so `.range()` can be re-applied per page).
//
// v5.1 (PERF-2): the first page is fetched ALONE. A 5-row result now costs
// exactly ONE database request (it used to fire four). Only when the first
// page is completely full (1000 rows) are further pages fetched, then in
// parallel batches. Pages are ordered by a total order (`id` tiebreaker) so
// no row is skipped/repeated at a page boundary.
const FETCH_ALL_PAGE_SIZE = 1000;
const FETCH_ALL_PARALLEL  = 4;
async function fetchAll(queryFactory, opts) {
  const tie = (opts && opts.tiebreak !== undefined) ? opts.tiebreak : 'id';
  const page = async (i) => {
    let q = queryFactory();
    if (tie) q = q.order(tie, { ascending: true });
    const from = i * FETCH_ALL_PAGE_SIZE;
    const { data, error } = await q.range(from, from + FETCH_ALL_PAGE_SIZE - 1);
    if (error) throw error;
    return data || [];
  };
  const all = [];
  const first = await page(0);
  for (let k = 0; k < first.length; k++) all.push(first[k]);
  if (first.length < FETCH_ALL_PAGE_SIZE) return all;
  let i = 1;
  while (true) {
    const idx = Array.from({ length: FETCH_ALL_PARALLEL }, (_, k) => i + k);
    const pages = await Promise.all(idx.map(page));
    let done = false;
    for (const rows of pages) {
      for (let k = 0; k < rows.length; k++) all.push(rows[k]);
      if (rows.length < FETCH_ALL_PAGE_SIZE) { done = true; break; }
    }
    if (done) break;
    i += FETCH_ALL_PARALLEL;
  }
  return all;
}

// v5.1 (PERF-1) — REAL server-side paging for list screens.
// ?page=1&pageSize=50  (pageSize capped at 200).  Returns {page,pageSize,from,to}
// where from/to are the inclusive .range() bounds. When the caller sends no
// `page` at all, returns null so old clients keep getting the full list.
function pageParams(query, defaultSize) {
  if (!query || query.page === undefined || query.page === '') return null;
  const page = Math.max(1, Math.floor(Number(query.page)) || 1);
  const pageSize = Math.min(200, Math.max(1, Math.floor(Number(query.pageSize)) || defaultSize || 50));
  return { page, pageSize, from: (page - 1) * pageSize, to: page * pageSize - 1 };
}

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function ds(v)  { if (!v) return ''; return String(v).slice(0, 10); }
// v5.1 (CALC-4): "today" is ALWAYS the Asia/Dhaka calendar day. The old UTC
// version returned yesterday between 00:00 and 06:00 Dhaka time.
function today(){ return bdtDateStr(new Date()); }
function now_() { return new Date().toISOString(); }
function str(v, max = 255) { return String(v || '').trim().slice(0, max); }

// ── Asia/Dhaka date helpers (V30 — Daily Report generation) ──────────
// The company operates in Bangladesh; "today"/"yesterday" for report
// generation must follow Asia/Dhaka local time, not the server's UTC
// clock, so the 02:00 auto-generate cron always closes out the correct
// local calendar day regardless of which UTC region Vercel runs it in.
function bdtDateStr(d) {
  d = d || new Date();
  // en-CA locale formats as YYYY-MM-DD, exactly what we need.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function bdtToday() { return bdtDateStr(new Date()); }
function addDaysStr(dateStr, delta) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
function bdtYesterday() { return addDaysStr(bdtToday(), -1); }
// V56 §4 — day-of-week for a plain 'YYYY-MM-DD' string, UTC-based so it's
// independent of server TZ. 0=Sunday..6=Saturday (matches JS Date.getDay()
// convention already used by attendance.js's local _weekdayOfDateStr).
function weekdayOf(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// ── "Salary/Target Month" cycle (V41 update 7) ────────────────────────
// Every monthly calculation in the app (salary, targets, reports, the
// bonus/damage cycle) is scoped NOT to the plain calendar month but to a
// company pay-cycle that runs from the 26th of the previous month through
// the 25th of the "labeled" month — e.g. period "2026-06" ("June") covers
// 2026-05-26 → 2026-06-25. Every place that used to store/query a plain
// 'YYYY-MM' calendar month (salary_settings.month, targets.period,
// product_targets.period, advance_requests.month, ...) keeps the exact
// same 'YYYY-MM' text format — only the date range that label refers to
// has changed, so no schema/data migration is needed, only application
// logic. These helpers are the single source of truth for that mapping;
// every API file that deals with a monthly period should go through them
// instead of re-deriving calendar-month bounds itself.
function cyclePeriodBounds(period) {
  // period = 'YYYY-MM', the label of the month the cycle's 25th falls in.
  const [y, m] = String(period).split('-').map(Number);
  let py = y, pm = m - 1;
  if (pm < 1) { pm = 12; py -= 1; }
  const start = `${py}-${String(pm).padStart(2, '0')}-26`;
  const end   = `${y}-${String(m).padStart(2, '0')}-25`;
  return { start, end };
}
function cyclePeriodForDate(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (d <= 25) return `${y}-${String(m).padStart(2, '0')}`;
  let ny = y, nm = m + 1;
  if (nm > 12) { nm = 1; ny += 1; }
  return `${ny}-${String(nm).padStart(2, '0')}`;
}
function cyclePeriodToday() { return cyclePeriodForDate(bdtToday()); }
// Every ISO date string in a cycle period, inclusive, in order.
function cyclePeriodDates(period) {
  const { start, end } = cyclePeriodBounds(period);
  const dates = [];
  let cur = start;
  while (cur <= end) { dates.push(cur); cur = addDaysStr(cur, 1); }
  return dates;
}
function safeErr(e) {
  if (process.env.NODE_ENV === 'development') return e.message;
  const msg = String(e.message || '');
  if (msg.includes('STOCK_NEGATIVE')) return 'স্টকে পর্যাপ্ত পণ্য নেই — স্টকের চেয়ে বেশি দেওয়া/বিক্রি করা যাবে না';
  if (msg.includes('duplicate') || msg.includes('unique')) return 'এই তথ্য ইতিমধ্যে আছে';
  if (msg.includes('foreign key') || msg.includes('violates')) return 'সম্পর্কিত তথ্য পাওয়া যায়নি';
  if (msg.includes('not found') || msg.includes('PGRST116')) return 'তথ্য পাওয়া যায়নি';
  return 'সার্ভার সমস্যা হয়েছে, আবার চেষ্টা করুন';
}

function mapProduct(r) {
  return {
    id: String(r.id || ''),
    name: r.name || '',
    sku: r.sku || '',
    caseSize: String(r.case_size || 1),
    unitType: r.unit_type || 'কেস',
    // casePrice / casePurchasePrice: source-of-truth bulk (case/jar/poly)
    // prices the owner actually types (AXIION §7 — reverse price entry).
    // purchasePrice / sellingPrice below are the derived per-piece values,
    // computed server-side in products.js, that every transaction uses.
    casePrice: String(r.case_price || 0),
    casePurchasePrice: String(r.case_purchase_price || 0),
    purchasePrice: String(r.purchase_price || 0),
    sellingPrice: String(r.selling_price || 0),
    bonusFreeUnits: String(r.bonus_free_units || 0),
    bonusCasesReq: String(r.bonus_cases_req || 1),
    bonusFreeMoney: String(r.bonus_free_money || 0),
    lowStockAlert: String(r.low_stock_alert || 0),
    thumb: r.thumb || '',
    category: r.category || '',
    sortOrder: r.sort_order != null ? Number(r.sort_order) : 0,
    // V40: running stock balance, maintained by a database trigger
    // (trg_apply_stock_delta) on every transaction insert. Read this
    // directly instead of re-fetching/re-summing full transaction
    // history — see migration_v40_stock_balance.sql.
    currentStock: num(r.current_stock),
    createdAt: r.created_at || ''
  };
}

function mapSR(r) {
  return {
    id: String(r.id || ''),
    name: r.name || '',
    phone: r.phone || '',
    area: r.area || '',
    role: r.role || 'dsr',
    thumb: r.thumb || '',
    soId: String(r.so_id || ''),
    soName: r.so_name || '',
    // displayNo: AXIION §10 — stable per-role numbering, assigned once,
    // never reused, independent of who currently holds the slot.
    // Update #20: matching displayNo across roles (DSR-1 ↔ SO-1, …) is
    // the auto-pair — so_id/soName are set automatically at creation,
    // no manual "connect" handshake exists anymore.
    displayNo: r.display_no != null ? Number(r.display_no) : null,
    // roadId/roadName (Update #22): which Road this SO/DSR belongs to —
    // set automatically via api/srs.js action=road-assign-so, never by
    // manual per-person selection.
    roadId: String(r.road_id || ''),
    roadName: r.road_name || '',
    createdAt: r.created_at || ''
  };
}

function mapShop(r) {
  return {
    id: String(r.id || ''),
    shopNo: r.shop_no || '',
    name: r.name || '',
    keeperName: r.keeper_name || '',
    phone: r.phone || '',
    address: r.address || '',
    lat: r.lat != null ? Number(r.lat) : null,
    lng: r.lng != null ? Number(r.lng) : null,
    assignedDsrId: String(r.assigned_dsr_id || ''),
    assignedDsrName: r.assigned_dsr_name || '',
    roadId: String(r.road_id || ''),
    roadName: r.road_name || '',
    createdAt: r.created_at || ''
  };
}

// Update #51 — Point-of-Sale customer capture. A proper stored record
// (name/phone/address/keeper name — same basic fields as normal shop
// registration) instead of just a free-text customer name.
function mapPosCustomer(r) {
  return {
    id: String(r.id || ''),
    name: r.name || '',
    keeperName: r.keeper_name || '',
    phone: r.phone || '',
    address: r.address || '',
    createdAt: r.created_at || ''
  };
}

// ── Roads feature (Updates #21–27) ──────────────────────────────────
function mapRoad(r) {
  return {
    id: String(r.id || ''),
    name: r.name || '',
    soId: String(r.so_id || ''),
    soName: r.so_name || '',
    dsrId: String(r.dsr_id || ''),
    dsrName: r.dsr_name || '',
    createdAt: r.created_at || ''
  };
}

function mapRoadPlan(r) {
  return {
    id: String(r.id || ''),
    roadId: String(r.road_id || ''),
    roadName: r.road_name || '',
    soId: String(r.so_id || ''),
    soName: r.so_name || '',
    dsrId: String(r.dsr_id || ''),
    dsrName: r.dsr_name || '',
    soVisitDate: r.so_visit_date || '',
    dsrVisitDate: r.dsr_visit_date || '',
    createdBy: r.created_by || '',
    createdAt: r.created_at || ''
  };
}

// V56 §4 — weekly recurring visit-day rule (replaces one-row-per-date
// road_visit_plans for the forward-looking PLAN — road_visit_plans stays
// for old/legacy data, shop_visits still covers the actual-visit audit
// trail). Field names deliberately match mapRoadPlan's output (id,
// roadId, roadName, soId, soName, dsrId, dsrName, createdBy, createdAt)
// so _roadDutyWidget()/_roadDutyBanner() on the front-end work unchanged
// against either shape — only weekday/activeFrom are new/extra.
function mapRoadWeeklyPlan(r) {
  return {
    id: String(r.id || ''),
    roadId: String(r.road_id || ''),
    roadName: r.road_name || '',
    soId: String(r.so_id || ''),
    soName: r.so_name || '',
    dsrId: String(r.dsr_id || ''),
    dsrName: r.dsr_name || '',
    weekday: r.weekday != null ? Number(r.weekday) : null,
    activeFrom: r.active_from || '',
    createdBy: r.created_by || '',
    createdAt: r.created_at || ''
  };
}

function mapShopVisit(r) {
  return {
    id: String(r.id || ''),
    shopId: String(r.shop_id || ''),
    visitRole: r.visit_role || '',
    visitorId: String(r.visitor_id || ''),
    visitorName: r.visitor_name || '',
    visitDate: r.visit_date || '',
    createdAt: r.created_at || ''
  };
}

function mapOrder(r) {
  return {
    id: String(r.id || ''),
    soId: String(r.so_id || ''),
    soName: r.so_name || '',
    items: r.items || [],
    requestedAmount: String(r.requested_amount || 0),
    status: r.status || 'pending',
    modifiedBy: r.modified_by || '',
    modifiedAmount: r.modified_amount != null ? String(r.modified_amount) : '',
    proposedItems: r.proposed_items || null,
    assignedDsrId: String(r.assigned_dsr_id || ''),
    loadStatus: r.load_status || 'not_started',
    loadTicks: r.load_ticks || {},
    approvedBy: r.approved_by || '',
    approvedAt: r.approved_at || '',
    createdAt: r.created_at || '',
    // v60 — simplified flow: what was originally ordered/given (before
    // the DSR adjusted quantities at loading) and when the van load
    // was confirmed (= when stock actually left the warehouse).
    originalItems: r.original_items || null,
    loadedAt: r.loaded_at || ''
  };
}

function mapTx(r) {
  return {
    txId: String(r.tx_id || ''),
    type: r.type || '',
    srId: String(r.sr_id || ''),
    srName: r.sr_name || '',
    date: r.date ? String(r.date).slice(0, 10) : '',
    slipNo: r.slip_no || '',
    productId: String(r.product_id || ''),
    productName: r.product_name || '',
    sku: r.sku || '',
    cases: String(r.cases || 0),
    pcs: String(r.pcs || 0),
    totalUnits: String(r.total_units || 0),
    purchasePrice: String(r.purchase_price || 0),
    sellingPrice: String(r.selling_price || 0),
    totalCost: String(r.total_cost || 0),
    totalRevenue: String(r.total_revenue || 0),
    // V35 — per-item commission/discount, persisted on 'dsr_sale' rows so
    // the DSR Payment page can total today's commission/discount per DSR.
    commissionAmt: String(r.commission_amt || 0),
    discountAmt: String(r.discount_amt || 0),
    // shop_id (Update #49/#51): links a row to a registered shop, when
    // there is one — was already a column on `transactions` but never
    // exposed to the JS side before.
    shopId: String(r.shop_id || ''),
    // customer_id (Update #51): links a point-sale row to a proper
    // pos_customers record when the walk-in customer isn't an existing
    // registered shop.
    customerId: String(r.customer_id || ''),
    note: r.note || '',
    createdAt: r.created_at || '',
    // v5.25 — company-offer deduction stored on the line (0 when none / legacy)
    offerCasePrice: String(r.offer_case_price || 0),
    offerDeductionPerCase: String(r.offer_deduction_per_case || 0),
    offerDeductionTotal: String(r.offer_deduction_total || 0),
    // v5.24 — snapshot of the prices / offer rule at the time of the transaction (null when the rule columns were not selected)
    snap: (r.rule_case_size !== undefined) ? require('./snapshot').snapOfRow(r) : null
  };
}

function mapDmg(r) {
  return {
    id: String(r.id || ''),
    txId: String(r.tx_id || ''),
    productId: String(r.product_id || ''),
    productName: r.product_name || '',
    sku: r.sku || '',
    totalUnits: String(r.total_units || 0),
    purchasePrice: String(r.purchase_price || 0),
    totalCost: String(r.total_cost || 0),
    date: r.date ? String(r.date).slice(0, 10) : '',
    srId: String(r.sr_id || ''),
    srName: r.sr_name || '',
    status: r.status || 'pending',
    clearedDate: r.cleared_date ? String(r.cleared_date).slice(0, 10) : '',
    createdAt: r.created_at || ''
  };
}

function mapBonus(r) {
  return {
    id: String(r.id || ''),
    productId: String(r.product_id || ''),
    productName: r.product_name || '',
    sku: r.sku || '',
    fromDate: r.from_date ? String(r.from_date).slice(0, 10) : '',
    toDate: r.to_date ? String(r.to_date).slice(0, 10) : '',
    givenUnits: String(r.given_units || 0),
    bonusAmount: String(r.bonus_amount || 0),
    status: r.status || '',
    clearedDate: r.cleared_date ? String(r.cleared_date).slice(0, 10) : '',
    note: r.note || '',
    createdAt: r.created_at || ''
  };
}

function mapPayment(r) {
  return {
    id: String(r.id || ''),
    srId: String(r.sr_id || ''),
    srName: r.sr_name || '',
    date: r.date ? String(r.date).slice(0, 10) : '',
    amount: String(r.amount || 0),
    cashAmount: String(r.cash_amount || 0),
    commissionAmt: String(r.commission_amt || 0),
    discountAmt: String(r.discount_amt || 0),
    damageAmt: String(r.damage_amt || 0),
    note: r.note || '',
    createdAt: r.created_at || ''
  };
}

function mapExpCat(r) {
  return { id: String(r.id || ''), name: r.name || '', createdAt: r.created_at || '' };
}
function mapExpRecord(r) {
  return {
    id: String(r.id || ''),
    categoryId: String(r.category_id || ''),
    categoryName: r.category_name || '',
    date: r.date ? String(r.date).slice(0, 10) : '',
    amount: String(r.amount || 0),
    note: r.note || '',
    createdAt: r.created_at || ''
  };
}
function mapDue(r) {
  return {
    id: String(r.id || ''),
    dsrId: String(r.dsr_id || ''),
    dsrName: r.dsr_name || '',
    clientType: r.client_type || 'dsr',
    shopId: String(r.shop_id || ''),
    shopName: r.shop_name || '',
    dueDate: r.due_date ? String(r.due_date).slice(0,10) : '',
    amount: String(r.amount || 0),
    paidAmount: String(r.paid_amount || 0),
    note: r.note || '',
    status: r.status || 'pending',
    clearedDate: r.cleared_date ? String(r.cleared_date).slice(0,10) : '',
    createdAt: r.created_at || '',
    txId: String(r.tx_id || '')
  };
}

function mapChatMsg(r) {
  return {
    id:         String(r.id || ''),
    senderId:   String(r.sender_id || ''),
    senderName: r.sender_name || '',
    senderRole: r.sender_role || '',
    message:    r.message || '',
    createdAt:  r.created_at || ''
  };
}

function calcStock(allTx) {
  const m = {};
  allTx.forEach(r => {
    const pid = r.productId; if (!pid) return;
    if (!m[pid]) m[pid] = 0;
    const u = num(r.totalUnits);
    if (r.type === 'buy')    m[pid] += u;
    if (r.type === 'give')   m[pid] -= u;
    if (r.type === 'return') m[pid] += u;
    // v60 — 'return_company': stock sent back to the company, leaves the warehouse.
    if (r.type === 'return_company') m[pid] -= u;
    // V35 — 'damage' deliberately does NOT touch stock. Damage is only a
    // reporting/reimbursement record (see dmg_claims + DSR payment page);
    // the physical product was already removed from warehouse stock at
    // 'give' time (or was never in warehouse stock if damaged before
    // being given out), so subtracting it again here would incorrectly
    // double-count the loss.
    if (r.type === 'point_sale')          m[pid] -= u;
    if (r.type === 'point_damage_return') m[pid] += u;
    // 'dsr_sale' (V31) is a DSR selling stock he ALREADY took via 'give' —
    // that stock left the warehouse and was deducted already at give-time,
    // so a dsr_sale row deliberately does NOT touch stock again here.
  });
  return m;
}

// Sign of a transaction for BONUS purposes (net pieces sold).
function _bonusSign(type) {
  return (type === 'give' || type === 'point_sale') ? 1
       : (type === 'return' || type === 'point_damage_return') ? -1 : 0;
}

// ══════════════════════════════════════════════════════════════════════
//  BONUS  (CALC-3, v5.1)
// ══════════════════════════════════════════════════════════════════════
// ONE bonus model: a pure date-range calculation, no "cleared" bookkeeping.
//   net pieces sold in [from,to] = give + point_sale − return − point_damage_return
//   bonus = floor( floor(net / case_size) / cases_required ) × free units (or money)
// The rule used is the one SNAPSHOTTED on each transaction row (columns
// rule_*), so editing a product later never rewrites an old period. Rows
// written before v5.1 have no snapshot and fall back to the product's
// current rule (exactly what the old code did).
// Every screen (dashboard card, bonus report, profit) calls this one function.
async function _bonusGroups(from, to) {
  try {
    const { data, error } = await supabase.rpc('bonus_net_units', { p_from: from, p_to: to });
    if (error) throw error;
    return (data || []).map(r => ({
      productId: String(r.product_id || ''), cs: r.case_size, bcr: r.bonus_cases_req,
      free: r.bonus_free_units, money: r.bonus_free_money,
      net: num(r.net_units), outUnits: num(r.out_units), outCost: num(r.out_cost)
    }));
  } catch (e) {
    // function not installed yet → slower, identical result
    const rows = await fetchAll(() => supabase.from('transactions')
      .select('product_id,type,total_units,total_cost,rule_case_size,rule_bonus_cases_req,rule_bonus_free_units,rule_bonus_free_money')
      .in('type', ['give', 'return', 'point_sale', 'point_damage_return']).gte('date', from).lte('date', to));
    const g = {};
    rows.forEach(r => {
      const k = [r.product_id, r.rule_case_size, r.rule_bonus_cases_req, r.rule_bonus_free_units, r.rule_bonus_free_money].join('|');
      const o = g[k] || (g[k] = { productId: String(r.product_id || ''), cs: r.rule_case_size, bcr: r.rule_bonus_cases_req,
        free: r.rule_bonus_free_units, money: r.rule_bonus_free_money, net: 0, outUnits: 0, outCost: 0 });
      const sign = _bonusSign(r.type), u = num(r.total_units);
      o.net += sign * u;
      if (sign > 0) { o.outUnits += u; o.outCost += num(r.total_cost); }
    });
    return Object.values(g);
  }
}

async function computeBonusRangeSummary(from, to) {
  const [prodsRaw, groups] = await Promise.all([
    fetchAll(() => supabase.from('products').select('*').order('created_at')),
    _bonusGroups(from, to)
  ]);
  const prods = (prodsRaw || []).map(mapProduct);
  const byId = {}; prods.forEach(p => { byId[p.id] = p; });
  const acc = {};
  groups.forEach(gr => {
    const p = byId[gr.productId]; if (!p) return;
    // snapshot rule if present, else the product's current rule
    const cs   = (gr.cs   != null ? num(gr.cs)   : num(p.caseSize))      || 1;
    const bcr  = (gr.bcr  != null ? num(gr.bcr)  : num(p.bonusCasesReq)) || 1;
    // v5.24 — a legacy line (no snapshot) never gets today's offer
    const free = gr.free  != null ? num(gr.free)  : 0;
    const mny  = gr.money != null ? num(gr.money) : 0;
    if (free <= 0 && mny <= 0) {
      const a0 = acc[p.id] || (acc[p.id] = { totalGiven: 0, totalCases: 0, bonusUnits: 0, bonusMoney: 0, amount: 0 });
      a0.totalGiven += Math.max(0, gr.net); return;
    }
    const given = Math.max(0, gr.net);
    const cases = Math.floor(given / cs + 1e-9);
    const mult  = Math.floor(cases / bcr + 1e-9);
    const avgPP = gr.outUnits > 0 ? gr.outCost / gr.outUnits : num(p.purchasePrice);
    const a = acc[p.id] || (acc[p.id] = { totalGiven: 0, totalCases: 0, bonusUnits: 0, bonusMoney: 0, amount: 0 });
    a.totalGiven += given; a.totalCases += cases;
    a.bonusUnits += mult * free; a.bonusMoney += mult * mny;
    a.amount += mult * free * avgPP + mult * mny;
  });
  return prods.filter(p => num(p.bonusFreeUnits) > 0 || num(p.bonusFreeMoney) > 0 || (acc[p.id] && acc[p.id].amount > 0)).map(p => {
    const a = acc[p.id] || { totalGiven: 0, totalCases: 0, bonusUnits: 0, bonusMoney: 0, amount: 0 };
    return {
      productId: p.id, name: p.name, sku: p.sku, thumb: p.thumb || '',
      caseSize: num(p.caseSize) || 1, purchasePrice: num(p.purchasePrice), sellingPrice: num(p.sellingPrice),
      bonusFreeUnits: num(p.bonusFreeUnits), bonusCasesReq: num(p.bonusCasesReq) || 1, bonusFreeMoney: num(p.bonusFreeMoney || 0),
      totalGiven: a.totalGiven, totalCases: a.totalCases, bonusUnits: a.bonusUnits, bonusMoney: a.bonusMoney,
      amount: Math.round(a.amount * 100) / 100
    };
  });
}

// ══════════════════════════════════════════════════════════════════════
//  PROFIT  (CALC-1, v5.1) — ONE definition, used by the dashboard
//  (today / month / range) and by the report.
//
//    gross profit = revenue − purchase cost            (give + point_sale − return − point_damage_return)
//    net profit   = gross profit
//                   − commission  − discount           (sr_payments, by payment date)
//                   − damage loss                      (dmg_claims.total_cost, van damage + shop damage collection, by date)
//                   − bonus                            (computeBonusRangeSummary)
//                   − expenses                         (exp_records)
//  Each deduction can be switched off in app_settings.profit_rules (owner
//  Settings page); the full breakdown is always returned so the screen can
//  show every line.
// ══════════════════════════════════════════════════════════════════════
// v5.7 — NET profit = gross profit − commission ONLY. Discount, damage, bonus and expenses are
// no longer deducted (they are still returned as separate figures for display). The rules are
// fixed here on purpose so an old saved `profit_rules` row can never switch them back on.
const DEFAULT_PROFIT_RULES = { commission: true, discount: false, damage: false, bonus: false, expenses: false };
async function getProfitRules() {
  try {
    const { data, error } = await supabase.from('app_settings').select('profit_rules').eq('id', 1).maybeSingle();
    if (error) throw error;
    return Object.assign({}, DEFAULT_PROFIT_RULES);
  } catch (e) { return Object.assign({}, DEFAULT_PROFIT_RULES); }
}

async function getSalesSummary(from, to) {
  try {
    const { data, error } = await supabase.rpc('sales_summary', { p_from: from, p_to: to });
    if (error) throw error;
    const r = (data && data[0]) || {};
    return { outRev: num(r.out_rev), inRev: num(r.in_rev), outCost: num(r.out_cost), inCost: num(r.in_cost), outUnits: num(r.out_units), inUnits: num(r.in_units) };
  } catch (e) {
    const rows = await fetchAll(() => supabase.from('transactions').select('type,total_units,total_revenue,total_cost')
      .in('type', ['give', 'return', 'point_sale', 'point_damage_return']).gte('date', from).lte('date', to));
    const o = { outRev: 0, inRev: 0, outCost: 0, inCost: 0, outUnits: 0, inUnits: 0 };
    rows.forEach(r => {
      if (r.type === 'give' || r.type === 'point_sale') { o.outRev += num(r.total_revenue); o.outCost += num(r.total_cost); o.outUnits += num(r.total_units); }
      else { o.inRev += num(r.total_revenue); o.inCost += num(r.total_cost); o.inUnits += num(r.total_units); }
    });
    return o;
  }
}

async function getProfitExtras(from, to) {
  try {
    const { data, error } = await supabase.rpc('profit_extras', { p_from: from, p_to: to });
    if (error) throw error;
    const r = (data && data[0]) || {};
    return { commission: num(r.commission), discount: num(r.discount), damageLoss: num(r.damage_loss), expenses: num(r.expenses) };
  } catch (e) {
    const [pay, dmg, exp] = await Promise.all([
      fetchAll(() => supabase.from('sr_payments').select('commission_amt,discount_amt').gte('date', from).lte('date', to)),
      fetchAll(() => supabase.from('dmg_claims').select('total_cost').gte('date', from).lte('date', to)),
      fetchAll(() => supabase.from('exp_records').select('amount').gte('date', from).lte('date', to))
    ]);
    return {
      commission: pay.reduce((s, r) => s + num(r.commission_amt), 0),
      discount: pay.reduce((s, r) => s + num(r.discount_amt), 0),
      damageLoss: dmg.reduce((s, r) => s + num(r.total_cost), 0),
      expenses: exp.reduce((s, r) => s + num(r.amount), 0)
    };
  }
}

async function computeProfit(from, to) {
  const [sales, extras, bonusRows, rules] = await Promise.all([
    getSalesSummary(from, to), getProfitExtras(from, to), computeBonusRangeSummary(from, to), getProfitRules()
  ]);
  const r2_ = n => Math.round((num(n) + Number.EPSILON) * 100) / 100;
  const revenue = sales.outRev - sales.inRev;
  const cost = sales.outCost - sales.inCost;
  const grossProfit = revenue - cost;
  const bonus = bonusRows.reduce((s, b) => s + num(b.amount), 0);
  const net = grossProfit
    - (rules.commission ? extras.commission : 0)
    - (rules.discount   ? extras.discount   : 0)
    - (rules.damage     ? extras.damageLoss : 0)
    - (rules.bonus      ? bonus             : 0)
    - (rules.expenses   ? extras.expenses   : 0);
  // v5.27 — offer split. total (netProfit) = cash profit + offer profit (+ সমন্বয় on its payment date).
  // revenue stays the GROSS (normal) sale; actual sales = gross − company offer deduction (stored snapshots only).
  let off = { earned: 0, sold: 0, returned: 0, received: 0, pending: 0, adjustment: 0, adjustments: [], payments: [], settledBy: [], balanceAll: 0 };
  try { off = await require('./offerLedger').profitOffer(from, to); } catch (e) {}
  const actualSales = revenue - off.earned;
  const cashProfit = actualSales - cost - (rules.commission ? extras.commission : 0)
    - (rules.discount ? extras.discount : 0) - (rules.damage ? extras.damageLoss : 0) - (rules.bonus ? bonus : 0) - (rules.expenses ? extras.expenses : 0);
  const totalProfit = cashProfit + off.earned + off.adjustment;
  return {
    from, to, rules,
    revenue: r2_(revenue), cost: r2_(cost), grossProfit: r2_(grossProfit),
    commission: r2_(extras.commission), discount: r2_(extras.discount), damageLoss: r2_(extras.damageLoss),
    bonus: r2_(bonus), expenses: r2_(extras.expenses),
    netProfit: r2_(totalProfit),
    normalSales: r2_(revenue), offerDeduction: r2_(off.earned), actualSales: r2_(actualSales),
    cashProfit: r2_(cashProfit), offerProfit: r2_(off.earned), offerReceived: r2_(off.received), offerPending: r2_(off.pending),
    adjustment: r2_(off.adjustment), adjustments: off.adjustments, companyPayments: off.payments, settledBy: off.settledBy,
    offerBalanceAll: r2_(off.balanceAll),
    givenUnits: sales.outUnits, returnUnits: sales.inUnits
  };
}

// ══════════════════════════════════════════════════════════════════════
//  SMALL AGGREGATES (PERF-3, v5.1)
//  The dashboards used to download every transaction row of the month and
//  add them up in Node. These are summed INSIDE Postgres and return a few
//  numbers per person / product. Each has an identical (slower) fallback so
//  the app keeps working before the SQL migration has been run.
// ══════════════════════════════════════════════════════════════════════
async function _rpcOr(name, args, fallback) {
  try {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw error;
    return data || [];
  } catch (e) { return fallback(); }
}

// per SR: out = give+point_sale, in = return+point_damage_return, plus give/return only
async function getSrSalesTotals(from, to) {
  const rows = await _rpcOr('sr_sales_totals', { p_from: from, p_to: to }, async () => {
    const tx = await fetchAll(() => supabase.from('transactions').select('sr_id,type,total_units,total_revenue')
      .in('type', ['give', 'return', 'point_sale', 'point_damage_return']).gte('date', from).lte('date', to));
    const m = {};
    tx.forEach(r => {
      const sid = String(r.sr_id || ''); if (!sid) return;
      const o = m[sid] || (m[sid] = { sr_id: sid, out_rev: 0, in_rev: 0, out_units: 0, in_units: 0, give_rev: 0, give_units: 0, ret_rev: 0, ret_units: 0 });
      const u = num(r.total_units), v = num(r.total_revenue);
      if (r.type === 'give' || r.type === 'point_sale') { o.out_rev += v; o.out_units += u; }
      else { o.in_rev += v; o.in_units += u; }
      if (r.type === 'give') { o.give_rev += v; o.give_units += u; }
      if (r.type === 'return') { o.ret_rev += v; o.ret_units += u; }
    });
    return Object.values(m);
  });
  const out = {};
  rows.forEach(r => {
    const sid = String(r.sr_id || ''); if (!sid) return;
    out[sid] = { outRev: num(r.out_rev), inRev: num(r.in_rev), outUnits: num(r.out_units), inUnits: num(r.in_units),
      giveRev: num(r.give_rev), giveUnits: num(r.give_units), retRev: num(r.ret_rev), retUnits: num(r.ret_units) };
  });
  return out;
}

// per product: net pieces sold (give+point_sale − return − point_damage_return)
// ── v5.4 display helpers: exact "cases + loose pieces" totals ─────────────
// Units are summed PER PRODUCT first and then split with THAT product's own
// case size, so the answer is exact (never a bare total-piece count).
function cpSplit(unitsByProduct, csMap) {
  let cases = 0, pcs = 0;
  // v5.11 — per-unit-type breakdown. A shop can sell কেস, ডজন, কার্টুন and পলি
  // products together; "5 কেস" must not swallow the ডজন / পলি packs. The unit
  // name of each product comes from csMap.__ut (see withUnits) — when it is not
  // supplied the old cases + pcs result is returned unchanged.
  const ut = (csMap && csMap.__ut) || null, by = {};
  Object.keys(unitsByProduct || {}).forEach(k => {
    const cs = Math.max(1, Math.round(num((csMap || {})[k])) || 1);
    const u  = Math.max(0, Math.round(num(unitsByProduct[k])));
    const c = Math.floor(u / cs);
    cases += c; pcs += u % cs;
    if (ut && c > 0) { const n = ut[k] || 'কেস'; by[n] = (by[n] || 0) + c; }
  });
  const out = { cases, pcs };
  if (ut) out.by = Object.keys(by).map(n => ({ unit: n, cases: by[n] }));
  return out;
}
// attach the product → unit-name map to a case-size map (non-enumerable, so
// Object.keys / JSON of the map itself never changes)
function withUnits(csMap, products) {
  const ut = {};
  (products || []).forEach(p => { ut[String(p.id)] = String(p.unit_type || p.unitType || 'কেস'); });
  Object.defineProperty(csMap, '__ut', { value: ut, enumerable: false, configurable: true });
  return csMap;
}
// rows: [{type, productId|product_id, totalUnits|total_units}]  groups: { name: [types…] }
function cpGroups(rows, csMap, groups) {
  const acc = {}; Object.keys(groups).forEach(g => { acc[g] = {}; });
  (rows || []).forEach(r => {
    const pid = String(r.productId != null ? r.productId : (r.product_id || ''));
    const u = num(r.totalUnits != null ? r.totalUnits : r.total_units);
    Object.keys(groups).forEach(g => { if (groups[g].indexOf(r.type) >= 0) acc[g][pid] = (acc[g][pid] || 0) + u; });
  });
  const out = {}; Object.keys(groups).forEach(g => { out[g] = cpSplit(acc[g], csMap); });
  return out;
}
async function getCaseTotals(from, to, groups, srId) {
  const types = Array.from(new Set([].concat.apply([], Object.keys(groups).map(g => groups[g]))));
  const [tx, pr] = await Promise.all([
    fetchAll(() => { let q = supabase.from('transactions').select('product_id,type,total_units').in('type', types).gte('date', from).lte('date', to); if (srId) q = q.eq('sr_id', srId); return q; }),
    fetchAll(() => supabase.from('products').select('id,case_size,unit_type'))
  ]);
  const cs = {}; pr.forEach(p => { cs[String(p.id)] = num(p.case_size) || 1; }); withUnits(cs, pr);
  return cpGroups(tx, cs, groups);
}

async function getProductNetUnits(from, to) {
  const rows = await _rpcOr('product_sales_totals', { p_from: from, p_to: to }, async () => {
    const tx = await fetchAll(() => supabase.from('transactions').select('product_id,type,total_units')
      .in('type', ['give', 'return', 'point_sale', 'point_damage_return']).gte('date', from).lte('date', to));
    const m = {};
    tx.forEach(r => { const k = String(r.product_id || ''); if (!k) return; m[k] = (m[k] || 0) + _bonusSign(r.type) * num(r.total_units); });
    return Object.keys(m).map(k => ({ product_id: k, net_units: m[k] }));
  });
  const out = {};
  rows.forEach(r => { out[String(r.product_id || '')] = num(r.net_units); });
  return out;
}

async function getPaymentsTotal(from, to) {
  const rows = await _rpcOr('payments_total', { p_from: from, p_to: to }, async () => {
    const pay = await fetchAll(() => supabase.from('sr_payments').select('amount').gte('date', from).lte('date', to));
    return [{ total: pay.reduce((s, r) => s + num(r.amount), 0) }];
  });
  // a scalar-returning SQL function comes back as a bare number
  const r0 = rows;
  if (typeof r0 === 'number') return r0;
  if (Array.isArray(r0)) return r0.length && typeof r0[0] === 'object' ? num(r0[0].total) : num(r0[0]);
  return num(r0);
}

// warehouse movement of one day per product (for "yesterday's closing stock")
async function getStockMovement(date) {
  const SIGN = { buy: 1, give: -1, return: 1, point_sale: -1, point_damage_return: 1, return_company: -1 };
  const rows = await _rpcOr('stock_movement', { p_date: date }, async () => {
    const tx = await fetchAll(() => supabase.from('transactions').select('product_id,type,total_units').eq('date', date).in('type', Object.keys(SIGN)));
    const m = {};
    tx.forEach(r => { const k = String(r.product_id || ''); if (!k) return; m[k] = (m[k] || 0) + SIGN[r.type] * num(r.total_units); });
    return Object.keys(m).map(k => ({ product_id: k, delta: m[k] }));
  });
  const out = {};
  rows.forEach(r => { out[String(r.product_id || '')] = num(r.delta); });
  return out;
}

// ══════════════════════════════════════════════════════════════════════
//  VAN STOCK + DUE PAYMENT HELPERS
// ══════════════════════════════════════════════════════════════════════
// What is physically left on ONE DSR's van, CARRIED OVER across days
// (CALC-2, v5.1). Stock a DSR did not hand back no longer vanishes at
// midnight:
//   given − returned − sold-to-shops − damage − damage-exchange replacements
//   summed over EVERY day up to and including `date`.
// Damage claims created by "damage collection" (tx_id starts with 'dc:')
// are goods taken back FROM a shop, never from the van, so they are
// always ignored here.
//   opts.damage = 'cleared' (default) — only Owner-cleared van damage is
//                 subtracted (the selling screen);
//   opts.damage = 'all' — every van-damage claim is subtracted (the
//                 end-of-day settlement).
// Returns { stock: {productId: units}, give: {productId: {u, v}} } where
// `give` is lifetime given units / value (for the return price).
async function computeVanDetail(dsrId, date, opts) {
  const mode = (opts && opts.damage) || 'cleared';
  const upto = date || bdtToday();
  try {
    const { data, error } = await supabase.rpc('van_stock_totals', { p_dsr_id: String(dsrId), p_upto: upto, p_all_damage: mode === 'all' });
    if (error) throw error;
    const stock = {}, give = {};
    (data || []).forEach(r => {
      const k = String(r.product_id || ''); if (!k) return;
      const q = Math.max(0, +num(r.qty).toFixed(4));
      if (q > 0) stock[k] = q;
      give[k] = { u: num(r.give_units), v: num(r.give_rev) };
    });
    return { stock, give };
  } catch (e) {
    // function not installed yet → same numbers, slower
    const [tx, dmg, exch] = await Promise.all([
      fetchAll(() => supabase.from('transactions').select('type,product_id,total_units,total_revenue')
        .eq('sr_id', String(dsrId)).lte('date', upto).in('type', ['give', 'return', 'dsr_sale', 'dsr_sale_return'])),
      fetchAll(() => {
        let q = supabase.from('dmg_claims').select('product_id,total_units,status,tx_id')
          .eq('sr_id', String(dsrId)).lte('date', upto);
        if (mode !== 'all') q = q.eq('status', 'cleared');
        return q;
      }),
      fetchAll(() => supabase.from('damage_collections').select('exch_product_id,exch_units')
        .eq('dsr_id', String(dsrId)).lte('date', upto).eq('resolution', 'exchange'))
    ]);
    const st = {}, give = {};
    const add = (pid, delta) => { pid = String(pid || ''); if (!pid) return; st[pid] = (st[pid] || 0) + delta; };
    tx.forEach(r => {
      add(r.product_id, (r.type === 'give' || r.type === 'dsr_sale_return') ? num(r.total_units) : -num(r.total_units));
      if (r.type === 'give') { const k = String(r.product_id); const g = give[k] || (give[k] = { u: 0, v: 0 }); g.u += num(r.total_units); g.v += num(r.total_revenue); }
    });
    dmg.forEach(r => { if (String(r.tx_id || '').startsWith('dc:')) return; add(r.product_id, -num(r.total_units)); });
    exch.forEach(r => add(r.exch_product_id, -num(r.exch_units)));
    const stock = {};
    Object.keys(st).forEach(k => { const q = Math.max(0, +st[k].toFixed(4)); if (q > 0) stock[k] = q; });
    return { stock, give };
  }
}
async function computeVanStock(dsrId, date, opts) {
  return (await computeVanDetail(dsrId, date, opts)).stock;
}

// Applies a payment to ONE due_calendar row: caps at what is still owed,
// guards against a concurrent double-write (optimistic check on
// paid_amount) and — for shop dues — logs a due_collections row so the
// end-of-day settlement knows exactly how much cash the DSR collected
// today. Returns { applied, paidAmount, remaining, status, conflict? }.
// v5.1 (CALC-6): amounts are kept to 2 decimals and a remainder under
// ৳0.01 counts as fully paid, so a due can never get stuck on a rounding crumb.
async function applyDuePayment(dueId, pay, meta) {
  meta = meta || {};
  const R = n => Math.round((num(n) + Number.EPSILON) * 100) / 100;
  const { data: cur, error } = await supabase.from('due_calendar').select('*').eq('id', dueId).single();
  if (error) throw error;
  const total = R(cur.amount), already = R(cur.paid_amount);
  const applied = R(Math.min(num(pay), Math.max(0, total - already)));
  if (applied <= 0) return { applied: 0, paidAmount: already, remaining: Math.max(0, R(total - already)), status: cur.status };
  let newPaid = R(already + applied);
  let remaining = R(total - newPaid);
  if (remaining < 0.01) { remaining = 0; newPaid = total; }
  const status = remaining <= 0 ? 'cleared' : 'partial';
  const date = meta.date || bdtToday();
  const { data: upd, error: uErr } = await supabase.from('due_calendar').update({
    paid_amount: newPaid, status, cleared_date: status === 'cleared' ? date : null
  }).eq('id', dueId).eq('paid_amount', cur.paid_amount).select('id');
  if (uErr) throw uErr;
  if (!upd || !upd.length) return { applied: 0, conflict: true, paidAmount: already, remaining: Math.max(0, R(total - already)), status: cur.status };
  const logged = R(newPaid - already);   // includes a swallowed rounding crumb
  if (cur.client_type === 'shop') {
    // v5.21 — dsr_id = whoever HOLDS the cash (a DSR / an SO); '' when the owner or a manager took it
    // (the company already has it, so no DSR's day-end cash goes up). credit_* = the shop's own DSR, who
    // gets the credit for the collection. collector_* = who actually took the money.
    const row = {
      due_id: String(dueId), shop_id: String(cur.shop_id || ''), shop_name: cur.shop_name || '',
      dsr_id: meta.noCashHolder ? '' : String(meta.dsrId || cur.dsr_id || ''), dsr_name: meta.noCashHolder ? '' : (meta.dsrName || cur.dsr_name || ''),
      date, amount: logged, created_at: now_()
    };
    const ext = (meta.creditId || meta.collectorId) ? {
      credit_dsr_id: String(meta.creditId || ''), credit_dsr_name: String(meta.creditName || ''),
      collector_id: String(meta.collectorId || ''), collector_name: String(meta.collectorName || ''), collector_role: String(meta.collectorRole || '')
    } : null;
    let ins = await supabase.from('due_collections').insert(ext ? Object.assign({}, row, ext) : row);
    // migrations/005_v5_21.sql not run yet → save the plain row (the money is still recorded)
    if (ins.error && ext && /credit_dsr|collector_/i.test(String(ins.error.message || ''))) {
      if (meta.noCashHolder) row.dsr_id = String(meta.creditId || cur.dsr_id || ''), row.dsr_name = String(meta.creditName || cur.dsr_name || '');
      ins = await supabase.from('due_collections').insert(row);
    }
    if (ins.error) throw ins.error;
  }
  return { applied: logged, paidAmount: newPaid, remaining, status };
}

// ── Audit trail (CALC-7) — best effort, never blocks the real action ──
async function auditLog(actor, action, table, rowId, oldData, newData) {
  try {
    await supabase.from('audit_log').insert({
      actor_id: String((actor && actor.id) || ''), actor_role: String((actor && actor.role) || ''),
      action, table_name: table, row_id: String(rowId || ''), old_data: oldData || null, new_data: newData || null
    });
  } catch (e) { /* table not installed yet — ignore */ }
}

// ── Idempotency (CALC-8) ──────────────────────────────────────────────
// The browser attaches a `requestId` to every money-writing POST. A double
// tap / network retry carries the SAME id, so the second call gets the
// first call's answer back instead of writing everything twice.
// Failed requests are never remembered, so a retry after an error works.
const _RID_RE = /^[A-Za-z0-9_-]{8,80}$/;
function _noTable(err) {
  const m = String((err && (err.code || '')) + ' ' + String((err && err.message) || ''));
  return /42P01|PGRST205|does not exist|schema cache/i.test(m);
}
async function idemRun(req, res, scope, fn) {
  const rid = req && req.body && typeof req.body.requestId === 'string' ? req.body.requestId.trim() : '';
  if (!_RID_RE.test(rid)) return fn();
  const key = scope + ':' + rid;
  const claim = await supabase.from('idempotency_keys').insert({ key, response: null });
  if (claim.error) {
    if (_noTable(claim.error)) return fn();
    const { data: ex } = await supabase.from('idempotency_keys').select('response,created_at').eq('key', key).maybeSingle();
    if (ex && ex.response) return res.json(Object.assign({}, ex.response, { replayed: true }));
    const age = ex ? Date.now() - new Date(ex.created_at).getTime() : 1e9;
    if (age < 60000) return res.json({ ok: false, error: 'আগের অনুরোধটি এখনও চলছে — একটু অপেক্ষা করুন, আবার চাপবেন না' });
    // an old claim from a crashed request — take it over
    await supabase.from('idempotency_keys').delete().eq('key', key);
    const again = await supabase.from('idempotency_keys').insert({ key, response: null });
    if (again.error) return res.json({ ok: false, error: 'আগের অনুরোধটি এখনও চলছে — একটু অপেক্ষা করুন' });
  }
  const origJson = res.json.bind(res), origStatus = res.status.bind(res);
  let captured, code = null;
  res.status = (c) => { code = c; return res; };
  res.json = (p) => { captured = p; return res; };
  try {
    await fn();
  } catch (e) {
    res.json = origJson; res.status = origStatus;
    try { await supabase.from('idempotency_keys').delete().eq('key', key); } catch (_) {}
    throw e;
  }
  res.json = origJson; res.status = origStatus;
  try {
    if (captured && captured.ok) await supabase.from('idempotency_keys').update({ response: captured }).eq('key', key);
    else await supabase.from('idempotency_keys').delete().eq('key', key);
    if (Math.random() < 0.02) await supabase.from('idempotency_keys').delete().lt('created_at', new Date(Date.now() - 7 * 86400000).toISOString());
  } catch (_) {}
  if (code) origStatus(code);
  return origJson(captured);
}

// Stock guard switch (app_settings.block_negative_stock, default ON).
async function blockNegativeStock() {
  try {
    const { data, error } = await supabase.from('app_settings').select('block_negative_stock').eq('id', 1).maybeSingle();
    if (error) throw error;
    return !(data && data.block_negative_stock === false);
  } catch (e) { return true; }
}


// ══════════════════════════════════════════════════════════════════════
//  LIFETIME DUE TOTALS — ONE source of truth for every panel
// ══════════════════════════════════════════════════════════════════════
// due = (Σ give revenue − Σ return revenue) − Σ payments, per DSR/SO.
// Previously each dashboard (Owner / Manager / SO / DSR) pulled the WHOLE
// transactions + sr_payments history into Node and summed it there, and
// some of those payment reads were not paginated — so the same DSR showed
// a different DU depending on which panel asked. Now every panel calls
// this. When the `dsr_due_totals` SQL function exists the
// sums are done inside Postgres in one tiny query (fast, exact, no 1000-row
// cap possible); if it isn't installed yet it falls back to the paginated
// JS path, which gives the identical numbers, just slower.
// Returns { [srId]: { givenRev, returnRev, givenUnits, returnUnits, payments } }
async function getDueTotals(srIds) {
  const ids = Array.isArray(srIds) ? srIds.map(String).filter(Boolean) : null;
  if (ids && !ids.length) return {};
  const out = {};
  const slot = (sid) => (out[sid] = out[sid] || { givenRev: 0, returnRev: 0, givenUnits: 0, returnUnits: 0, payments: 0 });
  try {
    const { data, error } = await supabase.rpc('dsr_due_totals', { p_sr_ids: ids });
    if (error) throw error;
    (data || []).forEach(r => {
      const sid = String(r.sr_id || ''); if (!sid) return;
      const o = slot(sid);
      o.givenRev = num(r.given_rev); o.returnRev = num(r.return_rev);
      o.givenUnits = num(r.given_units); o.returnUnits = num(r.return_units);
      o.payments = num(r.paid);
    });
    return out;
  } catch (e) {
    // fall through to the slower, still-correct paginated path
  }
  const [tx, pay] = await Promise.all([
    fetchAll(() => {
      let q = supabase.from('transactions').select('type,sr_id,total_units,total_revenue').in('type', ['give', 'return']);
      if (ids) q = q.in('sr_id', ids);
      return q;
    }),
    fetchAll(() => {
      let q = supabase.from('sr_payments').select('sr_id,amount');
      if (ids) q = q.in('sr_id', ids);
      return q;
    })
  ]);
  tx.forEach(r => {
    const sid = String(r.sr_id || ''); if (!sid) return;
    const o = slot(sid);
    if (r.type === 'give')   { o.givenRev += num(r.total_revenue);  o.givenUnits += num(r.total_units); }
    if (r.type === 'return') { o.returnRev += num(r.total_revenue); o.returnUnits += num(r.total_units); }
  });
  pay.forEach(r => { const sid = String(r.sr_id || ''); if (sid) slot(sid).payments += num(r.amount); });
  return out;
}

module.exports = {
  supabase, getDueTotals, cors, num, ds, today, now_, str, safeErr, fetchAll, pageParams,
  mapProduct, mapSR, mapTx, mapDmg, mapBonus, mapPayment,
  mapExpCat, mapExpRecord, mapDue, mapChatMsg, mapShop, mapOrder,
  mapRoad, mapRoadPlan, mapRoadWeeklyPlan, mapShopVisit, mapPosCustomer,
  calcStock, computeBonusRangeSummary,
  bdtDateStr, bdtToday, addDaysStr, bdtYesterday, weekdayOf,
  cyclePeriodBounds, cyclePeriodForDate, cyclePeriodToday, cyclePeriodDates,
  computeVanStock, computeVanDetail, applyDuePayment, _bonusSign,
  getSalesSummary, getProfitExtras, getProfitRules, computeProfit, DEFAULT_PROFIT_RULES,
  getSrSalesTotals, getProductNetUnits, getPaymentsTotal, getStockMovement,
  auditLog, idemRun, blockNegativeStock,
  cpSplit, cpGroups, getCaseTotals, withUnits
};
