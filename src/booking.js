// Booking a consultation slot ON THE CALL (decision D43). The model never invents or promises a time: CODE offers slots taken from real
// availability (office hours, working days, designers who are free) and only "holds" one after the caller says yes. The hold becomes a
// consultation on the lead when the call ends (applyCallBooking), exactly like a dashboard booking.
import { getTeam, tzOffset, ownerOf } from './team.js';
import { schedule, fmtWhen } from './actions.js';
import { displayPhone } from './phone.js';

const DAY = 86400000;
const WEEKDAYS = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6, somvar: 1, mangalvar: 2, budhvar: 3, guruvar: 4, shukravar: 5, shanivar: 6, ravivar: 0 };

const zoneParts = (cfg, ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: cfg.studio.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, dow: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday], hour: Number(p.hour) % 24, minute: Number(p.minute) };
};

/** Rough reading of "weekend mornings", "Saturday after 4", "tomorrow evening", "11 am". Returns only what was actually said. */
export function parseWindowHint(text, cfg, nowMs = Date.now()) {
  const s = String(text ?? '').toLowerCase();
  const hint = { days: null, part: null, hour: null, date: null };
  const days = new Set();
  for (const [w, d] of Object.entries(WEEKDAYS)) if (new RegExp(`\\b${w}s?\\b`).test(s)) days.add(d);
  if (/\bweekends?\b/.test(s)) { days.add(6); days.add(0); }
  if (/\bweek ?days?\b|\bworking days?\b/.test(s)) [1, 2, 3, 4, 5].forEach((d) => days.add(d));
  if (days.size) hint.days = days;
  if (/\btomorrow\b|\bkal\b/.test(s)) hint.date = zoneParts(cfg, nowMs + DAY).ymd;
  if (/\bmorning|subah|savere\b/.test(s)) hint.part = 'morning';
  else if (/\bafternoon|dopahar|lunch\b/.test(s)) hint.part = 'afternoon';
  else if (/\bevening|shaam|after work|night\b/.test(s)) hint.part = 'evening';
  const t = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|baje)\b/) || s.match(/\b(?:at|around|after|before)\s+(\d{1,2})\b/);
  if (t) {
    let h = Number(t[1]); const mer = t[3];
    if (mer === 'pm' && h < 12) h += 12; else if (mer === 'am' && h === 12) h = 0; else if (!mer && h >= 1 && h <= 7) h += 12; // "at 4" in an office-hours context means 4 pm
    if (h >= 0 && h <= 23) hint.hour = h;
  }
  return hint;
}
/** Does this slot satisfy what the caller just said (e.g. "yes, Saturday works")? */
export function slotMatchesHint(cfg, slot, hint) {
  const p = zoneParts(cfg, new Date(slot.start).getTime());
  return (!hint.days || hint.days.has(p.dow)) && (!hint.date || p.ymd === hint.date)
    && (!hint.part || (hint.part === 'morning' ? p.hour < 12 : hint.part === 'afternoon' ? p.hour >= 12 && p.hour < 16 : p.hour >= 16)) && (hint.hour == null || p.hour === hint.hour);
}
export const hintIsEmpty = (h) => !h.days && !h.part && h.hour == null && !h.date;

/** Is at least one active designer free for [startMs, endMs)? Other calls' unsaved holds count as busy. */
export function slotIsFree(cfg, store, startMs, endMs, { excludeCallId = null, excludeEnquiryId = null } = {}) {
  const team = getTeam(cfg);
  const active = team.designers.filter((d) => d.active);
  if (!active.length) return false;
  const overlaps = (s, e) => new Date(s).getTime() < endMs && new Date(e).getTime() > startMs;
  const busy = new Set();
  for (const e of store.db.enquiries) if (e.id !== excludeEnquiryId && e.consult?.status === 'scheduled' && overlaps(e.consult.start, e.consult.end)) busy.add(e.consult.designerId ?? `x_${e.id}`);
  let holds = 0;
  for (const c of store.db.calls) {
    const b = c.state?.booking;
    if (c.id !== excludeCallId && c.status === 'in_progress' && b?.slot && overlaps(b.slot.start, b.slot.end)) holds++;
  }
  return busy.size + holds < active.length;
}

