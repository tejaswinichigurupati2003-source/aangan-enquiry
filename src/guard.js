// Output guard — hard rules #1 and #3. Every line the AI is about to speak passes through here.
//  (1) PRICING: anything that looks like a price, range, per-sq-ft figure or "it'll cost around…" is BLOCKED,
//      logged by the caller, and the approved pricing line is SUBSTITUTED.
//  (3) POLICY: a claim to be human, a referral elsewhere, or a promised call time is BLOCKED and replaced by a safe line.
// Over-blocking is the intended failure mode.

export const PRICING_LINE =
  "Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like.";

const DEVANAGARI_DIGITS = '०१२३४५६७८९';

function normalise(text) {
  let s = String(text ?? '').normalize('NFKC');
  s = s.replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));
  s = s.replace(/[​-‍­]/g, ''); // zero-width / soft hyphen smuggling
  return s.toLowerCase().replace(/\s+/g, ' ');
}

const NUM_WORD = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|half|ek|do|teen|char|paanch|panch|das|sau|hazaar|hazar)';

export const RULES = [
  { id: 'currency_symbol', re: /[₹]|\brs\.?\s*\d|\binr\b|\brupees?\b|\brupaye\b|\brupay[ae]\b|रुपय|रूपय/ },
  { id: 'lakh_crore', re: /\blakhs?\b|\blacs?\b|\bcrores?\b|\bcr\b|लाख|करोड़|करोड/ },
  { id: 'k_amount', re: /\b\d+(?:\.\d+)?\s?k\b(?!\w)/ },
  { id: 'thousand_hundred_amount', re: new RegExp(`\\b(?:\\d+|${NUM_WORD})\\s+(?:thousand|hundred|hazaar|hazar|sau)\\b`) },
  { id: 'per_area_unit', re: /\bper\s*(?:sq|square|foot|feet|ft|sft|sqft)|\/\s*(?:sq\.?\s*ft|sqft|sft|ft)\b|\bpsf\b|\bsq\.?\s*ft\.?\s*(?:rate|cost|price)/ },
  { id: 'rate_word', re: /\brates?\b|\bpricing\s+(?:starts?|from)\b|\bprice\s+(?:is|starts?|range|from)\b/ },
  { id: 'starts_at', re: /\bstarts?\s+(?:at|from)\b|\bstarting\s+(?:at|from|price)\b/ },
  { id: 'around_number', re: new RegExp(`\\baround\\b\\W{0,3}(?:\\w+\\W+){0,2}(?:\\d|${NUM_WORD}\\b)|(?:\\d|\\b${NUM_WORD})\\b\\W+(?:\\w+\\W+){0,2}\\baround\\b`) },
  { id: 'approx_money', re: /\b(?:approx\w*|roughly|ballpark|about|nearly|close to|upto|up to)\b\W{0,3}(?:rs\.?|inr|₹)?\s*\d[\d,.]*\s*(?:k|l|lakh|lac|cr|crore|thousand)\b/ },
  { id: 'cost_phrase', re: /\b(?:cost|costs|costing|price|priced|charge|charges|fee|fees|budget|quote|quoted)\b\W+(?:\w+\W+){0,3}(?:\d|about|around|roughly|approx|between|from)/ },
  { id: 'multiple_of_cost', re: /\b\d+(?:\.\d+)?\s*[x×]\s*(?:the\s+)?(?:cost|price|amount)/ },
  // comma-grouped amounts (2,40,000 / 1,800) unless clearly an area ("1,400 sq ft") or a count of units
  { id: 'grouped_amount', re: /\b\d{1,3}(?:,\d{2,3})+\b(?!\s*(?:sq|square|sft|ft|feet|foot|carpet))/ },
];

/** @returns {{ok: boolean, violations: {rule: string, match: string}[]}} */
export function checkReply(text) {
  const s = normalise(text);
  const violations = [];
  for (const { id, re } of RULES) {
    const m = s.match(re);
    if (m) violations.push({ rule: id, match: m[0].slice(0, 60) });
  }
  return { ok: violations.length === 0, violations };
}

// ---- Policy guard: never claim to be human, never refer elsewhere, never promise a call time ----
export const BOT_DISCLOSURE_EN = "I'm an AI assistant for Aangan Studio, not a person. I can take your details and set up a consultation request with one of our designers. Shall we carry on?";
export const NO_REFERRAL_LINE = "I'm sorry, I'm not able to recommend anyone. Thank you for calling Aangan Studio, and take care.";
export const TEAM_CONFIRMS_LINE = "I've noted that, and the team will confirm the details with you directly.";

const WHEN = 'today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week|shortly|within|in an hour|in \\d+|by \\d|at \\d|\\d+ (?:minutes|mins|hours)';

export const POLICY_RULES = [
  {
    id: 'human_claim', replacement: BOT_DISCLOSURE_EN,
    re: /\b(?:i(?:'m| am)|this is)\s+(?:a\s+)?(?:real\s+|actual\s+|live\s+)?(?:human|person|man|woman|agent)\b|\bi(?:'m| am) not (?:a )?(?:bot|robot|ai|machine)\b|\bmain\s+(?:ek\s+)?(?:insaan|human)\b/,
  },
  {
    id: 'referral', replacement: NO_REFERRAL_LINE,
    re: /\b(?:try|contact|call|approach|check with|speak to|talk to|reach out to|look for|search for|go to|ask)\b[^.?!]{0,40}\b(?:another|other|different|local|any)\b[^.?!]{0,20}\b(?:studio|studios|designer|designers|contractor|contractors|firm|agency|company)\b|\b(?:recommend|suggest|refer)\w*\b[^.?!]{0,40}\b(?:studio|designer|contractor|firm|agency)\b|\b(?:another|other) studios?\b/,
  },
  {
    id: 'promised_time', replacement: TEAM_CONFIRMS_LINE,
    re: new RegExp(`\\b(?:will|'ll|shall|going to)\\s+(?:call|ring|phone|reach|contact|get back|revert|visit|be there)\\b[^.?!]{0,30}\\b(?:${WHEN})\\b|\\b(?:designer|architect)\\s+[a-z]+\\s+will\\b|\\b(?:call|visit|site visit)\\b[^.?!]{0,15}\\b(?:tomorrow|today|tonight)\\b`),
  },
];

export function checkPolicy(text) {
  const s = normalise(text);
  return POLICY_RULES.filter(({ re }) => re.test(s)).map(({ id, replacement }) => ({ rule: id, replacement }));
}

/**
 * Guard a single outbound line: pricing rules first, then policy rules.
 * @returns {{text: string, blocked: boolean, violations: object[], original?: string}}
 */
export function guardReply(text, { onViolation } = {}) {
  const price = checkReply(text);
  if (!price.ok) {
    const result = { text: PRICING_LINE, blocked: true, violations: price.violations, original: text };
    if (onViolation) onViolation(result);
    return result;
  }
  const policy = checkPolicy(text);
  if (policy.length) {
    const result = { text: policy[0].replacement, blocked: true, violations: policy.map((p) => ({ rule: p.rule, match: '' })), original: text };
    if (onViolation) onViolation(result);
    return result;
  }
  return { text, blocked: false, violations: [] };
}
