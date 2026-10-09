#!/usr/bin/env node
// Text-based call simulator. You are the caller; the real engine → classifier → router run behind it (all DRY-RUN).
//   node bin/call.js                        interactive call (provider: config.provider.name; "auto" = Gemini if a key
//                                           exists, falling back to the offline heuristic provider if the API fails)
//   node bin/call.js --provider offline     force the offline heuristic provider (no API at all)
//   node bin/call.js --from 98765 43210     caller ID (default: a random fake number)
//   node bin/call.js --at 2026-10-09T23:40:00+05:30    pretend the call arrives at this time (try after-hours)
//   node bin/call.js --no-caller-id         withheld number: the assistant will ask for one
// Type /drop to simulate the line dropping, /quit to hang up normally.
import readline from 'node:readline';
import { loadConfig, dataDir, forceDryRun } from '../src/config.js';
import { createProvider } from '../src/llm/index.js';
import { Store } from '../src/store.js';
import { CallEngine } from '../src/engine.js';
import { finishCall } from '../src/pipeline.js';
import { normalizePhone } from '../src/phone.js';
import { StubTelephony } from '../src/telephony/adapter.js';
import { renderReport } from '../src/dashboard/report.js';
import { computeMetrics } from '../src/metrics.js';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const flag = (n) => args.includes(`--${n}`);

const cfg = loadConfig({ fresh: true });
if (!flag('live')) forceDryRun(cfg); // the simulator is a rehearsal: real Telegram/HubSpot only with --live
const store = new Store(flag('no-save') ? null : dataDir(cfg));
const provider = createProvider(cfg, { name: opt('provider') ?? cfg.provider.name, onFallback: (e) => console.log(`\n  (model unavailable: ${e.message} — using offline fallback)`) });
const from = flag('no-caller-id') ? null : normalizePhone(opt('from')) ?? `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const telephony = new StubTelephony();
const engine = new CallEngine({ cfg, provider, store });

const ringAt = telephony.ring({ from, callId: 'interactive' });
const { call, greeting } = engine.start({ from, startedAt: opt('at') ?? new Date().toISOString(), source: 'live', ringAt });
await telephony.answer('interactive');
console.log(`\n☎  Incoming call from ${from ?? 'withheld number'}   [provider: ${provider.name}, DRY-RUN]`);
console.log('   (type your lines as the caller; /drop = line drops, /quit = hang up)\n');
console.log(`Assistant: ${greeting}`);

const rl = readline.createInterface({ input: process.stdin });
let status = 'completed';
process.stdout.write('You: ');
for await (const raw of rl) {
  const line = raw.trim();
  if (line === '/quit') break;
  if (line === '/drop') { status = 'dropped'; break; }
  if (line) {
    const r = await engine.turn(call, line);
    console.log('Assistant: ' + r.reply);
    if (r.done) break;
  }
  process.stdout.write('You: ');
}
rl.close();
engine.end(call, status);

const { classification, routed, enquiry } = await finishCall({ cfg, store, provider, call });
console.log('\n──────── call ended ────────');
console.log(`Tier: ${classification.tier.toUpperCase()}${classification.red_reason ? ` (${classification.red_reason})` : ''}`);
console.log(`Why:  ${classification.reasons.join('; ')}`);
console.log(`Flags: ${classification.flags.join(', ') || '—'}`);
console.log(`Routing (dry-run): ${routed.actions.join(', ')}`);
if (call.guardEvents.length) console.log(`Guard blocked ${call.guardEvents.length} line(s) this call.`);
const out = store.db.outbox.filter((o) => o.enquiryId === enquiry.id && o.channel === 'telegram');
for (const o of out) console.log(`\n--- Telegram note to ${o.to}${o.silent ? ' (silent)' : ''} ---\n${o.text}`);
if (!flag('no-save')) console.log(`\nSaved to ${dataDir(cfg)} — run "npm run dashboard" to see it.`);
if (flag('report')) console.log('\n' + renderReport(computeMetrics(store, cfg, { source: 'live' })));
