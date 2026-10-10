// Team roster, lead ownership, pipeline stages and the "needs attention" list.
// Ownership/stage/consultation live INSIDE the enquiry record (enquiry.assignment / .stage / .consult / .activity), so they
// persist through the existing JSON/Supabase stores with no schema change. None of this is ever spoken to a caller.

export const STAGES = {
  new: 'New',
  contacted: 'Contacted',
  consult_booked: 'Consultation booked',
  consult_done: 'Consultation done',
  won: 'Won',
  lost: 'Lost',
  resolved: 'Resolved',
};
export const CLOSED_STAGES = ['won', 'lost', 'resolved'];
/** Stages offered in the UI per tier (a complaint or a missed call does not go through a sales pipeline). */
export const STAGE_FLOW = {
  green: ['new', 'contacted', 'consult_booked', 'consult_done', 'won', 'lost'],
  amber: ['new', 'contacted', 'resolved'],
  escalate: ['new', 'contacted', 'resolved'],
  red: ['new', 'resolved'],
};

export function getTeam(cfg) {
  const t = cfg.team ?? {};
  const designers = (t.designers ?? []).map((d) => ({ id: d.id, name: d.name, email: d.email || '', active: d.active !== false }));
  const admin = t.admin ?? { id: 'nikhil', name: cfg.studio?.founder_name ?? 'Studio head' };
  return {
    designers, admin,
    owners: [...designers, { id: admin.id, name: admin.name, email: '', active: true }],
    consultMinutes: t.consult_minutes ?? 60,
    pickupAlertMin: t.pickup_alert_minutes ?? 30,
    staleDays: t.stale_lead_days ?? 3,
    calendarViewUrl: t.calendar_view_url ?? 'https://calendar.google.com/calendar/u/0/r/week',
  };
}

export const ownerOf = (enq) => enq.assignment?.ownerId ?? null;
export const stageOf = (enq) => enq.stage ?? 'new';
export const isClosed = (enq) => CLOSED_STAGES.includes(stageOf(enq)) || enq.status === 'closed';

export function pushActivity(enq, by, kind, text, now = new Date()) {
  enq.activity = enq.activity ?? [];
  enq.activity.push({ at: now.toISOString(), by: by || 'system', kind, text });
  if (enq.activity.length > 100) enq.activity = enq.activity.slice(-100);
  enq.lastActivityAt = now.toISOString();
}

/** Least-loaded active designer (open Green leads they own). Ties go to the first in config order. Null if nobody is active. */
export function pickDesigner(cfg, store) {
  const { designers } = getTeam(cfg);
  const active = designers.filter((d) => d.active);
  if (!active.length) return null;
  const load = (id) => store.db.enquiries.filter((e) => ownerOf(e) === id && e.tier === 'green' && !isClosed(e)).length;
  return active.map((d, i) => ({ d, n: load(d.id), i })).sort((a, b) => a.n - b.n || a.i - b.i)[0].d;
}

/** First-time ownership when a lead is routed: Green → least-loaded designer, Escalate → the studio head. Never overrides a person's choice. */
export function autoAssign(cfg, store, enq, now = new Date()) {
  if (enq.assignment) return enq.assignment;
  const team = getTeam(cfg);
  const owner = enq.tier === 'green' ? pickDesigner(cfg, store) : enq.tier === 'escalate' ? team.admin : null;
  if (!owner) return null;
  enq.assignment = { ownerId: owner.id, ownerName: owner.name, by: 'auto', at: now.toISOString(), auto: true };
  pushActivity(enq, 'system', 'assigned', `Assigned to ${owner.name} (${enq.tier === 'green' ? 'least open leads' : 'studio head handles complaints'})`, now);
  return enq.assignment;
}

export function tzOffset(tz, date = new Date()) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(date).find((p) => p.type === 'timeZoneName')?.value ?? '';
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part);
  return m ? `${m[1]}${m[2].padStart(2, '0')}:${m[3] ?? '00'}` : '+00:00';
}

