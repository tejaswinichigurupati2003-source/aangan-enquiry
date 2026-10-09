// In-process directory of Vani calls seen via webhooks (caller number, timing). Cleared on restart: anything that matters is also
// written to the store (events + call records), so a restart loses only the short-lived "call_started → first BYOL turn" hand-off.
export class CallRegistry {
  constructor() { this.calls = new Map(); this.seenEvents = new Map(); }

  get(id) { return this.calls.get(id); }
  upsert(id, patch) { const cur = this.calls.get(id) ?? { id, firstSeen: Date.now() }; const next = { ...cur, ...patch }; this.calls.set(id, next); return next; }

  /** The first BYOL turn can arrive before the call_started webhook; wait briefly for the caller number. */
  async waitForPhone(id, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const phone = this.calls.get(id)?.phone;
      if (phone) return phone;
      await new Promise((r) => setTimeout(r, 40));
    }
    return this.calls.get(id)?.phone ?? null;
  }

  /** Webhook duplicate suppression (Vani documents no delivery guarantees). Remembers ~1 hour. */
  isDuplicate(key) {
    const now = Date.now();
    for (const [k, t] of this.seenEvents) if (now - t > 3600000) this.seenEvents.delete(k);
    if (this.seenEvents.has(key)) return true;
    this.seenEvents.set(key, now);
    return false;
  }
}
