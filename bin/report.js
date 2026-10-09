#!/usr/bin/env node
// node bin/report.js [--source all|live|seed] [--dir data/demo]
import path from 'node:path';
import { loadConfig, dataDir, ROOT } from '../src/config.js';
import { Store } from '../src/store.js';
import { computeMetrics } from '../src/metrics.js';
import { renderReport } from '../src/dashboard/report.js';

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const cfg = loadConfig({ fresh: true });
const dir = opt('dir') ? path.resolve(ROOT, opt('dir')) : dataDir(cfg);
console.log(renderReport(computeMetrics(new Store(dir), cfg, { source: opt('source', 'all') })));
