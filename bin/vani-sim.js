#!/usr/bin/env node
// A stand-in for Vani, so you can test YOUR server end to end before the real Vani account is wired:
// it fires the documented webhooks and talks to the BYOL WebSocket exactly as Vani would (same frames).
//   1) terminal A:  npm run serve
//   2) terminal B:  npm run vani-sim -- --from "+919876543210"
//   type caller lines; /hangup ends the call (sends call_ended).
// Flags: --ws ws://127.0.0.1:8787/byol  --webhook http://127.0.0.1:8787/webhooks/vaani/<secret>  --call-id demo-1  --from <number>
// Secrets are read from .env (VAANI_BYOL_TOKEN, VAANI_WEBHOOK_SECRET) — never typed on the command line.
import readline from 'node:readline';
import { loadConfig } from '../src/config.js';

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const cfg = loadConfig({ fresh: true });
const port = cfg.env.PORT || 8787;
const callId = opt('call-id', `sim-${Date.now()}`);
const from = opt('from', '+919800012345');
const wsBase = opt('ws', `ws://127.0.0.1:${port}/byol`);
const hook = opt('webhook', `http://127.0.0.1:${port}/webhooks/vaani/${cfg.env.VAANI_WEBHOOK_SECRET ?? 'SET_VAANI_WEBHOOK_SECRET'}`);
const token = cfg.env.VAANI_BYOL_TOKEN;

const fire = async (body) => { try { await fetch(hook, { method: 'POST', body: JSON.stringify(body) }); } catch (e) { console.log(`  (webhook failed: ${e.message})`); } };

await fire({ event: 'call_started', room_name: callId, status: 'connected', phone_number: from });
const ws = new WebSocket(`${wsBase}/${callId}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
const inbox = []; let wake = null;
ws.onmessage = (e) => { inbox.push(JSON.parse(e.data)); wake?.(); };
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`could not connect to ${wsBase} — is "npm run serve" running (and does VAANI_BYOL_TOKEN match)?`)); });
const next = async () => { while (!inbox.length) await new Promise((r) => { wake = r; }); return inbox.shift(); };
await next(); await next(); // config + greeting handshake frames

console.log(`☎  simulated Vani call ${callId} from ${from}`);
console.log('Assistant: Hello, you\'ve reached Aangan Studio. I\'m the studio\'s AI assistant, and this call is recorded and transcribed so the team can follow up. How can I help you today?   (spoken by Vani from its configured opening line)');
const history = [{ role: 'system', content: 'Vani agent prompt (ignored by our server)' }];
let rid = 0; let started = Date.now(); let ended = false;
const rl = readline.createInterface({ input: process.stdin });
process.stdout.write('You: ');
for await (const raw of rl) {
  const line = raw.trim();
  if (line === '/hangup') break;
  if (line) {
    history.push({ role: 'user', content: line });
    ws.send(JSON.stringify({ interaction_type: 'response_required', response_id: ++rid, call_id: callId, transcript: history, req_body: null }));
    let text = ''; let endCall = false;
    for (;;) { const f = await next(); text += f.content; if (f.end_call) endCall = true; if (f.content_complete) break; }
    history.push({ role: 'assistant', content: text.trim() });
    console.log(`Assistant: ${text.trim()}`);
    if (endCall) { console.log('  (assistant ended the call)'); ended = true; break; }
  }
  process.stdout.write('You: ');
}
ws.close();
await fire({ event: 'call_ended', room_name: callId, call_duration: Math.round((Date.now() - started) / 1000), end_reason: ended ? 'agent_ended' : 'user_hangup' });
console.log('\nCall finished. Give the server a second to classify, then check the dashboard / Supabase.');
setTimeout(() => process.exit(0), 300);
