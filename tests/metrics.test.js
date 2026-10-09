import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { callCost, modelCostInr, modelConversationUsage } from '../src/cost.js';
import { computeMetrics } from '../src/metrics.js';
import { renderReport } from '../src/dashboard/report.js';
import { createDashboard } from '../src/dashboard/server.js';
import { createProvider } from '../src/llm/index.js';
import { parseSeed } from '../src/seed.js';
import { runSeedCall } from '../evals/runner.js';
import { scheduleCallbacks } from '../src/callbacks.js';

const cfg = loadConfig({ fresh: true, env: {} });

test('cost: every component is derived from config.yaml (no hard-coded prices)', () => {
  const call = { status: 'completed', durationSec: 150, turns: [{ role: 'agent', text: 'x'.repeat(2000) }], usage: { conversation: { in: 10000, out: 800 }, classifier: { in: 3000, out: 400 } } };
  const c = callCost(cfg, call);
  const fx = cfg.cost_assumptions.usd_to_inr;
  const p = cfg.costs.model_usd_per_million_tokens['gemini-2.5-flash'];
  const expectModel = ((13000 / 1e6) * p.input + (1200 / 1e6) * p.output) * fx;
  assert.ok(Math.abs(c.model - expectModel) < 0.01);
  assert.ok(Math.abs(c.stt - (2.5 * cfg.costs.stt_usd_per_minute * fx)) < 0.01);
  assert.ok(Math.abs(c.tts - ((2000 / 1e6) * cfg.costs.tts_usd_per_million_chars * fx)) < 0.01);
  assert.ok(Math.abs(c.telephony - 3 * cfg.costs.telephony_inr_per_minute) < 0.01); // 150 s = 3 started minutes
  assert.ok(Math.abs(c.hosting - cfg.costs.hosting_inr_per_month / cfg.cost_assumptions.expected_calls_per_month) < 0.01);
  assert.ok(Math.abs(c.total - (c.model + c.stt + c.tts + c.telephony + c.hosting)) < 0.02);
  assert.equal(callCost(cfg, { status: 'missed', durationSec: 0, turns: [], usage: {} }).telephony, 0);
  assert.ok(modelCostInr(cfg, 'unlisted-model', 1e6, 0) > 0, 'unlisted models fall back to the default price row');
  assert.equal(modelConversationUsage(cfg, [{ role: 'caller', text: 'a' }, { role: 'caller', text: 'b' }], 4000).n, 2);
});

async function populated() {
  const store = new Store(null);
  const provider = createProvider(cfg, { name: 'recorded' });
  for (const id of ['T01', 'T03', 'T07', 'T08', 'T09', 'T10']) await runSeedCall({ cfg, store, provider, seed: parseSeed().find((s) => s.id === id) });
  return store;
}

test('metrics: tiers, Green handoffs, cost per Green lead, Red spot-check list, seed safety', async () => {
  const store = await populated();
  const m = computeMetrics(store, cfg, { source: 'all' });
  assert.deepEqual(m.tiers, { green: 1, amber: 2, red: 2, escalate: 1, unclassified: 0 });
  assert.equal(m.handoff.greenHandoffs, 1);
  assert.equal(m.cost.perGreenLead, Math.round(m.cost.totalSpend * 100) / 100, 'with 1 Green lead, cost per Green lead = total spend');
  assert.equal(m.reds.length, 2);
  assert.ok(m.reds.every((r) => r.reason && r.transcript && r.summary));
  assert.equal(m.safety.hubspotOutboxFromSeed, 0);
  assert.ok(m.safety.seedHubspotRefusals >= 1);
  assert.equal(computeMetrics(store, cfg, { source: 'live' }).totals.calls, 0, 'seed data never shows up in the live view');
  assert.match(renderReport(m), /Red — spot-check list/);
  assert.equal(computeMetrics(store, cfg, { source: 'live' }).pipeline?.greenLeads ?? 0, 0);
});

