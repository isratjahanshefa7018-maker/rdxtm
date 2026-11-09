const {
  supabase, cors, now_, str, safeErr, mapSR,
  mapRoad, mapRoadPlan, mapRoadWeeklyPlan, bdtToday, addDaysStr, weekdayOf
} = require('./_lib/db');
const { resolveThumb, deleteThumb } = require('./_lib/thumb');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';

  try {
    // ══════════════════════════════════════════════════
    //  ROADS (Update #21) — Owner creates roads freely by name.
    //  No fixed/predefined list, no separate 13th API file — this all
    //  lives here alongside the SO/DSR registry since a road's whole
    //  purpose is pairing an SO (+ their auto-paired DSR) to an area.
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'roads') {
      const { data, error } = await supabase.from('roads').select('*').order('created_at');
      if (error) throw error;
      return res.json({ ok: true, roads: (data || []).map(mapRoad) });
    }

    if (req.method === 'POST' && action === 'road-create') {
      const d = req.body;
      const name = str(d.name, 200);
      if (!name) return res.json({ ok: false, error: 'রোডের নাম আবশ্যক' });
      const { data, error } = await supabase.from('roads').insert({
        name, created_at: now_()
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, road: mapRoad(data) });
    }

    if (req.method === 'PUT' && action === 'road-rename') {
      const d = req.body;
      if (!d.id) return res.json({ ok: false, error: 'id প্রয়োজন' });
      const name = str(d.name, 200);
      if (!name) return res.json({ ok: false, error: 'রোডের নাম আবশ্যক' });
      const { error } = await supabase.from('roads').update({ name }).eq('id', d.id);
      if (error) throw error;
      // Keep the denormalised road_name copies on srs/shops in sync so
      // a rename doesn't leave stale names scattered across the app.
      await supabase.from('srs').update({ road_name: name }).eq('road_id', d.id);
      await supabase.from('shops').update({ road_name: name }).eq('road_id', d.id);
      await supabase.from('road_weekly_plans').update({ road_name: name }).eq('road_id', d.id);
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE' && action === 'road-delete') {
      const id = req.body?.id || req.query?.id;
      if (!id) return res.json({ ok: false, error: 'id প্রয়োজন' });
      // Unlink first so no SO/DSR/shop is left pointing at a deleted road.
      await supabase.from('srs').update({ road_id: '', road_name: '' }).eq('road_id', id);
      await supabase.from('shops').update({ road_id: '', road_name: '' }).eq('road_id', id);
      await supabase.from('road_weekly_plans').delete().eq('road_id', id);
      const { error } = await supabase.from('roads').delete().eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    // ══════════════════════════════════════════════════
    //  ASSIGN SO → ROAD, AUTO-ASSIGN PAIRED DSR (Update #22)
    //  Owner picks one SO per road. That SO's auto-paired DSR (Update
    //  #20's same-display-no pairing) is carried onto the same road
    //  automatically — there is no separate "assign DSR to road" step
    //  anywhere in the app.
    // ══════════════════════════════════════════════════
    if (req.method === 'POST' && action === 'road-assign-so') {
      const d = req.body;
      if (!d.roadId || !d.soId) return res.json({ ok: false, error: 'roadId ও soId প্রয়োজন' });
      const { data: so, error: soErr } = await supabase.from('srs').select('*').eq('id', d.soId).eq('role', 'so').single();
      if (soErr || !so) return res.json({ ok: false, error: 'SO পাওয়া যায়নি' });
      const { data: road, error: roadErr } = await supabase.from('roads').select('*').eq('id', d.roadId).single();
      if (roadErr || !road) return res.json({ ok: false, error: 'রোড পাওয়া যায়নি' });

      // The paired DSR is whichever `srs` row has so_id === this SO's id
      // (set automatically at registration time — Update #20).
      // v5.7 — .limit(1) instead of .maybeSingle(): maybeSingle() errors (→ no DSR) as soon as an SO has 2 DSRs paired.
      const { data: _pd } = await supabase.from('srs').select('id,name').eq('role', 'dsr').eq('so_id', String(so.id)).order('created_at').limit(1);
      const pairedDsr = (_pd && _pd[0]) || null;

      // v5.7 — one SO (and his paired DSR) can now cover MANY roads. The old code cleared the
      // SO's previous road here, so assigning a second road silently un-assigned the first.

      const { error: roadUpdErr } = await supabase.from('roads').update({
        so_id: String(so.id), so_name: so.name || '',
        dsr_id: pairedDsr ? String(pairedDsr.id) : '',
        dsr_name: pairedDsr ? (pairedDsr.name || '') : ''
      }).eq('id', d.roadId);
      if (roadUpdErr) throw roadUpdErr;

      await supabase.from('srs').update({ road_id: d.roadId, road_name: road.name || '' }).eq('id', so.id);
      if (pairedDsr) {
        await supabase.from('srs').update({ road_id: d.roadId, road_name: road.name || '' }).eq('id', pairedDsr.id);
      }

      // Existing shops already registered under this road should track
      // the (possibly new) DSR too, so deliveries never point at a stale
      // DSR after a road's SO/DSR assignment changes.
      await supabase.from('shops').update({
        assigned_dsr_id: pairedDsr ? String(pairedDsr.id) : '',
        assigned_dsr_name: pairedDsr ? (pairedDsr.name || '') : ''
      }).eq('road_id', d.roadId);

      // V56 §4 — keep the denormalised so/dsr copies on any existing
      // weekly visit rules for this road in sync too, so a road's future
      // occurrences never point at a stale SO/DSR after reassignment.
      await supabase.from('road_weekly_plans').update({
        so_id: String(so.id), so_name: so.name || '',
        dsr_id: pairedDsr ? String(pairedDsr.id) : '',
        dsr_name: pairedDsr ? (pairedDsr.name || '') : ''
      }).eq('road_id', d.roadId);

      return res.json({ ok: true });
    }

    // ══════════════════════════════════════════════════
    //  VISIT-DAY AUTOMATION (Update #25) — Owner picks an SO + road +
    //  date; the SO visits shops that day, the paired DSR delivers to
    //  those same shops the next day. dashboard.js reads today's
    //  matching row(s) to surface "you're due at [road] today".
    // ══════════════════════════════════════════════════
    if (req.method === 'POST' && action === 'road-plan') {
      const d = req.body;
      if (!d.roadId || !d.soVisitDate) return res.json({ ok: false, error: 'roadId ও তারিখ প্রয়োজন' });
      const { data: road, error: roadErr } = await supabase.from('roads').select('*').eq('id', d.roadId).single();
      if (roadErr || !road) return res.json({ ok: false, error: 'রোড পাওয়া যায়নি' });
      if (!road.so_id) return res.json({ ok: false, error: 'এই রোডে এখনো কোনো SO নিয়োগ করা হয়নি' });
      const soVisitDate = String(d.soVisitDate).slice(0, 10);
      const dsrVisitDate = addDaysStr(soVisitDate, 1);
      const { data, error } = await supabase.from('road_visit_plans').insert({
        road_id: road.id, road_name: road.name || '',
        so_id: road.so_id, so_name: road.so_name || '',
        dsr_id: road.dsr_id || '', dsr_name: road.dsr_name || '',
        so_visit_date: soVisitDate, dsr_visit_date: dsrVisitDate,
        created_by: d.createdBy || '', created_at: now_()
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, plan: mapRoadPlan(data) });
    }

    if (req.method === 'GET' && action === 'road-plan-list') {
      const { roadId, soId, limit } = req.query;
      let q = supabase.from('road_visit_plans').select('*').order('so_visit_date', { ascending: false });
      if (roadId) q = q.eq('road_id', roadId);
      if (soId)   q = q.eq('so_id', soId);
      const { data, error } = await q.limit(limit ? Number(limit) : 60);
      if (error) throw error;
      return res.json({ ok: true, plans: (data || []).map(mapRoadPlan) });
    }

    // "Due today" lookup used by dashboard.js for both the SO (day 1)
    // and paired DSR (day 2) dashboards — kept here since it's just a
    // date-filtered read of the same table the two actions above own.
    if (req.method === 'GET' && action === 'road-plan-today') {
      const { role, userId } = req.query;
      const todayStr = bdtToday();
      let q = supabase.from('road_visit_plans').select('*');
      if (role === 'so')  q = q.eq('so_id', userId).eq('so_visit_date', todayStr);
      else if (role === 'dsr') q = q.eq('dsr_id', userId).eq('dsr_visit_date', todayStr);
      else return res.json({ ok: false, error: 'role=so অথবা dsr প্রয়োজন' });
      const { data, error } = await q;
      if (error) throw error;
      return res.json({ ok: true, plans: (data || []).map(mapRoadPlan) });
    }

    // ══════════════════════════════════════════════════
    //  WEEKLY RECURRING VISIT PLAN (V56 §4) — replaces the old
    //  date-by-date `road_visit_plans` calendar with a small weekly rule
    //  table (`road_weekly_plans`): Owner picks which weekday(s) an SO
    //  visits a road ONCE, and it repeats automatically forever — no more
    //  clicking every future date. The paired DSR's delivery day keeps
    //  following "the day after the SO's visit" (unchanged rule) — see
    //  dashboard.js, which now resolves "today's duty" LIVE from this
    //  table instead of reading pre-inserted date rows.
    //
    //  One row per (road_id, weekday) — UNIQUE constraint. Editing a
    //  pattern (e.g. swap Wednesday for Thursday) = delete the old
    //  weekday row + add the new one (with a fresh active_from = today),
    //  so past history is untouched and only future occurrences change.
    // ══════════════════════════════════════════════════

    // POST ?action=road-weekly-set — add one weekday rule for a road.
    // Idempotent: if this exact (road, weekday) already exists, returns
    // ok without altering its existing active_from (so re-tapping an
    // already-active day never resets its start date).
    if (req.method === 'POST' && action === 'road-weekly-set') {
      const d = req.body || {};
      const roadId = d.roadId;
      const weekday = Number(d.weekday);
      if (!roadId || !(weekday >= 0 && weekday <= 6)) return res.json({ ok: false, error: 'roadId ও সঠিক সপ্তাহের দিন প্রয়োজন' });
      const { data: road, error: roadErr } = await supabase.from('roads').select('*').eq('id', roadId).single();
      if (roadErr || !road) return res.json({ ok: false, error: 'রোড পাওয়া যায়নি' });
      if (!road.so_id) return res.json({ ok: false, error: 'এই রোডে এখনো কোনো SO নিয়োগ করা হয়নি' });

      const { data: already } = await supabase.from('road_weekly_plans')
        .select('id').eq('road_id', roadId).eq('weekday', weekday).maybeSingle();
      if (already) return res.json({ ok: true, alreadyExists: true });

      // v5.7 — an SO has one body: he cannot visit two different roads on the same weekday.
      // (Different weekdays for different roads are fine — that is how one SO covers many roads.)
      {
        const { data: clash } = await supabase.from('road_weekly_plans')
          .select('road_name').eq('so_id', String(road.so_id)).eq('weekday', weekday).neq('road_id', String(road.id)).limit(1);
        if (clash && clash.length) {
          const DAYS = ['রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার'];
          return res.json({ ok: false, error: road.so_name + ' ' + DAYS[weekday] + ' ইতিমধ্যে "' + (clash[0].road_name || 'অন্য রোড') + '"-এ ভিজিট করেন — একই দিনে দুই রোড দেওয়া যাবে না। অন্য দিন বাছুন।' });
        }
      }

      const { data, error } = await supabase.from('road_weekly_plans').insert({
        road_id: road.id, road_name: road.name || '',
        so_id: road.so_id, so_name: road.so_name || '',
        dsr_id: road.dsr_id || '', dsr_name: road.dsr_name || '',
        weekday, active_from: bdtToday(),
        created_by: d.createdBy || '', created_at: now_()
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, plan: mapRoadWeeklyPlan(data) });
    }

    // DELETE ?action=road-weekly-delete — remove one weekday rule (e.g.
    // when the Owner unchecks a day, or as the first half of "swap this
    // day for another"). Only removes the forward-looking rule — never
    // touches shop_visits (the actual-visit audit trail).
    if (req.method === 'DELETE' && action === 'road-weekly-delete') {
      const d = req.body || req.query || {};
      const roadId = d.roadId;
      const weekday = Number(d.weekday);
      if (!roadId || !(weekday >= 0 && weekday <= 6)) return res.json({ ok: false, error: 'roadId ও সঠিক সপ্তাহের দিন প্রয়োজন' });
      const { error } = await supabase.from('road_weekly_plans').delete().eq('road_id', roadId).eq('weekday', weekday);
      if (error) throw error;
      return res.json({ ok: true });
    }

    // GET ?action=road-weekly-list&roadId= — current weekly pattern
    // (optionally scoped to one road) for the Owner's road-management
    // screen, or for any other reporting need.
    if (req.method === 'GET' && action === 'road-weekly-list') {
      const { roadId } = req.query;
      let q = supabase.from('road_weekly_plans').select('*').order('weekday');
      if (roadId) q = q.eq('road_id', roadId);
      const { data, error } = await q;
      if (error) throw error;
      return res.json({ ok: true, plans: (data || []).map(mapRoadWeeklyPlan) });
    }

    if (req.method === 'GET' && !action) {
      const { soId } = req.query;
      let q = supabase.from('srs').select('*').order('created_at');
      // soId filter: returns only DSRs assigned to this SO
      if (soId) q = q.eq('so_id', soId);
      const { data, error } = await q;
      if (error) throw error;
      return res.json((data || []).map(mapSR));
    }

    if (req.method === 'POST' && !action) {
      const d = req.body;

      // ── Normal DSR/SO creation — auto-assigns a stable, never-reused
      //    display number for the chosen role (AXIION §10) ──────────
      const role = d.role || 'dsr';
      const { data: dn, error: dnErr } = await supabase.rpc('next_sr_display_no', { p_role: role });
      if (dnErr) throw dnErr;

      // ══════════════════════════════════════════════════
      //  SO ↔ DSR AUTO-PAIRING BY REGISTRATION ORDER (Update #20)
      //  No manual "connect"/handshake step anywhere. The 1st SO ever
      //  registered (display_no=1) auto-pairs with the 1st DSR ever
      //  registered (display_no=1), 2nd with 2nd, and so on. Whichever
      //  side registers second simply inherits the pairing that's
      //  already implied by the matching number — nothing to click.
      // ══════════════════════════════════════════════════
      let soId = '', soName = '';
      if (role === 'dsr') {
        // A same-numbered SO may already exist — pair to it immediately.
        const { data: partner } = await supabase.from('srs')
          .select('id,name').eq('role', 'so').eq('display_no', dn).maybeSingle();
        if (partner) { soId = String(partner.id); soName = partner.name || ''; }
      }

      const { data, error } = await supabase.from('srs').insert({
        name: String(d.name||'').trim(), phone: d.phone||'',
        area: d.area||'', role,
        thumb: await resolveThumb(d.thumb, ''),
        so_id: soId, so_name: soName,
        display_no: dn,
        created_at: now_()
      }).select().single();
      if (error) throw error;

      // If this new registration is the SO half of a pairing, and a
      // same-numbered DSR was already registered earlier (unpaired,
      // waiting), link that DSR to this SO now.
      if (role === 'so') {
        const { error: linkErr } = await supabase.from('srs')
          .update({ so_id: String(data.id), so_name: data.name || '' })
          .eq('role', 'dsr').eq('display_no', dn);
        if (linkErr) throw linkErr;
      }

      return res.json({ ok: true, id: data.id, displayNo: dn });
    }

    if (req.method === 'PUT') {
      const d = req.body;
      if (!d.id) return res.json({ ok: false, error: 'id প্রয়োজন' });

      const { data: ex } = await supabase.from('srs').select('thumb').eq('id',d.id).single();
      const thumb = await resolveThumb(d.thumb, ex ? ex.thumb||'' : '');
      // Name/meta edits never touch display_no or so_id — per §10, if the
      // person in a numbered slot changes, only name/phone/area/thumb
      // update; every historical record keeps pointing at the same
      // stable id/display_no. so_id/so_name are never set here — they're
      // only ever set automatically at creation time (Update #20), never
      // by a manual edit.
      const { error } = await supabase.from('srs').update({
        name: String(d.name||'').trim(), phone: d.phone||'',
        area: d.area||'', role: d.role||'dsr', thumb
      }).eq('id', d.id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const id = req.body?.id || req.query?.id;
      if (!id) return res.json({ ok: false, error: 'id প্রয়োজন' });
      const { data: row } = await supabase.from('srs').select('thumb').eq('id', id).single();
      const { error } = await supabase.from('srs').delete().eq('id', id);
      if (error) throw error;
      if (row && row.thumb) deleteThumb(row.thumb);
      return res.json({ ok: true });
    }
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) { res.json({ ok: false, error: safeErr(e) }); }
};
