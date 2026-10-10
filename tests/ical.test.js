import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { parseIcalBusy, getExternalBusy, resetBusyCache } from '../src/integrations/ical-busy.js';
import { findSlots, parseWindowHint } from '../src/booking.js';

const cfg = loadConfig({ fresh: true, env: {} });
const NOW = new Date('2026-10-09T06:30:00Z'); // Fri 12:00 IST
const ics = (...ev) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...ev.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');
const range = { from: NOW.getTime(), to: NOW.getTime() + 20 * 86400000, studioTz: 'Asia/Kolkata' };

test('iCal: UTC, TZID and all-day events become busy intervals; cancelled, "free" and our own events are ignored', () => {
  const busy = parseIcalBusy(ics(
    ['UID:a@google.com', 'DTSTART:20261017T043000Z', 'DTEND:20261017T053000Z', 'SUMMARY:Site visit'],
    ['UID:b@google.com', 'DTSTART;TZID=Asia/Kolkata:20261019T110000', 'DTEND;TZID=Asia/Kolkata:20261019T120000', 'SUMMARY:Vendor meeting'],
    ['UID:c@google.com', 'DTSTART;VALUE=DATE:20261020', 'DTEND;VALUE=DATE:20261021', 'SUMMARY:Holiday'],
    ['UID:d@google.com', 'DTSTART:20261021T050000Z', 'DTEND:20261021T060000Z', 'STATUS:CANCELLED'],
    ['UID:e@google.com', 'DTSTART:20261021T050000Z', 'DTEND:20261021T060000Z', 'TRANSP:TRANSPARENT'],
    ['UID:enq_1-consult@aangan', 'DTSTART:20261022T050000Z', 'DTEND:20261022T060000Z', 'SUMMARY:ours'],
    ['UID:f@google.com', 'DTSTART:20261023T050000Z', 'DTEND:20261023T060000Z', 'DESCRIPTION:Lead: enq_9'],
  ), range);
  assert.equal(busy.length, 3);
  assert.equal(new Date(busy[0].start).toISOString(), '2026-10-17T04:30:00.000Z');
  assert.equal(new Date(busy.find((b) => b.summary === 'Vendor meeting').start).toISOString(), '2026-10-19T05:30:00.000Z', '11:00 IST = 05:30Z');
  assert.equal(busy.find((b) => b.summary === 'Holiday').end - busy.find((b) => b.summary === 'Holiday').start, 86400000);
});

test('iCal: weekly and daily recurrences, EXDATE, COUNT and UNTIL are expanded; folded lines are joined', () => {
  const busy = parseIcalBusy(ics(
    ['UID:w@google.com', 'DTSTART;TZID=Asia/Kolkata:20261012T100000', 'DTEND;TZID=Asia/Kolkata:20261012T110000', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3', 'SUMMARY:Team mee', ' ting'],
    ['UID:x@google.com', 'DTSTART:20261013T090000Z', 'DTEND:20261013T093000Z', 'RRULE:FREQ=DAILY;UNTIL=20261015T235959Z', 'EXDATE:20261014T090000Z', 'SUMMARY:Stand-up'],
  ), range);
  const team = busy.filter((b) => b.summary === 'Team meeting').map((b) => new Date(b.start).toISOString());
  assert.deepEqual(team, ['2026-10-12T04:30:00.000Z', '2026-10-19T04:30:00.000Z', '2026-10-26T04:30:00.000Z']);
  assert.deepEqual(busy.filter((b) => b.summary === 'Stand-up').map((b) => new Date(b.start).toISOString().slice(0, 10)), ['2026-10-13', '2026-10-15']);
});

test('the AI never offers a time that is busy on the studio calendar', () => {
  const store = new Store(null);
  const hint = parseWindowHint('Saturday mornings', cfg, NOW.getTime());
  const [first] = findSlots({ cfg, store, hint, nowMs: NOW.getTime() });
  const busy = [{ start: new Date(first.start).getTime(), end: new Date(first.end).getTime() }];
  const after = findSlots({ cfg, store, hint, nowMs: NOW.getTime(), count: 10, busy });
  assert.ok(!after.some((s) => s.start === first.start));
  assert.ok(after.length > 0);
  // a whole-day block (holiday) removes every slot that day
  const day = new Date(first.start).getTime(); const all = findSlots({ cfg, store, hint: {}, nowMs: NOW.getTime(), count: 200, busy: [{ start: day - 6 * 3600000, end: day + 12 * 3600000 }] });
  assert.ok(!all.some((s) => new Date(s.start).toISOString().slice(0, 10) === first.start.slice(0, 10)));
});

test('iCal fetch: cached, last good copy survives an outage, no URL = no effect, URL is never logged', async () => {
  resetBusyCache();
  const store = new Store(null);
  const live = { ...cfg, env: { CALENDAR_ICAL_URL: 'https://calendar.google.com/calendar/ical/secret-token/basic.ics' } };
  assert.deepEqual(await getExternalBusy(cfg, { nowMs: NOW.getTime() }), []);
  let calls = 0; let up = true;
  const fetchImpl = async () => { calls++; if (!up) return { ok: false, status: 500, text: async () => '' }; return { ok: true, text: async () => ics(['UID:a@google.com', 'DTSTART:20261017T043000Z', 'DTEND:20261017T053000Z', 'SUMMARY:Site visit']) }; };
  assert.equal((await getExternalBusy(live, { fetchImpl, nowMs: NOW.getTime(), store })).length, 1);
  await getExternalBusy(live, { fetchImpl, nowMs: NOW.getTime() + 1000, store }); assert.equal(calls, 1, 'cached for 5 minutes');
  up = false;
  assert.equal((await getExternalBusy(live, { fetchImpl, nowMs: NOW.getTime() + 400000, store })).length, 1, 'an outage keeps the last good copy');
  assert.ok(store.db.events.some((e) => e.type === 'ical_error'));
  assert.ok(!JSON.stringify(store.db.events).includes('secret-token'), 'the secret address is never written to the log');
});
