import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { h5Enabled, H5_MODE, observeStreaming, originalTerminal, requireH5Candidate,
  H5_LIMITS, ORIGINAL_BUDGETS, prepareParticipantAgents, observeRunSettlement } from '../tests/e2e/fixtures/native-ingestion-h5.mjs';

const timeout = milliseconds => Object.assign(new Error(`Timeout ${milliseconds}ms exceeded while waiting on the predicate`),
  { matcherResult: { name: 'toBeGreaterThanOrEqual', pass: false } });

test('the actual paginated result counter counts accepted results in default H4e and observation H5c', async () => {
  const source = await readFile(new URL('../tests/e2e/native-event-ingestion.journey.ts', import.meta.url), 'utf8');
  const statements = source.split('\n').filter(line => line.includes('resultAcceptedEvents++'));
  assert.equal(statements.length, 1, 'Exercise the actual event-loop counter statement');
  const count = new Function('h5', 'rows', `let resultAcceptedEvents = 0;
    for (const row of rows) { const event = row.payload?.prpEvent; ${statements[0]} } return resultAcceptedEvents;`);
  for (const h5 of [false, true]) {
    assert.equal(count(h5, [{ eventType: 'run.result.accepted', payload: { prpEvent: { eventType: 'run.result.accepted' } } }]), 1);
    assert.equal(count(h5, [{ payload: { prpEvent: { eventType: 'run.result.accepted' } } }]), 1);
    assert.equal(count(h5, [{ eventType: 'run.result.proposed' }, { payload: { prpEvent: { eventType: 'item.delta' } } }]), 0);
    assert.equal(count(h5, []), 0);
  }
});

test('real frozen Playwright tiny poll exposes the matcher deadline shape used by H5', async () => {
  const require = createRequire(import.meta.url), { expect } = require('@playwright/test');
  assert.equal(require('@playwright/test/package.json').version, '1.62.1');
  await assert.rejects(expect.poll(async () => 0, { timeout: 15, intervals: [5] }).toBeGreaterThanOrEqual(1), error => {
    assert.equal(error.matcherResult?.name, 'toBeGreaterThanOrEqual');
    assert.equal(error.matcherResult.pass, false);
    assert.ok(error.message.includes('Timeout 15ms exceeded while waiting on the predicate'));
    return true;
  });
  // This checks the real library's format; it does not execute a120s wait or
  // claim runtime qualification of H5's extended application path.
});

test('real frozen Playwright can report its configured timeout before the nominal deadline', async context => {
  const require = createRequire(import.meta.url), { expect } = require('@playwright/test');
  assert.equal(require('@playwright/test/package.json').version, '1.62.1');
  const timeoutMs = 1200, intervalMs = 1500, startedAtMs = Date.now(), started = performance.now();
  let observations = 0, failure;
  try {
    await expect.poll(async () => { observations++; return 0; }, { timeout: timeoutMs, intervals: [intervalMs] }).toBeGreaterThanOrEqual(1);
  } catch (error) { failure = error; }
  const assessedAtMs = Date.now(), elapsedMs = performance.now() - started;
  assert.equal(failure?.matcherResult?.name, 'toBeGreaterThanOrEqual');
  assert.equal(failure.matcherResult.pass, false);
  assert.ok(failure.message.includes(`Timeout ${timeoutMs}ms exceeded while waiting on the predicate`));
  assert.equal(observations, 1);
  assert.ok(assessedAtMs < startedAtMs + timeoutMs, 'The real poll ends before its nominal deadline when its next interval would cross it');
  context.diagnostic(JSON.stringify({ scope: 'Small real-library poll only; no app or120s runtime qualification',
    playwrightVersion: '1.62.1', timeoutMs, intervalMs, startedAtMs, nominalDeadlineMs: startedAtMs + timeoutMs,
    assessedAtMs, elapsedMs, observations, matcherName: failure.matcherResult.name, matcherPassed: failure.matcherResult.pass }));
});