test('missed call → three call-backs scheduled starting at the next office slot; idempotent', async () => {
  const store = await populated();
  const enq = store.db.enquiries.find((e) => e.flags.includes('missed_call'));
  const cbs = store.db.callbacks.filter((c) => c.enquiryId === enq.id);
  assert.equal(cbs.length, 3);
  assert.equal(cbs[0].dueAt, '2026-09-10T10:15:00+05:30'); // missed 9 Sept 22:47 → next morning
  assert.deepEqual(scheduleCallbacks({ cfg, store, enquiry: enq, missedAt: '2026-09-09T22:47:00+05:30' }), []);
});

test('dashboard server: serves page + metrics, stores spot-check reviews, rejects bad input', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aangan-dash-'));
  const store = new Store(dir);
  const provider = createProvider(cfg, { name: 'recorded' });
  await runSeedCall({ cfg, store, provider, seed: parseSeed().find((s) => s.id === 'T03') });
  const redId = store.db.enquiries.find((e) => e.tier === 'red').id;
  const srv = createDashboard(cfg, { dir });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const page = await (await fetch(base + '/')).text();
    assert.match(page, /Aangan Studio — phone enquiries/);
    assert.match(page, /const esc = /, 'page escapes all caller-supplied text');
    const m = await (await fetch(base + '/api/metrics?source=seed')).json();
    assert.equal(m.tiers.red, 1);
    const ok = await fetch(base + '/api/review', { method: 'POST', body: JSON.stringify({ enquiryId: redId, verdict: 'too_strict', note: 'n' }) });
    assert.equal(ok.status, 200);
    assert.equal((await (await fetch(base + '/api/metrics')).json()).redReview.tooStrict, 1);
    assert.equal((await fetch(base + '/api/review', { method: 'POST', body: JSON.stringify({ enquiryId: 'nope', verdict: 'ok' }) })).status, 400);
    assert.equal((await fetch(base + '/api/review', { method: 'POST', body: '{bad' })).status, 400);
    assert.equal((await fetch(base + '/nope')).status, 404);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('store persists atomically to disk and reloads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aangan-store-'));
  const a = new Store(dir);
  a.event('x', { n: 1 });
  const b = new Store(dir);
  assert.equal(b.db.events[0].type, 'x');
  fs.rmSync(dir, { recursive: true, force: true });
});

import { createHandlers, checkAuth, resetCache } from '../src/dashboard/handlers.js';

