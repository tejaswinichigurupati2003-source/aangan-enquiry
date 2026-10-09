# Telegram — designer handoff (about 2 minutes, free)

Why Telegram: instant push on the designer's phone, the number on the first line is tap-to-call, and the **✅ Got it** button is how the dashboard
measures designer pickup time. Email stays as a backup log.

## Steps
1. In Telegram, open **@BotFather** → send `/newbot` → give it a name (e.g. `Aangan Leads`) and a username ending in `bot` → it replies with a **token**
   (looks like `123456789:AA…`).
2. Put it in `.env` yourself: `TELEGRAM_BOT_TOKEN=123456789:AA…` (never paste it in chat or commit it).
3. **Personal alerts (Nikhil / escalations):** open your new bot in Telegram, press **Start**, send `hi`.
4. **Designer group:** create a group, add the bot, then send any message in the group (e.g. `/start`).
5. Run `node bin/telegram-setup.js` — it verifies the token and **lists the chat IDs** it finds:
   - your personal chat id (a positive number) → `TELEGRAM_NIKHIL_CHAT_ID`
   - the group's id (a negative number) → `TELEGRAM_DESIGNER_CHAT_ID`
6. Optional check: `node bin/telegram-setup.js --test <chat_id>` sends one test message to that chat.
7. Nothing real is sent by the system until `AANGAN_LIVE=1`.

## Notes
- Notes sent between 10 pm and 8 am arrive **silently** (no buzz) so designers aren't woken; they are there when they wake up.
- The "Got it" tap needs a small listener (webhook or poller) to record pickup time — not built yet; without it the notes still arrive and the button is simply decorative.
- Telegram stores messages on its servers, including the caller's phone number. Keep the designer group to people who should see it.
