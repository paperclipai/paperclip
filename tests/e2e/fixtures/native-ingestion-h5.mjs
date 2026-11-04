import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const H5_MODE = 'h5c-observe-original-sla-independent-agents-settlement';
export const H5_PROTOCOL = 'v5c-independent-agents-complete-settlement-original-sla';
export const H4E_PROTOCOL = 'v4e-independent-agents-settlement-original-deadlines';
export const H5_TOPOLOGY = Object.freeze({ mode: 'one-normal-agent-per-concurrent-participant',
  fullRemoteAgentPoolSize: 100, agentSetupConcurrency: 8, maxConcurrentRuns: 50,
  poolReuse: 'only-across-sequential-cases' });
export const H5_BASELINE_REVISIONS = Object.freeze({ B0: '7550ffa5d6447d2615bc89fc5313f4cbb958b615',
  B1: '2cf1454406cbd582a11f04476713eceb746eada5' });
export const ORIGINAL_BUDGETS = Object.freeze({ providerReadinessMs: 300_000, fullInvocationMs: 900_000,
  streamingMs: 120_000, terminalDrainageMs: 180_000, stopAcknowledgementMs: 30_000, remoteLeaseCleanupMs: 30_000 });
export const H5_LIMITS = Object.freeze({ streamingMs: 600_000, terminalDrainageMs: 180_000, fullInvocationMs: 1_200_000 });
export const SETTLEMENT_MAX_TRANSITIONS_PER_RUN = 16;
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
  topology: H5_TOPOLOGY, originalDeadlineProtocol: H4E_PROTOCOL,
  settlement: { classification: 'Failed native retryable_failure remains pending within the original terminal window',
    detailReads: 'Only failed run-list candidates use the normal detail GET; no event polling or retry dispatch',
    maxTransitionsPerRun: SETTLEMENT_MAX_TRANSITIONS_PER_RUN,
    retryRatePolicy: 'No new recorded error class after frozen A/A; every paired and median total/per-class unique-ever-failed-run rate increase must stay within absolute paired A/A noise',
    recordedFailures: 'Post-timing exact-run-set read-only snapshot unions current and durable recovered error codes with observed transitions; retained recovery metadata is last-failure evidence, not exhaustive per-class history' },
  originalBudgets: ORIGINAL_BUDGETS, observationLimits: H5_LIMITS, workloads: H5_WORKLOADS,
  pairs: 5, order: 'baseline-first on even pair index; candidate-first on odd pair index',
  stages: ['B0 A/A', 'B1 A/A', 'B0→B1 nonregression', 'B1→B2 improvement', 'B0→B2 improvement'],
  knownBaselineMisses: ['burst512:streaming120', 'invocation:observed-total-duration900'],
  baselineEligibility: 'Finite complete correct observation; SLA misses remain failures of the H4e original deadlines',
  cursorCandidateEligibility: 'Nonregression; only the paired baseline exact registered known misses may be inherited',
  finalCandidateEligibility: 'Every original SLA passes in every arm; independently assessed total duration <900s; later H4e default-mode functional PASS on the same harness source and independent-agent geometry required',
  noise: 'Fresh B0 and B1 A/A frozen before any further product implementation; no old abort/profile samples',
  performance: 'Loaded p95 emission/intended-to-visible and terminal drainage improve beyond frozen noise in median and at least4/5 pairs; all other metrics nonregress',
});
export const H5_WORKLOAD_SHA256 = createHash('sha256').update(JSON.stringify(H5_REGISTRATION)).digest('hex');

/** Agent setup settles in full before any case activation; its time remains
 * inside the owning invocation and outside the existing admission300s window. */
