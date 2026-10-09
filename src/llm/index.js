import { GeminiProvider } from './gemini.js';
import { RecordedProvider } from './recorded.js';
import { OfflineProvider } from './offline.js';
import { ScriptedProvider } from './scripted.js';

/** Try the primary provider; on any failure fall back to the offline heuristic provider and say so. */
export class ResilientProvider {
  constructor(primary, fallback, onFallback = () => {}) { this.primary = primary; this.fallback = fallback; this.onFallback = onFallback; this.name = `${primary.name}→${fallback.name}`; this.degraded = false; }
  async generateJson(req) {
    if (!this.degraded) {
      try { return await this.primary.generateJson(req); } catch (e) {
        if (e.status === 401 || e.status === 403) this.degraded = true; // bad key: stop hammering the API this session
        this.onFallback(e);
      }
    }
    return this.fallback.generateJson(req);
  }
}

/**
 * name: auto | gemini | recorded | offline   (config.provider.name or override)
 *  auto = Gemini when GEMINI_API_KEY exists (with offline fallback on error), else offline.
 */
export function createProvider(cfg, { name = cfg.provider.name, onFallback } = {}) {
  switch (name) {
    case 'gemini': return new GeminiProvider(cfg);
    case 'recorded': return new RecordedProvider(cfg);
    case 'offline': return new OfflineProvider(cfg);
    case 'auto':
      return cfg.env.GEMINI_API_KEY
        ? new ResilientProvider(new GeminiProvider(cfg), new OfflineProvider(cfg), onFallback)
        : new OfflineProvider(cfg);
    default: throw new Error(`unknown provider "${name}"`);
  }
}

export { GeminiProvider, RecordedProvider, OfflineProvider, ScriptedProvider };
