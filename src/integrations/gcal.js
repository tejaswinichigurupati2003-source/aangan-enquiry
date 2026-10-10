// Google Calendar: put the consultation straight onto the studio's shared calendar, so the slot is genuinely BLOCKED.
// Uses a Google SERVICE ACCOUNT (zero dependencies: the JWT is signed with node:crypto). Setup (done by the studio, once):
//   1. Google Cloud → create a service account → create a JSON key.   2. Enable the "Google Calendar API" for that project.
//   3. Share the studio calendar with the service account's e-mail ("Make changes to events").
//   4. Put the JSON (one line) in GOOGLE_SERVICE_ACCOUNT_JSON and the calendar id in GOOGLE_CALENDAR_ID.
// Service accounts cannot invite guests, so the caller gets their invite by e-mail instead (see sendCallerConfirmation).
// DRY-RUN by default (outbox); test/seed leads are forced dry-run by the callers.
import crypto from 'node:crypto';
import { isLive } from '../config.js';
import { consultTitle, consultDetails } from '../calendar.js';

const b64 = (x) => Buffer.from(x).toString('base64url');
let tokenCache = null;

async function accessToken(cfg, fetchImpl) {
  if (tokenCache && tokenCache.exp > Date.now() + 60000) return tokenCache.token;
  const sa = JSON.parse(cfg.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/calendar.events', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }))}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  if (!res.ok) throw new Error(`Google token ${res.status}`);
  const j = await res.json();
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return tokenCache.token;
}
export const resetGoogleToken = () => { tokenCache = null; };

export function eventBody(cfg, enq, designerName) {
  const c = enq.consult;
  return {
    summary: `${consultTitle(enq)}${designerName ? ` · ${designerName}` : ''}`,
    description: `${consultDetails(enq)}${c.callerEmail ? `\nCaller email: ${c.callerEmail}` : ''}${c.bookedBy === 'phone_ai' ? '\nBooked by the AI phone assistant on the call.' : ''}\nLead: ${enq.id}`,
    start: { dateTime: c.start, timeZone: cfg.studio.timezone }, end: { dateTime: c.end, timeZone: cfg.studio.timezone },
    ...(enq.fields?.locality ? { location: enq.fields.locality } : {}),
  };
}

/** Create / move / remove the calendar event to match the lead's consultation. Never throws; returns {skipped|dryRun|id}. */
export async function syncCalendar({ cfg, store, enquiry, designerName, fetchImpl = fetch }) {
  const c = enquiry.consult;
  if (!c) return { skipped: 'no_consultation' };
  const want = c.status === 'scheduled';
  if (!isLive(cfg, ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_CALENDAR_ID'])) {
    if (want || c.gcalEventId) store?.outboxPush({ channel: 'calendar', dryRun: true, enquiryId: enquiry.id, source: enquiry.source, action: want ? (c.gcalEventId ? 'update_event' : 'create_event') : 'delete_event', payload: want ? eventBody(cfg, enquiry, designerName) : undefined });
    return { dryRun: true };
  }
  try {
    const token = await accessToken(cfg, fetchImpl);
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cfg.env.GOOGLE_CALENDAR_ID)}/events`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (!want) {
      if (c.gcalEventId) { await fetchImpl(`${base}/${c.gcalEventId}`, { method: 'DELETE', headers }); delete c.gcalEventId; }
      return { deleted: true };
    }
    let res = c.gcalEventId ? await fetchImpl(`${base}/${c.gcalEventId}`, { method: 'PATCH', headers, body: JSON.stringify(eventBody(cfg, enquiry, designerName)) }) : null;
    if (!res || res.status === 404) res = await fetchImpl(base, { method: 'POST', headers, body: JSON.stringify(eventBody(cfg, enquiry, designerName)) });
    if (!res.ok) throw new Error(`Google Calendar ${res.status}`);
    c.gcalEventId = (await res.json()).id;
    store?.outboxPush({ channel: 'calendar', dryRun: false, enquiryId: enquiry.id, source: enquiry.source, action: 'sync_event', id: c.gcalEventId });
    return { dryRun: false, id: c.gcalEventId };
  } catch (e) {
    store?.event('calendar_error', { enquiryId: enquiry.id, error: e.message });
    return { skipped: 'error', error: e.message };
  }
}
