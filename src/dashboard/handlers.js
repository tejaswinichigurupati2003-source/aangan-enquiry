// Dashboard request handlers for serverless hosting (Vercel). The dashboard shows caller phone numbers and transcripts (personal
// data), so by default EVERY route is behind HTTP Basic auth, and with no DASHBOARD_PASSWORD configured the dashboard refuses to serve (503).
// The owner can explicitly turn the login off with DASHBOARD_AUTH=off (then anyone with the link can see everything).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { openStore } from '../storage.js';
import { apiMetrics, apiLead, apiIcs, apiReview, apiAction, apiCalendarFeed } from './api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const safeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function checkAuth(req, env) {
  // Explicit opt-out only (DASHBOARD_AUTH=off). Merely forgetting to set a password still fails CLOSED (503).
  if (env.DASHBOARD_AUTH === 'off') return { ok: true };
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

/** Cached store per warm serverless instance (the page polls every 15 s). Writes always reload first, so two instances never overwrite each other with stale rows. */
let cache = { store: null, at: 0 };
async function getStore(cfg, fetchImpl, { fresh = false } = {}) {
  if (fresh || !cache.store || Date.now() - cache.at > 10000) cache = { store: await openStore(cfg, { fetchImpl }), at: Date.now() };
  return cache.store;
}
export const resetCache = () => { cache = { store: null, at: 0 }; };

async function readBody(req) {
  const body = req.body;
  if (typeof body === 'string') { try { return JSON.parse(body); } catch { return null; } }
  if (body !== undefined) return body;
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 20000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(null); } });
  });
}

export function createHandlers({ env = process.env, fetchImpl, pagePath = path.join(here, 'page.html') } = {}) {
  const cfg = loadConfig({ fresh: true, env: { STORAGE_BACKEND: 'supabase', ...env } });
  const guard = (fn) => async (req, res) => {
    const a = checkAuth(req, cfg.env);
    if (!a.ok) return send(res, a.code, a.body, undefined, a.headers);
    try { return await fn(req, res); } catch (e) { return send(res, 500, { error: e.message }); }
  };
  const query = (req) => new URL(req.url, 'http://localhost').searchParams;
  const out = (res, r) => send(res, r.code, r.body, r.type, r.headers);
  const post = (fn) => guard(async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    // With the login switched off, anyone with the link can READ. Changing things (reassign, book, notes, Telegram posts) can
    // additionally require a team PIN: set DASHBOARD_TEAM_PIN and the page asks for it once per browser.
    const pin = cfg.env.DASHBOARD_TEAM_PIN;
    if (pin && cfg.env.DASHBOARD_AUTH === 'off' && !safeEqual(req.headers?.['x-team-pin'] ?? '', pin)) return send(res, 403, { error: 'team PIN required', pinRequired: true });
    const body = await readBody(req);
    if (!body) return send(res, 400, { error: 'bad json' });
    return out(res, await fn(await getStore(cfg, fetchImpl, { fresh: true }), body));
  });
  return {
    cfg,
    page: guard(async (req, res) => send(res, 200, fs.readFileSync(pagePath, 'utf8'), 'text/html; charset=utf-8')),
    metrics: guard(async (req, res) => out(res, apiMetrics(await getStore(cfg, fetchImpl), cfg, query(req)))),
    lead: guard(async (req, res) => out(res, apiLead(await getStore(cfg, fetchImpl), cfg, query(req)))),
    // token-protected instead of login-protected: Google Calendar / Apple Calendar cannot send a password
    calendar: async (req, res) => { try { return out(res, apiCalendarFeed(await getStore(cfg, fetchImpl), cfg, query(req))); } catch (e) { return send(res, 500, { error: e.message }); } },
    ics: guard(async (req, res) => out(res, apiIcs(await getStore(cfg, fetchImpl), cfg, query(req)))),
    review: post(async (store, body) => { const r = apiReview(store, body); if (store.drain) await store.drain(); return r; }),
    action: post((store, body) => apiAction(store, cfg, body, { fetchImpl })),
  };
}
