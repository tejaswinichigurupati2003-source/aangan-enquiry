# EXTENSION — adding WhatsApp and the web form later

Not built (scope is inbound phone calls only). This is how they would plug in without touching the rules, handoff or dashboard.

## What stays exactly the same
- **Classifier and rules** (`prompts/classifier.v1.md`, `src/rules.js`): they take a *transcript* and return facts + verdicts →
  tier. A WhatsApp thread or a form submission is just another transcript.
- **Router and handoff** (`src/router.js`, `src/notes.js`, Telegram/HubSpot/email): they take an enquiry + classification.
- **Dashboard** (`src/metrics.js`): reads calls/enquiries from the store.
- **Guard and scripts** (`src/guard.js`, `src/scripts.js`): the same pricing/human/referral/promised-time rules apply to every channel.
- **Merge by phone number**: WhatsApp numbers are phone numbers, so a caller who later messages (or fills the form with the same
  number) merges into the same enquiry.

## What each channel adds

| | WhatsApp | Web form |
|---|---|---|
| Entry | Cloud-API webhook → `channel.onMessage({from, text, ts})` | form POST → one synthetic "transcript" (fields as `Caller:` lines) |
| Conversation | Reuse `CallEngine.turn()` per inbound message; replies are text, so no STT/TTS. One session per phone number, expiring after inactivity | None needed if the form already has the fields; otherwise a one-message follow-up for anything unclear |
| `call.channel` | `'whatsapp'` (already a field on the call record, currently always `'phone'`) | `'form'` |
| Time to answer | message received → first reply | submission → first reply/ack |
| Cost lines | model tokens + WhatsApp conversation fees; no STT/TTS/telephony minutes | model tokens only |
| Consent | WhatsApp opt-in rules and the 24-hour window for free-form replies; templates for outbound | consent checkbox on the form |

## Steps
1. Make the store's `call` generic: it already holds `turns[]`, `from`, `source`, `startedAt`, `status`. Add `channel` to the
   dashboard filters and break cost down by channel (`callCost` already reads components from config, so a `channel` switch there is enough).
2. Add `src/channels/whatsapp.js` implementing the same small contract as the telephony adapter (`onMessage`, `send`).
   Everything after "turn in → reply out" is the existing engine.
3. For the form: build a transcript string and call `finishCall()` directly — no engine turns.
4. Add channel-specific greeting/closing lines to `src/scripts.js` (the AI-disclosure line must be sent on the first WhatsApp reply too).
5. Add eval scenarios per channel (reuse `evals/scenarios/*.json` — `turns` are already plain text).
