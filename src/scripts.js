// Fixed lines the system speaks. Anything with policy weight is NOT improvised by the model.
// All of these pass the output guard (tested). No referrals, no numbers, no promised times, no named designers.
// Hinglish lines are friendly-tone only and need a native-speaker review before go-live (DECISIONS D12).
import { PRICING_LINE, BOT_DISCLOSURE_EN, NO_REFERRAL_LINE } from './guard.js';

export { PRICING_LINE };

const isHinglish = (lang) => lang === 'hinglish' || lang === 'hi';

export function greeting({ afterHours = false } = {}) {
  const base = "Hello, you've reached Aangan Studio. I'm the studio's AI assistant, and this call is recorded and transcribed so the team can follow up.";
  const tail = afterHours
    ? " The designers are away right now, but I can take down your details and set up a consultation request. How can I help?"
    : ' How can I help you today?';
  return base + tail;
}

export const AFTER_HOURS_NOTE = "Just so you know, the designers are away right now, but I can take down your details and set up a consultation request.";

export const PRICE_REPEAT_PREFIX = ['I understand — ', "I hear you — ", "I know that's not the answer you were hoping for — "];
export const pricingReply = (priceAsks) => (priceAsks > 1 ? PRICE_REPEAT_PREFIX[(priceAsks - 2) % PRICE_REPEAT_PREFIX.length] : '') + PRICING_LINE;

export const botDisclosure = (lang) => (isHinglish(lang)
  ? 'Main Aangan Studio ka AI assistant hoon, koi insaan nahi. Main aapki details le sakta hoon aur designer ke saath consultation ki request bana sakta hoon. Aage badhein?'
  : BOT_DISCLOSURE_EN);

export const INJECTION_NOTE = "I'm not able to change how I work, but I'm happy to help with your project.";

export const ESCALATE_ASK = "I'm sorry to hear that. I can't resolve project matters myself, so I'm passing this to Nikhil, our studio head, right now. May I take your name and the best number to reach you?";
export const ESCALATE_ASK_NUMBER = 'Thank you. And what is the best number to reach you on?';
export const ESCALATE_ASK_NAME = 'Thank you. May I have your name, please?';
export const ESCALATE_CLOSE = "Thank you. I've passed this to Nikhil right away, including that you'd like to hear from him or a senior person. I'm sorry for the trouble.";

export const NOISE_1 = "Sorry, I'm having trouble hearing you — the line is breaking up. Could you say that again?";
export const NOISE_1_HI = 'Maaf kijiye, line mein awaaz toot rahi hai. Kya aap dobara bol sakte hain?';
export const NOISE_2 = "I'm still having trouble hearing you. I'll note this number so the team can call you back. Thank you for calling Aangan Studio.";
export const noise = (n, lang) => (n === 1 ? (isHinglish(lang) ? NOISE_1_HI : NOISE_1) : NOISE_2);

export const FAREWELL = 'Thank you for calling Aangan Studio. Take care.';
export const NO_REFERRAL = NO_REFERRAL_LINE;

export const DECLINE = {
  out_of_area: "Thank you for calling. We only take on projects in Pune and PCMC at the moment, so I'm afraid we can't help with this one. We appreciate you thinking of us.",
  advice_only: "Thank you for calling. We're a design-and-execution studio, so we don't offer advice-only visits. If you decide to go ahead with a full project later, we'd be glad to hear from you.",
  out_of_scope_type: "Thank you for thinking of us. We focus on homes and offices, so this type of project isn't something we take on. I'm sorry we can't help.",
  decor_or_sourcing_only: "Thank you for calling. Our work is complete design with execution, so styling or furnishing on its own isn't something we do. If you plan a fuller redesign later, do get in touch.",
  budget_below_scope: "Thank you for being upfront. A complete design-and-execution project is a bigger investment than what you've shared, so I wouldn't want to bring you in for a consultation that doesn't fit. We do appreciate your interest.",
};

export const closeOk = (name, lang) => (isHinglish(lang)
  ? `Shukriya${name ? `, ${name}` : ''}. Maine aapki details aur consultation ka preferred time team ko de diya hai — woh aapse seedha confirm karenge.`
  : `Thank you${name ? `, ${name}` : ''}. I've noted your details and preferred time and passed them to the team — they'll confirm the consultation with you directly.`);

export const CLOSE_AMBER = "Thank you. I've noted everything down and passed it to the team, who will be in touch to take it from here.";

export const CALLBACK_INTRO = "Hello, this is Aangan Studio's AI assistant, returning your call. Is this a good time to talk for a couple of minutes?";

