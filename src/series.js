// Time series for the dashboard charts: calls per day by tier, calls per hour of day, 7-day trend deltas, top flags.
// "Today" is anchored to the newest call in the data (not the wall clock) so a quiet week or a demo dataset still shows a trend.
import { flagLabel } from './notes.js';

const TIERS = ['green', 'amber', 'red', 'escalate'];
const DAY = 86400000;

export function buildSeries(store, cfg, calls, enquiries) {
  const tz = cfg.studio.timezone;
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false });
  const dayKey = (ms) => dayFmt.format(new Date(ms));
  const hourOf = (ms) => Number(hourFmt.format(new Date(ms))) % 24;
  const tierOf = (c) => c.tier ?? store.getEnquiry(c.enquiryId)?.tier ?? null;

  const times = calls.map((c) => new Date(c.startedAt).getTime()).filter(Number.isFinite);
  const anchor = times.length ? Math.max(...times) : Date.now();
  const first = times.length ? Math.min(...times) : anchor;
  const span = Math.min(90, Math.max(1, Math.round((anchor - first) / DAY) + 1));

  // calls per day (IST) by tier, oldest → newest, no gaps
  const days = [];
  for (let i = span - 1; i >= 0; i--) days.push({ date: dayKey(anchor - i * DAY), green: 0, amber: 0, red: 0, escalate: 0, other: 0, calls: 0 });
  const byDay = new Map(days.map((d) => [d.date, d]));
  for (const c of calls) {
    const d = byDay.get(dayKey(new Date(c.startedAt).getTime()));
    if (!d) continue;
    d.calls++;
    const t = tierOf(c);
    if (TIERS.includes(t)) d[t]++; else d.other++;
  }

  // calls per hour of day (IST), split office / after hours
  const [oh] = cfg.studio.office_hours_start.split(':').map(Number);
  const [ch] = cfg.studio.office_hours_end.split(':').map(Number);
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, calls: 0, office: h >= oh && h < ch }));
  for (const c of calls) hours[hourOf(new Date(c.startedAt).getTime())].calls++;

  // last 7 days vs the 7 before
  const win = (from, to, pred) => calls.filter((c) => { const t = new Date(c.startedAt).getTime(); return t > from && t <= to && pred(c); }).length;
  const delta = (pred) => {
    const cur = win(anchor - 7 * DAY, anchor, pred); const prev = win(anchor - 14 * DAY, anchor - 7 * DAY, pred);
    return { cur, prev, pct: prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null };
  };
  const deltas = { calls: delta(() => true), green: delta((c) => tierOf(c) === 'green'), amber: delta((c) => tierOf(c) === 'amber'), red: delta((c) => tierOf(c) === 'red') };

  const flagCounts = {};
  for (const e of enquiries) for (const f of e.flags || []) flagCounts[f] = (flagCounts[f] || 0) + 1;
  const flags = Object.entries(flagCounts).sort((a, b) => b[1] - a[1]).map(([flag, count]) => ({ flag, label: flagLabel(flag), count }));

  return {
    anchorDate: dayKey(anchor), daily: days, hourly: hours, officeHours: { start: oh, end: ch }, deltas, flags,
  };
}
