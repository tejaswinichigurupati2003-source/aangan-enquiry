# Aangan Studio — phone-enquiry system

Answers every inbound call (text simulator now, telephony later), qualifies it against Nikhil's five-criteria rubric,
hands **Green** leads to designers on Telegram with everything already asked, queues Amber for the front desk, declines Red
politely, pages Nikhil on existing-client complaints, and shows response time, yield and running cost on a dashboard.

**Everything is DRY-RUN by default.** No call, Telegram message, email or CRM write leaves this machine until you flip the
live flag *and* provide credentials. Scope is inbound phone calls only (WhatsApp / web form: see [EXTENSION.md](EXTENSION.md)).

## Run it (Node 20+; zero npm dependencies)

```bash
npm test                          # 78 unit/integration tests (guard, rules, seed-guard, merge, adapters, leak scan, dashboard, Vani, Supabase)
npm run eval                      # T01–T20 + 11 extra scenarios on recorded model outputs (no API needed)
npm run eval -- --write-report    # same, also writes EVAL_RESULTS.md
npm run eval -- --provider gemini --write-report  # live Gemini (~4 min); writes EVAL_RESULTS_gemini.md. Last run: 20/20 and 13/13
npm run call                      # talk to the assistant yourself (type as the caller)
npm run call -- --provider offline --at 2026-10-09T23:40:00+05:30   # offline heuristic model, pretend it is 11:40pm
npm run demo                      # fill data/demo with T01–T20 + scenarios, print the report
npm run dashboard -- --dir data/demo   # http://127.0.0.1:4177
npm run serve                     # Vani webhook + BYOL server (see docs/VANI_SETUP.md)
npm run vani-sim                  # pretend to be Vani to test the server
npm run report                    # the same numbers as a CLI report (add: -- --dir data/demo --source live)
```

Why a local web page *and* a CLI report: Nikhil wants to glance at it on a phone or laptop (page); the CLI report works over
SSH, in cron/email, and in tests. Both read the same `computeMetrics()` so they cannot disagree.

## How a call flows

```
caller ─► telephony adapter ─► conversation engine ─► call record ─► merge by caller number ─► classifier ─► router
                                (LLM judges+phrases;                   (same number, 14 days,     (LLM facts +       Green  → Telegram + HubSpot + email
                                 CODE owns price/bot/complaint/                 never seed↔live)    code rules → tier)  Amber  → front-desk queue (+ call-backs)
                                 injection/decline/close + guard)                                                      Red    → log + polite close + spot-check
                                                                                                                       Escalate → page Nikhil (never HubSpot)
```

**The model judges, the code decides.** The LLM returns facts and pass/fail/unclear verdicts with evidence
(`prompts/*.md`); `src/rules.js` turns them into a tier. Anything with policy weight — the pricing line, AI disclosure,
complaint script, decline scripts, closing, which question is asked next — is code, not model wording.
Every spoken line passes `src/guard.js` (prices, human claims, referrals, promised call times).

| Folder | What |
|---|---|
| `prompts/` | versioned runtime prompts (`conversation.v1.md`, `classifier.v1.md`) + CHANGELOG. Versions are stored on every call. |
| `src/` | `guard` `rules` `classifier` `engine` `router` `store` `cost` `metrics` `notes` `scripts` `seed` `simulate` |
| `src/llm/` | `gemini` (live), `recorded` (eval fixtures), `offline` (heuristic fallback), `scripted` (tests) |
| `src/integrations/` | `telegram` `hubspot` `email` — all dry-run by default |
| `src/telephony/` | adapter interface, `StubTelephony`, `exotel.stub.js` (refuses to run) |
| `evals/` `fixtures/` | oracle, scenarios, exact model inputs, recorded model outputs |
| `config.yaml` | rules, service area, costs (every unit price marked **ESTIMATE** with where to confirm it) |
| `.env.example` | every secret/flag; real `.env` is git-ignored |

## Going live (checklist)

