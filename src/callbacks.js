// Missed / dropped calls with no usable details (T08): schedule call-back attempts through the telephony adapter.
import { istParts } from './classifier.js';
import { uid } from './store.js';

const addDays = (isoDate, n) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** @returns {object[]} callback records (also pushed to the store). Idempotent per enquiry. */
export function scheduleCallbacks({ cfg, store, enquiry, missedAt }) {
  if (store.db.callbacks.some((c) => c.enquiryId === enquiry.id)) return [];
  const { date, time } = istParts(missedAt, cfg.studio.timezone);
  const baseDate = time >= cfg.studio.office_hours_end ? addDays(date, 1) : date;
  const missedMs = new Date(missedAt).getTime();
  const out = [];
  for (const [i, slot] of cfg.telephony.callback_schedule.entries()) {
    const dueAt = `${addDays(baseDate, slot.day_offset)}T${slot.time}:00+05:30`;
    if (new Date(dueAt).getTime() <= missedMs) continue; // already in the past
    out.push({ id: uid('cb'), enquiryId: enquiry.id, phone: enquiry.phone, attempt: i + 1, dueAt, status: 'scheduled', source: enquiry.source });
  }
  store.db.callbacks.push(...out);
  store.event('callbacks_scheduled', { enquiryId: enquiry.id, count: out.length });
  store.save();
  return out;
}

/**
 * Dial call-backs that are due (missed / dropped calls with no usable details). Live source only: seed call-backs are never dialled.
 * Goes through VaaniApi.triggerCall, which is DRY-RUN unless AANGAN_LIVE=1 + VAANI_API_KEY + VAANI_AGENT_ID, and never skips DND.
 */
export async function runDueCallbacks({ cfg, store, api, now = new Date() }) {
  const done = [];
  for (const cb of store.db.callbacks) {
    if (cb.status !== 'scheduled' || new Date(cb.dueAt) > now) continue;
    const enq = store.getEnquiry(cb.enquiryId);
    if (!enq || cb.source === 'seed') { cb.status = 'skipped_seed'; continue; }
    if (['green', 'red', 'escalate'].includes(enq.tier)) { cb.status = 'skipped_resolved'; continue; } // the caller got through meanwhile
    try {
      const r = await api.triggerCall({ contactNumber: cb.phone, name: enq.fields?.name, metadata: { phone: cb.phone, callback_for: enq.id, attempt: cb.attempt }, store, enquiryId: enq.id });
      cb.status = r.dryRun ? 'dry_run_dialled' : 'dialing';
      cb.vaaniCallId = r.callId ?? null;
      cb.attemptedAt = now.toISOString();
      done.push(cb);
    } catch (e) {
      cb.status = 'error'; cb.error = e.message;
      store.event('callback_error', { enquiryId: enq.id, error: e.message });
    }
  }
  store.save();
  return done;
}
