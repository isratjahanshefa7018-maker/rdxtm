const { supabase, cors, safeErr } = require('./_lib/db');
const { resolveThumb, deleteThumb } = require('./_lib/thumb');

const PIN_RE = /^\d{5}$/;
function validPin(p) { return typeof p === 'string' && PIN_RE.test(p.trim()); }

// ── Owner Reset Center (§ new) ─────────────────────────────────────────
// A hardcoded whitelist — this is the ONLY way category keys ever turn
// into real table names, so a request can never delete anything outside
// this list no matter what the client sends. Deliberately excludes:
// products, srs, user_passwords, exp_cats, office_location,
// important_contacts, salary_settings — catalog/staff/login/config data
// that must never be wiped from this screen.
const RESET_CATEGORIES = {
  transactions:     { label: 'লেনদেন (বিক্রয়, দেওয়া, ফেরত, ড্যামেজ)', tables: [{ name: 'transactions', idCol: 'id' }] },
  due_calendar:     { label: 'ডিউ ক্যালেন্ডার (বকেয়ার তালিকা)',        tables: [{ name: 'due_calendar', idCol: 'id' }] },
  sr_payments:      { label: 'DSR/SO পেমেন্ট ও জমার রেকর্ড',           tables: [{ name: 'sr_payments', idCol: 'id' }] },
  dmg_claims:       { label: 'ড্যামেজ ক্লেইম',                        tables: [{ name: 'dmg_claims', idCol: 'id' }] },
  bonus:            { label: 'বোনাস রেকর্ড',                          tables: [{ name: 'bonus', idCol: 'id' }] },
  exp_records:      { label: 'খরচের রেকর্ড (খরচের ক্যাটাগরি অক্ষত থাকবে)', tables: [{ name: 'exp_records', idCol: 'id' }] },
  attendance:       { label: 'উপস্থিতি রেকর্ড (পাঞ্চ ইন/আউট)',         tables: [{ name: 'attendance', idCol: 'id' }] },
  salary_records:   { label: 'বেতন পরিশোধ রেকর্ড ও ওভাররাইড',          tables: [{ name: 'salary_ledger', idCol: 'user_key' }, { name: 'salary_day_override', idCol: 'user_key' }] },
  advance_requests: { label: 'অগ্রিম টাকার আবেদন',                     tables: [{ name: 'advance_requests', idCol: 'id' }] },
  orders:           { label: 'অর্ডার ও গাড়ি লোড রেকর্ড',              tables: [{ name: 'orders', idCol: 'id' }] },
  personal_ledger:  { label: 'ব্যক্তিগত হিসাব (অফ-বুকস ক্যালকুলেটর)',  tables: [{ name: 'personal_ledger', idCol: 'id' }] },
  online_deposit:   { label: 'অনলাইন জমার রেকর্ড',                     tables: [{ name: 'online_deposit', idCol: 'date' }] },
  targets:          { label: 'সেলস টার্গেট (টাকা ও পণ্যভিত্তিক)',      tables: [{ name: 'targets', idCol: 'id' }, { name: 'product_targets', idCol: 'id' }] },
  daily_so_reports: { label: 'দৈনিক SO রিপোর্ট',                       tables: [{ name: 'daily_so_reports', idCol: 'id' }] },
  group_chat:       { label: 'গ্রুপ চ্যাট মেসেজ',                      tables: [{ name: 'group_chat_messages', idCol: 'id' }] },
  notices:          { label: 'নোটিশ',                                  tables: [{ name: 'notices', idCol: 'id' }] },
  live_locations:   { label: 'লাইভ লোকেশন ডেটা',                       tables: [{ name: 'live_locations', idCol: 'user_key' }] },
  manager_approvals:{ label: 'ম্যানেজার অনুমোদন অপেক্ষমাণ তালিকা',      tables: [{ name: 'manager_pending_approvals', idCol: 'id' }] },
  // Danger zone — shop directory isn't day-to-day transactional data,
  // it's the customer list itself, so kept separate/flagged in the UI.
  shops:            { label: '⚠️ দোকান তালিকা (সব দোকানের তথ্য মুছে যাবে)', tables: [{ name: 'shops', idCol: 'id' }], dangerous: true }
};

