// STUB for an India-capable voice provider (Exotel is used as the worked example; Knowlarity, Ozonetel,
// MyOperator, Plivo, Twilio etc. follow the same shape). NOTHING here makes a network call and the class
// refuses to run. Webhook field names below are from memory of typical provider docs — VERIFY every one
// against the provider's current documentation before wiring.
import { TelephonyAdapter, NotWiredError } from './adapter.js';

/** Map a provider "incoming call" webhook payload to the adapter's neutral shape. (field names: verify) */
export function parseIncomingWebhook(payload) {
  return {
    callId: payload.CallSid ?? payload.call_id ?? null,
    from: payload.CallFrom ?? payload.From ?? payload.from ?? null,
    to: payload.CallTo ?? payload.To ?? payload.to ?? null,
    ringAt: Date.now(),
    raw: payload,
  };
}

export class ExotelStubAdapter extends TelephonyAdapter {
  constructor() {
    super();
    throw new NotWiredError('ExotelStubAdapter');
  }
}

/*
 Wiring checklist (what a real adapter would do):
  1. HTTP endpoint receives the provider's call webhook → parseIncomingWebhook → engine.start({from})
  2. Provider streams caller audio (WebSocket / media stream) → streaming STT (Hindi + English + Marathi) → engine.turn(text)
  3. engine reply text → streaming TTS → provider plays audio; barge-in/interrupt handling
  4. On hang-up/status webhook → engine.end(call, status) → finishCall() (merge, classify, route)
  5. No answer / failure → mark call.status='missed' → scheduleCallbacks() → placeCallback() via the provider API
*/
