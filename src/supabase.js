// Supabase persistence over its PostgREST HTTP API (zero dependencies).
// SupabaseStore keeps the same synchronous in-memory interface as Store (so engine/router/metrics are unchanged) and
// WRITES THROUGH: save() schedules a flush that upserts only the rows that changed. The service-role key stays on the server.
import { Store } from './store.js';

// Every column we create is prefixed aan_ so it can never collide with another app's columns in the same Supabase project.
const TABLES = {
  calls:     { table: 'aangan_calls',     key: 'aan_id',         limit: 5000, order: 'aan_started_at.desc' },
  enquiries: { table: 'aangan_enquiries', key: 'aan_id',         limit: 5000, order: 'aan_updated_at.desc' },
  events:    { table: 'aangan_events',    key: 'aan_id',         limit: 3000, order: 'aan_at.desc' },
  outbox:    { table: 'aangan_outbox',    key: 'aan_id',         limit: 3000, order: 'aan_at.desc' },
  callbacks: { table: 'aangan_callbacks', key: 'aan_id',         limit: 5000, order: 'aan_due_at.desc' },
  reviews:   { table: 'aangan_reviews',   key: 'aan_enquiry_id', limit: 5000, order: 'aan_at.desc' },
};
const recordId = (name, rec) => (name === 'reviews' ? rec.enquiryId : rec.id);

const ts = (v) => (v ? new Date(v).toISOString() : null);

/** Typed columns promoted out of each record (the full record is always kept in aan_data). */
const toRow = {
  calls: (c) => ({ aan_id: c.id, aan_source: c.source, aan_vani_call_id: c.vaaniCallId ?? null, aan_phone: c.from ?? null, aan_status: c.status ?? null, aan_tier: c.tier ?? null, aan_started_at: ts(c.startedAt), aan_data: c, aan_updated_at: new Date().toISOString() }),
  enquiries: (e) => ({ aan_id: e.id, aan_source: e.source, aan_phone: e.phone ?? null, aan_tier: e.tier ?? null, aan_status: e.status ?? null, aan_created_at: ts(e.createdAt), aan_data: e, aan_updated_at: new Date().toISOString() }),
  events: (e) => ({ aan_id: e.id, aan_type: e.type, aan_at: ts(e.at), aan_data: e }),
  outbox: (o) => ({ aan_id: o.id, aan_channel: o.channel, aan_enquiry_id: o.enquiryId ?? null, aan_at: ts(o.at), aan_data: o }),
  callbacks: (c) => ({ aan_id: c.id, aan_enquiry_id: c.enquiryId ?? null, aan_due_at: ts(c.dueAt), aan_status: c.status ?? null, aan_data: c }),
  reviews: (r) => ({ aan_enquiry_id: r.enquiryId, aan_verdict: r.verdict, aan_at: ts(r.at), aan_data: r }),
};

export class SupabaseError extends Error {
  constructor(message, status) { super(message); this.name = 'SupabaseError'; this.status = status; }
}

export class SupabaseClient {
  constructor({ url, key, fetchImpl = fetch, timeoutMs = 15000 }) {
    if (!url || !key) throw new SupabaseError('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    this.base = `${String(url).replace(/\/+$/, '')}/rest/v1`;
    this.key = key; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  headers(extra = {}) {
    const h = { apikey: this.key, 'Content-Type': 'application/json', ...extra };
    if (!String(this.key).startsWith('sb_')) h.Authorization = `Bearer ${this.key}`; // legacy JWT keys need the bearer header; sb_* keys are not JWTs
    return h;
  }

  async select(table, { order, limit = 1000 } = {}) {
    const q = new URLSearchParams({ select: 'aan_data', limit: String(limit) });
    if (order) q.set('order', order);
    const res = await this.fetch(`${this.base}/${table}?${q}`, { headers: this.headers(), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new SupabaseError(`Supabase select ${table} failed: HTTP ${res.status}`, res.status);
    return (await res.json()).map((r) => r.aan_data);
  }

  async upsert(table, rows, onConflict) {
    if (!rows.length) return;
    const res = await this.fetch(`${this.base}/${table}?on_conflict=${onConflict}`, {
      method: 'POST', headers: this.headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(rows), signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new SupabaseError(`Supabase upsert ${table} failed: HTTP ${res.status}`, res.status);
  }
}

export class SupabaseStore extends Store {
  constructor(cfg, { fetchImpl, debounceMs = 250 } = {}) {
    super(null);
    this.client = new SupabaseClient({ url: cfg.env.SUPABASE_URL, key: cfg.env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl });
    this.synced = new Map(); // "collection:id" → JSON last written
    this.debounceMs = debounceMs; this.timer = null; this.inflight = Promise.resolve(); this.lastError = null;
  }

  /** Load existing rows into memory. Call once after construction. */
  async load() {
    for (const [name, t] of Object.entries(TABLES)) {
      const rows = await this.client.select(t.table, { order: t.order, limit: t.limit });
      // oldest first so in-memory arrays keep chronological order like the JSON store
      this.db[name] = rows.reverse();
      for (const r of this.db[name]) this.synced.set(`${name}:${recordId(name, r)}`, JSON.stringify(r));
    }
    return this;
  }

  /** Write-through: schedule a flush (debounced); returns nothing so it stays a drop-in for Store.save(). */
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.inflight = this.flush().catch(() => {}); }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Upsert every row that changed since the last successful write. Safe to call any time; rejects if Supabase is unreachable. */
  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const jobs = [];
    for (const [name, t] of Object.entries(TABLES)) {
      const dirty = [];
      for (const rec of this.db[name]) {
        const id = recordId(name, rec);
        const json = JSON.stringify(rec);
        if (this.synced.get(`${name}:${id}`) !== json) dirty.push({ rec, id, json });
      }
      for (let i = 0; i < dirty.length; i += 200) {
        const chunk = dirty.slice(i, i + 200);
        jobs.push({ name, t, chunk });
      }
    }
    try {
      for (const { name, t, chunk } of jobs) {
        await this.client.upsert(t.table, chunk.map((c) => toRow[name](c.rec)), t.key);
        for (const c of chunk) this.synced.set(`${name}:${c.id}`, c.json);
      }
      this.lastError = null;
    } catch (e) {
      this.lastError = e; // rows stay dirty and are retried on the next flush
      throw e;
    }
  }

  /** Await any scheduled/in-flight write (use before shutdown and in tests). */
  async drain() { await this.inflight; await this.flush(); }
}
