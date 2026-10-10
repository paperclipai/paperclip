/** Secret-free interpretation of a bounded personal-Muse probe, not a Product E2E campaign. */
export const MUSE_QUALIFICATION_GRADER = "paperclip.muse-qualification.v2";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const timestamp = value => typeof value === "string" ? Date.parse(value) : NaN;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const sha = value => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);
const duration = (from, to) => {
  const value = timestamp(to) - timestamp(from);
  return Number.isFinite(value) && value >= 0 ? value : null;
};
const distribution = values => {
  const sorted = values.filter(value => value !== null).sort((a, b) => a - b);
  const percentile = fraction => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
  return { count: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1) ?? null };
};

/** Explicitly project safe facts; never spread retained evidence or print task/account/session identifiers. */
export function qualificationReport(evidence, now = Date.now()) {
  const run = evidence.qualification ?? {};
  const provenance = evidence.provenance ?? {};
  const start = timestamp(run.startedAt), expiry = timestamp(run.expiresAt);
  const bounded = Number.isFinite(start) && expiry - start === DAY && run.requestedPollIntervalMs === 5000;
  const samples = Array.isArray(evidence.samples) ? evidence.samples : [];
  const uniqueSlots = new Set(samples.map(sample => sample.slot)).size === samples.length;
  const ordered = sample => {
    const times = [sample.queuedAt, sample.offeredAt, sample.claimedAt, sample.nativeAcceptedAt, sample.acceptedResultAt, sample.finalizedAt].map(timestamp);
    return times.every((value, index) => Number.isFinite(value) && value >= start && value <= expiry && (index === 0 || value >= times[index - 1]));
  };
  const successful = samples.filter(sample => ordered(sample) && sample.unattended === true && sample.attempts === 1
    && sample.nativeSucceeded === true && sha(sample.documentSha256));
  const cadence = evidence.cadence ?? {};
  const intervalsValid = nonnegative(cadence.observedIntervals) && cadence.observedIntervals > 0
    && nonnegative(cadence.withinSevenSeconds) && cadence.withinSevenSeconds <= cadence.observedIntervals;
  const fraction = intervalsValid ? cadence.withinSevenSeconds / cadence.observedIntervals : null;
  const cadenceComplete = bounded && cadence.complete === true && cadence.missingIntervals === 0
    && nonnegative(cadence.maxUnobservedGapMs) && cadence.maxUnobservedGapMs <= 60_000
    && timestamp(cadence.from) <= start + 60_000 && timestamp(cadence.to) >= expiry - 60_000
    && intervalsValid && cadence.observedIntervals >= Math.floor(DAY / 7000);
  const windows = Array.isArray(evidence.idleWindows) ? evidence.idleWindows : [];
  const idleVerified = windows.some(window => duration(window.from, window.to) >= 2 * HOUR
    && timestamp(window.from) >= start && timestamp(window.to) <= expiry
    && window.coverageComplete === true && window.healthy === true
    && window.activeAssignments === 0 && window.unconsumedInputs === 0
    && !samples.some(sample => timestamp(sample.queuedAt) < timestamp(window.to)
      && (!Number.isFinite(timestamp(sample.finalizedAt)) || timestamp(sample.finalizedAt) > timestamp(window.from))));
  const cleanup = evidence.cleanup ?? {};
  const stopped = cleanup.authorityRevoked === true && timestamp(run.deadlineEnforcedAt) >= expiry
    && timestamp(run.deadlineEnforcedAt) <= expiry + 60_000;
  const noUncertainty = cleanup.nativeEffectsUnknown === false && cleanup.workerStopUnconfirmed === false;
  const sourceKnown = sha(provenance.coreRevision) && sha(provenance.runnerRevision)
    && provenance.protocolVersion === 1 && provenance.profile === "muse-personal"
    && ["local", "cloud", "self-hosted"].includes(provenance.environment);
  const live = provenance.mode === "live";
  const reasons = [];
  if (!bounded) reasons.push("invalid_duration_or_requested_cadence");
  if (!sourceKnown) reasons.push("missing_source_provenance");
  if (!live) reasons.push("not_live_personal_muse");
  if (!bounded || now < expiry) reasons.push("twenty_four_hours_not_elapsed");
  if (!stopped) reasons.push("deadline_cleanup_not_verified");
  if (!uniqueSlots || samples.some(sample => !Number.isInteger(sample.slot) || sample.slot < 0 || sample.slot >= 24)) reasons.push("invalid_or_duplicate_slots");
  if (successful.length < 20 || successful.length !== samples.length) reasons.push("insufficient_unattended_native_document_samples");
  if (!cadenceComplete) reasons.push("incomplete_receiver_cadence_evidence");
  if (fraction === null || fraction < 0.9) reasons.push("five_second_cadence_not_qualified");
  if (!idleVerified) reasons.push("sustained_idle_not_verified");
  if (!noUncertainty) reasons.push("unresolved_remote_work");
  if ((evidence.interventions ?? []).length) reasons.push("intervened_samples");
  const workflowNames = ["researchDocument", "clarification", "followUp", "freshConversationProactive"];
  const workflows = Object.fromEntries(workflowNames.map(name => [name, evidence.workflows?.[name]?.verified === true]));
  const passed = reasons.length === 0;
  return {
    schema: MUSE_QUALIFICATION_GRADER,
    provenance: { coreRevision: sha(provenance.coreRevision) ? provenance.coreRevision : null,
      runnerRevision: sha(provenance.runnerRevision) ? provenance.runnerRevision : null,
      protocolVersion: provenance.protocolVersion === 1 ? 1 : null, mode: live ? "live" : "synthetic_or_unspecified",
      environment: ["local", "cloud", "self-hosted"].includes(provenance.environment) ? provenance.environment : null },
    startedAt: Number.isFinite(start) ? new Date(start).toISOString() : null,
    expiresAt: Number.isFinite(expiry) ? new Date(expiry).toISOString() : null,
    elapsedHours: Number.isFinite(start) ? Math.max(0, now - start) / HOUR : null,
    samples: samples.map(sample => ({ slot: Number.isInteger(sample.slot) ? sample.slot : null,
      queueToOfferMs: duration(sample.queuedAt, sample.offeredAt), queueToClaimMs: duration(sample.queuedAt, sample.claimedAt),
      queueToNativeAcceptMs: duration(sample.queuedAt, sample.nativeAcceptedAt),
      queueToAcceptedResultMs: duration(sample.queuedAt, sample.acceptedResultAt), fullResponseMs: duration(sample.queuedAt, sample.finalizedAt),
      nativeSucceeded: sample.nativeSucceeded === true, unattended: sample.unattended === true,
      attempts: nonnegative(sample.attempts) ? sample.attempts : null, documentSha256: sha(sample.documentSha256) ? sample.documentSha256 : null })),
    successfulNativeTasks: successful.length,
    queueToClaim: distribution(samples.map(sample => duration(sample.queuedAt, sample.claimedAt))),
    fullResponse: distribution(samples.map(sample => duration(sample.queuedAt, sample.finalizedAt))),
    receiverIntervals: intervalsValid ? cadence.observedIntervals : null, fractionWithinSevenSeconds: fraction,
    requestedPollIntervalMs: 5000, cadenceEvidenceComplete: cadenceComplete, sustainedIdleVerified: idleVerified,
    deadlineCleanupVerified: stopped, unresolvedRemoteWork: !noUncertainty,
    usage: null, cost: null, usageAccounting: "unavailable", workflows,
    qualificationPassed: passed, releaseQualified: passed && Object.values(workflows).every(Boolean), reasons,
    evidenceBoundary: "Authenticated unattended round trips and native receipts; private Muse tool activity is not independently observed.",
  };
}

