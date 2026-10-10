// HubSpot DEALS: one deal per Green, live lead in the "Aangan Enquiries" pipeline, moved through the same stages the dashboard uses.
// Same hard rule as contacts: live + Green only, refused in code BEFORE the dry-run branch. Needs the deal scopes on the HubSpot key
// (crm.objects.deals.read/write + crm.schemas.deals.read); without them this degrades quietly (one event, nothing breaks) and the contact sync carries on.
import { isLive } from '../config.js';
import { SeedRefusedError, NotGreenError } from './hubspot.js';
import { STAGES } from '../team.js';

const API = 'https://api.hubapi.com';
const DEAL_TO_CONTACT = 3; // HubSpot-defined association type id: deal → contact

/** Our dashboard stage → HubSpot stage LABEL (the pipeline's stages were renamed to match; ids are looked up at run time). */
export const STAGE_LABELS = (cfg) => ({
  new: 'New lead', contacted: 'Contacted', consult_booked: 'Consultation booked', consult_done: 'Consultation done', won: 'Won', lost: 'Lost',
  resolved: 'Won', // never used for Green leads; harmless default
  ...(cfg.hubspot?.stage_labels ?? {}),
});

let pipelineCache = null;
export const resetPipelineCache = () => { pipelineCache = null; };

async function loadPipeline(cfg, headers, fetchImpl) {
  if (pipelineCache && Date.now() - pipelineCache.at < 3600000) return pipelineCache;
  const res = await fetchImpl(`${API}/crm/v3/pipelines/deals`, { headers });
  if (res.status === 403) { const e = new Error('missing_scopes'); e.code = 'missing_scopes'; throw e; }
  if (!res.ok) throw new Error(`HubSpot pipelines ${res.status}`);
  const want = cfg.hubspot?.pipeline_label ?? 'Aangan Enquiries';
  const all = (await res.json()).results ?? [];
  const p = all.find((x) => x.label === want);
  if (!p) throw new Error(`HubSpot deal pipeline "${want}" not found`);
  pipelineCache = { at: Date.now(), id: p.id, stages: Object.fromEntries(p.stages.map((s) => [s.label, s.id])) };
  return pipelineCache;
}

export function dealProperties(enq, stage, designerName) {
  const f = enq.fields ?? {};
  return {
    dealname: `${f.name || 'Caller'}${f.locality ? ` — ${f.locality}` : ''}${f.property_type ? ` · ${f.property_type}` : ''}`,
    description: [enq.classification?.summary, designerName ? `Designer: ${designerName}` : null, f.preferred_window ? `Asked for: ${f.preferred_window}` : null].filter(Boolean).join('\n'),
    ...(stage ? { dealstage: stage } : {}),
  };
}

/**
 * Create or update the deal for an enquiry. Never throws for "scopes missing" (returns {skipped}). Seed/non-Green are refused in code.
 * @returns {{dryRun?: boolean, skipped?: string, id?: string}}
 */
export async function syncDeal({ cfg, store, enquiry, fetchImpl = fetch }) {
  if (enquiry?.source !== 'live') throw new SeedRefusedError(enquiry?.source);
  if (enquiry?.tier !== 'green') throw new NotGreenError(enquiry?.tier);
  const h = enquiry.handoff ?? (enquiry.handoff = {});
  const stageKey = enquiry.stage ?? 'new';
  const label = STAGE_LABELS(cfg)[stageKey];
  const designerName = enquiry.assignment?.ownerName;
  if (!isLive(cfg, ['HUBSPOT_TOKEN'])) {
    store?.outboxPush({ channel: 'hubspot', dryRun: true, enquiryId: enquiry.id, source: enquiry.source, action: h.dealId ? 'update_deal' : 'create_deal', payload: dealProperties(enquiry, label, designerName) });
    return { dryRun: true };
  }
  if (!h.hubspotId && !h.dealId) return { skipped: 'no_contact_yet' };
  const headers = { Authorization: `Bearer ${cfg.env.HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' };
  try {
    const pl = await loadPipeline(cfg, headers, fetchImpl);
    const stageId = pl.stages[label];
    if (!stageId) throw new Error(`HubSpot stage "${label}" not found in pipeline`);
    const properties = { ...dealProperties(enquiry, stageId, designerName), pipeline: pl.id };
    let res;
    if (h.dealId) res = await fetchImpl(`${API}/crm/v3/objects/deals/${h.dealId}`, { method: 'PATCH', headers, body: JSON.stringify({ properties }) });
    if (!h.dealId || res.status === 404) {
      res = await fetchImpl(`${API}/crm/v3/objects/deals`, {
        method: 'POST', headers,
        body: JSON.stringify({ properties, associations: [{ to: { id: h.hubspotId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: DEAL_TO_CONTACT }] }] }),
      });
    }
    if (res.status === 403) { const e = new Error('missing_scopes'); e.code = 'missing_scopes'; throw e; }
    if (!res.ok) throw new Error(`HubSpot deal ${res.status}`);
    const body = await res.json();
    h.dealId = body.id ?? h.dealId; h.dealStage = stageKey;
    store?.outboxPush({ channel: 'hubspot', dryRun: false, enquiryId: enquiry.id, source: enquiry.source, action: 'sync_deal', id: h.dealId, stage: label });
    return { dryRun: false, id: h.dealId };
  } catch (e) {
    if (e.code === 'missing_scopes') {
      if (!h.dealScopesNoted) { h.dealScopesNoted = true; store?.event('hubspot_deals_scopes_missing', { enquiryId: enquiry.id }); }
      return { skipped: 'missing_scopes' };
    }
    store?.event('hubspot_deal_error', { enquiryId: enquiry.id, error: e.message });
    return { skipped: 'error', error: e.message };
  }
}

export { STAGES };
