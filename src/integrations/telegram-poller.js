// Listens for taps on the "✅ Got it" button under each designer note and records the pickup time.
// Uses Telegram long-polling (getUpdates), so no public URL or webhook is needed. Only ONE poller may run per bot token.
import { isLive } from '../config.js';
import { recordAck } from './telegram.js';

export class TelegramPoller {
  constructor({ cfg, store, fetchImpl = fetch, now = () => new Date(), log = () => {} }) {
    Object.assign(this, { cfg, store, fetch: fetchImpl, now, log });
    this.offset = 0; this.running = false; this.failures = 0;
  }

  get enabled() { return isLive(this.cfg, ['TELEGRAM_BOT_TOKEN']); }

  async api(method, body, signal) {
    const r = await this.fetch(`https://api.telegram.org/bot${this.cfg.env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}), signal,
    });
    return r.json();
  }

  /** One long-poll round. Returns the number of updates handled. */
  async tick({ timeout = 25 } = {}) {
    const res = await this.api('getUpdates', { offset: this.offset, timeout, allowed_updates: ['callback_query', 'message', 'channel_post', 'my_chat_member'] });
    if (!res.ok) throw new Error(res.description || 'getUpdates failed');
    for (const u of res.result ?? []) { this.offset = u.update_id + 1; await this.handle(u); }
    return (res.result ?? []).length;
  }

  async handle(u) {
    const cq = u.callback_query;
    if (!cq) return;
    const m = /^ack:(.+)$/.exec(cq.data ?? '');
    if (!m) { await this.api('answerCallbackQuery', { callback_query_id: cq.id }); return; }
    const by = [cq.from?.first_name, cq.from?.last_name].filter(Boolean).join(' ') || cq.from?.username || 'someone';
    const enq = recordAck(this.store, m[1], this.now(), by);
    await this.api('answerCallbackQuery', { callback_query_id: cq.id, text: enq ? 'Thanks — marked as picked up ✅' : 'Already picked up' });
    if (cq.message) {
      const when = this.now().toLocaleTimeString('en-GB', { timeZone: this.cfg.studio.timezone, hour: '2-digit', minute: '2-digit' });
      const label = enq ? `✅ Picked up by ${by} at ${when}` : '✅ Already picked up';
      await this.api('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [[{ text: label, callback_data: 'noop' }]] } });
    }
    if (enq) this.store.save();
    this.log('telegram ack', m[1], by);
  }

  /** Run until stop(). Backs off on errors; never throws. */
  async start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    while (this.running) {
      try { await this.tick(); this.failures = 0; } catch (e) {
        this.failures++; this.log('telegram poll error', e.message);
        await new Promise((r) => setTimeout(r, Math.min(60000, 2000 * 2 ** Math.min(this.failures, 5))));
      }
    }
  }
  stop() { this.running = false; }
}
