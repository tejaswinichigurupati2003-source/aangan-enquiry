// Booking from the TRANSCRIPT (decision D45). When Vani's own AI answered the call it cannot see our calendar, so it can only take a request.
// After the call we ask Gemini what the caller actually asked for (day, time, e-mail), check it against REAL availability (designers, the
// studio calendar, office hours) and, if it is free, book it exactly like a dashboard booking: Telegram, calendar event, caller e-mail.
// If it is not free we never double-book: the team is told, with the nearest open slots, and the lead is flagged.
import { loadPrompt } from './prompts.js';
import { getTeam, tzOffset, ownerOf } from './team.js';
import { schedule, fmtWhen } from './actions.js';
import { displayPhone } from './phone.js';
import { findSlots, slotIsFree, parseSpokenEmail, parseWindowHint, speakSlot } from './booking.js';
import { getExternalBusy } from './integrations/ical-busy.js';
import { syncConsultation } from './consult-sync.js';
import { sendTelegram } from './integrations/telegram.js';
import { forceDryRun } from './config.js';

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const pad = (n) => String(n).padStart(2, '0');

/** Ask Gemini what was requested. Returns the validated object, or null when the model could not be used. */
export async function extractBookingRequest({ cfg, provider, transcript, callStartedAt }) {
  const tz = cfg.studio.timezone;
  const f = (o) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...o }).format(new Date(callStartedAt));
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(callStartedAt));
  const input = `CALL DATE (IST): ${date} (${f({ weekday: 'long' })})\nCALL TIME (IST): ${f({ hour: '2-digit', minute: '2-digit', hour12: false })}\n\nTRANSCRIPT:\n${transcript}`;
  try {
    const res = await provider.generateJson({ kind: 'booking_extract', system: loadPrompt(cfg, 'booking-extract').text, messages: [{ role: 'user', text: input }], model: cfg.provider.classifier_model, temperature: 0, ctx: {} });
    const j = res.json;
    if (!j || typeof j !== 'object' || typeof j.wants_consultation !== 'boolean') return null;
    const email = typeof j.email === 'string' ? j.email.trim().toLowerCase() : null;
    return {
      wants: j.wants_consultation,
      date: /^\d{4}-\d{2}-\d{2}$/.test(j.requested_date ?? '') ? j.requested_date : null,
      time: /^\d{2}:\d{2}$/.test(j.requested_time ?? '') ? j.requested_time : null,
      email: email && EMAIL_RE.test(email) && email.length <= 120 ? email : null,
      emailConfirmed: Boolean(j.email_confirmed), flexible: Boolean(j.flexible), evidence: String(j.evidence ?? '').slice(0, 200), by: 'model',
    };
  } catch { return null; }
}

/** Fallback when the model is unavailable: only what can be read with certainty from the caller's own words. */
export function heuristicBookingRequest({ cfg, callerText, callStartedAt }) {
  const hint = parseWindowHint(callerText, cfg, new Date(callStartedAt).getTime());
  const email = parseSpokenEmail(callerText);
  return { wants: Boolean(hint.date || hint.days || hint.hour != null), date: hint.date, time: hint.hour != null ? `${pad(hint.hour)}:00` : null, email, emailConfirmed: false, flexible: false, evidence: '', by: 'heuristic', hint };
}

/**
 * @returns {{status: 'booked'|'conflict'|'skipped', reason?: string}}  Never throws.
 */
