const { supabase, cors, num, now_, mapProduct, str, safeErr, fetchAll } = require('./_lib/db');
const { resolveThumb, deleteThumb } = require('./_lib/thumb');
const snap = require('./_lib/snapshot');
const offerLib = require('./_lib/offer');   // v5.25
const ol = require('./_lib/offerLedger');   // v5.26 company offer ledger

// v5.24 — owner check for freeze actions (same pattern as shops.js edit): the caller's OWN password, role must be owner
async function _isOwner(d) {
  const pin = String(d.pin || '').trim(), aid = String(d.actorId || '').trim();
  if (!pin) return false;
  try {
    if (aid) {
      const { data } = await supabase.from('user_passwords').select('role').eq('user_key', aid).eq('password', pin).limit(1);
      return !!(data && data.length && data[0].role === 'owner');
    }
    const { data } = await supabase.from('user_passwords').select('role').eq('role', 'owner').eq('password', pin).limit(1);
    return !!(data && data.length);
  } catch (e) { return false; }
}

// V40 — stock delta rule, kept identical to the DB trigger
// (trg_apply_stock_delta / apply_stock_delta() in schema.sql) so this
// manual resync can never disagree with what the trigger computes
// going forward.
const STOCK_TYPE_SIGN = {
  buy: 1, give: -1, return: 1, point_sale: -1, point_damage_return: 1,
  return_company: -1   // v60 — returned to the company: leaves the warehouse
};

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const action = req.query && req.query.action;

      // ── categories: distinct list of category labels already in use,
      // so the Add/Edit form can offer a pick-list instead of everyone
      // retyping (and slightly-misspelling) the same category name. ──
      if (action === 'categories') {
        const { data, error } = await supabase.from('products').select('category');
        if (error) throw error;
        const set = new Set();
        (data || []).forEach(r => { const c = String(r.category || '').trim(); if (c) set.add(c); });
        return res.json({ ok: true, categories: [...set].sort((a, b) => a.localeCompare(b, 'bn')) });
      }

      // ── V40 SAFETY NET — resync-stock: recomputes every product's
      // current_stock from FULL transaction history and writes it back.
      // This is the one place in the app that deliberately still pays
      // the full-history-fetch cost — but only when an Owner explicitly
      // asks for it (e.g. after restoring a backup, or bulk-editing rows
      // directly in the Supabase dashboard), never on a normal page load.
      // The DB trigger keeps current_stock correct automatically for
      // every day-to-day transaction, so this should rarely be needed.
      if (action === 'resync-stock') {
        const [prodRows, txRows] = await Promise.all([
          supabase.from('products').select('id'),
          fetchAll(() => supabase.from('transactions').select('product_id,type,total_units'))
        ]);
        const deltas = {};
        (txRows || []).forEach(r => {
          const sign = STOCK_TYPE_SIGN[r.type]; if (!sign) return;
          const pid = String(r.product_id || ''); if (!pid) return;
          deltas[pid] = (deltas[pid] || 0) + sign * num(r.total_units);
        });
        const ids = (prodRows.data || []).map(p => p.id);
        const updates = ids.map(id => supabase.from('products').update({ current_stock: deltas[String(id)] || 0 }).eq('id', id));
        const results = await Promise.all(updates);
        const failed = results.find(r => r.error);
        if (failed) throw failed.error;
        return res.json({ ok: true, resynced: ids.length });
      }

      // ── PERF — migrate-thumbs: moves photos still stored as base64 inside the database rows
      // (products + staff) into Storage and keeps only the short URL. Run it by opening
      //   /api/products?action=migrate-thumbs   (repeat until "remaining" is 0).
      // A failed upload leaves that row untouched, so no photo can be lost.
      if (action === 'migrate-thumbs') {
        const BATCH = 15;
        const out = { ok: true, migrated: 0, failed: 0, remaining: 0 };
        for (const table of ['products', 'srs']) {
          const { data: rows, error: e1 } = await supabase.from(table).select('id,thumb').like('thumb', 'data:image%').limit(BATCH);
          if (e1) throw e1;
          for (const r of (rows || [])) {
            const url = await resolveThumb(r.thumb, '');
            if (url && !String(url).startsWith('data:')) {
              const { error: e2 } = await supabase.from(table).update({ thumb: url }).eq('id', r.id);
              if (e2) out.failed++; else out.migrated++;
            } else out.failed++;
          }
          const { count } = await supabase.from(table).select('id', { count: 'exact', head: true }).like('thumb', 'data:image%');
          out.remaining += (count || 0);
        }
        return res.json(out);
      }

      // v5.24 — price history (all products, or ?productId=) — works with or without the product_price_history table
      if (action === 'price-history') {
        const rows = await snap.readPriceHistory(req.query.productId || '');
        return res.json({ ok: true, rows });
      }
      // v5.25 — offer calculation start date (any role may READ it; DSR/SO screens need it only to preview the reduced price)
      if (action === 'offer-settings') {
        return res.json({ ok: true, offerStart: await offerLib.getStartDate(), today: require('./_lib/db').bdtToday(), columns: await offerLib.columnsOk() });
      }
      // v5.24 — legacy-freeze status (counts only, nothing is written)
      if (action === 'freeze-status') {
        return res.json(Object.assign({ ok: true }, await snap.freezeStatus()));
      }

      const { data, error } = await supabase.from('products').select('*').order('sort_order').order('created_at');
      if (error) throw error;
      return res.json((data || []).map(mapProduct));
    }

    if (req.method === 'POST' && req.body && req.body.action) {
      const d = req.body;
      if (d.action === 'offer-start') {                         // v5.25 — owner switch "আজ থেকে চালু করুন": start = today (Dhaka). Can be set once; earlier sales never get an offer.
        if (!(await _isOwner(d))) return res.json({ ok: false, error: 'ভুল পাসওয়ার্ড — শুধু Owner এটি করতে পারেন' });
        const cur = await offerLib.getStartDate();
        if (cur) return res.json({ ok: true, offerStart: cur, already: true });
        const today = require('./_lib/db').bdtToday();
        const ok = await snap.storeWrite({ offerStart: today });
        if (!ok) return res.json({ ok: false, error: 'সংরক্ষণ করা যায়নি' });
        return res.json({ ok: true, offerStart: today });
      }
      // ── v5.26 company offer ledger (OWNER / MANAGER only — DSR/SO/driver are rejected here, not just hidden in the UI) ──
      if (typeof d.action === 'string' && d.action.indexOf('co-') === 0) {
        const WR = d.action === 'co-pay-add' || d.action === 'co-pay-edit' || d.action === 'co-pay-del';
        const role = WR ? await ol.canWrite(d) : await ol.canRead(d);
        if (!role) return res.json({ ok: false, forbidden: true, error: WR ? 'ভুল পাসওয়ার্ড বা অনুমতি নেই — শুধু Owner/Manager' : 'অনুমতি নেই — শুধু Owner/Manager' });
        const by = String(d.actorName || d.actorId || role);
        if (d.action === 'co-ledger') {
          const L = await ol.ledger();
          return res.json({ ok: true, start: L.start, payments: L.payments, alloc: L.alloc, today: require('./_lib/db').bdtToday() });
        }
        if (d.action === 'co-send') {
          const rows = await ol.loadRows(), pays = await ol.readPayments();
          const f = /^\d{4}-\d{2}-\d{2}$/.test(String(d.from || '')) ? String(d.from) : '', t = /^\d{4}-\d{2}-\d{2}$/.test(String(d.to || '')) ? String(d.to) : '';
          return res.json({ ok: true, summary: ol.salesSummary(rows.sales, rows.returns, pays, f || t ? { from: f, to: t } : null) });
        }
        const list = await ol.readPayments();
        if (d.action === 'co-pay-del') {
          const n = list.filter(p => p.id !== String(d.id));
          if (n.length === list.length) return res.json({ ok: false, error: 'পেমেন্ট পাওয়া যায়নি' });
          if (!(await ol.writePayments(n))) return res.json({ ok: false, error: 'সংরক্ষণ করা যায়নি' });
          return res.json({ ok: true });
        }
        const id = d.action === 'co-pay-edit' ? String(d.id || '') : 'cp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const c = ol.cleanPayment(d, id, by); if (c.error) return res.json({ ok: false, error: c.error });
        let n;
        if (d.action === 'co-pay-edit') { const i = list.findIndex(p => p.id === id); if (i < 0) return res.json({ ok: false, error: 'পেমেন্ট পাওয়া যায়নি' }); c.p.by = list[i].by || by; c.p.editedBy = by; n = list.slice(); n[i] = c.p; }
        else n = list.concat([c.p]);
        if (!(await ol.writePayments(n))) return res.json({ ok: false, error: 'সংরক্ষণ করা যায়নি' });
        const L2 = await ol.ledger();   // tell the screen how the payment was applied (shortfall → offer "সমন্বয় সহ বন্ধ করুন")
        return res.json({ ok: true, payment: c.p, applied: (L2.alloc.payments.find(x => x.id === id) || null) });
      }
      if (d.action === 'freeze-remind') {                       // owner chose "পরে মনে করান" — remember for 1 day, writes no transactions
        if (!(await _isOwner(d))) return res.json({ ok: false, error: 'শুধু Owner' });
        await snap.storeWrite({ freezeRemindAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString() });
        return res.json({ ok: true });
      }
      if (d.action === 'freeze-backup' || d.action === 'freeze-run') {
        if (!(await _isOwner(d))) return res.json({ ok: false, error: 'ভুল পাসওয়ার্ড — শুধু Owner এটি করতে পারেন' });
        if (d.action === 'freeze-backup') {
          const [products, transactions, history] = await Promise.all([
            fetchAll(() => supabase.from('products').select('*')), fetchAll(() => supabase.from('transactions').select('*')), snap.readPriceHistory('')]);
          return res.json({ ok: true, backup: { app: 'axiion-dms', kind: 'pre-freeze-backup', at: now_(), products, transactions, priceHistory: history } });
        }
        const out = await snap.freezeRun(String(d.actorName || d.actorId || 'owner'));
        return res.json(out);
      }
      return res.json({ ok: false, error: 'অজানা action' });
    }

    if (req.method === 'POST') {
      const d = req.body;
      if (!d || !String(d.name || '').trim()) return res.json({ ok: false, error: 'পণ্যের নাম আবশ্যক' });
      // AXIION §7 — reverse price entry: the owner types the bulk
      // case/jar/poly price (case_price / case_purchase_price); the
      // per-piece price every transaction actually uses is derived here,
      // server-side, to full 4-decimal precision — never typed by hand.
      const caseSize          = num(d.caseSize) || 1;
      const casePrice         = num(d.casePrice);
      const casePurchasePrice = num(d.casePurchasePrice);
      if (casePrice < 0 || casePurchasePrice < 0) return res.json({ ok: false, error: 'মূল্য ঋণাত্মক হতে পারবে না' });
      const sp = +(casePrice / caseSize).toFixed(4);
      const pp = +(casePurchasePrice / caseSize).toFixed(4);

      // New products always land at the end of the manual ordering list.
      const { data: maxRow } = await supabase.from('products').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle();
      const nextOrder = (maxRow ? num(maxRow.sort_order) : 0) + 1;

      const { data, error } = await supabase.from('products').insert({
        name:                str(d.name, 200),
        sku:                 str(d.sku, 50).toUpperCase(),
        case_size:           caseSize,
        unit_type:           str(d.unitType || 'কেস', 50),
        case_price:          casePrice,
        case_purchase_price: casePurchasePrice,
        purchase_price:      pp,
        selling_price:       sp,
        bonus_free_units:    num(d.bonusFreeUnits),
        bonus_cases_req:     num(d.bonusCasesReq) || 1,
        bonus_free_money:    num(d.bonusFreeMoney),
        low_stock_alert:     num(d.lowStockAlert),
        thumb:               await resolveThumb(d.thumb, ''),
        category:            str(d.category || '', 100),
        sort_order:          nextOrder,
        created_at:          now_()
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, id: data.id });
    }

    if (req.method === 'PUT') {
      const d = req.body;

      // ── REORDER — bulk re-write sort_order from a full ordered id list.
      // Sent whenever the Owner drags a product, taps ▲/▼, or types a
      // target position number ("move #26 to #5") in the product list —
      // the UI always recomputes the *entire* new order client-side first
      // (simple array move), then sends that whole list here so every
      // affected row's sort_order is rewritten in one shot, race-free. ──
      if (d.action === 'reorder') {
        const order = Array.isArray(d.order) ? d.order : [];
        if (!order.length) return res.json({ ok: false, error: 'order প্রয়োজন' });
        const updates = order.map((id, i) => supabase.from('products').update({ sort_order: i + 1 }).eq('id', id));
        const results = await Promise.all(updates);
        const failed = results.find(r => r.error);
        if (failed) throw failed.error;
        return res.json({ ok: true });
      }

      if (!d.id) return res.json({ ok: false, error: 'id প্রয়োজন' });
      if (!String(d.name || '').trim()) return res.json({ ok: false, error: 'পণ্যের নাম আবশ্যক' });
      // AXIION §7 — same reverse price-entry logic as POST (see above).
      const caseSize          = num(d.caseSize) || 1;
      const casePrice         = num(d.casePrice);
      const casePurchasePrice = num(d.casePurchasePrice);
      if (casePrice < 0 || casePurchasePrice < 0) return res.json({ ok: false, error: 'মূল্য ঋণাত্মক হতে পারবে না' });
      const sp = +(casePrice / caseSize).toFixed(4);
      const pp = +(casePurchasePrice / caseSize).toFixed(4);
      const { data: existingRow } = await supabase.from('products').select('*').eq('id', d.id).single();
      const thumb = await resolveThumb(d.thumb, existingRow ? existingRow.thumb : '');
      const { error } = await supabase.from('products').update({
        name:                str(d.name, 200),
        sku:                 str(d.sku, 50).toUpperCase(),
        case_size:           caseSize,
        unit_type:           str(d.unitType || 'কেস', 50),
        case_price:          casePrice,
        case_purchase_price: casePurchasePrice,
        purchase_price:      pp,
        selling_price:       sp,
        bonus_free_units:    num(d.bonusFreeUnits),
        bonus_cases_req:     num(d.bonusCasesReq) || 1,
        bonus_free_money:    num(d.bonusFreeMoney),
        low_stock_alert:     num(d.lowStockAlert),
        category:            str(d.category || '', 100),
        thumb
      }).eq('id', d.id);
      if (error) throw error;
      // v5.24 — dated price/offer history. Never blocks the save.
      try {
        const after = { case_price: casePrice, case_purchase_price: casePurchasePrice, case_size: caseSize,
          bonus_free_units: num(d.bonusFreeUnits), bonus_cases_req: num(d.bonusCasesReq) || 1, bonus_free_money: num(d.bonusFreeMoney) };
        await snap.addPriceHistory(snap.diffProduct(existingRow || {}, after, String(d.changedBy || d.actorName || ''), d.id, str(d.name, 200)));
      } catch (e) { /* history is best-effort */ }
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const id = req.body?.id || req.query?.id;
      if (!id) return res.json({ ok: false, error: 'id প্রয়োজন' });
      const { data: row } = await supabase.from('products').select('thumb').eq('id', id).single();
      const { error } = await supabase.from('products').delete().eq('id', id);
      if (error) throw error;
      if (row && row.thumb) deleteThumb(row.thumb);
      return res.json({ ok: true });
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};
