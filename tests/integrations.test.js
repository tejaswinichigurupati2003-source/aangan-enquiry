import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, isLive, parseEnv } from '../src/config.js';
import { Store } from '../src/store.js';
import { pushLeadToHubspot, SeedRefusedError, NotGreenError } from '../src/integrations/hubspot.js';
import { sendTelegram, recordAck } from '../src/integrations/telegram.js';
import { sendEmail } from '../src/integrations/email.js';
import { buildDesignerNote, buildEscalationNote } from '../src/notes.js';
import { normalizePhone, extractPhone } from '../src/phone.js';

const dry = () => loadConfig({ fresh: true, env: {} });
const liveCfg = () => { const c = loadConfig({ fresh: true, env: { AANGAN_LIVE: '1', HUBSPOT_TOKEN: 't', TELEGRAM_BOT_TOKEN: 'b', TELEGRAM_DESIGNER_CHAT_ID: '1', TELEGRAM_NIKHIL_CHAT_ID: '2', EMAIL_API_KEY: 'k', EMAIL_FROM: 'a@b.c', EMAIL_TO: 'x@y.z' } }); return c; };
const rec = (over = {}) => ({ source: 'live', tier: 'green', phone: '+919876543210', fields: { name: 'Priya Rao', locality: 'Kothrud' }, flags: [], summary: 's', ...over });
const spy = () => { const calls = []; const f = async (...a) => { calls.push(a); return { ok: true, json: async () => ({ id: '1', results: [] }) }; }; f.calls = calls; return f; };

test('HARD RULE 4: HubSpot refuses source=seed — even when live flag + token are set', async () => {
  const f = spy();
  for (const cfg of [dry(), liveCfg()]) {
    await assert.rejects(() => pushLeadToHubspot(rec({ source: 'seed' }), { cfg, store: new Store(null), fetchImpl: f }), SeedRefusedError);
  }
  assert.equal(f.calls.length, 0, 'no network request may ever be made for seed data');
});

test('HubSpot refuses anything that is not explicitly source=live', async () => {
  for (const source of [undefined, null, '', 'SEED', 'test', 'demo']) {
    await assert.rejects(() => pushLeadToHubspot(rec({ source }), { cfg: dry(), store: new Store(null), fetchImpl: spy() }), SeedRefusedError);
  }
});

test('HubSpot refuses non-green tiers', async () => {
  for (const tier of ['amber', 'red', 'escalate', undefined]) {
    await assert.rejects(() => pushLeadToHubspot(rec({ tier }), { cfg: liveCfg(), store: new Store(null), fetchImpl: spy() }), NotGreenError);
  }
});

test('HubSpot: green live lead in dry-run writes to outbox only; live mode upserts via API', async () => {
  const store = new Store(null); const f = spy();
  const r = await pushLeadToHubspot(rec(), { cfg: dry(), store, fetchImpl: f });
  assert.equal(r.dryRun, true); assert.equal(f.calls.length, 0);
  assert.equal(store.db.outbox[0].channel, 'hubspot');
  const r2 = await pushLeadToHubspot(rec(), { cfg: liveCfg(), store, fetchImpl: f });
  assert.equal(r2.dryRun, false); assert.ok(f.calls.length >= 2); // search + create
});

test('defaults: dry-run on, nothing live without the flag AND credentials', () => {
  const cfg = dry();
  assert.equal(cfg.mode.dry_run, true);
  assert.equal(isLive(cfg, ['HUBSPOT_TOKEN']), false);
  const onlyFlag = loadConfig({ fresh: true, env: { AANGAN_LIVE: '1' } });
  assert.equal(isLive(onlyFlag, ['HUBSPOT_TOKEN']), false);
  const onlyToken = loadConfig({ fresh: true, env: { HUBSPOT_TOKEN: 'x' } });
  assert.equal(isLive(onlyToken, ['HUBSPOT_TOKEN']), false);
  assert.deepEqual(parseEnv('A=1\n# c\nB="two"\n'), { A: '1', B: 'two' });
});