1. **LLM key.** Put a valid `GEMINI_API_KEY` in `.env` (`GEMINI_BACKEND=aistudio` for `AIza…` keys, `vertex` for Vertex express `AQ.…` keys).
   The key supplied during the build was rejected by both backends. Then run `npm run eval -- --provider gemini` and read the diffs
   before trusting it. Confirm model ids and prices in `config.yaml` (they are estimates).
2. **Telegram.** Create a bot, add it to the designers' group and a private chat with Nikhil; set `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_DESIGNER_CHAT_ID`, `TELEGRAM_NIKHIL_CHAT_ID`. Designer-pickup times need a webhook or poller that passes
   `callback_query` updates to `handleTelegramUpdate()` (not included; the button + recorder are).
3. **HubSpot.** Private-app token with contacts read/write. Create four custom contact properties first:
   `aangan_source`, `aangan_tier`, `aangan_flags`, `aangan_summary`. Only `source=live` **Green** leads are ever sent.
4. **Email backup.** `EMAIL_API_KEY / EMAIL_FROM / EMAIL_TO` (Resend-style HTTP API — swap the provider if you prefer).
5. Set `AANGAN_LIVE=1`. Each integration still needs its own credentials; with any missing it stays dry-run.
6. **Telephony** (below). Nothing is wired — that is a separate, deliberate step.
7. Have a lawyer review the consent/retention points in the final report.

## Vani + Supabase (chosen telephony and storage)

See **[docs/VANI_SETUP.md](docs/VANI_SETUP.md)** for the step-by-step. Short version: `npm run serve` runs the webhook receiver and the BYOL WebSocket
(Vani speaks, our engine decides every line); `STORAGE_BACKEND=supabase` + `supabase/migrations/0001_init.sql` moves storage to Supabase;
`npm run vani-sim` lets you test the whole thing with no Vani account.

## Telephony adapter — providers to verify

`src/telephony/adapter.js` is the interface (`onIncomingCall / answer / say / hangup / placeCallback`). `exotel.stub.js`
documents the wiring checklist and **refuses to run**. Candidates to evaluate (verify everything; this list is not a recommendation):

| Option | Why consider | Check before choosing |
|---|---|---|
| Exotel, Knowlarity, Ozonetel, MyOperator, Servetel | Indian cloud-telephony vendors, local numbers and support | Real-time audio streaming API (WebSocket/media stream) for an AI agent; Pune (020) or toll-free numbers; KYC lead time; per-minute inbound price; concurrency; recording and webhook features |
| Twilio / Plivo / Vonage | Strong developer tooling | **Indian number availability and regulatory limits**; latency from India; ability to port the studio's existing number; local compliance |
| Voice-AI platforms with India telephony | Faster to a first call | Data residency, who stores recordings/transcripts, Hindi/Marathi quality, per-minute total cost, whether our guard/rules can sit in front of the model |

Also verify for any option: caller-ID pass-through; missed-call and status webhooks; call-back (outbound) permission and DND/DLT rules;
Hindi + Marathi + English STT/TTS quality and price; barge-in and end-of-speech latency; failover to a human; call-recording consent tooling;
DPDP-Act data-processing terms; cost at ~200 calls/month vs. fixed plan fees.

## Safety invariants (each has a test)

- No price/range/per-area figure ever reaches the caller: engine override + guard, proven against a rogue model.
- `pricing.md` is read by nothing; no pricing figure exists in any prompt, source, config or fixture (leak scan).
- HubSpot refuses `source≠live` and tier≠green in code, before any dry-run branch.
- No human claim, no referrals, no promised times (policy guard + prompts + scripts).
- A classifier failure routes to Amber for a human; it never drops or auto-pushes a lead.
- Secrets only in `.env`; dry-run unless `AANGAN_LIVE=1` **and** credentials exist.

See [PLAN.md](PLAN.md), [DECISIONS.md](DECISIONS.md) (⚑ = please review), [EVAL_RESULTS.md](EVAL_RESULTS.md).
