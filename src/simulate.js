// Text-based call simulator: drives the real engine → classifier → router with caller lines instead of audio.
import { CallEngine } from './engine.js';
import { finishCall } from './pipeline.js';
import { StubTelephony } from './telephony/adapter.js';

/**
 * Run one scripted call.
 * @param opts.turns        caller lines
 * @param opts.dropAfter    hang up (status "dropped") after this many caller lines even if the engine is not done
 */
export async function runScriptedCall({ cfg, store, provider, turns, from = null, startedAt, source = 'live', caseId = null, classifierCaseId = null, dropAfter = null, telephony = new StubTelephony(), finish = true }) {
  const engine = new CallEngine({ cfg, provider, store });
  const callIdHint = `sim_${Date.now()}`;
  const ringAt = telephony.ring({ from, callId: callIdHint });
  const { call } = engine.start({ from, startedAt, source, caseId, ringAt });
  await telephony.answer(callIdHint);
  const replies = [];
  let used = 0;
  for (const line of turns) {
    if (dropAfter != null && used >= dropAfter) break;
    const r = await engine.turn(call, line);
    used++;
    replies.push(r);
    if (r.done) break;
  }
  const dropped = dropAfter != null && used >= dropAfter && !replies.at(-1)?.done;
  engine.end(call, dropped ? 'dropped' : 'completed');
  const result = finish ? await finishCall({ cfg, store, provider, call, caseId: classifierCaseId ?? caseId }) : null;
  return { call, replies, result, telephony };
}

export const agentLines = (call) => call.turns.filter((t) => t.role === 'agent').map((t) => t.text);
