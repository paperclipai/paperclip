import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL, WORKLOAD as W, WORKLOAD_SHA256, METRICS, isAppendLockQuery, assertHeldSample,
  assertIntentAudit, metrics, registration, noiseEnvelope, comparePairs, assertFunctional, assertAuthoritativeRetirement, observerBrackets, assertNoiseEnvelope, PRECISION_RULE, cleanupCancellationEligible, cleanupOwnedRunBeforeClockClose } from './native-ingestion-blocked-stop-protocol.mjs';
const evidence = (shift = 0) => ({ protocol: PROTOCOL, workloadSha256: WORKLOAD_SHA256, complete: true, cleanup: { complete: true },
  timing: { actionAtMs: 1000, requestAtMs: 1005, releaseRequestedAtMs: 2005, releaseCommitAckAtMs: 2007,
    absenceObservedAtMs: 2030 + shift, ackObservedAtMs: 2040 + shift } });
const processes = () => ({ runner: { pid: 10, group: 10, birth: 'runner-birth' }, provider: { pid: 11, group: 11, birth: 'provider-birth' }, group: 10, providerGroup: 11 });
const sample = () => ({ processes: { ...processes(), runnerGroupAlive: true, providerGroupAlive: true }, httpPending: true, intent: null, auditIds: [], processesAlive: true, clockOpen: true, blockers: [{ blocking_pids: [88] }] });
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
  assertHeldSample(sample(), 88, processes());
  for (const patch of [{ httpPending: false }, { intent: {} }, { auditIds: ['a'] }, { processesAlive: false }, { clockOpen: false }, { blockers: [] }])
    assert.throws(() => assertHeldSample({ ...sample(), ...patch }, 88, processes()));
  assert.throws(() => assertHeldSample(sample(), 89, processes()));
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
  const e = evidence(), identity = { company_id: 'c', run_id: 'r', issue_id: 'i', runtime_mode: 'native', process_pid: 10, process_group_id: 10,
    process_started_at: '2026-11-04T00:00:00.000Z', process_identity_seq: '1', process_identity_source_event_id: null,
    process_identity: { targetKind: 'local', hostname: 'fixture-host', processPid: 10, processGroupId: 10, processStartedAt: '2026-11-04T00:00:00.000Z' },
    lease_id: 'lease', environment_id: 'environment', provider: 'local', provider_lease_id: null };
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
      { kind: 'process-check', startedAtMs: 2029, completedAtMs: 2030, durationMs: 1, value: true }], processesBefore: processes(), processesAfter: { runnerAbsent: true, groupAbsent: true, providerAbsent: true, providerGroupAbsent: true, group: 10, providerGroup: 11 },
    authorityBefore: { rows: [{ ...identity }] },
    authorityAfter: { rows: [{ ...structuredClone(identity), status: 'cancelled', cancellation_dispatch_state: 'acknowledged', native_cancellation: intentRow().intent,
      process_pid: null, process_group_id: null, process_started_at: null, process_stopped_seq: '20',
      process_stopped_source_event_id: null, process_stopped: { processPid: 10, processGroupId: 10, processStartedAt: identity.process_started_at },
      process_lifecycle_seq: '20', process_lifecycle_event_type: 'native.local_process_stopped', process_lifecycle_source_event_id: null,
      lease_status: 'released', lease_cleanup_status: 'success', lease_released_at: 'time' }] },
    authoritativeRetirementState: 'cleared-identity-with-authoritative-retirement',
    lease: { id: 'lease', heartbeatRunId: 'r', companyId: 'c', provider: 'local', providerLeaseId: null, releasedAt: 'time', status: 'released', cleanupStatus: 'success' },
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

