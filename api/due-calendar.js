const { supabase, cors, num, str, now_, mapDue, safeErr, applyDuePayment, fetchAll, bdtToday, auditLog, idemRun, pageParams, cyclePeriodBounds } = require('./_lib/db');
const { randomUUID } = require('crypto');

// Merged with the former api/settings.js (app-wide shop-name setting) to
// stay within the Vercel Hobby plan's 12-Serverless-Function limit — both
// live in one file, distinguished by ?action=.
const DUE_COLS = 'id,dsr_id,dsr_name,client_type,shop_id,shop_name,due_date,amount,paid_amount,note,status,cleared_date,created_at,tx_id';

// v5.6 — attach the shop's phone + keeper name to shop-type due rows so the
// calendar can offer a one-tap call. One batched lookup, never one per row.
async function _withShopPhones(dues) {
  const ids = [...new Set((dues || []).map(d => d.shopId).filter(Boolean))];
  if (!ids.length) return dues;
  const info = {};
  for (let i = 0; i < ids.length; i += 80) {
    const { data } = await supabase.from('shops').select('id,phone,keeper_name').in('id', ids.slice(i, i + 80));
    (data || []).forEach(s => { info[String(s.id)] = s; });
  }
  dues.forEach(d => { const s = info[d.shopId]; d.shopPhone = (s && s.phone) || ''; d.keeperName = (s && s.keeper_name) || ''; });
  return dues;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const action = req.query.action || (req.body && req.body.action);

    // GET — app-wide shop/business identity (used on every printed
    // challan, memo, report and slip letterhead).
    if (req.method === 'GET' && action === 'settings-get') {
      const { data, error } = await supabase.from('app_settings').select('shop_name,shop_address,shop_phone,distributor_name,logo_text,block_negative_stock,profit_rules').eq('id', 1).maybeSingle();
      if (error) throw error;
      return res.json({
        ok: true,
        blockNegativeStock: !(data && data.block_negative_stock === false),
        profitRules: Object.assign({ commission: true, discount: true, damage: true, bonus: true, expenses: true }, (function(){ const x = Object.assign({}, (data && data.profit_rules) || {}); delete x._store; return x; })()),
        shopName:        (data && data.shop_name)        || '',
        shopAddress:     (data && data.shop_address)      || '',
        shopPhone:       (data && data.shop_phone)        || '',
        distributorName: (data && data.distributor_name)  || '',
        logoText:        (data && data.logo_text)         || ''
      });
    }

    // POST — update the app-wide shop/business identity. Only shopName is
    // required; the rest are optional and simply won't be printed on
    // documents until the owner fills them in.
    if (req.method === 'POST' && action === 'settings-update') {
      const d = req.body || {};
      const shopName = str(d.shopName, 120);
      if (!shopName) return res.json({ ok: false, error: 'দোকান/প্রতিষ্ঠানের নাম দিন' });
      const shopAddress     = str(d.shopAddress, 200);
      const shopPhone       = str(d.shopPhone, 30);
      const distributorName = str(d.distributorName, 120);
      const logoText        = str(d.logoText, 4);

      const row = {
        id: 1, shop_name: shopName, shop_address: shopAddress, shop_phone: shopPhone,
        distributor_name: distributorName, logo_text: logoText,
        set_by: str(d.setBy, 60), updated_at: now_()
      };
      // v5.1 — owner switches (only written when the screen sends them, so an
      // old client never resets them): stock guard + what reduces net profit.
      if (typeof d.blockNegativeStock === 'boolean') row.block_negative_stock = d.blockNegativeStock;
      if (d.profitRules && typeof d.profitRules === 'object') {
        // v5.24 — keep the hidden settings store (_store: price history, freeze flag) when the switches are saved
        let _keep = {};
        try { const { data: _ex } = await supabase.from('app_settings').select('profit_rules').eq('id', 1).maybeSingle(); if (_ex && _ex.profit_rules && _ex.profit_rules._store) _keep = { _store: _ex.profit_rules._store }; } catch (e) {}
        row.profit_rules = {
          ..._keep,
          commission: d.profitRules.commission !== false, discount: d.profitRules.discount !== false,
          damage: d.profitRules.damage !== false, bonus: d.profitRules.bonus !== false, expenses: d.profitRules.expenses !== false
        };
      }
      let { error } = await supabase.from('app_settings').upsert(row);
      if (error && /block_negative_stock|profit_rules/.test(String(error.message))) {
        // migration 001 not run yet — save the business info anyway
        delete row.block_negative_stock; delete row.profit_rules;
        ({ error } = await supabase.from('app_settings').upsert(row));
      }
      if (error) throw error;
      return res.json({ ok: true, shopName, shopAddress, shopPhone, distributorName, logoText });
    }

    // GET — fetch dues filtered by month and/or dsrId
    if (req.method === 'GET') {
      const { month, dsrId, shopId, openOnly } = req.query;
      const pg = pageParams(req.query, 50);
      const applyFilters = (q) => {
        if (month) {
          // v5.5 — "month" is the company pay-cycle label 'YYYY-MM' = 26th of the
          // previous month → 25th of that month (same rule as salary / targets).
          const cb = cyclePeriodBounds(String(month).slice(0, 7));
          q = q.gte('due_date', cb.start).lte('due_date', cb.end);
        }
        if (dsrId) q = q.eq('dsr_id', dsrId);
        if (shopId) q = q.eq('shop_id', shopId);
        // PERF-4 — cleared rows owe nothing; screens that only need what is
        // still unpaid ask for ?openOnly=1 and skip downloading them.
        if (openOnly === '1' || openOnly === 'true') q = q.neq('status', 'cleared');
        return q;
      };
      if (pg) {
        const { data, error, count } = await applyFilters(supabase.from('due_calendar').select(DUE_COLS, { count: 'exact' }).order('due_date', { ascending: false }).order('id')).range(pg.from, pg.to);
        if (error) throw error;
        return res.json({ ok: true, dues: await _withShopPhones((data || []).map(mapDue)), page: pg.page, pageSize: pg.pageSize, total: count || 0, hasMore: pg.to + 1 < (count || 0) });
      }
      // fetchAll: a busy month (or an all-time per-DSR/shop history) can
      // pass PostgREST's silent 1000-row cap.
      const data = await fetchAll(() => {
        let q = supabase.from('due_calendar').select(DUE_COLS).order('due_date');
        return applyFilters(q);
      });
      return res.json({ ok: true, dues: await _withShopPhones((data || []).map(mapDue)) });
    }

    // POST — add a new due entry
    if (req.method === 'POST') return idemRun(req, res, 'due-add', async () => {
      const d = req.body;
      if (!d.dueDate || !d.amount) return res.json({ ok: false, error: 'dueDate ও amount প্রয়োজন' });
      const { data, error } = await supabase.from('due_calendar').insert({
        id:          randomUUID(),
        dsr_id:      d.dsrId   || '',
        dsr_name:    d.dsrName || '',
        client_type: d.clientType || 'dsr',
        shop_id:     d.shopId   || '',
        shop_name:   d.shopName || '',
        due_date:    d.dueDate,
        amount:      num(d.amount),
        paid_amount: 0,
        note:        d.note || '',
        status:      'pending',
        cleared_date: null,
        created_at:  now_()
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, due: mapDue(data) });
    });

    // PUT — partial/full payment, mark cleared, or edit fields
    if (req.method === 'PUT') return idemRun(req, res, 'due-put', async () => {
      const d = req.body || {};
      if (!d.id) return res.json({ ok: false, error: 'id প্রয়োজন' });
      const actor = { id: d.actorId || d.collectorId || '', role: d.actorRole || '' };

      // v5.16 — taking money on a due (full OR part) needs the acting person's OWN password.
      // Verified here on the server so it cannot be skipped from the browser.
      const _needPin = (typeof d.payAmount !== 'undefined') || d.status === 'cleared';
      if (_needPin) {
        const pin = String(d.pin == null ? '' : d.pin).trim();
        const aid = String(d.actorId || d.collectorId || '').trim();
        if (!aid || !pin) return res.json({ ok: false, error: 'আপনার নিজের পাসওয়ার্ড দিন', needPin: true });
        const { data: pw, error: pwErr } = await supabase.from('user_passwords').select('user_key').eq('user_key', aid).eq('password', pin).limit(1);
        if (pwErr) throw pwErr;
        if (!pw || !pw.length) return res.json({ ok: false, error: 'পাসওয়ার্ড ভুল — কিছুই সংরক্ষিত হয়নি', badPin: true });
      }

      if (typeof d.payAmount !== 'undefined') {
        const pay = num(d.payAmount);
        if (pay <= 0) return res.json({ ok: false, error: 'পরিমাণ ০-এর বেশি হতে হবে' });

        // v4.8.0 — goes through the shared helper so a shop-due payment is
        // also logged in due_collections (the end-of-day settlement reads
        // that log to know how much cash the DSR collected today).
        const r1 = await applyDuePayment(d.id, pay, { dsrId: d.collectorId || '', dsrName: d.collectorName || '' });
        if (r1.conflict) return res.json({ ok: false, error: 'অন্য একটি আপডেট চলছিল — আবার চেষ্টা করুন' });
        if (r1.applied <= 0) return res.json({ ok: false, error: 'এই বাকি আগেই পরিশোধিত' });
        return res.json({ ok: true, paidAmount: r1.paidAmount, remaining: r1.remaining, status: r1.status });
      }

      // CALC-7 — "mark cleared" used to just overwrite paid_amount = amount
      // with NO collection record, so the ledger and the day's settlement
      // treated the missing part as "paid at delivery". It now pays the
      // remaining balance through the same helper as every other payment,
      // so it is logged in due_collections (and dated in Asia/Dhaka time).
      if (d.status === 'cleared') {
        const { data: cur, error: cErr } = await supabase.from('due_calendar').select('amount,paid_amount,status').eq('id', d.id).single();
        if (cErr) throw cErr;
        const remaining = Math.max(0, num(cur.amount) - num(cur.paid_amount));
        if (remaining > 0.0001) {
          const r1 = await applyDuePayment(d.id, remaining, { dsrId: d.collectorId || '', dsrName: d.collectorName || '' });
          if (r1.conflict) return res.json({ ok: false, error: 'অন্য একটি আপডেট চলছিল — আবার চেষ্টা করুন' });
        } else if (cur.status !== 'cleared') {
          await supabase.from('due_calendar').update({ status: 'cleared', cleared_date: bdtToday() }).eq('id', d.id);
        }
        await auditLog(actor, 'due-mark-cleared', 'due_calendar', d.id, { amount: cur.amount, paid_amount: cur.paid_amount, status: cur.status }, { status: 'cleared' });
      }

      // Field edits (date / amount / owner / note). The old row is written to
      // audit_log first so an amount can never change without a trace.
      const updates = {};
      if (d.dueDate)            updates.due_date    = d.dueDate;
      if (d.amount)             updates.amount      = num(d.amount);
      if (d.dsrName)            updates.dsr_name    = d.dsrName;
      if (d.dsrId)              updates.dsr_id      = d.dsrId;
      if (d.clientType)         updates.client_type = d.clientType;
      if (d.shopId !== undefined)   updates.shop_id   = d.shopId;
      if (d.shopName !== undefined) updates.shop_name = d.shopName;
      if (d.note !== undefined) updates.note        = d.note;
      if (Object.keys(updates).length) {
        const { data: before } = await supabase.from('due_calendar').select(DUE_COLS).eq('id', d.id).maybeSingle();
        const { error } = await supabase.from('due_calendar').update(updates).eq('id', d.id);
        if (error) throw error;
        await auditLog(actor, 'due-edit', 'due_calendar', d.id, before, updates);
      }
      return res.json({ ok: true });
    });

    // DELETE — remove a due entry
    if (req.method === 'DELETE') {
      const d = req.body || {};
      if (!d.id) return res.json({ ok: false, error: 'id প্রয়োজন' });
      // CALC-7 — keep a copy of what was deleted
      const { data: before } = await supabase.from('due_calendar').select(DUE_COLS).eq('id', d.id).maybeSingle();
      const { error } = await supabase.from('due_calendar').delete().eq('id', d.id);
      if (error) throw error;
      await auditLog({ id: d.actorId || '', role: d.actorRole || '' }, 'due-delete', 'due_calendar', d.id, before, null);
      return res.json({ ok: true });
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};
