# Aangan Enquiry System

Scope: inbound phone calls only. WhatsApp and web form are out of scope (extension note only).

## Tiers (from qualified.md)
- Green: passes all five criteria, or unclear only on budget or decision-maker (flag it in the note).
- Amber: timeline unclear or fixable, or no usable details (missed call).
- Red: out of area, advice-only, budget far below scope, or out-of-scope project type.
- Escalate: existing client complaint. Page Nikhil. Not a lead.

## AI can
Answer scope and area questions, ask one clarifying question, deflect pricing, book a consultation, decline politely.

## AI must never
Say any number, range or per-sq-ft figure (pricing.md is NOT in its context). Refer callers to other studios.
Promise dates or designers. Handle complaints. Claim to be human if asked.

## Pricing reply (verbatim)
"Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like."

## Routing
- Green only goes to HubSpot. Telegram note goes to the designer. Email is a backup log.
- Seed data (the 20 phone transcripts) is for testing only. Never push it to HubSpot.
- Every record carries source=live|seed. The HubSpot function must refuse source=seed in code.
- Merge duplicate caller numbers into one record.
- Everything is DRY-RUN by default. Secrets in .env only.

## Open questions for Nikhil
- Lead-time cut-off: 6 weeks (services.md) or 8-10 weeks (qualified.md)? Default: 8-10.
- Is there a 500 sq ft commercial minimum? It appears in T18 but not in services.md. Default: do not enforce, flag it.
