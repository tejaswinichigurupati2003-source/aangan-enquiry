import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { autoAssign, buildAttention, getTeam, pickDesigner } from '../src/team.js';
import { applyAction } from '../src/actions.js';
import { buildIcs, googleCalendarLink, calendarWeekLink } from '../src/calendar.js';
import { computeMetrics } from '../src/metrics.js';
import { createDashboard } from '../src/dashboard/server.js';

const cfg = loadConfig({ fresh: true, env: {} });
const D = getTeam(cfg).designers.map((d) => d.name);
const NOW = new Date('2026-10-10T06:00:00Z'); // Saturday 11:30 IST

function lead(store, over = {}) {
  const n = store.db.enquiries.length + 1;
  const e = { id: `enq_${n}`, source: 'live', phone: `+9198000000${String(n).padStart(2, '0')}`, callIds: [], tier: 'green', fields: { name: `Caller ${n}`, locality: 'Baner' }, flags: [], status: 'handed_off', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), handoff: {}, classification: { summary: 's' }, ...over };
  store.db.enquiries.push(e);
  return e;
}
const act = (store, body, now = NOW) => applyAction({ cfg, store, body, now });

test('auto-assign: Green goes to the least-loaded designer, ties by config order; Escalate goes to the studio head', () => {
  const store = new Store(null);
  const owners = [];
  for (let i = 0; i < 6; i++) { const e = lead(store); autoAssign(cfg, store, e, NOW); owners.push(e.assignment.ownerId); }
  assert.deepEqual(owners, ['designer_1', 'designer_2', 'designer_3', 'designer_1', 'designer_2', 'designer_3']);
  const esc = lead(store, { tier: 'escalate' });
  autoAssign(cfg, store, esc, NOW);
  assert.equal(esc.assignment.ownerId, getTeam(cfg).admin.id);
  const amber = lead(store, { tier: 'amber' });
  assert.equal(autoAssign(cfg, store, amber, NOW), null, 'Amber leads wait in the queue with no owner');
  // a person's choice is never overridden
  const g = lead(store); g.assignment = { ownerId: 'designer_3', ownerName: 'Designer 3' };
  assert.equal(autoAssign(cfg, store, g, NOW).ownerId, 'designer_3');
  // closed leads no longer count as load
  for (const e of store.db.enquiries.filter((x) => x.assignment?.ownerId === 'designer_1')) e.stage = 'won';
  assert.equal(pickDesigner(cfg, store).id, 'designer_1');
});

test('reassign: changes owner, moves a booked consultation with it, logs the change, ignores unknown people', () => {
  const store = new Store(null); const e = lead(store); autoAssign(cfg, store, e, NOW);
  assert.equal(act(store, { action: 'assign', enquiryId: e.id, ownerId: 'nobody' }).status, 400);
  const r = act(store, { action: 'assign', enquiryId: e.id, ownerId: 'designer_2', by: 'Nikhil' });
  assert.ok(r.ok); assert.equal(e.assignment.ownerId, 'designer_2'); assert.match(r.notify, new RegExp(`${D[0]} → ${D[1]}`));
  assert.equal(act(store, { action: 'assign', enquiryId: e.id, ownerId: 'designer_2' }).notify, null, 'no-op reassign sends nothing');
  act(store, { action: 'schedule', enquiryId: e.id, start: '2026-10-12T05:30:00Z', minutes: 60 });
  act(store, { action: 'assign', enquiryId: e.id, ownerId: 'designer_3' });
  assert.equal(e.consult.designerId, 'designer_3');
  assert.ok(e.activity.some((a) => new RegExp(`Reassigned from ${D[0]} to ${D[1]}`).test(a.text)));
  assert.ok(store.db.events.some((x) => x.type === 'lead_assigned' && x.to === 'designer_2'));
});

