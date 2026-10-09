// OFFLINE heuristic provider — a degraded-mode fallback (model unreachable) and what lets the text simulator run
// with no API at all. It implements the same JSON contracts as the real model using plain pattern matching.
// Limits (by design): it can NOT judge "budget far below scope" (never declines on budget — fails open), it
// understands only simple English/Hinglish phrasing, and it is NOT used for the T01–T20 evals.
import { detect, looksHinglish } from '../engine.js';
import * as S from '../scripts.js';
import { estimateTokens } from './recorded.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const NOT_NAMES = new Set(['in', 'at', 'from', 'calling', 'looking', 'planning', 'the', 'a', 'an', 'interested', 'here', 'just', 'not', 'sure', 'trying', 'wanting', 'ready', 'getting', 'moving']);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function weeksUntilMonth(callDate, monthIdx) {
  const d = new Date(`${callDate}T00:00:00Z`);
  let target = new Date(Date.UTC(d.getUTCFullYear(), monthIdx, 1));
  if (target <= d) target = new Date(Date.UTC(d.getUTCFullYear() + 1, monthIdx, 1));
  return Math.round(((target - d) / (7 * 86400000)) * 10) / 10;
}

export function analyze(text, { callDate, nextField, cfg }) {
  const t = String(text);
  const lower = t.toLowerCase();
  const up = {}; const a = {};
  const language = looksHinglish(t) ? 'hinglish' : 'en';

  // name
  let m = t.match(/(?:my name is|this is|i am|i'm|myself|mera naam|naam)\s+([A-Za-z]+(?:\s[A-Z][a-z]+)?)/i);
  if (m && !NOT_NAMES.has(m[1].split(' ')[0].toLowerCase())) up.name = m[1].replace(/\s+(hai|hoon|from|and|here)$/i, '').replace(/^./, (c) => c.toUpperCase());
  else if (nextField === 'name' && /^[A-Za-z]+(?:\s[A-Za-z]+)?$/.test(t.trim()) && t.trim().split(/\s+/).length <= 3) up.name = t.trim();

  // locality + service area
  const places = [...(cfg.service_area.in || []).map((p) => [p, 'in']), ...(cfg.service_area.out || []).map((p) => [p, 'out'])]
    .sort((x, y) => y[0].length - x[0].length);
  const hit = places.find(([p]) => new RegExp(`\\b${escapeRe(p.toLowerCase())}\\b`).test(lower));
  if (hit) { up.locality = hit[0]; a.service_area = { verdict: hit[1] === 'in' ? 'pass' : 'fail' }; }
  else {
    const pm = t.match(/\b(?:in|at|near|from)\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)/);
    if (pm && nextField === 'locality') { up.locality = pm[1]; a.service_area = { verdict: 'unclear' }; }
    else if (nextField === 'locality' && /^[A-Za-z ]{3,30}$/.test(t.trim())) { up.locality = t.trim(); a.service_area = { verdict: 'unclear' }; }
  }

  // property type / out-of-scope types
  const bhk = lower.match(/(\d)\s*-?\s*bhk/);
  if (/restaurant|hotel|\bcafe\b|\bretail\b|\bshop\b|showroom|\bgym\b|resort/.test(lower)) {
    up.property_type = (lower.match(/restaurant|hotel|cafe|retail|shop|showroom|gym|resort/) || ['commercial'])[0];
    a.real_project = { verdict: 'fail', fail_reason: 'out_of_scope_type' };
  } else if (/\boffice|clinic|studio|coworking|co-working/.test(lower)) up.property_type = (lower.match(/office|clinic|studio|coworking|co-working/) || ['office'])[0];
  else if (/villa|bungalow/.test(lower)) up.property_type = 'villa';
  else if (bhk) up.property_type = `${bhk[1]}BHK ${/house|bungalow/.test(lower) ? 'house' : 'apartment'}`;
  else if (/\bflat|apartment|\bhouse\b|\bghar\b/.test(lower)) up.property_type = /house|ghar/.test(lower) ? 'house' : 'apartment';

  // area
  const ar = lower.match(/(\d[\d,]*)\s*(?:sq\.?\s*ft|sqft|square feet|sft)/);
  if (ar) up.carpet_area_sqft = Number(ar[1].replace(/,/g, ''));

  // scope + real-project judgement
  const words = ['kitchen', 'wardrobe', 'living room', 'bedroom', 'bedrooms', 'bathroom', 'study', 'office', 'dining'].filter((w) => lower.includes(w));
  const full = /\b(full|complete|whole|entire|poora|pura|end[- ]to[- ]end)\b/.test(lower);
  if (full || words.length) up.scope = [full ? 'full redesign' : null, words.length ? words.join(', ') : null].filter(Boolean).join(' — ');
  const advice = /\b(ideas|suggestions?|advice|advise|just exploring|just looking|tips|second opinion|colour suggestions?|color suggestions?)\b/.test(lower);
  const diy = /do the execution myself|execution myself/.test(lower);
  if ((advice && !/execution/.test(lower)) || diy) a.real_project = { verdict: 'fail', fail_reason: 'advice_only' };
  else if (!a.real_project && (up.scope || /redo|redesign|interior|renovat|design/.test(lower))) a.real_project = { verdict: 'pass', fail_reason: null };

  // timeline
  const tl = { mentioned: false, urgency_cue: false, completion_in_weeks: null, flexible: null };
  const num = lower.match(/(\d+(?:\.\d+)?)\s*(week|weeks|month|months|mahine|mahina)\b/);
  const monthHit = MONTHS.findIndex((mn) => new RegExp(`\\b${mn}\\b`).test(lower));
  if (num && /(in|within|by|about|around|after|mein|baad|move|ready|done|complete)/.test(lower)) {
    tl.mentioned = true;
    tl.completion_in_weeks = /week/.test(num[2]) ? Number(num[1]) : Math.round(Number(num[1]) * 4.345 * 10) / 10;
  } else if (monthHit >= 0 && /(by|before|till|until|move|ready|done|complete|operational|finish)/.test(lower) && !/\bstart|begin/.test(lower)) {
    tl.mentioned = true; tl.completion_in_weeks = weeksUntilMonth(callDate, monthHit);
  } else if (monthHit >= 0 || /no rush|flexible|plenty of time|no hurry|whenever|sometime/.test(lower)) tl.mentioned = true;
  if (/\b(asap|urgent|urgently|immediately|right away|jaldi|abhi|before diwali|before the festival)\b/.test(lower)) { tl.mentioned = true; tl.urgency_cue = true; }
  if (/start after|can wait|could wait|flexible/.test(lower)) tl.flexible = true;
  if (tl.mentioned) a.timeline = tl;

  // decision maker
  if (/\b(i am|i'm|we are)\s+(?:the\s+)?(?:owner|founder|decision)|myself and my (?:husband|wife|spouse)|my (?:husband|wife|spouse) and i|\bwe both\b|\bi decide\b|\bwe decide\b|\bowner\b|\bfounder\b|hum dono|mera ghar|humara ghar|my husband (?:knows|is happy|said)/.test(lower)) {
    up.decision_maker = /husband|wife|spouse|hum dono/.test(lower) ? 'caller and spouse' : 'caller';
    a.decision_maker = { verdict: 'pass' };
  } else if (/\b(parents|in-laws|father|mother|boss|my company)\b/.test(lower) && /\b(checking|research|decide|they will|will decide)\b/.test(lower)) {
    up.decision_maker = 'family member decides; caller is checking'; a.decision_maker = { verdict: 'unclear' };
  }

  // referral
  const rf = t.match(/[^.]*\b(?:friend|referred|recommended|instagram|linkedin|google|facebook|saw your work|website|justdial|sulekha)\b[^.]*/i);
  if (rf) up.referral_source = rf[0].trim().slice(0, 100);
  else if (nextField === 'referral_source' && t.trim().length <= 60) up.referral_source = t.trim();

  // consultation window
  if (/\b(weekdays?|weekends?|mornings?|evenings?|afternoons?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|subah|shaam|tomorrow|this week|next week)\b/.test(lower)) up.preferred_window = t.trim().slice(0, 120);

  // budget: volunteered at most — the offline provider never judges "far below scope" (fails open)
  if (/\b(budget|lakh|lacs?|crore)\b|₹/.test(lower)) a.budget = { assessment: 'plausible' };

  const d = detect(t);
  const complaint = /\b(my|our) (?:designer|project)\b/.test(lower) && /(not (?:acceptable|replied|responded)|hasn'?t|haven'?t|no (?:reply|response|update)|unacceptable|complain)/.test(lower);
  return {
    updates: up, assessment: a, language,
    signals: { asks_price: d.price, asks_if_bot: d.bot, existing_client_complaint: complaint, asks_discount: d.discount, injection_attempt: d.injection, wants_to_end: d.end, caller_frustrated: complaint || /\b(not acceptable|annoyed|frustrat)/.test(lower) },
  };
}

export class OfflineProvider {
  constructor(cfg) { this.name = 'offline'; this.cfg = cfg; }

  async generateJson({ kind, messages, system }) {
    const cfg = this.cfg;
    const last = messages.at(-1).text;
    let json;
    if (kind === 'conversation') {
      const sm = last.match(/STATE: (\{.*\})\nCALLER SAID: ([\s\S]*)$/);
      const state = sm ? JSON.parse(sm[1]) : {};
      const said = sm ? sm[2] : last;
      const r = analyze(said, { callDate: state.call_date, nextField: state.next_field, cfg });
      const lang = r.language;
      const ack = r.updates.name ? (lang === 'hinglish' ? `Shukriya, ${r.updates.name}.` : `Thanks, ${r.updates.name}.`) : (lang === 'hinglish' ? 'Theek hai.' : 'Got it.');
      const next = state.next_field;
      json = {
        reply: next ? `${ack} ${S.question(next, lang)}` : ack,
        language: lang, updates: r.updates, signals: r.signals, assessment: r.assessment,
        asking_about: next ?? 'none', ready_to_close: false,
      };
    } else {
      // classifier: analyse each caller line on its own, then merge (first firm value wins)
      const lines = last.split('\n').filter((l) => l.startsWith('Caller:')).map((l) => l.slice(7).trim());
      const callerText = lines.join(' ');
      const callDate = (last.match(/CALL DATE: (\S+)/) || [])[1];
      const r = { updates: {}, assessment: {}, signals: {}, language: 'en' };
      for (const line of lines) {
        const x = analyze(line, { callDate, nextField: null, cfg });
        for (const [k, v] of Object.entries(x.updates)) if (r.updates[k] == null) r.updates[k] = v;
        for (const [k, v] of Object.entries(x.assessment)) {
          const firm = (o) => o && (o.verdict === 'pass' || o.verdict === 'fail' || o.mentioned || o.assessment);
          if (!r.assessment[k] || (!firm(r.assessment[k]) && firm(v))) r.assessment[k] = v;
        }
        for (const [k, v] of Object.entries(x.signals)) r.signals[k] = r.signals[k] || v;
        if (x.language === 'hinglish') r.language = 'hinglish';
      }
      const A = r.assessment;
      const f = r.updates;
      const summary = [f.name, f.property_type && `${f.property_type}${f.locality ? ` in ${f.locality}` : ''}`, f.scope].filter(Boolean).join(' — ');
      json = {
        interaction: { kind: 'conversation', usable_details: callerText.length > 15 },
        existing_client_complaint: { is: r.signals.existing_client_complaint, evidence: '' },
        criteria: {
          real_project: { verdict: 'unclear', fail_reason: null, evidence: 'offline heuristic', ...A.real_project },
          service_area: { verdict: 'unclear', evidence: 'offline heuristic', ...A.service_area },
          timeline: { mentioned: false, urgency_cue: false, completion_in_weeks: null, flexible: null, evidence: 'offline heuristic', ...A.timeline },
          budget: { volunteered: Boolean(A.budget), assessment: 'not_mentioned', evidence: 'offline heuristic cannot judge budget', ...A.budget },
          decision_maker: { verdict: 'unclear', evidence: 'offline heuristic', ...A.decision_maker },
        },
        fields: { language: r.language, ...r.updates },
        flags: [], summary: summary ? `${summary} (offline heuristic — review the transcript).` : 'Offline heuristic summary — review the transcript.', reason: 'offline heuristic classification (degraded mode)',
      };
    }
    const cpt = cfg.cost_assumptions.chars_per_token;
    return { json, provider: 'offline', model: 'offline-heuristic', usage: { inputTokens: estimateTokens(system + messages.map((x) => x.text).join(''), cpt), outputTokens: estimateTokens(JSON.stringify(json), cpt), estimated: true } };
  }
}
