# Deploying

Two pieces, two hosts — because they behave differently:

| Piece | What it does | Needs | Host |
|---|---|---|---|
| **Call server** (`bin/serve.js`) | Vani webhooks + the live per-call WebSocket (BYOL) + call-back runner | a long-lived process that can hold WebSockets, always on | **Render** (`render.yaml`) — NOT Vercel (serverless functions cannot hold a WebSocket server) |
| **Dashboard** (`api/*.js`, `src/dashboard/page.html`) | Read-only view of calls/leads/costs, Red spot-check | stateless HTTPS functions | **Vercel** (already deployed) |

Source of truth: the private GitHub repo `tejaswinichigurupati2003-source/aangan-enquiry`. No secret is committed (`.env` is git-ignored).

## Dashboard on Vercel (done)
- URL: https://aangan-dashboard-gamma.vercel.app — **login currently OFF (`DASHBOARD_AUTH=off`, owner decision 2026-10-09): anyone with the link sees phone numbers and transcripts.** To re-enable: `vercel env rm DASHBOARD_AUTH production` and redeploy. Login (when on): HTTP Basic. Username/password are `DASHBOARD_USER` / `DASHBOARD_PASSWORD` in your local `.env`
  (also stored, hidden, as Vercel environment variables). With no password configured it refuses to serve (503).
- It reads Supabase with the server-side secret key stored as a *sensitive* Vercel env var. Anyone with the dashboard login can see caller phone numbers and transcripts.
- Redeploy after changes: `vercel deploy --prod`. Change the password: edit `.env`, then `vercel env add DASHBOARD_PASSWORD production --force --sensitive` and redeploy.
- Optional: connect the GitHub repo in the Vercel dashboard (Project → Git) so every push to `main` redeploys.

## Call server on Render (you do this; it needs your Render login)
1. Render → **New → Blueprint** → select the GitHub repo (Render reads `render.yaml`).
2. Fill the secret env vars it lists (values are in your local `.env`; type/paste them in Render's UI, never in chat or git).
3. Use an **always-on paid plan** (free plans sleep and would drop live calls).
4. After deploy, put these in the Vani dashboard:
   - Webhook: `https://<service>.onrender.com/webhooks/vaani/<VAANI_WEBHOOK_SECRET>`
   - BYOL: `wss://<service>.onrender.com/byol` with auth token = `VAANI_BYOL_TOKEN`
5. `GET https://<service>.onrender.com/health` should say `{"ok":true,"storage":"supabase",…}`.
Alternatives to Render with the same shape: Fly.io, Railway, any VPS with a reverse proxy (needs WebSocket upgrade support).
