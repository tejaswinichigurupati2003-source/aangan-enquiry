// Dashboard actions on a lead: assign / reassign, change stage, schedule a consultation, add a note.
// Pure functions over the store (no network). They return { ok, enquiry, notify } where `notify` is an optional Telegram text
// for the caller (the API layer) to send; or { error, status, warnings } when the request is refused.
import { getTeam, STAGES, STAGE_FLOW, ownerOf, stageOf, isClosed, autoAssign, pushActivity } from './team.js';
import { displayPhone } from './phone.js';

const fail = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });
const label = (enq) => `${enq.fields?.name || 'Unknown caller'}${enq.fields?.locality ? ` · ${enq.fields.locality}` : ''} · ${displayPhone(enq.phone)}`;
const clean = (s, n = 500) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);

export function fmtWhen(cfg, iso, opts = {}) {
  return new Date(iso).toLocaleString('en-GB', { timeZone: cfg.studio.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, ...opts });
}

export function assign({ cfg, store, enq, ownerId, by, now = new Date() }) {
  const owner = getTeam(cfg).owners.find((o) => o.id === ownerId);
  if (!owner) return fail(400, 'unknown designer');
  const prev = enq.assignment;
  if (prev?.ownerId === owner.id) return { ok: true, enquiry: enq, notify: null };
  enq.assignment = { ownerId: owner.id, ownerName: owner.name, by: by || 'someone', at: now.toISOString(), auto: false, previous: prev?.ownerId ?? null };
  if (enq.consult?.status === 'scheduled') enq.consult.designerId = owner.id; // the consultation moves with the lead
  pushActivity(enq, by, 'assigned', prev ? `Reassigned from ${prev.ownerName} to ${owner.name}` : `Assigned to ${owner.name}`, now);
  store.event('lead_assigned', { enquiryId: enq.id, to: owner.id, from: prev?.ownerId ?? null, by: by || null, source: enq.source });
  store.save();
  return { ok: true, enquiry: enq, notify: `🔁 ${prev ? `Lead reassigned: ${prev.ownerName} → ${owner.name}` : `Lead assigned to ${owner.name}`}\n${label(enq)}${by ? `\nBy ${by}` : ''}` };
}

export function setStage({ store, enq, stage, by, now = new Date() }) {
  if (!STAGES[stage]) return fail(400, 'unknown stage');
  const allowed = STAGE_FLOW[enq.tier] ?? STAGE_FLOW.amber;
  if (!allowed.includes(stage)) return fail(400, `"${STAGES[stage]}" is not a stage for ${enq.tier ?? 'unclassified'} leads`);
  if (stageOf(enq) === stage) return { ok: true, enquiry: enq, notify: null };
  const from = stageOf(enq);
  enq.stage = stage;
  if (stage === 'consult_done' && enq.consult?.status === 'scheduled') enq.consult.status = 'done';
  pushActivity(enq, by, 'stage', `${STAGES[from]} → ${STAGES[stage]}`, now);
  store.event('lead_stage', { enquiryId: enq.id, from, to: stage, by: by || null, source: enq.source });
  store.save();
  return { ok: true, enquiry: enq, notify: null };
}

export function addNote({ store, enq, text, by, now = new Date() }) {
  const t = clean(text);
  if (!t) return fail(400, 'empty note');
  pushActivity(enq, by, 'note', t, now);
  store.save();
  return { ok: true, enquiry: enq, notify: null };
}

/** Does `iso` fall outside office hours or on a Sunday, in the studio's timezone? */
function offHours(cfg, startMs, endMs) {
  const f = (ms, o) => new Intl.DateTimeFormat('en-GB', { timeZone: cfg.studio.timezone, ...o }).format(new Date(ms));
  const hm = (ms) => f(ms, { hour: '2-digit', minute: '2-digit', hour12: false });
  const warnings = [];
  if (f(startMs, { weekday: 'short' }) === 'Sun') warnings.push('This is a Sunday.');
  if (hm(startMs) < cfg.studio.office_hours_start || hm(endMs) > cfg.studio.office_hours_end) warnings.push(`Outside office hours (${cfg.studio.office_hours_start}–${cfg.studio.office_hours_end}).`);
  return warnings;
}

