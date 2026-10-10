# DECISIONS

Format: decision — alternatives — why. ⚑ = please review.

## D1 ⚑ LLM access: supplied Gemini key was rejected; evals run on recorded outputs
Both Google AI Studio (`generativelanguage.googleapis.com`) and Vertex (`aiplatform.googleapis.com`)
returned 401 for the supplied key (`AQ.` prefix = Vertex-express style; reported as
ACCESS_TOKEN_TYPE_UNSUPPORTED / invalid credentials). Possibly expired, mistyped or restricted.
- Built: Gemini adapter (both backends), tested against a local mock server for request/response shape.
- Evals: classifier outputs for T01–T20 and my extra scenarios were produced **blind** (the producer saw
  only `prompts/*.md` and the exact model input, never the expected tiers) by Claude subagents and saved to
  `fixtures/`. Deterministic parts (rules, guard, overrides, routing, merge, cost) run live.
- ⚑ Therefore the eval results prove the **rules + prompts + plumbing**, not Gemini's behaviour. Re-run
  `npm run eval -- --provider gemini` once a valid key is in `.env`.
- The key was pasted in chat → treat as exposed; rotate it.

## D2 Stack: Node, zero dependencies
Python is not installed here. Alternatives: install Python + SDKs; TypeScript build step. Chose plain
ESM JavaScript on the Node already present; `fetch`/`node:test`/`node:http` cover everything.

## D3 The model judges, the code decides
LLM returns verdicts+evidence+fields; `rules.js` computes tiers. Alternative (LLM returns the tier) is
less testable and drifts between runs. Same rules code serves live calls and seed transcripts.

## D4 ⚑ Lead time = 8–10 weeks (not 6)
Per brief default. Interpreted as minimum lead time from the call to the caller's required completion
date: <8 weeks = timeline fails (fixable → Amber); 8–10 = pass + `timeline_tight` flag; >10 = pass.
Stated month → earliest date the words allow. A caller with no completion deadline (T15: "possession in
six weeks, start right away") passes. services.md's own durations (design 3–4 wk + execution 8–16 wk) do
not reconcile with either number — Nikhil to confirm.

## D5 ⚑ 500 sq ft commercial minimum: flag, don't enforce
`commercial_min_enforced: false`; below `commercial_min_sqft_flag` adds `commercial_min_unconfirmed`.
T18 still has to be Red, so criterion 1 is read as: a single pod/booth/desk/corner inside another space,
wanting lighting + desk + storage, is furnishing/decor, not a fit-out with execution
(`fail_reason: decor_or_sourcing_only`). This sentence is general in the prompt, but it is T18-shaped —
⚑ review.

## D6 ⚑ "Timeline not discussed" = soft pass + flag
T11, T13, T14, T16 are expected Green but contain no timeline. Strict rubric reading (unclear → Amber) would
fail them. Rule: no timeline mentioned and no urgency cue → pass with `timeline_not_confirmed`
(mirrors qualified.md: "budget not mentioned → treat as qualified"). A stated-but-vague/urgent timeline
("ASAP", "before X" with no way to compute) = unclear → Amber. Green still needs criteria 1 and 2 positively
established, so dropped/empty calls stay Amber. The live engine always asks the timeline.

## D7 A timeline failure alone is never Red
CLAUDE.md's Red list does not include timeline; T07 expects Amber. Timeline + any other failure → Red
(reason = the other failure).

## D8 ⚑ "Far below budget" without price tables
pricing.md numbers must not enter any AI-visible file, so the model judges with general market sense and
only the caller's own volunteered figure. Nikhil's own example figure is paraphrased out of the prompts.
Offline provider never declines on budget (fails open). AI never echoes a caller's figure (guard bans
"lakh" etc.). Evidence strings in outputs must not repeat figures.

## D9 Seed front-desk behaviour is not copied
Seeds contain referrals (T10 contractors, T18 designer, T19 search advice), promised times (T09, T12) and a
multiple-of-cost remark (T13). Prompts forbid all of these; seeds are classifier input only.

## D10 T16 is a prospect, not a client → Green + flags (`prior_enquiry_dropped`, `caller_frustrated`)
Escalate is only for existing-client complaints (T09). AI says one short apology, never "handles" it.
T09: AI promises no callback time and names nobody.

## D11 Booking = consultation request
No calendar exists. The AI captures a preferred day/time window; the designer confirms. It never confirms a
slot or names a designer. The approved pricing line promises "book" — satisfied by the request.

