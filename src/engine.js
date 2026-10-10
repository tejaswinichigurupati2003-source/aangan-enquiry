// Conversation engine. The LLM supplies understanding + judgement + natural phrasing (JSON).
// CODE owns everything with policy weight and the output guard:
//   precedence per turn:  complaint → clear red (polite decline) → bot disclosure / pricing line / injection note
//                         → one clarifying question per unclear criterion → intake questions → booking request → close
// Every outbound line passes src/guard.js. If the model misbehaves (or is replaced by a rogue one), the guard holds.
import { evaluate } from './rules.js';
import { guardReply, checkReply, PRICING_LINE } from './guard.js';
import { loadPrompt } from './prompts.js';
import { extractPhone } from './phone.js';
import { istParts, isAfterHours } from './classifier.js';
import { speechSeconds } from './cost.js';
import * as S from './scripts.js';
import { uid } from './store.js';
import { parseWindowHint, hintIsEmpty, slotMatchesHint, findSlots, speakSlot, speakEmail, parseSpokenEmail, isYes, isNo } from './booking.js';

const FIELD_KEYS = ['name', 'locality', 'property_type', 'carpet_area_sqft', 'scope', 'timeline_text', 'decision_maker', 'referral_source', 'preferred_window', 'designer_mentioned', 'callback_preference'];
const ASKING_TO_FIELD = { name: 'name', locality: 'locality', property_type: 'property_type', carpet_area: 'carpet_area', scope: 'scope', timeline: 'timeline', decision_maker: 'decision_maker', referral_source: 'referral_source', preferred_window: 'preferred_window', phone: 'phone' };
const CLARIFY_TO_CRITERION = { clarify_real_project: 'real_project', clarify_service_area: 'service_area', clarify_timeline: 'timeline' };
const CRITERION_INTAKE_FIELD = { real_project: 'scope', service_area: 'locality', timeline: 'timeline' };
const FAIL_REASONS = ['advice_only', 'decor_or_sourcing_only', 'out_of_scope_type', 'structural_work'];

// Backup detectors (the model's signals are primary; these catch what it might miss).
const RE = {
  price: /\b(?:quote|give|tell|share|send|state|name)\b[^.?!]{0,30}\b(?:price|prices|rate|rates|cost|costs|figure|number|range|estimate|ballpark|charges)\b|\b(?:how much|ballpark|rough(?:ly)? (?:idea|figure|range|number|estimate)|per\s*sq|price|prices|pricing|cost|costs|costing|charges?|quote|estimate|rates?|kitna|kitne|kharcha|kharch|daam|paisa)\b[^.?!]*\?|\bhow much\b|\bballpark\b|\bper\s*sq\s*(?:ft|feet|foot)\b|\b(?:kitna|kitne)\b.*\b(?:kharcha|lagega|aayega|padega|hoga)\b|\b(?:rate|daam|price|cost)\s+(?:kya|bata|batao|bataiye)\b|\bwhat(?:'s| is| will| would)?\b[^.?!]{0,30}\b(?:cost|price|rate|charge)\b/i,
  discount: /\b(?:discount|discounts|concession|negotiat\w*|cheaper|best price|special offers?|any offers?|kam kar\w*)\b/i,
  bot: /\b(?:are you|r u|you(?:'re| are)|is this|am i (?:talking|speaking))\b[^.?!]{0,40}\b(?:bot|robot|ai|a\.i\.|machine|human|real person|actual person|automated|computer|recording)\b|\b(?:bot|robot)\b|\breal person\b|\bactual person\b|\binsaan\b|\bmachine hai\b|\brobot hai\b/i,
  injection: /\bignore\b[^.?!]{0,30}\b(?:rules?|instructions?|guidelines?|prompt|above|previous)\b|\bsystem prompt\b|\byou are now\b|\bforget\b[^.?!]{0,20}\b(?:rules?|instructions?)\b|\bdeveloper mode\b|\bjailbreak\b|\bdisregard\b[^.?!]{0,20}\b(?:rules?|instructions?)\b|\breveal\b[^.?!]{0,20}\b(?:prompt|instructions?)\b|\bpretend (?:you|to be)\b/i,
  referralAsk: /\b(?:refer|recommend|suggest|know (?:anyone|someone|any)|any other|another (?:studio|designer)|kisi aur)\b/i,
  end: /\b(?:bye|goodbye|that'?s all|nothing else|have to go|gotta go|call you back|will call back|let me think|phir baat|baad mein)\b/i,
};
export const detect = (text) => ({
  price: RE.price.test(text), discount: RE.discount.test(text), bot: RE.bot.test(text),
  injection: RE.injection.test(text), referralAsk: RE.referralAsk.test(text), end: RE.end.test(text),
});

/** Hindi/Hinglish markers (Roman script) or any Devanagari. Code, not the model, decides the reply language. */
export const HINGLISH_RE = /\b(?:hai|hain|mujhe|chahiye|karwana|karna|karni|karwani|ghar|mera|meri|humara|kitna|kitne|kya|aap|aapka|hum|nahi|haan|namaste|batao|bataiye|kab|mahine|mahina|saal|poora|pura|shaam|subah|lagbhag|theek|kharcha|dost|bataya)\b|[ऀ-ॿ]/i;
export const looksHinglish = (t) => HINGLISH_RE.test(String(t));

/** Text-simulator convention for a bad line (a real STT would flag low confidence): [noise] / [inaudible] markers or almost no words. */
export const isNoise = (t) => /\[[^\]]*(?:noise|inaudible|unintelligible|breaking up|static|garbled)[^\]]*\]/i.test(t) || !/[a-zA-Zऀ-ॿ]/.test(t.replace(/\[[^\]]*\]/g, ''));

const cleanText = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);

