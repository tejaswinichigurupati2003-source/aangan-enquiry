import { isLive } from '../config.js';

/** Backup log by email (Resend-style HTTP API — verify the provider before going live). DRY-RUN by default. */
export async function sendEmail({ cfg, store, subject, text, enquiryId, fetchImpl = fetch }) {
  if (!isLive(cfg, ['EMAIL_API_KEY', 'EMAIL_FROM', 'EMAIL_TO'])) {
    store?.outboxPush({ channel: 'email', dryRun: true, enquiryId, subject, text });
    return { dryRun: true };
  }
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.env.EMAIL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: cfg.env.EMAIL_FROM, to: cfg.env.EMAIL_TO.split(','), subject, text }),
  });
  if (!res.ok) throw new Error(`Email ${res.status}`);
  store?.outboxPush({ channel: 'email', dryRun: false, enquiryId, subject });
  return { dryRun: false };
}