## D12 Guard is stricter than the brief
Blocks ₹, Rs/INR/rupees, lakh/lac/crore, 50k-style amounts, "per sq ft/foot", "rate(s)", "starts at",
"around/approximately/roughly + number", "cost(s) about…", multiples ("3x the cost"), Devanagari
forms, and comma-grouped amounts that are not followed by "sq ft". Over-blocking is the safe failure.
Pricing line is English-only verbatim (also for Hindi callers) until Nikhil approves a translation.
On repeated price asks a short non-numeric lead-in may precede the verbatim line.

## D13 AI avoids numerals about money AND about timelines
CLAUDE.md says the AI never says "any number". Read in the pricing context, but the prompt also steers the AI
away from quoting week counts ("a couple of months of lead time").

## D14 Merge duplicates by normalised number + source, 14-day window
Seeds and live never merge together. Merged enquiry is re-classified on the combined transcript.

## D15 Routing detail
Green → Telegram + HubSpot (dry-run; live only) + email backup. Escalate → Telegram to Nikhil + email.
Amber → dashboard queue only. Red → log + close script + spot-check. Quiet hours 22:00–08:00: Telegram
sent silently. Designer pickup time = inline "Got it" button (simulated in dry-run).

## D16 Missed/after-hours (T08)
System answers 24/7, so a "missed" call is a telephony failure: Amber, "no usable details", callback
attempts scheduled via the adapter (next morning, then two more) and logged; WhatsApp/SMS not used.

## D17 Recording/consent
No audio stored; text transcripts only. Greeting discloses AI + recording/transcription. See README risks.

## D18 Fail-safe classification
Any classifier error/invalid JSON/provider failure → Amber `classifier_error` for human review. A lead is
never silently dropped, and never auto-pushed to HubSpot on a failure.

## D19 Costs
All unit costs in `config.yaml` marked ESTIMATE with where to confirm. Token counts for recorded/offline
runs are estimated (chars/4) and labelled as such. Cost per Green lead = total spend ÷ Green leads.

## D20 Seed data gaps
No phone numbers in the seed → obviously fake numbers (`+91 00000 000NN`), source=seed. T16's Monday call
is not in the file → synthetic prior-call fixture for the merge test. Seed weekday labels are inconsistent
(19 Sept 2026 is a Saturday); weekdays are not used in any logic. T07 says Diwali is ~3 weeks away; the
classifier uses only durations the caller/desk state, never festival dates.

---
## Added during the build

## D21 Code owns the next question; model wording is used only when it asks that field
First dumped transcripts showed drift (the engine passed through model wording that asked something else). Now the engine
decides what is asked (intake order, one clarifying question per unclear criterion, enforced in code) and uses the model's
sentence only if it asks exactly the wanted field with exactly one question; otherwise "short acknowledgement + standard question".
Cost: slightly less varied phrasing. Benefit: the dialogue cannot desync, and clarifier limits hold whatever the model does.

## D22 ⚑ Policy guard added next to the pricing guard
Brief asked for a price guard. Hard rule 3 (no human claim, no referral, no promised times) had no code backstop, so
`guard.js` also blocks human claims, referrals ("try another studio") and promised call times and substitutes safe lines.
Regex-based = will have misses; the prompts and scripts are the first line, this is the last.

