// attendance.js — REWRITTEN for the full Salary system
// (Punch In/Out, per-person attendance calendar, Owner-configurable
//  monthly salary + bonus scheme, day-override for forgotten punches)
//
// ── Punch rules ──────────────────────────────────────────────────────
//  - Morning punch ("in"): the day's 1st confirmation of presence.
//    On-time if punched between 07:00–10:00 (Asia/Dhaka), else late.
//    Drives the optional daily/perfect-month bonus (independent of salary).
//  - Evening punch ("out"): must happen between 18:00 today and 08:30
//    the NEXT calendar day. This is the day's 2nd confirmation.
//  - A day only counts toward SALARY if BOTH "in" and "out" exist for
//    that workday (regardless of whether the "in" was on-time or late),
//    OR the Owner manually approved that day via day-override (for a
//    forgotten punch).
//  - Fridays are the weekly off-day — never counted for salary or bonus,
//    in either direction.
//  - If an office location is configured, BOTH punches require GPS and
//    must be within the office radius, or they're rejected outright.
//
// ── Salary math ──────────────────────────────────────────────────────
//  - V56 update §3: Owner sets a PER-DAY salary per person, per month (so
//    a raise only affects months from then on, past months stay untouched).
//    There is NO MORE monthly-total ÷ working-days step — the figure the
//    Owner enters (salary_settings.salary_per_day, DB column renamed from
//    the old base_salary) is used directly as the daily rate.
//  - dailyRate = salaryPerDay (no division — see computeSalary below)
//  - salaryEarned = dailyRate × validDays (days with both punches, or an override)
//  - Bonus is a separate optional toggle, per person, with owner-configurable
//    amounts (daily on-time bonus / perfect-month bonus / late penalty).
//  - V56 §3.4: a separate "no 3-day gap" full-attendance bonus — flat,
//    Owner-configurable (salary_settings.no_gap_bonus_amt) — paid whenever
//    the person never has a stretch of 3+ consecutive calendar days with
//    no valid attendance across the whole pay-cycle. Independent of the
//    bonus_enabled toggle above (same pattern as the existing Friday bonus).
//  - V56 §3.5: an optional Owner-settled TARGET bonus (see the
//    `target_bonuses` table + target-bonus-set/target-bonus-settle actions
//    below) — purely informational inside computeSalary(); it is NEVER
//    folded into salaryEarned/bonus/total/payable, exactly per spec ("never
//    auto-added to the payable salary total without the Owner's confirmation").
//  - Each month is tracked independently — an unpaid month just sits as
//    "due" for that specific month and never mixes into the next month.
//
// ── "Month" = pay-cycle, not calendar month (V41 update 7) ───────────
//  Every "month" below (attendance calendar, salary, targets) actually
//  means the company's pay cycle: the 26th of the previous calendar
//  month through the 25th of the labeled month — e.g. period "2026-06"
//  covers 2026-05-26 → 2026-06-25. The 'YYYY-MM' text format used
//  everywhere (query params, DB columns) is unchanged; only the date
//  range it resolves to has changed. See cyclePeriodBounds/
//  cyclePeriodForDate in _lib/db.js.

const {
  supabase, cors, now_, safeErr, bdtToday, fetchAll,
  cyclePeriodBounds, cyclePeriodForDate, cyclePeriodToday, cyclePeriodDates
} = require('./_lib/db');

// Vercel serverless functions run in UTC, not Bangladesh time — every
// time-of-day / "which calendar day is it" decision goes through these
// Asia/Dhaka-aware helpers so results are correct regardless of server TZ.
const APP_TZ = 'Asia/Dhaka';

function _tzParts(d) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
  const parts = {};
  fmt.formatToParts(d || new Date()).forEach(p => { if (p.type !== 'literal') parts[p.type] = p.value; });
  return parts;
}
function _tzISODate(d) { const p = _tzParts(d); return `${p.year}-${p.month}-${p.day}`; }
function _tzMinutesOfDay(d) { const p = _tzParts(d); return Number(p.hour) * 60 + Number(p.minute); }

