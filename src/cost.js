// Cost per call = model tokens + speech-to-text + text-to-speech + telephony minutes + hosting share.
// EVERY unit price comes from config.yaml and is an ESTIMATE. Nothing is hard-coded here.

export function modelCostInr(cfg, model, inTokens, outTokens) {
  const table = cfg.costs.model_usd_per_million_tokens;
  const p = table[model] || table.default;
  const usd = (inTokens / 1e6) * p.input + (outTokens / 1e6) * p.output;
  return usd * cfg.cost_assumptions.usd_to_inr;
}

/** Spoken characters → seconds (used when a simulated call has no real audio duration). */
export const speechSeconds = (cfg, chars) => chars / cfg.cost_assumptions.speech_chars_per_second;

/**
 * Model what an AI-handled call would use when the call itself was human-handled (seed transcripts) or
 * recorded: one conversation turn per caller utterance, each re-sending the system prompt + history.
 * Flagged `modelled: true` everywhere it is shown.
 */
export function modelConversationUsage(cfg, turns, systemChars, { outTokensPerTurn = 140 } = {}) {
  const cpt = cfg.cost_assumptions.chars_per_token;
  let history = 0; let inTok = 0; let outTok = 0; let n = 0;
  for (const t of turns) {
    history += t.text.length;
    if (t.role === 'caller') {
      inTok += Math.ceil((systemChars + history) / cpt) + 120; // + per-turn STATE block
      outTok += outTokensPerTurn; n++;
    }
  }
  return { in: inTok, out: outTok, n, estimated: true, modelled: true };
}

export function callCost(cfg, call) {
  const c = cfg.costs;
  const fx = cfg.cost_assumptions.usd_to_inr;
  const u = call.usage || {};
  const conv = u.conversation || { in: 0, out: 0 };
  const cls = u.classifier || { in: 0, out: 0 };
  const model = modelCostInr(cfg, cfg.provider.conversation_model, conv.in, conv.out)
    + modelCostInr(cfg, cfg.provider.classifier_model, cls.in, cls.out);

  const seconds = call.durationSec ?? 0;
  const minutes = seconds / 60;
  const agentChars = (call.turns || []).filter((t) => t.role === 'agent').reduce((a, t) => a + t.text.length, 0);
  const stt = minutes * c.stt_usd_per_minute * fx;
  const tts = (agentChars / 1e6) * c.tts_usd_per_million_chars * fx;
  const telephony = call.status === 'missed' ? 0 : Math.ceil(minutes) * c.telephony_inr_per_minute; // providers bill per started minute
  const hosting = c.hosting_inr_per_month / cfg.cost_assumptions.expected_calls_per_month;
  const total = model + stt + tts + telephony + hosting;
  const r = (x) => Math.round(x * 100) / 100;
  return { model: r(model), stt: r(stt), tts: r(tts), telephony: r(telephony), hosting: r(hosting), total: r(total), currency: cfg.cost_assumptions.currency };
}