async function verifyOwnerPin(pin) {
  if (!validPin(pin)) return false;
  const { data } = await supabase.from('user_passwords').select('id').eq('password', pin).eq('role', 'owner').limit(1);
  return !!(data && data.length);
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // POST: validate password → return role + user info
    if (req.method === 'POST') {
      const { password } = req.body || {};
      if (!password) return res.json({ ok: false, error: 'পাসওয়ার্ড দিন' });
      const pin = String(password).trim();
      if (!validPin(pin)) return res.json({ ok: false, error: 'ভুল পাসওয়ার্ড' });

      const { data, error } = await supabase
        .from('user_passwords')
        .select('*')
        .eq('password', pin)
        .limit(1);

      if (error) throw error;
      if (!data || !data.length) return res.json({ ok: false, error: 'ভুল পাসওয়ার্ড' });

      const u = data[0];
      let thumb = u.thumb || '';
      if (!thumb && ['dsr', 'so', 'driver'].includes(u.role)) {
        const { data: srsRow } = await supabase.from('srs').select('thumb').eq('id', u.user_key).maybeSingle();
        thumb = (srsRow && srsRow.thumb) || '';
      }
      return res.json({
        ok: true,
        role:     u.role,
        userId:   u.user_key,
        userName: u.user_name,
        thumb,
        // V44 #18 — Owner's first-ever login must force a real password
        // to be set before anything else in the app is usable.
        mustChangePw: !!u.must_change_pw
      });
    }

    // GET: list all users (for owner's password manager)
    if (req.method === 'GET' && (!req.query || !req.query.action)) {
      const { data, error } = await supabase
        .from('user_passwords')
        .select('user_key,user_name,role,password,thumb')
        .order('created_at');
      if (error) throw error;
      return res.json({ ok: true, users: data || [] });
    }

    // GET ?action=reset-counts — row counts per resettable category, so
    // the owner can see exactly how much data each option would wipe
    // before they ever touch a checkbox.
    if (req.method === 'GET' && req.query && req.query.action === 'reset-counts') {
      const counts = {};
      for (const key of Object.keys(RESET_CATEGORIES)) {
        let total = 0;
        for (const t of RESET_CATEGORIES[key].tables) {
          const { count, error } = await supabase.from(t.name).select('*', { count: 'exact', head: true });
          if (error) throw error;
          total += count || 0;
        }
        counts[key] = total;
      }
      return res.json({ ok: true, counts });
    }

    // PUT: change/set passwords
    if (req.method === 'PUT') {
      const d = req.body || {};

      // User changing own password (requires old password)
      if (d.action === 'change') {
        if (!validPin(String(d.newPass || ''))) return res.json({ ok: false, error: 'নতুন PIN অবশ্যই ৫ সংখ্যার হতে হবে' });
        const { data: existing } = await supabase
          .from('user_passwords')
          .select('id')
          .eq('user_key', d.userKey)
          .eq('password', String(d.oldPass || '').trim())
          .limit(1);
        if (!existing || !existing.length)
          return res.json({ ok: false, error: 'পুরানো পাসওয়ার্ড ভুল' });
        const { error } = await supabase
          .from('user_passwords')
          // V44 #18 — a self-service change (including the mandatory
          // first-login change) always clears the forced-setup flag.
          .update({ password: String(d.newPass).trim(), must_change_pw: false })
          .eq('user_key', d.userKey);
        if (error) throw error;
        return res.json({ ok: true });
      }

      // Owner setting any user's password (no old pass needed)
      if (d.action === 'owner_set') {
        if (!validPin(String(d.newPass || ''))) return res.json({ ok: false, error: 'PIN অবশ্যই ৫ সংখ্যার হতে হবে' });
        const { error } = await supabase
          .from('user_passwords')
          .update({ password: String(d.newPass).trim(), must_change_pw: false })
          .eq('user_key', d.userKey);
        if (error) throw error;
        return res.json({ ok: true });
      }

      // update_meta: rename/re-role a user without touching their password
      if (d.action === 'update_meta') {
        const { error } = await supabase
          .from('user_passwords')
          .update({ user_name: String(d.userName || ''), role: String(d.role || 'dsr') })
          .eq('user_key', String(d.userKey));
        if (error) throw error;
        return res.json({ ok: true });
      }

      // set_thumb: Owner sets/updates a user's individual profile photo
      // (used for the Manager account, which has no `srs` row of its own —
      // DSR/SO/Driver photos are already set via api/srs.js `thumb`).
      if (d.action === 'set_thumb') {
        const { error } = await supabase
          .from('user_passwords')
          .update({ thumb: await resolveThumb(d.thumb, '') })
          .eq('user_key', String(d.userKey));
        if (error) throw error;
        return res.json({ ok: true });
      }

      // Create or update a user entry (called when DSR/SO is enrolled)
      if (d.action === 'upsert') {
        let pin = String(d.password || '');
        // autoPin: generate a collision-free 5-digit PIN server-side
        if (d.autoPin) {
          pin = '';
          for (let i = 0; i < 60; i++) {
            const candidate = String(10000 + Math.floor(Math.random() * 90000));
            const { data: clash } = await supabase
              .from('user_passwords').select('id').eq('password', candidate).limit(1);
            if (!clash || !clash.length) { pin = candidate; break; }
          }
          if (!pin) return res.json({ ok: false, error: 'PIN তৈরি করা সম্ভব হয়নি' });
        }
        const { error } = await supabase
          .from('user_passwords')
          .upsert({
            user_key:  String(d.userKey),
            user_name: String(d.userName || ''),
            role:      String(d.role || 'dsr'),
            password:  pin,
            thumb:     await resolveThumb(d.thumb, '')
          }, { onConflict: 'user_key' });
        if (error) throw error;
        return res.json({ ok: true, password: pin });
      }

      // Delete a user entry (when DSR/SO is removed)
      if (d.action === 'delete') {
        const { data: row } = await supabase.from('user_passwords').select('thumb').eq('user_key', d.userKey).maybeSingle();
        const { error } = await supabase
          .from('user_passwords')
          .delete()
          .eq('user_key', d.userKey);
        if (error) throw error;
        // Only cleans up a photo set directly on user_passwords (the Manager
        // path) — a DSR/SO's own photo lives on their `srs` row and is
        // cleaned up separately when that row is deleted in srs.js.
        if (row && row.thumb) deleteThumb(row.thumb);
        return res.json({ ok: true });
      }

      // reset-data: Owner Reset Center — permanently deletes every row in
      // the selected categories. The frontend already makes the owner
      // enter their password twice before this call ever fires, but we
      // NEVER trust that alone — the password is re-validated here,
      // server-side, against a live owner account, every single time.
      // `categories` is filtered against the RESET_CATEGORIES whitelist
      // above, so a tampered/replayed request still can't reach any
      // table outside that fixed list.
      if (d.action === 'reset-data') {
        const pin = String(d.password || '').trim();
        const isOwner = await verifyOwnerPin(pin);
        if (!isOwner) return res.json({ ok: false, error: '❌ পাসওয়ার্ড ভুল অথবা আপনি Owner নন' });

        const requested = Array.isArray(d.categories) ? d.categories : [];
        const keys = requested.filter(k => RESET_CATEGORIES[k]);
        if (!keys.length) return res.json({ ok: false, error: 'কোনো তথ্য নির্বাচিত হয়নি' });

        const deleted = {};
        for (const key of keys) {
          for (const t of RESET_CATEGORIES[key].tables) {
            const { error, count } = await supabase.from(t.name).delete({ count: 'exact' }).not(t.idCol, 'is', null);
            if (error) throw error;
            deleted[t.name] = count || 0;
          }
        }
        return res.json({ ok: true, deleted });
      }

      return res.json({ ok: false, error: 'অজানা action' });
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};
