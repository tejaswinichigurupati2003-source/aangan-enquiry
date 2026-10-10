// Dashboard metrics. Everything is computed from the store; nothing is hand-entered.
import { callCost } from './cost.js';
import { buildSeries } from './series.js';
import { getTeam, buildAttention, buildWorkload, ownerOf, stageOf, isClosed, tzOffset } from './team.js';

const median = (xs) => { const a = xs.filter((x) => x != null && Number.isFinite(x)).sort((p, q) => p - q); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

/** @param source 'all' | 'live' | 'seed' */
export function computeMetrics(store, cfg, { source = 'all', now = new Date() } = {}) {
  const inSrc = (x) => source === 'all' || x.source === source;
  const calls = store.db.calls.filter(inSrc);
  const enquiries = store.db.enquiries.filter(inSrc);
  const tiers = { green: 0, amber: 0, red: 0, escalate: 0, unclassified: 0 };
  for (const e of enquiries) tiers[e.tier ?? 'unclassified']++;

  // --- time to answer ---
  const aiCalls = calls.filter((c) => c.ringToAnswerMs != null);
  const afterHoursCalls = calls.filter((c) => c.afterHours || c.engineFlags?.includes('after_hours') || (c.source === 'seed' && isAfterHoursSeed(cfg, c)));
  const answerMs = median(aiCalls.map((c) => c.ringToAnswerMs));
  const answered = aiCalls.filter((c) => c.status !== 'missed');
  const within5min = aiCalls.length ? answered.filter((c) => c.ringToAnswerMs <= 300000).length / aiCalls.length : null;

  // --- handoff + pickup ---
  const handed = enquiries.filter((e) => e.tier === 'green' && e.handoff?.telegramSentAt);
  const lastEnd = (e) => Math.max(...e.callIds.map((id) => new Date(store.getCall(id)?.endedAt ?? 0).getTime()));
  const handoffSec = handed.map((e) => (new Date(e.handoff.telegramSentAt) - lastEnd(e)) / 1000);
  const acked = handed.filter((e) => e.handoff.ackAt);
  const pickupMin = acked.map((e) => (new Date(e.handoff.ackAt) - new Date(e.handoff.telegramSentAt)) / 60000);

  // --- cost ---
  const costs = calls.map((c) => ({ call: c, cost: callCost(cfg, c) }));
  const parts = ['model', 'stt', 'tts', 'telephony', 'hosting'];
  const totals = Object.fromEntries(parts.map((p) => [p, r2(sum(costs.map((c) => c.cost[p])))]));
  const totalSpend = r2(sum(costs.map((c) => c.cost.total)));
  const greens = tiers.green;
  const usageEstimated = calls.some((c) => c.usage?.conversation?.estimated || c.usage?.classifier?.estimated);
  const modelled = calls.some((c) => c.usage?.conversation?.modelled);

  // --- spot-check list: every Red, newest first, with the evidence for why ---
  const reviews = new Map(store.db.reviews.map((r) => [r.enquiryId, r]));
  const reds = enquiries.filter((e) => e.tier === 'red').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((e) => {
    const cls = e.classification || {};
    const failing = Object.entries(cls.verdicts || {}).filter(([, v]) => v === 'fail').map(([k]) => k);
    return {
      id: e.id, phone: e.phone, source: e.source, at: e.updatedAt, reason: cls.red_reason, why: cls.reasons?.[0], summary: cls.summary,
      failing, evidence: Object.fromEntries(failing.map((k) => [k, cls.evidence?.[k] || ''])), closeScript: e.closeScript, review: reviews.get(e.id) || null,
      transcript: store.combinedTranscript(e),
    };
  });
  const reviewed = reds.filter((r) => r.review);
  const tooStrict = reviewed.filter((r) => r.review.verdict === 'too_strict').length;

  const amberQueue = enquiries.filter((e) => e.tier === 'amber').map((e) => ({
    id: e.id, phone: e.phone, source: e.source, since: e.queue?.since, reason: e.queue?.reason, next: e.queue?.next_question, fields: e.fields,
    callbacks: store.db.callbacks.filter((c) => c.enquiryId === e.id).map((c) => ({ attempt: c.attempt, dueAt: c.dueAt, status: c.status })),
  }));

  const flagCounts = {};
  for (const e of enquiries) for (const f of e.flags || []) flagCounts[f] = (flagCounts[f] || 0) + 1;

  // --- people: every lead a person can own (Green, Amber, Escalate), with owner / stage / consultation ---
  const team = getTeam(cfg);
  const cbs = (id) => store.db.callbacks.filter((c) => c.enquiryId === id).map((c) => ({ attempt: c.attempt, dueAt: c.dueAt, status: c.status }));
  const leads = enquiries.filter((e) => ['green', 'amber', 'escalate'].includes(e.tier)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((e) => ({
    id: e.id, source: e.source, phone: e.phone, tier: e.tier, fields: e.fields, flags: e.flags || [], summary: e.classification?.summary, reason: e.queue?.reason || e.classification?.reasons?.[0],
    next: e.queue?.next_question, createdAt: e.createdAt, updatedAt: e.updatedAt, lastActivityAt: e.lastActivityAt || e.updatedAt, calls: e.callIds.length, repeat: e.callIds.length > 1,
    ownerId: ownerOf(e), ownerName: e.assignment?.ownerName ?? null, ownerAuto: Boolean(e.assignment?.auto), stage: stageOf(e), closed: isClosed(e), consult: e.consult ?? null,
    handoff: { telegramSentAt: e.handoff?.telegramSentAt ?? null, ackAt: e.handoff?.ackAt ?? null, ackBy: e.handoff?.ackBy ?? null, hubspot: e.handoff?.hubspot ?? null, pagedAt: e.handoff?.pagedAt ?? null },
    callbacks: e.tier === 'amber' ? cbs(e.id) : [],
  }));
  const attention = buildAttention(store, cfg, now).filter((a) => source === 'all' || source === 'live');

  const cc = cfg.cost_assumptions;
  const pv = cfg.business?.avg_project_value_inr;
  return {
    generatedAt: new Date().toISOString(), source,
    totals: { calls: calls.length, enquiries: enquiries.length, mergedEnquiries: enquiries.filter((e) => e.callIds.length > 1).length },
    tiers,
    answer: {
      aiHandled: aiCalls.length, medianMs: answerMs, within5minShare: within5min,
      afterHoursCalls: afterHoursCalls.length, afterHoursShare: calls.length ? afterHoursCalls.length / calls.length : null,
      missedCalls: calls.filter((c) => c.status === 'missed').length,
      note: aiCalls.length ? 'Measured by the simulator/stub; real telephony will report true ring-to-answer.' : 'No AI-answered calls in this view (seed calls were human-handled).',
    },
    handoff: { greenHandoffs: handed.length, medianHandoffSec: r2(median(handoffSec)), designerPickup: { acked: acked.length, pending: handed.length - acked.length, medianMin: r2(median(pickupMin)) } },
    cost: {
      currency: cc.currency, totalSpend, perCall: calls.length ? r2(totalSpend / calls.length) : null,
      perGreenLead: greens ? r2(totalSpend / greens) : null, breakdown: totals,
      perCallBreakdown: calls.length ? Object.fromEntries(parts.map((p) => [p, r2(totals[p] / calls.length)])) : null,
      flags: { tokensEstimated: usageEstimated, conversationModelled: modelled, allUnitCostsAreEstimates: true },
      monthlyProjection: { calls: cc.expected_calls_per_month, spend: calls.length ? r2((totalSpend / calls.length) * cc.expected_calls_per_month) : null },
    },
    pipeline: pv && source === 'live' ? { greenLeads: greens, grossValueMin: greens * pv.min, grossValueMax: greens * pv.max, note: 'Green leads × average project value from the brief. Not a forecast: conversion is unknown.' } : null,
    ambers: amberQueue, reds, redReview: { total: reds.length, reviewed: reviewed.length, tooStrict, tooStrictRate: reviewed.length ? tooStrict / reviewed.length : null },
    flagCounts,
    team: { ...team, tz: cfg.studio.timezone, tzOffset: tzOffset(cfg.studio.timezone, now), officeHours: { start: cfg.studio.office_hours_start, end: cfg.studio.office_hours_end }, workload: buildWorkload(store, cfg, now, { source }) },
    leads, attention, now: now.toISOString(),
    series: buildSeries(store, cfg, calls, enquiries),
    safety: {
      guardBlocked: store.db.events.filter((e) => e.type === 'guard_blocked' && (source === 'all' || e.source === source)).length,
      seedHubspotRefusals: store.db.events.filter((e) => e.type === 'hubspot_refused_seed').length,
      hubspotOutboxFromSeed: store.db.outbox.filter((o) => o.channel === 'hubspot' && store.getEnquiry(o.enquiryId)?.source === 'seed').length,
      classifierErrors: store.db.events.filter((e) => e.type === 'classifier_error').length,
      llmFallbacks: store.db.events.filter((e) => e.type === 'llm_error').length,
    },
    escalations: enquiries.filter((e) => e.tier === 'escalate').map((e) => ({ id: e.id, phone: e.phone, source: e.source, summary: e.classification?.summary, pagedAt: e.handoff?.pagedAt })),
  };
}

function isAfterHoursSeed(cfg, c) {
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: cfg.studio.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(c.startedAt));
  return hhmm < cfg.studio.office_hours_start || hhmm >= cfg.studio.office_hours_end;
}
