// CLI report — same numbers as the web dashboard, for terminals, SSH and tests.
const pct = (x) => (x == null ? 'n/a' : `${Math.round(x * 100)}%`);
const inr = (x, cur = 'INR') => (x == null ? 'n/a' : `${cur} ${x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const secs = (ms) => (ms == null ? 'n/a' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

export function renderReport(m) {
  const L = [];
  const h = (t) => L.push('', `── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`);
  L.push(`AANGAN STUDIO — PHONE ENQUIRY REPORT  (view: ${m.source})   ${m.generatedAt}`);
  L.push(`Calls: ${m.totals.calls}   Enquiries: ${m.totals.enquiries}   (merged repeat callers: ${m.totals.mergedEnquiries})`);
  h('Calls by tier (enquiries)');
  L.push(`Green ${m.tiers.green}   Amber ${m.tiers.amber}   Red ${m.tiers.red}   Escalate ${m.tiers.escalate}`);
  h('Time to answer');
  L.push(`AI-answered calls: ${m.answer.aiHandled}   median ring-to-answer: ${secs(m.answer.medianMs)}   answered inside 5 min: ${pct(m.answer.within5minShare)}`);
  L.push(`Calls outside 10am–7pm: ${m.answer.afterHoursCalls} (${pct(m.answer.afterHoursShare)})   missed calls: ${m.answer.missedCalls}`);
  L.push(`(${m.answer.note})`);
  h('Green handoffs & designer pickup');
  L.push(`Green handoffs: ${m.handoff.greenHandoffs}   median call-end → Telegram: ${m.handoff.medianHandoffSec ?? 'n/a'} s`);
  L.push(`Designer pickup: acked ${m.handoff.designerPickup.acked}, pending ${m.handoff.designerPickup.pending}, median ${m.handoff.designerPickup.medianMin ?? 'n/a'} min`);
  h(`Cost (${m.cost.currency}; every unit price is an ESTIMATE from config.yaml)`);
  L.push(`Total: ${inr(m.cost.totalSpend, m.cost.currency)}   per call: ${inr(m.cost.perCall, m.cost.currency)}   per Green lead: ${inr(m.cost.perGreenLead, m.cost.currency)}`);
  if (m.cost.perCallBreakdown) L.push(`Per call: ${Object.entries(m.cost.perCallBreakdown).map(([k, v]) => `${k} ${v}`).join('  ·  ')}`);
  L.push(`Projected month at ${m.cost.monthlyProjection.calls} calls: ${inr(m.cost.monthlyProjection.spend, m.cost.currency)}`);
  const f = m.cost.flags;
  L.push(`Caveats: tokens ${f.tokensEstimated ? 'ESTIMATED (chars/4)' : 'reported by provider'}${f.conversationModelled ? '; conversation tokens MODELLED for human-handled seed calls' : ''}.`);
  if (m.pipeline) L.push(`Gross pipeline of Green leads (not a forecast): ${inr(m.pipeline.grossValueMin)} – ${inr(m.pipeline.grossValueMax)}`);
  h('Amber — front-desk queue');
  if (!m.ambers.length) L.push('(none)');
  for (const a of m.ambers) L.push(`• ${a.phone ?? 'no number'}  [${a.source}]  ${a.reason}${a.callbacks.length ? `  call-backs: ${a.callbacks.map((c) => `#${c.attempt} ${c.dueAt.slice(5, 16)} ${c.status}`).join(', ')}` : ''}`);
  h('Red — spot-check list (is the AI too strict?)');
  if (!m.reds.length) L.push('(none)');
  for (const r of m.reds) L.push(`• ${r.phone ?? 'no number'}  [${r.source}]  ${r.reason}  — ${r.summary ?? ''}${r.review ? `  [reviewed: ${r.review.verdict}]` : '  [not reviewed]'}`);
  L.push(`Reviewed ${m.redReview.reviewed}/${m.redReview.total}; marked too strict: ${m.redReview.tooStrict} (${pct(m.redReview.tooStrictRate)})`);
  if (m.escalations.length) { h('Escalations (paged Nikhil)'); for (const e of m.escalations) L.push(`• ${e.phone}  ${e.summary ?? ''}`); }
  h('Safety counters');
  L.push(`Guard blocked lines: ${m.safety.guardBlocked}   HubSpot seed refusals: ${m.safety.seedHubspotRefusals}   seed records in HubSpot outbox: ${m.safety.hubspotOutboxFromSeed} (must be 0)   classifier errors: ${m.safety.classifierErrors}   model errors: ${m.safety.llmFallbacks}`);
  return L.join('\n');
}
