import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { CallEngine } from '../src/engine.js';
import { ScriptedProvider } from '../src/llm/scripted.js';
import { guardReply } from '../src/guard.js';
import { getTeam, autoAssign } from '../src/team.js';
import { parseSpokenEmail, speakEmail, parseWindowHint, findSlots, speakSlot, slotIsFree, applyCallBooking, isYes, isNo } from '../src/booking.js';
import { syncConsultation } from '../src/consult-sync.js';
import { syncCalendar, eventBody, resetGoogleToken } from '../src/integrations/gcal.js';
import { syncDeal, resetPipelineCache } from '../src/integrations/hubspot-deals.js';
import crypto from 'node:crypto';

const cfg = loadConfig({ fresh: true, env: {} });
const NOW = new Date('2026-10-09T06:30:00Z'); // Fri 12:00 IST

/** A cooperative model: has already understood everything, and (like a real one) wants to chat on. */
const model = new ScriptedProvider(async () => ({
  reply: '', language: 'en', signals: {}, asking_about: 'none', ready_to_close: false,
  updates: { name: 'Priya Kulkarni', locality: 'Baner', property_type: '3 BHK flat', carpet_area_sqft: 1400, scope: 'full home', timeline_text: 'in four months', decision_maker: 'myself', referral_source: 'a friend', preferred_window: 'Saturday mornings' },
  assessment: { real_project: { verdict: 'pass', fail_reason: null }, service_area: { verdict: 'pass' }, timeline: { mentioned: true, urgency_cue: false, completion_in_weeks: 16, flexible: true }, budget: { assessment: 'not_mentioned' }, decision_maker: { verdict: 'pass' } },
}));
const engineFor = (store, over = {}) => new CallEngine({ cfg: { ...cfg, booking: { ...cfg.booking, ...over } }, provider: model, store, now: () => NOW });
const LINE = 'Hi, I am Priya from Baner, I have a 3 BHK flat of 1400 square feet and want the whole home done in four months, Saturday mornings suit me.';

test('spoken e-mail addresses are understood and read back safely', () => {
  assert.equal(parseSpokenEmail('my email is priya dot kulkarni at gmail dot com'), 'priya.kulkarni@gmail.com');
  assert.equal(parseSpokenEmail("it's rahul underscore mehta nine two at the rate of outlook dot com"), 'rahul_mehta92@outlook.com');
  assert.equal(parseSpokenEmail('sneha at gmail'), 'sneha@gmail.com');
  assert.equal(parseSpokenEmail('priya.k@studio.co.in'), 'priya.k@studio.co.in');
  assert.equal(parseSpokenEmail('I would rather not say'), null);
  assert.equal(parseSpokenEmail('at gmail dot com'), null);
  assert.equal(speakEmail('priya.k_92@gmail.com'), 'priya dot k underscore 92 at gmail dot com');
  assert.ok(isYes('yes that works') && isYes('haan theek hai') && !isYes('no that is wrong') && isNo("that doesn't work") && !isNo('perfect'));
});

test('window hints are read conservatively; slots come from real availability only', () => {
  const h = parseWindowHint('Saturday mornings, maybe 11 am', cfg, NOW.getTime());
  assert.deepEqual([...h.days], [6]); assert.equal(h.part, 'morning'); assert.equal(h.hour, 11);
  assert.equal(parseWindowHint('whenever', cfg, NOW.getTime()).days, null);
  const store = new Store(null);
  const [a, b] = findSlots({ cfg, store, hint: parseWindowHint('weekday mornings', cfg, NOW.getTime()), nowMs: NOW.getTime() });
  assert.match(speakSlot(cfg, a.start), /^\w+day, \d+ October at \d+ in the morning$/);
  assert.notEqual(a.start.slice(0, 10), b.start.slice(0, 10), 'second option is on a different day');
  for (const s of [a, b]) {
    assert.ok(new Date(s.start) - NOW >= 24 * 3600000, 'never sooner than the minimum notice');
    assert.notEqual(new Date(s.start).toLocaleDateString('en-US', { timeZone: cfg.studio.timezone, weekday: 'short' }), 'Sun');
    assert.equal(guardReply(speakSlot(cfg, s.start)).blocked, false);
  }
  // all designers busy at that time -> the slot is not offered
  const busy = new Store(null);
  getTeam(cfg).designers.forEach((d, i) => busy.db.enquiries.push({ id: `e${i}`, consult: { status: 'scheduled', designerId: d.id, start: a.start, end: a.end } }));
  assert.equal(slotIsFree(cfg, busy, new Date(a.start).getTime(), new Date(a.end).getTime()), false);
  assert.ok(!findSlots({ cfg, store: busy, hint: parseWindowHint('weekday mornings', cfg, NOW.getTime()), nowMs: NOW.getTime(), count: 20 }).some((s) => s.start === a.start));
});

