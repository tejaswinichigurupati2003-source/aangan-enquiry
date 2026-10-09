import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { evaluate, validateExtraction, judgeTimeline } from '../src/rules.js';

const cfg = loadConfig();

/** Build an extraction that passes everything, then override. */
function mk(over = {}) {
  const base = {
    interaction: { kind: 'conversation', usable_details: true },
    existing_client_complaint: { is: false },
    criteria: {
      real_project: { verdict: 'pass', evidence: 'wants full redesign with execution' },
      service_area: { verdict: 'pass', evidence: 'Baner' },
      timeline: { mentioned: true, urgency_cue: false, completion_in_weeks: 20, flexible: null, evidence: '' },
      budget: { volunteered: false, assessment: 'plausible', evidence: '' },
      decision_maker: { verdict: 'pass', evidence: 'owner' },
    },
    fields: { property_type: 'apartment', carpet_area_sqft: 1000 },
    flags: [],
    reason: '',
  };
  const merged = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (k === 'criteria') for (const [ck, cv] of Object.entries(v)) merged.criteria[ck] = { ...merged.criteria[ck], ...cv };
    else merged[k] = v;
  }
  return merged;
}

test('green: passes all five', () => {
  const r = evaluate(mk(), cfg);
  assert.equal(r.tier, 'green');
});

test('green: unclear only on budget and decision-maker is forwarded with flags', () => {
  const r = evaluate(mk({ criteria: { budget: { assessment: 'not_mentioned' }, decision_maker: { verdict: 'unclear' } } }), cfg);
  assert.equal(r.tier, 'green');
  assert.ok(r.flags.includes('budget_not_discussed'));
  assert.ok(r.flags.includes('decision_maker_unclear'));
});

test('timeline: not discussed = soft pass with flag; urgent-but-unplaceable = amber', () => {
  assert.equal(judgeTimeline({ mentioned: false, urgency_cue: false }, cfg).flag, 'timeline_not_confirmed');
  const r = evaluate(mk({ criteria: { timeline: { mentioned: true, urgency_cue: true, completion_in_weeks: null } } }), cfg);
  assert.equal(r.tier, 'amber');
});

test('timeline thresholds: <8 weeks fails, 8-10 tight pass, >10 pass', () => {
  assert.equal(judgeTimeline({ mentioned: true, urgency_cue: false, completion_in_weeks: 3 }, cfg).verdict, 'fail');
  assert.equal(judgeTimeline({ mentioned: true, urgency_cue: false, completion_in_weeks: 7.9 }, cfg).verdict, 'fail');
  const tight = judgeTimeline({ mentioned: true, urgency_cue: false, completion_in_weeks: 8.4 }, cfg);
  assert.equal(tight.verdict, 'pass'); assert.equal(tight.flag, 'timeline_tight');
  assert.equal(judgeTimeline({ mentioned: true, urgency_cue: false, completion_in_weeks: 10 }, cfg).flag, undefined);
});

test('timeline failure alone is Amber, never Red', () => {
  const r = evaluate(mk({ criteria: { timeline: { completion_in_weeks: 3 } } }), cfg);
  assert.equal(r.tier, 'amber');
  assert.equal(r.next_question, 'timeline');
});

test('timeline failure plus another failure is Red with the other reason', () => {
  const r = evaluate(mk({ criteria: { timeline: { completion_in_weeks: 3 }, service_area: { verdict: 'fail' } } }), cfg);
  assert.equal(r.tier, 'red');
  assert.equal(r.red_reason, 'out_of_area');
});

test('red reasons map correctly', () => {
  assert.equal(evaluate(mk({ criteria: { service_area: { verdict: 'fail' } } }), cfg).red_reason, 'out_of_area');
  assert.equal(evaluate(mk({ criteria: { real_project: { verdict: 'fail', fail_reason: 'advice_only' } } }), cfg).red_reason, 'advice_only');
  assert.equal(evaluate(mk({ criteria: { real_project: { verdict: 'fail', fail_reason: 'out_of_scope_type' } } }), cfg).red_reason, 'out_of_scope_type');
  assert.equal(evaluate(mk({ criteria: { real_project: { verdict: 'fail', fail_reason: 'decor_or_sourcing_only' } } }), cfg).red_reason, 'decor_or_sourcing_only');
  assert.equal(evaluate(mk({ criteria: { budget: { assessment: 'far_below_scope' } } }), cfg).red_reason, 'budget_below_scope');
});

test('unclear on criteria 1-3 is amber with the question to ask', () => {
  const r = evaluate(mk({ criteria: { service_area: { verdict: 'unclear' } } }), cfg);
  assert.equal(r.tier, 'amber');
  assert.equal(r.next_question, 'service_area');
});

test('no usable details / missed call is amber', () => {
  const r = evaluate(mk({ interaction: { kind: 'missed_call', usable_details: false } }), cfg);
  assert.equal(r.tier, 'amber');
});

test('existing-client complaint escalates, even if everything else looks like a lead', () => {
  const r = evaluate(mk({ existing_client_complaint: { is: true } }), cfg);
  assert.equal(r.tier, 'escalate');
});

test('commercial under the 500 flag adds a flag but is NOT enforced', () => {
  const r = evaluate(mk({ fields: { property_type: 'commercial coworking pod', carpet_area_sqft: 180 } }), cfg);
  assert.equal(r.tier, 'green');
  assert.ok(r.flags.includes('commercial_min_unconfirmed'));
});

test('invalid extraction is rejected, unknown flags dropped', () => {
  assert.throws(() => validateExtraction({}), /invalid|must/);
  const ok = validateExtraction(mk({ flags: ['timeline_tight', 'made_up_flag'] }));
  assert.deepEqual(ok.flags, ['timeline_tight']);
  assert.throws(() => validateExtraction(mk({ criteria: { real_project: { verdict: 'fail', fail_reason: null } } })), /fail_reason/);
});