// Pure calendar-date arithmetic (add days) — built on Date.UTC so it's
// independent of the server process's own TZ.
function _addDaysISO(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
function _weekdayOfDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
// Cycle-period (V41 update 7) equivalents of the calendar-month helpers
// above — a period's working-day count / last working day, counted over
// its actual 26th-to-25th date range instead of a plain calendar month.
function _workingDaysInPeriod(period) {
  return cyclePeriodDates(period).filter(ds => _weekdayOfDateStr(ds) !== 5).length;
}
function _lastWorkingDayOfPeriod(period) {
  const dates = cyclePeriodDates(period);
  for (let i = dates.length - 1; i >= 0; i--) if (_weekdayOfDateStr(dates[i]) !== 5) return dates[i];
  return dates[dates.length - 1];
}

// Great-circle distance in meters
function _haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';

  try {
    // ══════════════════════════════════════════════
    //  OFFICE LOCATION (geofence reference point)
    // ══════════════════════════════════════════════

    if (req.method === 'POST' && action === 'office-set') {
      const d = req.body || {};
      const lat = Number(d.lat), lng = Number(d.lng);
      if (!isFinite(lat) || !isFinite(lng))
        return res.json({ ok: false, error: 'লোকেশন পাওয়া যায়নি — GPS চালু আছে কিনা দেখুন' });
      const radiusM = Number(d.radiusM) || 150;
      const { error } = await supabase.from('office_location').upsert({
        id: 1, lat, lng, radius_m: radiusM, set_by: d.setBy || '', set_at: now_()
      }, { onConflict: 'id' });
      if (error) throw error;
      return res.json({ ok: true, office: { lat, lng, radiusM } });
    }

    if (req.method === 'GET' && action === 'office-get') {
      const { data, error } = await supabase.from('office_location').select('*').eq('id', 1).maybeSingle();
      if (error) throw error;
      return res.json({ ok: true, office: data ? mapOffice(data) : null });
    }

    // ══════════════════════════════════════════════
    //  STAFF LIST (for Owner's person picker)
    // ══════════════════════════════════════════════

    if (req.method === 'GET' && action === 'staff-list') {
      const { data, error } = await supabase
        .from('user_passwords').select('user_key,user_name,role,thumb')
        .in('role', ['manager', 'dsr', 'so', 'driver']);
      if (error) throw error;
      const nonMgrKeys = (data || []).filter(u => u.role !== 'manager').map(u => u.user_key);
      let srsThumbMap = {};
      if (nonMgrKeys.length) {
        const { data: srsRows } = await supabase.from('srs').select('id,thumb').in('id', nonMgrKeys);
        (srsRows || []).forEach(r => { srsThumbMap[String(r.id)] = r.thumb || ''; });
      }
      const staff = (data || [])
        .map(u => ({ ...u, thumb: u.role === 'manager' ? (u.thumb || '') : (srsThumbMap[String(u.user_key)] || '') }))
        .sort((a, b) => (a.role + a.user_name).localeCompare(b.role + b.user_name));
      return res.json({ ok: true, staff });
    }

    // ══════════════════════════════════════════════
    //  PUNCH — in (morning) / out (evening checkout)
    // ══════════════════════════════════════════════

    if (req.method === 'POST' && action === 'punch') {
      const d = req.body || {};
      const userKey = String(d.userKey || '');
      if (!userKey) return res.json({ ok: false, error: 'ব্যবহারকারী পাওয়া যায়নি' });
      const punchType = d.punchType === 'out' ? 'out' : 'in';

      const nowD = new Date();
      const nowMin = _tzMinutesOfDay(nowD);
      const todayStr = _tzISODate(nowD);

      let workdayDate;
      if (punchType === 'in') {
        workdayDate = todayStr;
      } else {
        // checkout window: 18:00 today → 08:30 next day
        if (nowMin < 8 * 60 + 30) workdayDate = _addDaysISO(todayStr, -1); // tail end of yesterday's shift
        else if (nowMin >= 18 * 60) workdayDate = todayStr;
        else return res.json({ ok: false, error: '⏰ চেকআউট শুধুমাত্র সন্ধ্যা ৬টা থেকে পরদিন সকাল ৮:৩০ এর মধ্যে করা যায়' });
      }

      // already punched this type for this workday?
      const { data: existing, error: exErr } = await supabase
        .from('attendance').select('*')
        .eq('user_key', userKey).eq('punch_date', workdayDate).eq('punch_type', punchType).maybeSingle();
      if (exErr) throw exErr;
      if (existing) return res.json({ ok: true, already: true, record: mapAttendance(existing) });

      // Location check — required for BOTH in/out if an office is configured
      const lat = d.lat != null ? Number(d.lat) : null;
      const lng = d.lng != null ? Number(d.lng) : null;
      const hasCoords = lat != null && lng != null && isFinite(lat) && isFinite(lng);
      const { data: office } = await supabase.from('office_location').select('*').eq('id', 1).maybeSingle();

      let atOffice = null, distanceM = null;
      if (office) {
        if (!hasCoords) return res.json({ ok: false, error: '📍 লোকেশন পাওয়া যায়নি — GPS চালু করে আবার চেষ্টা করুন। অফিসে না থাকলে পাঞ্চ করা যাবে না।' });
        distanceM = Math.round(_haversine(lat, lng, Number(office.lat), Number(office.lng)));
        atOffice = distanceM <= Number(office.radius_m || 150);
        if (!atOffice) {
          return res.json({
            ok: false,
            error: `⚠️ আপনি অফিস থেকে ${distanceM}মি দূরে আছেন — ${office.radius_m}মি এর মধ্যে থাকলে পাঞ্চ করতে পারবেন।`,
            distanceM, radiusM: Number(office.radius_m)
          });
        }
      }

      let status = null;
      if (punchType === 'in') {
        // V44 update #8: the on-time cutoff is now role-specific —
        // Manager must punch in by 8:00 AM, everyone else (SO/DSR/Driver)
        // by 8:30 AM. The start of the on-time window (7:00 AM) is
        // unchanged for every role. A punch outside the window is NEVER
        // blocked — it's simply recorded with status 'late' instead of
        // 'present', exactly as before.
        const onTimeStartMin = 7 * 60;
        const roleKey = String(d.role || '').toLowerCase();
        const onTimeEndMin = roleKey === 'manager' ? (8 * 60) : (8 * 60 + 30);
        status = (nowMin >= onTimeStartMin && nowMin <= onTimeEndMin) ? 'present' : 'late';
      }

      const row = {
        user_key: userKey, user_name: d.userName || '', role: d.role || '',
        punch_date: workdayDate, punch_type: punchType, punch_time: now_(),
        status, lat, lng, at_office: atOffice, distance_m: distanceM
      };
      const { error } = await supabase.from('attendance').insert(row);
      if (error) throw error;
      return res.json({ ok: true, already: false, record: mapAttendance(row) });
    }

    // GET ?action=punch-today&userKey=  → today's in/out punch state
    if (req.method === 'GET' && action === 'punch-today') {
      const userKey = req.query.userKey;
      const todayStr = _tzISODate(new Date());
      const { data, error } = await supabase
        .from('attendance').select('*').eq('user_key', userKey).eq('punch_date', todayStr);
      if (error) throw error;
      const inRow  = (data || []).find(r => r.punch_type === 'in')  || null;
      const outRow = (data || []).find(r => r.punch_type === 'out') || null;
      return res.json({ ok: true, in: inRow ? mapAttendance(inRow) : null, out: outRow ? mapAttendance(outRow) : null });
    }

    // GET ?action=punch-state&userKey=  → full picture needed to decide
    // which button to show (Punch In / Punch Out), correctly accounting
    // for a checkout window that spans past midnight into "yesterday".
    if (req.method === 'GET' && action === 'punch-state') {
      const userKey = req.query.userKey;
      const nowD = new Date();
      const nowMin = _tzMinutesOfDay(nowD);
      const todayStr = _tzISODate(nowD);
      const yestStr = _addDaysISO(todayStr, -1);
      const checkoutWindowOpen = nowMin < 8 * 60 + 30 || nowMin >= 18 * 60;

      const { data, error } = await supabase
        .from('attendance').select('*').eq('user_key', userKey).in('punch_date', [todayStr, yestStr]);
      if (error) throw error;
      const find = (dateStr, type) => (data || []).find(r => r.punch_date === dateStr && r.punch_type === type) || null;
      const todayIn = find(todayStr, 'in'), todayOut = find(todayStr, 'out');
      const yestIn  = find(yestStr, 'in'),  yestOut  = find(yestStr, 'out');
      const needsCheckout = checkoutWindowOpen && ((todayIn && !todayOut) || (yestIn && !yestOut));

      return res.json({
        ok: true, checkoutWindowOpen, needsCheckout,
        todayDate: todayStr,
        todayIn: todayIn ? mapAttendance(todayIn) : null,
        todayOut: todayOut ? mapAttendance(todayOut) : null,
        yestDate: yestStr,
        yestIn: yestIn ? mapAttendance(yestIn) : null,
        yestOut: yestOut ? mapAttendance(yestOut) : null
      });
    }

    // ══════════════════════════════════════════════
    //  LIVE LOCATION
    // ══════════════════════════════════════════════

    if (req.method === 'POST' && action === 'location-ping') {
      const d = req.body || {};
      const lat = Number(d.lat), lng = Number(d.lng);
      if (!isFinite(lat) || !isFinite(lng)) return res.json({ ok: false, error: 'লোকেশন নেই' });
      const { error } = await supabase.from('live_locations').upsert({
        user_key: String(d.userKey || ''), user_name: d.userName || '', role: d.role || '',
        lat, lng, updated_at: now_()
      }, { onConflict: 'user_key' });
      if (error) throw error;
      return res.json({ ok: true });
    }

    if (req.method === 'GET' && action === 'location-list') {
      const viewerRole = req.query.viewerRole || '';
      const soId = req.query.soId || '';
      let q = supabase.from('live_locations').select('*').order('updated_at', { ascending: false });
      if (viewerRole === 'manager') {
        q = q.in('role', ['dsr', 'so']);
      } else if (viewerRole === 'so') {
        // SO sees the live location of DSRs — scoped to their own
        // assigned DSRs when soId is supplied, otherwise every DSR.
        if (soId) {
          const { data: myDsrs, error: dsrErr } = await supabase.from('srs').select('id').eq('so_id', soId).eq('role', 'dsr');
          if (dsrErr) throw dsrErr;
          const ids = (myDsrs || []).map(r => String(r.id));
          if (!ids.length) return res.json({ ok: true, locations: [] });
          q = q.eq('role', 'dsr').in('user_key', ids);
        } else {
          q = q.eq('role', 'dsr');
        }
      }
      // owner (or any other/unspecified viewerRole) — no filter, sees everyone,
      // including SO's own live location.
      const { data, error } = await q;
      if (error) throw error;
      const locations = (data || []).map(mapLoc);

      // Attach each person's individual photo (Owner-set) so the live map
      // can show a real photo pin instead of a generic role emoji.
      const keys = locations.map(l => l.userKey).filter(Boolean);
      if (keys.length) {
        const thumbMap = {};
        const [srsThumbs, upThumbs] = await Promise.all([
          supabase.from('srs').select('id,thumb').in('id', keys),
          supabase.from('user_passwords').select('user_key,thumb').in('user_key', keys)
        ]);
        (srsThumbs.data || []).forEach(r => { thumbMap[String(r.id)] = r.thumb || ''; });
        (upThumbs.data || []).forEach(r => { thumbMap[String(r.user_key)] = r.thumb || ''; });
        locations.forEach(l => { l.thumb = thumbMap[String(l.userKey)] || ''; });
      }
      return res.json({ ok: true, locations });
    }

    // ══════════════════════════════════════════════
    //  PER-PERSON ATTENDANCE CALENDAR
    // ══════════════════════════════════════════════

    // GET ?action=calendar&userKey=&month=YYYY-MM (period label — see cycle note above)
    if (req.method === 'GET' && action === 'calendar') {
      const userKey = req.query.userKey;
      const month = req.query.month || cyclePeriodToday();
      const { start: monthStart, end: monthEnd } = cyclePeriodBounds(month);

      const [attRes, ovrRes] = await Promise.all([
        supabase.from('attendance').select('*').eq('user_key', userKey).gte('punch_date', monthStart).lte('punch_date', monthEnd),
        supabase.from('salary_day_override').select('*').eq('user_key', userKey).gte('workday_date', monthStart).lte('workday_date', monthEnd)
      ]);
      if (attRes.error) throw attRes.error;
      if (ovrRes.error) throw ovrRes.error;

      const byDate = {};
      (attRes.data || []).forEach(r => { if (!byDate[r.punch_date]) byDate[r.punch_date] = {}; byDate[r.punch_date][r.punch_type] = r; });
      const overrideMap = {};
      (ovrRes.data || []).forEach(r => { overrideMap[r.workday_date] = { reason: r.reason || '', approvedBy: r.approved_by || '', approvedAt: r.approved_at }; });

      const todayStr = _tzISODate(new Date());
      const days = {};
      cyclePeriodDates(month).forEach(dateStr => {
        const isFriday = _weekdayOfDateStr(dateStr) === 5;
        const rec = byDate[dateStr] || {};
        const hasIn = !!rec.in, hasOut = !!rec.out;
        const override = overrideMap[dateStr] || null;
        days[dateStr] = {
          isFriday,
          isFuture: dateStr > todayStr,
          hasIn, hasOut,
          inStatus: rec.in ? rec.in.status : null,
          inTime:   rec.in ? rec.in.punch_time : null,
          outTime:  rec.out ? rec.out.punch_time : null,
          inAtOffice: rec.in ? rec.in.at_office : null,
          outAtOffice: rec.out ? rec.out.at_office : null,
          override: !!override,
          overrideReason: override ? override.reason : null,
          salaryValid: !isFriday && !!(override || (hasIn && hasOut)),
          // V44 update #9: Friday punch-in earns a separate bonus day —
          // shown on the calendar so it's visually distinct from a
          // normal salary-counted day.
          fridayBonusEarned: isFriday && hasIn
        };
      });
      return res.json({ ok: true, month, periodStart: monthStart, periodEnd: monthEnd, days });
    }

    // POST ?action=day-override — Owner manually approves a missed-punch day
    if (req.method === 'POST' && action === 'day-override') {
      const d = req.body || {};
      const userKey = String(d.userKey || ''), workdayDate = String(d.workdayDate || '');
      if (!userKey || !/^\d{4}-\d{2}-\d{2}$/.test(workdayDate)) return res.json({ ok: false, error: 'ভুল ইনপুট' });
      const { error } = await supabase.from('salary_day_override').upsert({
        user_key: userKey, workday_date: workdayDate,
        reason: d.reason || '', approved_by: d.approvedBy || '', approved_at: now_()
      }, { onConflict: 'user_key,workday_date' });
      if (error) throw error;
      return res.json({ ok: true });
    }

    // ══════════════════════════════════════════════
    //  SALARY
    // ══════════════════════════════════════════════

    // GET ?action=salary-summary&userKey=&month=YYYY-MM
    if (req.method === 'GET' && action === 'salary-summary') {
      const userKey = req.query.userKey;
      const month = req.query.month || cyclePeriodToday();
      const r = await computeSalary(userKey, month);
      return res.json({ ok: true, month, ...r });
    }

    // POST ?action=salary-set — Owner fixes base salary + bonus scheme for a person/month
    if (req.method === 'POST' && action === 'salary-set') {
      const d = req.body || {};
      const userKey = String(d.userKey || ''), month = String(d.month || '');
      if (!userKey || !/^\d{4}-\d{2}$/.test(month)) return res.json({ ok: false, error: 'ভুল ইনপুট' });
      const row = {
        user_key: userKey, month, user_name: d.userName || '',
        // V56 §3.2 — Owner now sets a PER-DAY amount directly (no more
        // monthly-total ÷ working-days). Accept the new `salaryPerDay`
        // field name; fall back to the old `baseSalary` name too so any
        // not-yet-updated caller (e.g. a cached front-end tab) still works.
        salary_per_day: Number(d.salaryPerDay != null ? d.salaryPerDay : d.baseSalary) || 0,
        bonus_enabled: !!d.bonusEnabled,
        daily_bonus_amt: Number(d.dailyBonusAmt) || 0,
        perfect_bonus_amt: Number(d.perfectBonusAmt) || 0,
        late_penalty_amt: Number(d.latePenaltyAmt) || 0,
        // V56 §3.4 — flat "no 3-day gap" full-attendance bonus amount.
        no_gap_bonus_amt: Number(d.noGapBonusAmt) || 0,
        set_by: d.setBy || '', set_at: now_()
      };
      const { error } = await supabase.from('salary_settings').upsert(row, { onConflict: 'user_key,month' });
      if (error) throw error;
      return res.json({ ok: true });
    }

    // POST ?action=salary-pay — Owner marks a specific month's salary as paid
    if (req.method === 'POST' && action === 'salary-pay') {
      const d = req.body || {};
      const userKey = String(d.userKey || ''), month = String(d.month || '');
      if (!userKey || !/^\d{4}-\d{2}$/.test(month)) return res.json({ ok: false, error: 'ভুল ইনপুট' });
      const { error } = await supabase.from('salary_ledger').upsert({
        user_key: userKey, month, user_name: d.userName || '',
        paid_at: now_(), paid_amount: Number(d.amount) || 0, paid_by: d.paidBy || '', updated_at: now_()
      }, { onConflict: 'user_key,month' });
      if (error) throw error;
      return res.json({ ok: true });
    }

    // ══════════════════════════════════════════════
    //  ADVANCE SALARY REQUESTS
    //  Manager/DSR/SO/Driver can request an advance against their own
    //  salary from their dashboard. Owner approves/rejects from the
    //  মালিক অনুমোদন tab. Once approved, computeSalary() automatically
    //  subtracts it from that person's total for the given month.
    // ══════════════════════════════════════════════

    // GET ?action=advance-list                        → owner: everything (recent + pending)
    // GET ?action=advance-list&userKey=XXX             → that person's own history
    if (req.method === 'GET' && action === 'advance-list') {
      const userKey = req.query.userKey || '';
      let q = supabase.from('advance_requests').select('*').order('requested_at', { ascending: false });
      q = userKey ? q.eq('user_key', userKey).limit(30) : q.limit(2000);  // owner: full history per person
      const { data, error } = await q;
      if (error) throw error;
      return res.json({ ok: true, requests: (data || []).map(mapAdvance) });
    }

    // POST ?action=advance-request — staff submits a new advance request
    if (req.method === 'POST' && action === 'advance-request') {
      const d = req.body || {};
      const userKey = String(d.userKey || '');
      const amount = Number(d.amount) || 0;
      const month = /^\d{4}-\d{2}$/.test(d.month || '') ? d.month : cyclePeriodToday();
      if (!userKey) return res.json({ ok: false, error: 'ইউজার শনাক্ত করা যায়নি' });
      if (amount <= 0) return res.json({ ok: false, error: 'সঠিক পরিমাণ লিখুন' });
      const { error } = await supabase.from('advance_requests').insert({
        user_key: userKey, user_name: d.userName || '', role: d.role || '',
        amount, month, note: d.note || '', status: 'pending', requested_at: now_()
      });
      if (error) throw error;
      return res.json({ ok: true });
    }

    // POST ?action=advance-approve — Owner approves a pending request
    if (req.method === 'POST' && action === 'advance-approve') {
      const d = req.body || {};
      if (!d.id) return res.json({ ok: false, error: 'ভুল অনুরোধ' });
      const { error } = await supabase.from('advance_requests')
        .update({ status: 'approved', decided_at: now_(), decided_by: d.approvedBy || 'owner' })
        .eq('id', d.id).eq('status', 'pending');
      if (error) throw error;
      return res.json({ ok: true });
    }

    // POST ?action=advance-reject — Owner rejects a pending request
    if (req.method === 'POST' && action === 'advance-reject') {
      const d = req.body || {};
      if (!d.id) return res.json({ ok: false, error: 'ভুল অনুরোধ' });
      const { error } = await supabase.from('advance_requests')
        .update({ status: 'rejected', decided_at: now_(), decided_by: d.approvedBy || 'owner' })
        .eq('id', d.id).eq('status', 'pending');
      if (error) throw error;
      return res.json({ ok: true });
    }

    // ══════════════════════════════════════════════
    //  SALES TARGETS (AXIION §16 — V25: SO-only split)
    //  Owner sets ONE company-wide total, then splits it across SOs only
    //  (per-SO target rows) — either by tapping "auto split evenly" or by
    //  editing each SO's figure by hand. A DSR has no target row of its
    //  own at all: a DSR is automatically paired with one SO (srs.so_id),
    //  so a DSR simply views their SO's target/progress — there is
    //  nothing separate to set for a DSR.
    //  "Achieved" is always computed live from transactions — same
    //  give/point_sale − return/point_damage_return pattern every other
    //  revenue figure in the app uses (see dashboard.js) — nothing about
    //  progress is ever stored, only the goal itself.
    // ══════════════════════════════════════════════

    // POST ?action=target-set — OWNER ONLY sets a target: per-SO, or the
    // company-wide total via userKey='COMPANY_TOTAL'. Manager/SO/DSR are
    // view-only for every target — enforced here, not just in the UI.
    // V43 update #5: also requires a valid Owner PIN on every save, not
    // just the requesterRole flag (which the client could spoof) — the
    // PIN is re-verified server-side against user_passwords, same pattern
    // as sr-payments.js action=approval_edit.
    if (req.method === 'POST' && action === 'target-set') {
      const d = req.body || {};
      if ((d.requesterRole || '') !== 'owner') {
        return res.json({ ok: false, error: 'শুধুমাত্র মালিক টার্গেট সেট/সম্পাদনা করতে পারবেন' });
      }
      if (!(await _verifyOwnerPin(d.ownerPin))) {
        return res.json({ ok: false, error: 'ভুল Owner PIN' });
      }
      const userKey = String(d.userKey || ''), period = String(d.period || '');
      if (!userKey || !/^\d{4}-\d{2}$/.test(period)) return res.json({ ok: false, error: 'ভুল ইনপুট' });
      const role = userKey === 'COMPANY_TOTAL' ? 'company' : 'so'; // DSR no longer gets its own target row
      // Box target (company's real policy) + money target. A field that is
      // not sent keeps its stored value, so saving one never wipes the other.
      const { data: ex, error: exErr } = await supabase.from('targets').select('target_amount,target_boxes')
        .eq('user_key', userKey).eq('period', period).maybeSingle();
      if (exErr) return res.json({ ok: false, error: _boxMigrationHint(exErr) });
      const amt = d.targetAmount !== undefined ? Number(d.targetAmount) : (ex ? Number(ex.target_amount) : 0);
      const box = d.targetBoxes  !== undefined ? Number(d.targetBoxes)  : (ex ? Number(ex.target_boxes)  : 0);
      if (!(amt >= 0) || !(box >= 0)) return res.json({ ok: false, error: 'টার্গেট ঋণাত্মক হতে পারে না' });
      const row = {
        user_key: userKey, period,
        user_name: d.userName || (userKey === 'COMPANY_TOTAL' ? 'COMPANY_TOTAL' : ''),
        role, target_amount: amt, target_boxes: box,
        set_by: d.setBy || '', set_at: now_()
      };
      const { error } = await supabase.from('targets').upsert(row, { onConflict: 'user_key,period' });
      if (error) return res.json({ ok: false, error: _boxMigrationHint(error) });
      return res.json({ ok: true });
    }

    // POST ?action=target-split-save — OWNER ONLY. ONE save for the whole
    // plan: the company total (boxes + money) and every SO's share as REAL
    // NUMBERS (e.g. 4000 / 3000 / 3000 boxes — not percentages, not forced
    // equal). The SO shares may not add up to MORE than the company total
    // (they may add up to less — the rest simply stays unallocated).
    if (req.method === 'POST' && action === 'target-split-save') {
      const d = req.body || {};
      if ((d.requesterRole || '') !== 'owner') {
        return res.json({ ok: false, error: 'শুধুমাত্র মালিক এই কাজ করতে পারবেন' });
      }
      if (!(await _verifyOwnerPin(d.ownerPin))) {
        return res.json({ ok: false, error: 'ভুল Owner PIN' });
      }
      const period = String(d.period || '');
      if (!/^\d{4}-\d{2}$/.test(period)) return res.json({ ok: false, error: 'ভুল ইনপুট' });
      const cBox = Number(d.companyBoxes) || 0, cAmt = Number(d.companyAmount) || 0;
      const splits = Array.isArray(d.splits) ? d.splits : [];
      if (cBox < 0 || cAmt < 0) return res.json({ ok: false, error: 'টার্গেট ঋণাত্মক হতে পারে না' });
      if (splits.some(x => !x.userKey || !(Number(x.boxes) >= 0) || !(Number(x.amount) >= 0)))
        return res.json({ ok: false, error: 'SO-এর টার্গেটে ভুল সংখ্যা আছে' });
      const sumBox = splits.reduce((t, x) => t + (Number(x.boxes) || 0), 0);
      const sumAmt = splits.reduce((t, x) => t + (Number(x.amount) || 0), 0);
      if (sumBox > cBox + 0.0001)
        return res.json({ ok: false, error: 'SO-দের বক্স টার্গেটের যোগফল (' + sumBox + ') সর্বমোট বক্স টার্গেট (' + cBox + ') ছাড়িয়ে গেছে' });
      if (sumAmt > cAmt + 0.5)
        return res.json({ ok: false, error: 'SO-দের টাকার টার্গেটের যোগফল সর্বমোট টাকার টার্গেট ছাড়িয়ে গেছে' });

      // v5.14 — SKU (product) targets, in cases. Saved together with the plan;
      // their sum may never go above the company's total box target.
      const prodRows = Array.isArray(d.products) ? d.products : null;
      let sumProd = 0;
      if (prodRows) {
        if (prodRows.some(x => !x.productId || !(Number(x.qty) >= 0)))
          return res.json({ ok: false, error: 'পণ্যের টার্গেটে ভুল সংখ্যা আছে' });
        sumProd = prodRows.reduce((t, x) => t + (Number(x.qty) || 0), 0);
        if (sumProd > cBox + 0.0001)
          return res.json({ ok: false, error: 'পণ্যওয়ারি টার্গেটের যোগফল (' + sumProd + ') সর্বমোট বক্স টার্গেট (' + cBox + ') ছাড়িয়ে গেছে' });
        const { data: plist, error: plErr } = await supabase.from('products').select('id');
        if (plErr) throw plErr;
        const okIds = new Set((plist || []).map(x => String(x.id)));
        if (prodRows.some(x => !okIds.has(String(x.productId)))) return res.json({ ok: false, error: 'অজানা পণ্য' });
      }

      // only real SOs may receive a share
      const { data: sos, error: sosErr } = await supabase.from('srs').select('id,name').eq('role', 'so');
      if (sosErr) throw sosErr;
      const soMap = {}; (sos || []).forEach(x => { soMap[String(x.id)] = x.name; });
      if (splits.some(x => !soMap[String(x.userKey)])) return res.json({ ok: false, error: 'অজানা SO' });

      const by = d.setBy || '', at = now_();
      const rows = [{ user_key: 'COMPANY_TOTAL', period, user_name: 'COMPANY_TOTAL', role: 'company', target_amount: cAmt, target_boxes: cBox, set_by: by, set_at: at }]
        .concat(splits.map(x => ({
          user_key: String(x.userKey), period, user_name: soMap[String(x.userKey)] || '', role: 'so',
          target_amount: Number(x.amount) || 0, target_boxes: Number(x.boxes) || 0, set_by: by, set_at: at
        })));
      const { error } = await supabase.from('targets').upsert(rows, { onConflict: 'user_key,period' });
      if (error) return res.json({ ok: false, error: _boxMigrationHint(error) });
      if (prodRows && prodRows.length) {
        const pRows = prodRows.map(x => ({ period, product_id: String(x.productId), target_qty: Number(x.qty) || 0, set_by: by, set_at: at }));
        const { error: pErr } = await supabase.from('product_targets').upsert(pRows, { onConflict: 'period,product_id' });
        if (pErr) throw pErr;
      }
      return res.json({ ok: true, saved: rows.length, allocatedBoxes: sumBox, allocatedAmount: sumAmt, allocatedProducts: sumProd });
    }

    // (v5.14) target-split-even was removed: SO targets are never split
    // equally by the system — the owner types each SO's own figure.

    // GET ?action=target-get&userKey=&period=YYYY-MM — one person's target + live progress
    if (req.method === 'GET' && action === 'target-get') {
      const userKey = req.query.userKey;
      const period = req.query.period || cyclePeriodToday();
      if (!userKey) return res.json({ ok: false, error: 'userKey প্রয়োজন' });
      const [st, tRes] = await Promise.all([
        _targetStats(period),
        supabase.from('targets').select('*').eq('user_key', userKey).eq('period', period).maybeSingle()
      ]);
      if (tRes.error) throw tRes.error;
      const t = tRes.data;
      const e = st.bySo[String(userKey)] || st.byId[String(userKey)] || { rev: 0, boxes: 0 };
      return res.json({ ok: true, period, userKey, ..._progress(t, e), setBy: t ? t.set_by : '', setAt: t ? t.set_at : null });
    }

    // GET ?action=target-list&period=&viewerRole=&viewerId=
    //  owner/manager → every SO ; so → self only ; dsr → their paired SO's target (read-only, no row of their own)
    //  Each row carries BOTH measures: boxes (the company's real target)
    //  and money. `company` also carries how much of it is already
    //  allocated to SOs, and each SO's share of the company target.
    if (req.method === 'GET' && action === 'target-list') {
      const period = req.query.period || cyclePeriodToday();
      const viewerRole = req.query.viewerRole || '';
      const viewerId = req.query.viewerId || '';

      const { data: allSos, error: srsErr } = await supabase
        .from('srs').select('id,name,role,so_id,display_no').eq('role', 'so').order('display_no');
      if (srsErr) throw srsErr;

      let list = allSos || [];
      if (viewerRole === 'so') {
        list = list.filter(s => s.id === viewerId);
      } else if (viewerRole === 'dsr') {
        const { data: meRow } = await supabase.from('srs').select('so_id').eq('id', viewerId).maybeSingle();
        const mySoId = meRow ? String(meRow.so_id || '') : '';
        list = list.filter(s => String(s.id) === mySoId);
      }
      // owner / manager: no filter — every SO

      const { data: targetsData, error: tErr } = await supabase.from('targets').select('*').eq('period', period);
      if (tErr) throw tErr;
      const tMap = {};
      (targetsData || []).forEach(t => { tMap[t.user_key] = t; });
      const st = await _targetStats(period);

      const companyRow = tMap['COMPANY_TOTAL'];
      const company = { userKey: 'COMPANY_TOTAL', period, ..._progress(companyRow, st.company) };

      const results = list.map(s => {
        const t = tMap[s.id];
        const pr = _progress(t, st.bySo[String(s.id)] || { rev: 0, boxes: 0 });
        return {
          userKey: s.id, userName: s.name, role: s.role, displayNo: s.display_no, period, ...pr,
          shareBoxesPct: company.targetBoxes > 0 ? Math.round((pr.targetBoxes / company.targetBoxes) * 1000) / 10 : null,
          shareAmountPct: company.targetAmount > 0 ? Math.round((pr.targetAmount / company.targetAmount) * 1000) / 10 : null,
          contribBoxesPct: st.company.boxes > 0 ? Math.round((pr.achievedBoxes / st.company.boxes) * 1000) / 10 : 0
        };
      });
      // Allocation over ALL SOs (not just the viewer's slice).
      const allocBoxes = (allSos || []).reduce((t, s) => t + (tMap[s.id] ? Number(tMap[s.id].target_boxes) || 0 : 0), 0);
      const allocAmount = (allSos || []).reduce((t, s) => t + (tMap[s.id] ? Number(tMap[s.id].target_amount) || 0 : 0), 0);
      company.allocatedBoxes = Math.round(allocBoxes * 100) / 100;
      company.allocatedAmount = Math.round(allocAmount * 100) / 100;

      return res.json({ ok: true, period, company, list: results });
    }

    // ══════════════════════════════════════════════
    //  TARGET BONUS — Owner-settled (V56 §3.5)
    //  Reuses the existing per-person target system above (`targets`
    //  table) to detect whether a person hit their sales target for the
    //  period. If met, the Owner can set a bonus amount and later
    //  manually settle/approve it (paid outside the automatic salary
    //  total — see computeSalary()'s `targetBonus` block, which is
    //  informational ONLY and never folds this amount into
    //  salaryEarned/bonus/total/payable).
    // ══════════════════════════════════════════════

    // POST ?action=target-bonus-set — OWNER ONLY. Sets/updates the bonus
    // amount available for a person for a given period. Does not itself
    // mark it paid — that's a separate step (target-bonus-settle).
    if (req.method === 'POST' && action === 'target-bonus-set') {
      const d = req.body || {};
      if ((d.requesterRole || '') !== 'owner') {
        return res.json({ ok: false, error: 'শুধুমাত্র মালিক টার্গেট বোনাস সেট করতে পারবেন' });
      }
      if (!(await _verifyOwnerPin(d.ownerPin))) {
        return res.json({ ok: false, error: 'ভুল Owner PIN' });
      }
      const userKey = String(d.userKey || ''), period = String(d.period || '');
      const amount = Number(d.amount) || 0;
      if (!userKey || !/^\d{4}-\d{2}$/.test(period)) return res.json({ ok: false, error: 'ভুল ইনপুট' });
      if (amount <= 0) return res.json({ ok: false, error: 'সঠিক বোনাস পরিমাণ লিখুন' });
      const { data: existing } = await supabase.from('target_bonuses').select('status')
        .eq('user_key', userKey).eq('period', period).maybeSingle();
      if (existing && existing.status === 'settled') {
        return res.json({ ok: false, error: 'এই বোনাস ইতিমধ্যে পরিশোধিত — পরিবর্তন করা যাবে না' });
      }
      const { error } = await supabase.from('target_bonuses').upsert({
        user_key: userKey, period, user_name: d.userName || '',
        amount, status: 'pending', set_by: d.setBy || '', set_at: now_()
      }, { onConflict: 'user_key,period' });
      if (error) throw error;
      return res.json({ ok: true });
    }

    // POST ?action=target-bonus-settle — OWNER ONLY. Marks a previously
    // set target bonus as settled/paid — a manual approve-and-pay action,
    // same spirit as advance-approve, but never touches salary math.
    if (req.method === 'POST' && action === 'target-bonus-settle') {
      const d = req.body || {};
      if ((d.requesterRole || '') !== 'owner') {
        return res.json({ ok: false, error: 'শুধুমাত্র মালিক এই বোনাস পরিশোধ নিশ্চিত করতে পারবেন' });
      }
      if (!(await _verifyOwnerPin(d.ownerPin))) {
        return res.json({ ok: false, error: 'ভুল Owner PIN' });
      }
      const userKey = String(d.userKey || ''), period = String(d.period || '');
      if (!userKey || !/^\d{4}-\d{2}$/.test(period)) return res.json({ ok: false, error: 'ভুল ইনপুট' });
      const { data: row } = await supabase.from('target_bonuses').select('*')
        .eq('user_key', userKey).eq('period', period).maybeSingle();
      if (!row || !(Number(row.amount) > 0)) return res.json({ ok: false, error: 'আগে বোনাসের পরিমাণ সেট করুন' });
      if (row.status === 'settled') return res.json({ ok: false, error: 'ইতিমধ্যে পরিশোধিত' });
      const { error } = await supabase.from('target_bonuses').update({
        status: 'settled', settled_by: d.settledBy || d.setBy || 'owner', settled_at: now_()
      }).eq('user_key', userKey).eq('period', period);
      if (error) throw error;
      return res.json({ ok: true });
    }

    // GET ?action=target-bonus-list&period= — OWNER: every SO's target
    // achievement + any bonus already set/settled for the period, so the
    // Owner can review who's eligible and settle bonuses from one screen.
    if (req.method === 'GET' && action === 'target-bonus-list') {
      const period = req.query.period || cyclePeriodToday();
      const { data: allSos, error: srsErr } = await supabase
        .from('srs').select('id,name,role,display_no').eq('role', 'so').order('display_no');
      if (srsErr) throw srsErr;
      const { data: targetsData } = await supabase.from('targets').select('*').eq('period', period);
      const tMap = {}; (targetsData || []).forEach(t => { tMap[t.user_key] = t; });
      const { data: bonusData } = await supabase.from('target_bonuses').select('*').eq('period', period);
      const bMap = {}; (bonusData || []).forEach(b => { bMap[b.user_key] = b; });

      const st = await _targetStats(period);
      const results = (allSos || []).map(s => {
        const t = tMap[s.id];
        const pr = _progress(t, st.bySo[String(s.id)] || { rev: 0, boxes: 0 });
        const b = bMap[s.id];
        return {
          userKey: s.id, userName: s.name, displayNo: s.display_no, period, ...pr,
          eligible: _targetMet(pr),
          bonusAmount: b ? Number(b.amount) : 0,
          status: b ? b.status : 'unset',
          settledAt: b ? b.settled_at : null
        };
      });
      return res.json({ ok: true, period, list: results });
    }

    // ══════════════════════════════════════════════
    //  PRODUCT-WISE SALES TARGET (V43 update #1: "Two Target Modes") —
    //  owner also sets a quantity target IN CASES (not money, not raw
    //  pieces) per product each month, company-wide, on top of the ৳
    //  total target above. Achieved is summed live from transactions
    //  (total_units → converted to whole cases via _achievedCasesByProduct,
    //  same give/point_sale − return/point_damage_return pattern used
    //  everywhere else) — a product only counts as "1 case sold" once
    //  enough pieces have accumulated to fill a full case.
    // ══════════════════════════════════════════════

    // POST ?action=product-target-set — OWNER ONLY
    if (req.method === 'POST' && action === 'product-target-set') {
      const d = req.body || {};
      if ((d.requesterRole || '') !== 'owner') {
        return res.json({ ok: false, error: 'শুধুমাত্র মালিক পণ্যের টার্গেট সেট করতে পারবেন' });
      }
      if (!(await _verifyOwnerPin(d.ownerPin))) {
        return res.json({ ok: false, error: 'ভুল Owner PIN' });
      }
      const productId = String(d.productId || ''), period = String(d.period || '');
      if (!productId || !/^\d{4}-\d{2}$/.test(period)) return res.json({ ok: false, error: 'ভুল ইনপুট' });
      const newQty = Number(d.targetQty) || 0;
      if (newQty < 0) return res.json({ ok: false, error: 'টার্গেট ঋণাত্মক হতে পারে না' });
      {
        const { data: cRow0 } = await supabase.from('targets').select('target_boxes')
          .eq('user_key', 'COMPANY_TOTAL').eq('period', period).maybeSingle();
        const totalBox = cRow0 ? Number(cRow0.target_boxes) || 0 : 0;
        const { data: others, error: oErr } = await supabase.from('product_targets').select('product_id,target_qty').eq('period', period);
        if (oErr) throw oErr;
        const sumOthers = (others || []).filter(r => String(r.product_id) !== productId).reduce((t, r) => t + (Number(r.target_qty) || 0), 0);
        if (totalBox <= 0 && newQty > 0) return res.json({ ok: false, error: 'আগে সর্বমোট বক্স টার্গেট সেট করুন' });
        if (sumOthers + newQty > totalBox + 0.0001)
          return res.json({ ok: false, error: 'পণ্যওয়ারি টার্গেটের যোগফল (' + (sumOthers + newQty) + ') সর্বমোট বক্স টার্গেট (' + totalBox + ') ছাড়িয়ে যাবে' });
      }
      const row = {
        period, product_id: productId,
        target_qty: newQty,
        set_by: d.setBy || '', set_at: now_()
      };
      const { error } = await supabase.from('product_targets').upsert(row, { onConflict: 'period,product_id' });
      if (error) throw error;
      return res.json({ ok: true });
    }

    // GET ?action=product-target-list&period=YYYY-MM — every product,
    // target qty (in CASES — Update #1) + live achieved CASE count
    // (read-only for everyone, editable by owner only on the front-end).
    // V43 update #1: ordered by the same sort_order the Product Catalog
    // list itself uses (was previously alphabetical by name, which could
    // disagree with the catalog's own order).
    if (req.method === 'GET' && action === 'product-target-list') {
      const period = req.query.period || cyclePeriodToday();
      const { data: prods, error: pErr } = await supabase
        .from('products').select('id,name,unit_type,case_size').order('sort_order').order('created_at');
      if (pErr) throw pErr;

      const { data: rows, error: tErr } = await supabase
        .from('product_targets').select('*').eq('period', period);
      if (tErr) throw tErr;
      const tMap = {};
      (rows || []).forEach(r => { tMap[r.product_id] = r; });

      const achievedMap = await _achievedCasesByProduct(period, prods || []);

      const results = (prods || []).map(p => {
        const t = tMap[p.id];
        const targetQty = t ? Number(t.target_qty) : 0;
        const achieved = achievedMap[p.id] || 0;
        return {
          productId: p.id, productName: p.name, unitType: p.unit_type || 'কেস',
          period, targetQty, achieved,
          pct: targetQty > 0 ? Math.round((achieved / targetQty) * 1000) / 10 : null,
          remaining: Math.max(0, targetQty - achieved)
        };
      });
      return res.json({ ok: true, period, list: results });
    }

    // GET ?action=daily-target-split&period=YYYY-MM — V43 update #6
    // ("RADT" widget): splits the TOTAL remaining case target (summed
    // across every product's per-product case target — Update #1) into
    // a daily case figure for the rest of the cycle, excluding Friday
    // (the company's non-working day) from the day count. Shown read-only
    // on every role's dashboard — nothing here is role-restricted.
    if (req.method === 'GET' && action === 'daily-target-split') {
      const period = req.query.period || cyclePeriodToday();
      const { data: prods, error: pErr } = await supabase
        .from('products').select('id,name,unit_type,case_size').order('sort_order').order('created_at');
      if (pErr) throw pErr;

      const { data: rows, error: tErr } = await supabase
        .from('product_targets').select('product_id,target_qty').eq('period', period);
      if (tErr) throw tErr;

      // The company's real target is in BOXES (one box = one full case of
      // any SKU). When an overall box target is set, RADT is driven by it;
      // otherwise fall back to the per-product case targets.
      let totalTargetCases = (rows || []).reduce((s, r) => s + (Number(r.target_qty) || 0), 0);
      let totalAchievedCases, source = 'product';
      const { data: cRow } = await supabase.from('targets').select('target_boxes')
        .eq('user_key', 'COMPANY_TOTAL').eq('period', period).maybeSingle();
      if (cRow && Number(cRow.target_boxes) > 0) {
        totalTargetCases = Number(cRow.target_boxes);
        totalAchievedCases = (await _targetStats(period)).company.boxes;
        source = 'company-boxes';
      } else {
        const achievedMap = await _achievedCasesByProduct(period, prods || []);
        totalAchievedCases = Object.values(achievedMap).reduce((s, v) => s + v, 0);
      }
      const remaining = Math.max(0, Math.round((totalTargetCases - totalAchievedCases) * 100) / 100);

      // Working days left in the cycle = today → period end, excluding
      // Friday (getUTCDay()===5) and excluding days already past.
      const { start, end } = cyclePeriodBounds(period);
      const rawToday = bdtToday();
      const today = (rawToday >= start && rawToday <= end) ? rawToday : start;
      let workingDaysLeft = 0;
      cyclePeriodDates(period).forEach(dt => {
        if (dt < today || dt > end) return;
        const dow = new Date(dt + 'T00:00:00Z').getUTCDay(); // 5 = Friday
        if (dow !== 5) workingDaysLeft++;
      });

      const dailyTarget = workingDaysLeft > 0
        ? Math.ceil(remaining / workingDaysLeft)
        : Math.ceil(remaining);

      return res.json({
        ok: true, period, totalTargetCases, source,
        totalAchievedCases: Math.round(totalAchievedCases * 100) / 100,
        remaining, workingDaysLeft, dailyTarget
      });
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};

// ══════════════════════════════════════════════════
//  TARGET ACHIEVEMENT — same revenue formula dashboard.js uses everywhere
//  else: (give + point_sale) − (return + point_damage_return), by sr_id,
//  scoped to the given YYYY-MM period.
// ══════════════════════════════════════════════════
// V43 update #4 fix: an SO's own 'give' (regular shop sales) transactions
// are recorded with sr_id = the DELIVERING DSR's id (see api/shops.js /
// sr-payments.js — orders.assigned_dsr_id becomes transactions.sr_id),
// never the SO's own id. Only 'point_sale'/'point_damage_return' (counter
// sales the SO makes directly) ever carry the SO's own id. Filtering
// strictly by sr_id === userKey therefore only ever matched a handful of
// counter-sale rows for an SO, so their progress % stayed at (or near) 0%
// even while their team was actively selling — the company-wide total
// looked fine because it never filtered by sr_id at all. Fix: resolve the
// SO's own id PLUS every DSR auto-paired to them (srs.so_id === userKey,
// per Update #20's auto-pairing) into one id list, same "SO + assigned
// DSRs" pattern api/dashboard.js already uses for the SO dashboard, and
// sum every id's transactions together. For a DSR's own userKey (used
// nowhere in target-set today, but kept safe for future use) this simply
// resolves to just that one id, unchanged from before.
async function _achievedForUser(userKey, period) {
  const st = await _targetStats(period);
  const e = st.bySo[String(userKey)] || st.byId[String(userKey)];
  return e ? e.rev : 0;
}

// Builds the progress block for a target row `t` (may be null) against
// an achieved entry {rev, boxes}. Money keeps its original field names
// (targetAmount / achieved / pct / remaining) so older screens keep
// working; boxes get their own set.
function _progress(t, e) {
  const tAmt = t ? Number(t.target_amount) || 0 : 0;
  const tBox = t ? Number(t.target_boxes)  || 0 : 0;
  const rev = e ? e.rev : 0, box = e ? e.boxes : 0;
  const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;
  return {
    targetAmount: tAmt, achieved: rev,
    pct: tAmt > 0 ? r1((rev / tAmt) * 100) : null,
    remaining: Math.max(0, r2(tAmt - rev)),
    targetBoxes: tBox, achievedBoxes: box,
    pctBoxes: tBox > 0 ? r1((box / tBox) * 100) : null,
    remainingBoxes: Math.max(0, r2(tBox - box))
  };
}
// A target counts as MET on boxes when a box target exists (the company's
// real measure), otherwise on money — used by target bonus + salary view.
function _targetMet(pr) {
  if (pr.targetBoxes > 0) return pr.achievedBoxes >= pr.targetBoxes;
  return pr.targetAmount > 0 && pr.achieved >= pr.targetAmount;
}
function _boxMigrationHint(err) {
  const m = String((err && err.message) || err || '');
  if (/target_boxes/i.test(m)) return 'ডাটাবেসে target_boxes কলাম নেই — সর্বশেষ schema.sql Supabase SQL editor-এ চালান';
  return safeErr(err);
}

// ══════════════════════════════════════════════════
//  BOX-BASED TARGET STATS — the single source of truth for every target
//  figure (company, each SO, salary target-bonus, RADT).
//
//  Company policy: the company gives its distributor a BOX target (one
//  box = one full case of ANY SKU — 6, 24, 40 pieces… it does not matter),
//  alongside a money target. So achieved boxes =
//        Σ over products ( net pieces sold ÷ that product's case_size )
//  where net pieces = (give + point_sale) − (return + point_damage_return)
//  — the same sign rule every other sales figure in the app uses.
//  Boxes are kept fractional (14 pcs of a 12-pc case = 1.17 boxes) and
//  rounded to 2 decimals only at the end; a product whose net is negative
//  for the period counts 0, never a minus.
//
//  Everything comes from ONE paginated read of the period's transactions
//  (fetchAll) — the old per-SO queries were bare selects that PostgREST
//  silently truncates at 1000 rows, which made progress wrong on a busy
//  month — and is then split per SO in memory:
//     SO total = the SO's own id + every DSR paired to that SO (srs.so_id)
//     company  = every transaction (no sr_id filter)
// ══════════════════════════════════════════════════
async function _targetStats(period) {
  const { start: from, end: to } = cyclePeriodBounds(period);
  const [srs, prods, txs] = await Promise.all([
    fetchAll(() => supabase.from('srs').select('id,role,so_id')),
    fetchAll(() => supabase.from('products').select('id,case_size')),
    fetchAll(() => supabase.from('transactions')
      .select('sr_id,type,product_id,total_units,total_revenue')
      .in('type', ['give', 'return', 'point_sale', 'point_damage_return'])
      .gte('date', from).lte('date', to))
  ]);
  const cs = {};
  (prods || []).forEach(p => { cs[String(p.id)] = Math.max(1, Number(p.case_size) || 1); });

  // per sr_id → { rev, pcs:{productId: netPieces} }
  const per = {}, all = { rev: 0, pcs: {} };
  (txs || []).forEach(r => {
    const sign = (r.type === 'give' || r.type === 'point_sale') ? 1 : -1;
    const u = (Number(r.total_units) || 0) * sign, v = (Number(r.total_revenue) || 0) * sign;
    const pid = String(r.product_id || '');
    const sid = String(r.sr_id || '');
    all.rev += v; if (pid) all.pcs[pid] = (all.pcs[pid] || 0) + u;
    if (!sid) return;
    const e = per[sid] || (per[sid] = { rev: 0, pcs: {} });
    e.rev += v; if (pid) e.pcs[pid] = (e.pcs[pid] || 0) + u;
  });
  const toBoxes = pcs => {
    let b = 0;
    Object.keys(pcs).forEach(pid => { b += Math.max(0, pcs[pid]) / (cs[pid] || 1); });
    return Math.round(b * 100) / 100;
  };
  const fin = e => ({ rev: Math.round(e.rev * 100) / 100, boxes: toBoxes(e.pcs) });
  const merge = ids => {
    const m = { rev: 0, pcs: {} };
    ids.forEach(id => {
      const e = per[String(id)]; if (!e) return;
      m.rev += e.rev;
      Object.keys(e.pcs).forEach(pid => { m.pcs[pid] = (m.pcs[pid] || 0) + e.pcs[pid]; });
    });
    return m;
  };

  const byId = {}; Object.keys(per).forEach(k => { byId[k] = fin(per[k]); });
  const dsrsBySo = {};
  (srs || []).forEach(x => { if (x.role === 'dsr' && x.so_id) (dsrsBySo[String(x.so_id)] = dsrsBySo[String(x.so_id)] || []).push(String(x.id)); });
  const bySo = {};
  (srs || []).filter(x => x.role === 'so').forEach(x => {
    bySo[String(x.id)] = fin(merge([String(x.id)].concat(dsrsBySo[String(x.id)] || [])));
  });
  return { company: fin(all), bySo, byId };
}

// V43 update #5 — re-verifies an Owner PIN server-side (never trust the
// client-side requesterRole flag alone). Same table/pattern already used
// by api/sr-payments.js action=approval_edit and api/report.js.
async function _verifyOwnerPin(pin) {
  const p = String(pin || '').trim();
  if (!/^\d{5}$/.test(p)) return false;
  const { data } = await supabase.from('user_passwords').select('id').eq('role', 'owner').eq('password', p).limit(1);
  return !!(data && data.length);
}

// Company-wide achieved money (same formula, no sr_id filter).
async function _achievedCompanyTotal(period) {
  return (await _targetStats(period)).company.rev;
}

// V43 update #1: sums total_units (raw pieces) per product_id for the
// period — same give/point_sale − return/point_damage_return sign
// pattern as every other achieved-figure helper — then converts pieces
// to whole CASES using that product's own case_size. Per the spec, a
// sale only counts as "1 case sold" once enough pieces have accumulated
// to make a full case (e.g. case_size=12, 14 pieces sold → 1 case, the
// leftover 2 pieces don't count yet) — nothing here is ever tracked or
// shown in raw pieces. `prods` must be an array of {id, case_size}
// (already fetched by the caller) so this never re-queries products.
async function _achievedCasesByProduct(period, prods) {
  const { start: from, end: to } = cyclePeriodBounds(period);
  const data = await fetchAll(() => supabase
    .from('transactions').select('type,product_id,total_units').gte('date', from).lte('date', to));
  const pieceMap = {};
  (data || []).forEach(r => {
    const v = Number(r.total_units) || 0;
    const pid = r.product_id;
    if (!pid) return;
    if (r.type === 'give' || r.type === 'point_sale') pieceMap[pid] = (pieceMap[pid] || 0) + v;
    if (r.type === 'return' || r.type === 'point_damage_return') pieceMap[pid] = (pieceMap[pid] || 0) - v;
  });
  const caseSizeMap = {};
  (prods || []).forEach(p => { caseSizeMap[p.id] = Math.max(1, Number(p.case_size) || 1); });
  const caseMap = {};
  Object.keys(pieceMap).forEach(pid => {
    const cs = caseSizeMap[pid] || 1;
    const pieces = Math.max(0, pieceMap[pid]);
    caseMap[pid] = Math.floor(pieces / cs);
  });
  return caseMap;
}

// ══════════════════════════════════════════════════
//  SALARY CALCULATION
// ══════════════════════════════════════════════════

async function _getSalarySettings(userKey, month) {
  const { data: exact } = await supabase.from('salary_settings').select('*').eq('user_key', userKey).eq('month', month).maybeSingle();
  if (exact) return { ...mapSalarySettings(exact), inherited: false };
  const { data: prior } = await supabase.from('salary_settings').select('*')
    .eq('user_key', userKey).lt('month', month).order('month', { ascending: false }).limit(1);
  if (prior && prior.length) return { ...mapSalarySettings(prior[0]), inherited: true };
  return null; // Owner has never configured a salary for this person
}

async function computeSalary(userKey, month) {
  const { start: monthStart, end: monthEnd } = cyclePeriodBounds(month);
  const cycleDates = cyclePeriodDates(month);

  const settings = await _getSalarySettings(userKey, month);
  const workingDays = _workingDaysInPeriod(month);
  // V56 §3.2 — the Owner-entered figure IS the daily rate now; no more
  // ÷ workingDays step (that used to turn a monthly total into a daily
  // rate — now the Owner enters the daily rate directly).
  const dailyRate = settings ? settings.salaryPerDay : 0;

  const [attRes, ovrRes, ledgerRes, advRes] = await Promise.all([
    supabase.from('attendance').select('*').eq('user_key', userKey).gte('punch_date', monthStart).lte('punch_date', monthEnd),
    supabase.from('salary_day_override').select('workday_date').eq('user_key', userKey).gte('workday_date', monthStart).lte('workday_date', monthEnd),
    supabase.from('salary_ledger').select('*').eq('user_key', userKey).eq('month', month).maybeSingle(),
    supabase.from('advance_requests').select('amount,status').eq('user_key', userKey).eq('month', month)
  ]);
  if (attRes.error) throw attRes.error;
  if (ovrRes.error) throw ovrRes.error;
  if (advRes.error) throw advRes.error;

  const byDate = {};
  (attRes.data || []).forEach(r => { if (!byDate[r.punch_date]) byDate[r.punch_date] = {}; byDate[r.punch_date][r.punch_type] = r; });
  const overrideDates = new Set((ovrRes.data || []).map(r => r.workday_date));

  let validDays = 0, onTimeCount = 0, lateCount = 0;
  // V44 update #9: Friday isn't part of the normal 26-day salary cycle —
  // it still never adds to validDays/onTimeCount/lateCount below — but if
  // the person punches in anyway on a Friday, that day earns a separate
  // bonus (one day's normal salary), tracked in fridayBonusDays/Amount,
  // never folded into salaryEarned/validDays. No Friday punch = no bonus.
  let fridayBonusDays = 0;
  cycleDates.forEach(dateStr => {
    if (_weekdayOfDateStr(dateStr) === 5) {
      const rec = byDate[dateStr] || {};
      if (rec.in) fridayBonusDays++;
      return;
    }
    const rec = byDate[dateStr] || {};
    if (rec.in && rec.in.status === 'present') onTimeCount++;
    if (rec.in && rec.in.status === 'late') lateCount++;
    if (overrideDates.has(dateStr) || (rec.in && rec.out)) validDays++;
  });

  const salaryEarned = Math.round(dailyRate * validDays * 100) / 100;
  const fridayBonusAmount = Math.round(dailyRate * fridayBonusDays * 100) / 100;

  let dailyBonus = 0, perfectBonus = 0, penalty = 0, perfectMonth = false, bonus = 0;
  const bonusEnabled = !!(settings && settings.bonusEnabled);
  if (bonusEnabled) {
    dailyBonus = onTimeCount * settings.dailyBonusAmt;
    const todayStr = _tzISODate(new Date());
    const lastWorkingDay = _lastWorkingDayOfPeriod(month);
    const monthConcluded = todayStr >= lastWorkingDay;
    perfectMonth = monthConcluded && lateCount === 0 && onTimeCount === workingDays;
    perfectBonus = perfectMonth ? settings.perfectBonusAmt : 0;
    penalty = lateCount >= 3 ? -settings.latePenaltyAmt : 0;
    bonus = dailyBonus + perfectBonus + penalty;
  }

  // V56 §3.4 — "no 3-day gap" full-attendance bonus. Distinct from the
  // perfectMonth bonus above (which cares about lateness): this only
  // cares about never going 3+ CONSECUTIVE calendar days with no valid
  // attendance (no in+out punch, no day-override) anywhere in the cycle.
  // Independent of bonus_enabled — same pattern as the Friday bonus.
  let _gapRun = 0, _maxGap = 0;
  cycleDates.forEach(dateStr => {
    const rec = byDate[dateStr] || {};
    const validToday = overrideDates.has(dateStr) || (rec.in && rec.out);
    if (validToday) { _gapRun = 0; } else { _gapRun++; if (_gapRun > _maxGap) _maxGap = _gapRun; }
  });
  const noGapEligible = _maxGap < 3;
  const noGapBonusAmt = settings ? Number(settings.noGapBonusAmt || 0) : 0;
  const noGapBonus = (noGapEligible && noGapBonusAmt > 0) ? noGapBonusAmt : 0;

  // V44 update #9 + V56 §3.4: Friday bonus and no-gap bonus are each
  // their own separate pay line, added on top of everything else — never
  // mixed into salaryEarned/bonus above.
  const total = salaryEarned + bonus + fridayBonusAmount + noGapBonus;
  const ledger = ledgerRes.data || null;

  const advRows = advRes.data || [];
  const advanceApproved = Math.round(advRows.filter(a => a.status === 'approved').reduce((s, a) => s + Number(a.amount), 0) * 100) / 100;
  const advancePending  = Math.round(advRows.filter(a => a.status === 'pending').reduce((s, a) => s + Number(a.amount), 0) * 100) / 100;
  const payable = Math.round((total - advanceApproved) * 100) / 100;

  // V56 §3.5 — target bonus is PURELY INFORMATIONAL here: it tells the
  // salary-breakdown screen whether this person hit their sales target
  // and what (if anything) the Owner has set/settled for it — it is
  // NEVER added into salaryEarned/bonus/total/payable above. Settling it
  // (target-bonus-settle) is a fully separate, manual, Owner-confirmed
  // action tracked in its own `target_bonuses` ledger.
  const [{ data: targetRow }, { data: tbRow }] = await Promise.all([
    supabase.from('targets').select('target_amount,target_boxes').eq('user_key', userKey).eq('period', month).maybeSingle(),
    supabase.from('target_bonuses').select('*').eq('user_key', userKey).eq('period', month).maybeSingle()
  ]);
  const hasTgt = targetRow && (Number(targetRow.target_amount) > 0 || Number(targetRow.target_boxes) > 0);
  const stT = hasTgt ? await _targetStats(month) : null;
  const tgtProg = _progress(targetRow, stT ? (stT.bySo[String(userKey)] || stT.byId[String(userKey)]) : null);
  const targetBonus = {
    targetAmount: tgtProg.targetAmount, achieved: tgtProg.achieved,
    targetBoxes: tgtProg.targetBoxes, achievedBoxes: tgtProg.achievedBoxes,
    eligible: _targetMet(tgtProg),
    amount: tbRow ? Number(tbRow.amount) : 0,
    status: tbRow ? tbRow.status : 'unset', // 'unset' | 'pending' | 'settled'
    settledAt: tbRow ? tbRow.settled_at : null
  };

  return {
    settings, workingDays, dailyRate: Math.round(dailyRate * 100) / 100, validDays,
    salaryEarned, bonusEnabled, onTimeCount, lateCount, dailyBonus, perfectMonth, perfectBonus, penalty, bonus,
    fridayBonusDays, fridayBonusAmount, noGapEligible, noGapBonus,
    total, paid: !!(ledger && ledger.paid_at), paidAmount: ledger ? Number(ledger.paid_amount) : 0, paidAt: ledger ? ledger.paid_at : null,
    advanceApproved, advancePending, payable, targetBonus
  };
}

// ══════════════════════════════════════════════════
//  MAPPERS
// ══════════════════════════════════════════════════

function mapOffice(r) {
  return { lat: Number(r.lat), lng: Number(r.lng), radiusM: Number(r.radius_m), setBy: r.set_by || '', setAt: r.set_at };
}
function mapLoc(r) {
  return { userKey: r.user_key, userName: r.user_name || '', role: r.role || '', lat: Number(r.lat), lng: Number(r.lng), updatedAt: r.updated_at };
}
function mapAttendance(r) {
  return {
    userKey: r.user_key, userName: r.user_name || '', role: r.role || '',
    punchDate: r.punch_date, punchType: r.punch_type, punchTime: r.punch_time, status: r.status,
    lat: r.lat, lng: r.lng, atOffice: r.at_office, distanceM: r.distance_m
  };
}
function mapAdvance(r) {
  return {
    id: r.id, userKey: r.user_key, userName: r.user_name || '', role: r.role || '',
    amount: Number(r.amount), month: r.month, note: r.note || '', status: r.status,
    requestedAt: r.requested_at, decidedAt: r.decided_at, decidedBy: r.decided_by || ''
  };
}
function mapSalarySettings(r) {
  return {
    month: r.month,
    // V56 §3.2 — column renamed base_salary → salary_per_day (its meaning
    // changed from "total for the month" to "amount per attended day").
    salaryPerDay: Number(r.salary_per_day), bonusEnabled: !!r.bonus_enabled,
    dailyBonusAmt: Number(r.daily_bonus_amt), perfectBonusAmt: Number(r.perfect_bonus_amt),
    latePenaltyAmt: Number(r.late_penalty_amt),
    noGapBonusAmt: Number(r.no_gap_bonus_amt || 0), // V56 §3.4
    setBy: r.set_by || '', setAt: r.set_at
  };
}

// v5.16 — shared with dashboard.js (sr-perf) so DSR % and SO % use the very same box/money maths
module.exports._targetStats = _targetStats;
