import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL, WORKLOAD as W, WORKLOAD_SHA256, METRICS, isAppendLockQuery, assertHeldSample,
  assertIntentAudit, metrics, registration, noiseEnvelope, comparePairs, assertFunctional, observerBrackets, assertNoiseEnvelope, PRECISION_RULE } from './native-ingestion-blocked-stop-protocol.mjs';
const evidence = (shift = 0) => ({ protocol: PROTOCOL, workloadSha256: WORKLOAD_SHA256, complete: true, cleanup: { complete: true },
  timing: { actionAtMs: 1000, requestAtMs: 1005, releaseRequestedAtMs: 2005, releaseCommitAckAtMs: 2007,
    absenceObservedAtMs: 2030 + shift, ackObservedAtMs: 2040 + shift } });
const sample = () => ({ httpPending: true, intent: null, auditIds: [], processesAlive: true, clockOpen: true, blockers: [{ blocking_pids: [88] }] });
const intentRow = () => ({ company_id: 'c', run_id: 'r', issue_id: 'i', intent: {
  schema: 'paperclip.native-cancellation.v1', companyId: 'c', runId: 'r', issueId: 'i',
  intentId: 'own', intentAuditId: 'a', dispatchState: 'acknowledged', acknowledgementAuditId: 'b',
  scope: 'run', reasonCode: 'cancellation_run_only', dispatched: true, decisionId: null },
  audits: [{ id: 'a', action: 'native.cancellation_intent_recorded', details: { intentId: 'own' } },
    { id: 'b', action: 'native.cancellation_dispatch_acknowledged', details: { intentId: 'own', intentAuditId: 'a', dispatched: true, decisionId: null } }] });

test('geometry fits the unchanged 4,000 character bound, includes existing emitted history', () => {
  const chars = '.'.repeat(W.prelude - 1) + ` PRELUDE_${'a'.repeat(32)}_READY `
    + Array.from({ length: W.events }, (_, index) => `[00${index.toString(36)}] `).join('');
  assert(chars.length < 4000); assert.equal(W.prelude, 1000); assert.equal(W.events, 256); assert.equal(W.intervalMs, 100);
});
test('B0 and candidate append SQL match while cancellation full-row and unrelated SQL do not', () => {
  for (const extra of ['', ', "next_event_seq", "event_cursor_projection_seq"']) assert(isAppendLockQuery(
    `select "company_id", "agent_id"${extra} from "heartbeat_runs" where "heartbeat_runs"."id" = $1 limit $2 for update`));
  assert(!isAppendLockQuery('select "id", "company_id", "agent_id" from "heartbeat_runs" where "heartbeat_runs"."id" = $1 for update'));
  assert(!isAppendLockQuery('select "company_id", "agent_id" from "heartbeat_runs" where "heartbeat_runs"."id" = $1'));
});
test('held sample requires every barrier and physical liveness proof', () => {
  assertHeldSample(sample(), 88);
  for (const patch of [{ httpPending: false }, { intent: {} }, { auditIds: ['a'] }, { processesAlive: false }, { clockOpen: false }, { blockers: [] }])
    assert.throws(() => assertHeldSample({ ...sample(), ...patch }, 88));
  assert.throws(() => assertHeldSample(sample(), 89));
});
test('ACK correlates both committed audits to the same owned intent', () => {
  assertIntentAudit(intentRow());
  for (const mutate of [row => { row.intent.runId = 'foreign'; }, row => { row.audits.pop(); },
    row => { row.audits[1].details.intentId = 'foreign'; }, row => { row.intent.intentAuditId = 'missing'; }]) {
    const row = intentRow(); mutate(row); assert.throws(() => assertIntentAudit(row));
  }
});
test('full action latency retains forced wait; release metrics use COMMIT ACK and also retain request-origin bounds', () => {
  assert.deepEqual(metrics(evidence()), { actionToAckMs: 1040, releaseAckToAbsenceMs: 23, releaseAckToAckMs: 33,
    releaseRequestToAbsenceMs: 25, releaseRequestToAckMs: 35 });
  for (const key of ['actionAtMs','requestAtMs','releaseRequestedAtMs','releaseCommitAckAtMs','absenceObservedAtMs','ackObservedAtMs']) {
    const e = evidence(); delete e.timing[key]; assert.throws(() => metrics(e));
  }
  const e = evidence(); e.timing.releaseRequestedAtMs--; assert.throws(() => metrics(e));
  e.timing.releaseRequestedAtMs++; e.complete = false; assert.throws(() => metrics(e));
});
test('registered companion is 50 separate alternating arms with fresh B0 and B1 A/A', () => {
  const arms = registration(); assert.equal(arms.length, 50);
  for (const stage of ['b0-aa','b1-aa','b0-b1','b1-b2','b0-b2']) {
    const rows = arms.filter(a => a.stage === stage); assert.equal(rows.length, 10);
    for (let pair = 1; pair <= 5; pair++) assert.equal(rows.filter(a => a.pair === pair).length, 2);
    assert.deepEqual(rows.slice(0, 4).map(a => a.role), ['baseline','candidate','candidate','baseline']);
  }
});

