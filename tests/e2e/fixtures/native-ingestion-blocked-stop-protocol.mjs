import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const PROTOCOL = 'blocked-stop-history-v1';
export const WORKLOAD = Object.freeze({ prelude: 1000, events: 256, intervalMs: 100, visibleBeforeLock: 3,
  heldAfterActualRequestMs: 1000, pollIntervalMs: 50, readinessMs: 300000, streamMs: 120000,
  terminalMs: 180000, acknowledgementAfterSettlementMs: 30000, leaseAfterSettlementMs: 30000, invocationMs: 900000 });
export const WORKLOAD_SHA256 = createHash('sha256').update(JSON.stringify(WORKLOAD)).digest('hex');
export const METRICS = ['actionToAckMs', 'releaseAckToAbsenceMs', 'releaseAckToAckMs'];
export function isAppendLockQuery(query) {
  // Shared B0/B1/B2 projection prefix, unlike cancellation's full-row SELECT.
  const sql = String(query).replace(/\s+/g, ' ').trim();
  return /^select "company_id", "agent_id"(?:,| from)/i.test(sql)
    && / from "heartbeat_runs" where "heartbeat_runs"\."id" = \$\d+.* for update/i.test(sql);
}
export function assertHeldSample(sample, holderPid, expectedProcesses) {
  assert.equal(sample.httpPending, true, 'Stop HTTP must remain pending while its durable barrier is locked');
  assert.equal(sample.intent, null, 'No committed intent before releasing the run lock');
  assert.deepEqual(sample.auditIds, [], 'No committed cancellation audit before releasing the run lock');
  assert.equal(sample.processesAlive, true, 'No physical provider Stop before the durable intent barrier');
  assert(expectedProcesses?.runner && expectedProcesses.provider, 'Missing original owned process births');
  assert.deepEqual(sample.processes?.runner, expectedProcesses.runner);
  assert.deepEqual(sample.processes?.provider, expectedProcesses.provider);
  assert.equal(sample.processes?.group, expectedProcesses.group);
  assert.equal(sample.processes?.providerGroup, expectedProcesses.providerGroup);
  assert.equal(sample.processes?.runnerGroupAlive, true);
  assert.equal(sample.processes?.providerGroupAlive, true);
  assert.equal(sample.clockOpen, true, 'The unchanged provider fixture closes its clock on turn/interrupt');
  assert(sample.blockers.some(row => row.blocking_pids.includes(holderPid)), 'Missing independent PostgreSQL blocker');
}
// Public cancellation supports active/scheduled runs and native retryable failures.
// A receipt is not physical Stop proof; the independent process/lease oracle remains required.
export function cleanupCancellationEligible(run) {
  return ['queued', 'running', 'scheduled_retry'].includes(run.status)
    || (run.status === 'failed' && run.runtimeMode === 'native' && run.nativePhase === 'retryable_failure');
}
export async function cleanupOwnedRunBeforeClockClose({ companyId, runId, readRun, cancelRun, closeClock, record }) {
  const snapshot = run => {
    assert.equal(run.id, runId); assert.equal(run.companyId, companyId);
    return { id: run.id, companyId: run.companyId, status: run.status, runtimeMode: run.runtimeMode,
      nativePhase: run.nativePhase ?? null, errorCode: run.errorCode ?? null,
      nativeCancellation: run.resultJson?.nativeCancellation ?? null };
  };
  try {
    if (readRun) {
      const before = await readRun(); record.before = snapshot(before);
      record.cancel = { attempted: cleanupCancellationEligible(before) };
      if (record.cancel.attempted) {
        const response = await cancelRun();
        record.cancel.httpStatus = response.status; record.cancel.response = snapshot(response.run);
      }
      record.after = snapshot(await readRun());
    }
  } catch (error) { record.error = String(error); throw error; }
  finally {
    record.clockCloseStartedAtMs = Date.now();
    try { await closeClock(); record.clockClosedAtMs = Date.now(); }
    catch (error) { record.clockCloseError = String(error); throw error; }
  }
}
export function assertIntentAudit(row) {
  const intent = row.intent;
  assert.equal(intent?.schema, 'paperclip.native-cancellation.v1');
  assert.equal(intent.companyId, row.company_id); assert.equal(intent.runId, row.run_id);
  assert.equal(intent.issueId, row.issue_id);
  assert.equal(intent.scope, 'run'); assert.equal(intent.reasonCode, 'cancellation_run_only');
  if (intent.decisionId != null) {
    assert.equal(row.shared_decision?.id, intent.decisionId);
    assert.equal(row.shared_decision.companyId, row.company_id); assert.equal(row.shared_decision.runId, row.run_id);
    assert.equal(row.shared_decision.issueId, row.issue_id);
  }
  assert(row.audits.some(a => a.id === intent.intentAuditId && a.action === 'native.cancellation_intent_recorded'
    && a.details?.intentId === intent.intentId), 'Intent must match its committed own audit');
  if (intent.dispatchState === 'acknowledged') {
    assert.equal(intent.dispatched, true);
    assert(row.audits.some(a => a.id === intent.acknowledgementAuditId
      && a.action === 'native.cancellation_dispatch_acknowledged' && a.details?.intentId === intent.intentId
      && a.details.intentAuditId === intent.intentAuditId && a.details.dispatched === true
      && (a.details.decisionId ?? null) === (intent.decisionId ?? null)), 'ACK must match its own committed audit and decision');
  }
}
export function metrics(evidence) {
  assert.equal(evidence.protocol, PROTOCOL); assert.equal(evidence.workloadSha256, WORKLOAD_SHA256);
  assert.equal(evidence.complete, true); assert.equal(evidence.cleanup?.complete, true);
  const t = evidence.timing;
  for (const k of ['actionAtMs', 'requestAtMs', 'releaseRequestedAtMs', 'releaseCommitAckAtMs', 'absenceObservedAtMs', 'ackObservedAtMs'])
    assert(Number.isSafeInteger(t[k]) && t[k] > 0, `Missing ${k}`);
  assert(t.actionAtMs <= t.requestAtMs); assert(t.requestAtMs + WORKLOAD.heldAfterActualRequestMs <= t.releaseRequestedAtMs);
  assert(t.releaseRequestedAtMs <= t.releaseCommitAckAtMs); assert(t.releaseCommitAckAtMs <= t.absenceObservedAtMs);
  assert(t.releaseCommitAckAtMs <= t.ackObservedAtMs);
  return { actionToAckMs: t.ackObservedAtMs - t.actionAtMs,
    releaseAckToAbsenceMs: t.absenceObservedAtMs - t.releaseCommitAckAtMs,
    releaseAckToAckMs: t.ackObservedAtMs - t.releaseCommitAckAtMs,
    releaseRequestToAbsenceMs: t.absenceObservedAtMs - t.releaseRequestedAtMs,
    releaseRequestToAckMs: t.ackObservedAtMs - t.releaseRequestedAtMs };
}
export function registration() {
  const stages = [['b0-aa','b0','b0'], ['b1-aa','b1','b1'], ['b0-b1','b0','b1'], ['b1-b2','b1','b2'], ['b0-b2','b0','b2']];
  return stages.flatMap(([stage,a,b]) => Array.from({ length: 5 }, (_, pair) => (pair % 2 ? [b,a] : [a,b])
    .map((variant, index) => ({ stage, pair: pair + 1, index, variant, role: pair % 2 ? (index ? 'baseline' : 'candidate') : (index ? 'candidate' : 'baseline') })))).flat();
}
const median = values => {
  assert(values.length > 0);
  const sorted = [...values].sort((a,b) => a-b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const spread = values => ({ minimumMs: Math.min(...values), maximumMs: Math.max(...values),
  spreadMs: Math.max(...values) - Math.min(...values) });
const hashReport = evidence => createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
export const PRECISION_RULE = Object.freeze({ schema: 'blocked-stop-precision-v1',
  pollIntervalMs: WORKLOAD.pollIntervalMs, floorMs: 2 * WORKLOAD.pollIntervalMs, pooledMedianFraction: 0.10,
  pairedRule: 'maximum absolute difference <= budget', driftRule: 'absolute first-five vs last-five chronological median drift <= budget',
  bracketRule: 'each observer bracket <= corresponding metric budget', unsuitableRule: 'retain all ten arms; no noise freeze or replacement',
  scope: 'Measurement repeatability; not a product Stop deadline' });
export const PRECISION_RULE_SHA256 = createHash('sha256').update(JSON.stringify(PRECISION_RULE)).digest('hex');
export function observerBrackets(evidence) {
  const t = evidence.timing, origin = t.releaseCommitAckAtMs;
  const samples = evidence.observerSamples;
  assert(Array.isArray(samples), 'Missing raw observer query/check samples');
  const result = {};
  for (const [kind, timestamp, negativeTimestamp] of [
    ['ack-query', 'ackObservedAtMs', 'lastAckNotObservedAtMs'],
    ['process-check', 'absenceObservedAtMs', 'lastProcessesPresentAtMs']]) {
    const rows = samples.filter(row => row.kind === kind);
    assert(rows.length > 0, `Missing ${kind} observer samples`);
    let priorEnd = origin;
    for (const [index,row] of rows.entries()) {
      assert(Number.isSafeInteger(row.startedAtMs) && Number.isSafeInteger(row.completedAtMs));
      assert(row.startedAtMs >= priorEnd && row.completedAtMs >= row.startedAtMs);
      assert.equal(row.durationMs, row.completedAtMs - row.startedAtMs);
      assert.equal(row.value, index === rows.length - 1, 'Retain every negative sample through the first successful observation');
      priorEnd = row.completedAtMs;
    }
    const success = rows.at(-1), negative = rows.at(-2);
    assert.equal(t[timestamp], success.completedAtMs);
    if (negative) assert.equal(t[negativeTimestamp], negative.completedAtMs);
    else assert(t[negativeTimestamp] === undefined, 'A negative timestamp needs its raw query/check sample');
    // A negative query can read its snapshot at any point during execution;
    // use its start as the conservative lower boundary and retain both ends.
    const lowerAtMs = negative?.startedAtMs ?? origin;
    result[kind] = { lowerAtMs, upperAtMs: success.completedAtMs,
      widthMs: success.completedAtMs - lowerAtMs, lowerKind: negative ? 'last-negative-query-or-check-start' : 'release-COMMIT-ACK',
      successfulStartedAtMs: success.startedAtMs, successfulDurationMs: success.durationMs,
      ...(negative ? { negativeStartedAtMs: negative.startedAtMs, negativeCompletedAtMs: negative.completedAtMs,
        negativeDurationMs: negative.durationMs } : {}), sampleCount: rows.length };
  }
  return { actionToAckMs: result['ack-query'], releaseAckToAckMs: result['ack-query'],
    releaseAckToAbsenceMs: result['process-check'] };
}
function validatedPairs(pairs) {
  assert.equal(pairs.length, 5, 'Require five fresh pairs');
  const validated = pairs.map(pair => {
    assert.equal(pair.length, 2);
    return pair.map(evidence => ({ evidence, values: assertFunctional(evidence), brackets: observerBrackets(evidence) }));
  });
  const chronological = validated.flat().sort((a,b) => a.evidence.startedAtMs - b.evidence.startedAtMs);
  assert.equal(new Set(chronological.map(arm => arm.evidence.runId)).size, 10, 'Ten fresh owned runs are required');
  assert.equal(new Set(chronological.map(arm => arm.evidence.companyId)).size, 10, 'Ten fresh disposable invocations are required');
  for (const [index,arm] of chronological.entries()) {
    assert(Number.isSafeInteger(arm.evidence.startedAtMs) && Number.isSafeInteger(arm.evidence.finishedAtMs));
    assert(arm.evidence.finishedAtMs >= arm.evidence.startedAtMs);
    if (index) assert(chronological[index-1].evidence.finishedAtMs < arm.evidence.startedAtMs,
      'Arms must not overlap');
  }
  validated.forEach((pair,index) => {
    assert.equal(pair[0].evidence.startedAtMs, chronological[2*index + index%2].evidence.startedAtMs,
      'Pairs must alternate baseline-first then candidate-first in chronological order');
    assert.equal(pair[1].evidence.startedAtMs, chronological[2*index + (index%2 ? 0 : 1)].evidence.startedAtMs);
  });
  return validated;
}
export function noiseEnvelope(pairs) {
  const validated = validatedPairs(pairs), chronological = validated.flat().sort((a,b) => a.evidence.startedAtMs - b.evidence.startedAtMs);
  for (const [index,arm] of chronological.entries()) {
    assert(Number.isSafeInteger(arm.evidence.startedAtMs) && Number.isSafeInteger(arm.evidence.finishedAtMs));
    assert(arm.evidence.finishedAtMs >= arm.evidence.startedAtMs);
    if (index) assert(chronological[index-1].evidence.finishedAtMs < arm.evidence.startedAtMs,
      'A/A requires ten distinct non-overlapping chronological arms');
  }
  const variants = new Set(chronological.map(arm => String(arm.evidence.variant).toLowerCase()));
  assert.equal(variants.size, 1, 'A/A calibration must use one baseline variant');
  const baselineVariant = [...variants][0]; assert(['b0','b1'].includes(baselineVariant));
  const result = { schema: 'paperclip.native-ingestion.blocked-stop-noise.v1', protocol: PROTOCOL, baselineVariant,
    workloadSha256: WORKLOAD_SHA256, precisionRule: PRECISION_RULE, precisionRuleSha256: PRECISION_RULE_SHA256,
    sampleCounts: { pairs: 5, arms: 10 }, suitable: false, noiseFrozen: false, metrics: {},
    arms: chronological.map(arm => ({ reportSha256: hashReport(arm.evidence), startedAtMs: arm.evidence.startedAtMs,
      finishedAtMs: arm.evidence.finishedAtMs, values: arm.values, observerBrackets: arm.brackets })),
    rawArms: chronological.map(arm => arm.evidence), pairBindings: validated.map(pair => pair.map(arm => hashReport(arm.evidence))),
    sourceDigestScope: 'SHA256 of JSON.stringify(parsed raw arm); owning raw-byte seals are separately required' };
  for (const metric of METRICS) {
    const values = chronological.map(arm => arm.values[metric]), pooledMedianMs = median(values);
    const baselineValues = validated.map(pair => pair[0].values[metric]), candidateValues = validated.map(pair => pair[1].values[metric]);
    const baselineMedianMs = median(baselineValues), candidateMedianMs = median(candidateValues);
    const differencesMs = validated.map(pair => pair[1].values[metric] - pair[0].values[metric]);
    const maximumAbsolutePairedDifferenceMs = Math.max(...differencesMs.map(Math.abs));
    const firstFiveMedianMs = median(values.slice(0,5)), lastFiveMedianMs = median(values.slice(5));
    const absoluteChronologicalMedianDriftMs = Math.abs(lastFiveMedianMs - firstFiveMedianMs);
    const precisionBudgetMs = Math.max(PRECISION_RULE.floorMs, PRECISION_RULE.pooledMedianFraction * pooledMedianMs);
    const observerBracketWidthsMs = chronological.map(arm => arm.brackets[metric].widthMs);
    const floorDominated = PRECISION_RULE.pooledMedianFraction * pooledMedianMs <= PRECISION_RULE.floorMs;
    result.metrics[metric] = { sampleCount: 10, pairCount: 5, pooledMedianMs, baselineMedianMs, candidateMedianMs,
      absoluteMedianDifferenceMs: Math.abs(candidateMedianMs - baselineMedianMs),
      medianDifferencePercent: floorDominated ? null : 100 * (candidateMedianMs - baselineMedianMs) / baselineMedianMs,
      ...spread(values), pairedDifferencesMs: differencesMs, maximumAbsolutePairedDifferenceMs,
      firstFiveMedianMs, lastFiveMedianMs, absoluteChronologicalMedianDriftMs, precisionBudgetMs,
      observerBracketWidthsMs, maximumObserverBracketMs: Math.max(...observerBracketWidthsMs),
      suitable: maximumAbsolutePairedDifferenceMs <= precisionBudgetMs && absoluteChronologicalMedianDriftMs <= precisionBudgetMs
        && observerBracketWidthsMs.every(width => width <= precisionBudgetMs),
      noiseMs: null, floorDominated, resolutionLabel: floorDominated ? '100 ms resolution floor' : 'Observer brackets and budget reported',
      subfloorOrP99ClaimsAllowed: false, percentageSpeedClaimsAllowed: !floorDominated };
  }
  result.suitable = METRICS.every(metric => result.metrics[metric].suitable);
  result.noiseFrozen = result.suitable;
  if (result.suitable) for (const metric of METRICS) result.metrics[metric].noiseMs = result.metrics[metric].maximumAbsolutePairedDifferenceMs;
  return result;
}
export function assertNoiseEnvelope(noise) {
  assert.equal(noise?.schema, 'paperclip.native-ingestion.blocked-stop-noise.v1');
  assert.equal(noise.protocol, PROTOCOL); assert.equal(noise.workloadSha256, WORKLOAD_SHA256);
  assert.equal(noise.precisionRuleSha256, PRECISION_RULE_SHA256); assert.deepEqual(noise.precisionRule, PRECISION_RULE);
  assert.deepEqual(noise.sampleCounts, { pairs: 5, arms: 10 });
  assert.equal(noise.suitable, true, 'Unsuitable A/A cannot freeze a noise envelope'); assert.equal(noise.noiseFrozen, true);
  assert.equal(noise.rawArms?.length, 10);
  // Recompute suitability and all numeric limits from retained raw arms. A
  // caller cannot inflate a budget or flip a failed suitability flag.
  const byDigest = new Map(noise.rawArms.map(arm => [hashReport(arm), arm]));
  assert.equal(noise.pairBindings?.length, 5);
  const logical = noise.pairBindings.map(pair => {
    assert.equal(pair.length, 2);
    return pair.map(digest => { const raw = byDigest.get(digest); assert(raw, 'Frozen arm digest mismatch'); return raw; });
  });
  const recomputed = noiseEnvelope(logical);
  assert.equal(recomputed.suitable, true);
  assert.deepEqual(noise.metrics, recomputed.metrics, 'Frozen noise or precision limit changed');
  assert.equal(noise.baselineVariant, recomputed.baselineVariant);
  assert.deepEqual(noise.arms, recomputed.arms, 'Frozen chronological arms changed');
  return noise;
}
export function comparePairs(pairs, noise) {
  const validated = validatedPairs(pairs); assertNoiseEnvelope(noise);
  for (const [baseline] of validated) assert.equal(String(baseline.evidence.variant).toLowerCase(), noise.baselineVariant,
    'Comparisons must use their own baseline calibration');
  return Object.fromEntries(METRICS.map(metric => {
    const calibrated = noise.metrics[metric], deltas = validated.map(([baseline,candidate]) => candidate.values[metric] - baseline.values[metric]);
    const baselineValues = validated.map(pair => pair[0].values[metric]), candidateValues = validated.map(pair => pair[1].values[metric]);
    const baselineMedianMs = median(baselineValues), candidateMedianMs = median(candidateValues);
    const observerBracketWidthsMs = validated.map(pair => pair.map(arm => arm.brackets[metric].widthMs));
    const floorDominated = calibrated.floorDominated || PRECISION_RULE.pooledMedianFraction * Math.min(baselineMedianMs,candidateMedianMs) <= PRECISION_RULE.floorMs;
    return [metric, { sampleCounts: { pairs: 5, arms: 10 }, baselineMedianMs, candidateMedianMs, deltaMedianMs: median(deltas),
      medianDifferencePercent: floorDominated ? null : 100 * (candidateMedianMs - baselineMedianMs) / baselineMedianMs,
      deltasMs: deltas, noiseMs: calibrated.noiseMs, precisionBudgetMs: calibrated.precisionBudgetMs,
      baselineSpread: spread(baselineValues), candidateSpread: spread(candidateValues), ...spread(deltas),
      observerBracketWidthsMs, floorDominated, resolutionLabel: floorDominated ? '100 ms resolution floor' : 'Observer brackets and budget reported',
      subfloorOrP99ClaimsAllowed: false, percentageSpeedClaimsAllowed: !floorDominated,
      pass: deltas.every(delta => delta <= calibrated.noiseMs) && median(deltas) <= calibrated.noiseMs
        && observerBracketWidthsMs.flat().every(width => width <= calibrated.precisionBudgetMs) }];
  }));
}
function assertOptionalShared(row, companyId, runId) {
  assert.equal(row.company_id, companyId); assert.equal(row.run_id, runId);
  const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
  const execution = row.shared_execution_cancellation;
  if (execution != null) {
    assert(execution && typeof execution === 'object' && !Array.isArray(execution));
    assert(['requested','acknowledged'].includes(execution.state));
    if (execution.state === 'requested') assert(timestamp(execution.requestedAt));
    if (execution.state === 'acknowledged') assert(timestamp(execution.acknowledgedAt));
    if (execution.requestedAt != null) assert(timestamp(execution.requestedAt));
    if (execution.acknowledgedAt != null) assert(timestamp(execution.acknowledgedAt));
    if (execution.requestedAt != null && execution.acknowledgedAt != null)
      assert(Date.parse(execution.requestedAt) <= Date.parse(execution.acknowledgedAt));
  }
  const cancellation = row.run_cancellation;
  if (cancellation != null) {
    assert.equal(cancellation.source, 'operator'); assert.equal(cancellation.expected, true);
    assert.equal(cancellation.initiator?.type, 'user');
    assert(typeof cancellation.reason === 'string' && cancellation.reason.length > 0);
    assert(timestamp(cancellation.recordedAt));
  }
}
export function assertFunctional(e) {
  metrics(e); observerBrackets(e);
  assert.equal(e.prelude?.individualDeltas, WORKLOAD.prelude); assert.equal(e.prelude?.uniqueIdentities, WORKLOAD.prelude);
  assert(e.prelude.verifiedBeforeEpochAtMs < e.epochMs);
  assert(e.visibleBeforeLock?.length >= WORKLOAD.visibleBeforeLock);
  assert.equal(e.lock?.id, e.runId); assert.equal(e.lock.company_id, e.companyId);
  assert(e.appendBlockedBeforeStop?.observedAtMs < e.timing.requestAtMs);
  assert(e.appendBlockedBeforeStop.rows.some(row => isAppendLockQuery(row.query) && row.blocking_pids.includes(e.lock.holder_pid)));
  assert(e.heldSamples?.length >= 2);
  for (const sample of e.heldSamples) {
    assertHeldSample(sample, e.lock.holder_pid, e.processesBefore); assertOptionalShared(sample, e.companyId, e.runId);
    assert(sample.queryStartedAtMs >= e.timing.requestAtMs && sample.observedAtMs <= e.timing.releaseRequestedAtMs);
  }
  assert(e.heldSamples.at(-1).emittedCount > e.heldSamples[0].emittedCount, 'Provider must still emit through the stall');
  assertIntentAudit(e.ack); assertOptionalShared(e.ack, e.companyId, e.runId);
  assert.equal(e.ack.intent.dispatchState, 'acknowledged');
  if (e.sharedSettlement != null) {
    assert.equal(e.sharedSettlement.runId, e.runId); assert.equal(e.sharedSettlement.companyId, e.companyId);
    assert.equal(e.sharedSettlement.status, 'cancelled');
    assertOptionalShared({ company_id: e.sharedSettlement.companyId, run_id: e.sharedSettlement.runId,
      shared_execution_cancellation: e.sharedSettlement.executionCancellation, run_cancellation: e.sharedSettlement.cancellation }, e.companyId, e.runId);
    if (e.sharedSettlement.nativeCancellation != null) assert.equal(e.sharedSettlement.nativeCancellation.intentId, e.ack.intent.intentId);
  }
  assert.equal(e.ack.company_id, e.companyId); assert.equal(e.ack.run_id, e.runId); assert.equal(e.ack.issue_id, e.issueId);
  assert.equal(e.stopHttpStatus, 200);
  assert.deepEqual([e.processesAfter?.runnerAbsent, e.processesAfter?.groupAbsent, e.processesAfter?.providerAbsent, e.processesAfter?.providerGroupAbsent], [true,true,true,true]);
  assert.equal(e.processesAfter.group, e.processesBefore.group);
  assert.equal(e.processesAfter.providerGroup, e.processesBefore.providerGroup);
  assert(e.timing.httpSettledAtMs >= e.timing.releaseRequestedAtMs);
  const before = e.authorityBefore?.rows?.[0], after = e.authorityAfter?.rows?.[0];
  for (const row of [before, after]) { assert.equal(row?.company_id, e.companyId); assert.equal(row?.run_id, e.runId); assert.equal(row.runtime_mode, 'native'); }
  assert.equal(after.status, 'cancelled'); assert.equal(after.cancellation_dispatch_state, 'acknowledged');
  assert(BigInt(after.process_stopped_seq) > BigInt(before.process_identity_seq));
  assert.equal(after.process_stopped_source_event_id, null);
  assert.equal(after.process_stopped.processPid, e.processesBefore.runner.pid);
  assert.equal(after.process_stopped.processGroupId, e.processesBefore.group);
  for (const process of [e.processesBefore.runner, e.processesBefore.provider]) {
    assert(Number.isSafeInteger(process.pid) && process.pid > 1 && process.birth);
    assert(Number.isSafeInteger(process.group) && process.group > 1);
  }
  assert.equal(e.processesBefore.runner.group, e.processesBefore.group);
  assert.equal(e.processesBefore.group, before.process_group_id);
  assert.equal(e.processesBefore.runner.pid, before.process_pid);
  assert.equal(e.processesBefore.provider.group, e.processesBefore.providerGroup);
  assert.equal(e.lease?.heartbeatRunId, e.runId); assert.equal(e.lease.companyId, e.companyId);
  assert.equal(e.lease.provider, 'local'); assert.equal(e.lease.providerLeaseId, null);
  assert(e.lease.releasedAt && ['released','expired','failed'].includes(e.lease.status)); assert.notEqual(e.lease.cleanupStatus, 'failed');
  const transcript = e.transcript;
  assert.equal(transcript?.persistedAfterReload, true); assert.equal(transcript?.ordered, true);
  assert.equal(transcript.resultAcceptedEvents, 0); assert.equal(transcript.preludeCount, WORKLOAD.prelude);
  assert.equal(transcript.individualDeltas, transcript.deltas.length);
  assert.equal(transcript.uniqueSourceIdentities, transcript.deltas.length);
  const identities = new Set();
  for (const [index,event] of transcript.deltas.entries()) {
    assert.equal(event.runId, e.runId); assert.equal(event.eventType, 'item.delta');
    assert(event.sourceInstanceId && event.sourceEventId && Number.isSafeInteger(event.sourceSeq) && event.sourceSeq > 0);
    identities.add(`${event.sourceInstanceId}:${event.sourceEventId}:${event.sourceSeq}`);
    assert.equal(event.payload.text, `[${e.clock.markerCode}${index.toString(36)}] `);
    assert(e.clock.records.some(record => record.index === index && record.nonce === e.clock.nonce));
  }
  assert.equal(identities.size, transcript.deltas.length);
  for (const marker of transcript.seen) assert(marker.index >= 0 && marker.index < transcript.deltas.length);
  assert(e.clock.ended || e.clock.aborted); assert(!e.clock.error);
  assert.equal(e.measurement?.actionToAckIncludesForcedWait, true);
  assert.equal(e.measurement?.recording?.trace, 'off'); assert.equal(e.measurement?.recording?.video, 'off');
  return metrics(e);
}