test('on the call: offer a real slot → caller agrees → asks e-mail → reads it back → books, never names a designer', async () => {
  const store = new Store(null); const eng = engineFor(store);
  const { call } = eng.start({ from: '+919800011111', startedAt: NOW.toISOString(), source: 'live' });
  const offer = await eng.turn(call, LINE);
  assert.match(offer.reply, /^I can hold (?:Saturday|Monday|Tuesday|Wednesday|Thursday|Friday), \d+ October at \d+ in the morning for your consultation\. Does that work for you\?$/);
  assert.equal(call.state.booking.phase, 'offer');
  const ask = await eng.turn(call, 'Yes, that works');
  assert.match(ask.reply, /email address/); assert.equal(call.state.booking.phase, 'ask_email');
  const read = await eng.turn(call, 'priya dot kulkarni at gmail dot com');
  assert.equal(read.reply, 'I have priya dot kulkarni at gmail dot com. Is that correct?');
  const done = await eng.turn(call, 'yes that is right');
  assert.equal(done.done, true); assert.match(done.reply, /^All set\. I've held .* for your consultation and the invite will go to your email\. The team will confirm the details with you directly\./);
  assert.equal(call.state.booking.slot.start, call.state.booking.slots[0].start); assert.equal(call.state.booking.email, 'priya.kulkarni@gmail.com');
  for (const d of getTeam(cfg).designers) assert.ok(!call.turns.some((t) => t.text.includes(d.name)), 'no designer is ever named to a caller');
  assert.ok(call.guardEvents.length === 0, 'every booking line passed the output guard untouched');
  assert.ok(call.engineFlags.includes('slot_held'));
});

test('on the call: a wrong e-mail is corrected; refusing to give one still books the slot (team confirms by phone)', async () => {
  const store = new Store(null); const eng = engineFor(store);
  const { call } = eng.start({ from: '+919800011112', startedAt: NOW.toISOString(), source: 'live' });
  await eng.turn(call, LINE); await eng.turn(call, 'yes');
  await eng.turn(call, 'priya at gmail dot com');
  const fix = await eng.turn(call, 'no, it is priya dot k at gmail dot com');
  assert.equal(fix.reply, 'I have priya dot k at gmail dot com. Is that correct?');
  const ok = await eng.turn(call, 'correct'); assert.equal(call.state.booking.email, 'priya.k@gmail.com'); assert.ok(ok.done);

  const { call: c2 } = eng.start({ from: '+919800011113', startedAt: NOW.toISOString(), source: 'live' });
  await eng.turn(c2, LINE); await eng.turn(c2, 'sounds good');
  const end = await eng.turn(c2, "I'd rather not give my email");
  assert.ok(end.done); assert.equal(c2.state.booking.email, null); assert.ok(c2.engineFlags.includes('no_email_captured'));
  assert.doesNotMatch(end.reply, /invite will go to your email/);
});

test('on the call: "no" moves to the second option, a new day is searched, and after the limit it falls back to a plain request', async () => {
  const store = new Store(null); const eng = engineFor(store);
  const { call } = eng.start({ from: '+919800011114', startedAt: NOW.toISOString(), source: 'live' });
  const first = await eng.turn(call, LINE);
  const second = await eng.turn(call, 'no, that does not suit me');
  assert.match(second.reply, /^Another option is /); assert.notEqual(second.reply.replace('Another option is ', ''), first.reply);
  const third = await eng.turn(call, 'what about Thursday evening');
  assert.match(third.reply, /Thursday.*in the evening/);
  const gave = await eng.turn(call, 'no, never mind');
  assert.ok(gave.done); assert.match(gave.reply, /confirm the consultation with you directly/); assert.equal(call.state.booking.slot, null);
});

test('policy questions during booking: bot disclosure and the pricing line still win, then the open question is repeated', async () => {
  const store = new Store(null); const eng = engineFor(store);
  const { call } = eng.start({ from: '+919800011115', startedAt: NOW.toISOString(), source: 'live' });
  await eng.turn(call, LINE);
  const bot = await eng.turn(call, 'wait, are you a robot?');
  assert.match(bot.reply, /AI assistant/); assert.match(bot.reply, /Does that work for you\?$/);
  const price = await eng.turn(call, 'how much will it cost?');
  assert.match(price.reply, /^Pricing depends on the site/); assert.doesNotMatch(price.reply, /\d{3}/);
});

test('seed/test calls and booking.enabled=false keep the old request-only close', async () => {
  const store = new Store(null);
  const { call } = engineFor(store).start({ from: '+919800011116', startedAt: NOW.toISOString(), source: 'seed' });
  const r = await engineFor(store).turn(call, LINE);
  assert.doesNotMatch(r.reply, /I can hold/);
  const { call: c2 } = engineFor(store, { enabled: false }).start({ from: '+919800011117', startedAt: NOW.toISOString(), source: 'live' });
  assert.doesNotMatch((await engineFor(store, { enabled: false }).turn(c2, LINE)).reply, /I can hold/);
});

test('after the call: the held slot becomes a consultation with a free designer; conflicts are reported, never double-booked', async () => {
  const store = new Store(null); const eng = engineFor(store);
  const mk = async (phone) => {
    const { call } = eng.start({ from: phone, startedAt: NOW.toISOString(), source: 'live' });
    await eng.turn(call, LINE); await eng.turn(call, 'yes'); await eng.turn(call, 'priya at gmail dot com'); await eng.turn(call, 'yes');
    const enq = { id: `enq_${phone}`, source: 'live', phone, tier: 'green', fields: { name: 'Priya Kulkarni', locality: 'Baner' }, flags: [], callIds: [call.id], handoff: {}, classification: { summary: 's' } };
    store.db.enquiries.push(enq); autoAssign(cfg, store, enq, NOW);
    return { call, enq };
  };
  const a = await mk('+919800011118');
  const r = applyCallBooking({ cfg, store, enquiry: a.enq, call: a.call, now: NOW });
  assert.ok(r.booked); assert.equal(a.enq.consult.status, 'scheduled'); assert.equal(a.enq.consult.bookedBy, 'phone_ai'); assert.equal(a.enq.consult.callerEmail, 'priya@gmail.com');
  assert.equal(a.enq.fields.email, 'priya@gmail.com'); assert.equal(a.enq.stage, 'consult_booked'); assert.match(r.notify, /held by the AI on the call/);
  // someone grabs the same slot for every designer before the 2nd call's hold is applied
  const b = await mk('+919800011119'); b.call.state.booking.slot = { ...a.call.state.booking.slot };
  for (const d of getTeam(cfg).designers) if (d.id !== a.enq.consult.designerId) store.db.enquiries.push({ id: `x_${d.id}`, consult: { status: 'scheduled', designerId: d.id, start: a.enq.consult.start, end: a.enq.consult.end } });
  const r2 = applyCallBooking({ cfg, store, enquiry: b.enq, call: b.call, now: NOW });
  assert.equal(r2.booked, false); assert.ok(b.enq.flags.includes('slot_needs_confirming')); assert.match(r2.notify, /could not be held/);
  assert.equal(b.enq.consult, undefined);
});

test('calendar + caller e-mail: dry-run by default, live only with credentials, test data never goes out', async () => {
  const store = new Store(null);
  const enq = { id: 'enq_c', source: 'live', phone: '+919800011120', tier: 'green', fields: { name: 'Priya Kulkarni', locality: 'Baner', email: 'priya@gmail.com' }, flags: [], handoff: {}, classification: { summary: 's' }, consult: { status: 'scheduled', start: '2026-10-12T05:30:00.000Z', end: '2026-10-12T06:30:00.000Z', designerId: 'designer_1', callerEmail: 'priya@gmail.com', bookedBy: 'phone_ai' } };
  await syncConsultation({ cfg, store, enquiry: enq });
  assert.ok(store.db.outbox.some((o) => o.channel === 'calendar' && o.dryRun && o.action === 'create_event'));
  const mail = store.db.outbox.find((o) => o.channel === 'email'); assert.ok(mail.dryRun && mail.to === 'priya@gmail.com' && /Your Aangan Studio consultation/.test(mail.subject));
  assert.ok(!/Ananya|Rohan|Meera/.test(mail.text), 'the caller e-mail does not name a designer');

  // live with credentials: token + event + e-mail requests are made (fake Google/Resend), the calendar id is stored
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const live = { ...cfg, mode: { ...cfg.mode }, env: { AANGAN_LIVE: '1', GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: privateKey }), GOOGLE_CALENDAR_ID: 'studio@group.calendar.google.com', EMAIL_API_KEY: 'k', EMAIL_FROM: 'a@b.c' } };
  const calls = [];
  const fetchImpl = async (url, init = {}) => { calls.push([String(url), init.method, init.body]); return { ok: true, status: 200, json: async () => (String(url).includes('oauth2') ? { access_token: 't', expires_in: 3600 } : { id: 'evt1' }) }; };
  resetGoogleToken();
  const store2 = new Store(null); const enq2 = structuredClone(enq);
  await syncConsultation({ cfg: live, store: store2, enquiry: enq2, fetchImpl });
  assert.equal(enq2.consult.gcalEventId, 'evt1');
  const ev = calls.find((c) => c[0].includes('/calendars/') && c[1] === 'POST'); assert.match(ev[0], /studio%40group\.calendar\.google\.com/);
  assert.equal(JSON.parse(ev[2]).start.timeZone, 'Asia/Kolkata');
  const em = calls.find((c) => c[0].includes('resend')); assert.deepEqual(JSON.parse(em[2]).to, ['priya@gmail.com']); assert.ok(JSON.parse(em[2]).attachments[0].content.length > 20);
  await syncConsultation({ cfg: live, store: store2, enquiry: enq2, fetchImpl }); // second sync: update, and no second e-mail
  assert.equal(calls.filter((c) => c[0].includes('resend')).length, 1); assert.ok(calls.some((c) => c[1] === 'PATCH'));
  // test/seed data: forced dry run even with live credentials
  const seedEnq = { ...structuredClone(enq), source: 'seed', consult: { ...enq.consult } }; const calls2 = [];
  await syncConsultation({ cfg: live, store: new Store(null), enquiry: seedEnq, fetchImpl: async (u) => { calls2.push(u); return { ok: true, json: async () => ({}) }; } });
  assert.equal(calls2.length, 0);
  // cancelling removes the event
  enq2.consult.status = 'cancelled'; await syncCalendar({ cfg: live, store: store2, enquiry: enq2, fetchImpl });
  assert.ok(calls.some((c) => c[1] === 'DELETE')); assert.ok(eventBody(cfg, { ...enq, consult: enq.consult }).description.includes('Booked by the AI'));
});

