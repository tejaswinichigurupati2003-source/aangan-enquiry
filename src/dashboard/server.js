// Local dashboard server. Binds to 127.0.0.1 only (no auth: it is a local tool; put it behind a login before exposing it).
// Reads from the configured storage backend (JSON file or Supabase). The API itself lives in ./api.js (shared with the Vercel functions).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiMetrics, apiLead, apiIcs, apiReview, apiAction } from './api.js';
import { openStore, storageBackend } from '../storage.js';
import { Store } from '../store.js';
import { dataDir } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE_CACHE_MS = 10000; // the page polls every 15 s; don't re-download every table on every request

export function createDashboard(cfg, { dir = dataDir(cfg), fetchImpl, local = false } = {}) {
  const remote = !local && storageBackend(cfg) === 'supabase'; // an explicit --dir always means the local JSON files
  let cached = null; let cachedAt = 0;
  const getStore = async ({ fresh = false } = {}) => {
    if (local) return new Store(dir);          // explicit --dir: local JSON, whatever STORAGE_BACKEND says
    if (!remote) return openStore(cfg, { dir });
    if (fresh || !cached || Date.now() - cachedAt > SUPABASE_CACHE_MS) { cached = await openStore(cfg, { fetchImpl }); cachedAt = Date.now(); }
    return cached;
  };
  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const out = (res, r) => send(res, r.code, r.body, r.type, r.headers);
  const readJson = (req) => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new SyntaxError('bad json')); } });
  });
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(path.join(here, 'page.html'), 'utf8'), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/metrics') return out(res, apiMetrics(await getStore(), cfg, url.searchParams));
      if (req.method === 'GET' && url.pathname === '/api/lead') return out(res, apiLead(await getStore(), cfg, url.searchParams));
      if (req.method === 'GET' && url.pathname === '/api/ics') return out(res, apiIcs(await getStore(), cfg, url.searchParams));
      if (req.method === 'POST' && (url.pathname === '/api/review' || url.pathname === '/api/action')) {
        const body = await readJson(req);
        const store = await getStore({ fresh: true });
        if (url.pathname === '/api/review') {
          const r = apiReview(store, body);
          if (store.drain) await store.drain(); else store.save();
          return out(res, r);
        }
        return out(res, await apiAction(store, cfg, body, { fetchImpl }));
      }
      if (url.pathname === '/health') return send(res, 200, { ok: true, storage: storageBackend(cfg) });
      return send(res, 404, { error: 'not found' });
    } catch (e) { return send(res, e instanceof SyntaxError ? 400 : 500, { error: e instanceof SyntaxError ? 'bad json' : e.message }); }
  });
}