test('stages: only those that fit the lead type; booking and cancelling move the stage', () => {
  const store = new Store(null); const g = lead(store); const a = lead(store, { tier: 'amber' });
  assert.equal(act(store, { action: 'stage', enquiryId: a.id, stage: 'won' }).status, 400);
  assert.equal(act(store, { action: 'stage', enquiryId: g.id, stage: 'nonsense' }).status, 400);
  assert.ok(act(store, { action: 'stage', enquiryId: a.id, stage: 'resolved' }).ok);
  autoAssign(cfg, store, g, NOW);
  act(store, { action: 'schedule', enquiryId: g.id, start: '2026-10-12T05:30:00Z' });
  assert.equal(g.stage, 'consult_booked');
  act(store, { action: 'cancel_consult', enquiryId: g.id });
  assert.equal(g.stage, 'contacted'); assert.equal(g.consult.status, 'cancelled');
  act(store, { action: 'schedule', enquiryId: g.id, start: '2026-10-12T05:30:00Z' });
  act(store, { action: 'consult_done', enquiryId: g.id });
  assert.equal(g.consult.status, 'done'); assert.equal(g.stage, 'consult_done');
});

test('schedule: refuses clashes and the past, asks before Sundays / out-of-hours, validates length', () => {
  const store = new Store(null); const a = lead(store); const b = lead(store);
  autoAssign(cfg, store, a, NOW); a.assignment.ownerId = 'designer_1'; b.assignment = { ownerId: 'designer_1', ownerName: 'Designer 1' };
  assert.ok(act(store, { action: 'schedule', enquiryId: a.id, start: '2026-10-12T05:30:00Z', minutes: 60 }).ok); // Mon 11:00 IST
  const clash = act(store, { action: 'schedule', enquiryId: b.id, start: '2026-10-12T06:00:00Z', minutes: 30 });
  assert.equal(clash.status, 409); assert.equal(clash.needsConfirm, undefined, 'a double-booking cannot be forced');
  assert.equal(act(store, { action: 'schedule', enquiryId: b.id, start: '2026-10-12T06:00:00Z', minutes: 30, force: true }).status, 409);
  assert.ok(act(store, { action: 'schedule', enquiryId: b.id, start: '2026-10-12T06:30:00Z', minutes: 30 }).ok, 'back-to-back is fine');
  assert.equal(act(store, { action: 'schedule', enquiryId: b.id, start: '2026-10-09T05:30:00Z' }).status, 400, 'past');
  assert.equal(act(store, { action: 'schedule', enquiryId: b.id, start: 'garbage' }).status, 400);
  assert.equal(act(store, { action: 'schedule', enquiryId: b.id, start: '2026-10-13T05:30:00Z', minutes: 5 }).status, 400);
  const c = lead(store); c.assignment = { ownerId: 'designer_2', ownerName: 'Designer 2' };
  const sun = act(store, { action: 'schedule', enquiryId: c.id, start: '2026-10-11T05:30:00Z' }); // Sunday
  assert.equal(sun.status, 409); assert.equal(sun.needsConfirm, true); assert.match(sun.error, /Sunday/);
  assert.ok(act(store, { action: 'schedule', enquiryId: c.id, start: '2026-10-11T05:30:00Z', force: true }).ok);
  const late = act(store, { action: 'schedule', enquiryId: lead(store).id, designerId: 'designer_3', start: '2026-10-13T14:00:00Z' }); // 19:30 IST
  assert.equal(late.needsConfirm, true); assert.match(late.error, /office hours/);
});

test('calendar: Google link and .ics carry the right times, no secrets, designer email only if configured', () => {
  const store = new Store(null); const e = lead(store, { fields: { name: 'Priya', locality: 'Baner', preferred_window: 'weekend mornings' } });
  autoAssign(cfg, store, e, NOW);
  act(store, { action: 'schedule', enquiryId: e.id, start: '2026-10-12T05:30:00Z', minutes: 60 });
  const link = googleCalendarLink(e, { name: 'D', email: 'd@example.com' }, cfg);
  assert.match(link, /^https:\/\/calendar\.google\.com\/calendar\/render\?/);
  const q = new URL(link).searchParams;
  assert.equal(q.get('dates'), '20261012T053000Z/20261012T063000Z'); assert.equal(q.get('ctz'), 'Asia/Kolkata'); assert.equal(q.get('add'), 'd@example.com');
  assert.match(q.get('details'), /weekend mornings/);
  assert.ok(!new URL(googleCalendarLink(e, { name: 'D', email: '' }, cfg)).searchParams.has('add'));
  const ics = buildIcs(e, null, cfg);
  assert.match(ics, /DTSTART:20261012T053000Z/); assert.match(ics, /\r\nEND:VCALENDAR\r\n$/);
  assert.equal(calendarWeekLink(cfg, e.consult.start, 'https://calendar.google.com/calendar/u/0/r/week/2026/10/11'), 'https://calendar.google.com/calendar/u/0/r/week/2026/10/12');
});

