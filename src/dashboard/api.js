// One implementation of the dashboard API, shared by the local server and the Vercel functions.
// Each function returns { code, body, type?, headers? } so the two hosts only adapt request/response objects.
import { computeMetrics } from '../metrics.js';
import { applyAction, autoAssignAll } from '../actions.js';
import { getTeam, ownerOf, stageOf } from '../team.js';
import { googleCalendarLink, calendarWeekLink, buildIcs } from '../calendar.js';
import { sendTelegram } from '../integrations/telegram.js';
import { forceDryRun } from '../config.js';
import { syncDeal } from '../integrations/hubspot-deals.js';
import { syncConsultation } from '../consult-sync.js';

const json = (code, body) => ({ code, body });

export const apiMetrics = (store, cfg, query) => {
  const source = ['all', 'live', 'seed'].includes(query.get('source')) ? query.get('source') : 'all';
  return json(200, computeMetrics(store, cfg, { source }));
};

/** Everything the lead drawer needs that is too heavy to ship with every 15-second refresh. */
export function apiLead(store, cfg, query) {
  const e = store.getEnquiry(query.get('id'));
  if (!e) return json(404, { error: 'lead not found' });
  const team = getTeam(cfg);
  const designer = team.owners.find((o) => o.id === (e.consult?.designerId ?? ownerOf(e)));
  const cls = e.classification ?? {};
  const failing = Object.entries(cls.verdicts ?? {}).filter(([, v]) => v === 'fail').map(([k]) => k);
  return json(200, {
    id: e.id, transcript: store.combinedTranscript(e), activity: [...(e.activity ?? [])].reverse(),
    reasons: cls.reasons ?? [], failing, evidence: cls.evidence ?? {}, closeScript: e.closeScript ?? null,
    calendar: e.consult?.status === 'scheduled' ? {
      google: googleCalendarLink(e, designer, cfg), week: calendarWeekLink(cfg, e.consult.start, team.calendarViewUrl), ics: `/api/ics?id=${encodeURIComponent(e.id)}`,
    } : null,
  });
}

export function apiIcs(store, cfg, query) {
  const e = store.getEnquiry(query.get('id'));
  if (!e || e.consult?.status !== 'scheduled') return json(404, { error: 'no consultation booked' });
  const designer = getTeam(cfg).owners.find((o) => o.id === e.consult.designerId);
  return { code: 200, body: buildIcs(e, designer, cfg), type: 'text/calendar; charset=utf-8', headers: { 'Content-Disposition': `attachment; filename="aangan-consultation-${e.id}.ics"` } };
}

export function apiReview(store, body) {
  const { enquiryId, verdict, note } = body || {};
  if (!['ok', 'too_strict'].includes(verdict) || !store.getEnquiry(enquiryId)) return json(400, { error: 'bad request' });
  return json(200, store.setReview(enquiryId, verdict, String(note ?? '').slice(0, 500)));
}

/** Apply an action, tell the designer group on Telegram (dry-run for seed/test data), then persist. */
export async function apiAction(store, cfg, body, { fetchImpl, now = new Date() } = {}) {
  if (body?.action === 'auto_assign_all') {
    const r = autoAssignAll({ cfg, store, by: body.by, now });
    if (r.notify) { try { await sendTelegram({ cfg, store, to: 'designer', text: r.notify, enquiryId: null, now, fetchImpl, button: false }); } catch (err) { store.event('telegram_error', { error: err.message }); } }
    if (store.drain) await store.drain();
    return json(200, { ok: true, count: r.count });
  }
  const r = applyAction({ cfg, store, body, now });
  if (!r.ok) return json(r.status ?? 400, { error: r.error, warnings: r.warnings, needsConfirm: r.needsConfirm === true });
  const e = r.enquiry;
  if (r.notify) {
    // Test data must never reach a real Telegram chat, even with AANGAN_LIVE=1.
    const io = { cfg: e.source === 'live' ? cfg : forceDryRun({ ...cfg, env: { ...cfg.env }, mode: { ...cfg.mode } }), store, fetchImpl };
    try { await sendTelegram({ ...io, to: 'designer', text: r.notify, enquiryId: e.id, now, button: false }); } catch (err) { store.event('telegram_error', { enquiryId: e.id, error: err.message }); }
  }
  if (['schedule', 'cancel_consult', 'assign'].includes(body.action) && e.consult) await syncConsultation({ cfg, store, enquiry: e, fetchImpl });
  // keep the HubSpot deal's stage in step with the dashboard (live Green leads only; best effort)
  if (e.source === 'live' && e.tier === 'green' && ['stage', 'schedule', 'cancel_consult', 'consult_done', 'assign'].includes(body.action)) {
    try { await syncDeal({ cfg, store, enquiry: e, fetchImpl }); } catch (err) { store.event('hubspot_deal_error', { enquiryId: e.id, error: err.message }); }
  }
  if (store.drain) await store.drain();
  return json(200, { ok: true, id: e.id, owner: ownerOf(e), stage: stageOf(e), consult: e.consult ?? null });
}
