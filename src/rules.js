// Tier rules (qualified.md + CLAUDE.md). The model supplies facts and verdicts; THIS file decides the tier.
// No transcript-specific logic lives here — only the rubric.

export const FLAGS = [
  'timeline_tight', 'timeline_not_confirmed', 'budget_not_discussed', 'decision_maker_unclear',
  'caller_is_proxy', 'prior_enquiry_dropped', 'caller_frustrated', 'repeat_caller',
  'referral_past_client', 'referral_vip', 'commercial_min_unconfirmed', 'rented_property',
  'commercial_project', 'hinglish_caller', 'injection_attempt', 'asked_for_price',
  'pushed_for_price', 'asked_if_bot', 'asked_for_discount', 'after_hours', 'classifier_error',
  'site_not_yet_possessed', 'noisy_line', 'missed_call', 'dropped_call', 'budget_volunteered',
];

export const FAIL_REASONS = ['advice_only', 'decor_or_sourcing_only', 'out_of_scope_type', 'structural_work'];
export const RED_REASONS = ['out_of_area', 'advice_only', 'out_of_scope_type', 'decor_or_sourcing_only', 'budget_below_scope'];

const VERDICTS = ['pass', 'fail', 'unclear'];
const BUDGET = ['far_below_scope', 'plausible', 'not_mentioned'];
const KINDS = ['conversation', 'missed_call', 'dropped_call', 'noise'];

/** Validate and normalise a classifier/assessment object. Throws Error(list of problems). */
export function validateExtraction(x) {
  const errs = [];
  const need = (cond, msg) => { if (!cond) errs.push(msg); };
  need(x && typeof x === 'object', 'extraction must be an object');
  if (errs.length) throw new Error(errs.join('; '));
  const c = x.criteria || {};
  need(KINDS.includes(x.interaction?.kind), 'interaction.kind invalid');
  need(typeof x.interaction?.usable_details === 'boolean', 'interaction.usable_details must be boolean');
  need(typeof x.existing_client_complaint?.is === 'boolean', 'existing_client_complaint.is must be boolean');
  need(VERDICTS.includes(c.real_project?.verdict), 'criteria.real_project.verdict invalid');
  need(c.real_project?.verdict !== 'fail' || FAIL_REASONS.includes(c.real_project?.fail_reason), 'real_project.fail_reason required when fail');
  need(VERDICTS.includes(c.service_area?.verdict), 'criteria.service_area.verdict invalid');
  need(typeof c.timeline?.mentioned === 'boolean', 'timeline.mentioned must be boolean');
  need(typeof c.timeline?.urgency_cue === 'boolean', 'timeline.urgency_cue must be boolean');
  need(c.timeline?.completion_in_weeks == null || typeof c.timeline.completion_in_weeks === 'number', 'timeline.completion_in_weeks must be number|null');
  need(BUDGET.includes(c.budget?.assessment), 'budget.assessment invalid');
  need(['pass', 'unclear'].includes(c.decision_maker?.verdict), 'decision_maker.verdict must be pass|unclear');
  need(Array.isArray(x.flags ?? []), 'flags must be an array');
  if (errs.length) throw new Error(errs.join('; '));
  return { ...x, flags: (x.flags ?? []).filter((f) => FLAGS.includes(f)), fields: x.fields ?? {} };
}

/**
 * Judge the timeline criterion.
 * @returns {{verdict:'pass'|'fail'|'unclear', flag?:string, note:string}}
 */
export function judgeTimeline(t, cfg) {
  const min = cfg.rules.lead_time_min_weeks;
  const comfy = cfg.rules.lead_time_comfortable_weeks;
  if (t.completion_in_weeks != null) {
    if (t.completion_in_weeks < min) return { verdict: 'fail', note: 'required completion is sooner than our minimum lead time' };
    if (t.completion_in_weeks < comfy) return { verdict: 'pass', flag: 'timeline_tight', note: 'lead time is at the tight end' };
    return { verdict: 'pass', note: 'lead time is comfortable' };
  }
  if (t.urgency_cue) return { verdict: 'unclear', note: 'urgent or vague timeline that cannot be placed' };
  if (!t.mentioned) return { verdict: 'pass', flag: 'timeline_not_confirmed', note: 'timeline not discussed, no urgency signal' };
  return { verdict: 'pass', note: 'timeline stated, no completion deadline that conflicts' };
}

