import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { ScriptedProvider } from '../src/llm/scripted.js';
import { handleVaaniWebhook } from '../src/vaani/vercel.js';

const base = loadConfig({ fresh: true, env: {} });
const cfg = { ...base, env: { VAANI_WEBHOOK_SECRET: 's3cret-value' } };
const provider = new ScriptedProvider(async () => ({}));
const run = (over = {}) => handleVaaniWebhook({ cfg, store: over.store ?? new Store(null), provider, secret: 's3cret-value', payload: { event: 'call_started', room_name: 'room-1', phone_number: '+919800000001', timestamp: 't1' }, ...over });

test('serverless webhook: wrong secret 403, no secret configured 503, bad body 400', async () => {
  assert.equal((await run({ secret: 'nope' })).code, 403);
  assert.equal((await run({ secret: undefined })).code, 403);
  assert.equal((await handleVaaniWebhook({ cfg: { ...base, env: {} }, store: new Store(null), provider, secret: 'x', payload: {} })).code, 503);
  assert.equal((await run({ payload: null })).code, 400);
  assert.equal((await run({ secret: encodeURIComponent('s3cret-value') })).code, 200, 'URL-encoded secret from the rewrite still matches');
});

test('serverless webhook: events are stored once; a redelivery is recognised from the stored events (no shared memory needed)', async () => {
  const store = new Store(null);
  const a = await run({ store }); assert.equal(a.code, 200); assert.equal(a.body.duplicate, undefined);
  const b = await run({ store }); assert.equal(b.code, 200); assert.equal(b.body.duplicate, true);
  assert.equal(store.db.events.filter((e) => e.type === 'vaani_event').length, 1);
  const c = await run({ store, payload: { event: 'call_started', room_name: 'room-1', phone_number: '+919800000001', timestamp: 't2' } });
  assert.equal(c.body.duplicate, undefined, 'a different timestamp is a different event');
});

test('serverless webhook: an unverifiable post-processing event is rejected, logged, and still answered 200', async () => {
  const store = new Store(null);
  const r = await run({ store, payload: { event: 'call_postprocessing', call_id: 'room-9', timestamp: 'p1', data: { transcript: 'AGENT: hi\nUSER: hello', call_duration: 1000 } } });
  assert.equal(r.code, 200);
  assert.ok(store.db.events.some((e) => e.type === 'vaani_unverified'));
  assert.equal(store.db.enquiries.length, 0, 'nothing is created from a webhook body that could not be verified with Vani');
});