test('Vercel dashboard handlers: password-gated (503 unset, 401 wrong, 200 right), never leaks data without auth, review persists', async () => {
  const KEY = 'service-role-key-for-tests';
  const store = new Map();
  const fetchImpl = async (url, init = {}) => {
    const t = new URL(url).pathname.split('/').pop();
    store.set(t, store.get(t) ?? new Map());
    if ((init.method || 'GET') === 'POST') { for (const r of JSON.parse(init.body)) store.get(t).set(r.aan_enquiry_id ?? r.aan_id, r); return { ok: true, status: 201, json: async () => ({}) }; }
    return { ok: true, status: 200, json: async () => [...store.get(t).values()].map((r) => ({ aan_data: r.aan_data })) };
  };
  const mkRes = () => { const r = { code: null, headers: {}, body: '' }; r.writeHead = (c, h) => { r.code = c; r.headers = h; }; r.end = (b) => { r.body = b; }; return r; };
  const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: KEY, DASHBOARD_PASSWORD: 'correct horse' };

  // no password configured → closed
  resetCache();
  const closed = createHandlers({ env: { ...env, DASHBOARD_PASSWORD: '' }, fetchImpl });
  let res = mkRes(); await closed.metrics({ url: '/api/metrics', headers: {} }, res); assert.equal(res.code, 503);

  const h = createHandlers({ env, fetchImpl });
  res = mkRes(); await h.metrics({ url: '/api/metrics', headers: {} }, res); assert.equal(res.code, 401); assert.match(res.headers['WWW-Authenticate'], /Basic/);
  assert.doesNotMatch(res.body, /aan_|phone|transcript/);
  res = mkRes(); await h.metrics({ url: '/api/metrics', headers: { authorization: basic('aangan', 'wrong') } }, res); assert.equal(res.code, 401);
  res = mkRes(); await h.page({ url: '/', headers: {} }, res); assert.equal(res.code, 401);

  const good = { authorization: basic('aangan', 'correct horse') };
  res = mkRes(); await h.page({ url: '/', headers: good }, res);
  assert.equal(res.code, 200); assert.match(res.body, /Aangan Studio — phone enquiries/); assert.match(res.headers['X-Robots-Tag'], /noindex/);
  res = mkRes(); await h.metrics({ url: '/api/metrics?source=all', headers: good }, res);
  assert.equal(res.code, 200); assert.equal(JSON.parse(res.body).totals.calls, 0);

  // review: needs a real enquiry
  store.set('aangan_enquiries', new Map([['enq_1', { aan_id: 'enq_1', aan_data: { id: 'enq_1', source: 'live', tier: 'red', callIds: [], classification: {}, handoff: {}, updatedAt: '2026-10-09T00:00:00Z', createdAt: '2026-10-09T00:00:00Z' } }]]));
  resetCache();
  res = mkRes(); await h.review({ method: 'POST', url: '/api/review', headers: good, body: { enquiryId: 'enq_1', verdict: 'too_strict' } }, res);
  assert.equal(res.code, 200); assert.equal(store.get('aangan_reviews').get('enq_1').aan_verdict, 'too_strict');
  res = mkRes(); await h.review({ method: 'POST', url: '/api/review', headers: good, body: { enquiryId: 'nope', verdict: 'ok' } }, res); assert.equal(res.code, 400);
  res = mkRes(); await h.review({ method: 'GET', url: '/api/review', headers: good }, res); assert.equal(res.code, 405);
  assert.equal(checkAuth({ headers: { authorization: basic('someone-else', 'correct horse') } }, env).ok, false, 'wrong username is rejected');
});

test('dashboard login can be turned off only explicitly (DASHBOARD_AUTH=off); a missing password still fails closed', () => {
  assert.equal(checkAuth({ headers: {} }, { DASHBOARD_AUTH: 'off' }).ok, true);
  assert.equal(checkAuth({ headers: {} }, {}).code, 503);
  assert.equal(checkAuth({ headers: {} }, { DASHBOARD_AUTH: 'on' }).code, 503);
  assert.equal(checkAuth({ headers: {} }, { DASHBOARD_AUTH: 'yes', DASHBOARD_PASSWORD: 'pw' }).code, 401);
});

test('metrics series: per-day tier counts and per-hour counts add up to the calls; deltas compare 7-day windows; flags have human labels', async () => {
  const store = await populated();
  const m = computeMetrics(store, cfg, { source: 'all' });
  const s = m.series;
  assert.equal(s.daily.reduce((a, d) => a + d.calls, 0), m.totals.calls, 'every call lands on exactly one day');
  assert.equal(s.hourly.reduce((a, h) => a + h.calls, 0), m.totals.calls);
  assert.equal(s.hourly.length, 24);
  assert.deepEqual([s.officeHours.start, s.officeHours.end], [10, 19]);
  assert.ok(s.hourly.filter((h) => h.office).length === 9);
  const green = s.daily.reduce((a, d) => a + d.green, 0);
  assert.equal(green, store.db.calls.filter((c) => c.tier === 'green').length);
  assert.ok(s.daily.every((d, i, a) => i === 0 || d.date > a[i - 1].date), 'days are consecutive and ascending');
  assert.ok(typeof s.deltas.calls.cur === 'number');
  assert.ok(s.flags.every((f) => f.label && f.count > 0));
  assert.deepEqual(computeMetrics(new Store(null), cfg).series.daily.length, 1, 'an empty store still yields a valid series');
});
