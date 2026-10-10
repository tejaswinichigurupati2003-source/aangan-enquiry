#!/usr/bin/env node
// Re-reads a finished Vani call from Vani's API and re-runs classification + routing on the SAME lead (no duplicate lead is created).
// Use it when a call was stored with an empty/partial transcript.   node bin/reprocess-vani.js <vani-call-id> [--dry]
import { loadConfig, forceDryRun } from '../src/config.js';
import { openStore, closeStore } from '../src/storage.js';
import { createProvider } from '../src/llm/index.js';
import { VaaniApi, parseVaaniTranscript } from '../src/vaani/api.js';
import { classifyEnquiry } from '../src/classifier.js';
import { route } from '../src/router.js';
import { bookFromCall } from '../src/postcall-booking.js';

const id = process.argv[2];
if (!id || id.startsWith('--')) { console.log('Usage: node bin/reprocess-vani.js <vani-call-id> [--dry]'); process.exit(1); }
let cfg = loadConfig({ fresh: true });
if (process.argv.includes('--dry')) cfg = forceDryRun(cfg);
const store = await openStore(cfg);
const call = store.db.calls.find((c) => c.vaaniCallId === id);
if (!call) { console.log(`No stored call with Vani id ${id}`); process.exit(1); }
const enquiry = store.getEnquiry(call.enquiryId);
const details = await new VaaniApi(cfg).waitForCallDetails(id);
if (!details.ready) { console.log('Vani has no transcript for this call yet.'); process.exit(1); }
call.turns = parseVaaniTranscript(details.transcription);
call.status = call.turns.some((t) => t.role === 'caller') ? 'completed' : 'dropped';
call.vaani = { ...(call.vaani ?? {}), summary: details.summary, verified: true };
console.log(`transcript: ${call.turns.length} turns (${call.turns.filter((t) => t.role === 'caller').length} from the caller)`);
const provider = createProvider(cfg, { onFallback: (e) => console.log('model fallback:', e.message) });
const { classification, usage } = await classifyEnquiry({ cfg, provider, store, enquiry, caseId: null, onEvent: (t, p) => store.event(t, { enquiryId: enquiry.id, ...p }) });
if (usage) call.usage = { ...(call.usage ?? {}), classifier: usage };
for (const cb of store.db.callbacks.filter((c) => c.enquiryId === enquiry.id && c.status === 'scheduled')) cb.status = 'skipped_resolved';
const routed = await route({ cfg, store, enquiry, classification, now: new Date(call.endedAt ?? Date.now()) });
call.tier = classification.tier;
if (classification.tier === 'green') { call.postCallBooking = undefined; const b = await bookFromCall({ cfg, store, provider, enquiry, call }); console.log(`booking from transcript: ${b.status}${b.reason ? ` (${b.reason})` : ''}${b.start ? ` ${b.start}` : ''}`); }
store.save();
if (store.drain) await store.drain();
console.log(`tier: ${classification.tier}\nsummary: ${classification.summary}\nactions: ${routed.actions.join(', ')}`);
await closeStore(store);