test('Telegram + email: dry-run default writes outbox, live uses fetch; quiet hours are silent', async () => {
  const store = new Store(null); const f = spy();
  await sendTelegram({ cfg: dry(), store, to: 'designer', text: 'x', enquiryId: 'e1', now: new Date('2026-09-02T18:00:00Z'), fetchImpl: f }); // 23:30 IST
  assert.equal(store.db.outbox[0].silent, true);
  await sendTelegram({ cfg: dry(), store, to: 'designer', text: 'x', enquiryId: 'e1', now: new Date('2026-09-02T06:00:00Z'), fetchImpl: f }); // 11:30 IST
  assert.equal(store.db.outbox[1].silent, false);
  assert.equal(f.calls.length, 0);
  await sendTelegram({ cfg: liveCfg(), store, to: 'nikhil', text: 'x', enquiryId: 'e1', fetchImpl: f });
  assert.match(f.calls[0][0], /api\.telegram\.org\/botb\/sendMessage/);
  await sendEmail({ cfg: dry(), store, subject: 's', text: 't', enquiryId: 'e1', fetchImpl: f });
  assert.equal(store.db.outbox.at(-1).channel, 'email');
});

test('designer note: first line is the tap-to-call number, then fields, then a one-line summary', () => {
  const enq = { phone: '+919876543210', source: 'live' };
  const cls = { fields: { name: 'Priya', locality: 'Kothrud', property_type: '3BHK apartment', carpet_area_sqft: 1400, scope: 'full home', timeline_text: 'by March', decision_maker: 'owner + husband', referral_source: 'friend' }, flags: ['decision_maker_unclear'], summary: 'Full 3BHK redo in Kothrud.' };
  const note = buildDesignerNote(enq, cls).split('\n');
  assert.equal(note[0], '+91 98765 43210');
  assert.match(note.join('\n'), /Locality: Kothrud/);
  assert.match(note.join('\n'), /1,400 sq ft carpet/);
  assert.ok(note.some((l) => l.startsWith('Summary: ')));
  assert.equal(buildEscalationNote(enq, { fields: {}, flags: [], reason: 'r' }).split('\n')[0], '+91 98765 43210');
});

test('phone normalisation and extraction', () => {
  assert.equal(normalizePhone('098765 43210'), '+919876543210');
  assert.equal(normalizePhone('+91-98765-43210'), '+919876543210');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(extractPhone('sure, it is 98765 43210 thanks'), '+919876543210');
});

test('store: duplicate caller numbers merge into one enquiry; seed and live never merge', () => {
  const store = new Store(null);
  const mkCall = (id, from, source, at) => ({ id, from, source, startedAt: at, turns: [{ role: 'caller', text: id }], status: 'completed' });
  const c1 = store.addCall(mkCall('c1', '+919876543210', 'live', '2026-09-22T14:14:00+05:30'));
  const e1 = store.attachCall(c1);
  const c2 = store.addCall(mkCall('c2', '+919876543210', 'live', '2026-09-22T14:16:00+05:30'));
  const e2 = store.attachCall(c2);
  assert.equal(e1.id, e2.id); assert.equal(store.db.enquiries.length, 1);
  assert.deepEqual(e2.callIds, ['c1', 'c2']); assert.equal(e2.repeatCaller, true);
  assert.match(store.combinedTranscript(e2), /Call 1 of 2[\s\S]*Call 2 of 2/);
  const c3 = store.addCall(mkCall('c3', '+919876543210', 'seed', '2026-09-22T14:20:00+05:30'));
  assert.notEqual(store.attachCall(c3).id, e1.id);
  const c4 = store.addCall(mkCall('c4', '+919876543210', 'live', '2026-11-30T10:00:00+05:30')); // outside 14-day window
  assert.notEqual(store.attachCall(c4).id, e1.id);
  const c5 = store.addCall(mkCall('c5', null, 'live', '2026-09-22T14:30:00+05:30')); // withheld numbers never merge
  const c6 = store.addCall(mkCall('c6', null, 'live', '2026-09-22T14:31:00+05:30'));
  assert.notEqual(store.attachCall(c5).id, store.attachCall(c6).id);
});

test('designer pickup: ack is recorded once', () => {
  const store = new Store(null);
  store.db.enquiries.push({ id: 'e1', handoff: {} });
  assert.ok(recordAck(store, 'e1', new Date('2026-09-02T10:00:00Z')));
  assert.equal(recordAck(store, 'e1', new Date('2026-09-02T11:00:00Z')), null);
  assert.equal(store.getEnquiry('e1').handoff.ackAt, '2026-09-02T10:00:00.000Z');
});

