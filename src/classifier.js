// Classifier: call transcript(s) in → structured JSON out (tier, five criteria, flags, reason, fields).
// The model returns facts + verdicts; src/rules.js decides the tier. Any failure → Amber `classifier_error`
// (a lead is never dropped, and never auto-pushed anywhere on a failure).
import { evaluate, validateExtraction } from './rules.js';
import { loadPrompt } from './prompts.js';

const wordCount = (s) => (String(s).match(/\S+/g) || []).length;

export function callerWords(calls) {
  return calls.reduce((n, c) => n + c.turns.filter((t) => t.role === 'caller').reduce((m, t) => m + wordCount(t.text), 0), 0);
}

const IST = 'Asia/Kolkata';
export function istParts(iso, tz = IST) {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return { date, time };
}

export function isAfterHours(cfg, iso) {
  const { time } = istParts(iso, cfg.studio.timezone);
  return time < cfg.studio.office_hours_start || time >= cfg.studio.office_hours_end;
}

/** What the model sees for one enquiry (also written to evals/inputs/ so recorded outputs are produced from the same text). */
export function buildClassifierInput(cfg, calls, transcript) {
  const first = calls[0];
  const { date, time } = istParts(first.startedAt, cfg.studio.timezone);
  return [
    `CALL DATE: ${date}`,
    `CALL TIME (IST): ${time}`,
    `OFFICE HOURS: ${cfg.studio.office_hours_start}-${cfg.studio.office_hours_end}`,
    `CALLS IN THIS RECORD: ${calls.length}`,
    '',
    'TRANSCRIPT:',
    transcript,
  ].join('\n');
}

function deterministicNoDetails(kind) {
  return {
    interaction: { kind, usable_details: false },
    existing_client_complaint: { is: false, evidence: '' },
    criteria: {
      real_project: { verdict: 'unclear', fail_reason: null, evidence: 'nothing captured' },
      service_area: { verdict: 'unclear', evidence: 'nothing captured' },
      timeline: { mentioned: false, urgency_cue: false, completion_in_weeks: null, flexible: null, evidence: '' },
      budget: { volunteered: false, assessment: 'not_mentioned', evidence: '' },
      decision_maker: { verdict: 'unclear', evidence: '' },
    },
    fields: {}, flags: [],
    summary: kind === 'missed_call' ? 'Missed call, no message left — call back.' : 'Call dropped before any details were captured — call back.',
    reason: 'no usable details were captured',
  };
}

/**
 * @returns {Promise<{classification: object, usage: {in:number,out:number,estimated:boolean}|null}>}
 */
export async function classifyEnquiry({ cfg, provider, store, enquiry, caseId, onEvent = () => {} }) {
  const calls = enquiry.callIds.map((id) => store.getCall(id)).filter(Boolean)
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  const transcript = store.combinedTranscript(enquiry);
  const prompt = loadPrompt(cfg, 'classifier');

  const codeFlags = new Set();
  if (calls.some((c) => isAfterHours(cfg, c.startedAt))) codeFlags.add('after_hours');
  if (calls.length > 1) codeFlags.add('repeat_caller');
  if (calls.some((c) => c.status === 'missed')) codeFlags.add('missed_call');
  if (calls.some((c) => c.status === 'dropped')) codeFlags.add('dropped_call');
  // engine-observed behaviour is trustworthy even if the model forgets it
  for (const c of calls) for (const f of c.engineFlags || []) codeFlags.add(f);

  const meta = { provider: provider.name, promptVersion: prompt.id, model: cfg.provider.classifier_model };
  const finish = (extraction, usage, source = 'model') => {
    const merged = { ...extraction, flags: [...new Set([...(extraction.flags || []), ...codeFlags])] };
    const result = evaluate(merged, cfg);
    return {
      classification: {
        ...result, fields: validateExtraction(merged).fields, summary: merged.summary, reason: merged.reason,
        interaction: merged.interaction, evidence: Object.fromEntries(Object.entries(merged.criteria).map(([k, v]) => [k, v.evidence || ''])),
        source, ...meta, classifiedAt: new Date().toISOString(),
      },
      usage,
    };
  };

  // No caller content at all → no model call needed (and nothing to leak).
  const missed = calls.every((c) => c.status === 'missed');
  if (missed) return finish(deterministicNoDetails('missed_call'), null, 'rule');
  // a call that dropped (or was silent) before anything substantive was said needs no model call
  const thin = (c) => callerWords([c]) < (c.status === 'dropped' ? 15 : 4);
  if (calls.every(thin)) return finish(deterministicNoDetails('dropped_call'), null, 'rule');

  const messages = [{ role: 'user', text: buildClassifierInput(cfg, calls, transcript) }];
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await provider.generateJson({
        kind: 'classifier', system: prompt.text, messages, model: cfg.provider.classifier_model,
        temperature: cfg.provider.temperature_classifier, ctx: { caseId },
      });
      const extraction = validateExtraction(res.json);
      return finish(extraction, { in: res.usage.inputTokens, out: res.usage.outputTokens, estimated: res.usage.estimated });
    } catch (e) {
      lastErr = e;
      onEvent('classifier_retry', { attempt, error: e.message });
    }
  }
  // Fail-safe: Amber for a human to look at; flagged so the dashboard surfaces it.
  onEvent('classifier_error', { error: lastErr?.message });
  const fallback = deterministicNoDetails('conversation');
  fallback.interaction.usable_details = true;
  fallback.criteria.real_project.verdict = 'unclear';
  fallback.summary = 'Automatic classification failed — front desk to review the transcript.';
  fallback.reason = `classifier error: ${lastErr?.message}`;
  fallback.flags = ['classifier_error'];
  const out = finish(fallback, null, 'error');
  out.classification.tier = 'amber';
  out.classification.reasons = [`classifier error — needs a human look (${lastErr?.message})`];
  out.classification.red_reason = null;
  out.classification.flags = [...new Set([...out.classification.flags, 'classifier_error'])];
  return out;
}
