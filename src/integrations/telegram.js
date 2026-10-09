import { isLive } from '../config.js';
import { toTelegramHtml } from '../notes.js';

const inQuietHours = (cfg, date) => {
  const hhmm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: cfg.studio.timezone }).format(date);
  const { quiet_hours_start: s, quiet_hours_end: e } = cfg.studio;
  return s > e ? hhmm >= s || hhmm < e : hhmm >= s && hhmm < e;
};

/**
 * Send a handoff note. DRY-RUN by default: the message is written to the outbox instead.
 * @param to 'designer' | 'nikhil'
 */
export async function sendTelegram({ cfg, store, to, text, enquiryId, now = new Date(), fetchImpl = fetch }) {
  const silent = inQuietHours(cfg, now);
  const chatKey = to === 'nikhil' ? 'TELEGRAM_NIKHIL_CHAT_ID' : 'TELEGRAM_DESIGNER_CHAT_ID';
  const payload = {
    text, to, silent,
    // The inline button is how "designer pickup time" is measured.
    buttons: [{ text: '✅ Got it', callback_data: `ack:${enquiryId}` }],
  };
  if (!isLive(cfg, ['TELEGRAM_BOT_TOKEN', chatKey])) {
    store?.outboxPush({ channel: 'telegram', dryRun: true, enquiryId, ...payload });
    return { dryRun: true, silent };
  }
  const res = await fetchImpl(`https://api.telegram.org/bot${cfg.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: cfg.env[chatKey], text: toTelegramHtml(text), parse_mode: 'HTML', disable_notification: silent,
      reply_markup: { inline_keyboard: [payload.buttons] },
    }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}`);
  store?.outboxPush({ channel: 'telegram', dryRun: false, enquiryId, to, silent, text });
  return { dryRun: false, silent };
}

/** Handle a Telegram callback_query update (the designer tapped "Got it"). Needs a webhook/poller to call it. */
export function handleTelegramUpdate(update, store, now = new Date()) {
  const data = update?.callback_query?.data || '';
  const m = data.match(/^ack:(.+)$/);
  if (!m) return null;
  return recordAck(store, m[1], now);
}

export function recordAck(store, enquiryId, now = new Date(), by = null) {
  const enq = store.getEnquiry(enquiryId);
  if (!enq || enq.handoff?.ackAt) return null;
  enq.handoff.ackAt = now.toISOString();
  if (by) enq.handoff.ackBy = by;
  store.save();
  return enq;
}
