// Vani (vaanivoice.ai) REST client — https://docs.vaanivoice.ai  (base https://api.vaanivoice.ai, header X-API-Key: vaani_…)
// Endpoints used: GET /api/call_details/{call_id}  (verify + fetch transcript),  POST /api/trigger-call/  (outbound call-back).
import { isLive } from '../config.js';

export class VaaniError extends Error {
  constructor(message, status) { super(message); this.name = 'VaaniError'; this.status = status; }
}

const NOT_READY = /transcript is not available/i;

export class VaaniApi {
  constructor(cfg, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
    this.cfg = cfg; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
    this.base = String(cfg.vaani.api_base).replace(/\/+$/, '');
    this.key = cfg.env.VAANI_API_KEY; this.agentId = cfg.env.VAANI_AGENT_ID;
  }
  get configured() { return Boolean(this.key); }
  headers(extra = {}) { return { 'X-API-Key': this.key, 'Content-Type': 'application/json', ...extra }; }

  /** Returns {ready, transcription, entity, summary, raw}. ready=false while Vani is still post-processing the call. */
  async getCallDetails(callId) {
    if (!this.key) throw new VaaniError('VAANI_API_KEY is not set');
    const res = await this.fetch(`${this.base}/api/call_details/${encodeURIComponent(callId)}`, { headers: this.headers(), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new VaaniError(`Vani call_details HTTP ${res.status}`, res.status);
    const raw = await res.json();
    const ready = typeof raw.transcription === 'string' && !NOT_READY.test(raw.transcription);
    return { ready, transcription: ready ? raw.transcription : '', entity: ready && typeof raw.entity === 'object' ? raw.entity : {}, summary: ready ? raw.summary ?? '' : '', raw };
  }

  /** Poll call_details until post-processing has produced a transcript (or give up). */
  async waitForCallDetails(callId, { attempts = 6, delayMs = 4000 } = {}) {
    let last;
    for (let i = 0; i < attempts; i++) {
      last = await this.getCallDetails(callId);
      if (last.ready) return last;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return last;
  }

  /**
   * Trigger an outbound call (used for call-backs). DRY-RUN unless AANGAN_LIVE=1 and VAANI_API_KEY + VAANI_AGENT_ID exist.
   * dnd_check_skipped is ALWAYS false: we never bypass the Do-Not-Disturb check.
   */
  async triggerCall({ contactNumber, name, metadata = {}, xAgentId, store, enquiryId }) {
    const body = { agent_id: this.agentId, medium: 'telephony', contact_number: contactNumber, name: name || 'Caller', metadata, dnd_check_skipped: false };
    if (!isLive(this.cfg, ['VAANI_API_KEY', 'VAANI_AGENT_ID'])) {
      store?.outboxPush({ channel: 'vaani_trigger_call', dryRun: true, enquiryId, body: { ...body, contact_number: contactNumber } });
      return { dryRun: true };
    }
    const res = await this.fetch(`${this.base}/api/trigger-call/`, {
      method: 'POST', headers: this.headers(xAgentId ? { 'X-Agent-Id': xAgentId } : {}), body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new VaaniError(`Vani trigger-call HTTP ${res.status}`, res.status);
    const json = await res.json();
    store?.outboxPush({ channel: 'vaani_trigger_call', dryRun: false, enquiryId, callId: json?.output?.call_id });
    return { dryRun: false, callId: json?.output?.call_id, raw: json };
  }
}

/** Vani transcripts are "AGENT: …\n\n USER: …" text. → turns [{role, text}] (agent|caller). */
export function parseVaaniTranscript(text) {
  // Vani's real format is "[11:26:57] AGENT: …" (a time stamp before the speaker); plain "AGENT: …" is accepted too.
  const turns = [];
  const parts = String(text ?? '').split(/(?:^|\n)\s*(?:\[[^\]\n]*\]\s*)?(AGENT|USER)\s*:\s*/i);
  for (let i = 1; i < parts.length; i += 2) {
    const body = parts[i + 1].replace(/\s+/g, ' ').trim();
    if (!body) continue;
    const role = parts[i].toUpperCase() === 'USER' ? 'caller' : 'agent';
    const prev = turns.at(-1);
    if (prev && prev.role === role) prev.text += ` ${body}`; // Vani splits one spoken answer into several lines ("Yes," / "Myself.")
    else turns.push({ role, text: body });
  }
  return turns;
}
