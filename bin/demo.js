#!/usr/bin/env node
// Populate data/demo with a full simulated run: T01–T20 (source=seed) + the extra conversation scenarios, all DRY-RUN,
// then print the report. Designer pickup times are SIMULATED (a deterministic pseudo-random delay) and labelled as such.
//   node bin/demo.js [--provider recorded]      then:  node bin/dashboard.js --dir data/demo
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, forceDryRun, ROOT } from '../src/config.js';
import { createProvider } from '../src/llm/index.js';
import { Store } from '../src/store.js';
import { parseSeed } from '../src/seed.js';
import { runSeedCall, runScenario, loadScenarios } from '../evals/runner.js';
import { recordAck } from '../src/integrations/telegram.js';
import { computeMetrics } from '../src/metrics.js';
import { renderReport } from '../src/dashboard/report.js';

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const cfg = forceDryRun(loadConfig({ fresh: true })); // fake callers: never send anything real
const provider = createProvider(cfg, { name: opt('provider', 'recorded') });
const dir = path.join(ROOT, 'data', 'demo');
fs.rmSync(dir, { recursive: true, force: true });
const store = new Store(dir);

for (const seed of parseSeed()) await runSeedCall({ cfg, store, provider, seed });
for (const scenario of loadScenarios()) await runScenario({ cfg, provider, scenario, store });

// Simulated designer pickup: deterministic delays (xorshift) so the demo is repeatable. NOT real data.
let x = 2463534242;
const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
for (const e of store.db.enquiries.filter((q) => q.tier === 'green' && q.handoff.telegramSentAt)) {
  if (rnd() < 0.85) recordAck(store, e.id, new Date(new Date(e.handoff.telegramSentAt).getTime() + (2 + rnd() * 40) * 60000));
}
store.event('demo_simulated_pickup', { note: 'designer pickup times in this dataset are simulated' });
store.save();

console.log(renderReport(computeMetrics(store, cfg, { source: 'all' })));
console.log('\nSaved to data/demo. View it:  node bin/dashboard.js --dir data/demo');
