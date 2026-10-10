// Reads the studio's Google Calendar through its private iCal address (Settings → Integrate calendar → "Secret address in iCal format").
// It is READ-ONLY: it lets the AI avoid times that are already busy (meetings, holidays, site visits). Writing a booking INTO the calendar is gcal.js.
// Events that this system created itself (they carry our UID / "Lead: enq_…" marker) are ignored here, because our own records already count them per designer.
const DAY = 86400000;

const unfold = (t) => String(t).replace(/\r?\n[ \t]/g, '');

/** "20261012T053000Z" / "20261012T110000" (+TZID) / "20261012" (all-day) → epoch ms */
function toMs(value, params, studioTz) {
  const v = String(value).trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', z] = m;
  if (z) return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const tz = /TZID=([^;:]+)/.exec(params)?.[1] ?? studioTz;
  return localToUtc(tz, +y, +mo, +d, +h, +mi, +s);
}

/** Wall-clock time in `tz` → epoch ms (offset found by asking Intl; two passes handle DST edges). */
function localToUtc(tz, y, mo, d, h, mi, s) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetAt = (ms) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
  };
  try { let t = guess - offsetAt(guess); t = guess - offsetAt(t); return t; } catch { return guess; }
}

const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Parse VEVENTs and expand simple recurrences (DAILY / WEEKLY[BYDAY] / MONTHLY, INTERVAL, COUNT, UNTIL, EXDATE) inside [from, to]. */
export function parseIcalBusy(text, { from, to, studioTz = 'Asia/Kolkata' }) {
  const lines = unfold(text).split(/\r?\n/);
  const events = []; let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { ex: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur?.start != null) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(':'); if (i < 0) continue;
    const [name, ...pp] = line.slice(0, i).split(';'); const params = pp.join(';'); const val = line.slice(i + 1);
    if (name === 'DTSTART') { cur.start = toMs(val, params, studioTz); cur.allDay = /VALUE=DATE(?!-)/.test(params) || /^\d{8}$/.test(val.trim()); }
    else if (name === 'DTEND') cur.end = toMs(val, params, studioTz);
    else if (name === 'DURATION') { const d = /P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/.exec(val) ?? []; cur.dur = ((+d[1] || 0) * 24 * 60 + (+d[2] || 0) * 60 + (+d[3] || 0)) * 60000; }
    else if (name === 'RRULE') cur.rrule = Object.fromEntries(val.split(';').map((kv) => kv.split('=')));
    else if (name === 'EXDATE') for (const v of val.split(',')) { const m = toMs(v, params, studioTz); if (m != null) cur.ex.push(m); }
    else if (name === 'UID') cur.uid = val; else if (name === 'DESCRIPTION') cur.desc = val; else if (name === 'SUMMARY') cur.summary = val;
    else if (name === 'STATUS') cur.status = val; else if (name === 'TRANSP') cur.transp = val;
  }
  const out = [];
  for (const e of events) {
    if (e.status === 'CANCELLED' || e.transp === 'TRANSPARENT') continue; // cancelled, or marked "free"
    if (/@aangan\b/.test(e.uid ?? '') || /Lead: enq_/.test(e.desc ?? '')) continue; // ours: counted per designer elsewhere
    const len = (e.end ?? e.start + (e.dur ?? (e.allDay ? DAY : 3600000))) - e.start;
    const starts = [];
    const r = e.rrule;
    if (!r) starts.push(e.start);
    else {
      const step = Math.max(1, +r.INTERVAL || 1); const until = r.UNTIL ? toMs(r.UNTIL, '', studioTz) : Infinity; let count = r.COUNT ? +r.COUNT : Infinity; let n = 0;
      const byday = r.BYDAY ? r.BYDAY.split(',').map((x) => DOW[x.slice(-2)]).filter((x) => x != null) : null;
      for (let day = 0; day < 400 && n < count; day++) {
        const t = e.start + day * DAY; if (t > to || t > until) break;
        const weekIdx = Math.floor(day / 7), dow = new Date(t + 5.5 * 3600000).getUTCDay();
        const ok = r.FREQ === 'DAILY' ? day % step === 0
          : r.FREQ === 'WEEKLY' ? weekIdx % step === 0 && (byday ? byday.includes(dow) : day % 7 === 0)
            : r.FREQ === 'MONTHLY' ? new Date(t).getUTCDate() === new Date(e.start).getUTCDate() && Math.round(day / 30) % step === 0 : day === 0;
        if (ok) { n++; starts.push(t); }
      }
    }
    for (const s of starts) { if (e.ex.includes(s)) continue; if (s + len > from && s < to) out.push({ start: s, end: s + len, summary: e.summary ?? '' }); }
  }
  return out;
}

let cache = { at: 0, url: null, busy: [] };
export const resetBusyCache = () => { cache = { at: 0, url: null, busy: [] }; };

/** Busy intervals [{start,end}] (ms) from CALENDAR_ICAL_URL for the next `horizonDays`. Cached 5 minutes. A failure returns the last good copy (or []), never throws. */
export async function getExternalBusy(cfg, { fetchImpl = fetch, nowMs = Date.now(), store = null } = {}) {
  const url = cfg.env?.CALENDAR_ICAL_URL;
  if (!url) return [];
  if (cache.url === url && nowMs - cache.at < 300000) return cache.busy;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`iCal HTTP ${res.status}`);
    const horizon = (cfg.booking?.horizon_days ?? 14) + 2;
    cache = { at: nowMs, url, busy: parseIcalBusy(await res.text(), { from: nowMs - DAY, to: nowMs + horizon * DAY, studioTz: cfg.studio.timezone }) };
  } catch (e) {
    store?.event?.('ical_error', { error: e.message });
    cache = { ...cache, at: nowMs - 240000, url }; // retry in a minute, keep serving the last good copy
  }
  return cache.busy;
}
