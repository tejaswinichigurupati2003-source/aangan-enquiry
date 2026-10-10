// Routing (CLAUDE.md):
//   Green    → Telegram note to the designer + HubSpot (live leads only, dry-run by default) + email backup
//   Amber    → front-desk queue (dashboard), no push
//   Red      → log + polite-close script + spot-check list
//   Escalate → page Nikhil on Telegram + email. Never HubSpot. Not a lead.
import { buildDesignerNote, buildEscalationNote, buildEmail, buildTranscriptMessages } from './notes.js';
import { sendTelegram } from './integrations/telegram.js';
import { sendEmail } from './integrations/email.js';
import { pushLeadToHubspot, SeedRefusedError } from './integrations/hubspot.js';
import { DECLINE } from './scripts.js';
import { scheduleCallbacks } from './callbacks.js';
import { forceDryRun } from './config.js';
import { autoAssign } from './team.js';
import { syncDeal } from './integrations/hubspot-deals.js';

export async function route({ cfg, store, enquiry, classification, now = new Date(), fetchImpl }) {
  const cls = classification;
  const prevTier = enquiry.tier;
  enquiry.tier = cls.tier;
  enquiry.classification = cls;
  enquiry.fields = { ...enquiry.fields, ...Object.fromEntries(Object.entries(cls.fields || {}).filter(([, v]) => v != null)) };
  enquiry.flags = cls.flags;
  enquiry.updatedAt = enquiry.updatedAt || now.toISOString();
  if (cls.tier === 'green' || cls.tier === 'escalate') autoAssign(cfg, store, enquiry, now); // owner is decided BEFORE the note is written
  const transcript = store.combinedTranscript(enquiry);
  const actions = [];
  const h = enquiry.handoff;
  const alreadySent = h.telegramSentAt && h.sentForCalls === enquiry.callIds.length && prevTier === cls.tier;
  // Test data must never reach a real Telegram chat or inbox, even with AANGAN_LIVE=1 (HubSpot additionally refuses seed in code).
  const io = { cfg: enquiry.source === 'live' ? cfg : forceDryRun({ ...cfg, env: { ...cfg.env }, mode: { ...cfg.mode } }), store, fetchImpl };

  if (cls.tier === 'green') {
    enquiry.status = 'handed_off';
    if (!alreadySent) {
      const note = buildDesignerNote(enquiry, cls);
      // Every channel is independent: a failing e-mail provider (or Telegram) must never stop the others or lose the lead.
      let tg = null;
      try { tg = await sendTelegram({ ...io, to: 'designer', text: note, enquiryId: enquiry.id, now }); actions.push('telegram:designer'); for (const part of buildTranscriptMessages(transcript)) await sendTelegram({ ...io, to: 'designer', text: part, enquiryId: enquiry.id, now, button: false }); } catch (e) { store.event('telegram_error', { enquiryId: enquiry.id, error: e.message }); actions.push('telegram:ERROR'); }
      try { const em = buildEmail('green', enquiry, cls, transcript); await sendEmail({ ...io, subject: em.subject, text: em.text, enquiryId: enquiry.id }); actions.push('email:backup'); } catch (e) { store.event('email_error', { enquiryId: enquiry.id, error: e.message }); actions.push('email:ERROR'); }
      if (tg) { h.telegramSentAt = now.toISOString(); h.sentForCalls = enquiry.callIds.length; h.silent = tg.silent; }
      try {
        const hs = await pushLeadToHubspot({ hubspotId: h.hubspotId, enquiryId: enquiry.id, source: enquiry.source, tier: cls.tier, phone: enquiry.phone, fields: enquiry.fields, flags: cls.flags, summary: cls.summary }, io);
        h.hubspot = hs.dryRun ? 'dry_run' : 'pushed';
        if (hs.id) h.hubspotId = hs.id;
        actions.push(`hubspot:${h.hubspot}`);
        const dl = await syncDeal({ cfg: io.cfg, store, enquiry, fetchImpl }); // the deal (pipeline stage) next to the contact; degrades quietly without deal scopes
        if (dl.id || dl.dryRun) actions.push(`hubspot_deal:${dl.dryRun ? 'dry_run' : 'synced'}`);
      } catch (e) {
        if (e instanceof SeedRefusedError) {
          h.hubspot = 'refused_seed';
          store.event('hubspot_refused_seed', { enquiryId: enquiry.id });
          actions.push('hubspot:REFUSED(seed)');
        } else {
          h.hubspot = 'error';
          store.event('hubspot_error', { enquiryId: enquiry.id, error: e.message });
          actions.push('hubspot:error');
        }
      }
    }
  } else if (cls.tier === 'amber') {
    enquiry.status = 'queued';
    enquiry.queue = { since: enquiry.queue?.since || now.toISOString(), reason: cls.reasons[0], next_question: cls.next_question };
    actions.push('queue:front_desk');
    if (cls.next_question === 'callback' && enquiry.phone) {
      const cbs = scheduleCallbacks({ cfg, store, enquiry, missedAt: store.getCall(enquiry.callIds.at(-1))?.startedAt ?? now.toISOString() });
      if (cbs.length) actions.push(`callbacks:${cbs.length}`);
    }
  } else if (cls.tier === 'red') {
    enquiry.status = 'closed';
    enquiry.closeScript = DECLINE[cls.red_reason] || null;
    actions.push('log:red', 'spot_check');
  } else if (cls.tier === 'escalate') {
    enquiry.status = 'escalated';
    if (!h.pagedAt) {
      try { await sendTelegram({ ...io, to: 'nikhil', text: buildEscalationNote(enquiry, cls), enquiryId: enquiry.id, now }); } catch (e) { store.event('telegram_error', { enquiryId: enquiry.id, error: e.message }); }
      try { const em = buildEmail('escalate', enquiry, cls, transcript); await sendEmail({ ...io, subject: em.subject, text: em.text, enquiryId: enquiry.id }); } catch (e) { store.event('email_error', { enquiryId: enquiry.id, error: e.message }); }
      h.pagedAt = now.toISOString();
      h.telegramSentAt = now.toISOString();
      actions.push('telegram:nikhil', 'email:backup'); // deliberately NO hubspot
    }
  }

  store.event('routed', { enquiryId: enquiry.id, tier: cls.tier, actions, source: enquiry.source });
  store.save();
  return { tier: cls.tier, actions };
}
