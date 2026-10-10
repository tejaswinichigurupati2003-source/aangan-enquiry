// Vani webhook receiver. Events (docs.vaanivoice.ai/guides/webhook-setup): call_started, call_ringing, user_picked_up_at,
// call_rejected, call_no_answer, call_failed, human_transfer_*, call_ended, call_postprocessing.
//
// AUTHENTICITY: Vani documents no signature or secret header. We therefore (1) put an unguessable secret in the URL path
// (compared in constant time), and (2) for call_postprocessing we do NOT trust the body: we re-fetch the call from Vani's
// API with our key and classify THAT transcript. A forged webhook can therefore at worst waste one API call.
import { normalizePhone } from '../phone.js';
import { uid } from '../store.js';
import { finishCall } from '../pipeline.js';
import { parseVaaniTranscript } from './api.js';
import { bookFromCall } from '../postcall-booking.js';

const str = (v) => (typeof v === 'string' ? v : null);

/** Pull ids/fields out of Vani's two payload shapes: flat events and call_postprocessing ({event, call_id, timestamp, data:{…}}). */
export function normalizeEvent(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const d = p.data && typeof p.data === 'object' ? p.data : {};
  return {
    event: str(p.event) ?? 'unknown',
    callId: str(p.room_name) ?? str(d.room_name) ?? str(p.call_id) ?? str(d.call_id),
    timestamp: str(p.timestamp),
    phone: normalizePhone(p.phone_number ?? d.phone_number),
    // call_ended reports seconds; call_postprocessing reports MILLISECONDS (per the docs)
    durationSec: typeof p.call_duration === 'number' ? p.call_duration : (typeof d.call_duration === 'number' ? Math.round(d.call_duration / 1000) : null),
    endReason: str(p.end_reason) ?? str(d.end_reason),
    summary: str(d.summary), transcript: str(d.transcript), recordingUrl: str(d.recording_url),
    entities: d.entities && typeof d.entities === 'object' ? d.entities : null,
    dispositions: d.dispositions && typeof d.dispositions === 'object' ? d.dispositions : null,
    error: str(p.error), raw: p,
  };
}

export class VaaniWebhook {
  constructor({ cfg, store, provider, registry, api, now = () => new Date(), poll, fetchImpl }) {
    Object.assign(this, { cfg, store, provider, registry, api, now, poll, fetchImpl });
  }

  /**
   * Synchronous part: validate, dedupe, persist the raw event. Returns {ok, duplicate, event} — the HTTP layer answers 200
   * right after this and runs process() in the background (Vani's webhook timeout is undocumented, so we answer fast).
   */
  ingest(payload) {
    const ev = normalizeEvent(payload);
    const key = `${ev.event}:${ev.callId}:${ev.timestamp ?? ''}`;
    if (this.registry.isDuplicate(key)) return { ok: true, duplicate: true, ev };
    // keep the raw event for debugging, minus the (large, personal) transcript text
    const { data, ...rest } = payload ?? {};
    const keep = { ...rest, ...(data ? { data: { ...data, transcript: data.transcript ? `[${String(data.transcript).length} chars]` : undefined } } : {}) };
    this.store.event('vaani_event', { vaaniEvent: ev.event, vaaniCallId: ev.callId, payload: keep });
    return { ok: true, duplicate: false, ev };
  }

  async process(ev) {
    const handlers = {
      call_started: () => this.onStarted(ev),
      call_ended: () => this.onEnded(ev),
      call_postprocessing: () => this.onPostprocessing(ev),
      call_no_answer: () => this.onOutboundFailure(ev, 'no_answer'),
      call_rejected: () => this.onOutboundFailure(ev, 'rejected'),
      call_failed: () => this.onOutboundFailure(ev, 'failed'),
    };
    const h = handlers[ev.event];
    return h ? h() : { action: 'logged_only' };
  }

  onStarted(ev) {
    if (!ev.callId) return { action: 'ignored_no_call_id' };
    this.registry.upsert(ev.callId, { phone: ev.phone, startedAt: this.now().toISOString() });
    return { action: 'registered', phone: ev.phone };
  }

