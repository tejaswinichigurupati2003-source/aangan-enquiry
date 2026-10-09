// Dashboard request handlers for serverless hosting (Vercel). The dashboard shows caller phone numbers and transcripts (personal
// data), so EVERY route is behind HTTP Basic auth, and with no DASHBOARD_PASSWORD configured the dashboard refuses to serve (503).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { openStore } from '../storage.js';
import { computeMetrics } from '../metrics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const safeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function checkAuth(req, env) {
  const pw = env.DASHBOARD_PASSWORD;
  if (!pw) return { ok: false, code: 503, body: { error: 'dashboard password not configured' } };
  const h = String(req.headers?.authorization || '');
  if (h.startsWith('Basic ')) {
    const [user, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
    if (safeEqual(user, env.DASHBOARD_USER || 'aangan') && safeEqual(rest.join(':'), pw)) return { ok: true };
  }
  return { ok: false, code: 401, headers: { 'WWW-Authenticate': 'Basic realm="Aangan dashboard", charset="UTF-8"' }, body: { error: 'authentication required' } };
}

const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

/** Cached store per warm serverless instance (the page polls every 15 s). */
let cache = { store: null, at: 0 };
async function getStore(cfg, fetchImpl) {
  if (!cache.store || Date.now() - cache.at > 10000) cache = { store: await openStore(cfg, { fetchImpl }), at: Date.now() };
  return cache.store;
}
export const resetCache = () => { cache = { store: null, at: 0 }; };

export function createHandlers({ env = process.env, fetchImpl, pagePath = path.join(here, 'page.html') } = {}) {
  const cfg = loadConfig({ fresh: true, env: { STORAGE_BACKEND: 'supabase', ...env } });
  const guard = (fn) => async (req, res) => {
    const a = checkAuth(req, cfg.env);
    if (!a.ok) return send(res, a.code, a.body, undefined, a.headers);
    try { return await fn(req, res); } catch (e) { return send(res, 500, { error: e.message }); }
  };
  return {
    cfg,
    page: guard(async (req, res) => send(res, 200, fs.readFileSync(pagePath, 'utf8'), 'text/html; charset=utf-8')),
    metrics: guard(async (req, res) => {
      const q = new URL(req.url, 'http://localhost').searchParams.get('source');
      const source = ['all', 'live', 'seed'].includes(q) ? q : 'all';
      return send(res, 200, computeMetrics(await getStore(cfg, fetchImpl), cfg, { source }));
    }),
    review: guard(async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return send(res, 400, { error: 'bad json' }); } }
      if (body === undefined) body = await new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(null); } }); });
      const { enquiryId, verdict, note } = body || {};
      const store = await getStore(cfg, fetchImpl);
      if (!['ok', 'too_strict'].includes(verdict) || !store.getEnquiry(enquiryId)) return send(res, 400, { error: 'bad request' });
      const r = store.setReview(enquiryId, verdict, String(note ?? '').slice(0, 500));
      await store.drain();
      return send(res, 200, r);
    }),
  };
}
