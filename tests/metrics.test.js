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
