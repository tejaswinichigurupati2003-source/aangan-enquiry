// finishCall: a call has ended → attach to its enquiry (merging duplicate numbers) → classify → route.
import { classifyEnquiry } from './classifier.js';
import { route } from './router.js';

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
  call.tier = classification.tier;
  store.save();
  return { enquiry, classification, routed };
}