test('H5c requires its explicit mode and leaves default H4e selected', () => {
  assert.equal(h5Enabled(undefined), false); assert.equal(h5Enabled(H5_MODE), true);
  assert.throws(() => h5Enabled('almost-h5'));
  assert.throws(() => h5Enabled('h5-observe-original-sla'), 'Old H5a observations use a different geometry');
  assert.throws(() => h5Enabled('h5b-observe-original-sla-independent-agents'), 'Old H5b observations stop before supported recovery');
});

for (const fail of [false, true]) test(`participant setup uses at most8 workers, preserves index order and settles all attempts${fail ? ' after a failure' : ''}`, async () => {
  const count = 20, pending = [], records = []; let active = 0, maximum = 0, finished = 0;
  const completion = prepareParticipantAgents({ count, onOutcome: value => records.push(structuredClone(value)),
    createAndReady: async index => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => pending.push(resolve)); active--; finished++;
      if (fail && index === 3) throw new Error('actual agent readiness failed');
      return { id: `agent-${index}` };
    } }).then(value => ({ value }), error => ({ error }));
  while (finished < count) {
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(active <= 8); pending.splice(0).reverse().forEach(resolve => resolve());
  }
  const result = await completion, last = records.at(-1);
  assert.equal(maximum, 8); assert.equal(active, 0); assert.equal(last.attempts.length, count);
  assert.ok(last.attempts.every(attempt => attempt.status !== 'pending'));
  assert.equal(last.complete, !fail);
  if (fail) { assert.match(result.error.message, /setup failed/); assert.equal(last.attempts.filter(value => value.status === 'rejected').length, 1); }
  else assert.deepEqual(result.value.map(agent => agent.id), Array.from({ length: count }, (_, index) => `agent-${index}`));
});

test('first successful observation uses only the original wait with no collection delay', async () => {
  const calls = [];
  const value = await observeStreaming({ readCount: async () => 16, target: 16, now: () => 1000,
    poll: async (read, milliseconds, target) => { calls.push(milliseconds); assert.ok(await read() >= target); } });
  assert.deepEqual(calls, [120000]); assert.equal(value.original.status, 'passed');
  assert.equal(value.observation.complete, true); assert.equal(value.observation.completedAtMs, 1000);
});

test('known120s miss assessed before its nominal deadline stays failed and uses only the remaining600s observation', async () => {
  let clock = 1000, count = 30; const calls = [], records = [];
  const value = await observeStreaming({ readCount: async () => count, target: 512, now: () => clock,
    onOutcome: value => records.push(structuredClone(value)),
    poll: async (read, milliseconds) => {
      calls.push(milliseconds); await read();
      if (calls.length === 1) { clock += milliseconds - 750; throw timeout(milliseconds); }
      count = 512; clock += 90000; await read();
    } });
  assert.deepEqual(calls, [120000, 480750]);
  assert.equal(value.original.status, 'failed'); assert.equal(value.original.lastObservedCount, 30);
  assert.equal(value.original.lastObservedAtMs, 1000); assert.equal(value.original.deadlineMs, 121000);
  assert.equal(value.original.assessedAtMs, 120250); assert.ok(value.original.assessedAtMs < value.original.deadlineMs);
  assert.equal(value.observation.completedAtMs, 210250); assert.equal(records[0].observation.complete, false);
  assert.equal(value.original.reason, 'original_streaming_deadline');
});

test('page read failures and unknown poll failures never become an expected SLA miss', async () => {
  const failure = new Error('page detached');
  await assert.rejects(observeStreaming({ readCount: async () => { throw failure; }, target: 1,
    poll: async read => { try { await read(); } catch {} throw timeout(120000); } }), error => error === failure);
  await assert.rejects(observeStreaming({ readCount: async () => 0, target: 1,
    poll: async () => { throw new Error('unrelated assertion'); } }), /Only the original streaming matcher deadline/);
});

