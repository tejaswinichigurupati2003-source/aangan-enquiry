#!/usr/bin/env node
// Usage:
//   node bin/eval.js                       T01–T20 + scenarios with recorded model outputs (no API needed)
//   node bin/eval.js --provider gemini     same, against the live Gemini model (needs a valid GEMINI_API_KEY)
//   node bin/eval.js --dump-inputs         write evals/inputs/T##.txt (exact classifier input per seed)
//   node bin/eval.js --only T03,S1_price_pushed_3x
//   node bin/eval.js --write-report        also write EVAL_RESULTS.md
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, forceDryRun, ROOT } from '../src/config.js';
import { createProvider } from '../src/llm/index.js';
import { runSeedEval, runScenarioEval, dumpInputs, dumpScenarioInputs } from '../evals/runner.js';

const args = process.argv.slice(2);
const opt = (name, def = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1]?.startsWith('--') || args[i + 1] == null ? true : args[i + 1]) : def; };
const cfg = forceDryRun(loadConfig({ fresh: true })); // fake callers: never send anything real
const providerName = opt('provider', 'recorded');
const only = opt('only') ? String(opt('only')).split(',') : null;

if (opt('dump-inputs')) {
  const files = await dumpInputs({ cfg });
  console.log(`wrote ${files.length} classifier inputs to evals/inputs/`);
  process.exit(0);
}

if (opt("dump-scenario-inputs")) {
  console.log("wrote classifier inputs for:", (await dumpScenarioInputs({ cfg })).join(", "));
  process.exit(0);
}

const provider = createProvider(cfg, { name: providerName });
const seed = await runSeedEval({ cfg, provider, only });
const scen = await runScenarioEval({ cfg, provider, only });

const pad = (s, n) => String(s ?? '').padEnd(n);
const mark = (ok) => (ok ? 'PASS' : 'FAIL');
console.log(`\nProvider for model judgements: ${provider.name}${providerName === 'recorded' ? '  (recorded outputs; rules, guard, routing and merge run live)' : ''}`);
console.log('\n=== T01–T20 (seed transcripts, dry-run, source=seed) ===');
console.log(`${pad('ID', 5)}${pad('Expected', 10)}${pad('Actual', 10)}${pad('Result', 7)}Notes`);
for (const r of seed.results) {
  console.log(`${pad(r.id, 5)}${pad(r.expected, 10)}${pad(r.actual, 10)}${pad(mark(r.ok), 7)}${r.ok ? (r.red_reason ?? '') + (r.flags.length ? ` [${r.flags.join(', ')}]` : '') : r.problems.join('; ')}`);
}
const seedPass = seed.results.filter((r) => r.ok).length;
console.log(`\nSeed: ${seedPass}/${seed.results.length} passed. HubSpot outbox entries from seed data: ${seed.hubspotLeaks} (must be 0).`);

console.log('\n=== Extra scenarios ===');
for (const s of scen) {
  console.log(`${mark(s.ok)}  ${s.id}${s.tier ? `  → ${s.tier}` : ''}`);
  for (const c of s.checks.filter((c) => !c.ok)) console.log(`        ✗ ${c.check}${c.detail ? ` — ${c.detail}` : ''}`);
}
const scenPass = scen.filter((s) => s.ok).length;
console.log(`\nScenarios: ${scenPass}/${scen.length} passed.`);

const allOk = seed.results.every((r) => r.ok) && seed.hubspotLeaks === 0 && scen.every((s) => s.ok);

if (opt('write-report')) {
  const md = [
    '# EVAL RESULTS', '', `Generated: ${new Date().toISOString()}  ·  model judgements from: **${provider.name}**`, '',
    providerName === 'recorded' ? '> Model outputs were recorded (produced blind by Claude subagents from `prompts/*.md` and the exact model input, because the supplied Gemini key was rejected). Rules, guard, overrides, routing, merge and cost run live. Re-run with `npm run eval -- --provider gemini` once a valid key is in `.env`.' : '', '',
    '## T01–T20', '', '| ID | Expected | Actual | Result | Red reason | Flags | Why |', '|---|---|---|---|---|---|---|',
    ...seed.results.map((r) => `| ${r.id} | ${r.expected} | ${r.actual} | ${mark(r.ok)} | ${r.red_reason ?? ''} | ${r.flags.join(', ')} | ${(r.ok ? r.reason : r.problems.join('; ')).replace(/\|/g, '/')} |`),
    '', `HubSpot outbox entries produced from seed data: **${seed.hubspotLeaks}** (must be 0).`, '',
    '## Extra scenarios', '', '| Scenario | Result | Tier | Failed checks |', '|---|---|---|---|',
    ...scen.map((s) => `| ${s.id} | ${mark(s.ok)} | ${s.tier ?? ''} | ${s.checks.filter((c) => !c.ok).map((c) => c.check).join('; ')} |`),
    '', '### Scenario assertions', '',
    ...scen.flatMap((s) => [`**${s.id}** — ${s.description}`, ...s.checks.map((c) => `- ${c.ok ? '✅' : '❌'} ${c.check}${c.detail && !c.ok ? ` — ${c.detail}` : ''}`), '']),
  ].join('\n');
  const reportFile = providerName === 'recorded' ? 'EVAL_RESULTS.md' : `EVAL_RESULTS_${provider.name}.md`;
  fs.writeFileSync(path.join(ROOT, reportFile), md);
  fs.mkdirSync(path.join(ROOT, 'evals', 'results'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'evals', 'results', `latest-${provider.name}.json`), JSON.stringify({ seed: seed.results, scenarios: scen.map(({ transcript, ...s }) => s) }, null, 2));
  console.log(`\nwrote ${reportFile}`);
}
process.exit(allOk ? 0 : 1);
