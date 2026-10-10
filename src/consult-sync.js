// Everything that must follow a consultation being booked, moved or cancelled, whoever did it (the AI on a call, or a person on the dashboard):
// put it on the studio's Google Calendar (blocks the slot) and e-mail the caller their confirmation. Both are DRY-RUN unless live credentials exist,
// and test/seed leads are always forced to dry-run. Never throws.
import { forceDryRun } from './config.js';
import { getTeam } from './team.js';
import { googleCalendarLink, buildIcs } from './calendar.js';
import { fmtWhen } from './actions.js';
import { syncCalendar } from './integrations/gcal.js';
import { sendEmail } from './integrations/email.js';

export async function syncConsultation({ cfg, store, enquiry, fetchImpl }) {
  const c = enquiry.consult;
  if (!c) return;
  const io = { cfg: enquiry.source === 'live' ? cfg : forceDryRun({ ...cfg, env: { ...cfg.env }, mode: { ...cfg.mode } }), store, fetchImpl };
  const designer = getTeam(cfg).owners.find((o) => o.id === c.designerId);
  try { await syncCalendar({ ...io, enquiry, designerName: designer?.name }); } catch (e) { store.event('calendar_error', { enquiryId: enquiry.id, error: e.message }); }
  const email = c.callerEmail || enquiry.fields?.email;
  if (c.status !== 'scheduled' || !email || c.callerNotifiedFor === c.start) return;
  try {
    const when = `${fmtWhen(cfg, c.start)} IST`;
    const first = String(enquiry.fields?.name || '').split(/\s+/)[0];
    const sent = await sendEmail({
      ...io, to: email, enquiryId: enquiry.id, subject: `Your Aangan Studio consultation — ${when}`,
      text: `Hello${first ? ` ${first}` : ''},\n\nYour consultation with Aangan Studio is booked for ${when}.\nAdd it to your calendar: ${googleCalendarLink(enquiry, designer, cfg)}\n\nOur team will confirm the details with you directly. If this time no longer suits you, just reply to this email.\n\nAangan Studio, Pune`,
      attachments: [{ filename: 'aangan-consultation.ics', content: Buffer.from(buildIcs(enquiry, designer, cfg)).toString('base64') }],
    });
    if (!sent.dryRun) c.callerNotifiedFor = c.start; // a dry run must not count as "told the caller"
  } catch (e) { store.event('email_error', { enquiryId: enquiry.id, error: e.message }); }
}