export async function prepareParticipantAgents({ count, createAndReady, now = Date.now, onOutcome = _value => {} }) {
  assert.ok(Number.isSafeInteger(count) && count > 0 && count <= H5_TOPOLOGY.fullRemoteAgentPoolSize);
  const agents = new Array(count), failures = [];
  const outcome = { count, concurrency: H5_TOPOLOGY.agentSetupConcurrency, startedAtMs: now(), settledAtMs: null,
    complete: false, attempts: [] };
  onOutcome(outcome);
  let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(count, outcome.concurrency) }, async () => {
    for (;;) {
      const index = next++; if (index >= count) return;
      const attempt = { index, startedAtMs: now(), settledAtMs: null, status: 'pending', agentId: null };
      outcome.attempts.push(attempt); onOutcome(outcome);
      try {
        agents[index] = await createAndReady(index);
        assert.ok(typeof agents[index]?.id === 'string', 'Missing ready participant agent');
        attempt.agentId = agents[index].id; attempt.status = 'fulfilled';
      } catch (error) {
        failures.push(error); attempt.status = 'rejected'; attempt.error = String(error);
      } finally { attempt.settledAtMs = now(); onOutcome(outcome); }
    }
  }));
  for (const worker of workers) if (worker.status === 'rejected') failures.push(worker.reason);
  if (!failures.length) try { assert.equal(new Set(agents.map(agent => agent.id)).size, count, 'Participant agents must be distinct'); }
  catch (error) { failures.push(error); }
  outcome.settledAtMs = now(); outcome.complete = failures.length === 0; onOutcome(outcome);
  if (failures.length) throw new AggregateError(failures, 'Participant agent setup failed; no case may activate');
  return agents;
}

export function assertParticipantSetup(report) {
  assert.deepEqual(report.agentTopology, { ...H5_TOPOLOGY, remoteAgentPoolSize: report.qualificationOnly ? 3 : 100 });
  const ids = report.remote?.agentIds;
  assert.equal(ids?.length, report.agentTopology.remoteAgentPoolSize, 'Incomplete independent participant agent pool');
  assert.equal(new Set(ids).size, ids.length, 'Duplicate participant agent pool identity');
  const setup = report.remote.agentSetup;
  assert.equal(setup?.complete, true, 'Agent setup must settle successfully before any case');
  assert.equal(setup.count, ids.length); assert.equal(setup.concurrency, H5_TOPOLOGY.agentSetupConcurrency);
  assert.ok(Number.isSafeInteger(report.bodyStartedAtMs) && report.bodyStartedAtMs > 0);
  assert.ok(Number.isSafeInteger(setup.startedAtMs) && setup.startedAtMs >= report.bodyStartedAtMs);
  assert.ok(Number.isSafeInteger(setup.settledAtMs) && setup.settledAtMs >= setup.startedAtMs);
  assert.equal(setup.attempts?.length, ids.length);
  assert.deepEqual(setup.attempts.map(attempt => attempt.index).sort((a, b) => a - b), ids.map((_id, index) => index));
  const boundaries = [];
  for (const attempt of setup.attempts) {
    assert.equal(attempt.status, 'fulfilled', 'Rejected agent setup cannot qualify');
    assert.equal(attempt.agentId, ids[attempt.index]);
    assert.ok(Number.isSafeInteger(attempt.startedAtMs) && attempt.startedAtMs >= setup.startedAtMs);
    assert.ok(Number.isSafeInteger(attempt.settledAtMs) && attempt.settledAtMs >= attempt.startedAtMs && attempt.settledAtMs <= setup.settledAtMs);
    if (attempt.settledAtMs > attempt.startedAtMs) boundaries.push([attempt.startedAtMs, 1], [attempt.settledAtMs, -1]);
  }
  let active = 0;
  for (const [_time, delta] of boundaries.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    active += delta; assert.ok(active <= setup.concurrency, 'Agent setup exceeded the fixed concurrency');
  }
  for (const item of report.cases) assert.ok(item.activations?.[0]?.startedAtMs >= setup.settledAtMs,
    'Agent setup must finish before every case activation');
}

export function assertParticipantTopology(report, result) {
  const ids = report.remote?.agentIds;
  if (!result.stop) {
    const rows = result.controllerAuthority?.rows;
    assert.equal(rows?.length, result.runs, 'Missing participant authority rows');
    assert.equal(new Set(rows.map(row => row.agent_id)).size, result.runs, 'Concurrent participants must use distinct normal agents');
    assert.ok(rows.every(row => ids.includes(row.agent_id)), 'Participant authority is outside the normal agent pool');
  }
}

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
  // deadlineMs is the nominal configured boundary. Playwright can report its
  // timeout earlier when its next polling interval would cross that boundary.
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
    ? { status: terminal.complete ? 'passed' : 'failed', reason: terminal.complete ? null
      : terminal.censored === false && terminal.error ? 'original_terminal_failure' : 'original_terminal_deadline',
      startedAtMs: terminal.startedAtMs, deadlineMs: terminal.deadlineMs, assessedAtMs: terminal.assessedAtMs }
    : { status: 'not-reached', reason: 'original_streaming_deadline', startedAtMs: null, deadlineMs: null, assessedAtMs: null };
}