function newState(cfg, startedAt, hasCallerId) {
  return {
    mode: 'intake', // intake | escalate | declined | closed
    fields: {}, asked: [], clarifiers: { real_project: 0, service_area: 0, timeline: 0 },
    assessment: {
      real_project: { verdict: 'unclear', fail_reason: null },
      service_area: { verdict: 'unclear' },
      timeline: { mentioned: false, urgency_cue: false, completion_in_weeks: null, flexible: null },
      budget: { assessment: 'not_mentioned' },
      decision_maker: { verdict: 'unclear' },
    },
    language: 'en', priceAsks: 0, turnCount: 0, windowAsked: false,
    escalate: { asked: false, reprompts: 0 }, referralAsked: false,
    callDate: istParts(startedAt, cfg.studio.timezone).date, hasCallerId, degraded: false,
  };
}

function sanitizeAssessment(prev, a) {
  if (!a || typeof a !== 'object') return prev;
  const next = structuredClone(prev);
  const verdict = (v) => ['pass', 'fail', 'unclear'].includes(v);
  const sticky = (old, v) => (v === 'unclear' && old !== 'unclear' ? old : v); // earlier firm verdicts are not erased by a vague later turn
  if (verdict(a.real_project?.verdict)) {
    let v = a.real_project.verdict; let reason = a.real_project.fail_reason ?? null;
    if (v === 'fail' && !FAIL_REASONS.includes(reason)) v = 'unclear';
    v = sticky(prev.real_project.verdict, v);
    next.real_project = { verdict: v, fail_reason: v === 'fail' ? (prev.real_project.verdict === 'fail' && v === 'fail' && !reason ? prev.real_project.fail_reason : reason) : null };
  }
  if (verdict(a.service_area?.verdict)) next.service_area = { verdict: sticky(prev.service_area.verdict, a.service_area.verdict) };
  const t = a.timeline;
  if (t && typeof t === 'object') {
    next.timeline = {
      mentioned: Boolean(t.mentioned) || prev.timeline.mentioned,
      urgency_cue: Boolean(t.urgency_cue),
      completion_in_weeks: typeof t.completion_in_weeks === 'number' ? t.completion_in_weeks : (t.mentioned ? null : prev.timeline.completion_in_weeks),
      flexible: typeof t.flexible === 'boolean' ? t.flexible : prev.timeline.flexible,
    };
  }
  if (['not_mentioned', 'plausible', 'far_below_scope'].includes(a.budget?.assessment) && a.budget.assessment !== 'not_mentioned') next.budget = { assessment: a.budget.assessment };
  if (['pass', 'unclear'].includes(a.decision_maker?.verdict)) next.decision_maker = { verdict: sticky(prev.decision_maker.verdict, a.decision_maker.verdict) };
  return next;
}

