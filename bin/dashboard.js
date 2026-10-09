#!/usr/bin/env node
// node bin/dashboard.js [--port 4177] [--dir data/demo]   → http://127.0.0.1:4177  (local only)
import path from 'node:path';
import { loadConfig, dataDir, ROOT } from '../src/config.js';
import { createDashboard } from '../src/dashboard/server.js';

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const cfg = loadConfig({ fresh: true });
const dir = opt('dir') ? path.resolve(ROOT, opt('dir')) : dataDir(cfg);
const port = Number(opt('port', 4177));
createDashboard(cfg, { dir, local: Boolean(opt('dir')) }).listen(port, '127.0.0.1', () => {
  console.log(`Dashboard: http://127.0.0.1:${port}   (data: ${path.relative(ROOT, dir) || dir})  — Ctrl+C to stop`);
});
