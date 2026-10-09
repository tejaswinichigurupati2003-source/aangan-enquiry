import fs from 'node:fs';
import path from 'node:path';

const cache = new Map();

/** Load a versioned runtime prompt: prompts/<name>.<version>.md (version from config.prompts). */
export function loadPrompt(cfg, name) {
  const version = cfg.prompts[name];
  const file = path.join(cfg.root, 'prompts', `${name}.${version}.md`);
  if (!cache.has(file)) cache.set(file, fs.readFileSync(file, 'utf8'));
  return { text: cache.get(file), version, id: `${name}.${version}` };
}