test('HubSpot deals: live Green only, stage follows the dashboard, degrades quietly without deal scopes', async () => {
  const { SeedRefusedError, NotGreenError } = await import('../src/integrations/hubspot.js');
  const store = new Store(null);
  const base = { id: 'enq_d', source: 'live', tier: 'green', phone: '+919800011121', fields: { name: 'Priya Kulkarni', locality: 'Baner' }, handoff: { hubspotId: '555' }, classification: { summary: 's' }, assignment: { ownerName: 'Ananya Kulkarni' } };
  await assert.rejects(syncDeal({ cfg, store, enquiry: { ...base, source: 'seed' } }), SeedRefusedError);
  await assert.rejects(syncDeal({ cfg, store, enquiry: { ...base, tier: 'amber' } }), NotGreenError);
  const dry = await syncDeal({ cfg, store, enquiry: { ...structuredClone(base), stage: 'consult_booked' } });
  assert.ok(dry.dryRun); assert.equal(store.db.outbox.at(-1).payload.dealstage, 'Consultation booked');

  const live = { ...cfg, mode: { ...cfg.mode }, env: { AANGAN_LIVE: '1', HUBSPOT_TOKEN: 't' } };
  const reqs = [];
  const ok = async (url, init = {}) => {
    reqs.push([String(url), init.method, init.body]);
    if (String(url).endsWith('/pipelines/deals')) return { ok: true, status: 200, json: async () => ({ results: [{ id: 'default', label: 'Aangan Enquiries', stages: [{ id: 's1', label: 'New lead' }, { id: 's3', label: 'Consultation booked' }, { id: 's5', label: 'Won' }] }] }) };
    return { ok: true, status: 200, json: async () => ({ id: 'deal9' }) };
  };
  resetPipelineCache();
  const enq = structuredClone(base);
  assert.equal((await syncDeal({ cfg: live, store, enquiry: enq, fetchImpl: ok })).id, 'deal9');
  const create = JSON.parse(reqs.find((r) => r[1] === 'POST')[2]);
  assert.equal(create.properties.dealstage, 's1'); assert.equal(create.associations[0].to.id, '555'); assert.equal(create.associations[0].types[0].associationTypeId, 3);
  enq.stage = 'consult_booked'; await syncDeal({ cfg: live, store, enquiry: enq, fetchImpl: ok });
  assert.equal(JSON.parse(reqs.filter((r) => r[1] === 'PATCH').at(-1)[2]).properties.dealstage, 's3');
  // no deal scopes on the key: nothing throws, one event
  resetPipelineCache(); const e2 = structuredClone(base);
  const denied = await syncDeal({ cfg: live, store, enquiry: e2, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) });
  assert.equal(denied.skipped, 'missing_scopes'); assert.equal(store.db.events.filter((e) => e.type === 'hubspot_deals_scopes_missing').length, 1);
});
