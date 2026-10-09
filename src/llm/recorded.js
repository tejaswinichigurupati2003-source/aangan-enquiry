import fs from 'node:fs';
import path from 'node:path';
import { LlmError } from './gemini.js';

export const estimateTokens = (text, charsPerToken = 4) => Math.ceil(String(text ?? '').length / charsPerToken);

/**
 * Replays recorded model outputs (fixtures/). Used for evals when no live model key is available.
 *   classifier   → fixtures/extractions/<caseId>.json
 *   conversation → fixtures/conversations/<caseId>.json  (array, one entry per caller turn, ctx.turn)
 * Token usage is ESTIMATED from text length and labelled as such.
 */
export class RecordedProvider {
  constructor(cfg, { dir = path.join(cfg.root, 'fixtures') } = {}) {
    this.name = 'recorded'; this.cfg = cfg; this.dir = dir;
  }

  async generateJson({ system, messages, kind, ctx = {}, model }) {
    const id = ctx.caseId;
    if (!id) throw new LlmError('recorded provider needs ctx.caseId');
    const file = path.join(this.dir, kind === 'classifier' ? 'extractions' : 'conversations', `${id}.json`);
    if (!fs.existsSync(file)) throw new LlmError(`no recorded fixture: ${path.relative(this.cfg.root, file)}`);
    let json = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (kind !== 'classifier') {
      json = json[ctx.turn ?? 0];
      if (!json) throw new LlmError(`recorded conversation ${id} has no turn ${ctx.turn}`);
    }
    const cpt = this.cfg.cost_assumptions.chars_per_token;
    const inChars = system.length + messages.map((m) => m.text).join('').length;
    return {
      json, provider: 'recorded', model,
      usage: { inputTokens: Math.ceil(inChars / cpt), outputTokens: estimateTokens(JSON.stringify(json), cpt), estimated: true },
    };
  }
}
