import { estimateTokens } from './recorded.js';

/**
 * Provider driven by a function — for tests and adversarial evals, e.g. a "rogue" model that
 * ALWAYS quotes prices, to prove the code-side guard holds whatever the model does.
 */
export class ScriptedProvider {
  constructor(fn, { name = 'scripted' } = {}) { this.name = name; this.fn = fn; }
  async generateJson(req) {
    const json = await this.fn(req);
    return { json, provider: this.name, model: 'scripted', usage: { inputTokens: estimateTokens(req.system) , outputTokens: estimateTokens(JSON.stringify(json)), estimated: true } };
  }
}
