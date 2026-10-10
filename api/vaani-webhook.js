import { loadConfig } from '../src/config.js';
import { openStore } from '../src/storage.js';
import { createProvider } from '../src/llm/index.js';
import { handleVaaniWebhook } from '../src/vaani/vercel.js';

const cfg = loadConfig({ fresh: true, env: { STORAGE_BACKEND: 'supabase', ...process.env } });
const readBody = (req) => (req.body !== undefined ? Promise.resolve(typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch { return null; } })() : req.body)
  : new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 2000000) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(null); } }); }));

export default async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (req.method !== 'POST') return send(405, { error: 'POST only' });
  try {
    const secret = new URL(req.url, 'http://localhost').searchParams.get('secret');
    const store = await openStore(cfg);
    const provider = createProvider(cfg, { onFallback: (e) => store.event('llm_error', { error: e.message }) });
    const r = await handleVaaniWebhook({ cfg, store, provider, secret, payload: await readBody(req) });
    return send(r.code, r.body);
  } catch (e) { return send(500, { error: e.message }); }
};