export function runningExtraction(state) {
  const a = state.assessment;
  return {
    interaction: { kind: 'conversation', usable_details: true },
    existing_client_complaint: { is: false },
    criteria: { real_project: a.real_project, service_area: a.service_area, timeline: a.timeline, budget: a.budget, decision_maker: a.decision_maker },
    fields: state.fields, flags: [],
  };
}

export class CallEngine {
  constructor({ cfg, provider, store, now = () => new Date() }) {
    Object.assign(this, { cfg, provider, store, now });
    this.prompt = loadPrompt(cfg, 'conversation');
  }

  /** Begin a call. Returns the call record; the greeting is already its first agent turn. */
  start({ from = null, startedAt = this.now().toISOString(), source = 'live', caseId = null, ringAt = Date.now(), externalGreeting = false } = {}) {
    const cfg = this.cfg;
    const afterHours = isAfterHours(cfg, startedAt);
    const call = {
      id: uid('call'), source, from, startedAt, caseId, status: 'in_progress', channel: 'phone', turns: [],
      state: newState(cfg, startedAt, Boolean(from)), engineFlags: afterHours ? ['after_hours'] : [],
      usage: { conversation: { in: 0, out: 0, n: 0, estimated: false } }, guardEvents: [], clock: 0,
      promptVersions: { conversation: this.prompt.id, classifier: cfg.prompts.classifier }, afterHours,
      ringToAnswerMs: Math.max(0, Date.now() - ringAt), provider: this.provider.name,
    };
    // externalGreeting: the telephony platform (Vani) speaks a fixed opening line configured in its dashboard, so it cannot
    // vary by time of day. We record the standard line as turn 0 and carry the after-hours sentence on our first reply instead.
    this.say(call, this.guard(call, S.greeting({ afterHours: externalGreeting ? false : afterHours })));
    call.state.afterHoursPending = externalGreeting && afterHours;
    this.store.addCall(call);
    return { call, greeting: call.turns[0].text };
  }

  guard(call, text) {
    const g = guardReply(text);
    if (g.blocked) {
      const ev = { at: this.now().toISOString(), original: g.original, violations: g.violations, substituted: true };
      call.guardEvents.push(ev);
      this.store.event('guard_blocked', { callId: call.id, source: call.source, violations: g.violations.map((v) => v.rule) });
    }
    return g.text;
  }

  say(call, text) { call.turns.push({ role: 'agent', text, at: this.stamp(call, text) }); }
  stamp(call, text) { call.clock += speechSeconds(this.cfg, text.length) + 1.2; return new Date(new Date(call.startedAt).getTime() + call.clock * 1000).toISOString(); }

  known(state, field) {
    const f = state.fields; const a = state.assessment;
    switch (field) {
      case 'carpet_area': return Boolean(f.carpet_area_sqft);
      case 'timeline': return Boolean(f.timeline_text) || a.timeline.mentioned;
      case 'decision_maker': return Boolean(f.decision_maker) || a.decision_maker.verdict === 'pass';
      case 'phone': return Boolean(state.hasCallerId || f.phone);
      default: return Boolean(f[field]);
    }
  }
  nextField(state) {
    const order = state.hasCallerId ? S.FIELD_ORDER : ['name', 'phone', ...S.FIELD_ORDER.filter((x) => x !== 'name')];
    return order.find((x) => !this.known(state, x) && !state.asked.includes(x)) ?? null;
  }