/** The run list omits nativePhase. Resolve failed rows through the normal run
 * detail API before deciding whether the existing terminal window has drained. */
export async function observeRunSettlement({ readRuns, readRun, poll, expectedRuns, now = Date.now, onOutcome = _value => {} }) {
  const startedAtMs = now();
  const outcome = { startedAtMs, deadlineMs: startedAtMs + ORIGINAL_BUDGETS.terminalDrainageMs,
    assessedAtMs: 0, lastObservedAtMs: 0, observedRuns: 0, terminalRuns: 0, pendingRetryRuns: 0,
    lastStatuses: [], transitions: [], uniqueRetryableRuns: 0, recoveredRuns: 0, nonretryableFailures: 0,
    retryableErrorClasses: {}, complete: false, censored: false };
  const previous = new Map();
  let runs = [];
  onOutcome(outcome);
  try {
    await poll(async () => {
      runs = [];
      for (const listed of await readRuns()) {
        const run = listed.status === 'failed' ? await readRun(listed.id) : listed;
        assert.equal(run.id, listed.id, 'Run detail belongs to a different run');
        if (listed.status === 'failed') {
          assert.ok(typeof run.runtimeMode === 'string', 'Run detail must expose runtimeMode');
          if (run.runtimeMode === 'native') assert.ok(Object.hasOwn(run, 'nativePhase'), 'Run detail must expose nativePhase');
        }
        runs.push(run);
      }
      assert.ok(runs.length <= expectedRuns && new Set(runs.map(run => run.id)).size === runs.length,
        'Terminal observation contains duplicate or additional runs');
      const observedAtMs = now();
      const statuses = runs.map(run => ({ runId: run.id, status: run.status,
        runtimeMode: run.runtimeMode ?? null, nativePhase: run.nativePhase ?? null, errorCode: run.errorCode ?? null }));
      for (const state of statuses) {
        const signature = JSON.stringify(state);
        if (previous.get(state.runId) !== signature) {
          assert.ok(outcome.transitions.filter(row => row.runId === state.runId).length < SETTLEMENT_MAX_TRANSITIONS_PER_RUN,
            'Terminal state transition evidence overflow; no observation may be dropped');
          outcome.transitions.push({ observedAtMs, ...state });
        }
        previous.set(state.runId, signature);
      }
      const pending = run => run.status === 'failed' && run.runtimeMode === 'native' && run.nativePhase === 'retryable_failure';
      const settled = run => ['succeeded', 'cancelled', 'failed'].includes(run.status) && !pending(run);
      Object.assign(outcome, { lastObservedAtMs: observedAtMs, observedRuns: runs.length,
        terminalRuns: runs.filter(settled).length, pendingRetryRuns: runs.filter(pending).length, lastStatuses: statuses,
        ...summarizeSettlementTransitions(outcome.transitions) });
      onOutcome(outcome);
      assert.ok(!runs.some(run => run.status === 'timed_out' || run.status === 'failed' && !pending(run)),
        'Terminal run failed; automatic retry is not pending');
      return runs.length === expectedRuns && runs.every(settled);
    }, ORIGINAL_BUDGETS.terminalDrainageMs);
    assert.equal(outcome.recoveredRuns, outcome.uniqueRetryableRuns, 'Every observed retryable run must recover successfully');
    outcome.assessedAtMs = now(); outcome.complete = true; onOutcome(outcome);
    return { runs, outcome };
  } catch (error) {
    outcome.assessedAtMs = now();
    outcome.censored = error?.matcherResult?.name === 'toBe' && error.matcherResult.pass === false
      && error.message.includes(`Timeout ${ORIGINAL_BUDGETS.terminalDrainageMs}ms exceeded while waiting on the predicate`);
    outcome.error = String(error); onOutcome(outcome); throw error;
  }
}