/** Up to `count` real slots matching the hint, nearest first, preferring different days for the 2nd option. */
export function findSlots({ cfg, store, hint = {}, nowMs = Date.now(), count = 2, exclude = [], callId = null }) {
  const b = cfg.booking ?? {};
  const mins = b.slot_minutes ?? 60, ahead = (b.earliest_hours_ahead ?? 24) * 3600000, horizon = b.horizon_days ?? 14;
  const working = new Set(b.working_days ?? [1, 2, 3, 4, 5, 6]);
  const [oh] = cfg.studio.office_hours_start.split(':').map(Number); const [ch] = cfg.studio.office_hours_end.split(':').map(Number);
  const off = tzOffset(cfg.studio.timezone, new Date(nowMs));
  const taken = new Set(exclude);
  const all = [];
  for (let d = 0; d <= horizon; d++) {
    const day = zoneParts(cfg, nowMs + d * DAY);
    if (!working.has(day.dow)) continue;
    for (let h = oh; h + mins / 60 <= ch; h++) {
      const startMs = new Date(`${day.ymd}T${String(h).padStart(2, '0')}:00:00${off}`).getTime();
      if (startMs < nowMs + ahead) continue;
      const endMs = startMs + mins * 60000;
      if (taken.has(new Date(startMs).toISOString())) continue;
      if (!slotIsFree(cfg, store, startMs, endMs, { excludeCallId: callId })) continue;
      all.push({ start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), ymd: day.ymd, dow: day.dow, hour: h });
    }
  }
  const matches = (x) => (!hint.days || hint.days.has(x.dow)) && (!hint.date || x.ymd === hint.date)
    && (!hint.part || (hint.part === 'morning' ? x.hour < 12 : hint.part === 'afternoon' ? x.hour >= 12 && x.hour < 16 : x.hour >= 16))
    && (hint.hour == null || x.hour === hint.hour);
  let pool = all.filter(matches);
  if (!pool.length && hint.hour != null) pool = all.filter((x) => matches({ ...x, hour: hint.hour })); // exact hour full: same day-part elsewhere
  if (!pool.length) pool = all;
  const out = pool.slice(0, 1);
  while (out.length < count && out.length < pool.length) { // further options: prefer a different day from those already chosen
    const next = pool.find((x) => !out.includes(x) && !out.some((o) => o.ymd === x.ymd)) ?? pool.find((x) => !out.includes(x));
    out.push(next);
  }
  return out.map(({ start, end }) => ({ start, end }));
}

/** "Saturday, 17 October at 11 in the morning" — spoken form. */
export function speakSlot(cfg, startIso) {
  const f = (o) => new Intl.DateTimeFormat('en-GB', { timeZone: cfg.studio.timezone, ...o }).format(new Date(startIso));
  const hour = Number(f({ hour: '2-digit', hour12: false })) % 24;
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const min = Number(f({ minute: '2-digit' }));
  const part = hour < 12 ? 'in the morning' : hour < 16 ? 'in the afternoon' : 'in the evening';
  return `${f({ weekday: 'long' })}, ${f({ day: 'numeric' })} ${f({ month: 'long' })} at ${h12}${min ? ` ${String(min).padStart(2, '0')}` : ''} ${part}`;
}

/* ---------- yes / no and spoken e-mail addresses ---------- */
const NO_RE = /\b(?:no|nope|nah|not|don'?t|doesn'?t|can'?t|cannot|won'?t|wrong|incorrect|different|another|later|else|instead|nahi|nahin|nope)\b/i;
const YES_RE = /\b(?:yes|yeah|yep|yup|correct|right|sure|ok(?:ay)?|fine|perfect|great|works?|suits?|good|go ahead|please do|confirm(?:ed)?|haan|haa|ha|theek|thik|bilkul|sahi)\b/i;
export const isNo = (t) => NO_RE.test(String(t));
export const isYes = (t) => YES_RE.test(String(t)) && !NO_RE.test(String(t));

const DIGIT_WORDS = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
const KNOWN_DOMAINS = /@(gmail|yahoo|outlook|hotmail|icloud|rediffmail|proton(?:mail)?)$/;

