import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICING_LINE, checkReply, guardReply } from '../src/guard.js';

const MUST_BLOCK = [
  'It will cost around ₹15 lakh for a 2BHK.',
  'Our rates start at 1800 per sq ft.',
  'For a 2BHK it is typically 8 to 12 lakhs.',
  'Roughly 2,40,000 for the kitchen.',
  'Rs. 50000 for a wardrobe',
  'about 3.5 lakh',
  'Typically around 20 lakhs all in',
  'It is approximately 1800 per square foot',
  'We start at 25k per room',
  'The price is somewhere between one and two lakh',
  'Premium costs about 3x the cost of standard',
  'That would be 2400 per sq.ft.',
  'दो लाख के आसपास',
  'लगभग ₹२०००० ',
  'INR 500000',
  'around fifty',
  'pricing starts from a small amount',
  'Our rate is flexible',
  'about 10 lakh',
  'eight hundred thousand rupees',
  'we charge 1,800 per sq ft',
  'total fee 4,00,000',
  'It is 3 lac',
  '2 crore',
  'costs about ten',
  'Zero-width ₹​50',
  'ℝs 5 lakh'.replace('ℝ', 'R'),
];

const MUST_PASS = [
  PRICING_LINE,
  'Thanks, Priya. Which locality is the flat in?',
  'A 3BHK in Kothrud sounds like a complete redesign. How big is it, roughly, in carpet area?',
  'So that is about 1,400 sq ft carpet in Dahanukar Colony. And when would you like the work completed?',
  'Hi, I am the AI assistant for Aangan Studio, not a person.',
  'We cover Pune and PCMC. Could you tell me which area the property is in?',
  'Namaste! Aap kis area mein hain, aur flat kitne BHK ka hai?',
  'Our process needs a couple of months from start to finish, so a start after the festival might suit you better.',
  'Thank you. I have passed your details and preferred time to the team, and they will confirm the consultation with you directly.',
  'Would weekday evenings or weekends suit you better?',
  'Is the property rented or owned?',
];

test('guard blocks every price-like phrasing', () => {
  for (const s of MUST_BLOCK) {
    const r = checkReply(s);
    assert.equal(r.ok, false, `should block: ${s}`);
  }
});

test('guard lets normal conversation through (no over-blocking of legit lines)', () => {
  for (const s of MUST_PASS) {
    const r = checkReply(s);
    assert.equal(r.ok, true, `should pass: ${s} -> ${JSON.stringify(r.violations)}`);
  }
});

test('the approved pricing line itself passes the guard and is verbatim', () => {
  assert.equal(
    PRICING_LINE,
    "Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like.",
  );
  assert.equal(guardReply(PRICING_LINE).blocked, false);
});

test('blocked line is replaced by the verbatim pricing line and the violation is reported', () => {
  const seen = [];
  const r = guardReply('Honestly it will cost around ₹12 lakh.', { onViolation: (v) => seen.push(v) });
  assert.equal(r.blocked, true);
  assert.equal(r.text, PRICING_LINE);
  assert.ok(r.violations.length >= 1);
  assert.equal(seen.length, 1);
  assert.match(seen[0].original, /12 lakh/);
});

import { guardReply as guardAll, BOT_DISCLOSURE_EN, NO_REFERRAL_LINE, TEAM_CONFIRMS_LINE } from '../src/guard.js';

test('policy guard: human claims, referrals and promised call times are blocked and replaced', () => {
  const cases = [
    ['Yes, I am a real person here.', BOT_DISCLOSURE_EN],
    ["I'm not a bot, promise.", BOT_DISCLOSURE_EN],
    ['You could try another studio for that.', NO_REFERRAL_LINE],
    ['I would recommend a local designer for this.', NO_REFERRAL_LINE],
    ['Our designer Aryan will call you tomorrow.', TEAM_CONFIRMS_LINE],
    ["I'll call you at 5 to confirm.", TEAM_CONFIRMS_LINE],
    ['We will visit your site on Monday.', TEAM_CONFIRMS_LINE],
  ];
  for (const [bad, expected] of cases) {
    const r = guardAll(bad);
    assert.equal(r.blocked, true, `should block: ${bad}`);
    assert.equal(r.text, expected);
  }
});

test('policy guard does not trip on the legitimate lines', () => {
  for (const ok of [...MUST_PASS, 'I am an AI assistant, not a person.', "I've flagged this to Nikhil, our studio head, right now.", 'The team will confirm the consultation with you directly.']) {
    assert.equal(guardAll(ok).blocked, false, `should pass: ${ok}`);
  }
});
