# Team views, reassigning and consultations

## Who sees what
Pick your name in the **Viewing as** box (top right). Share `…/?as=designer_1` to give someone their own view.

| View | Tabs | Sees |
|---|---|---|
| Studio head | Overview, Leads, Schedule, Spot-check, Cost & health | everything, plus team workload |
| Front desk | Overview, Leads, Schedule | every lead (to assign and chase), no cost or spot-check |
| Designer | My day, Leads, Schedule | only their own leads and consultations |

This is a view, not a login. To keep strangers from *changing* things, set `DASHBOARD_TEAM_PIN` in Vercel (Settings → Environment Variables) and redeploy; the
page asks for the PIN once per browser. For real per-person privacy you need per-person logins.

## Owners
* A new Green lead is assigned automatically to the designer with the fewest open Green leads. Complaints go to the studio head. Amber leads wait unassigned.
* **Reassign** any lead from the Leads list (the Owner dropdown) or the lead panel. The designer group on Telegram gets "Lead reassigned: A → B".
* Edit the designers in `config.yaml` → `team.designers` (names are placeholders; add `email` to invite them to calendar events; `active: false` = away, no new leads).

## Booking a consultation
Open a lead → **Consultation** → pick date, time, length, designer → **Book**.
* The caller's own preferred slot is shown above the form.
* The same designer cannot be double-booked; Sundays and out-of-hours ask you to confirm.
* After booking you get **Add to Google Calendar** (opens pre-filled in your own calendar), **Download .ics**, and **Open that week** in the shared calendar.
* The designer group is told on Telegram. The AI itself still only *requests* a consultation on the call and never promises a time or a person.

### Why not write into Google Calendar directly?
That needs a Google service account that you create and add to the shared calendar. Once you have one, only `schedule()` in `src/actions.js` needs to call the
Calendar API (and store the event id). Until then the one-click link gives the same result with no credentials.

## Stages
Green: New → Contacted → Consultation booked → Consultation done → Won / Lost. Amber and complaints: New → Contacted → Resolved.

## Needs attention (Overview)
Live leads only: no designer, Telegram note not picked up within 30 min, no activity for 3 days, call-back due, consultation time passed. Thresholds are in `config.yaml` → `team`.

## The single studio calendar (works today, no Google credentials)
Every consultation — booked by the AI on a call or by a person on the dashboard — appears in one subscribable calendar feed:
`https://<your-dashboard>/api/calendar?token=<CALENDAR_FEED_TOKEN>` (add `&designer=designer_1` for one person's view).
Google Calendar → **Other calendars → + → From URL** → paste it. Google re-reads subscribed feeds every few hours (not instantly), so it is for *seeing* the studio's bookings;
the system itself never double-books because it checks its own records the moment a slot is offered. The token is the password: anyone with the URL can read the feed.
For instant blocking write straight into the calendar with a Google service account (see the header of `src/integrations/gcal.js`).

## Checking the whole chain
`node bin/e2e.js` plays a full simulated call with the real model and the real pipeline in dry-run; `node bin/e2e.js --live --cleanup` does it with the real
Telegram, HubSpot and Supabase (one test message lands in the designer group; the HubSpot contact and Supabase rows are deleted afterwards).
