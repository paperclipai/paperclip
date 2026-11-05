import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCounters } from './counters.mjs';
import { hash, pins } from './transforms.mjs';
import { CDP_TIMEOUT_MS, FINALIZE_EXPRESSION, ownedDirectory, ownedFile, evaluateCapture, validateInspector,
  validateCounters, verifyFinalizedFiles, sha256 } from './counter-capture-client.mjs';
import { bindAcknowledgement, markerCoverage } from './counter-proofs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const withTemp = async work => {
  const root = await mkdtemp(path.join(here, '.wrapper-test-'));
  try { return await work(root); } finally { await rm(root, { recursive: true, force: true }); }
};
const writeJson = (file, value) => writeFile(file, JSON.stringify(value));
async function proofFixture(root) {
  const directory = path.join(root, 'profile'); await mkdir(directory);
  const rows = [], counters = createCounters(row => rows.push({ atMs: 2, ...row }));
  counters.normalized(); const begin = counters.beginStarted(); counters.beginAck(begin);
  const scope = counters.scopeStarted(begin, false); counters.queryBuild('begin'); counters.queryBuild('commit');
  counters.completionRequested(scope, false); counters.completionAck(scope); counters.scopeFinished(scope); counters.beginResolved(begin);
  counters.postCommit({ runId: 'run', sourceInstanceId: 'source', sourceEventId: 'event', sourceSeq: 1,
    eventType: 'item.delta', payload: { text: '[0a0]' } }, 'committed');
  const counts = counters.snapshot();
  rows.push({ atMs: 3, kind: 'app-sample', counters: counts, fatalDiagnosticErrors: 0,
    localAppend: { calls: 1, pending: 0 }, portAppends: { appendEvent: { calls: 1, events: 1, pending: 0 } } });
  rows.push({ atMs: 3, kind: 'diagnostic-capture-finalized', counters: counts, v8CpuSampling: false });
  const metadata = { pid: 123, startedAtMs: 1, variant: 'B0', appRoot: path.join(root, 'fixture-app-not-executed') };
  const expected = { ...Object.fromEntries(Object.entries(pins.variants.B0.modules).map(([type, row]) => [type, row.sha256])),
    postgresIndex: pins.postgres.files['src/index.js'], postgresConnection: pins.postgres.files['src/connection.js'] };
  const modules = Object.entries(expected).map(([type, sha256]) => ({ type, sha256, transformed: type !== 'resolver',
    file: type.startsWith('postgres') ? path.join(metadata.appRoot, `node_modules/postgres/src/${type === 'postgresIndex' ? 'index' : 'connection'}.js`)
      : path.join(metadata.appRoot, pins.variants.B0.modules[type].path) }));
  rows.unshift(...modules.map(row => ({ atMs: 1, kind: 'instrumented-module', ...row })));
  const ndjson = rows.map(row => JSON.stringify(row) + '\n').join(''), recordFile = path.join(directory, 'app-123.ndjson');
  await writeFile(recordFile, ndjson);
  const stats = { recordsWritten: rows.length, bytesWritten: Buffer.byteLength(ndjson), errors: 0, pendingRecords: 0, pendingBytes: 0 };
  const observerFile = path.join(directory, 'app-123.observer.json'); await writeJson(observerFile, { ...stats, counters: counts });
  const receipt = { diagnosticOnly: true, performanceAcceptanceEligible: false, pid: 123, finalizedAtMs: 3,
    capturedBeforePlaywrightTeardown: true, v8CpuSampling: false, observer: stats, counters: counts, modules,
    observerFile, observerSha256: await sha256(observerFile), recordFile, recordFileSha256: await sha256(recordFile) };
  const receiptFile = path.join(directory, 'app-123.final-capture.json'); await writeJson(receiptFile, receipt);
  return { directory, metadata, receipt, result: { ...receipt, receiptFile, receiptSha256: await sha256(receiptFile) } };
}
test('independent filesystem proof accepts hash-matched final counters and rejects changed receipt/observer/log bytes', async () => withTemp(async root => {
  const fixture = await proofFixture(root), { directory, metadata, result } = fixture;
  const valid = await verifyFinalizedFiles(directory, metadata, result); assert.equal(valid.markers.length, 1); assert.equal(valid.recordCount, 10);
  const receiptBytes = await readFile(result.receiptFile); await writeFile(result.receiptFile, Buffer.concat([receiptBytes, Buffer.from(' ')]));
  await assert.rejects(verifyFinalizedFiles(directory, metadata, result), /Final receipt hash mismatch/);
  await writeFile(result.receiptFile, receiptBytes);
  await writeFile(result.observerFile, '{}'); await assert.rejects(verifyFinalizedFiles(directory, metadata, result), /Observer hash mismatch/);
}));

