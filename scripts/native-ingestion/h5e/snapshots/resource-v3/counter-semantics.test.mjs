import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCounters } from './counters.mjs';
import { hash, pins, replaceExactly, symbolName, transform } from './transforms.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const postgres = path.join(here, 'test-fixtures/postgres');
const read = file => readFileSync(file, 'utf8');
const index = read(path.join(postgres, 'src/index.js'));
const withObserver = async (api, work) => {
  const symbol = Symbol.for(symbolName), previous = globalThis[symbol]; globalThis[symbol] = api;
  try { return await work(); } finally { if (previous === undefined) delete globalThis[symbol]; else globalThis[symbol] = previous; }
};
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };

// Execute only the actual transformed driver's extracted begin/scope closure
// with an in-memory SQL acknowledgement stub. Never import postgres, connect,
// launch an app or execute compiled product modules.
function fakeBegin(controls = {}) {
  const transformed = transform('postgresIndex', index, 'B0');
  const from = transformed.indexOf('  async function begin(options, fn) {');
  const to = transformed.indexOf('\n  function move(c, queue) {', from);
  assert.ok(from > 0 && to > from);
  const source = transformed.slice(from, to), commands = [];
  const connection = { queue: {}, execute() { return true; } };
  const command = async text => {
    commands.push(text);
    if (text === 'commit') {
      controls.commitReached?.resolve(); if (controls.commitGate) await controls.commitGate.promise;
      if (controls.commitFailure) throw controls.commitFailure;
    }
    if (text.startsWith('prepare transaction') && controls.prepareFailure) throw controls.prepareFailure;
    if (text.startsWith('rollback') && controls.rollbackFailure) throw controls.rollbackFailure;
    return [];
  };
  function Sql(handler) {
    function sql(strings, ...values) {
      if (!Array.isArray(strings?.raw)) return String(strings);
      return command(strings.reduce((text, piece, i) => text + piece + (i < values.length ? values[i] : ''), '').trim());
    }
    sql.unsafe = value => value;
    sql.injectUncaughtQueryError = error => handler({ catch(reject) { reject(error); }, reject() {} });
    return sql;
  }
  const outer = { unsafe(text, _, { onexecute }) { return { async execute() {
    commands.push(text.trim());
    if (controls.beginFailure) throw controls.beginFailure;
    onexecute(connection); return [];
  } }; } };
  class PostgresError extends Error {}
  const factory = new Function('sql', 'Queue', 'Sql', 'full', 'reserved', 'move', 'PostgresError', `return (${source});`);
  return { begin: factory(outer, () => [], Sql, {}, {}, () => {}, PostgresError), commands, source };
}

test('unknown bytes, variants and absent/duplicated anchors fail without legacy fallback', () => {
  assert.throws(() => transform('postgresIndex', index + '\n', 'B0'), /Unqualified/);
  assert.throws(() => transform('postgresIndex', index, 'old'), /Unknown/);
  assert.throws(() => replaceExactly('missing', 'anchor', ''), /Expected one/);
  assert.throws(() => replaceExactly('anchor anchor', 'anchor', ''), /Expected one/);
});

test('outer COMMIT is counted only after its actual awaited acknowledgement, not query construction or request', async () => {
  const rows = [], counters = createCounters(row => rows.push(row));
  const commitReached = deferred(), commitGate = deferred(), { begin } = fakeBegin({ commitReached, commitGate });
  await withObserver(counters, async () => {
    const pending = begin(async () => 'value'); await commitReached.promise;
    const before = counters.snapshot(); assert.equal(before.outerCommitRequested, 1);
    assert.equal(before.outerCommitAcknowledged, 0); assert.equal(before.beginResolved, 0); assert.equal(rows.length, 0);
    commitGate.resolve(); assert.equal(await pending, 'value');
  });
  const after = counters.snapshot(); assert.equal(after.outerCommitAcknowledged, 1);
  assert.equal(after.beginResolved, 1); assert.equal(after.scopesPending, 0);
  assert.deepEqual(rows.map(row => row.completion), ['commit']);
});

