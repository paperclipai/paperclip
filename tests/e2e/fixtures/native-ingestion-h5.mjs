import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const H5_MODE = 'h5-observe-original-sla';
export const H5_PROTOCOL = 'v5-complete-observation-original-sla';
export const H5_BASELINE_REVISIONS = Object.freeze({ B0: 'a36567f9fbf805ad72207d54f539516e3121741e',
  B1: 'd8cd3be0aeed4f9fb93ecc3cf725f1d46d5a0310' });
export const ORIGINAL_BUDGETS = Object.freeze({ providerReadinessMs: 300_000, fullInvocationMs: 900_000,
  streamingMs: 120_000, terminalDrainageMs: 180_000, stopAcknowledgementMs: 30_000, remoteLeaseCleanupMs: 30_000 });
export const H5_LIMITS = Object.freeze({ streamingMs: 600_000, terminalDrainageMs: 180_000, fullInvocationMs: 1_200_000 });
export const H5_WORKLOADS = Object.freeze([
  { name: 'paced', runs: 1, events: 128, intervalMs: 25, prelude: 0, stop: false },
  { name: 'burst16', runs: 1, events: 16, intervalMs: 0, prelude: 0, stop: false },
  { name: 'burst128', runs: 10, events: 128, intervalMs: 0, prelude: 0, stop: false },
  { name: 'burst512', runs: 100, events: 512, intervalMs: 0, prelude: 0, stop: false },
  { name: 'existing-history', runs: 10, events: 128, intervalMs: 0, prelude: 1000, stop: false },
  { name: 'operator-stop', runs: 1, events: 512, intervalMs: 100, prelude: 0, stop: true },
]);
export const H5_REGISTRATION = Object.freeze({ mode: H5_MODE, protocolVersion: H5_PROTOCOL,
  baselineRevisions: H5_BASELINE_REVISIONS,
  originalBudgets: ORIGINAL_BUDGETS, observationLimits: H5_LIMITS, workloads: H5_WORKLOADS,
  pairs: 5, order: 'baseline-first on even pair index; candidate-first on odd pair index',
  stages: ['B0 A/A', 'B1 A/A', 'B0→B1 nonregression', 'B1→B2 improvement', 'B0→B2 improvement'],
  knownBaselineMisses: ['burst512:streaming120', 'invocation:observed-total-duration900'],
  baselineEligibility: 'Finite complete correct observation; SLA misses remain failures of H4c',
  cursorCandidateEligibility: 'Nonregression; only the paired baseline exact registered known misses may be inherited',
  finalCandidateEligibility: 'Every original SLA passes in every arm; independently assessed total duration <900s; later unchanged H4c full functional PASS required',
  noise: 'Fresh B0 and B1 A/A frozen before any further product implementation; no old abort/profile samples',
  performance: 'Loaded p95 emission/intended-to-visible and terminal drainage improve beyond frozen noise in median and at least4/5 pairs; all other metrics nonregress',
});
export const H5_WORKLOAD_SHA256 = createHash('sha256').update(JSON.stringify(H5_REGISTRATION)).digest('hex');

export function h5Enabled(value) {
  assert.ok(value === undefined || value === H5_MODE, 'Explicit supported H5 observation mode required');
  return value === H5_MODE;
}

// Keep the original Playwright poll as the first wait. Only its known matcher
// deadline may extend observation; callback errors and other failures propagate.
export async function observeStreaming({ readCount, poll, target, now = Date.now, onOutcome = _value => {} }) {
  const startedAtMs = now();
  let lastObservedCount = null, lastObservedAtMs = null, readError;
  const read = async () => {
    try {
      const count = await readCount();
      assert.ok(Number.isSafeInteger(count) && count >= 0, 'Invalid visible marker count');
      lastObservedCount = count; lastObservedAtMs = now(); return count;
    } catch (error) { readError = error; throw error; }
  };
  let deadlineError;
  try { await poll(read, ORIGINAL_BUDGETS.streamingMs, target); }
  catch (error) {
    if (readError) throw readError;
    assert.ok(error?.matcherResult?.name === 'toBeGreaterThanOrEqual' && error.matcherResult.pass === false
      && error.message.includes(`Timeout ${ORIGINAL_BUDGETS.streamingMs}ms exceeded while waiting on the predicate`),
    'Only the original streaming matcher deadline can extend observation');
    assert.ok(lastObservedCount !== null && lastObservedCount < target, 'Deadline needs an incomplete actual observation');
    deadlineError = error;
  }
  if (readError) throw readError;
  const original = { status: deadlineError ? 'failed' : 'passed', reason: deadlineError ? 'original_streaming_deadline' : null,
    startedAtMs, deadlineMs: startedAtMs + ORIGINAL_BUDGETS.streamingMs, assessedAtMs: now(),
    target, lastObservedCount, lastObservedAtMs, error: deadlineError?.message ?? null };
  const observation = { ceilingMs: H5_LIMITS.streamingMs, deadlineMs: startedAtMs + H5_LIMITS.streamingMs,
    complete: false, censored: false, completedAtMs: null };
  const result = { original, observation };
  onOutcome(result);
  if (deadlineError) {
    try {
      const remaining = observation.deadlineMs - now();
      assert.ok(remaining > 0, 'H5 streaming observation ceiling exceeded');
      await poll(read, remaining, target);
    } catch (error) { observation.censored = true; onOutcome(result); throw readError ?? error; }
  }
  if (readError) throw readError;
  observation.complete = true; observation.completedAtMs = now(); onOutcome(result);
  return result;
}

