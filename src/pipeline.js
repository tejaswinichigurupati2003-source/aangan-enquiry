// finishCall: a call has ended → attach to its enquiry (merging duplicate numbers) → classify → route.
import { classifyEnquiry } from './classifier.js';
import { route } from './router.js';
import { applyCallBooking } from './booking.js';
import { syncConsultation } from './consult-sync.js';
import { sendTelegram } from './integrations/telegram.js';
import { forceDryRun } from './config.js';

export async function finishCall({ cfg, store, provider, call, caseId, now, fetchImpl }) {
  if (!call.endedAt) call.endedAt = new Date().toISOString();
  const enquiry = store.attachCall(call, { windowDays: cfg.rules.merge_window_days });
  const { classification, usage } = await classifyEnquiry({
    cfg, provider, store, enquiry, caseId, onEvent: (type, p) => store.event(type, { enquiryId: enquiry.id, ...p }),
  });
  if (usage) {
    call.usage = call.usage || {};
    call.usage.classifier = usage;
  }
  const routed = await route({ cfg, store, enquiry, classification, now: now ?? new Date(call.endedAt), fetchImpl });
  // The caller said yes to a slot on the call: turn the hold into a real consultation, block the calendar, tell the designers and the caller.
  const booking = applyCallBooking({ cfg, store, enquiry, call });
  if (booking.notify) {
    const io = { cfg: enquiry.source === 'live' ? cfg : forceDryRun({ ...cfg, env: { ...cfg.env }, mode: { ...cfg.mode } }), store, fetchImpl };
    try { await sendTelegram({ ...io, to: 'designer', text: booking.notify, enquiryId: enquiry.id, now: now ?? new Date(call.endedAt), button: false }); } catch (e) { store.event('telegram_error', { enquiryId: enquiry.id, error: e.message }); }
  }
  if (booking.booked) await syncConsultation({ cfg, store, enquiry, fetchImpl });
  call.tier = classification.tier;
  store.save();
  return { enquiry, classification, routed };
}
