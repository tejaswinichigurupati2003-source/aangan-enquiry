// Vani webhook as a serverless function (Vercel): POST /webhooks/vaani/<VAANI_WEBHOOK_SECRET>.
// Same receiver as the always-on server (src/vaani/webhook.js), with two differences forced by serverless:
//   • there is no long-lived memory, so duplicate deliveries are detected from the stored events (Supabase) instead of in RAM, and
//   • the work is finished BEFORE answering (a serverless function may be frozen the moment it responds).
// It CANNOT host the live conversation: Vani's BYOL connection is a WebSocket and needs the always-on server (render.yaml / bin/serve.js).
// Webhooks alone are enough when Vani's own AI answers the call; they also attach Vani's metadata to calls our BYOL server handled.
import crypto from 'node:crypto';
import { VaaniApi } from './api.js';
import { CallRegistry } from './registry.js';
import { VaaniWebhook, normalizeEvent } from './webhook.js';

const safeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export async function handleVaaniWebhook({ cfg, store, provider, fetchImpl, secret, payload, poll }) {
  const want = cfg.env.VAANI_WEBHOOK_SECRET;
  if (!want) return { code: 503, body: { error: 'webhook secret not configured' } };
  if (!secret || !safeEqual(decodeURIComponent(secret), want)) return { code: 403, body: { error: 'forbidden' } };
  if (!payload || typeof payload !== 'object') return { code: 400, body: { error: 'bad json' } };

  const ev = normalizeEvent(payload);
  const seen = store.db.events.some((e) => e.type === 'vaani_event' && e.vaaniEvent === ev.event && e.vaaniCallId === ev.callId && (e.payload?.timestamp ?? null) === (ev.timestamp ?? null));
  const hook = new VaaniWebhook({ cfg, store, provider, registry: new CallRegistry(), api: new VaaniApi(cfg, { fetchImpl }), poll, fetchImpl });
  if (seen) return { code: 200, body: { status: 'ok', duplicate: true } };
  hook.ingest(payload);
  try {
    const r = await hook.process(ev);
    if (store.drain) await store.drain();
    return { code: 200, body: { status: 'ok', action: r?.action ?? null } };
  } catch (e) {
    store.event('webhook_error', { vaaniEvent: ev.event, vaaniCallId: ev.callId, error: e.message });
    if (store.drain) await store.drain().catch(() => {});
    return { code: 200, body: { status: 'ok', error: 'processing failed, logged' } }; // 200 so Vani does not retry-storm; the event is stored
  }
}
