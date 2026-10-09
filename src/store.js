import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EMPTY = () => ({ calls: [], enquiries: [], events: [], outbox: [], reviews: [], callbacks: [] });

export const uid = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

/** Tiny JSON-file store. ~200 calls/month does not need a database. Atomic writes. */
export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = dir ? path.join(dir, 'db.json') : null;
    this.db = EMPTY();
    if (this.file && fs.existsSync(this.file)) {
      try { this.db = { ...EMPTY(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch { this.db = EMPTY(); }
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.file);
  }

  reset() { this.db = EMPTY(); this.save(); }

  event(type, payload = {}) {
    const e = { id: uid('ev'), type, at: new Date().toISOString(), ...payload };
    this.db.events.push(e);
    this.save();
    return e;
  }

  addCall(call) { this.db.calls.push(call); this.save(); return call; }
  getCall(id) { return this.db.calls.find((c) => c.id === id); }
  getEnquiry(id) { return this.db.enquiries.find((e) => e.id === id); }

  /**
   * Attach a call to an enquiry: merge by normalised number + source inside the merge window,
   * otherwise open a new enquiry. Seed and live never merge together.
   */
  attachCall(call, { windowDays = 14 } = {}) {
    const when = new Date(call.startedAt).getTime();
    const windowMs = windowDays * 86400000;
    let enquiry = null;
    if (call.from) {
      enquiry = this.db.enquiries.find((e) =>
        e.phone === call.from && e.source === call.source && e.status !== 'closed' &&
        Math.abs(when - new Date(e.updatedAt).getTime()) <= windowMs);
    }
    if (enquiry) {
      enquiry.callIds.push(call.id);
      enquiry.updatedAt = call.startedAt;
      enquiry.repeatCaller = true;
    } else {
      enquiry = {
        id: uid('enq'), source: call.source, phone: call.from, callIds: [call.id],
        tier: null, classification: null, fields: {}, flags: [], status: 'open',
        createdAt: call.startedAt, updatedAt: call.startedAt, handoff: {}, repeatCaller: false,
      };
      this.db.enquiries.push(enquiry);
    }
    call.enquiryId = enquiry.id;
    this.save();
    return enquiry;
  }

  /** Combined transcript for an enquiry (chronological), with call headers. */
  combinedTranscript(enquiry) {
    const calls = enquiry.callIds.map((id) => this.getCall(id)).filter(Boolean)
      .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
    return calls.map((c, i) => {
      const head = `--- Call ${i + 1} of ${calls.length} · ${c.startedAt} · ${c.status}${c.durationSec != null ? ` · ${c.durationSec}s` : ''} ---`;
      const body = c.turns.length ? c.turns.map((t) => `${t.role === 'caller' ? 'Caller' : 'Agent'}: ${t.text}`).join('\n') : '(no conversation)';
      return `${head}\n${body}`;
    }).join('\n\n');
  }

  outboxPush(entry) {
    const e = { id: uid('out'), at: new Date().toISOString(), dryRun: true, ...entry };
    this.db.outbox.push(e);
    this.save();
    return e;
  }

  setReview(enquiryId, verdict, note = '') {
    const r = { enquiryId, verdict, note, at: new Date().toISOString() };
    this.db.reviews = this.db.reviews.filter((x) => x.enquiryId !== enquiryId);
    this.db.reviews.push(r);
    this.save();
    return r;
  }
}