test('observation ceiling leaves a censored failure, never a substituted latency', async () => {
  let clock = 1000, calls = 0; const records = [];
  await assert.rejects(observeStreaming({ readCount: async () => 30, target: 512, now: () => clock,
    onOutcome: value => records.push(structuredClone(value)),
    poll: async (read, milliseconds) => { await read(); calls++; clock += milliseconds; throw timeout(milliseconds); } }), /Timeout/);
  assert.equal(calls, 2); assert.equal(clock, 601000);
  assert.equal(records.at(-1).observation.complete, false); assert.equal(records.at(-1).observation.censored, true);
  assert.equal(records.at(-1).observation.completedAtMs, null);
});

test('original terminal is not reached after120s miss; observational180s is distinct', () => {
  const terminal = { complete: true, startedAtMs: 211000, deadlineMs: 391000, assessedAtMs: 212000 };
  assert.deepEqual(originalTerminal({ original: { status: 'failed' } }, terminal), {
    status: 'not-reached', reason: 'original_streaming_deadline', startedAtMs: null, deadlineMs: null, assessedAtMs: null });
  assert.equal(originalTerminal({ original: { status: 'passed' } }, terminal).status, 'passed');
  assert.equal(originalTerminal({ original: { status: 'passed' } }, { ...terminal, complete: false,
    censored: false, error: 'Terminal run failed' }).reason, 'original_terminal_failure');
  assert.equal(H5_LIMITS.terminalDrainageMs, ORIGINAL_BUDGETS.terminalDrainageMs);
});

test('terminal observation keeps a supported native retry pending until same-run recovery within the original window', async () => {
  let clock = 1000, reads = 0; const calls = [], records = [];
  const states = [{ status: 'running', runtimeMode: 'native', nativePhase: 'executing' },
    { status: 'failed', runtimeMode: 'native', nativePhase: 'retryable_failure', errorCode: 'provider_transport_failed' },
    { status: 'succeeded', runtimeMode: 'native', nativePhase: 'committed' }];
  const value = await observeRunSettlement({ expectedRuns: 1, now: () => clock,
    onOutcome: value => records.push(structuredClone(value)),
    readRuns: async () => [{ id: 'same-run', status: states[Math.min(reads++, 2)].status }],
    readRun: async id => { calls.push(id); return { id, ...states[1] }; },
    poll: async (read, milliseconds) => {
      assert.equal(milliseconds, 180000);
      while (clock < 181000) { if (await read()) return; clock += 30000; }
      throw new Error('Unexpected terminal timeout');
    } });
  assert.equal(reads, 3); assert.deepEqual(calls, ['same-run']);
  assert.equal(value.runs[0].status, 'succeeded'); assert.equal(value.outcome.complete, true);
  assert.equal(value.outcome.startedAtMs, 1000); assert.equal(value.outcome.deadlineMs, 181000);
  assert.equal(value.outcome.assessedAtMs, 61000); assert.equal(value.outcome.censored, false);
  assert.equal(records.find(value => value.lastStatuses[0]?.nativePhase === 'retryable_failure').terminalRuns, 0);
  assert.deepEqual(value.outcome.transitions.map(row => row.status), ['running', 'failed', 'succeeded']);
  assert.equal(value.outcome.uniqueRetryableRuns, 1); assert.equal(value.outcome.recoveredRuns, 1);
  assert.equal(value.outcome.nonretryableFailures, 0);
  assert.deepEqual(value.outcome.retryableErrorClasses, { provider_transport_failed: 1 });
});

test('a permanent native failure rejects immediately without waiting for another provider turn', async () => {
  let reads = 0; const records = [];
  await assert.rejects(observeRunSettlement({ expectedRuns: 2,
    onOutcome: value => records.push(structuredClone(value)),
    readRuns: async () => { reads++; return [{ id: 'failed-run', status: 'failed' }, { id: 'still-running', status: 'running' }]; },
    readRun: async id => ({ id, status: 'failed', runtimeMode: 'native', nativePhase: 'terminal_failure' }),
    poll: async (read, milliseconds) => { assert.equal(milliseconds, 180000); await read(); } }), /Terminal run failed/);
  assert.equal(reads, 1); assert.equal(records.at(-1).complete, false); assert.equal(records.at(-1).censored, false);
});