export async function bookFromCall({ cfg, store, provider, enquiry, call, fetchImpl, now = new Date() }) {
  try {
    const b = cfg.booking ?? {};
    if (!b.enabled || b.post_call_enabled === false) return { status: 'skipped', reason: 'disabled' };
    if (enquiry.source !== 'live' || enquiry.tier !== 'green') return { status: 'skipped', reason: 'not a live green lead' };
    if (enquiry.consult?.status === 'scheduled') return { status: 'skipped', reason: 'already booked' };
    if (call.postCallBooking) return { status: 'skipped', reason: 'already processed' };
    call.postCallBooking = { at: now.toISOString() };

    const transcript = (call.turns ?? []).map((t) => `${t.role === 'caller' ? 'CALLER' : 'AGENT'}: ${t.text}`).join('\n');
    const callerText = (call.turns ?? []).filter((t) => t.role === 'caller').map((t) => t.text).join(' ');
    const startedAt = call.startedAt ?? now.toISOString();
    let ex = await extractBookingRequest({ cfg, provider, transcript, callStartedAt: startedAt });
    if (!ex) ex = heuristicBookingRequest({ cfg, callerText, callStartedAt: startedAt });
    call.postCallBooking.extracted = { ...ex, hint: undefined };
    if (!ex.wants) { store.event('post_call_booking', { enquiryId: enquiry.id, outcome: 'no_request', source: enquiry.source }); return { status: 'skipped', reason: 'caller did not ask for a consultation' }; }
    if (ex.email) enquiry.fields = { ...enquiry.fields, email: ex.email };

    const io = { cfg, store, fetchImpl };
    const tg = async (text) => { try { await sendTelegram({ ...io, to: 'designer', text, enquiryId: enquiry.id, now, button: false }); } catch (e) { store.event('telegram_error', { enquiryId: enquiry.id, error: e.message }); } };
    const who = `${displayPhone(enquiry.phone)}${enquiry.fields?.name ? ` · ${enquiry.fields.name}` : ''}`;
    const flag = (why) => { enquiry.flags = [...new Set([...(enquiry.flags ?? []), 'slot_needs_confirming'])]; enquiry.activity = [...(enquiry.activity ?? []), { at: now.toISOString(), by: 'system', kind: 'consult', text: why }]; };

    const mins = b.slot_minutes ?? 60;
    const team = getTeam(cfg);
    const off = tzOffset(cfg.studio.timezone, new Date(startedAt));
    const startMs = ex.date && ex.time ? new Date(`${ex.date}T${ex.time}:00${off}`).getTime() : NaN;
    const caller = ex.email ? `\nCaller email: ${ex.email}${ex.emailConfirmed ? ' (read back and confirmed)' : ''}` : '\nNo email captured — please confirm by phone';

    const hintForAlternatives = ex.hint ?? parseWindowHint(`${ex.date ?? ''} ${ex.evidence}`, cfg, now.getTime());
    const alternatives = async () => {
      const busy = await getExternalBusy(cfg, { store, nowMs: now.getTime() });
      return findSlots({ cfg, store, hint: hintForAlternatives, nowMs: now.getTime(), count: 3, busy });
    };
    const conflict = async (reason) => {
      const alts = await alternatives();
      const asked = Number.isFinite(startMs) ? fmtWhen(cfg, new Date(startMs).toISOString()) : (ex.evidence || 'a time that was not clear');
      flag(`The caller asked for ${asked} but it could not be booked (${reason}). Please confirm a time with them.`);
      store.event('post_call_booking', { enquiryId: enquiry.id, outcome: 'conflict', reason, source: enquiry.source });
      store.save();
      await tg(`⚠️ Consultation request needs a person\n${who}\nAsked for: ${asked}\nCould not book: ${reason}${alts.length ? `\nOpen slots: ${alts.map((s) => fmtWhen(cfg, s.start)).join(' · ')}` : ''}${caller}`);
      return { status: 'conflict', reason };
    };

    if (!Number.isFinite(startMs)) return conflict('the day or time was not clear from the call');
    const endMs = startMs + mins * 60000;
    const minNoticeMs = (b.post_call_min_hours ?? 2) * 3600000;
    if (startMs < now.getTime() + minNoticeMs) return conflict('that time is too soon or already past');
    if (startMs > now.getTime() + (b.horizon_days ?? 14) * 2 * 86400000) return conflict('that is too far ahead to book automatically');
    const dow = new Date(`${ex.date}T12:00:00${off}`).getUTCDay();
    if (!(b.working_days ?? [0, 1, 2, 3, 4, 5, 6]).includes(dow)) return conflict('the studio does not take consultations that day');
    const hm = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: cfg.studio.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
    if (hm(startMs) < cfg.studio.office_hours_start || hm(endMs) > cfg.studio.office_hours_end) return conflict(`outside office hours (${cfg.studio.office_hours_start}–${cfg.studio.office_hours_end})`);

    const busy = await getExternalBusy(cfg, { store, nowMs: now.getTime() });
    if (busy.some((x) => x.start < endMs && x.end > startMs)) return conflict('the studio calendar already has something at that time');
    const free = (id) => !store.db.enquiries.some((e) => e.id !== enquiry.id && e.consult?.status === 'scheduled' && e.consult.designerId === id && new Date(e.consult.start).getTime() < endMs && new Date(e.consult.end).getTime() > startMs);
    const owner = ownerOf(enquiry);
    const designer = (owner && free(owner) ? owner : team.designers.find((d) => d.active && free(d.id))?.id) ?? null;
    if (!designer || !slotIsFree(cfg, store, startMs, endMs, { excludeEnquiryId: enquiry.id, busy })) return conflict('every designer is already booked then');

    const r = schedule({ cfg, store, enq: enquiry, start: new Date(startMs).toISOString(), minutes: mins, designerId: designer, force: true, by: 'AI (from the call transcript)', now });
    if (!r.ok) return conflict(r.error);
    enquiry.consult.bookedBy = 'phone_ai'; enquiry.consult.callerEmail = ex.email ?? null; enquiry.consult.fromTranscript = true;
    store.event('post_call_booking', { enquiryId: enquiry.id, outcome: 'booked', start: enquiry.consult.start, hasEmail: Boolean(ex.email), by: ex.by, source: enquiry.source });
    store.save();
    await tg(r.notify.replace('📅 Consultation booked', '📅 Consultation booked by the AI from the call').concat(caller));
    await syncConsultation({ cfg, store, enquiry, fetchImpl });
    return { status: 'booked', start: enquiry.consult.start, hasEmail: Boolean(ex.email) };
  } catch (e) {
    store.event('post_call_booking_error', { enquiryId: enquiry.id, error: e.message });
    return { status: 'skipped', reason: `error: ${e.message}` };
  }
}

export { speakSlot, forceDryRun };