export function originalTerminal(streaming, terminal) {
  return streaming.original.status === 'passed'
    ? { status: terminal.complete ? 'passed' : 'failed', reason: terminal.complete ? null : 'original_terminal_deadline',
      startedAtMs: terminal.startedAtMs, deadlineMs: terminal.deadlineMs, assessedAtMs: terminal.assessedAtMs }
    : { status: 'not-reached', reason: 'original_streaming_deadline', startedAtMs: null, deadlineMs: null, assessedAtMs: null };
}

export function assessH5Arm(report, owner) {
  assert.equal(report.protocolVersion, H5_PROTOCOL);
  assert.equal(report.observationMode, H5_MODE);
  assert.equal(report.observationComplete, true, 'H5 requires complete finite observation');
  assert.equal(report.complete, true); assert.equal(report.qualificationOnly, false);
  assert.equal(report.diagnosticOnly, false); assert.equal(report.performanceAcceptanceEligible, true);
  assert.equal(report.cleanup?.complete, true); assert.deepEqual(report.cleanup.errors, []);
  assert.equal(report.workloadSha256, H5_WORKLOAD_SHA256, 'H5 registration changed');
  assert.deepEqual(report.observationLimits, H5_LIMITS);
  assert.deepEqual(report.resourceBudgets, ORIGINAL_BUDGETS);
  assert.equal(report.actualPlaywrightTimeoutMs, H5_LIMITS.fullInvocationMs);
  assert.deepEqual(report.cases.map(item => item.name), H5_WORKLOADS.map(item => item.name), 'Complete fixed six-case observation required');
  assert.equal(owner.status, 'passed', 'Owning Playwright attempt must pass observation/correctness');
  assert.equal(owner.retry, 0, 'Retries cannot replace an H5 arm');
  assert.deepEqual(owner.errors, []);
  assert.equal(owner.timeoutMs, H5_LIMITS.fullInvocationMs);
  assert.ok(Number.isFinite(owner.durationMs) && owner.durationMs > 0 && owner.durationMs < H5_LIMITS.fullInvocationMs);
  assert.ok(typeof owner.startedAt === 'string' && Number.isFinite(Date.parse(owner.startedAt)));
  const misses = [];
  for (const item of report.cases) {
    const value = item.h5;
    assert.ok(value, 'Missing H5 case outcomes');
    assert.equal(value.streaming.observation.complete, true);
    assert.equal(value.streaming.observation.censored, false);
    const streaming = value.streaming.original;
    for (const field of ['startedAtMs', 'deadlineMs', 'assessedAtMs', 'lastObservedAtMs'])
      assert.ok(Number.isSafeInteger(streaming[field]) && streaming[field] > 0, 'Missing raw original-deadline timing');
    assert.ok(['passed', 'failed'].includes(streaming.status));
    assert.equal(streaming.deadlineMs, streaming.startedAtMs + ORIGINAL_BUDGETS.streamingMs);
    assert.equal(streaming.target, item.stop ? 3 : item.events);
    assert.ok(Number.isSafeInteger(streaming.lastObservedCount) && streaming.lastObservedCount >= 0);
    assert.ok(streaming.lastObservedAtMs >= streaming.startedAtMs && streaming.lastObservedAtMs <= streaming.assessedAtMs);
    if (streaming.status === 'failed') {
      assert.equal(streaming.reason, 'original_streaming_deadline');
      assert.ok(streaming.lastObservedCount < streaming.target);
      assert.ok(streaming.assessedAtMs >= streaming.deadlineMs);
      assert.equal(item.stop, false, 'Control readiness cannot inherit a streaming SLA miss');
      assert.ok(streaming.error.includes('Timeout 120000ms exceeded while waiting on the predicate'));
      assert.equal(value.terminalOriginal.status, 'not-reached');
      assert.equal(value.terminalOriginal.reason, 'original_streaming_deadline');
      misses.push(`${item.name}:streaming120`);
    } else {
      assert.ok(streaming.lastObservedCount >= streaming.target);
      assert.equal(streaming.reason, null);
      assert.equal(streaming.error, null);
      assert.equal(value.terminalOriginal.status, 'passed');
    }
    assert.equal(value.terminalObservation.complete, true, 'H5 terminal observation must drain');
    assert.equal(value.terminalObservation.censored, false);
    assert.equal(value.terminalObservation.deadlineMs, value.terminalObservation.startedAtMs + H5_LIMITS.terminalDrainageMs);
    assert.equal(value.terminalObservation.assessedAtMs, item.settledAtMs);
    assert.equal(value.terminalObservation.observedRuns, item.runs); assert.equal(value.terminalObservation.terminalRuns, item.runs);
    assert.ok(value.terminalObservation.lastObservedAtMs >= value.terminalObservation.startedAtMs
      && value.terminalObservation.lastObservedAtMs <= value.terminalObservation.assessedAtMs);
    assert.deepEqual(value.terminalObservation.lastStatuses.map(row => row.runId).sort(), [...item.runIds].sort());
    assert.ok(value.terminalObservation.lastStatuses.every(row => row.status === (item.stop ? 'cancelled' : 'succeeded')));
    assert.equal(value.streaming.observation.ceilingMs, H5_LIMITS.streamingMs);
    assert.equal(value.streaming.observation.deadlineMs, streaming.startedAtMs + H5_LIMITS.streamingMs);
    assert.ok(value.streaming.observation.completedAtMs >= streaming.assessedAtMs
      && value.streaming.observation.completedAtMs <= value.streaming.observation.deadlineMs);
    assert.ok(value.terminalObservation.startedAtMs >= value.streaming.observation.completedAtMs);
    assert.ok(item.settledAtMs <= value.terminalObservation.deadlineMs);
    assert.deepEqual(value.terminalOriginal, originalTerminal(value.streaming, value.terminalObservation));
    assert.equal(value.visibleCountByOriginalPaintDeadline, item.visible.filter(marker => marker.visibleMs <= streaming.deadlineMs).length);
    assert.deepEqual(item.terminalStatuses.map(row => row.runId).sort(), [...item.runIds].sort());
    assert.ok(item.terminalStatuses.every(row => row.runtimeMode === 'native' && row.status === (item.stop ? 'cancelled' : 'succeeded')),
      'Failed terminal runs are not successful drainage');
    assert.ok(item.durable.every(row => row.resultAcceptedEvents === (item.stop ? 0 : 1)), 'Every completed run needs its independently persisted result');
    assert.ok(value.independentDrain.verifiedAtMs >= item.settledAtMs);
    assert.equal(value.independentDrain.elapsedFromEpochMs, value.independentDrain.verifiedAtMs - item.epochMs);
    assert.equal(value.independentDrain.deltaCount, item.durable.reduce((sum, row) => sum + row.individualDeltas, 0));
    assert.equal(value.independentDrain.resultAcceptedCount, item.stop ? 0 : item.runs);
    assert.equal(value.independentDrain.clockStreamsClosed, true);
  }
  if (owner.durationMs >= ORIGINAL_BUDGETS.fullInvocationMs) misses.push('invocation:observed-total-duration900');
  return { originalSlaPassed: misses.length === 0, misses,
    original900budget: { status: owner.durationMs < ORIGINAL_BUDGETS.fullInvocationMs ? 'passed' : 'failed',
      assessedAgainst: 'observed owning Playwright total duration', durationMs: owner.durationMs,
      limitMs: ORIGINAL_BUDGETS.fullInvocationMs,
      scope: 'Independent conservative gate; total duration can include hooks/teardown that the original timeout treats differently; not an exact original timer-expiration fact' } };
}

export function requireH5Candidate(policy, baseline, candidate) {
  if (policy === 'final-b2') assert.deepEqual(candidate.misses, [], 'Final B2 must pass every original SLA in every arm');
  else if (policy === 'cursor-nonregression') {
    const allowed = new Set(H5_REGISTRATION.knownBaselineMisses);
    assert.ok(candidate.misses.every(miss => allowed.has(miss) && baseline.misses.includes(miss)),
      'Cursor-only candidate may inherit only the paired baseline exact registered known misses');
  } else throw new Error('Explicit final-b2 or cursor-nonregression candidate policy required');
}