  onEnded(ev) {
    if (!ev.callId) return { action: 'ignored_no_call_id' };
    this.registry.upsert(ev.callId, { endedAt: this.now().toISOString(), durationSec: ev.durationSec, endReason: ev.endReason });
    // Vani's duration is authoritative; call_ended can arrive after our socket already closed and the call was finalised
    const call = this.findCall(ev.callId);
    if (call && ev.durationSec > 0) { call.durationSec = ev.durationSec; this.store.save(); }
    return { action: 'noted_end' };
  }

  /** Outbound call-back attempts that did not connect: update the matching call-back record. */
  onOutboundFailure(ev, status) {
    const cb = this.store.db.callbacks.find((c) => c.status === 'dialing' && c.vaaniCallId === ev.callId);
    if (cb) { cb.status = `failed_${status}`; this.store.save(); return { action: 'callback_marked', status }; }
    return { action: 'logged_only' };
  }

  findCall(vaaniCallId) { return this.store.db.calls.find((c) => c.vaaniCallId === vaaniCallId); }

  async onPostprocessing(ev) {
    if (!ev.callId) return { action: 'ignored_no_call_id' };
    const reg = this.registry.get(ev.callId) ?? {};
    let transcript = null; let summary = ev.summary; let entities = ev.entities; let verified = false;

    if (this.cfg.vaani.verify_with_api) {
      if (!this.api.configured) { this.store.event('vaani_unverified', { vaaniCallId: ev.callId, reason: 'VAANI_API_KEY not set' }); return { action: 'rejected_unverified' }; }
      let details;
      try { details = await this.api.waitForCallDetails(ev.callId, this.poll); } catch (e) {
        this.store.event('vaani_unverified', { vaaniCallId: ev.callId, reason: e.message });
        return { action: 'rejected_unverified', reason: e.message };
      }
      if (!details?.ready) { this.store.event('vaani_unverified', { vaaniCallId: ev.callId, reason: 'transcript not ready' }); return { action: 'rejected_unverified', reason: 'not_ready' }; }
      transcript = details.transcription; summary = details.summary || summary; entities = Object.keys(details.entity).length ? details.entity : entities; verified = true;
    } else transcript = ev.transcript;

    const meta = { summary, entities, dispositions: ev.dispositions, recordingUrl: ev.recordingUrl, endReason: ev.endReason ?? reg.endReason, verified };
    const durationSec = ev.durationSec ?? reg.durationSec ?? null;

    // A) our BYOL engine already handled this call → attach Vani's metadata; the classification already ran when the socket closed
    const existing = this.findCall(ev.callId);
    if (existing) {
      existing.vaani = meta;
      if (durationSec != null) existing.durationSec = durationSec;
      this.store.save();
      return { action: 'attached_to_byol_call', callId: existing.id };
    }

    // B) Vani's own AI ran the call → build a call record from Vani's transcript and run it through classify + route
    const turns = parseVaaniTranscript(transcript);
    const end = this.now();
    const start = new Date(end.getTime() - (durationSec ?? 0) * 1000);
    const call = this.store.addCall({
      id: uid('call'), source: 'live', channel: 'phone', vaaniCallId: ev.callId, from: reg.phone ?? ev.phone ?? null,
      startedAt: start.toISOString(), endedAt: end.toISOString(), durationSec: durationSec ?? 0, status: turns.some((t) => t.role === 'caller') ? 'completed' : 'dropped',
      turns, usage: {}, guardEvents: [], engineFlags: [], vaani: meta, via: 'vani_llm',
    });
    const out = await finishCall({ cfg: this.cfg, store: this.store, provider: this.provider, call, now: end });
    // Vani's own AI cannot see our calendar, so it only took a request: book it now from what the caller actually said.
    const booking = await bookFromCall({ cfg: this.cfg, store: this.store, provider: this.provider, enquiry: out.enquiry, call, fetchImpl: this.fetchImpl, now: end });
    if (this.store.drain) await this.store.drain().catch(() => {});
    return { action: 'classified_from_vani_transcript', tier: out.classification.tier, enquiryId: out.enquiry.id, booking: booking.status };
  }
}