  buildMessages(call, text) {
    const st = call.state;
    const msgs = [{ role: 'user', text: '[call connected]' }];
    for (const t of call.turns) msgs.push({ role: t.role === 'caller' ? 'user' : 'model', text: t.text });
    const stateBlock = {
      reply_language: st.language, call_date: st.callDate, after_hours: call.afterHours, caller_id_available: st.hasCallerId,
      known: Object.fromEntries(Object.entries(st.fields).filter(([, v]) => v != null)),
      next_field: this.nextField(st), clarifiers_used: st.clarifiers, caller_turn_number: st.turnCount,
      running_assessment_summary: { real_project: st.assessment.real_project.verdict, service_area: st.assessment.service_area.verdict },
    };
    // merge consecutive same-role messages (Gemini wants alternating turns)
    const merged = [];
    for (const m of msgs) {
      if (merged.length && merged.at(-1).role === m.role) merged.at(-1).text += `\n${m.text}`; else merged.push({ ...m });
    }
    merged.push({ role: 'user', text: `STATE: ${JSON.stringify(stateBlock)}\nCALLER SAID: ${text}` });
    // the last two could both be 'user' (caller turn then state) — only if history ended with a user turn
    return merged.reduce((acc, m) => { if (acc.length && acc.at(-1).role === m.role) acc.at(-1).text += `\n${m.text}`; else acc.push(m); return acc; }, []);
  }

  async callModel(call, text) {
    const st = call.state;
    try {
      const res = await this.provider.generateJson({
        kind: 'conversation', system: this.prompt.text, messages: this.buildMessages(call, text),
        model: this.cfg.provider.conversation_model, temperature: this.cfg.provider.temperature_conversation,
        ctx: { caseId: call.caseId, turn: st.turnCount - 1 },
      });
      const u = call.usage.conversation;
      u.in += res.usage.inputTokens; u.out += res.usage.outputTokens; u.n++; u.estimated = u.estimated || res.usage.estimated;
      if (!res.json || typeof res.json !== 'object') throw new Error('model output is not an object');
      return res.json;
    } catch (e) {
      st.degraded = true;
      this.store.event('llm_error', { callId: call.id, error: e.message });
      return null; // deterministic fallback below
    }
  }

  mergeModelOutput(call, out, text, det) {
    const st = call.state;
    if (!out) return { signals: {}, asking: null };
    for (const k of FIELD_KEYS) {
      let v = out.updates?.[k];
      if (v == null || v === '') continue;
      if (k === 'carpet_area_sqft') { v = Number(String(v).replace(/,/g, '')); if (!Number.isFinite(v) || v <= 0) continue; } else {
        v = String(v).slice(0, 200);
        if (!checkReply(v).ok) { this.store.event('field_dropped_price_like', { callId: call.id, field: k }); continue; } // no figures in notes
      }
      st.fields[k] = v;
    }
    st.assessment = sanitizeAssessment(st.assessment, out.assessment);
    if (st.language === 'en' && ['hinglish', 'hi', 'mr'].includes(out.language)) st.language = out.language; // never downgrade: code detected Hinglish
    const sg = out.signals || {};
    return { signals: sg, asking: out.asking_about, ready: Boolean(out.ready_to_close), reply: typeof out.reply === 'string' ? out.reply.trim() : '' };
  }

  addFlag(call, f) { if (!call.engineFlags.includes(f)) call.engineFlags.push(f); }