test('injected COMMIT failure preserves the exact error and never counts a committed transaction or rollback', async () => {
  const error = new Error('commit rejected'), counters = createCounters(), { begin, commands } = fakeBegin({ commitFailure: error });
  await withObserver(counters, async () => assert.rejects(begin(() => 9), candidate => candidate === error));
  const value = counters.snapshot(); assert.equal(value.outerCommitRequested, 1); assert.equal(value.outerCommitFailed, 1);
  assert.equal(value.outerCommitAcknowledged, 0); assert.equal(value.outerRollbackAcknowledged, 0);
  assert.equal(value.beginRejected, 1); assert.equal(value.scopesPending, 0); assert.deepEqual(commands, ['begin', 'commit']);
});

test('callback rejection and acknowledged rollback are distinct, preserving original thrown error', async () => {
  const error = new Error('work rejected'), counters = createCounters(), { begin, commands } = fakeBegin();
  await withObserver(counters, async () => assert.rejects(begin(() => { throw error; }), candidate => candidate === error));
  const value = counters.snapshot(); assert.equal(value.outerWorkRejected, 1); assert.equal(value.outerRollbackAcknowledged, 1);
  assert.equal(value.outerCommitRequested, 0); assert.equal(value.outerCommitAcknowledged, 0);
  assert.equal(value.beginRejected, 1); assert.equal(value.scopesPending, 0); assert.deepEqual(commands, ['begin', 'rollback']);
});

test('actual scope handler retains its lexical uncaught-query error and original rollback propagation', async () => {
  const error = new Error('uncaught query'), counters = createCounters(), { begin } = fakeBegin();
  await withObserver(counters, async () => assert.rejects(begin(sql => {
    sql.injectUncaughtQueryError(error); return 3;
  }), candidate => candidate === error));
  const value = counters.snapshot(); assert.equal(value.outerWorkRejected, 1);
  assert.equal(value.outerRollbackAcknowledged, 1); assert.equal(value.outerCommitAcknowledged, 0);
});

test('rollback failure retains original postgres replacement-error behavior and has no rollback ACK', async () => {
  const work = new Error('work'), rollback = new Error('rollback'), counters = createCounters();
  const { begin } = fakeBegin({ rollbackFailure: rollback });
  await withObserver(counters, async () => assert.rejects(begin(() => { throw work; }), candidate => candidate === rollback));
  const value = counters.snapshot(); assert.equal(value.outerRollbackFailed, 1); assert.equal(value.outerRollbackAcknowledged, 0);
  assert.equal(value.outerCommitAcknowledged, 0); assert.equal(value.scopesPending, 0);
});

test('BEGIN rejection stays separate from callback, COMMIT and rollback failures', async () => {
  const error = new Error('begin'), counters = createCounters(), { begin } = fakeBegin({ beginFailure: error });
  await withObserver(counters, async () => assert.rejects(begin(() => 1), candidate => candidate === error));
  const value = counters.snapshot(); assert.equal(value.beginInvocations, 1); assert.equal(value.beginAcknowledged, 0);
  assert.equal(value.beginRejectedBeforeAcknowledgment, 1); assert.equal(value.outerScopes, 0); assert.equal(value.outerCommitAcknowledged, 0);
});

test('nested successful scopes and rollback-to scopes never inflate outer transactions', async () => {
  const counters = createCounters(), { begin, commands } = fakeBegin();
  await withObserver(counters, async () => {
    assert.equal(await begin(async sql => {
      assert.equal(await sql.savepoint(() => 7), 7);
      const error = new Error('nested');
      await assert.rejects(sql.savepoint(() => { throw error; }), candidate => candidate === error);
      return 11;
    }), 11);
  });
  const value = counters.snapshot(); assert.equal(value.outerCommitAcknowledged, 1);
  assert.equal(value.nestedScopes, 2); assert.equal(value.nestedWorkSucceeded, 1);
  assert.equal(value.nestedWorkRejected, 1); assert.equal(value.nestedRollbackAcknowledged, 1);
  assert.equal(value.scopesPending, 0); assert.deepEqual(commands, ['begin', 'savepoint s0', 'savepoint s1', 'rollback to s1', 'commit']);
});

