# Connecting HubSpot

**What gets sent:** only **Green, live** leads (never seed/test data, never Amber/Red/Escalate): one HubSpot *contact* per caller,
matched by phone number (so a repeat caller updates the same contact instead of duplicating it).

| HubSpot field | Filled with |
|---|---|
| First name / Last name | from the call |
| Phone | caller number (E.164) |
| City | locality (e.g. Kothrud) |
| Lead status / Lifecycle stage | `NEW` / `lead` |
| `aangan_source`, `aangan_tier`, `aangan_flags`, `aangan_summary` | custom properties (created by step 3) |

## Steps (you do 1–2 in HubSpot; the script does 3)
1. **Create a Private App** — HubSpot → ⚙ Settings → Integrations → **Private Apps** → *Create a private app* → name it `Aangan phone assistant`.
2. **Scopes** tab → tick:
   - `crm.objects.contacts.read`
   - `crm.objects.contacts.write`
   - `crm.schemas.contacts.write` (only needed once, to create the four custom properties — you can remove it afterwards)

   Create the app and **copy the access token** (starts `pat-…`). Put it in `.env` yourself: `HUBSPOT_TOKEN=pat-…` (never paste it in chat).
3. **Create the custom properties:**
   ```bash
   node bin/hubspot-setup.js          # check only: tests the token, lists what is missing
   node bin/hubspot-setup.js --apply  # creates the missing ones
   ```
4. **Try it safely (dry-run is the default):** `npm run call` or `npm run vani-sim` — Green calls show `hubspot:dry_run` and the payload sits in the outbox.
5. **Go live:** set `AANGAN_LIVE=1` in `.env`. HubSpot is then written (only with `HUBSPOT_TOKEN` present). Telegram/email also go live at the same moment
   if their credentials are set, so set those up first, or leave them blank to keep them dry-run.

## Safety
- The seed guard is in code: `pushLeadToHubspot` throws for anything that is not `source="live"` and `tier="green"`, before any dry-run branch (tested).
- A HubSpot error never loses the lead: the Telegram note and the Supabase record are written first; the error is logged (`hubspot_error` event) and shown on the dashboard.
- Free-tier HubSpot is enough: contacts + custom properties are available on the free CRM.
