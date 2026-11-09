// claims.js — merged bonus.js + damage.js, routed by ?type=bonus | ?type=damage
//
// V44 updates #13/#14: the old owner-facing "পেয়েছি / পরিশোধিত" controls
// (mark-as-paid, which instantly reset the whole running total to zero
// for a product) are GONE from this file entirely — POST is no longer
// accepted here. In their place, GET now takes an optional date range
// (?from=YYYY-MM-DD&to=YYYY-MM-DD) and returns bonus/damage figures for
// exactly that window, computed live every time from raw records — no
// state is ever written or reset by viewing a report. Leaving off
// from/to defaults to the CURRENT pay cycle (V41 update #7's 26th→25th
// window), so the figures naturally reset each cycle just by looking —
// no manual action required, per update #14.
const {
  supabase, cors, num, now_, mapDmg, safeErr,
  cyclePeriodBounds, cyclePeriodToday, computeBonusRangeSummary, fetchAll
} = require('./_lib/db');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_RE = /^\d{4}-\d{2}$/;

// Resolves the from/to query params to a valid [from,to] range, falling
// back to the current pay-cycle bounds when missing/invalid, and
// swapping the two if given in reverse order.
// V48 update #46 — also accepts ?period=YYYY-MM directly (the "which
// month cycle" label used everywhere else per update #7), so the
// Monthly Damage Report can ask for a specific pay-cycle by name instead
// of hand-computing its from/to dates on the client.
function _resolveRange(req) {
  const period = (req.query && req.query.period) || '';
  if (PERIOD_RE.test(period)) {
    const b = cyclePeriodBounds(period);
    return { from: b.start, to: b.end };
  }
  let from = (req.query && req.query.from) || '';
  let to   = (req.query && req.query.to)   || '';
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    const b = cyclePeriodBounds(cyclePeriodToday());
    from = b.start; to = b.end;
  }
  if (from > to) { const t = from; from = to; to = t; }
  return { from, to };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const type = (req.query && req.query.type) || '';

  try {
    if (type === 'bonus') return await handleBonus(req, res);
    if (type === 'damage') return await handleDamage(req, res);
    return res.json({ ok: false, error: 'type=bonus বা type=damage প্রয়োজন' });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};

// ══════════════════════════════════════════════════
//  BONUS — GET only. Pure date-range view (updates #13/#14).
// ══════════════════════════════════════════════════
async function handleBonus(req, res) {
  if (req.method === 'GET') {
    const { from, to } = _resolveRange(req);
    const byProduct = await computeBonusRangeSummary(from, to);
    const totalAmount = byProduct.reduce((s, b) => s + num(b.amount), 0);
    return res.json({ ok: true, from, to, generatedAt: now_(), totalAmount, byProduct });
  }
  res.status(405).json({ ok: false, error: 'এই রিপোর্ট এখন শুধু দেখার জন্য — POST সমর্থিত নয়' });
}

// ══════════════════════════════════════════════════
//  DAMAGE — GET only. Pure date-range view (updates #13/#14).
//  Status (pending/cleared) is intentionally ignored for these totals —
//  every claim dated inside the chosen range counts, so nothing needs
//  to be manually "cleared" just to be seen in a report.
// ══════════════════════════════════════════════════
async function handleDamage(req, res) {
  if (req.method === 'GET') {
    const { from, to } = _resolveRange(req);
    const [dmgRes, prodRes] = await Promise.all([
      fetchAll(() => supabase.from('dmg_claims').select('*').gte('date', from).lte('date', to).order('date')).then(d => ({ data: d, error: null })),
      // Update #46 — case_size pulled alongside thumb so the Monthly
      // Damage Report can print "X কেস Y পিস" per SKU, not just a raw
      // piece total, matching the case+piece rule used everywhere else.
      supabase.from('products').select('id,thumb,case_size')
    ]);
    if (dmgRes.error) throw dmgRes.error;
    const claims = (dmgRes.data || []).map(mapDmg);
    const prodMetaMap = {};
    (prodRes.data || []).forEach(p => { prodMetaMap[String(p.id)] = { thumb: p.thumb || '', caseSize: Number(p.case_size) || 1 }; });

    const map = {};
    claims.forEach(c => {
      const pid = c.productId; if (!pid) return;
      if (!map[pid]) map[pid] = {
        productId: pid, name: c.productName, sku: c.sku,
        thumb: (prodMetaMap[pid] || {}).thumb || '',
        caseSize: (prodMetaMap[pid] || {}).caseSize || 1,
        units: 0, cost: 0
      };
      map[pid].units += num(c.totalUnits);
      map[pid].cost  += num(c.totalCost);
    });
    // Update #46 — one row per damaged SKU: case count, piece count,
    // total quantity (units), and buying price (weighted-average
    // purchase rate = this window's cost ÷ units, so it stays accurate
    // even if the product's purchase price changed mid-window).
    const byProduct = Object.values(map).map(p => {
      const cs = p.caseSize || 1;
      const cases = Math.floor(p.units / cs);
      const pieces = +(p.units - cases * cs).toFixed(2);
      const buyingPrice = p.units > 0 ? +(p.cost / p.units).toFixed(4) : 0;
      return { ...p, cases, pieces, totalQuantity: p.units, buyingPrice };
    }).sort((a, b) => b.cost - a.cost);
    const totalCost  = byProduct.reduce((s, p) => s + p.cost, 0);
    const totalUnits = byProduct.reduce((s, p) => s + p.units, 0);
    // v5.4 — total quantity as exact cases + loose pieces (never a bare piece total)
    const totalCP = { cases: byProduct.reduce((s, p) => s + p.cases, 0), pcs: byProduct.reduce((s, p) => s + Math.round(p.pieces), 0) };
    return res.json({ ok: true, from, to, generatedAt: now_(), totalCost, totalUnits, totalCP, byProduct });
  }
  res.status(405).json({ ok: false, error: 'এই রিপোর্ট এখন শুধু দেখার জন্য — POST সমর্থিত নয়' });
}