export function summarizeSettlementTransitions(transitions) {
  const retryable = new Set(), recovered = new Set(), permanent = new Set(), classes = new Map();
  for (const row of transitions) {
    if (row.status === 'failed' && row.runtimeMode === 'native' && row.nativePhase === 'retryable_failure') {
      assert.ok(typeof row.errorCode === 'string' && row.errorCode.length > 0, 'Retryable failure needs its observed error class');
      retryable.add(row.runId);
      const runs = classes.get(row.errorCode) ?? new Set(); runs.add(row.runId); classes.set(row.errorCode, runs);
    } else if (row.status === 'failed' || row.status === 'timed_out') permanent.add(row.runId);
    if (row.status === 'succeeded' && retryable.has(row.runId)) recovered.add(row.runId);
  }
  return { uniqueRetryableRuns: retryable.size, recoveredRuns: recovered.size, nonretryableFailures: permanent.size,
    retryableErrorClasses: Object.fromEntries([...classes].sort(([a], [b]) => a.localeCompare(b)).map(([code, runs]) => [code, runs.size])) };
}

export function assertSettlementObservation(value, item) {
  assert.ok(value, 'Missing canonical run settlement observation');
  assert.equal(value.complete, true); assert.equal(value.censored, false);
  assert.ok(Number.isSafeInteger(value.startedAtMs) && value.startedAtMs > 0);
  assert.equal(value.deadlineMs, value.startedAtMs + ORIGINAL_BUDGETS.terminalDrainageMs);
  assert.equal(value.assessedAtMs, item.settledAtMs);
  assert.ok(value.lastObservedAtMs >= value.startedAtMs && value.lastObservedAtMs <= value.assessedAtMs
    && value.assessedAtMs <= value.deadlineMs, 'Settlement must fit the original terminal window');
  assert.equal(value.observedRuns, item.runs); assert.equal(value.terminalRuns, item.runs); assert.equal(value.pendingRetryRuns, 0);
  assert.deepEqual(value.lastStatuses.map(row => row.runId).sort(), [...item.runIds].sort());
  assert.ok(value.lastStatuses.every(row => row.status === (item.stop ? 'cancelled' : 'succeeded')), 'Failed runs are not settled success');
  assert.ok(Array.isArray(value.transitions) && value.transitions.length >= item.runs
    && value.transitions.length <= item.runs * SETTLEMENT_MAX_TRANSITIONS_PER_RUN, 'Missing or overflowing bounded state history');
  const last = new Map(), counts = new Map(); let priorTime = value.startedAtMs;
  for (const row of value.transitions) {
    assert.ok(item.runIds.includes(row.runId), 'State history belongs to another run');
    assert.ok(Number.isSafeInteger(row.observedAtMs) && row.observedAtMs >= priorTime
      && row.observedAtMs <= value.lastObservedAtMs, 'Invalid state history timestamp');
    priorTime = row.observedAtMs;
    for (const field of ['runtimeMode', 'nativePhase', 'errorCode']) assert.ok(row[field] === null || typeof row[field] === 'string');
    const count = (counts.get(row.runId) ?? 0) + 1; counts.set(row.runId, count);
    assert.ok(count <= SETTLEMENT_MAX_TRANSITIONS_PER_RUN, 'State history overflow');
    last.set(row.runId, row);
  }
  for (const row of value.lastStatuses) {
    const { observedAtMs: _at, ...state } = last.get(row.runId) ?? {};
    assert.deepEqual(state, row, 'Final state must match retained state history');
  }
  const summary = summarizeSettlementTransitions(value.transitions);
  for (const [field, expected] of Object.entries(summary)) assert.deepEqual(value[field], expected, 'Retry ledger must match retained transitions');
  assert.equal(summary.nonretryableFailures, 0, 'Nonretryable failures cannot qualify');
  assert.equal(summary.recoveredRuns, summary.uniqueRetryableRuns, 'Every observed retryable run must recover successfully');
  return summary;
}