test('counter failures, missing ACK coverage, unknown/duplicate hooks and nonzero pending observer cannot pass a forged complete receipt', async () => withTemp(async root => {
  const { receipt, metadata } = await proofFixture(root); validateCounters(receipt, metadata);
  for (const key of ['errors', 'pendingRecords', 'pendingBytes']) {
    const corrupt = structuredClone(receipt); corrupt.observer[key] = 1; assert.throws(() => validateCounters(corrupt, metadata), /Counter observer/);
  }
  const missingAck = structuredClone(receipt); missingAck.counters.outerCommitAcknowledged = 0;
  assert.throws(() => validateCounters(missingAck, metadata), /Missing outerCommitAcknowledged/);
  for (const type of ['unknown', 'port']) {
    const corrupt = structuredClone(receipt); corrupt.modules.push({ ...corrupt.modules[0], type });
    assert.throws(() => validateCounters(corrupt, metadata), /Missing, duplicate or unknown hook/);
  }
  const preparedAsCommit = structuredClone(receipt); preparedAsCommit.counters.outerCommitAcknowledged = 2;
  assert.throws(() => validateCounters(preparedAsCommit, metadata));
}));

test('self-consistent file hashes cannot substitute a claimed receipt hook for an absent observed hook', async () => withTemp(async root => {
  const { directory, metadata, receipt, result } = await proofFixture(root);
  const lines = (await readFile(receipt.recordFile, 'utf8')).trimEnd().split('\n'); lines.shift();
  const body = lines.map(line => line + '\n').join(''); await writeFile(receipt.recordFile, body);
  receipt.recordFileSha256 = await sha256(receipt.recordFile);
  receipt.observer.recordsWritten = lines.length; receipt.observer.bytesWritten = Buffer.byteLength(body);
  await writeJson(receipt.observerFile, { ...receipt.observer, counters: receipt.counters });
  receipt.observerSha256 = await sha256(receipt.observerFile); await writeJson(result.receiptFile, receipt);
  const forged = { ...receipt, receiptFile: result.receiptFile, receiptSha256: await sha256(result.receiptFile) };
  await assert.rejects(verifyFinalizedFiles(directory, metadata, forged), /prove every receipt hook/);
}));

test('independent ACK must bind the same PID, boundary, observer/log hashes and counters as the reread receipt', async () => withTemp(async root => {
  const { receipt, metadata } = await proofFixture(root);
  const ack = { ...receipt }; bindAcknowledgement(ack, metadata, receipt);
  for (const field of ['pid', 'finalizedAtMs', 'observerSha256', 'recordFileSha256']) {
    const corrupt = structuredClone(ack); corrupt[field] = typeof corrupt[field] === 'number' ? corrupt[field] + 1 : '0'.repeat(64);
    assert.throws(() => bindAcknowledgement(corrupt, metadata, receipt));
  }
  const corrupt = structuredClone(ack); corrupt.counters.outerCommitAcknowledged++;
  assert.throws(() => bindAcknowledgement(corrupt, metadata, receipt));
}));

test('capture ownership rejects a different uid, symlink evidence and canonical escape from the owned directory', async () => withTemp(async root => {
  const { directory, result } = await proofFixture(root);
  assert.equal(await ownedDirectory(directory), directory);
  await assert.rejects(ownedDirectory(directory, process.getuid() + 1), /owner mismatch/);
  const link = path.join(directory, 'receipt-link.json'); await symlink(result.receiptFile, link);
  await assert.rejects(ownedFile(directory, link), /regular file/);
  const outside = path.join(root, 'outside.json'); await writeFile(outside, '{}');
  await assert.rejects(ownedFile(directory, outside), /escapes/);
}));

