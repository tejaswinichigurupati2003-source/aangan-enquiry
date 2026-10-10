// Calendar helpers. The studio uses Google Calendar; writing into it automatically needs a Google service account or OAuth
// (a credential only the studio can create), so this module builds the next best thing with no credentials at all:
//   • a one-click "Add to Google Calendar" link (the person who clicks it is already signed in), and
//   • a standards .ics file that any calendar app can import.
import { displayPhone } from './phone.js';

const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

export function consultTitle(enq) {
  const f = enq.fields ?? {};
  return `Aangan consultation — ${f.name || 'caller'}${f.locality ? ` (${f.locality})` : ''}`;
}

export function consultDetails(enq) {
  const f = enq.fields ?? {};
  return [
    `Phone: ${displayPhone(enq.phone)}`,
    f.locality ? `Locality: ${f.locality}` : null,
    f.property_type || f.carpet_area_sqft ? `Property: ${[f.property_type, f.carpet_area_sqft ? `${f.carpet_area_sqft} sq ft` : null].filter(Boolean).join(' · ')}` : null,
    f.scope ? `Scope: ${f.scope}` : null,
    f.preferred_window ? `Caller asked for: ${f.preferred_window}` : null,
    enq.classification?.summary ? `Summary: ${enq.classification.summary}` : null,
  ].filter(Boolean).join('\n');
}

export function googleCalendarLink(enq, designer, cfg) {
  const c = enq.consult;
  const q = new URLSearchParams({
    action: 'TEMPLATE', text: consultTitle(enq), details: consultDetails(enq),
    dates: `${stamp(c.start)}/${stamp(c.end)}`, ctz: cfg.studio.timezone,
  });
  if (enq.fields?.locality) q.set('location', enq.fields.locality);
  if (designer?.email) q.set('add', designer.email);
  return `https://calendar.google.com/calendar/render?${q}`;
}

/** The week of the consultation in the studio's own calendar (a plain link to the calendar the team already uses). */
export function calendarWeekLink(cfg, startIso, base) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.studio.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(startIso)).split('-');
  const root = String(base).replace(/\/(week|day|month)(\/.*)?$/, '/week').replace(/\/+$/, '');
  return `${root}/${parts[0]}/${Number(parts[1])}/${Number(parts[2])}`;
}

export function buildIcs(enq, designer, cfg) {
  const c = enq.consult;
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Aangan Studio//Enquiry system//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${enq.id}-consult@aangan`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(c.start)}`, `DTEND:${stamp(c.end)}`,
    `SUMMARY:${esc(consultTitle(enq))}`, `DESCRIPTION:${esc(consultDetails(enq))}`,
    enq.fields?.locality ? `LOCATION:${esc(enq.fields.locality)}` : null,
    designer?.email ? `ATTENDEE;CN=${esc(designer.name)}:mailto:${designer.email}` : null,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].filter((l) => l !== null).join('\r\n');
}