## D23 Noisy / inaudible line handler (no model call)
`[noise]`-style markers (the text simulator's stand-in for low STT confidence) → ask to repeat; second time → polite close and
call-back. Avoids a model hallucinating details from garbage and saves tokens. Real telephony should feed STT confidence into the same switch.

## D24 Offline heuristic provider
Degraded-mode fallback (model down/401) and what lets `npm run call` work with no API. It cannot judge "budget far below scope"
(fails open) and understands only simple phrasing. NOT used for the T01–T20 evals (that would be tuning code to 20 transcripts).

## D25 ⚑ How the recorded evals were produced (be sceptical of them accordingly)
Subagents played the model, blind: they saw `prompts/*.md` and the exact model input only. Two phases for scenarios: conversation
turns first, then classifier outputs from the transcripts the real engine produced. Sanity checks: a rate-tightening control flips exactly
T02; a rubber-stamp model fails 9 seeds. Bug found by this process: the harness read recorded turns one index off (fixed).
Nothing here proves Gemini's behaviour.

## D26 Seed notes and headers are withheld from the model
"Note: Escalated to studio head", "— ESCALATE", "Handle with care" would hand over the answer, so the model sees dialogue only.

## D27 Dropped/low-content call rule
Total caller words < 4, or every call a drop with < 15 caller words, → Amber "no usable details" without a model call.

## D28 Cost model
Telephony billed per started minute; hosting amortised over `expected_calls_per_month`; STT on call minutes; TTS on agent characters;
seed calls get *modelled* conversation tokens (one turn per caller utterance re-sending prompt + history). Scenario calls are terse
(40–140 s) versus real seed calls (3–7 min), so per-call cost on the live slice is lower than a real day will be.

## D29 Dashboard
Local only (127.0.0.1), no auth. Spot-check verdicts stored in the DB. "Gross pipeline" (Green × Nikhil's stated average project
value) shown for the Live view only and labelled not-a-forecast. Median "time to answer" is a simulator number until real telephony reports one.

## D30 Booking is a consultation request; designer pickup measured by an inline "Got it" button
(See D11/D15.) The webhook/poller that receives the tap is not included.

---
## Vani + Supabase integration

## D31 ⚑ Vani runs speech only; OUR engine speaks every line (BYOL) — default
Vani's "Bring Your Own LLM" WebSocket sends each caller turn to us and speaks what we stream back. This keeps the pricing line, AI disclosure,
policy guard and clarifier limits enforced in code. Alternative (Vani's own AI talks) is supported only as a post-call path and cannot enforce rules.
Vani's own system prompt (transcript[0]) is ignored. Fallback in Vani must be "No fallback".

## D32 Webhooks are not trusted
Vani documents no signature. Secret in the URL path (constant-time compare) + for `call_postprocessing` we re-fetch the call via Vani's API and
use THAT transcript; unverifiable events create no lead. Duplicates are suppressed. We answer 200 immediately and process in the background.

## D33 Vani speaks the greeting
Vani's agent speaks a fixed opening line configured in its dashboard (our handshake "greeting" frame is discarded by Vani). The line is our
disclosure text; the after-hours sentence rides on our first reply (`externalGreeting`).

## D34 Supabase = JSONB documents + a few typed columns, write-through from an in-memory store
Keeps engine/router/metrics synchronous and unchanged. Only changed rows are upserted; an outage leaves data in memory and retries. Tables have RLS on with
no policies and anon/authenticated revoked: only the server's service-role key can touch them. Dashboard reads Supabase with a 10 s cache.
Trade-off: single writer (the serve process). Fine for ~200 calls/month; revisit if you add a second writer.

## D35 Zero-dependency WebSocket server
Hand-written RFC 6455 server (text/ping/close/fragments, masked client frames required, 4 MiB cap). Tested against Node's built-in WebSocket client.
Alternative: the `ws` package. Revisit if Vani needs permessage-deflate or other extensions.

## D36 Call-backs through Vani's trigger-call, DND never skipped, dry-run until live
Due call-backs for live Amber calls dial via `POST /api/trigger-call/`; seed and already-resolved ones are skipped. Whether an AI call-back to a missed
caller is acceptable under DND/consent rules is a legal question — kept off by the dry-run default.

## First live Gemini run (2026-10-09) — what the recorded evals could not show
## D37 ⚑ Live results and the four real problems found
Live Gemini (classifier `gemini-3.8-flash`, conversation `gemini-3.1-flash-lite`): **T01–T20 20/20, scenarios 13/13** (see EVAL_RESULTS_gemini.md).
Getting there exposed things a recorded run cannot:
1. **Truncated JSON** — hidden "thinking" tokens count against `maxOutputTokens`; a cap of 800 cut the classifier's JSON mid-string (finishReason MAX_TOKENS)
   → 6/20 seeds fell to the Amber fail-safe. Fixed: per-task caps (4096 classifier / 800 conversation), thinking budgets (1024 / 0), explicit
   truncation error, and no blind retry on a parse failure. The fail-safe worked as designed (nothing dropped, nothing pushed).
2. **Hinglish** — Gemini answered a Hinglish caller in English and reported "en". Fixed in code (language decided from the caller's words and sent as
   `STATE.reply_language`; engine falls back to its Hinglish template if the model ignores it) + prompt v2.
3. **Latency** — `gemini-3.8-flash` ≈ 4–6 s per turn (too slow for speech); `gemini-3.1-flash-lite` with thinking off ≈ 1.6 s. Still above the ~1 s ideal;
   streaming from Gemini and a faster "first words" reply are the next optimisation.
4. **Monitoring blind spot** — HubSpot outbox rows carried no enquiry id, so the dashboard "seed records in HubSpot" counter could never trigger. Fixed + tested.
Also: `gemini-2.5-flash` is retired for new keys; model ids need periodic re-checking. Prices for the new models are NOT confirmed (default estimate row used).

## D38 Shared Supabase project
The project already hosts a movie app and a "kargo" recruiting app. Our migration is additive only (verified: every existing table, column, RLS flag, policy and
row count identical before/after), tables are `aangan_*`, columns `aan_*`. ⚑ The kargo tables have RLS OFF (candidate names, emails, phones, CV text) — with
RLS off, the public/publishable key can read them. Not touched (out of scope), but worth fixing in that app.

## D39 Lead ownership, stages and consultations live inside the enquiry record
`assignment` (owner, who/when, auto flag), `stage`, `consult` (start/end/designer/status) and `activity` (timeline) are stored on the enquiry JSON, so JSON and
Supabase persist them with **no schema change**. Green leads are auto-assigned to the designer with the fewest open Green leads (ties: config order); Escalate goes
to the studio head; Amber waits unowned in the queue. A person's assignment is never overridden. Reassigning, booking, cancelling and notes are logged and a short
message is posted to the designer Telegram group (test data is forced to dry-run, as everywhere). The AI never names or promises a designer — a test scans every
spoken script for designer names.
Designer names in `config.yaml` (`team:`) are PLACEHOLDERS — replace them; keep each `id` stable once leads are assigned.

## D40 Calendar: one-click Google Calendar link + .ics, not a silent write
Writing straight into the studio's Google Calendar needs credentials only the studio can create (Google service account / OAuth). Until then a booking produces an
"Add to Google Calendar" link (opens pre-filled in the signed-in person's own calendar, with the designer as a guest if their email is configured), a standard
.ics download, and a link to that week in the shared calendar. Double-booking the same designer is refused in code; Sundays and out-of-hours need an explicit confirm.
Upgrade path: a service account that is a member of the shared calendar → create the event in `actions.schedule` (one function) and store the event id on `consult`.

## D41 Per-person views are a view, not a login
The "Viewing as" selector (studio head / front desk / each designer) changes what is shown and defaults the filters; `?as=designer_1` makes a shareable link.
It is NOT access control: with the dashboard login off, anyone with the link can switch. Real per-person privacy needs per-person logins (Vercel/Supabase auth).
Because changing things is riskier than reading, writes can require a shared **team PIN** (`DASHBOARD_TEAM_PIN`, only when `DASHBOARD_AUTH=off`).

## D42 Dashboard de-duplicated
Removed repeats: the sidebar guardrail card (the same numbers are on Cost & health), the cost KPI on Overview (lives on Cost & health), the separate Follow-ups and
Safety/Costs tabs (merged into one Leads list with filters, and one Cost & health tab), the Green-leads table that duplicated the Follow-ups queue, and two footers.
Added: needs-attention list, per-role home, lead drawer (owner, stage, consultation, notes, transcript), week schedule, workload, search ( / ), CSV export.

## D43 ⚑ The AI books a consultation slot on the call (owner request 2026-10-10) — changes a hard rule
Before: the AI only captured a preferred window and the team confirmed. Now (live calls, `booking.enabled` in config.yaml): after the Green intake and the caller's preferred window,
CODE offers a real slot (office hours, Mon–Sat, at least 24 h ahead, at least one active designer free, other in-progress calls' holds counted), the caller says yes, the AI asks for
their e-mail, reads it back for confirmation, and holds the slot. When the call ends the hold becomes a consultation on the lead (same rules as a dashboard booking: no
double-booking), the designer group is told on Telegram, the studio's Google Calendar event is created (blocks the slot) and the caller is e-mailed a confirmation with an .ics.
Safety: the booking turns are fully scripted (no model call), every line passes the guard, no designer is ever named, a caller who declines to give an e-mail is still booked
(team confirms by phone), a slot that is taken before the call ends is reported to the team instead of double-booked, and bot-disclosure / pricing questions still win mid-booking.
This overrides "never promise dates" ONLY for slots the system has really held. The Vani-side prompt (used when Vani's own model answers instead of our BYOL engine) is unchanged and
still only takes a request. Real Google Calendar writes need a service account (gcal.js header); without it everything is dry-run and the dashboard shows the slot.
Hinglish booking lines need native-speaker review like the others (D12).

## D44 HubSpot: one pipeline, renamed; deals follow the dashboard stages
The free HubSpot plan allows ONE deal pipeline (the portal's "Education Sales Pipeline"). With the owner's OK it was renamed **Aangan Enquiries** and its six stages renamed in place
(ids kept): New lead, Contacted, Consultation booked, Consultation done, Won, Lost. Each live Green lead gets a deal that moves with the dashboard stage (hubspot-deals.js; stage
ids are looked up by label). Needs deal scopes on the HubSpot key (crm.objects.deals.read/write, crm.schemas.deals.read) — until added, the contact sync keeps working and one
`hubspot_deals_scopes_missing` event is logged. Stage probabilities (10/30/60/80 %) are left as they were; adjust them to your own sense of conversion.
