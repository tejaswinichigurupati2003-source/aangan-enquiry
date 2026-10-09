// HubSpot — hard rule #4: GREEN, LIVE leads only. These checks run BEFORE the dry-run branch, so even a
// dry run refuses seed data; there is no code path from a seed record to a HubSpot request.
import { isLive } from '../config.js';

export class SeedRefusedError extends Error {
  constructor(source) { super(`HubSpot refuses source="${source}" — only source="live" may be pushed`); this.name = 'SeedRefusedError'; }
}
export class NotGreenError extends Error {
  constructor(tier) { super(`HubSpot accepts GREEN leads only (got tier="${tier}")`); this.name = 'NotGreenError'; }
}

const API = 'https://api.hubapi.com';

export function toContactProperties(record) {
  const f = record.fields || {};
  const [first, ...rest] = String(f.name || '').trim().split(/\s+/);
  return {
    firstname: first || 'Unknown',
    lastname: rest.join(' ') || undefined,
    phone: record.phone,
    city: f.locality || undefined,
    lifecyclestage: 'lead',
    hs_lead_status: 'NEW',
    // Custom contact properties — must be created in HubSpot before going live (see README).
    aangan_source: record.source,
    aangan_tier: record.tier,
    aangan_flags: (record.flags || []).join(';'),
    aangan_summary: record.summary || '',
  };
}

/**
 * @param record {source, tier, phone, fields, flags, summary}
 * @param ctx {cfg, store, fetchImpl}
 */
export async function pushLeadToHubspot(record, { cfg, store, fetchImpl = fetch } = {}) {
  if (record?.source !== 'live') throw new SeedRefusedError(record?.source); // rule 4 — unconditional
  if (record?.tier !== 'green') throw new NotGreenError(record?.tier);
  if (!record.phone) throw new Error('HubSpot: a phone number is required to upsert a contact');

  const properties = toContactProperties(record);
  if (!isLive(cfg, ['HUBSPOT_TOKEN'])) {
    store?.outboxPush({ channel: 'hubspot', dryRun: true, enquiryId: record.enquiryId, source: record.source, action: 'upsert_contact', payload: properties });
    return { dryRun: true };
  }

  const headers = { Authorization: `Bearer ${cfg.env.HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' };
  const done = (action, id) => { store?.outboxPush({ channel: 'hubspot', dryRun: false, enquiryId: record.enquiryId, source: record.source, action, id }); return { dryRun: false, id }; };

  // 1) We already know this contact (same caller, merged by phone in our own store) → update by id.
  //    HubSpot's search index lags by several seconds, so a call-back right after a drop must NOT depend on search.
  if (record.hubspotId) {
    const res = await fetchImpl(`${API}/crm/v3/objects/contacts/${record.hubspotId}`, { method: 'PATCH', headers, body: JSON.stringify({ properties }) });
    if (res.ok) return done('update_contact', record.hubspotId);
    if (res.status !== 404) throw new Error(`HubSpot ${res.status}`); // 404 = deleted in HubSpot → fall through and re-create
  }
  // 2) Look the number up (covers contacts that already existed in HubSpot before this system).
  const search = await fetchImpl(`${API}/crm/v3/objects/contacts/search`, {
    method: 'POST', headers,
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: record.phone }] }], limit: 1 }),
  });
  const found = (await search.json())?.results?.[0];
  const res = found
    ? await fetchImpl(`${API}/crm/v3/objects/contacts/${found.id}`, { method: 'PATCH', headers, body: JSON.stringify({ properties }) })
    : await fetchImpl(`${API}/crm/v3/objects/contacts`, { method: 'POST', headers, body: JSON.stringify({ properties }) });
  if (!res.ok) throw new Error(`HubSpot ${res.status}`);
  const body = await res.json();
  return done(found ? 'update_contact' : 'create_contact', body.id);
}
