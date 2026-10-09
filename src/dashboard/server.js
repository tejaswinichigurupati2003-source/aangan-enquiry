// Local dashboard server. Binds to 127.0.0.1 only (no auth: it is a local tool; put it behind a login before exposing it).
// Reads from the configured storage backend (JSON file or Supabase).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMetrics } from '../metrics.js';
import { openStore, storageBackend } from '../storage.js';
import { Store } from '../store.js';
import { dataDir } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE_CACHE_MS = 10000; // the page polls every 15 s; don't re-download every table on every request

export function createDashboard(cfg, { dir = dataDir(cfg), fetchImpl, local = false } = {}) {
  const remote = !local && storageBackend(cfg) === 'supabase'; // an explicit --dir always means the local JSON files
  let cached = null; let cachedAt = 0;
  const getStore = async () => {
    if (local) return new Store(dir);          // explicit --dir: local JSON, whatever STORAGE_BACKEND says
    if (!remote) return openStore(cfg, { dir });
    if (!cached || Date.now() - cachedAt > SUPABASE_CACHE_MS) { cached = await openStore(cfg, { fetchImpl }); cachedAt = Date.now(); }
    return cached;
  };
  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(path.join(here, 'page.html'), 'utf8'), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/metrics') {
        const source = ['all', 'live', 'seed'].includes(url.searchParams.get('source')) ? url.searchParams.get('source') : 'all';
        return send(res, 200, computeMetrics(await getStore(), cfg, { source }));
      }
      if (req.method === 'POST' && url.pathname === '/api/review') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
        req.on('end', async () => {
          try {
            const { enquiryId, verdict, note } = JSON.parse(body);
            const store = await getStore();
            if (!['ok', 'too_strict'].includes(verdict) || !store.getEnquiry(enquiryId)) return send(res, 400, { error: 'bad request' });
            const r = store.setReview(enquiryId, verdict, String(note ?? '').slice(0, 500));
            if (store.drain) await store.drain(); // persist to Supabase before answering
            return send(res, 200, r);
          } catch (e) { return send(res, e instanceof SyntaxError ? 400 : 500, { error: e instanceof SyntaxError ? 'bad json' : e.message }); }
        });
        return;
      }
      if (url.pathname === '/health') return send(res, 200, { ok: true, storage: storageBackend(cfg) });
      return send(res, 404, { error: 'not found' });
    } catch (e) { return send(res, 500, { error: e.message }); }
  });
}