test('attention: live leads only; unassigned, un-picked-up, stale, due call-backs, overdue consults; test data never nags', () => {
  const store = new Store(null);
  const old = (min) => new Date(NOW.getTime() - min * 60000).toISOString();
  const un = lead(store, { handoff: { telegramSentAt: old(10) } });
  const np = lead(store, { handoff: { telegramSentAt: old(45) }, assignment: { ownerId: 'designer_1', ownerName: 'Designer 1' } });
  const stale = lead(store, { handoff: { telegramSentAt: old(6000), ackAt: old(5990) }, stage: 'contacted', updatedAt: old(6000), assignment: { ownerId: 'designer_1', ownerName: 'D' } });
  const fine = lead(store, { handoff: { telegramSentAt: old(10), ackAt: old(5) }, assignment: { ownerId: 'designer_2', ownerName: 'D2' } });
  const amber = lead(store, { tier: 'amber', queue: { since: old(100), reason: 'missed' } });
  store.db.callbacks.push({ id: 'cb1', enquiryId: amber.id, status: 'scheduled', dueAt: old(5), attempt: 1 });
  lead(store, { source: 'seed', handoff: { telegramSentAt: old(9000) } });
  const att = buildAttention(store, cfg, NOW);
  const kinds = Object.fromEntries(att.map((a) => [a.enquiryId, a.kind]));
  assert.equal(kinds[un.id], 'unassigned'); assert.equal(kinds[np.id], 'not_picked_up'); assert.equal(kinds[stale.id], 'stale'); assert.equal(kinds[amber.id], 'callback_due');
  assert.ok(!(fine.id in kinds)); assert.equal(att.length, 4, 'the seed lead is ignored');
  const m = computeMetrics(store, cfg, { source: 'all', now: NOW });
  assert.equal(m.attention.length, 4); assert.equal(m.leads.length, 6); assert.equal(computeMetrics(store, cfg, { source: 'seed', now: NOW }).attention.length, 0);
  assert.ok(m.team.workload.find((w) => w.id === 'designer_1').open === 2);
});

test('dashboard API: actions persist, are seed-safe, and never expose more than a lead id and status', async () => {
  const store = new Store(null);
  const g = lead(store, { source: 'seed' }); autoAssign(cfg, store, g, NOW);
  const srv = createDashboard(cfg, { dir: null, local: true });
  // use a real dir-less store through the handler layer
  const { apiAction, apiLead, apiIcs } = await import('../src/dashboard/api.js');
  const sent = [];
  const fetchImpl = async (u) => { sent.push(String(u)); return { ok: true, json: async () => ({}) }; };
  const r = await apiAction(store, { ...cfg, env: { ...cfg.env, AANGAN_LIVE: '1', TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_DESIGNER_CHAT_ID: '1' }, mode: { ...cfg.mode } }, { action: 'assign', enquiryId: g.id, ownerId: 'designer_2', by: 'T' }, { fetchImpl, now: NOW });
  assert.equal(r.code, 200); assert.equal(sent.length, 0, 'seed/test data never reaches real Telegram, even live');
  assert.ok(store.db.outbox.some((o) => o.channel === 'telegram' && o.dryRun === true && /reassigned/i.test(o.text)));
  assert.equal((await apiAction(store, cfg, { action: 'assign', enquiryId: 'enq_x', ownerId: 'designer_2' }, { now: NOW })).code, 404);
  const L = apiLead(store, cfg, new URLSearchParams({ id: g.id })); assert.equal(L.code, 200); assert.equal(L.body.calendar, null);
  assert.equal(apiIcs(store, cfg, new URLSearchParams({ id: g.id })).code, 404);
  srv.close?.();
});

