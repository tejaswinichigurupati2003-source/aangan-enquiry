#!/usr/bin/env node
// Copies the settings the Vercel deployment needs from your local .env into Vercel (production). YOU run this; values are never printed.
//   node bin/vercel-env.js            → shows which variables WOULD be copied (names only)
//   node bin/vercel-env.js --apply    → copies them (needs `vercel login` once) and sets a random team PIN for dashboard changes
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../src/config.js';

const NAMES = ['GEMINI_API_KEY', 'GEMINI_BACKEND', 'VAANI_API_KEY', 'VAANI_AGENT_ID', 'VAANI_WEBHOOK_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_DESIGNER_CHAT_ID', 'TELEGRAM_NIKHIL_CHAT_ID', 'HUBSPOT_TOKEN', 'EMAIL_API_KEY', 'EMAIL_FROM', 'EMAIL_TO', 'CALENDAR_ICAL_URL', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_CALENDAR_ID'];
const env = Object.fromEntries(fs.readFileSync(`${ROOT}/.env`, 'utf8').split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const apply = process.argv.includes('--apply');
const pin = String(100000 + crypto.randomInt(900000));
const todo = [...NAMES.filter((n) => env[n]).map((n) => [n, env[n]]), ['AANGAN_LIVE', '1'], ['DASHBOARD_TEAM_PIN', pin]];
console.log(`${apply ? 'Copying' : 'Would copy'} to Vercel (production): ${todo.map(([n]) => n).join(', ')}`);
console.log(`Empty in .env, skipped: ${NAMES.filter((n) => !env[n]).join(', ') || 'none'}`);
if (!apply) process.exit(0);
for (const [n, v] of todo) {
  const r = spawnSync('vercel', ['env', 'add', n, 'production', '--force', '--yes'], { input: v, encoding: 'utf8', shell: true });
  console.log(`  ${n.padEnd(28)} ${r.status === 0 ? 'ok' : `FAILED: ${(r.stderr || r.stdout).slice(0, 100).replace(/\s+/g, ' ')}`}`);
}
console.log(`\nDashboard team PIN (needed once per browser to change anything): ${pin}\nNow redeploy:  vercel --prod   (or push any commit)`);