export function assertRecordedFailures(proof, item, companyId) {
  const observed = assertSettlementObservation(item.h5?.terminalObservation ?? item.terminalObservation, item);
  assert.equal(proof?.kind, 'recorded-run-failure-codes', 'Missing post-timing recorded failure proof');
  assert.equal(proof.transaction, 'READ ONLY REPEATABLE READ'); assert.equal(proof.observedReadOnly, 'on');
  assert.equal(proof.observedIsolation, 'repeatable read');
  const after = Math.max(item.settledAtMs, item.remoteLeasesCheckedAtMs ?? 0, item.stopAcknowledgedAtMs ?? 0,
    item.localStopProof?.checkedAtMs ?? 0);
  assert.ok(Number.isSafeInteger(proof.queryStartedAtMs) && proof.queryStartedAtMs >= after
    && Number.isSafeInteger(proof.checkedAtMs) && proof.checkedAtMs >= proof.queryStartedAtMs
    && Number.isSafeInteger(proof.connectionClosedAtMs) && proof.connectionClosedAtMs >= proof.checkedAtMs,
  'Close the post-timing failure snapshot after settlement and lease timing');
  assert.equal(proof.rows?.length, item.runs, 'Recorded failure proof needs every actual run');
  assert.deepEqual(proof.rows.map(row => row.run_id).sort(), [...item.runIds].sort(), 'Recorded failure run set mismatch');
  assert.equal(new Set(proof.rows.map(row => row.run_id)).size, item.runs);
  const classes = new Map(), ever = new Set(), recovered = new Set();
  const add = (runId, code) => {
    assert.ok(typeof code === 'string' && code.length > 0 && code.length <= 128, 'Missing closed recorded error code');
    ever.add(runId); const ids = classes.get(code) ?? new Set(); ids.add(runId); classes.set(code, ids);
  };
  const transitions = (item.h5?.terminalObservation ?? item.terminalObservation).transitions;
  for (const row of transitions) if (row.status === 'failed') add(row.runId, row.errorCode);
  for (const row of proof.rows) {
    assert.equal(row.company_id, companyId, 'Recorded failure company mismatch');
    assert.equal(row.agent_id, item.controllerAuthority.rows.find(authority => authority.run_id === row.run_id)?.agent_id,
      'Recorded failure agent mismatch');
    assert.equal(row.runtime_mode, 'native');
    assert.equal(row.status, item.stop ? 'cancelled' : 'succeeded', 'Recorded run is not successfully settled');
    if (!item.stop) assert.equal(row.native_phase, 'committed', 'Recorded native finalization is not committed');
    else assert.ok(row.native_phase === null || typeof row.native_phase === 'string', 'Invalid recorded cancellation phase');
    assert.ok(typeof row.current_has_error === 'boolean');
    assert.ok(row.current_error_code === null || typeof row.current_error_code === 'string');
    if (!item.stop) {
      assert.equal(row.current_has_error, false, 'Successful committed runs must clear their current execution error');
      assert.equal(row.current_error_code, null, 'Successful committed runs must clear their current execution error code');
    }
    // The normal Stop path writes the closed code "cancelled". Retain it as
    // cancellation evidence; every other recorded code remains failure evidence.
    if ((row.current_has_error || row.current_error_code !== null) && !(item.stop && row.current_error_code === 'cancelled'))
      add(row.run_id, row.current_error_code);
    if (row.recovered_type === null || row.recovered_type === 'null') {
      for (const key of ['recovered_schema', 'recovered_error_code', 'recovered_observed_at']) assert.equal(row[key], null);
    } else {
      assert.equal(row.recovered_type, 'object'); assert.equal(row.recovered_schema, 'paperclip.recovered_execution_failure.v1');
      assert.ok(typeof row.recovered_observed_at === 'string' && Number.isFinite(Date.parse(row.recovered_observed_at))
        && Date.parse(row.recovered_observed_at) <= proof.checkedAtMs, 'Invalid recovered failure observation time');
      add(row.run_id, row.recovered_error_code);
    }
    assert.ok(row.finalization_attempt === null || Number.isSafeInteger(row.finalization_attempt) && row.finalization_attempt >= 0,
      'Invalid descriptive finalization attempt');
    if (ever.has(row.run_id) && row.status === 'succeeded') recovered.add(row.run_id);
  }
  assert.equal(recovered.size, ever.size, 'Every recorded failed run must have recovered successfully');
  assert.ok(item.durable.every(row => row.resultAcceptedEvents === (item.stop ? 0 : 1)), 'Every run needs its exact independently persisted result');
  if (item.h5?.independentDrain) assert.ok(item.h5.independentDrain.verifiedAtMs >= proof.connectionClosedAtMs,
    'Independent drainage must include the closed recorded-failure snapshot');
  return { ...observed, uniqueEverFailedRuns: ever.size, allRecordedRecoveredRuns: recovered.size,
    recordedErrorClasses: Object.fromEntries([...classes].sort(([a], [b]) => a.localeCompare(b)).map(([code, ids]) => [code, ids.size])) };
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
      // The original matcher outcome is authoritative; assessedAtMs retains
      // the actual return time even when it precedes the nominal deadlineMs.
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
    assertSettlementObservation(value.terminalObservation, item);
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
