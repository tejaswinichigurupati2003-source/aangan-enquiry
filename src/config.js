import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './yaml.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Parse a .env file into an object. Never logs values. */
export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

let cached;
export function loadConfig(opts = {}) {
  const { root = ROOT, env = process.env, fresh = false } = opts;
  if (cached && !fresh) return cached;
  const cfg = parseYaml(fs.readFileSync(path.join(root, 'config.yaml'), 'utf8'));
  let fileEnv = {};
  const envPath = path.join(root, '.env');
  // A caller that supplies its own `env` (tests, embedding) gets exactly that: the real .env is NOT read, so tests are hermetic.
  if (opts.env === undefined && fs.existsSync(envPath)) fileEnv = parseEnv(fs.readFileSync(envPath, 'utf8'));
  const merged = { ...fileEnv, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) };
  cfg.env = merged;
  cfg.root = root;
  cached = cfg;
  return cfg;
}

/**
 * Live gating. Everything is DRY-RUN unless config.mode.dry_run is false OR AANGAN_LIVE=1,
 * AND the specific credentials for that integration exist.
 */
export function isLive(cfg, requiredEnvKeys = []) {
  const flag = cfg.env.AANGAN_LIVE === '1' || cfg.mode?.dry_run === false;
  return Boolean(flag && requiredEnvKeys.every((k) => cfg.env[k]));
}

export const dataDir = (cfg) => cfg.env.AANGAN_DATA_DIR || path.join(cfg.root, 'data', 'runtime');
