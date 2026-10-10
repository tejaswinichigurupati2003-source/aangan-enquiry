#!/usr/bin/env node
// End-to-end check of the whole chain with a simulated caller:
//   call (real model) → AI books a slot + takes the e-mail → classifier → Telegram note → HubSpot contact (+deal) → Supabase → calendar → caller e-mail.
//   node bin/e2e.js                      DRY-RUN: nothing leaves this computer (local JSON store, every integration in dry-run)
//   node bin/e2e.js --live               REAL Telegram + HubSpot + Supabase (a test lead named "AANGAN TEST"; one real message in the designer group)
//   node bin/e2e.js --live --cleanup     …and then delete the HubSpot contact/deal and the Supabase rows it created
// The caller is scripted, the agent is the real engine with the real model from .env.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, forceDryRun, isLive } from '../src/config.js';
import { createProvider } from '../src/llm/index.js';
import { Store } from '../src/store.js';
import { openStore, storageBackend, closeStore } from '../src/storage.js';
import { CallEngine } from '../src/engine.js';
import { finishCall } from '../src/pipeline.js';
import { apiCalendarFeed } from '../src/dashboard/api.js';
import { getTeam } from '../src/team.js';
import { fmtWhen } from '../src/actions.js';

const args = new Set(process.argv.slice(2));
const LIVE = args.has('--live'); const CLEANUP = args.has('--cleanup');
let cfg = loadConfig({ fresh: true });
if (!LIVE) cfg = forceDryRun(cfg);
const PHONE = '+910000000003';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`); return ok; };
const note = (s) => console.log(`  · ${s}`);

console.log(`\nEND-TO-END (${LIVE ? 'LIVE services' : 'dry-run'})\n`);
console.log('Integrations configured:');
const has = (k) => Boolean(cfg.env[k]);
for (const [label, ok] of [['Gemini key', has('GEMINI_API_KEY')], ['Telegram bot + designer chat', has('TELEGRAM_BOT_TOKEN') && has('TELEGRAM_DESIGNER_CHAT_ID')], ['Supabase', has('SUPABASE_URL') && has('SUPABASE_SERVICE_ROLE_KEY')], ['HubSpot token', has('HUBSPOT_TOKEN')], ['Google Calendar service account', has('GOOGLE_SERVICE_ACCOUNT_JSON') && has('GOOGLE_CALENDAR_ID')], ['E-mail (Resend) key', has('EMAIL_API_KEY') && has('EMAIL_FROM')], ['Studio calendar iCal address (AI avoids busy times)', has('CALENDAR_ICAL_URL')], ['Calendar feed token', has('CALENDAR_FEED_TOKEN')]]) console.log(`  ${ok ? '●' : '○'} ${label}`);
console.log(`  live flag: ${cfg.env.AANGAN_LIVE === '1' && LIVE ? 'on' : 'off (dry-run)'}\n`);

const store = LIVE && storageBackend(cfg) === 'supabase' ? await openStore(cfg) : new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'aangan-e2e-')));
const provider = createProvider(cfg, { onFallback: (e) => note(`model fallback: ${e.message}`) });
console.log(`Model: ${provider.name}   Storage: ${LIVE && storageBackend(cfg) === 'supabase' ? 'supabase' : 'local temp'}\n`);

// ---- 1) the call ----
const reply = (agent) => {
  const a = agent.toLowerCase();
  if (/i can hold|another option/.test(a)) return 'Yes, that works for me.';
  if (/is that correct/.test(a)) return 'Yes, that is correct.';
  if (/email address/.test(a)) return 'aarav dot test at example dot com';
  if (/name/.test(a) && /\?/.test(a)) return 'My name is Aarav Test.';
  if (/which area|what area|locality/.test(a)) return "It's in Baner.";
  if (/how big|carpet|size|square feet/.test(a)) return 'About 1400 square feet carpet area.';
  if (/whole home|rooms|specific work|what would you like done|design or/.test(a)) return 'I want the whole home done.';
  if (/flat|house|office|bhk|type of property/.test(a)) return "It's a 3 BHK flat.";
  if (/complete|when would you need/.test(a)) return 'We would like it done in about five months.';
  if (/deciding|family/.test(a)) return 'My wife and I will decide together.';
  if (/hear about/.test(a)) return 'A friend recommended you.';
  if (/days and times|suit you for a consultation|weekdays or weekends/.test(a)) return 'Saturday mornings would work best.';
  return 'Yes, please.';
};
const engine = new CallEngine({ cfg, provider, store });
const startedAt = new Date().toISOString();
const { call, greeting } = engine.start({ from: PHONE, source: 'live', startedAt });
console.log('CALL'); console.log(`  Agent : ${greeting}`);
let last = greeting; let turns = 0; let done = false;
const t0 = Date.now();
while (!done && turns < 30) {
  const said = reply(last); console.log(`  Caller: ${said}`);
  const r = await engine.turn(call, said); last = r.reply; done = r.done; turns++;
  console.log(`  Agent : ${r.reply}`);
}
const avgMs = Math.round((Date.now() - t0) / Math.max(1, turns));
engine.end(call, 'completed');
console.log(`  (${turns} caller turns, ~${avgMs} ms per turn)\n`);

check('call ended by the agent', done);
const b = call.state.booking;
check('agent offered a real slot', Boolean(b?.slots?.length), b?.slots?.[0] ? fmtWhen(cfg, b.slots[0].start) : 'no slot was offered');
check('caller agreed and the slot is held', Boolean(b?.slot), b?.slot ? fmtWhen(cfg, b.slot.start) : '');
check('e-mail understood, read back and confirmed', b?.email === 'aarav.test@example.com', String(b?.email));
check('every spoken line passed the guard untouched', call.guardEvents.length === 0, `${call.guardEvents.length} blocked`);
check('no designer was ever named to the caller', !getTeam(cfg).designers.some((d) => call.turns.some((t) => t.role === 'agent' && new RegExp(`\\b${d.name}\\b`).test(t.text))));
check('no price figure was spoken', !call.turns.some((t) => t.role === 'agent' && /₹|\blakh|\bper sq/i.test(t.text)));

// ---- 2) after the call: classify → route → book ----
console.log('\nAFTER THE CALL');
const { enquiry, classification, routed } = await finishCall({ cfg, store, provider, call, caseId: null });
if (store.drain) await store.drain();
note(`classified: ${classification.tier} — ${classification.summary ?? ''}`);
note(`actions: ${routed.actions.join(', ')}`);
check('classified Green', classification.tier === 'green');
check('lead owner assigned automatically', Boolean(enquiry.assignment?.ownerName), enquiry.assignment?.ownerName);
check('consultation created from the held slot', enquiry.consult?.status === 'scheduled' && enquiry.consult.bookedBy === 'phone_ai', enquiry.consult ? `${fmtWhen(cfg, enquiry.consult.start)} with ${getTeam(cfg).owners.find((o) => o.id === enquiry.consult.designerId)?.name}` : 'none');
check('caller e-mail saved on the lead', enquiry.fields?.email === 'aarav.test@example.com');

const out = store.db.outbox.filter((o) => o.enquiryId === enquiry.id);
const tg = out.filter((o) => o.channel === 'telegram');
const telegramLive = LIVE && isLive(cfg, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_DESIGNER_CHAT_ID']);
check(`Telegram: designer note${telegramLive ? ' sent for real' : ' (dry-run)'}`, tg.some((o) => /Source: live call/.test(o.text ?? '')) && tg.every((o) => o.dryRun === !telegramLive), `${tg.length} message(s)`);
check('Telegram: "held by the AI on the call" message', tg.some((o) => /held by the AI/.test(o.text ?? '')));
const hs = out.filter((o) => o.channel === 'hubspot');
const hubLive = LIVE && isLive(cfg, ['HUBSPOT_TOKEN']);
check(`HubSpot: contact ${hubLive ? 'written for real' : '(dry-run)'}`, hs.some((o) => /contact/.test(o.action)) && (!hubLive || Boolean(enquiry.handoff.hubspotId)), enquiry.handoff.hubspotId ? `id ${enquiry.handoff.hubspotId}` : '');
const dealScopes = store.db.events.some((e) => e.type === 'hubspot_deals_scopes_missing' && e.enquiryId === enquiry.id);
if (hubLive) check('HubSpot: deal in the Aangan Enquiries pipeline', Boolean(enquiry.handoff.dealId), dealScopes ? 'SKIPPED — the HubSpot key has no deal permissions yet' : enquiry.handoff.dealId ? `deal ${enquiry.handoff.dealId}` : 'not created');
else check('HubSpot: deal (dry-run payload prepared)', hs.some((o) => o.action === 'create_deal' && o.payload?.dealstage === 'New lead' || o.action === 'update_deal'));
const cal = out.filter((o) => o.channel === 'calendar');
const gLive = LIVE && isLive(cfg, ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_CALENDAR_ID']);
check(`Google Calendar: event ${gLive ? 'created for real' : 'prepared (dry-run — no service account configured)'}`, gLive ? Boolean(enquiry.consult.gcalEventId) : cal.some((o) => o.action === 'create_event' && o.payload?.start?.dateTime === enquiry.consult.start));
const feed = apiCalendarFeed(store, { ...cfg, env: { ...cfg.env, CALENDAR_FEED_TOKEN: 'e2e' } }, new URLSearchParams({ token: 'e2e' }));
check('Studio calendar feed contains the consultation (subscribe URL)', feed.code === 200 && feed.body.includes(`UID:${enquiry.id}-consult@aangan`) && feed.body.includes(`DTSTART:${new Date(enquiry.consult.start).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`));
const mail = out.find((o) => o.channel === 'email' && o.to === 'aarav.test@example.com');
check(`Caller confirmation e-mail ${has('EMAIL_API_KEY') && LIVE ? 'sent' : '(dry-run — no e-mail provider configured)'}`, Boolean(mail), mail?.subject);
const bak = out.some((o) => o.channel === 'email' && !o.to);
check('Backup e-mail log prepared', bak);

// ---- 3) persistence ----
if (LIVE && storageBackend(cfg) === 'supabase') {
  const fresh = await openStore(cfg);
  const e2 = fresh.db.enquiries.find((e) => e.id === enquiry.id);
  check('Supabase: lead, consultation and activity read back from the database', Boolean(e2?.consult?.start) && e2.assignment?.ownerName === enquiry.assignment.ownerName && fresh.db.calls.some((c) => c.id === call.id) && fresh.db.events.some((x) => x.type === 'call_booking' && x.enquiryId === enquiry.id));
  await closeStore(fresh);
}

// ---- 4) cleanup ----
if (LIVE && CLEANUP) {
  console.log('\nCLEANUP');
  const H = { Authorization: `Bearer ${cfg.env.HUBSPOT_TOKEN}` };
  if (enquiry.handoff.dealId) { const r = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${enquiry.handoff.dealId}`, { method: 'DELETE', headers: H }); note(`HubSpot deal delete: HTTP ${r.status}`); }
  if (enquiry.handoff.hubspotId) { const r = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${enquiry.handoff.hubspotId}`, { method: 'DELETE', headers: H }); note(`HubSpot contact delete: HTTP ${r.status}`); }
  if (storageBackend(cfg) === 'supabase') {
    const SH = { apikey: cfg.env.SUPABASE_SERVICE_ROLE_KEY, ...(String(cfg.env.SUPABASE_SERVICE_ROLE_KEY).startsWith('sb_') ? {} : { Authorization: `Bearer ${cfg.env.SUPABASE_SERVICE_ROLE_KEY}` }) };
    const base = `${cfg.env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1`;
    const del = async (table, col, val) => { const r = await fetch(`${base}/${table}?${col}=eq.${encodeURIComponent(val)}`, { method: 'DELETE', headers: SH }); return r.status; };
    const s = [await del('aangan_outbox', 'aan_enquiry_id', enquiry.id), await del('aangan_callbacks', 'aan_enquiry_id', enquiry.id), await del('aangan_reviews', 'aan_enquiry_id', enquiry.id), await del('aangan_calls', 'aan_id', call.id), await del('aangan_enquiries', 'aan_id', enquiry.id)];
    for (const ev of store.db.events.filter((x) => x.enquiryId === enquiry.id || x.callId === call.id)) s.push(await del('aangan_events', 'aan_id', ev.id));
    note(`Supabase rows deleted (statuses: ${[...new Set(s)].join(', ')})`);
  }
  note('The Telegram message stays in the group (a bot cannot recall what it sent without its message id).');
}

await closeStore(store).catch(() => {});
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `✗ ${failed.length} of ${results.length} checks failed` : `✓ all ${results.length} checks passed`}\n`);
process.exit(failed.length ? 1 : 0);
