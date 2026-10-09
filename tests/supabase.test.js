import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { SupabaseStore, SupabaseClient } from '../src/supabase.js';
import { openStore, storageBackend } from '../src/storage.js';
import { Store } from '../src/store.js';
import { createProvider } from '../src/llm/index.js';
import { parseSeed } from '../src/seed.js';
import { runSeedCall } from '../evals/runner.js';
import { computeMetrics } from '../src/metrics.js';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';

const KEY = 'service-role-key-for-tests';
const cfgFor = (env = {}) => loadConfig({ fresh: true, env: { SUPABASE_URL: 'https://example-project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: KEY, ...env } });

/** In-memory PostgREST stand-in: GET select=data, POST upsert with on_conflict (merge-duplicates). */
function mockSupabase({ failPosts = 0 } = {}) {
  const tables = {}; const log = []; let fails = failPosts;
  const keyOf = { aangan_reviews: 'aan_enquiry_id' };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); const table = u.pathname.split('/').pop();
    log.push({ method: init.method || 'GET', table, headers: init.headers, query: Object.fromEntries(u.searchParams) });
    if (init.headers.apikey !== KEY || (!KEY.startsWith('sb_') && init.headers.Authorization !== `Bearer ${KEY}`)) return { ok: false, status: 401, json: async () => ({}) };
    tables[table] ??= new Map();
    if ((init.method || 'GET') === 'POST') {
      if (fails > 0) { fails--; return { ok: false, status: 500, json: async () => ({}) }; }
      const conflict = u.searchParams.get('on_conflict');
      assert.equal(conflict, keyOf[table] ?? 'aan_id');
      assert.match(init.headers.Prefer, /resolution=merge-duplicates/);
      for (const row of JSON.parse(init.body)) tables[table].set(row[conflict], row);
      return { ok: true, status: 201, json: async () => ({}) };
    }
    const rows = [...tables[table].values()].map((r) => ({ aan_data: r.aan_data }));
    return { ok: true, status: 200, json: async () => rows };
  };
  return { tables, log, fetchImpl };
}

test('Supabase client sends the service-role key and refuses to start without credentials', async () => {
  assert.throws(() => new SupabaseClient({ url: '', key: '' }), /SUPABASE_URL/);
  const m = mockSupabase();
  const c = new SupabaseClient({ url: 'https://x.supabase.co/', key: KEY, fetchImpl: m.fetchImpl });
  await c.select('aangan_calls', { limit: 5 });
  assert.equal(m.log[0].headers.apikey, KEY);
  const bad = new SupabaseClient({ url: 'https://x.supabase.co', key: 'wrong', fetchImpl: m.fetchImpl });
  await assert.rejects(() => bad.select('aangan_calls'), /HTTP 401/);
});

test('SupabaseStore: write-through persists calls/enquiries/outbox with typed columns; a fresh store reloads the same state', async () => {
  const m = mockSupabase(); const cfg = cfgFor();
  const store = await new SupabaseStore(cfg, { fetchImpl: m.fetchImpl, debounceMs: 5 }).load();
  const provider = createProvider(cfg, { name: 'recorded' });
  for (const id of ['T01', 'T03']) await runSeedCall({ cfg, store, provider, seed: parseSeed().find((s) => s.id === id) });
  await store.drain();

  const enq = [...m.tables.aangan_enquiries.values()];
  assert.equal(enq.length, 2);
  const red = enq.find((r) => r.aan_tier === 'red');
  assert.equal(red.aan_source, 'seed'); assert.equal(red.aan_phone, '+910000000003'); assert.equal(red.aan_data.classification.red_reason, 'out_of_area');
  assert.equal([...m.tables.aangan_calls.values()].length, 2);
  assert.ok([...m.tables.aangan_outbox.values()].some((o) => o.aan_channel === 'telegram'));
  assert.ok(![...m.tables.aangan_outbox.values()].some((o) => o.aan_channel === 'hubspot'), 'seed data never produced a HubSpot action');
  assert.ok([...m.tables.aangan_events.values()].length > 0);

  const again = await new SupabaseStore(cfg, { fetchImpl: m.fetchImpl }).load();
  assert.equal(again.db.enquiries.length, 2);
  assert.deepEqual(computeMetrics(again, cfg).tiers, computeMetrics(store, cfg).tiers, 'the dashboard sees identical numbers after a reload');
});

test('SupabaseStore: only changed rows are re-sent; unchanged flushes make no write requests', async () => {
  const m = mockSupabase(); const cfg = cfgFor();
  const store = await new SupabaseStore(cfg, { fetchImpl: m.fetchImpl, debounceMs: 1 }).load();
  store.addCall({ id: 'c1', source: 'live', from: '+919800000001', startedAt: '2026-10-09T10:00:00+05:30', status: 'completed', turns: [] });
  store.addCall({ id: 'c2', source: 'live', from: '+919800000002', startedAt: '2026-10-09T10:05:00+05:30', status: 'completed', turns: [] });
  await store.drain();
  const posts = () => m.log.filter((l) => l.method === 'POST').length;
  const first = posts();
  await store.flush(); assert.equal(posts(), first, 'nothing changed → no writes');
  store.getCall('c2').status = 'dropped'; await store.flush();
  assert.equal(posts(), first + 1);
  assert.equal(m.tables.aangan_calls.get('c2').aan_status, 'dropped');
  assert.equal(m.tables.aangan_calls.get('c1').aan_status, 'completed');
});

test('SupabaseStore: an outage never loses data in memory; rows are retried on the next flush', async () => {
  const m = mockSupabase({ failPosts: 1 }); const cfg = cfgFor();
  const store = await new SupabaseStore(cfg, { fetchImpl: m.fetchImpl, debounceMs: 1 }).load();
  store.addCall({ id: 'c9', source: 'live', from: null, startedAt: '2026-10-09T10:00:00+05:30', status: 'completed', turns: [] });
  await assert.rejects(() => store.flush(), /HTTP 500/);
  assert.ok(store.lastError);
  assert.equal(store.db.calls.length, 1, 'still held in memory');
  await store.flush();
  assert.equal(store.lastError, null);
  assert.ok(m.tables.aangan_calls.has('c9'));
});

test('storage: json is the default backend; supabase only when selected', async () => {
  assert.equal(storageBackend(loadConfig({ fresh: true, env: {} })), 'json');
  assert.equal(storageBackend(loadConfig({ fresh: true, env: { STORAGE_BACKEND: 'supabase' } })), 'supabase');
  const s = await openStore(loadConfig({ fresh: true, env: { AANGAN_DATA_DIR: fs.mkdtempSync(path.join(ROOT, 'data', 'tmp-')) } }));
  assert.ok(s instanceof Store);
  fs.rmSync(s.dir, { recursive: true, force: true });
  const m = mockSupabase();
  const sup = await openStore(cfgFor({ STORAGE_BACKEND: 'supabase' }), { fetchImpl: m.fetchImpl });
  assert.ok(sup instanceof SupabaseStore);
});

test('the SQL migration locks the tables down: RLS on, no policies, anon/authenticated revoked, service-role only', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '0001_init.sql'), 'utf8');
  for (const t of ['aangan_calls', 'aangan_enquiries', 'aangan_events', 'aangan_outbox', 'aangan_callbacks', 'aangan_reviews']) {
    assert.match(sql, new RegExp(`alter table public\\.${t}\\s+enable row level security`), `RLS missing on ${t}`);
    assert.match(sql, new RegExp(`public\\.${t}`));
  }
  assert.match(sql, /revoke all on[\s\S]*from anon, authenticated/);
  assert.doesNotMatch(sql, /create policy/i, 'no policies: nothing is readable with the public key');
  assert.match(sql, /aan_source\s+text not null check \(aan_source in \('live', 'seed'\)\)/);
  // additive only: never alters, drops or renames anything that already exists
  assert.doesNotMatch(sql.replace(/--.*$/gm, ''), /\b(alter table (?!public\.aangan_)|drop |truncate|delete from|update )/i);
  // every column of ours is aan_-prefixed (no clash with other apps in the same project)
  const colLines = sql.replace(/--.*$/gm, '').split('\n').filter((l) => /^\s{2}[a-z_]+\s+(text|timestamptz|jsonb)\b/.test(l));
  assert.ok(colLines.length > 20);
  for (const l of colLines) assert.match(l.trim(), /^aan_/, `column not prefixed: ${l}`);
});