const retained = (e = functional(), receipt = false) => {
  const before = e.authorityBefore.rows[0], after = e.authorityAfter.rows[0];
  Object.assign(after, { process_pid: before.process_pid, process_group_id: before.process_group_id, process_started_at: before.process_started_at });
  if (!receipt) Object.assign(after, { process_stopped_seq: null, process_stopped: null, process_stopped_source_event_id: null,
    process_lifecycle_seq: before.process_identity_seq, process_lifecycle_event_type: 'native.process_identity_recorded' });
  e.authoritativeRetirementState = 'retained-identity-after-physical-exit'; return e;
};
test('retained original identity with NULL retirement receipt passes only with independent exit, own ACK and released lease', () => {
  const e = retained();
  assert.equal(assertAuthoritativeRetirement(e), 'retained-identity-after-physical-exit'); assertFunctional(e);
  assert.equal(e.authorityAfter.rows[0].process_stopped, null);
});
test('cleared identity requires bound server retirement; a bound optional receipt also validates for retained identity', () => {
  const cleared = functional(); assert.equal(assertAuthoritativeRetirement(cleared), 'cleared-identity-with-authoritative-retirement');
  assertFunctional(cleared); assertFunctional(retained(functional(), true));
});
test('both states require valid captured authoritative original birth, including before JSON serialization', () => {
  for (const factory of [functional, retained]) {
    const valid = factory(), before = valid.authorityBefore.rows[0], after = valid.authorityAfter.rows[0];
    before.process_started_at = new Date(before.process_started_at);
    if (after.process_started_at !== null) after.process_started_at = new Date(after.process_started_at);
    assertFunctional(valid); assertFunctional(JSON.parse(JSON.stringify(valid)));
    for (const mutate of [e => {
      const original = e.authorityBefore.rows[0], current = e.authorityAfter.rows[0];
      original.process_started_at = null; original.process_identity.processStartedAt = null;
      current.process_identity.processStartedAt = null; current.process_started_at = null;
      if (current.process_stopped) current.process_stopped.processStartedAt = null;
    }, e => { delete e.authorityBefore.rows[0].process_started_at; },
    e => { e.authorityBefore.rows[0].process_started_at = 'not-a-birth'; e.authorityBefore.rows[0].process_identity.processStartedAt = 'not-a-birth'; }]) {
      const invalid = factory(); mutate(invalid);
      assert.throws(() => assertFunctional(invalid));
    }
  }
});
test('cleared identity rejects absent, unbound, partial or later-invalidated retirement evidence', () => {
  const mutations = [
    row => { row.process_stopped_seq = null; row.process_stopped = null; },
    row => { row.process_stopped_seq = null; }, row => { row.process_stopped_source_event_id = 'provider-event'; },
    row => { row.process_stopped.processPid = 99; }, row => { row.process_stopped.processGroupId = 99; },
    row => { row.process_stopped.processStartedAt = '2026-11-04T00:00:01.000Z'; }, row => { delete row.process_stopped.processStartedAt; },
    row => { row.process_stopped_seq = '1'; }, row => { row.process_started_at = '2026-11-04T00:00:00.000Z'; },
    row => { row.process_lifecycle_seq = '21'; row.process_lifecycle_event_type = 'native.process_start_requested'; },
    row => { row.process_identity_seq = '21'; }, row => { row.process_lifecycle_seq = '21'; },
    row => { row.process_lifecycle_source_event_id = 'provider-event'; }];
  for (const mutate of mutations) { const e = functional(); mutate(e.authorityAfter.rows[0]); assert.throws(() => assertAuthoritativeRetirement(e)); }
});
test('retained identity rejects changed PID, group, birth, server identity or later launch and verifies optional receipts', () => {
  const mutations = [row => { row.process_pid = null; }, row => { row.process_group_id = null; },
    row => { row.process_pid = 99; }, row => { row.process_group_id = 99; },
    row => { row.process_started_at = '2026-11-04T00:00:01.000Z'; }, row => { row.process_started_at = null; },
    row => { row.process_identity.processStartedAt = 'other'; }, row => { row.process_identity_seq = '2'; },
    row => { row.process_lifecycle_seq = '2'; row.process_lifecycle_event_type = 'native.process_start_requested'; },
    row => { row.process_identity_source_event_id = 'provider-event'; }, row => { delete row.process_stopped; }];
  for (const mutate of mutations) { const e = retained(); mutate(e.authorityAfter.rows[0]); assert.throws(() => assertAuthoritativeRetirement(e)); }
  const optional = retained(functional(), true); optional.authorityAfter.rows[0].process_stopped.processPid = 99;
  assert.throws(() => assertAuthoritativeRetirement(optional));
});
test('neither retirement state bypasses physical process/group absence, own audited ACK or exact lease cleanup', () => {
  const mutations = [e => { delete e.processesAfter.providerGroupAbsent; }, e => { e.processesAfter.groupAbsent = false; },
    e => { e.processesAfter.runnerAbsent = false; }, e => { e.processesAfter.providerAbsent = false; },
    e => { e.authorityAfter.rows[0].native_cancellation.intentId = 'other'; }, e => { e.ack.audits.pop(); },
    e => { e.authorityAfter.rows[0].status = 'failed'; }, e => { e.lease.id = 'other'; },
    e => { e.authorityAfter.rows[0].lease_id = 'other'; }, e => { e.lease.releasedAt = null; },
    e => { e.authorityAfter.rows[0].lease_released_at = null; }, e => { e.authorityAfter.rows[0].lease_cleanup_status = 'failed'; },
    e => { e.authorityAfter.rows[0].provider = 'remote'; }];
  for (const factory of [functional, retained]) for (const mutate of mutations) {
    const e = factory(); mutate(e); assert.throws(() => assertAuthoritativeRetirement(e));
  }
  const forged = retained(); forged.authoritativeRetirementState = 'cleared-identity-with-authoritative-retirement';
  assert.throws(() => assertFunctional(forged));
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

test('distinct provider group is valid, same-group topology is also valid, and both exact owned groups must be proved', () => {
  const distinct = functional(); assert.notEqual(distinct.processesBefore.group, distinct.processesBefore.providerGroup); assertFunctional(distinct);
  const shared = functional(); shared.processesBefore.provider.group = 10; shared.processesBefore.providerGroup = 10;
  shared.processesAfter.providerGroup = 10;
  for (const held of shared.heldSamples) { held.processes.provider.group = 10; held.processes.providerGroup = 10; }
  assertFunctional(shared);
  for (const mutate of [e => { delete e.processesBefore.providerGroup; }, e => { e.processesBefore.providerGroup = 99; },
    e => { e.processesBefore.provider.group = 0; }, e => { delete e.processesAfter.providerGroupAbsent; },
    e => { e.processesAfter.providerGroupAbsent = false; }, e => { e.processesAfter.providerGroup = 99; },
    e => { e.authorityBefore.rows[0].process_group_id = 99; }, e => { e.processesBefore.runner.group = 99; },
    e => { e.heldSamples[1].processes.provider.birth = 'different-birth'; }, e => { e.heldSamples[1].processes.runner.pid = 99; },
    e => { e.heldSamples[1].processes.providerGroupAlive = false; }, e => { e.heldSamples[1].processes.runnerGroupAlive = false; },
    e => { delete e.heldSamples[1].processes; }]) {
    const e = functional(); mutate(e); assert.throws(() => assertFunctional(e));
  }
});
test('cleanup eligibility follows supported active/scheduled and native retryable phases only', () => {
  for (const status of ['queued','running','scheduled_retry']) assert(cleanupCancellationEligible({ status }));
  assert(cleanupCancellationEligible({ status:'failed', runtimeMode:'native', nativePhase:'retryable_failure' }));
  for (const run of [{ status:'failed', runtimeMode:'legacy', nativePhase:'retryable_failure' },
    { status:'failed', runtimeMode:'native', nativePhase:'terminal_failure' }, { status:'failed', runtimeMode:'native' },
    { status:'succeeded' }, { status:'cancelled' }, { status:'timed_out' }]) assert.equal(cleanupCancellationEligible(run), false);
});
test('owned cleanup records public cancellation before closing its clock, including retryable failure', async () => {
  for (const before of [{ status:'running', runtimeMode:'native' }, { status:'failed', runtimeMode:'native', nativePhase:'retryable_failure' }]) {
    const order=[],record={}; let open=true,run={ id:'r',companyId:'c',...before };
    await cleanupOwnedRunBeforeClockClose({ companyId:'c',runId:'r',record,
      readRun:async()=>{ assert(open);order.push('read');return run; },
      cancelRun:async()=>{ assert(open);order.push('cancel');run={...run,status:'cancelled',resultJson:{nativeCancellation:{dispatchState:'acknowledged'}}};return {status:200,run}; },
      closeClock:async()=>{ order.push('close');open=false; } });
    assert.deepEqual(order,['read','cancel','read','close']); assert.equal(record.before.status,before.status);
    assert.equal(record.cancel.httpStatus,200); assert.equal(record.after.status,'cancelled'); assert.equal(record.after.nativeCancellation.dispatchState,'acknowledged');
    assert.equal('providerAbsent' in record,false,'Cancellation response is not physical Stop evidence');
  }
});
test('cleanup does not cancel terminal/foreign runs and closes clock after a failed cancellation attempt', async () => {
  for (const mode of ['terminal','foreign','cancel-error']) {
    const order=[],record={};let cancelled=false;
    const action=()=>cleanupOwnedRunBeforeClockClose({companyId:'c',runId:'r',record,
      readRun:async()=>{order.push('read');return {id:'r',companyId:mode==='foreign'?'other':'c',status:mode==='terminal'?'succeeded':'running'};},
      cancelRun:async()=>{cancelled=true;order.push('cancel');throw Error('controlled cancellation error');},
      closeClock:async()=>{order.push('close');} });
    if(mode==='terminal'){await action();assert.equal(record.cancel.attempted,false);assert.equal(cancelled,false);}
    else {await assert.rejects(action());assert(record.error);assert.equal(cancelled,mode==='cancel-error');}
    assert.equal(order.at(-1),'close');assert(record.clockClosedAtMs);
  }
});