const functional = () => {
  const e = evidence(), identity = { company_id: 'c', run_id: 'r', runtime_mode: 'native' };
  return { ...e, variant: 'b0', startedAtMs: 100, finishedAtMs: 3000, companyId: 'c', runId: 'r', issueId: 'i', epochMs: 900,
    prelude: { individualDeltas: 1000, uniqueIdentities: 1000, verifiedBeforeEpochAtMs: 850 },
    visibleBeforeLock: [0,1,2], lock: { id: 'r', company_id: 'c', holder_pid: 88 },
    appendBlockedBeforeStop: { observedAtMs: 1004, rows: [{ query: 'select "company_id", "agent_id" from "heartbeat_runs" where "heartbeat_runs"."id" = $1 for update', blocking_pids: [88] }] },
    heldSamples: [{ ...sample(), company_id: 'c', run_id: 'r', queryStartedAtMs: 1010, observedAtMs: 1015, emittedCount: 3 },
      { ...sample(), company_id: 'c', run_id: 'r', queryStartedAtMs: 1995, observedAtMs: 2004, emittedCount: 13 }], ack: intentRow(), stopHttpStatus: 200,
    timing: { ...e.timing, httpSettledAtMs: 2042, lastAckNotObservedAtMs: 2036, lastProcessesPresentAtMs: 2026 },
    observerSamples: [{ kind: 'ack-query', startedAtMs: 2035, completedAtMs: 2036, durationMs: 1, value: false },
      { kind: 'ack-query', startedAtMs: 2039, completedAtMs: 2040, durationMs: 1, value: true },
      { kind: 'process-check', startedAtMs: 2025, completedAtMs: 2026, durationMs: 1, value: false },
      { kind: 'process-check', startedAtMs: 2029, completedAtMs: 2030, durationMs: 1, value: true }], processesBefore: { runner: { pid: 10, group: 10, birth: 'birth' },
      provider: { pid: 11, group: 10, birth: 'birth' }, group: 10 }, processesAfter: { runnerAbsent: true, groupAbsent: true, providerAbsent: true },
    authorityBefore: { rows: [{ ...identity, process_identity_seq: '1' }] },
    authorityAfter: { rows: [{ ...identity, status: 'cancelled', cancellation_dispatch_state: 'acknowledged', process_stopped_seq: '20',
      process_stopped_source_event_id: null, process_stopped: { processPid: 10, processGroupId: 10 } }] },
    lease: { heartbeatRunId: 'r', companyId: 'c', provider: 'local', providerLeaseId: null, releasedAt: 'time', status: 'released', cleanupStatus: 'success' },
    transcript: { individualDeltas: 3, uniqueSourceIdentities: 3, persistedAfterReload: true, ordered: true, resultAcceptedEvents: 0,
      preludeCount: 1000, seen: [{ index: 0 },{ index: 1 },{ index: 2 }], deltas: [0,1,2].map(index => ({ runId: 'r', eventType: 'item.delta',
        sourceInstanceId: 'source', sourceEventId: `id${index}`, sourceSeq: index+1, payload: { text: `[00${index}] ` } })) },
    clock: { markerCode: '00', nonce: 'nonce', ended: true, records: [0,1,2].map(index => ({ index, nonce: 'nonce' })) },
    measurement: { actionToAckIncludesForcedWait: true, recording: { trace: 'off', video: 'off' } } };
};
test('functional oracle accepts complete correlated proof and rejects plausible missing or wrong outcomes', () => {
  assertFunctional(functional());
  const mutations = [e => { delete e.ack; }, e => { e.ack.intent.intentId = 'other'; },
    e => { e.appendBlockedBeforeStop.rows[0].blocking_pids = []; }, e => { e.prelude.individualDeltas = 999; },
    e => { e.authorityAfter.rows[0].process_stopped.processPid = 99; }, e => { e.processesAfter.providerAbsent = false; },
    e => { e.heldSamples[1].emittedCount = 3; }, e => { e.transcript.deltas[1].payload.text = '[000] '; },
    e => { e.transcript.deltas[1].sourceEventId = 'id0'; e.transcript.deltas[1].sourceSeq = 1; },
    e => { e.transcript.persistedAfterReload = false; }, e => { e.measurement.recording.trace = 'on'; }];
  for (const mutate of mutations) { const e = functional(); mutate(e); assert.throws(() => assertFunctional(e)); }
});