test('local dashboard server: POST /api/action works end to end over HTTP', async () => {
  const srv = createDashboard(cfg, { dir: null, local: true });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof b === 'string' ? b : JSON.stringify(b) });
  assert.equal((await post('/api/action', '{nope')).status, 400);
  assert.equal((await post('/api/action', { action: 'note', enquiryId: 'missing', text: 'x' })).status, 404);
  assert.equal((await fetch(base + '/api/lead?id=missing')).status, 404);
  const m = await (await fetch(base + '/api/metrics')).json();
  assert.ok(Array.isArray(m.leads) && Array.isArray(m.attention) && m.team.designers.length >= 1 && /^[+-]\d\d:\d\d$/.test(m.team.tzOffset));
  await new Promise((r) => srv.close(r));
});

test('the Telegram note names the designer but the AI never does (no designer names in any spoken script)', async () => {
  const { buildDesignerNote } = await import('../src/notes.js');
  const note = buildDesignerNote({ phone: '+919800000001', source: 'live', assignment: { ownerName: 'Designer 1' } }, { fields: { name: 'X' }, flags: [], summary: 's' });
  assert.match(note, /Designer: Designer 1/); assert.ok(note.split('\n')[0].startsWith('+91'), 'tap-to-call number stays first');
  const scripts = await import('../src/scripts.js');
  const blob = JSON.stringify(scripts);
  for (const d of getTeam(cfg).designers) assert.ok(!blob.includes(d.name), 'spoken scripts must not mention designers');
});

test('team PIN: with the login off, writes need DASHBOARD_TEAM_PIN (reads stay open); with no PIN set nothing changes', async () => {
  const { createHandlers } = await import('../src/dashboard/handlers.js');
  const call = async (h, fn, headers = {}, body = { action: 'note', enquiryId: 'missing', text: 'x' }) => {
    const res = { code: null, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = b; } };
    await h[fn]({ method: 'POST', headers, url: '/api/action', body }, res);
    return res;
  };
  const h = createHandlers({ env: { STORAGE_BACKEND: 'json', DASHBOARD_AUTH: 'off', DASHBOARD_TEAM_PIN: '4321' } });
  const none = await call(h, 'action'); assert.equal(none.code, 403); assert.ok(JSON.parse(none.body).pinRequired);
  assert.equal((await call(h, 'action', { 'x-team-pin': '0000' })).code, 403);
  assert.equal((await call(h, 'review', {}, { enquiryId: 'x', verdict: 'ok' })).code, 403, 'reviews are writes too');
  assert.equal((await call(h, 'action', { 'x-team-pin': '4321' })).code, 404, 'right PIN gets through to the normal "lead not found"');
  const open = createHandlers({ env: { STORAGE_BACKEND: 'json', DASHBOARD_AUTH: 'off' } });
  assert.equal((await call(open, 'action')).code, 404, 'no PIN configured: unchanged behaviour');
});

test('share out unassigned: existing Green/Escalate leads without an owner get one, evenly; owned and closed leads are untouched; workload shows an Unassigned row', async () => {
  const { autoAssignAll } = await import('../src/actions.js');
  const store = new Store(null);
  const ls = [lead(store), lead(store), lead(store), lead(store), lead(store, { tier: 'escalate' }), lead(store, { tier: 'amber' }), lead(store, { stage: 'won' })];
  ls[0].assignment = { ownerId: 'designer_3', ownerName: 'x' };
  let m = computeMetrics(store, cfg, { source: 'all', now: NOW });
  assert.equal(m.team.workload.find((w) => w.id === null).open, 5, 'three Green, the complaint and the Amber queue item; the won lead is not open');
  const r = autoAssignAll({ cfg, store, by: 'Nikhil', now: NOW });
  assert.equal(r.count, 4); assert.match(r.notify, /4 existing leads/);
  assert.equal(ls[5].assignment, undefined, 'Amber stays in the front-desk queue'); assert.equal(ls[6].assignment, undefined, 'closed leads are left alone'); assert.equal(ls[0].assignment.ownerId, 'designer_3');
  assert.equal(ls[4].assignment.ownerId, getTeam(cfg).admin.id);
  const counts = {}; for (const e of [ls[1], ls[2], ls[3]]) counts[e.assignment.ownerId] = (counts[e.assignment.ownerId] || 0) + 1;
  assert.ok(Math.max(...Object.values(counts)) <= 2, 'spread, not piled on one person');
  assert.equal(autoAssignAll({ cfg, store, now: NOW }).count, 0, 'idempotent');
});