  /** One caller utterance in → one agent reply out. */
  async turn(call, rawText) {
    const cfg = this.cfg; const st = call.state;
    const text = cleanText(rawText);
    call.turns.push({ role: 'caller', text, at: this.stamp(call, text) });
    st.turnCount++;
    const det = detect(text);
    const phone = extractPhone(text);
    if (phone && !call.from) st.fields.phone = phone;

    // Closed states need no model call (and cost nothing).
    if (st.mode === 'declined' || st.mode === 'closed') {
      const reply = this.guard(call, det.referralAsk ? S.NO_REFERRAL : S.FAREWELL);
      return this.emit(call, reply, true, 'closed');
    }

    // Bad line: ask for a repeat (no model call); second time, close politely so the team can call back.
    if (isNoise(text) && !phone) {
      st.noiseCount = (st.noiseCount || 0) + 1;
      this.addFlag(call, 'noisy_line');
      const done = st.noiseCount >= 2;
      return this.emit(call, S.noise(st.noiseCount, st.language), done, done ? 'closed' : 'intake');
    }

    if (looksHinglish(text) && st.language === 'en') st.language = 'hinglish';
    // A slot is being booked: the next few turns are fully scripted (no model), so the model can never invent a time or an address.
    if (['offer', 'ask_email', 'confirm_email'].includes(st.booking?.phase)) return this.bookingTurn(call, text, det);
    const out = await this.callModel(call, text);
    const m = this.mergeModelOutput(call, out, text, det);
    const sig = m.signals;
    const lang = st.language;
    if (lang === 'hinglish' || lang === 'hi') this.addFlag(call, 'hinglish_caller');
    if (sig.caller_frustrated) this.addFlag(call, 'caller_frustrated');
    const asksPrice = Boolean(sig.asks_price || det.price);
    const asksDiscount = Boolean(sig.asks_discount || det.discount);
    const asksBot = Boolean(sig.asks_if_bot || det.bot);
    const injection = Boolean(sig.injection_attempt || det.injection);
    if (asksBot) this.addFlag(call, 'asked_if_bot');
    if (injection) this.addFlag(call, 'injection_attempt');
    if (asksDiscount) this.addFlag(call, 'asked_for_discount');
    if (asksPrice || asksDiscount) {
      st.priceAsks++;
      this.addFlag(call, 'asked_for_price');
      if (st.priceAsks >= 2) this.addFlag(call, 'pushed_for_price');
    }

    // 1) existing-client complaint → fixed script, never handled by the AI
    if (sig.existing_client_complaint || st.mode === 'escalate') return this.escalateTurn(call);

    // 2) running tier on the model's judgements, decided by code
    const ev = evaluate(runningExtraction(st), cfg);
    call.state.lastEval = { tier: ev.tier, red_reason: ev.red_reason };
    const botPrefix = asksBot ? `${S.botDisclosure(lang)} ` : '';
    if (ev.tier === 'red') {
      st.mode = 'declined';
      return this.emit(call, botPrefix + S.DECLINE[ev.red_reason], false, 'declined', { decline: ev.red_reason });
    }

    // 3) policy replies that override whatever the model wrote
    if (asksPrice || asksDiscount) return this.emit(call, botPrefix + S.pricingReply(st.priceAsks), false, 'intake');
    if (asksBot) return this.emit(call, S.botDisclosure(lang), false, 'intake');
    const injectionPrefix = injection ? `${S.INJECTION_NOTE} ` : '';

    // 4) wrap-up conditions
    const next = this.nextField(st);
    const endNow = Boolean(sig.wants_to_end || det.end) && st.turnCount > 1;
    const tooLong = st.turnCount >= cfg.rules.max_caller_turns;
    const ready = next === null || endNow || tooLong;

    // 5) one clarifying question per unclear criterion (only after the natural intake question for it has been used)
    if (!ready && ev.tier === 'amber' && ['real_project', 'service_area', 'timeline'].includes(ev.next_question)) {
      const crit = ev.next_question;
      const intakeField = CRITERION_INTAKE_FIELD[crit];
      const intakeUsed = this.known(st, intakeField) || st.asked.includes(intakeField);
      if (intakeUsed && st.clarifiers[crit] < cfg.rules.clarifier_limit_per_criterion) {
        st.clarifiers[crit]++;
        const wanted = `clarify_${crit}`;
        const reply = m.asking === wanted && m.reply ? m.reply : S.question(wanted, lang);
        return this.emit(call, injectionPrefix + reply, false, 'intake');
      }
    }

    if (ready) {
      const closeWithBooking = ev.tier === 'green' && !endNow && !tooLong && !st.windowAsked && !this.known(st, 'preferred_window');
      if (closeWithBooking) {
        st.windowAsked = true; st.asked.push('preferred_window');
        return this.emit(call, injectionPrefix + S.question('preferred_window', lang), false, 'intake');
      }
      if (ev.tier === 'green' && !endNow && !tooLong && this.bookingOn(call) && !st.booking) {
        const offer = this.startBooking(call, text);
        if (offer) return offer;
      }
      st.mode = 'closed';
      const line = ev.tier === 'green' ? S.closeOk(st.fields.name, lang) : S.CLOSE_AMBER;
      return this.emit(call, line, true, 'closed');
    }

    // 6) normal intake turn. CODE decides what is asked next; the model's wording is used only when it asks
    //    exactly that field (otherwise: short acknowledgement + the standard question), so the dialogue cannot drift.
    let reply;
    const asked = ASKING_TO_FIELD[m.asking] ?? null;
    if (next === 'preferred_window') {
      reply = S.question('preferred_window', lang); st.windowAsked = true; st.asked.push('preferred_window');
    } else {
      const languageOk = !(st.language === 'hinglish' || st.language === 'hi') || looksHinglish(m.reply ?? '');
      const usable = m.reply && asked === next && m.reply.includes('?') && m.reply.split('?').length === 2 && languageOk;
      reply = usable ? m.reply : `${S.ack(lang, st.turnCount)} ${S.question(next, lang)}`;
      if (!st.asked.includes(next)) st.asked.push(next);
    }
    return this.emit(call, injectionPrefix + reply, false, 'intake');
  }