export function schedule({ cfg, store, enq, start, minutes, designerId, force = false, by, now = new Date() }) {
  const team = getTeam(cfg);
  const startMs = new Date(start).getTime();
  if (!Number.isFinite(startMs)) return fail(400, 'invalid start time');
  const mins = Math.round(Number(minutes ?? team.consultMinutes));
  if (!(mins >= 15 && mins <= 240)) return fail(400, 'length must be between 15 and 240 minutes');
  if (startMs < now.getTime() - 5 * 60000) return fail(400, 'that time has already passed');
  const designer = team.owners.find((o) => o.id === (designerId || ownerOf(enq)));
  if (!designer) return fail(400, 'pick a designer first');
  const endMs = startMs + mins * 60000;

  const clashes = store.db.enquiries.filter((e) => e.id !== enq.id && e.consult?.status === 'scheduled' && e.consult.designerId === designer.id
    && new Date(e.consult.start).getTime() < endMs && new Date(e.consult.end).getTime() > startMs);
  if (clashes.length) return fail(409, `${designer.name} already has a consultation at that time (${clashes.map((c) => `${c.fields?.name || displayPhone(c.phone)} ${fmtWhen(cfg, c.consult.start)}`).join(', ')})`, { hard: true });
  const warnings = offHours(cfg, startMs, endMs);
  if (warnings.length && !force) return fail(409, warnings.join(' '), { warnings, needsConfirm: true });

  const rescheduled = enq.consult?.status === 'scheduled';
  enq.consult = { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), designerId: designer.id, status: 'scheduled', createdBy: by || null, createdAt: now.toISOString() };
  if (!enq.assignment || enq.assignment.ownerId !== designer.id) {
    const prev = enq.assignment;
    enq.assignment = { ownerId: designer.id, ownerName: designer.name, by: by || 'someone', at: now.toISOString(), auto: false, previous: prev?.ownerId ?? null };
  }
  if (['new', 'contacted'].includes(stageOf(enq))) enq.stage = 'consult_booked';
  pushActivity(enq, by, 'consult', `${rescheduled ? 'Consultation moved to' : 'Consultation booked for'} ${fmtWhen(cfg, enq.consult.start)} with ${designer.name}`, now);
  store.event('consult_scheduled', { enquiryId: enq.id, designerId: designer.id, start: enq.consult.start, by: by || null, source: enq.source });
  store.save();
  return { ok: true, enquiry: enq, notify: `📅 Consultation ${rescheduled ? 'rescheduled' : 'booked'}\n${label(enq)}\n${fmtWhen(cfg, enq.consult.start)}–${fmtWhen(cfg, enq.consult.end, { weekday: undefined, day: undefined, month: undefined })} IST · ${designer.name}${by ? `\nBy ${by}` : ''}` };
}

export function cancelConsult({ store, enq, by, now = new Date() }) {
  if (enq.consult?.status !== 'scheduled') return fail(400, 'no consultation is booked');
  enq.consult.status = 'cancelled';
  if (stageOf(enq) === 'consult_booked') enq.stage = 'contacted';
  pushActivity(enq, by, 'consult', 'Consultation cancelled', now);
  store.event('consult_cancelled', { enquiryId: enq.id, by: by || null, source: enq.source });
  store.save();
  return { ok: true, enquiry: enq, notify: `❌ Consultation cancelled\n${label(enq)}${by ? `\nBy ${by}` : ''}` };
}

/** Give every open Green / Escalate lead that has no owner one (same rule as new leads). Returns how many were assigned. */
export function autoAssignAll({ cfg, store, by, now = new Date() }) {
  let n = 0; let live = 0;
  for (const e of store.db.enquiries) {
    if (!['green', 'escalate'].includes(e.tier) || e.assignment || isClosed(e)) continue;
    if (autoAssign(cfg, store, e, now)) { n++; if (e.source === 'live') live++; }
  }
  if (n) { store.event('lead_assigned_bulk', { count: n, by: by || null }); store.save(); }
  return { ok: true, count: n, live, notify: live ? `🔁 ${live} existing lead${live === 1 ? '' : 's'} without a designer were shared out automatically${by ? ` by ${by}` : ''}` : null };
}

/** Entry point used by the API layer. */
export function applyAction({ cfg, store, body, now = new Date() }) {
  const enq = store.getEnquiry(body?.enquiryId);
  if (!enq) return fail(404, 'lead not found');
  const by = clean(body.by, 60) || null;
  switch (body.action) {
    case 'assign': return assign({ cfg, store, enq, ownerId: body.ownerId, by, now });
    case 'stage': return setStage({ store, enq, stage: body.stage, by, now });
    case 'note': return addNote({ store, enq, text: body.text, by, now });
    case 'schedule': return schedule({ cfg, store, enq, start: body.start, minutes: body.minutes, designerId: body.designerId, force: body.force === true, by, now });
    case 'cancel_consult': return cancelConsult({ store, enq, by, now });
    case 'consult_done': return setStage({ store, enq, stage: 'consult_done', by, now });
    default: return fail(400, 'unknown action');
  }
}