test('prepared transaction ACK and failure are not committed transactions', async () => {
  for (const fail of [false, true]) {
    const counters = createCounters(), error = new Error('prepare'), { begin } = fakeBegin({ prepareFailure: fail ? error : null });
    await withObserver(counters, async () => {
      const operation = begin(sql => { sql.prepare('prepared'); return 3; });
      if (fail) await assert.rejects(operation, candidate => candidate === error); else assert.equal(await operation, 3);
    });
    const value = counters.snapshot(); assert.equal(value.outerPrepareRequested, 1);
    assert.equal(value.outerPrepareAcknowledged, fail ? 0 : 1); assert.equal(value.outerPrepareFailed, fail ? 1 : 0);
    assert.equal(value.outerCommitAcknowledged, 0); assert.equal(value.scopesPending, 0);
  }
});

test('query-build attempts retain transaction commands but cannot become ACKs or log statement/parameters', () => {
  const rows = [], counters = createCounters(row => rows.push(row));
  for (const statement of ['begin', 'commit', 'rollback', 'savepoint x', 'select secret_parameter']) counters.queryBuild(statement);
  const value = counters.snapshot(); assert.equal(value.queryBuildAttempts, 5);
  assert.deepEqual(value.queryBuildVerbs, { begin: 1, commit: 1, rollback: 1, savepoint: 1, select: 1 });
  assert.equal(value.outerCommitAcknowledged, 0); assert.equal(value.beginInvocations, 0); assert.deepEqual(rows, []);
  assert.equal(JSON.stringify(value).includes('secret_parameter'), false);
});

test('postcommit new identities, duplicate receipts and later callback failures keep distinct durable semantics', async () => {
  const records = [], counters = createCounters(row => records.push(row)), { begin } = fakeBegin();
  const event = { runId: 'run', sourceInstanceId: 'source', sourceEventId: 'event', sourceSeq: 1,
    eventType: 'item.delta', payload: { text: '[0c0]' } }, failure = new Error('later callback');
  await withObserver(counters, async () => {
    const append = async () => { await begin(() => 1); counters.postCommit(event, 'committed'); throw failure; };
    await assert.rejects(append(), error => error === failure);
  });
  counters.postCommit(event, 'duplicate');
  const value = counters.snapshot(); assert.equal(value.outerCommitAcknowledged, 1); assert.equal(value.postCommitEvents, 1);
  assert.equal(value.postCommitMarkers, 1); assert.equal(value.duplicateReceipts, 1);
  assert.throws(() => counters.postCommit(event, 'committed'), /Repeated committed/);
  const marker = records.find(row => row.kind === 'postcommit-marker'); assert.equal(marker.index, 0);
  assert.match(marker.identitySha256, /^[a-f0-9]{64}$/); assert.equal(JSON.stringify(records).includes('sourceInstanceId'), false);
});

test('actual transformed AsyncQueue counts accepted values, direct handoff and buffered depth without altering close/failure semantics', async () => {
  const original = read(path.join(here, 'test-fixtures/modules/queue.js')), source = transform('queue', original, 'B0');
  const body = source.slice(source.indexOf('class AsyncQueue {'), source.indexOf('export class CodexSessionState'));
  const counters = createCounters(); let queue, peak = 0;
  const observer = { ...counters, registerQueue(value) { queue = value; }, observeQueue() { peak = Math.max(peak, queue.__resourceCounterDepth()); } };
  await withObserver(observer, async () => {
    const Queue = new Function(body + '\nreturn AsyncQueue;')(), value = new Queue();
    value.push(1); value.push(2); value.push(3); assert.equal(value.__resourceCounterDepth(), 3);
    const iterator = value[Symbol.asyncIterator]();
    for (const n of [1, 2, 3]) assert.deepEqual(await iterator.next(), { value: n, done: false });
    const pending = iterator.next(); value.push(4); assert.deepEqual(await pending, { value: 4, done: false });
    value.close(); value.push(5); assert.deepEqual(await iterator.next(), { value: undefined, done: true });
    assert.equal(counters.snapshot().normalizedEvents, 4); assert.equal(peak, 3);
    const failed = new Queue(); failed.push(6); const error = new Error('integrity'); failed.fail(error);
    assert.equal(failed.__resourceCounterDepth(), 0); await assert.rejects(failed[Symbol.asyncIterator]().next(), candidate => candidate === error);
  });
});
