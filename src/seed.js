// Parse enquiries/phone_transcripts.md into structured seed calls. Seed data is TEST DATA ONLY:
// every record gets source="seed", obviously fake numbers, and can never reach HubSpot.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const MONTHS = { January: 0, February: 1, March: 2, April: 3, May: 4, June: 5, July: 6, August: 7, September: 8, October: 9, November: 10, December: 11 };

function parseClock(s) {
  const m = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'pm') h += 12;
  return { h, min: Number(m[2]) };
}

/** IST ISO string for a seed day/time (the seed has no year → 2026 per the file title). */
function istIso(day, month, clock) {
  const pad = (n) => String(n).padStart(2, '0');
  return `2026-${pad(month + 1)}-${pad(day)}T${pad(clock.h)}:${pad(clock.min)}:00+05:30`;
}

export function parseSeed(file = path.join(ROOT, 'enquiries', 'phone_transcripts.md')) {
  const text = fs.readFileSync(file, 'utf8');
  const parts = text.split(/^## (T\d{2}) · /m);
  const out = [];
  for (let i = 1; i < parts.length; i += 2) {
    const id = parts[i];
    const block = parts[i + 1];
    const [headerLine, ...rest] = block.split(/\r?\n/);
    const body = rest.join('\n').trim();
    const dm = headerLine.match(/(\d{1,2})\s+(\w+)\s+·\s+(\d{1,2}:\d{2}\s*[ap]m)/i);
    const clock = dm ? parseClock(dm[3]) : null;
    const startedAt = dm && clock ? istIso(Number(dm[1]), MONTHS[dm[2]], clock) : '2026-09-01T10:00:00+05:30';
    const dur = headerLine.match(/(\d+)\s*min\s*(\d+)\s*sec/);
    const durationSec = dur ? Number(dur[1]) * 60 + Number(dur[2]) : null;
    const missed = /MISSED CALL/i.test(headerLine);
    const n = Number(id.slice(1));
    out.push({
      id, source: 'seed', header: headerLine.trim(), body, startedAt, durationSec, missed,
      // Obviously fake. T17's two calls share one number so the merge logic can be tested.
      from: `+9100000${String(n).padStart(5, '0')}`,
      note: (body.match(/^Note:.*$/gm) || []).join(' '),
    });
  }
  return out;
}

/** T17 contains two calls in one entry. Split into [{startedAt, durationSec, status, text}] so merge can be tested. */
export function splitT17(seed) {
  const m = seed.body.split(/^Second call — .*$/m);
  const first = m[0].replace(/^First call — .*$/m, '').trim();
  const second = (m[1] || '').trim();
  return [
    { startedAt: '2026-09-22T14:14:00+05:30', durationSec: 72, status: 'dropped', text: first },
    { startedAt: '2026-09-22T14:16:00+05:30', durationSec: 270, status: 'completed', text: second },
  ];
}

/**
 * Convert "Front Desk: ..." / "Caller: ..." text into turn objects.
 * "Note:" lines (human annotations such as "Escalated to studio head") are deliberately NOT part of the
 * dialogue, so they cannot leak the expected answer into the model input.
 */
export function textToTurns(text) {
  const turns = [];
  let inNote = false;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(Front Desk|Caller|Agent):\s*(.*)$/);
    if (m) { inNote = false; turns.push({ role: m[1] === 'Caller' ? 'caller' : 'agent', text: m[2] }); continue; }
    if (/^(Note:|First call|Second call)/.test(line)) { inNote = true; continue; }
    if (!inNote && turns.length && line.trim()) turns[turns.length - 1].text += ' ' + line.trim();
  }
  return turns;
}