  /** Booking on the call only for live calls, and only when switched on in config.yaml (booking.enabled). */
  bookingOn(call) { return Boolean(this.cfg.booking?.enabled) && call.source === 'live'; }

  startBooking(call, text) {
    const st = call.state; const lang = st.language;
    const hint = parseWindowHint(`${st.fields.preferred_window ?? ''} ${text}`, this.cfg, this.now().getTime());
    const slots = findSlots({ cfg: this.cfg, store: this.store, hint, nowMs: this.now().getTime(), count: 2, callId: call.id });
    if (!slots.length) { st.booking = { phase: 'skipped' }; return null; }
    st.booking = { phase: 'offer', slots, idx: 0, offers: 1, email: null, candidate: null, tries: 0, unclear: 0, slot: null };
    this.addFlag(call, 'slot_offered');
    return this.emit(call, S.bookingOffer(speakSlot(this.cfg, slots[0].start), 0, lang), false, 'booking');
  }

  /** The line that re-asks whatever question is currently open (used after a policy reply such as the pricing line). */
  bookingPending(call) {
    const st = call.state; const b = st.booking; const lang = st.language;
    if (b.phase === 'offer') return S.bookingOffer(speakSlot(this.cfg, b.slots[b.idx].start), 0, lang);
    if (b.phase === 'confirm_email') return S.confirmEmail(speakEmail(b.candidate), lang);
    return lang === 'hinglish' || lang === 'hi' ? S.ASK_EMAIL_HI : S.ASK_EMAIL;
  }

  finishBooking(call, withEmail) {
    const st = call.state; const b = st.booking; const lang = st.language;
    b.phase = 'done'; b.slot = b.slots[b.idx];
    if (!withEmail) b.email = null; else st.fields.email = b.email;
    this.addFlag(call, 'slot_held');
    if (!b.email) this.addFlag(call, 'no_email_captured');
    st.mode = 'closed';
    return this.emit(call, S.bookedLine(speakSlot(this.cfg, b.slot.start), Boolean(b.email), lang), true, 'closed', { booked: b.slot });
  }

  fallBackToRequest(call) {
    const st = call.state;
    st.booking.phase = 'skipped'; st.mode = 'closed';
    return this.emit(call, S.closeOk(st.fields.name, st.language), true, 'closed');
  }

