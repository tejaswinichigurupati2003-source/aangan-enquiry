// HTTP + WebSocket server for the Vani integration:
//   POST /webhooks/vaani/<VAANI_WEBHOOK_SECRET>   Vani call events
//   WS   /byol/<call_id>                          Vani Bring-Your-Own-LLM turns (Authorization: Bearer <VAANI_BYOL_TOKEN>)
//   GET  /health
import http from 'node:http';
import crypto from 'node:crypto';
import { VaaniApi } from './api.js';
import { CallRegistry } from './registry.js';
import { VaaniWebhook } from './webhook.js';
import { ByolHub } from './byol.js';
import { storageBackend } from '../storage.js';

const safeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function createVaaniServer({ cfg, store, provider, fetchImpl, now, poll, log = () => {} }) {
  const registry = new CallRegistry();
  const api = new VaaniApi(cfg, { fetchImpl });
  const webhook = new VaaniWebhook({ cfg, store, provider, registry, api, now, poll });
  const hub = new ByolHub({ cfg, store, provider, registry, now });
  const pending = new Set(); // in-flight background webhook jobs (so tests/shutdown can await them)

  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, storage: storageBackend(cfg), storageError: store.lastError?.message ?? null, activeCalls: hub.sessions.size, live: cfg.env.AANGAN_LIVE === '1' });
    }
    const m = url.pathname.match(/^\/webhooks\/vaani\/([^/]+)$/);
    if (req.method === 'POST' && m) {
      const secret = cfg.env.VAANI_WEBHOOK_SECRET;
      if (!secret) return send(res, 503, { error: 'webhook secret not configured' });
      if (!safeEqual(decodeURIComponent(m[1]), secret)) return send(res, 403, { error: 'forbidden' });
      let body = ''; let tooBig = false;
      req.on('data', (c) => { body += c; if (body.length > cfg.vaani.max_body_bytes) { tooBig = true; req.destroy(); } });
      req.on('end', () => {
        if (tooBig) return;
        let payload;
        try { payload = JSON.parse(body); } catch { return send(res, 400, { error: 'bad json' }); }
        const { duplicate, ev } = webhook.ingest(payload);
        send(res, 200, { status: 'ok' }); // answer fast; heavy work continues below
        if (duplicate) return;
        const job = webhook.process(ev).then((r) => log('webhook', ev.event, ev.callId, r?.action)).catch((e) => { store.event('webhook_error', { vaaniEvent: ev.event, vaaniCallId: ev.callId, error: e.message }); log('webhook_error', e.message); }).finally(() => pending.delete(job));
        pending.add(job);
      });
      return;
    }
    return send(res, 404, { error: 'not found' });
  });

  server.on('upgrade', (req, socket) => {
    const m = new URL(req.url, 'http://localhost').pathname.match(/^\/byol\/([^/]+)$/);
    if (!m) { socket.destroy(); return; }
    hub.handleUpgrade(req, socket, decodeURIComponent(m[1]));
  });

  return { server, hub, registry, webhook, api, idle: () => Promise.allSettled([...pending]) };
}