/** "priya dot k at gmail dot com" / "priya.k@gmail.com" → priya.k@gmail.com, or null. */
export function parseSpokenEmail(text) {
  let s = ` ${String(text ?? '').toLowerCase()} `;
  s = s.replace(/\bat the rate(?: of)?\b|\bat-the-rate\b|\bat sign\b|\battherate\b/g, ' @ ').replace(/\s+at\s+/g, ' @ '); // before the filler words are dropped ("the" is one)
  // drop everything that is talk rather than address ("no, it is …", "sorry, my email id is …")
  s = s.replace(/\b(?:my )?e-?mail(?: id| address)?\b|\bmy id\b|\b(?:it|that|this)(?:'s| is)\b|\b(?:is|no|nope|yes|yeah|sorry|actually|the|so|um|uh|hmm|okay|ok|wait|its|my|mine|sir|madam|correct|wrong|am|are|you|can|could|just|well|then|and|or|please|id|address|mail|let|me|say|again|once|more|ready)\b/g, ' ');
  s = s.replace(/\bat the rate(?: of)?\b|\bat-the-rate\b|\bat sign\b|\battherate\b/g, ' @ ').replace(/\s+at\s+/g, ' @ ');
  s = s.replace(/\bdot\b/g, '.').replace(/\bunderscore\b|\bunder score\b/g, '_').replace(/\b(?:dash|hyphen|minus)\b/g, '-').replace(/\bplus\b/g, '+');
  s = s.replace(/\b(?:double|triple)\s+(\w)\b/g, (m, c) => c.repeat(m.startsWith('double') ? 2 : 3));
  s = s.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/g, (w) => DIGIT_WORDS[w]);
  s = s.replace(/\s+/g, '');
  const at = s.lastIndexOf('@');
  if (at < 1) return null;
  let local = s.slice(0, at).replace(/[^a-z0-9._%+-]/g, ''); let domain = s.slice(at + 1).replace(/[^a-z0-9.-]/g, '');
  if (!local || !domain) return null;
  if (!domain.includes('.') && KNOWN_DOMAINS.test(`@${domain}`)) domain += '.com';
  const email = `${local}@${domain}`.replace(/\.{2,}/g, '.').replace(/\.$/, '');
  return /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email) && email.length <= 120 ? email : null;
}

/** Read an address back the way it is said on the phone. */
export const speakEmail = (email) => String(email).replace(/\./g, ' dot ').replace(/@/g, ' at ').replace(/_/g, ' underscore ').replace(/-/g, ' dash ').replace(/\+/g, ' plus ').replace(/\s+/g, ' ').trim();

/** After the call: turn the held slot into a real consultation on the lead. Returns { booked, notify?, reason? }. */
export function applyCallBooking({ cfg, store, enquiry, call, now = new Date() }) {
  const b = call.state?.booking;
  if (!b?.slot || enquiry.tier !== 'green') return { booked: false };
  if (b.email) { enquiry.fields = { ...enquiry.fields, email: b.email }; }
  const startMs = new Date(b.slot.start).getTime(), endMs = new Date(b.slot.end).getTime();
  const team = getTeam(cfg);
  const free = (id) => !store.db.enquiries.some((e) => e.id !== enquiry.id && e.consult?.status === 'scheduled' && e.consult.designerId === id && new Date(e.consult.start).getTime() < endMs && new Date(e.consult.end).getTime() > startMs);
  const owner = ownerOf(enquiry);
  const designer = (owner && free(owner) ? owner : team.designers.find((d) => d.active && free(d.id))?.id) ?? null;
  const mins = Math.round((endMs - startMs) / 60000);
  const r = designer ? schedule({ cfg, store, enq: enquiry, start: b.slot.start, minutes: mins, designerId: designer, force: true, by: 'AI phone assistant', now }) : { ok: false, error: 'no designer is free any more' };
  if (!r.ok) {
    enquiry.flags = [...new Set([...(enquiry.flags ?? []), 'slot_needs_confirming'])];
    enquiry.activity = [...(enquiry.activity ?? []), { at: now.toISOString(), by: 'system', kind: 'consult', text: `The AI offered ${fmtWhen(cfg, b.slot.start)} on the call but it could not be held (${r.error}). Please confirm a time with the caller.` }];
    store.event('call_booking_failed', { enquiryId: enquiry.id, error: r.error, source: enquiry.source });
    return { booked: false, reason: r.error, notify: `⚠️ The caller was offered ${fmtWhen(cfg, b.slot.start)} but it could not be held (${r.error}).\n${displayPhone(enquiry.phone)} — please confirm a time with them.` };
  }
  enquiry.consult.bookedBy = 'phone_ai'; enquiry.consult.callerEmail = b.email ?? null;
  store.event('call_booking', { enquiryId: enquiry.id, callId: call.id, start: b.slot.start, hasEmail: Boolean(b.email), source: enquiry.source });
  store.save();
  return { booked: true, notify: r.notify.replace('📅 Consultation booked', '📅 Consultation held by the AI on the call').concat(b.email ? `\nCaller email: ${b.email}` : '\nNo email captured — please confirm by phone') };
}
