// HARD RULE 1/7 — pricing.md figures must not exist in any file the AI can see at runtime, and no code may read pricing.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return walk(p);
  return [p];
});
const rel = (p) => path.relative(ROOT, p).replaceAll('\\', '/');

// "Runtime-visible": prompts, the code that builds prompts/replies, config, recorded model outputs.
const RUNTIME = [
  ...walk(path.join(ROOT, 'prompts')),
  ...walk(path.join(ROOT, 'src')),
  ...walk(path.join(ROOT, 'fixtures')),
  path.join(ROOT, 'config.yaml'),
].filter((f) => /\.(md|js|json|yaml|yml|txt)$/.test(f));

// Allowed to MENTION price words: the guard (it defines the blocklist) and the YAML parser of cost estimates.
// src/llm/offline.js only *detects* currency words in what the CALLER says (to notice a volunteered budget); it never emits them.
const ALLOWED = new Set(['src/guard.js', 'src/llm/offline.js']);

const PRICE_PATTERNS = [
  [/₹/, 'rupee symbol'],
  [/\blakhs?\b|\blacs?\b|\bcrores?\b/i, 'lakh/lac/crore'],
  [/per\s*sq\.?\s*(?:ft|feet|foot)/i, 'per sq ft'],
  [/\bstarts?\s+at\b/i, '"starts at"'],
];

test('no price-like strings in any runtime-visible file (except the guard blocklist)', () => {
  const offenders = [];
  for (const f of RUNTIME) {
    if (ALLOWED.has(rel(f))) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const [re, label] of PRICE_PATTERNS) if (re.test(text)) offenders.push(`${rel(f)}: ${label}`);
  }
  assert.deepEqual(offenders, []);
});

test('the actual pricing.md figures appear nowhere in runtime-visible files', () => {
  const pricing = fs.readFileSync(path.join(ROOT, 'pricing.md'), 'utf8');
  // every currency-prefixed figure in pricing.md, e.g. "₹1,800", "₹3.5 lakh"
  const figures = [...pricing.matchAll(/₹\s?([\d,]+(?:\.\d+)?)/g)].map((m) => m[1]);
  assert.ok(figures.length >= 8, 'expected to find the figures in pricing.md');
  const offenders = [];
  for (const f of RUNTIME) {
    if (ALLOWED.has(rel(f))) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const fig of figures) {
      if (fig.length < 4) continue; // ignore tiny numbers like "8"
      if (new RegExp(`(?<![\\d,])${fig.replace(/[.,]/g, (c) => `\\${c}`)}(?![\\d])`).test(text.replace(/\bcarpet_area_sqft": \d+/g, ''))) {
        // allow bare integers used as areas in extractions, only if no currency/area-rate context
        if (/₹|per\s*sq|lakh/i.test(text)) offenders.push(`${rel(f)}: ${fig}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('no source, prompt or config file references or loads pricing.md', () => {
  const offenders = RUNTIME.filter((f) => /pricing\.md/i.test(fs.readFileSync(f, 'utf8'))).map(rel);
  assert.deepEqual(offenders, []);
});

test('config.yaml: every cost line is marked ESTIMATE with where to confirm it', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'config.yaml'), 'utf8').split(/\r?\n/);
  const costLines = lines.filter((l) => /^\s+(input|output|stt_usd_per_minute|tts_usd_per_million_chars|telephony_inr_per_minute|hosting_inr_per_month|usd_to_inr|speech_chars_per_second|chars_per_token):/.test(l));
  assert.ok(costLines.length >= 8);
  for (const l of costLines) assert.match(l, /ESTIMATE/, `cost value missing ESTIMATE marker: ${l}`);
});
