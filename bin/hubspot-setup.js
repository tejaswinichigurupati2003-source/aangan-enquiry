#!/usr/bin/env node
// One-time HubSpot setup: checks your token and creates the four custom CONTACT properties the integration writes
// (aangan_source, aangan_tier, aangan_flags, aangan_summary). Idempotent: existing properties are left alone.
//   node bin/hubspot-setup.js            → CHECK ONLY: tests the token and lists what is missing (changes nothing)
//   node bin/hubspot-setup.js --apply    → creates the missing properties
// The token comes from .env (HUBSPOT_TOKEN) — never pass it on the command line.
import { loadConfig } from '../src/config.js';

export const PROPERTIES = [
  { name: 'aangan_source', label: 'Aangan source', type: 'string', fieldType: 'text', description: 'live (real call). Seed/test data is never sent.' },
  { name: 'aangan_tier', label: 'Aangan tier', type: 'string', fieldType: 'text', description: 'Qualification tier from the phone assistant (green leads only are pushed).' },
  { name: 'aangan_flags', label: 'Aangan flags', type: 'string', fieldType: 'textarea', description: 'Semicolon-separated notes, e.g. decision_maker_unclear; timeline_tight.' },
  { name: 'aangan_summary', label: 'Aangan summary', type: 'string', fieldType: 'textarea', description: 'One-line summary of the call for the designer.' },
];

export async function setup({ token, apply = false, fetchImpl = fetch, log = console.log }) {
  const base = 'https://api.hubapi.com';
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const ping = await fetchImpl(`${base}/crm/v3/objects/contacts?limit=1`, { headers });
  if (ping.status === 401 || ping.status === 403) {
    log(`✗ HubSpot rejected the token (HTTP ${ping.status}). Check HUBSPOT_TOKEN and that the private app has the scope: crm.objects.contacts.read`);
    return { ok: false, created: [], missing: [] };
  }
  if (!ping.ok) { log(`✗ HubSpot error HTTP ${ping.status}`); return { ok: false, created: [], missing: [] }; }
  log('✓ token works (can read contacts)');

  const missing = []; const created = [];
  for (const p of PROPERTIES) {
    const r = await fetchImpl(`${base}/crm/v3/properties/contacts/${p.name}`, { headers });
    if (r.ok) { log(`  = ${p.name}: already exists`); continue; }
    if (r.status !== 404) { log(`  ? ${p.name}: could not check (HTTP ${r.status})`); continue; }
    missing.push(p.name);
    if (!apply) { log(`  - ${p.name}: MISSING (run with --apply to create)`); continue; }
    const c = await fetchImpl(`${base}/crm/v3/properties/contacts`, { method: 'POST', headers, body: JSON.stringify({ ...p, groupName: 'contactinformation' }) });
    if (c.ok || c.status === 409) { created.push(p.name); log(`  + ${p.name}: created`); }
    else log(`  ✗ ${p.name}: create failed (HTTP ${c.status}). The token needs the scope crm.schemas.contacts.write`);
  }
  return { ok: true, created, missing };
}

if (process.argv[1]?.endsWith('hubspot-setup.js')) { // only when run directly, not when imported by tests
  const cfg = loadConfig({ fresh: true });
  if (!cfg.env.HUBSPOT_TOKEN) { console.log('HUBSPOT_TOKEN is not set in .env — see docs/HUBSPOT_SETUP.md'); process.exit(1); }
  const r = await setup({ token: cfg.env.HUBSPOT_TOKEN, apply: process.argv.includes('--apply') });
  process.exit(r.ok ? 0 : 1);
}