const Q_EN = {
  name: 'May I have your name, please?',
  locality: 'Which area is the property in?',
  property_type: 'Is it a flat, a house or an office, and how many BHK?',
  carpet_area: 'Roughly how big is it, in carpet area?',
  scope: 'What would you like done — the whole home, or particular rooms?',
  timeline: 'When would you need the project complete?',
  decision_maker: 'Will you be deciding on this yourself, or together with family?',
  referral_source: 'How did you hear about Aangan Studio?',
  preferred_window: 'Which days and times suit you for a consultation — weekdays or weekends, mornings or evenings?',
  phone: "What's the best number to reach you on?",
  clarify_real_project: 'Just so I understand — are you looking for a complete design with execution, or mainly advice?',
  clarify_service_area: 'Could you tell me which area of Pune the property is in?',
  clarify_timeline: 'When would you need the project complete?',
};
const Q_HI = {
  name: 'Aapka naam bata sakte hain?',
  locality: 'Property kaun se area mein hai?',
  property_type: 'Flat hai, ghar hai ya office, aur kitne BHK?',
  carpet_area: 'Lagbhag kitna bada hai, carpet area mein?',
  scope: 'Kya karwana hai — poora ghar ya kuch rooms?',
  timeline: 'Aapko project kab tak poora chahiye?',
  decision_maker: 'Aap khud decide karenge ya family ke saath?',
  referral_source: 'Aapne Aangan Studio ke baare mein kaise suna?',
  preferred_window: 'Consultation ke liye kaun se din aur time theek rahenge — weekday ya weekend, subah ya shaam?',
  phone: 'Aapse kis number par baat ho sakti hai?',
  clarify_real_project: 'Bas samajhna chahta hoon — aapko poora design aur execution chahiye ya sirf salah?',
  clarify_service_area: 'Property Pune ke kaun se area mein hai?',
  clarify_timeline: 'Aapko project kab tak poora chahiye?',
};
export const question = (field, lang) => (isHinglish(lang) ? Q_HI : Q_EN)[field] ?? Q_EN[field] ?? null;
const ACK_EN = ['Thanks.', 'Got it.', 'Okay.'];
const ACK_HI = ['Theek hai.', 'Samajh gaya.', 'Zaroor.'];
export const ack = (lang, n = 0) => (isHinglish(lang) ? ACK_HI : ACK_EN)[n % 3];

// ---- Booking a slot on the call (D43). Code speaks these; slots come from real availability. No designer is ever named. ----
export const bookingOffer = (slot, n, lang) => (isHinglish(lang)
  ? (n === 0 ? `Main ${slot} ke liye aapka consultation hold kar sakta hoon. Kya yeh theek rahega?` : `Ek aur option hai: ${slot}. Kya yeh theek rahega?`)
  : (n === 0 ? `I can hold ${slot} for your consultation. Does that work for you?` : `Another option is ${slot}. Would that suit you?`));
export const BOOKING_OTHER_TIME = 'Of course. Which other day or time would suit you better?';
export const BOOKING_OTHER_TIME_HI = 'Zaroor. Aapko kaun sa din ya time theek rahega?';
export const ASK_EMAIL = 'Lovely. So I can send you the calendar invite, could you tell me your email address? Please say it slowly, for example name, at, gmail, dot, com.';
export const ASK_EMAIL_HI = 'Bahut accha. Calendar invite bhejne ke liye, kya aap apna email address bata sakte hain? Dheere boliye, jaise name, at, gmail, dot, com.';
export const confirmEmail = (spoken, lang) => (isHinglish(lang) ? `Maine suna: ${spoken}. Kya yeh sahi hai?` : `I have ${spoken}. Is that correct?`);
export const EMAIL_AGAIN = "Sorry about that. Could you say your email address once more, slowly, one part at a time?";
export const EMAIL_AGAIN_HI = 'Maaf kijiye. Kya aap email address ek baar aur, dheere dheere bata sakte hain?';
export const bookedLine = (slot, hasEmail, lang) => (isHinglish(lang)
  ? `Ho gaya. Maine ${slot} aapke consultation ke liye hold kar diya hai${hasEmail ? ' aur invite aapke email par bheja jayega' : ''}. Team aapse details seedha confirm karegi. Shukriya.`
  : `All set. I've held ${slot} for your consultation${hasEmail ? ' and the invite will go to your email' : ''}. The team will confirm the details with you directly. Thank you for calling Aangan Studio.`);

export const FIELD_ORDER = ['name', 'locality', 'property_type', 'carpet_area', 'scope', 'timeline', 'decision_maker', 'referral_source', 'preferred_window'];

export const ALL_SCRIPT_LINES = () => [
  greeting({ afterHours: false }), greeting({ afterHours: true }), ...PRICE_REPEAT_PREFIX.map((p) => p + PRICING_LINE),
  AFTER_HOURS_NOTE, botDisclosure('en'), botDisclosure('hinglish'), INJECTION_NOTE, ESCALATE_ASK, ESCALATE_ASK_NUMBER, ESCALATE_ASK_NAME,
  ESCALATE_CLOSE, FAREWELL, NO_REFERRAL, ...Object.values(DECLINE), closeOk('Priya', 'en'), closeOk('', 'hinglish'),
  bookingOffer('Saturday, 17 October at 11 in the morning', 0, 'en'), bookingOffer('Monday, 19 October at 4 in the afternoon', 1, 'en'), bookingOffer('Saturday, 17 October at 11 in the morning', 0, 'hinglish'),
  BOOKING_OTHER_TIME, BOOKING_OTHER_TIME_HI, ASK_EMAIL, ASK_EMAIL_HI, confirmEmail('priya dot kulkarni at gmail dot com', 'en'), confirmEmail('priya dot k at gmail dot com', 'hinglish'), EMAIL_AGAIN, EMAIL_AGAIN_HI,
  bookedLine('Saturday, 17 October at 11 in the morning', true, 'en'), bookedLine('Saturday, 17 October at 11 in the morning', false, 'en'), bookedLine('Saturday, 17 October at 11 in the morning', true, 'hinglish'),
  CLOSE_AMBER, CALLBACK_INTRO, NOISE_1, NOISE_1_HI, NOISE_2, ...ACK_EN, ...ACK_HI, ...Object.values(Q_EN), ...Object.values(Q_HI),
];
