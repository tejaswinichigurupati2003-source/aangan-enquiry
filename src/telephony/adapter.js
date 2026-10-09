// Telephony adapter — a thin interface. No live number is wired in this build (hard requirement).
// The simulator (bin/call.js) and StubTelephony implement it; ExotelStubAdapter documents the shape of a real
// India-capable provider integration but refuses to run. See README for providers to verify.

export class NotWiredError extends Error {
  constructor(what) { super(`${what} is not wired. No live telephony in this build — see README "Going live".`); this.name = 'NotWiredError'; }
}

/**
 * Interface every provider adapter implements. In production audio flows: caller audio → STT → engine.turn()
 * → TTS → caller. Here "audio" is text, so say()/listen() carry strings.
 */
export class TelephonyAdapter {
  /** register handler({callId, from, to, ringAt}) for inbound calls */
  onIncomingCall(_handler) { throw new NotWiredError('onIncomingCall'); }
  async answer(_callId) { throw new NotWiredError('answer'); }
  async say(_callId, _text) { throw new NotWiredError('say'); }
  async hangup(_callId, _reason) { throw new NotWiredError('hangup'); }
  /** place an outbound call-back (missed-call recovery, T08) */
  async placeCallback(_opts) { throw new NotWiredError('placeCallback'); }
}

/** Records everything; never touches a network. Used by the simulator, tests and the demo. */
export class StubTelephony extends TelephonyAdapter {
  constructor() { super(); this.log = []; this.handler = null; this.ringAt = new Map(); }
  onIncomingCall(handler) { this.handler = handler; }
  ring({ from, callId }) {
    const ringAt = Date.now();
    this.ringAt.set(callId, ringAt);
    this.log.push({ type: 'ring', callId, from, ringAt });
    return ringAt;
  }
  async answer(callId) { this.log.push({ type: 'answer', callId, at: Date.now(), ringToAnswerMs: Date.now() - (this.ringAt.get(callId) ?? Date.now()) }); }
  async say(callId, text) { this.log.push({ type: 'say', callId, text }); }
  async hangup(callId, reason = 'normal') { this.log.push({ type: 'hangup', callId, reason }); }
  async placeCallback({ to, reason, enquiryId }) { this.log.push({ type: 'callback_dry_run', to, reason, enquiryId }); return { dryRun: true }; }
}
