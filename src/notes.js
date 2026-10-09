// Designer / escalation notes. Rule 5: the FIRST line is the tap-to-call number (Telegram makes plain
// phone numbers tappable), then the fields designers otherwise re-ask, then a one-line summary.
import { displayPhone } from './phone.js';

const FLAG_TEXT = {
  timeline_tight: 'tight timeline',
  timeline_not_confirmed: 'timeline not confirmed — ask',
  budget_not_discussed: 'budget not discussed',
  decision_maker_unclear: 'decision-maker not confirmed',
  caller_is_proxy: 'caller is not the decider (family member checking)',
  prior_enquiry_dropped: 'earlier enquiry was NOT followed up — handle with care',
  caller_frustrated: 'caller is frustrated',
  repeat_caller: 'repeat caller (merged)',
  referral_past_client: 'referred by a past client',
  referral_vip: 'referred by a friend of the studio head',
  commercial_min_unconfirmed: 'small commercial area (minimum not confirmed)',
  rented_property: 'rented property',
  commercial_project: 'commercial project',
  hinglish_caller: 'caller speaks Hindi/Hinglish',
  after_hours: 'called outside office hours',
  site_not_yet_possessed: 'site not yet possessed',
  budget_volunteered: 'caller volunteered a budget',
  asked_for_price: 'asked for pricing (deflected)',
  pushed_for_price: 'pushed repeatedly for pricing (deflected)',
};

export const flagLabel = (f) => FLAG_TEXT[f] ?? f.replace(/_/g, ' ');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const line = (label, v) => (v ? `${label}: ${v}` : null);

export function areaText(f) {
  if (!f.carpet_area_sqft) return null;
  return `${Number(f.carpet_area_sqft).toLocaleString('en-IN')} sq ft carpet`;
}

/** Plain-text designer note (HTML-escaped when sent to Telegram). */
export function buildDesignerNote(enquiry, cls) {
  const f = cls.fields || {};
  const flags = (cls.flags || []).filter((x) => !['asked_if_bot'].includes(x));
  const lines = [
    displayPhone(enquiry.phone),
    line('Name', f.name),
    line('Locality', f.locality),
    line('Property', [f.property_type, areaText(f)].filter(Boolean).join(' · ')),
    line('Scope', f.scope),
    line('Timeline', f.timeline_text),
    line('Who decides', f.decision_maker),
    line('Referral', f.referral_source),
    line('Preferred consultation slot', f.preferred_window),
    flags.length ? `Flags: ${flags.map(flagLabel).join('; ')}` : null,
    '',
    `Summary: ${cls.summary || cls.reason}`,
    enquiry.source === 'seed' ? 'Source: seed (TEST DATA — not a real lead)' : 'Source: live call',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

export function buildEscalationNote(enquiry, cls) {
  const f = cls.fields || {};
  return [
    displayPhone(enquiry.phone),
    '🚨 ESCALATION — existing client complaint (not a lead)',
    line('Name', f.name),
    line('Project', [f.property_type, f.locality].filter(Boolean).join(' · ')),
    line('Designer mentioned', f.designer_mentioned),
    line('Callback wanted from', f.callback_preference),
    '',
    `Summary: ${cls.summary || cls.reason}`,
    'The AI did not discuss the complaint and promised no times or people.',
    enquiry.source === 'seed' ? 'Source: seed (TEST DATA)' : 'Source: live call',
  ].filter((l) => l !== null).join('\n');
}

export const toTelegramHtml = (plain) => esc(plain);

export function buildEmail(kind, enquiry, cls, transcript) {
  const f = cls.fields || {};
  const label = kind === 'escalate' ? 'ESCALATION' : kind.toUpperCase();
  return {
    subject: `[Aangan ${enquiry.source === 'seed' ? 'SEED TEST ' : ''}${label}] ${f.name || 'Unknown caller'} — ${f.locality || 'locality n/a'} — ${displayPhone(enquiry.phone)}`,
    text: `${kind === 'escalate' ? buildEscalationNote(enquiry, cls) : buildDesignerNote(enquiry, cls)}\n\n----- Transcript -----\n${transcript}\n`,
  };
}
