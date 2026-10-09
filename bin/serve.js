#!/usr/bin/env node
// Production-style entry point for the Vani integration: webhook receiver + BYOL WebSocket + call-back runner.
//   node bin/serve.js [--port 8787]
// Needs a PUBLIC https/wss URL in front of it (a tunnel such as ngrok for testing; a real host for production). See docs/VANI_SETUP.md.
import { loadConfig } from '../src/config.js';
import { createProvider } from '../src/llm/index.js';
import { openStore, closeStore, storageBackend } from '../src/storage.js';
import { createVaaniServer } from '../src/vaani/server.js';
import { runDueCallbacks } from '../src/callbacks.js';
import { VaaniApi } from '../src/vaani/api.js';

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const cfg = loadConfig({ fresh: true });
const port = Number(opt('port', cfg.env.PORT || 8787));

const store = await openStore(cfg);
const provider = createProvider(cfg, { onFallback: (e) => store.event('llm_error', { error: e.message }) });
const { server, hub } = createVaaniServer({ cfg, store, provider, log: (...a) => console.log(new Date().toISOString(), ...a) });
const api = new VaaniApi(cfg);

const warnings = [];
if (!cfg.env.VAANI_WEBHOOK_SECRET) warnings.push('VAANI_WEBHOOK_SECRET is not set — the webhook endpoint will answer 503');
if (!cfg.env.VAANI_API_KEY) warnings.push('VAANI_API_KEY is not set — call_postprocessing cannot be verified (and is rejected)');
if (!cfg.env.VAANI_BYOL_TOKEN && cfg.env.AANGAN_LIVE === '1') warnings.push('VAANI_BYOL_TOKEN is not set — BYOL sockets are refused while AANGAN_LIVE=1');
if (provider.name === 'offline') warnings.push('model provider is OFFLINE heuristic (no valid GEMINI_API_KEY) — fine for a smoke test, not for real callers');

server.listen(port, () => {
  console.log(`Vani integration listening on :${port}   storage=${storageBackend(cfg)}  provider=${provider.name}  live=${cfg.env.AANGAN_LIVE === '1'}`);
  console.log(`  webhook  POST /webhooks/vaani/<VAANI_WEBHOOK_SECRET>`);
  console.log(`  BYOL     wss://<public-host>/byol          (Vani appends /<call_id>)`);
  for (const w of warnings) console.warn(`  ! ${w}`);
});

const tick = async () => {
  try {
    await hub.sweepStale();
    await runDueCallbacks({ cfg, store, api });
    if (store.flush) await store.flush();
  } catch (e) { console.error('background task failed:', e.message); }
};
const timer = setInterval(tick, 60000); timer.unref();

const shutdown = async () => { console.log('\nshutting down…'); clearInterval(timer); server.close(); await closeStore(store).catch((e) => console.error(e.message)); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