test('shared decision is correlated when present and absent run-only decisions stay valid', () => {
  const row = intentRow(); assertIntentAudit(row);
  row.intent.decisionId = 'decision'; row.audits[1].details.decisionId = 'decision';
  row.shared_decision = { id: 'decision', companyId: 'c', runId: 'r', issueId: 'i' }; assertIntentAudit(row);
  row.shared_decision.runId = 'foreign'; assert.throws(() => assertIntentAudit(row));
});

const arm = (index, shift = 0, variant = 'b0') => {
  const offset = index * 10000;
  const evidence = JSON.parse(JSON.stringify(functional()), (key,value) => {
    if (value === 'r') return `r${index}`; if (value === 'c') return `c${index}`; if (value === 'i') return `i${index}`;
    return typeof value === 'number' && (key.endsWith('AtMs') || key === 'epochMs') ? value + offset : value;
  });
  evidence.variant = variant;
  for (const key of ['ackObservedAtMs','absenceObservedAtMs','lastAckNotObservedAtMs','lastProcessesPresentAtMs','httpSettledAtMs'])
    evidence.timing[key] += shift;
  for (const sample of evidence.observerSamples) { sample.startedAtMs += shift; sample.completedAtMs += shift; }
  return evidence;
};
const pairs = (shift = () => 0) => Array.from({ length: 5 }, (_, pair) => [
  arm(2*pair + (pair % 2), shift(pair,0)), arm(2*pair + (pair % 2 ? 0 : 1), shift(pair,1))]);