test('inspector validation and CDP use only Runtime.evaluate, bind exact PID and fail on early close without an ACK', async () => {
  const inspector = { diagnosticOnly: true, pid: 123, v8CpuSampling: false, url: 'ws://127.0.0.1:1234/owned-target' };
  assert.equal(validateInspector(inspector, 123), inspector.url); assert.equal(CDP_TIMEOUT_MS, 10_000);
  for (const url of ['ws://example.com:1234/target', 'wss://127.0.0.1:1234/target', 'ws://user@127.0.0.1:1234/target', 'ws://127.0.0.1:1234/target?x=1']) assert.throws(() => validateInspector({ ...inspector, url }, 123));
  for (const [observedPid, earlyClose] of [[123, false], [999, false], [123, true]]) {
    const requests = []; let closed = false;
    class FakeSocket extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      send(text) {
        const message = JSON.parse(text); requests.push(message);
        queueMicrotask(() => {
          if (earlyClose && requests.length === 2) return this.dispatchEvent(new Event('close'));
          const value = requests.length === 1 ? observedPid : { diagnosticOnly: true, pid: 123 };
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: message.id, result: { result: { value } } }) }));
        });
      }
      close() { closed = true; this.dispatchEvent(new Event('close')); }
    }
    if (observedPid === 123 && !earlyClose) assert.equal((await evaluateCapture(inspector.url, 123, FakeSocket)).pid, 123);
    else await assert.rejects(evaluateCapture(inspector.url, 123, FakeSocket));
    assert.ok(closed); assert.ok(requests.every(row => row.method === 'Runtime.evaluate'));
    assert.equal(requests[0].params.expression, 'process.pid');
    if (requests.length === 2) { assert.equal(requests[1].params.expression, FINALIZE_EXPRESSION); assert.equal(requests[1].params.awaitPromise, true); }
    if (observedPid !== 123) assert.equal(requests.length, 1);
  }
});

test('marker-level coverage keeps normal complete joins and Stop prefix while rejecting missing, foreign and duplicated observations', () => {
  const source = (code, index, nonce) => ({ markerCode: code, index, nonce, emittedMs: 1 });
  const proof = (runId, markerCode, token, count, stop) => ({ runId, markerCode, token, individualDeltas: count,
    uniqueSourceIdentities: count, matchedSourceClocks: count, ordered: true, resultAcceptedEvents: stop ? 0 : 1 });
  const evidence = { cases: [{ runs: 1, events: 2, stop: false, persistedAfterReload: true,
    clockEvidence: [{ emissions: [source('0a', 0, 'normal'), source('0a', 1, 'normal')] }], durable: [proof('run', '0a', 'normal', 2, false)] },
  { runs: 1, events: 512, stop: true, persistedAfterReload: true,
    clockEvidence: [{ emissions: [source('0b', 0, 'stop'), source('0b', 1, 'stop')] }], durable: [proof('stop-run', '0b', 'stop', 1, true)] }] };
  const markers = [['0a', 0, 'run'], ['0a', 1, 'run'], ['0b', 0, 'stop-run']].map(([markerCode, index, runId]) => ({ markerCode, index, runId, identitySha256: hash(`${runId}:${index}`) }));
  const valid = markerCoverage(evidence, markers); assert.equal(valid.originalSourceMarkers, 4); assert.equal(valid.independentlyDurableMarkers, 3);
  assert.equal(valid.complete, true);
  assert.throws(() => markerCoverage(evidence, markers.slice(1)), /Missing postcommit/);
  assert.throws(() => markerCoverage(evidence, [...markers, markers[0]]), /Duplicate postcommit/);
  assert.throws(() => markerCoverage(evidence, markers.map((row, i) => i ? row : { ...row, runId: 'foreign' })));
  assert.throws(() => markerCoverage(evidence, [...markers, { markerCode: '0b', index: 1, runId: 'stop-run', identitySha256: hash('tail') }])) ;
});