/** Turn an extraction into the five verdicts + flags. */
export function deriveCriteria(x, cfg) {
  const c = x.criteria;
  const flags = new Set(x.flags || []);
  const tl = judgeTimeline(c.timeline, cfg);
  if (tl.flag) flags.add(tl.flag);

  let budgetVerdict;
  if (c.budget.assessment === 'far_below_scope') budgetVerdict = 'fail';
  else if (c.budget.assessment === 'plausible') budgetVerdict = 'pass';
  else { budgetVerdict = 'unclear'; flags.add('budget_not_discussed'); }

  const dm = c.decision_maker.verdict;
  if (dm === 'unclear') flags.add('decision_maker_unclear');

  const f = x.fields || {};
  const isCommercial = /commercial|office|clinic|studio|coworking/i.test(f.property_type || '');
  if (isCommercial) {
    flags.add('commercial_project');
    const area = Number(f.carpet_area_sqft);
    if (area && area < cfg.rules.commercial_min_sqft_flag) flags.add('commercial_min_unconfirmed');
  }

  return {
    verdicts: {
      real_project: c.real_project.verdict,
      service_area: c.service_area.verdict,
      timeline: tl.verdict,
      budget: budgetVerdict,
      decision_maker: dm,
    },
    timelineNote: tl.note,
    flags: [...flags],
  };
}

/**
 * Main entry. @returns {{tier, reasons:string[], red_reason:string|null, verdicts, flags, next_question:string|null}}
 */
export function evaluate(rawExtraction, cfg) {
  const x = validateExtraction(rawExtraction);
  const { verdicts, flags, timelineNote } = deriveCriteria(x, cfg);
  const out = (tier, reasons, extra = {}) => ({ tier, reasons, red_reason: null, verdicts, flags, next_question: null, ...extra });

  if (x.existing_client_complaint.is) {
    return out('escalate', ['existing client complaint — not a lead, page the studio head']);
  }
  if (!x.interaction.usable_details || (verdicts.real_project === 'unclear' && verdicts.service_area === 'unclear')) {
    return out('amber', ['no usable details (missed, dropped or empty call) — front desk to call back'], { next_question: 'callback' });
  }

  // Hard failures (single clear failure is enough to decline — qualified.md).
  const hard = [];
  if (verdicts.service_area === 'fail') hard.push('out_of_area');
  if (verdicts.real_project === 'fail') {
    const fr = x.criteria.real_project.fail_reason;
    hard.push(fr === 'structural_work' ? 'out_of_scope_type' : fr);
  }
  if (verdicts.budget === 'fail') hard.push('budget_below_scope');

  if (hard.length) {
    const priority = ['out_of_area', 'out_of_scope_type', 'advice_only', 'decor_or_sourcing_only', 'budget_below_scope'];
    const reason = priority.find((r) => hard.includes(r)) || hard[0];
    const reasons = [`fails ${hard.length > 1 ? 'multiple criteria' : 'a criterion'}: ${hard.join(', ')}${verdicts.timeline === 'fail' ? ' (+ timeline)' : ''}`];
    return out('red', reasons, { red_reason: reason });
  }

  // Timeline failing on its own is fixable → Amber, never Red (DECISIONS D7).
  if (verdicts.timeline === 'fail') {
    return out('amber', [`timeline: ${timelineNote}; caller may be able to move the date`], { next_question: 'timeline' });
  }
  const unclear = ['real_project', 'service_area', 'timeline'].filter((k) => verdicts[k] === 'unclear');
  if (unclear.length) {
    return out('amber', [`unclear on: ${unclear.join(', ')} — needs one clarifying question`], { next_question: unclear[0] });
  }

  const notes = [];
  if (verdicts.budget === 'unclear') notes.push('budget not discussed');
  if (verdicts.decision_maker === 'unclear') notes.push('decision-maker not confirmed');
  return out('green', [notes.length ? `passes; unclear only on ${notes.join(' and ')} (flagged)` : 'passes all five criteria']);
}