test('an unsettled retry is censored at the one unchanged180s deadline, never a completed latency', async () => {
  let clock = 1000, reads = 0; const records = [], calls = [];
  const error = Object.assign(new Error('Timeout 180000ms exceeded while waiting on the predicate'),
    { matcherResult: { name: 'toBe', pass: false } });
  await assert.rejects(observeRunSettlement({ expectedRuns: 1, now: () => clock,
    onOutcome: value => records.push(structuredClone(value)),
    readRuns: async () => { reads++; return [{ id: 'same-run', status: 'failed' }]; },
    readRun: async id => ({ id, status: 'failed', runtimeMode: 'native', nativePhase: 'retryable_failure', errorCode: 'provider_transport_failed' }),
    poll: async (read, milliseconds) => {
      calls.push(milliseconds);
      while (clock < 181000) { if (await read()) return; clock += 30000; }
      throw error;
    } }), value => value === error);
  assert.deepEqual(calls, [180000]); assert.equal(reads, 6);
  const last = records.at(-1); assert.equal(last.deadlineMs, 181000); assert.equal(last.assessedAtMs, 181000);
  assert.equal(last.complete, false); assert.equal(last.censored, true); assert.equal(last.terminalRuns, 0);
});

test('failed-list details may already show recovery; detail errors and unknown phases fail closed', async () => {
  const value = await observeRunSettlement({ expectedRuns: 1,
    readRuns: async () => [{ id: 'run', status: 'failed' }],
    readRun: async id => ({ id, status: 'succeeded', runtimeMode: 'native', nativePhase: 'committed' }),
    poll: async read => assert.equal(await read(), true) });
  assert.equal(value.runs[0].status, 'succeeded'); assert.equal(value.outcome.uniqueRetryableRuns, 0);
  const failure = new Error('normal detail GET failed');
  for (const readRun of [async () => { throw failure; },
    async id => ({ id, status: 'failed', runtimeMode: 'native', nativePhase: 'unknown' })]) {
    await assert.rejects(observeRunSettlement({ expectedRuns: 1,
      readRuns: async () => [{ id: 'run', status: 'failed' }], readRun, poll: async read => read() }),
    error => error === failure || error.message.includes('Terminal run failed'));
  }
});

test('the real frozen Playwright terminal poll preserves detail errors and exposes its deadline matcher', async () => {
  const require = createRequire(import.meta.url), { expect } = require('@playwright/test');
  const failure = new Error('actual callback failure');
  await assert.rejects(expect.poll(async () => { throw failure; }, { timeout: 15 }).toBe(true), error => error === failure);
  await assert.rejects(expect.poll(async () => false, { timeout: 15, intervals: [5] }).toBe(true), error => {
    assert.equal(error.matcherResult?.name, 'toBe'); assert.equal(error.matcherResult.pass, false);
    assert.ok(error.message.includes('Timeout 15ms exceeded while waiting on the predicate')); return true;
  });
});

test('bounded state evidence fails on overflow instead of omitting a transition', async () => {
  let reads = 0;
  await assert.rejects(observeRunSettlement({ expectedRuns: 1,
    readRuns: async () => [{ id: 'run', status: 'running', errorCode: String(reads++) }], readRun: async () => assert.fail(),
    poll: async read => { for (let index = 0; index < 17; index++) await read(); } }), /evidence overflow/);
});

test('cursor inherits only paired exact known misses; final candidate inherits none', () => {
  const base = { misses: ['burst512:streaming120'] };
  requireH5Candidate('cursor-nonregression', base, base);
  const slowInvocation = { misses: ['invocation:observed-total-duration900'] };
  requireH5Candidate('cursor-nonregression', slowInvocation, slowInvocation);
  requireH5Candidate('final-b2', base, { misses: [] });
  for (const candidate of [{ misses: ['paced:streaming120'] }, { misses: ['invocation:observed-total-duration900'] },
    { misses: ['operator-stop:streaming120'] }]) assert.throws(() => requireH5Candidate('cursor-nonregression', base, candidate));
  assert.throws(() => requireH5Candidate('final-b2', base, base), /every original SLA/);
  assert.throws(() => requireH5Candidate('final-b2', slowInvocation, slowInvocation), /every original SLA/);
});
