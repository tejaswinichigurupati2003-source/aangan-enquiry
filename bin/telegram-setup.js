#!/usr/bin/env node
// Telegram helper: checks your bot token and FINDS YOUR CHAT IDs (so you never have to dig them out of a URL).
//   node bin/telegram-setup.js                 → verifies the token, lists every chat that has messaged the bot (id, type, name)
//   node bin/telegram-setup.js --test <chat_id> → sends one harmless test message to that chat (a real message; opt-in)
// The bot token comes from .env (TELEGRAM_BOT_TOKEN) — never put it on the command line.
import { loadConfig } from '../src/config.js';

export async function telegramSetup({ token, testChat = null, fetchImpl = fetch, log = console.log }) {
  const api = (m, body) => fetchImpl(`https://api.telegram.org/bot${token}/${m}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined).then((r) => r.json());
  const me = await api('getMe');
  if (!me.ok) { log(`✗ Telegram rejected the token: ${me.description ?? 'unknown error'}. Re-copy it from @BotFather (no spaces).`); return { ok: false, chats: [] }; }
  log(`✓ token works — your bot is @${me.result.username} (${me.result.first_name})`);

  const up = await api('getUpdates', { allowed_updates: ['message', 'channel_post', 'my_chat_member', 'callback_query'] });
  const chats = new Map();
  for (const u of up.result ?? []) {
    const m = u.message ?? u.channel_post ?? u.my_chat_member?.chat ? (u.message ?? u.channel_post ?? { chat: u.my_chat_member.chat }) : null;
    if (m?.chat) chats.set(m.chat.id, { id: m.chat.id, type: m.chat.type, name: m.chat.title ?? [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') ?? m.chat.username });
  }
  if (!up.ok && /webhook/i.test(up.description ?? '')) log('! A webhook is set on this bot, so getUpdates is blocked. Remove it with: https://api.telegram.org/bot<TOKEN>/deleteWebhook');
  if (!chats.size) {
    log('  No chats found yet. Do this, then run the command again:');
    log(`   • personal alerts: open Telegram, search @${me.result.username}, press START and send "hi"`);
    log('   • designer group: add the bot to the group, then send any message in the group (e.g. "/start")');
  } else {
    log('  Chats that have contacted the bot:');
    for (const c of chats.values()) log(`   id ${String(c.id).padEnd(16)} ${c.type.padEnd(11)} ${c.name || ''}`);
    log('  → put the PERSONAL chat id in TELEGRAM_NIKHIL_CHAT_ID and the GROUP chat id (negative number) in TELEGRAM_DESIGNER_CHAT_ID');
  }
  if (testChat) {
    const r = await api('sendMessage', { chat_id: testChat, text: '✅ Aangan Studio: Telegram is connected. Real lead notes will arrive here.' });
    log(r.ok ? `✓ test message sent to ${testChat}` : `✗ could not send to ${testChat}: ${r.description}`);
    return { ok: r.ok, chats: [...chats.values()] };
  }
  return { ok: true, chats: [...chats.values()] };
}

if (process.argv[1]?.endsWith('telegram-setup.js')) {
  const cfg = loadConfig({ fresh: true });
  if (!cfg.env.TELEGRAM_BOT_TOKEN) { console.log('TELEGRAM_BOT_TOKEN is not set in .env — see docs/TELEGRAM_SETUP.md'); process.exit(1); }
  const i = process.argv.indexOf('--test');
  const r = await telegramSetup({ token: cfg.env.TELEGRAM_BOT_TOKEN, testChat: i >= 0 ? process.argv[i + 1] : null });
  process.exit(r.ok ? 0 : 1);
}