/** Merge persisted replica buckets before measuring gaps; bucket totals alone hide cross-replica gaps. */
export function qualificationCadence(evidence) {
  const start = timestamp(evidence.startedAt), expiry = timestamp(evidence.expiresAt);
  const contacts = Array.isArray(evidence.contacts) ? evidence.contacts : [];
  const times = [...new Set(contacts.flatMap(bucket => bucket.timestamps ?? []).map(timestamp)
    .filter(at => Number.isFinite(at) && at >= start && at <= expiry))].sort((a, b) => a - b);
  const gaps = times.slice(1).map((at, index) => at - times[index]);
  const missing = contacts.filter(bucket => bucket.incomplete || bucket.contacts !== bucket.timestamps?.length).length;
  const boundaryGap = times.length ? Math.max(0, times[0] - start, expiry - times.at(-1)) : Infinity;
  const largestGap = gaps.reduce((maximum, gap) => Math.max(maximum, gap), boundaryGap);
  return { from: times.length ? new Date(times[0]).toISOString() : null,
    to: times.length ? new Date(times.at(-1)).toISOString() : null,
    observedIntervals: gaps.length, withinSevenSeconds: gaps.filter(gap => gap <= 7000).length,
    missingIntervals: missing + (evidence.cadenceEvidenceComplete === true ? 0 : 1),
    maxUnobservedGapMs: Number.isFinite(largestGap) ? largestGap : null,
    complete: evidence.cadenceEvidenceComplete === true && missing === 0 && times.length > 1 };
}
