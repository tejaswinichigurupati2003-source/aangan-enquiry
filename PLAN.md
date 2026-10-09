# PLAN — Aangan Studio phone-enquiry system

Scope: inbound phone calls only. WhatsApp / web form: see EXTENSION.md.

## 1. Architecture

```
caller (text simulator now; telephony adapter later)
   │ ring / answer / audio-as-text
   ▼
Telephony adapter (stub)  ──►  Conversation engine  ◄── prompts/conversation.v1.md
                                   │  LLM does: understanding + judgement (JSON)
                                   │  CODE does: what to say for price / bot / complaint /
                                   │             injection, tier decisions, clarifier limits,
                                   │             output guard on EVERY outbound line
                                   ▼
                              call record (store) ──► merge by caller number (enquiry)
                                   ▼
                              Classifier  ◄── prompts/classifier.v1.md
                              LLM: per-criterion verdicts + fields + flags (JSON)
                              CODE (rules.js): verdicts ──► tier
                                   ▼
                              Router
        Green ─► Telegram note (tap-to-call first line) + HubSpot (dry-run, live only, never seed) + email backup log
        Amber ─► front-desk queue (dashboard)
        Red   ─► log + polite-close script (no referrals) + spot-check list
        Escalate ─► page Nikhil (Telegram) + email; never HubSpot
                                   ▼
                              Dashboard (local web page + CLI report)
```

Key design choice: **the model judges, the code decides.** The LLM returns facts and
pass/fail/unclear verdicts with evidence. `src/rules.js` turns verdicts into a tier. This makes the
tier logic unit-testable, keeps it identical for live calls and the 20 seed transcripts, and means
fixing an eval failure means fixing a prompt or a general rule, never a per-transcript answer.

## 2. Stack and why
- **Node 26, zero npm dependencies** (Python is not installed on this machine; `fetch`, `node:test`,
  `node:http` are built in). Fewer dependencies = fewer things to break for a small studio.
- Storage: one JSON file (`data/runtime/db.json`), atomic writes. ~200 calls/month does not need a DB.
- Config: `config.yaml` (tiny built-in YAML subset parser) + `.env` (secrets only).
- LLM providers behind one interface: `gemini` (live), `recorded` (eval fixtures), `offline`
  (heuristic fallback so the simulator and graceful degradation work with no API).
- Dashboard: local web page (`node:http`, one HTML file, vanilla JS/SVG) **plus** a CLI report.
  A page because Nikhil wants to glance at it on a phone/laptop; a CLI report because it works over SSH
  and in tests.

## 3. Folder structure
```
CLAUDE.md PLAN.md DECISIONS.md README.md EXTENSION.md config.yaml .env.example
prompts/        versioned runtime prompts (conversation.v1.md, classifier.v1.md, CHANGELOG.md)
src/            guard, rules, classifier, engine, router, store, cost, phone, seed, config, yaml
src/llm/        gemini, recorded, offline, index
src/integrations/  telegram, hubspot, email  (all DRY-RUN by default)
src/telephony/  adapter interface + stub (no live number)
src/dashboard/  server, report, page.html
bin/            CLI entry points (call simulator, eval, demo, report, dashboard)
evals/          expected.json, scenarios/, inputs/ (what the classifier sees), runner
fixtures/       recorded model outputs (extractions/, conversations/)
tests/          node:test unit tests (guard, rules, seed-guard, merge, leak scan, adapters)
enquiries/      seed transcripts (source=seed, never pushed to HubSpot)
```
pricing.md is never read by any code or prompt. A test scans runtime-visible files for price-like
strings and fails the build if any appear.

## 4. Hard-rule enforcement map
| Rule | Where enforced | Test |
|---|---|---|
| No prices spoken | engine overrides price asks with the approved line; `guard.js` blocks+logs+substitutes on every outbound line | tests/guard.test.js, rogue-LLM scenario tests |
| pricing.md not visible to AI | no file reads it; leak scan | tests/no_pricing_leak.test.js |
| Tiers per rubric | rules.js | tests/rules.test.js + evals |
| No referrals / promised dates / complaints / human claim | fixed scripts in code, prompt rules, bot-disclosure override | engine tests, scenarios |
| HubSpot Green + live only | `hubspot.js` throws on source=seed or tier≠green | tests/hubspot.test.js |
| Secrets only in .env, dry-run default | config.js | tests/config.test.js |
| No fabricated costs | all unit costs in config.yaml marked ESTIMATE | cost test |

## 5. Risks
1. **No working LLM key at build time** (supplied Gemini key rejected). Evals run on recorded outputs
   produced by Claude subagents, not Gemini. Mitigation: provider interface, mock-server tests of the
   Gemini adapter, `npm run eval -- --provider gemini` to re-run live.
2. **Rubric/data conflicts** (lead time, 500 sq ft, missing timelines in seeds): defaults in DECISIONS.md.
3. **Model judges "far below budget" without price tables** (by design): may be inconsistent; the
   Red spot-check list exists so Nikhil can see over-strictness.
4. **Guard over-blocking** (any "around" + number). Chosen on purpose: safe failure.
5. **Voice latency, Hindi/Marathi STT quality, call-recording consent**: only addressable once
   telephony is wired; see README / final report.
