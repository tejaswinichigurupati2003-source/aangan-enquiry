import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { ScriptedProvider } from '../src/llm/scripted.js';
import { bookFromCall, heuristicBookingRequest } from '../src/postcall-booking.js';
import { autoAssign, getTeam } from '../src/team.js';
import { parseVaaniTranscript } from '../src/vaani/api.js';

const cfg = loadConfig({ fresh: true, env: {} });
const NOW = new Date('2026-10-10T11:30:00Z'); // Sat 17:00 IST
const REAL = `[11:26:57] AGENT: Hello, you have reached Aangan Studio.
[11:27:06] USER: This is Piyush, I have a two BHK flat in Baner.
[11:28:15] AGENT: What days and times work best for you for a consultation?
[11:28:18] USER: Tomorrow's IPM works.
[11:28:37] AGENT: Thank you, Piyush. I've noted your details and preferred time for tomorrow at 1:00 PM.
[11:28:41] USER: Tomorrow's five PM
[11:28:50] USER: and my email is piyush dot test at gmail dot com`;

function setup({ model, turnsText = REAL } = {}) {
  const store = new Store(null);
  const call = { id: 'c1', source: 'live', from: '+919800077771', startedAt: '2026-10-10T11:26:41Z', turns: parseVaaniTranscript(turnsText) };
  store.addCall(call);
  const enquiry = store.attachCall(call); enquiry.tier = 'green'; enquiry.fields = { name: 'Piyush', locality: 'Baner' }; enquiry.classification = { summary: 's' };
  autoAssign(cfg, store, enquiry, NOW);
  const provider = new ScriptedProvider(async () => model ?? { wants_consultation: true, requested_date: '2026-10-11', requested_time: '17:00', flexible: false, email: 'piyush.test@gmail.com', email_confirmed: false, evidence: "Tomorrow's five PM" });
  return { store, call, enquiry, provider };
}

test('post-call booking: the LAST thing the caller said wins, the slot is booked for a free designer, e-mail captured', async () => {
  const { store, call, enquiry, provider } = setup();
  const r = await bookFromCall({ cfg, store, provider, enquiry, call, now: NOW });
  assert.equal(r.status, 'booked');
  assert.equal(enquiry.consult.start, '2026-10-11T11:30:00.000Z', '5 PM IST on Sunday 11 Oct');
  assert.equal(enquiry.consult.status, 'scheduled'); assert.equal(enquiry.consult.bookedBy, 'phone_ai'); assert.equal(enquiry.consult.callerEmail, 'piyush.test@gmail.com');
  assert.equal(enquiry.stage, 'consult_booked'); assert.equal(enquiry.fields.email, 'piyush.test@gmail.com');
  const tg = store.db.outbox.filter((o) => o.channel === 'telegram');
  assert.ok(tg.some((o) => /booked by the AI from the call/.test(o.text) && /piyush\.test@gmail\.com/.test(o.text)));
  assert.ok(store.db.outbox.some((o) => o.channel === 'calendar' && o.action === 'create_event'));
  assert.ok(store.db.outbox.some((o) => o.channel === 'email' && o.to === 'piyush.test@gmail.com'));
  assert.equal((await bookFromCall({ cfg, store, provider, enquiry, call, now: NOW })).status, 'skipped', 'idempotent: a re-delivered webhook never books twice');
});

test('post-call booking: if every designer is busy it does NOT double-book; the team is told with open slots', async () => {
  const { store, call, enquiry, provider } = setup();
  getTeam(cfg).designers.forEach((d, i) => store.db.enquiries.push({ id: `busy${i}`, consult: { status: 'scheduled', designerId: d.id, start: '2026-10-11T11:00:00.000Z', end: '2026-10-11T12:00:00.000Z' } }));
  const r = await bookFromCall({ cfg, store, provider, enquiry, call, now: NOW });
  assert.equal(r.status, 'conflict'); assert.equal(enquiry.consult, undefined);
  assert.ok(enquiry.flags.includes('slot_needs_confirming'));
  const msg = store.db.outbox.find((o) => /needs a person/.test(o.text ?? ''));
  assert.ok(msg && /Open slots:/.test(msg.text) && /piyush\.test@gmail\.com/.test(msg.text));
});

test('post-call booking: refuses outside office hours, past times and unclear requests; no request = nothing happens', async () => {
  const run = async (model) => { const s = setup({ model }); const r = await bookFromCall({ cfg, store: s.store, provider: s.provider, enquiry: s.enquiry, call: s.call, now: NOW }); return { r, s }; };
  const base = { wants_consultation: true, requested_date: '2026-10-11', requested_time: '17:00', email: null, email_confirmed: false, flexible: false, evidence: '' };
  assert.match((await run({ ...base, requested_time: '21:00' })).r.reason, /office hours/);
  assert.match((await run({ ...base, requested_date: '2026-10-10', requested_time: '17:30' })).r.reason, /too soon|past/);
  assert.match((await run({ ...base, requested_date: null, requested_time: null })).r.reason, /not clear/);
  const none = await run({ ...base, wants_consultation: false });
  assert.equal(none.r.status, 'skipped'); assert.equal(none.s.enquiry.consult, undefined); assert.equal(none.s.store.db.outbox.filter((o) => o.channel === 'telegram').length, 0);
});

test('post-call booking: only live Green leads; a model that returns junk falls back to what the caller plainly said; a bad e-mail is dropped', async () => {
  const s = setup(); s.enquiry.tier = 'amber';
  assert.equal((await bookFromCall({ cfg, store: s.store, provider: s.provider, enquiry: s.enquiry, call: s.call, now: NOW })).status, 'skipped');
  const j = setup({ model: { nonsense: true } });
  const r = await bookFromCall({ cfg, store: j.store, provider: j.provider, enquiry: j.enquiry, call: j.call, now: NOW });
  assert.equal(j.call.postCallBooking.extracted.by, 'heuristic');
  assert.ok(['booked', 'conflict'].includes(r.status));
  const bad = setup({ model: { wants_consultation: true, requested_date: '2026-10-11', requested_time: '17:00', email: 'not an email', email_confirmed: true, flexible: false, evidence: '' } });
  await bookFromCall({ cfg, store: bad.store, provider: bad.provider, enquiry: bad.enquiry, call: bad.call, now: NOW });
  assert.equal(bad.enquiry.consult.callerEmail, null); assert.equal(bad.enquiry.fields.email, undefined);
  assert.equal(heuristicBookingRequest({ cfg, callerText: 'hello', callStartedAt: NOW.toISOString() }).wants, false);
});