/** Things a person should act on now. Live data only: seed/demo records are static, so "stale" would be meaningless noise. */
export function buildAttention(store, cfg, now = new Date()) {
  const team = getTeam(cfg);
  const out = [];
  const nowMs = now.getTime();
  const add = (kind, sev, enq, text, since) => out.push({ kind, sev, enquiryId: enq.id, ownerId: ownerOf(enq), name: enq.fields?.name || null, phone: enq.phone, tier: enq.tier, text, since: since ?? null });
  for (const e of store.db.enquiries) {
    if (e.source !== 'live' || isClosed(e)) continue;
    const stage = stageOf(e);
    if (e.tier === 'green') {
      if (!ownerOf(e)) add('unassigned', 'high', e, 'Green lead has no designer', e.updatedAt);
      const sent = e.handoff?.telegramSentAt;
      if (sent && !e.handoff?.ackAt && stage === 'new' && (nowMs - new Date(sent)) / 60000 > team.pickupAlertMin) add('not_picked_up', 'high', e, `Note sent ${Math.round((nowMs - new Date(sent)) / 60000)} min ago, nobody tapped "Got it"`, sent);
      const last = new Date(e.lastActivityAt ?? e.updatedAt).getTime();
      if (['new', 'contacted'].includes(stage) && !e.consult && (nowMs - last) / 86400000 > team.staleDays) add('stale', 'med', e, `No activity for ${Math.floor((nowMs - last) / 86400000)} days`, new Date(last).toISOString());
    }
    if (e.tier === 'escalate' && stage === 'new') add('escalation', 'high', e, 'Complaint not yet picked up', e.handoff?.pagedAt ?? e.updatedAt);
    if (e.tier === 'amber') {
      const due = store.db.callbacks.filter((c) => c.enquiryId === e.id && c.status === 'scheduled' && new Date(c.dueAt).getTime() <= nowMs);
      if (due.length) add('callback_due', 'med', e, 'Call-back is due', due[0].dueAt);
      else if (stage === 'new' && (nowMs - new Date(e.queue?.since ?? e.updatedAt)) / 3600000 > 24) add('queue_waiting', 'med', e, 'Waiting in the queue for over a day', e.queue?.since);
    }
    if (e.consult?.status === 'scheduled' && new Date(e.consult.end).getTime() < nowMs) add('consult_overdue', 'med', e, 'Consultation time has passed — mark it done or reschedule', e.consult.end);
  }
  const rank = { high: 0, med: 1 };
  return out.sort((a, b) => rank[a.sev] - rank[b.sev] || String(a.since).localeCompare(String(b.since)));
}

/** Per-owner workload for the studio head. */
export function buildWorkload(store, cfg, now = new Date()) {
  const team = getTeam(cfg);
  const weekEnd = now.getTime() + 7 * 86400000;
  return team.owners.map((o) => {
    const mine = store.db.enquiries.filter((e) => e.source === 'live' && ownerOf(e) === o.id);
    const open = mine.filter((e) => !isClosed(e));
    const acked = mine.filter((e) => e.handoff?.ackAt && e.handoff?.telegramSentAt);
    const pick = acked.map((e) => (new Date(e.handoff.ackAt) - new Date(e.handoff.telegramSentAt)) / 60000).sort((a, b) => a - b);
    return {
      id: o.id, name: o.name, active: o.active, open: open.length,
      awaitingPickup: open.filter((e) => e.tier === 'green' && e.handoff?.telegramSentAt && !e.handoff?.ackAt).length,
      consultsWeek: mine.filter((e) => e.consult?.status === 'scheduled' && new Date(e.consult.start).getTime() >= now.getTime() && new Date(e.consult.start).getTime() <= weekEnd).length,
      won: mine.filter((e) => stageOf(e) === 'won').length, lost: mine.filter((e) => stageOf(e) === 'lost').length,
      medianPickupMin: pick.length ? Math.round(pick[pick.length >> 1] * 10) / 10 : null,
    };
  });
}