  bookingTurn(call, text, det) {
    const st = call.state; const b = st.booking; const lang = st.language; const hi = lang === 'hinglish' || lang === 'hi';
    if (det.bot) { this.addFlag(call, 'asked_if_bot'); return this.emit(call, `${S.botDisclosure(lang)} ${this.bookingPending(call)}`, false, 'booking'); }
    if (det.price || det.discount) { st.priceAsks++; this.addFlag(call, 'asked_for_price'); return this.emit(call, `${S.pricingReply(st.priceAsks)} ${this.bookingPending(call)}`, false, 'booking'); }
    const emailInText = parseSpokenEmail(text);
    if (det.end && !isYes(text) && !emailInText) return this.fallBackToRequest(call);

    if (b.phase === 'offer') {
      const hint = parseWindowHint(text, this.cfg, this.now().getTime());
      if (isYes(text) && (hintIsEmpty(hint) || slotMatchesHint(this.cfg, b.slots[b.idx], hint))) { // accepted the slot we offered
        b.slot = b.slots[b.idx];
        b.phase = 'ask_email';
        return this.emit(call, hi ? S.ASK_EMAIL_HI : S.ASK_EMAIL, false, 'booking');
      }
      if (isNo(text) || !hintIsEmpty(hint)) { // wants something else (a plain "yes" was handled above)
        if (b.offers >= (this.cfg.booking?.offers_per_call ?? 2) + 1) return this.fallBackToRequest(call);
        const offered = b.slots.map((x) => x.start);
        let next = findSlots({ cfg: this.cfg, store: this.store, hint, nowMs: this.now().getTime(), count: 2, exclude: offered, callId: call.id });
        if (hintIsEmpty(hint) && b.slots[b.idx + 1]) next = [b.slots[b.idx + 1]]; // a plain "no": move on to the second option we already had
        if (!next.length) return this.fallBackToRequest(call);
        b.slots = next; b.idx = 0; b.offers++;
        return this.emit(call, S.bookingOffer(speakSlot(this.cfg, next[0].start), 1, lang), false, 'booking');
      }
      if (++b.unclear >= 2) return this.fallBackToRequest(call);
      return this.emit(call, this.bookingPending(call), false, 'booking');
    }

    if (b.phase === 'ask_email' || b.phase === 'confirm_email') {
      if (emailInText && (b.phase === 'ask_email' || !isYes(text))) { b.candidate = emailInText; b.phase = 'confirm_email'; return this.emit(call, S.confirmEmail(speakEmail(emailInText), lang), false, 'booking'); }
      if (b.phase === 'confirm_email' && isYes(text)) { b.email = b.candidate; return this.finishBooking(call, true); }
      const declines = /\b(?:don'?t (?:want|have|wish)|no email|rather not|skip|nahi (?:hai|dena|chahiye)|not comfortable|prefer not)\b/i.test(text);
      if (declines || ++b.tries >= 2) return this.finishBooking(call, false);
      b.phase = 'ask_email';
      return this.emit(call, hi ? S.EMAIL_AGAIN_HI : S.EMAIL_AGAIN, false, 'booking');
    }
    return this.fallBackToRequest(call);
  }

  escalateTurn(call) {
    const st = call.state; const e = st.escalate;
    st.mode = 'escalate';
    this.addFlag(call, 'caller_frustrated');
    const name = st.fields.name; const number = call.from || st.fields.phone;
    let line; let done = false;
    if (!e.asked) {
      e.asked = true;
      if (name && number) { line = S.ESCALATE_CLOSE; done = true; } else line = S.ESCALATE_ASK;
    } else if (name && number) { line = S.ESCALATE_CLOSE; done = true; }
    else if (e.reprompts >= 1) { line = S.ESCALATE_CLOSE; done = true; }
    else { e.reprompts++; line = !name ? S.ESCALATE_ASK_NAME : S.ESCALATE_ASK_NUMBER; }
    if (done) st.mode = 'closed';
    call.escalation = true;
    return this.emit(call, line, done, st.mode);
  }

  emit(call, text, done, mode, extra = {}) {
    let spoken = text;
    if (call.state.afterHoursPending) { call.state.afterHoursPending = false; spoken = `${S.AFTER_HOURS_NOTE} ${text}`; }
    const safe = this.guard(call, spoken);
    this.say(call, safe);
    if (done) { call.state.mode = 'closed'; }
    return { reply: safe, done, mode, ...extra };
  }

  /** Hang up. status: completed | dropped | missed */
  end(call, status = 'completed') {
    call.status = status;
    if (!call.from && call.state.fields.phone) call.from = call.state.fields.phone;
    call.durationSec = Math.round(call.clock);
    call.endedAt = new Date(new Date(call.startedAt).getTime() + call.clock * 1000).toISOString();
    this.store.save();
    return call;
  }
}

export { PRICING_LINE };