test('every HubSpot outbox record is tied to its enquiry and source, so the dashboard seed-leak counter is meaningful', async () => {
  const store = new Store(null);
  await pushLeadToHubspot(rec({ enquiryId: 'enq_1' }), { cfg: dry(), store, fetchImpl: spy() });
  const row = store.db.outbox.find((o) => o.channel === 'hubspot');
  assert.equal(row.enquiryId, 'enq_1');
  assert.equal(row.source, 'live');
});

import { setup as hubspotSetup, PROPERTIES } from '../bin/hubspot-setup.js';

test('hubspot-setup: check-only changes nothing; --apply creates only the missing properties; bad token is reported', async () => {
  const existing = new Set(['aangan_tier']); const posts = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/crm/v3/objects/contacts')) return { ok: true, status: 200, json: async () => ({}) };
    if ((init.method || 'GET') === 'POST') { posts.push(JSON.parse(init.body)); return { ok: true, status: 201, json: async () => ({}) }; }
    const name = u.split('/').pop();
    return { ok: existing.has(name), status: existing.has(name) ? 200 : 404, json: async () => ({}) };
  };
  const quiet = () => {};
  const check = await hubspotSetup({ token: 't', apply: false, fetchImpl: f, log: quiet });
  assert.equal(posts.length, 0); assert.deepEqual(check.missing.sort(), ['aangan_flags', 'aangan_source', 'aangan_summary']);
  const done = await hubspotSetup({ token: 't', apply: true, fetchImpl: f, log: quiet });
  assert.equal(posts.length, 3); assert.ok(posts.every((p) => p.groupName === 'contactinformation'));
  assert.deepEqual(done.created.sort(), ['aangan_flags', 'aangan_source', 'aangan_summary']);
  assert.equal(PROPERTIES.length, 4);
  const bad = await hubspotSetup({ token: 'x', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }), log: quiet });
  assert.equal(bad.ok, false);
});

test('the HubSpot contact properties the code writes are exactly the ones the setup script creates', async () => {
  const { toContactProperties } = await import('../src/integrations/hubspot.js');
  const written = Object.keys(toContactProperties(rec())).filter((k) => k.startsWith('aangan_')).sort();
  assert.deepEqual(written, PROPERTIES.map((p) => p.name).sort());
});

import { telegramSetup } from '../bin/telegram-setup.js';

test('telegram-setup: verifies the token, lists chat ids, only sends a message when asked, reports a bad token', async () => {
  const sent = [];
  const f = async (url, init) => {
    const method = String(url).split('/').pop();
    const j = (o) => ({ json: async () => o });
    if (method === 'getMe') return j({ ok: true, result: { username: 'aangan_leads_bot', first_name: 'Aangan Leads' } });
    if (method === 'getUpdates') return j({ ok: true, result: [
      { update_id: 1, message: { chat: { id: 111, type: 'private', first_name: 'Nikhil' } } },
      { update_id: 2, message: { chat: { id: -100222, type: 'supergroup', title: 'Designers' } } },
      { update_id: 3, message: { chat: { id: 111, type: 'private', first_name: 'Nikhil' } } },
    ] });
    if (method === 'sendMessage') { sent.push(JSON.parse(init.body)); return j({ ok: true }); }
    return j({ ok: false });
  };
  const lines = []; const log = (l) => lines.push(l);
  const r = await telegramSetup({ token: 't', fetchImpl: f, log });
  assert.deepEqual(r.chats.map((c) => c.id), [111, -100222], 'duplicates collapsed, group id is negative');
  assert.equal(sent.length, 0, 'no message is sent unless --test is given');
  assert.match(lines.join('\n'), /@aangan_leads_bot/);
  await telegramSetup({ token: 't', testChat: '-100222', fetchImpl: f, log });
  assert.equal(sent.length, 1); assert.equal(sent[0].chat_id, '-100222');
  const bad = await telegramSetup({ token: 'x', fetchImpl: async () => ({ json: async () => ({ ok: false, description: 'Unauthorized' }) }), log });
  assert.equal(bad.ok, false);
});
