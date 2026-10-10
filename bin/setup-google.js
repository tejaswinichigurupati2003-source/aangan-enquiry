#!/usr/bin/env node
// Connects the studio's Google Calendar so booked consultations BLOCK the slot.
//   node bin/setup-google.js <path-to-downloaded-key.json> <calendar-id>           → checks the key, writes it to .env (you never paste it anywhere else)
//   node bin/setup-google.js --test                                               → creates a test event on the calendar, reads it back, deletes it
// The key file stays on your computer; this script only copies it (as one line) into .env, which is git-ignored.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';
import { syncCalendar, resetGoogleToken } from '../src/integrations/gcal.js';
import { Store } from '../src/store.js';

const [a, b] = process.argv.slice(2);
const envPath = path.join(ROOT, '.env');
const setEnv = (k, v) => {
  let t = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = `${k}=${v}`;
  t = new RegExp(`^${k}=.*$`, 'm').test(t) ? t.replace(new RegExp(`^${k}=.*$`, 'm'), () => line) : `${t.replace(/\s*$/, '\n')}${line}\n`;
  fs.writeFileSync(envPath, t);
};

if (a && a !== '--test') {
  if (!b) { console.log('Usage: node bin/setup-google.js <key.json> <calendar-id>'); process.exit(1); }
  let key;
  try { key = JSON.parse(fs.readFileSync(path.resolve(a), 'utf8')); } catch (e) { console.log(`✗ could not read ${a}: ${e.message}`); process.exit(1); }
  if (key.type !== 'service_account' || !key.client_email || !key.private_key) { console.log('✗ that is not a service-account key file (it should contain "type": "service_account")'); process.exit(1); }
  setEnv('GOOGLE_SERVICE_ACCOUNT_JSON', JSON.stringify(key));
  setEnv('GOOGLE_CALENDAR_ID', b);
  console.log(`✓ saved to .env. Service account: ${key.client_email}`);
  console.log(`  Next: make sure the calendar is SHARED with ${key.client_email} ("Make changes to events"), then run:  node bin/setup-google.js --test`);
  process.exit(0);
}

if (a === '--test') {
  const cfg = loadConfig({ fresh: true });
  if (!cfg.env.GOOGLE_SERVICE_ACCOUNT_JSON || !cfg.env.GOOGLE_CALENDAR_ID) { console.log('✗ not set up yet — run: node bin/setup-google.js <key.json> <calendar-id>'); process.exit(1); }
  cfg.env.AANGAN_LIVE = '1';
  resetGoogleToken();
  const start = new Date(Date.now() + 3 * 86400000); start.setUTCHours(21, 0, 0, 0); // an hour nobody works
  const enq = { id: 'enq_calendar_test', source: 'live', phone: '+910000000009', fields: { name: 'CALENDAR TEST (safe to ignore)', locality: 'Pune' }, classification: { summary: 'Test event created by bin/setup-google.js' }, consult: { status: 'scheduled', start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString(), designerId: 'designer_1', bookedBy: 'phone_ai' } };
  const store = new Store(null);
  const r = await syncCalendar({ cfg, store, enquiry: enq, designerName: 'Test' });
  if (!enq.consult.gcalEventId) { console.log(`✗ could not create the event: ${r.error ?? JSON.stringify(r)}\n  Most common cause: the calendar is not shared with the service account, or the Calendar API is not enabled for the project.`); process.exit(1); }
  console.log(`✓ event created on the calendar (id ${enq.consult.gcalEventId}) — look for "CALENDAR TEST" three days from now at ${start.toISOString()}`);
  enq.consult.status = 'cancelled';
  await syncCalendar({ cfg, store, enquiry: enq });
  console.log('✓ and removed again. Calendar blocking works.');
  process.exit(0);
}

console.log('Usage:\n  node bin/setup-google.js <key.json> <calendar-id>\n  node bin/setup-google.js --test');