test('noise artifact freezes actual suitable A/A limits with counts, spread, chronological drift and resolution labels', () => {
  const noise = noiseEnvelope(pairs((pair,side) => side ? pair+1 : 0));
  assert.equal(noise.suitable, true); assert.equal(noise.noiseFrozen, true); assertNoiseEnvelope(noise);
  assert.deepEqual(noise.sampleCounts, { pairs: 5, arms: 10 }); assert.equal(noise.rawArms.length, 10);
  for (const metric of METRICS) {
    const row = noise.metrics[metric]; assert.equal(row.noiseMs, 5); assert.equal(row.sampleCount, 10);
    assert.equal(row.precisionBudgetMs, Math.max(2*W.pollIntervalMs, 0.10*row.pooledMedianMs));
    assert(row.maximumObserverBracketMs <= row.precisionBudgetMs);
  }
  assert.equal(noise.metrics.releaseAckToAckMs.resolutionLabel, '100 ms resolution floor');
  assert.equal(noise.metrics.releaseAckToAckMs.medianDifferencePercent, null);
  assert.equal(noise.metrics.releaseAckToAckMs.percentageSpeedClaimsAllowed, false);
});
test('every calibration and comparison arm must pass the complete functional oracle', () => {
  const noise = noiseEnvelope(pairs());
  const mutations = [e => { delete e.lock; }, e => { delete e.ack; }, e => { delete e.processesAfter; },
    e => { delete e.lease; }, e => { delete e.transcript; }, e => Object.assign(e, evidence()),
    e => { e.transcript.persistedAfterReload = false; }];
  for (const mutate of mutations) {
    const invalid = pairs(); mutate(invalid[4][1]);
    assert.throws(() => noiseEnvelope(invalid)); assert.throws(() => comparePairs(invalid, noise));
  }
  const forged = pairs(); forged[0][0] = evidence();
  assert.throws(() => noiseEnvelope(forged)); assert.throws(() => comparePairs(forged, noise));
});
test('paired jitter and chronological drift outside prospective budget retain all arms and cannot freeze noise', () => {
  for (const data of [pairs((pair,side) => side ? 150 : 0), pairs(pair => pair * 60)]) {
    const noise = noiseEnvelope(data);
    assert.equal(noise.suitable, false); assert.equal(noise.noiseFrozen, false); assert.equal(noise.rawArms.length, 10);
    assert(METRICS.every(metric => noise.metrics[metric].noiseMs === null));
    assert.throws(() => assertNoiseEnvelope(noise)); assert.throws(() => comparePairs(pairs(), noise));
  }
  const drift = noiseEnvelope(pairs(pair => pair * 60));
  assert.equal(drift.metrics.releaseAckToAckMs.maximumAbsolutePairedDifferenceMs, 0);
  assert(drift.metrics.releaseAckToAckMs.absoluteChronologicalMedianDriftMs > drift.metrics.releaseAckToAckMs.precisionBudgetMs);
});
test('raw observer brackets retain actual query/check durations and reject missing or forged timing', () => {
  const e = functional(), brackets = observerBrackets(e);
  assert.equal(brackets.releaseAckToAckMs.widthMs, 5);
  assert.equal(brackets.releaseAckToAckMs.negativeDurationMs, 1);
  assert.equal(brackets.releaseAckToAbsenceMs.successfulDurationMs, 1);
  e.observerSamples[0].durationMs = 0; assert.throws(() => observerBrackets(e));
  delete e.observerSamples; assert.throws(() => assertFunctional(e));
});
test('a wide observer bracket invalidates A/A suitability and comparison despite stable latency medians', () => {
  const data = pairs(() => 120), e = data[0][0];
  e.observerSamples = e.observerSamples.filter(sample => sample.kind !== 'ack-query' || sample.value);
  delete e.timing.lastAckNotObservedAtMs;
  const unsuitable = noiseEnvelope(data);
  assert.equal(unsuitable.metrics.releaseAckToAckMs.maximumAbsolutePairedDifferenceMs, 0);
  assert.equal(unsuitable.suitable, false); assert.throws(() => assertNoiseEnvelope(unsuitable));
  const noise = noiseEnvelope(pairs(() => 120));
  const result = comparePairs(data, noise);
  assert.equal(result.releaseAckToAckMs.pass, false);
  assert.equal(result.releaseAckToAckMs.noiseMs, 0);
});
test('comparison uses unchanged frozen noise and budget; one paired regression or inflated artifact fails', () => {
  const calibration = pairs((pair,side) => side ? pair+1 : 0), noise = noiseEnvelope(calibration);
  assert(Object.values(comparePairs(calibration, noise)).every(row => row.pass));
  const regression = pairs((pair,side) => side ? 6 : 0);
  assert(Object.values(comparePairs(regression, noise)).every(row => !row.pass));
  const forged = structuredClone(noise); forged.metrics.releaseAckToAckMs.noiseMs = 999;
  assert.throws(() => comparePairs(pairs(), forged));
  const inflated = structuredClone(noise); inflated.metrics.releaseAckToAckMs.precisionBudgetMs = 999;
  assert.throws(() => comparePairs(pairs(), inflated));
  assert.throws(() => noiseEnvelope(pairs().slice(1)));
});
test('optional shared cancellation accepts absent/requested B0 metadata and validates present state, time, attribution and run scope', () => {
  const when = '2026-11-04T10:00:00.000Z';
  const e = functional(); assertFunctional(e);
  e.ack.shared_execution_cancellation = { state: 'requested', requestedAt: when };
  e.ack.run_cancellation = { source: 'operator', expected: true, initiator: { type: 'user' }, reason: 'Operator Stop', recordedAt: when };
  assertFunctional(e);
  e.ack.shared_execution_cancellation = { state: 'acknowledged', acknowledgedAt: when }; assertFunctional(e);
  for (const patch of [{ state: 'requested' }, { state: 'acknowledged', acknowledgedAt: 'invalid' },
    { state: 'other', requestedAt: when }]) {
    const bad = structuredClone(e); bad.ack.shared_execution_cancellation = patch; assert.throws(() => assertFunctional(bad));
  }
  const wrong = structuredClone(e); wrong.ack.run_cancellation.source = 'provider'; assert.throws(() => assertFunctional(wrong));
  const foreign = structuredClone(e); foreign.sharedSettlement = { companyId: 'c', runId: 'foreign', status: 'cancelled' };
  assert.throws(() => assertFunctional(foreign));
});

test('calibration and comparison reject reused runs, overlapping arms and nonalternating chronology', () => {
  const noise = noiseEnvelope(pairs());
  for (const corrupt of [data => { data[4][1] = data[0][0]; },
    data => { data[0][1].startedAtMs = data[0][0].finishedAtMs; },
    data => { data[1].reverse(); }]) {
    const invalid = pairs(); corrupt(invalid);
    assert.throws(() => noiseEnvelope(invalid)); assert.throws(() => comparePairs(invalid, noise));
  }
});
