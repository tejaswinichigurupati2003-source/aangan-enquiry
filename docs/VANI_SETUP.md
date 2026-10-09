# Connecting Vani + Supabase — step by step

What is built (all tested, all dry-run until you flip the flags):

```
caller ─► Vani (number, speech-to-text, text-to-speech)
            │  per turn: WebSocket  wss://<your-host>/byol/<call_id>   ──► OUR engine (guard, pricing line, scripts) ──► reply text spoken by Vani
            │  call events: HTTPS   POST /webhooks/vaani/<secret>        ──► caller number, end, summary, recording URL
            ▼
         bin/serve.js ──► classify ──► Telegram / HubSpot(dry-run) / email ──► Supabase (calls, enquiries, call-backs, reviews)
                                                                          └──► dashboard (npm run dashboard) reads Supabase
```

Two ways Vani can run a call; both work:
- **BYOL (recommended, the default here):** Vani only does speech. Every sentence the assistant says comes from our engine, so the
  hard rules (no prices, no human claims, no referrals) are enforced in our code on every line.
- **Vani's own AI:** if you do not set BYOL, Vani's AI talks. We then receive the finished call, verify it against Vani's API, classify and route it.
  The pricing/behaviour rules are then only as good as the prompt you give Vani — we cannot enforce them. Not recommended.

## 1. You do these (I cannot: they need your account login and secrets)

### Vani — https://app.vaanivoice.ai
1. Sign in with your invite. Docs: https://docs.vaanivoice.ai/getting-started/create-account.md
2. **Create an agent** (Agent Config). Copy its **agent_id** (a UUID) → `VAANI_AGENT_ID`.
3. **Generate an API key** (docs: getting-started/generate-api-key). Format `vaani_…` → `VAANI_API_KEY`.
4. **Telephony** (Settings → Telephony): provision a number or bring a SIP trunk, and assign it to the agent.
   **Ask Vani support, in writing:** (a) can I get an Indian (Pune 020 / toll-free) inbound number, (b) how are INBOUND calls routed to an agent
   (their docs only describe outbound), (c) do webhooks carry a signature, (d) webhook retry/timeout behaviour.

### Supabase — https://supabase.com
1. New project (pick a region near India, e.g. Mumbai if offered).
2. SQL Editor → New query → paste `supabase/migrations/0001_init.sql` → Run. (Creates 6 locked-down tables: RLS on, no policies.)
3. Project Settings → API: copy **Project URL** → `SUPABASE_URL`, and the **service_role** key → `SUPABASE_SERVICE_ROLE_KEY`.
   The service-role key bypasses all security: it lives only in `.env` on the server. Never paste it in chat, a browser, or git.

### Your `.env` (copy from `.env.example`; edit the file yourself — do not paste keys into chat)
Generate the two secrets that YOU invent:
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # run twice
```
```
VAANI_API_KEY=vaani_…            VAANI_AGENT_ID=<agent uuid>
VAANI_WEBHOOK_SECRET=<random 1>  VAANI_BYOL_TOKEN=<random 2>
STORAGE_BACKEND=supabase         SUPABASE_URL=https://<ref>.supabase.co     SUPABASE_SERVICE_ROLE_KEY=…
GEMINI_API_KEY=<a NEW valid key; rotate the one that was pasted in chat>     GEMINI_BACKEND=aistudio
PORT=8787
```

## 2. Run the server and give it a public URL
```bash
npm run serve            # webhook + BYOL + call-back runner; prints warnings for anything missing
```
Vani must reach it over the internet. For a first test use a tunnel: `ngrok http 8787` → you get `https://abc123.ngrok-free.app`.
For production put it on a small always-on host (VPS / Render / Fly / Railway) behind HTTPS — URL below is `<host>`.

## 3. Configure Vani's dashboard
1. **Settings → Webhooks:** `https://<host>/webhooks/vaani/<VAANI_WEBHOOK_SECRET>`
2. **Agent → Brain → Reasoning Language Model (LLM) → "Bring your own LLM":**
   - URL: `wss://<host>/byol`  (Vani appends `/<call_id>`)
   - Auth Token: the value of `VAANI_BYOL_TOKEN`
   - **Test Connection**, then **Save URL**
   - Fallback: choose **No fallback**. (Vani's own LLM is not governed by our guard; a failed turn is safer as silence/hang-up than as an ungoverned answer.)
3. **Agent opening line / prompt:** Vani speaks the first sentence itself (our server cannot). Set it to exactly:
   > Hello, you've reached Aangan Studio. I'm the studio's AI assistant, and this call is recorded and transcribed so the team can follow up. How can I help you today?

   This is the AI + recording disclosure. Keep the rest of Vani's prompt minimal: BYOL ignores it (our `prompts/conversation.v1.md` is the only instruction used).
   After hours, our first reply adds "the designers are away right now…" automatically.
4. Language: pick Hindi + English (Marathi is not named in Vani's docs — test it).

## 4. Test, in this order
1. **No Vani needed:** `npm run serve` in one terminal, `npm run vani-sim -- --from "+919876543210"` in another. Type as the caller. This fires the documented webhooks and BYOL frames.
2. Check the result: `npm run dashboard` (or the Supabase table editor → `aangan_enquiries`).
3. **Real call, outbound to your own phone** (Vani dashboard "Create Dispatch", or `POST /api/trigger-call/`): confirms BYOL, webhooks and Supabase with the real platform.
4. **Real inbound call** once Vani confirms inbound routing for your number.
5. Only then: `AANGAN_LIVE=1` (this also enables Telegram/HubSpot/email sends — set up those credentials first; each stays dry-run if its credentials are missing).

## 5. How to read what happened
- Every Vani webhook is stored (`aangan_events`, type `vaani_event`; transcripts are not copied into events).
- `vaani_unverified` events = a `call_postprocessing` we refused because Vani's API did not confirm it (forged, or transcript not ready after ~24 s of polling).
- `byol_error` / `llm_error` events = a turn failed; the caller got a safe closing line and the call is routed to Amber for a human.
- `GET /health` shows storage backend, last Supabase error, active calls.

## 6. Known gaps (Vani's docs do not say; verify with them)
| Question | Our safeguard meanwhile |
|---|---|
| Webhook signature | secret in URL path + we re-fetch the call from Vani's API and ignore the webhook body |
| Webhook retries/timeouts | we answer 200 in milliseconds and de-duplicate |
| Inbound routing + India numbers | not assumed; test before promising "24×7" |
| Barge-in / interruption signalling over BYOL | undocumented; replies are short sentences so interruptions lose little |
| Whether `room_name` always equals the BYOL `call_id` | we treat them as the same id (the docs imply it); the sim and tests rely on it — confirm with a real call |
| Call-back (outbound) permission and DND | call-backs never skip the DND check (`dnd_check_skipped: false`) and stay dry-run until `AANGAN_LIVE=1` |
