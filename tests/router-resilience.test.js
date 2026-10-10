import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { route } from '../src/router.js';
import { buildTranscriptMessages } from '../src/notes.js';

const base = loadConfig({ fresh: true, env: {} });

test('transcript messages: whole conversation, split under the Telegram limit, nothing lost', () => {
  const t = '--- Call 1 of 1 · x · completed ---\nAgent: Hello.\nCaller: ' + 'long answer '.repeat(500) + '\nAgent: Thanks.';
  const parts = buildTranscriptMessages(t);
  assert.ok(parts.length >= 2 && parts.every((p) => p.length <= 3700));
  assert.match(parts[0], /Full transcript \(1\//);
  const all = parts.join('\n');
  assert.ok(all.includes('🤖 AI: Hello.') && all.includes('AI: Thanks.') && (all.replace(/[^a-z]/g, '').match(/longanswer/g) || []).length === 500);
  assert.equal(buildTranscriptMessages('Agent: hi').length, 1);
});

test('routing: a failing e-mail provider must not stop Telegram, the transcript, or HubSpot', async () => {
  const cfg = { ...base, mode: { ...base.mode }, env: { AANGAN_LIVE: '1', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_DESIGNER_CHAT_ID: '1', EMAIL_API_KEY: 'k', EMAIL_FROM: 'a@b.c', EMAIL_TO: 'x@y.z', HUBSPOT_TOKEN: 'h' } };
  const store = new Store(null);
  const call = { id: 'c1', source: 'live', from: '+919800099991', startedAt: '2026-10-10T10:00:00Z', endedAt: '2026-10-10T10:05:00Z', status: 'completed', turns: [{ role: 'agent', text: 'Hello' }, { role: 'caller', text: 'I want my 3BHK in Baner designed' }], state: {} };
  store.addCall(call); const enq = store.attachCall(call);
  const sent = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url); sent.push(u);
    if (u.includes('resend')) return { ok: false, status: 403, json: async () => ({ message: 'domain not verified' }) };
    if (u.includes('/contacts/search')) return { ok: true, status: 200, json: async () => ({ results: [] }) };
    return { ok: true, status: 200, json: async () => ({ id: '77', results: [{ id: 'default', label: 'Aangan Enquiries', stages: [{ id: 's1', label: 'New lead' }] }] }) };
  };
  const cls = { tier: 'green', reasons: ['ok'], fields: { name: 'Priya', locality: 'Baner' }, flags: [], summary: 'Priya wants a 3BHK designed.', red_reason: null, next_question: null };
  const r = await route({ cfg, store, enquiry: enq, classification: cls, fetchImpl });
  assert.ok(r.actions.includes('telegram:designer') && r.actions.includes('email:ERROR') && r.actions.includes('hubspot:pushed'), r.actions.join());
  assert.ok(sent.filter((u) => u.includes('api.telegram.org')).length >= 2, 'the note and the transcript both went to Telegram');
  assert.ok(enq.handoff.telegramSentAt && enq.handoff.hubspotId === '77');
  assert.ok(store.db.events.some((e) => e.type === 'email_error'));
});
