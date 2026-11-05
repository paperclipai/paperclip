import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { pins, pinsFile, symbolName } from './transforms.mjs';

export const CDP_TIMEOUT_MS = 10_000;
export const FINALIZE_EXPRESSION = `globalThis[Symbol.for('${symbolName}')].finalizeCapture()`;
const inside = (root, file) => file.startsWith(root + path.sep);
const integer = value => Number.isSafeInteger(value) && value >= 0;
export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function ownedDirectory(directory, expectedUid = process.getuid()) {
  assert.ok(directory && path.isAbsolute(directory));
  const canonical = await realpath(directory), temporary = await realpath('/tmp');
  assert.ok(inside(temporary, canonical), 'Counter output must be temporary');
  assert.equal(path.basename(canonical), 'profile');
  const info = await lstat(canonical), parent = await lstat(path.dirname(canonical));
  assert.ok(info.isDirectory() && parent.isDirectory());
  assert.equal(info.uid, expectedUid, 'Counter directory owner mismatch');
  assert.equal(parent.uid, expectedUid, 'Counter output parent owner mismatch');
  return canonical;
}
export async function ownedFile(directory, file) {
  assert.ok(typeof file === 'string' && path.isAbsolute(file));
  const info = await lstat(file); assert.ok(info.isFile() && !info.isSymbolicLink(), 'Evidence must be a regular file');
  const canonical = await realpath(file); assert.ok(inside(directory, canonical), 'Evidence escapes owned capture directory');
  return canonical;
}
export async function readJson(file) {
  assert.ok((await lstat(file)).size <= 4 * 1024 * 1024, 'Bounded capture JSON exceeded');
  return JSON.parse(await readFile(file, 'utf8'));
}
export function validateInspector(inspector, expectedPid) {
  assert.equal(inspector.diagnosticOnly, true); assert.equal(inspector.pid, expectedPid);
  assert.equal(inspector.v8CpuSampling, false);
  const url = new URL(inspector.url);
  assert.equal(url.protocol, 'ws:'); assert.equal(url.hostname, '127.0.0.1');
  for (const field of ['username', 'password', 'search', 'hash']) assert.equal(url[field], '');
  assert.ok(integer(Number(url.port)) && Number(url.port) > 0 && Number(url.port) <= 65535);
  assert.ok(url.pathname.length > 1, 'Missing inspector target identity');
  return url.href;
}
export async function evaluateCapture(url, expectedPid, WebSocketClass = globalThis.WebSocket) {
  assert.equal(typeof WebSocketClass, 'function');
  const deadline = Date.now() + CDP_TIMEOUT_MS, socket = new WebSocketClass(url), pending = new Map();
  let nextId = 0, failure;
  const fail = error => {
    failure = error;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  socket.addEventListener('error', () => fail(new Error('Counter inspector failed')));
  socket.addEventListener('close', () => fail(new Error('Counter inspector closed before acknowledgement')));
  socket.addEventListener('message', event => {
    try {
      const message = JSON.parse(String(event.data)), entry = pending.get(message.id); if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error('Counter inspector CDP error')) : entry.resolve(message.result);
    } catch (error) { fail(error); }
  });
  const request = params => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const remaining = deadline - Date.now(); if (remaining <= 0) return reject(new Error('Counter CDP deadline expired'));
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error('Counter CDP deadline expired')); }, remaining);
    pending.set(id, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params })); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  const value = response => {
    assert.ok(response && !response.exceptionDetails, 'Counter evaluation failed');
    assert.ok(response.result && Object.hasOwn(response.result, 'value'), 'Missing by-value counter result');
    return response.result.value;
  };
  try {
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer); socket.removeEventListener('open', opened); socket.removeEventListener('error', errored); socket.removeEventListener('close', closed);
        error ? reject(error) : resolve();
      };
      const opened = () => finish(), errored = () => finish(new Error('Counter inspector cannot connect'));
      const closed = () => finish(new Error('Counter inspector closed during connection'));
      const timer = setTimeout(() => finish(new Error('Counter CDP deadline expired')), Math.max(1, deadline - Date.now()));
      socket.addEventListener('open', opened, { once: true }); socket.addEventListener('error', errored, { once: true }); socket.addEventListener('close', closed, { once: true });
    });
    assert.equal(value(await request({ expression: 'process.pid', returnByValue: true })), expectedPid, 'Inspector target PID mismatch');
    return value(await request({ expression: FINALIZE_EXPRESSION, awaitPromise: true, returnByValue: true }));
  } finally { fail(new Error('Counter client closed')); socket.close(); }
}
export function validateCounters(receipt, metadata) {
  assert.equal(receipt.diagnosticOnly, true); assert.equal(receipt.performanceAcceptanceEligible, false);
  assert.equal(receipt.pid, metadata.pid); assert.equal(receipt.v8CpuSampling, false);
  assert.equal(receipt.capturedBeforePlaywrightTeardown, true);
  assert.ok(integer(receipt.finalizedAtMs) && receipt.finalizedAtMs >= metadata.startedAtMs);
  const observer = receipt.observer;
  for (const key of ['errors', 'pendingRecords', 'pendingBytes']) assert.equal(observer[key], 0, `Counter observer ${key}`);
  for (const key of ['recordsWritten', 'bytesWritten']) assert.ok(integer(observer[key]) && observer[key] > 0);
  const counts = receipt.counters;
  for (const [key, value] of Object.entries(counts)) if (key !== 'queryBuildVerbs') assert.ok(integer(value), `Invalid counter ${key}`);
  for (const key of ['normalizedEvents', 'postCommitEvents', 'postCommitMarkers', 'queryBuildAttempts', 'beginAcknowledged', 'outerCommitAcknowledged']) assert.ok(counts[key] > 0, `Missing ${key} coverage`);
  assert.equal(counts.scopesPending, 0);
  assert.ok(counts.postCommitEvents >= counts.postCommitMarkers);
  assert.ok(counts.outerCommitAcknowledged + counts.outerCommitFailed <= counts.outerCommitRequested);
  assert.ok(counts.outerPrepareAcknowledged + counts.outerPrepareFailed <= counts.outerPrepareRequested);
  assert.ok(counts.beginAcknowledged <= counts.beginInvocations);
  const expected = { ...Object.fromEntries(Object.entries(pins.variants[metadata.variant].modules).map(([type, row]) => [type, row.sha256])),
    postgresIndex: pins.postgres.files['src/index.js'], postgresConnection: pins.postgres.files['src/connection.js'] };
  assert.deepEqual(receipt.modules.map(row => row.type).sort(), Object.keys(expected).sort(), 'Missing, duplicate or unknown hook');
  for (const row of receipt.modules) {
    assert.equal(row.sha256, expected[row.type]); assert.equal(row.transformed, row.type !== 'resolver');
    assert.ok(inside(metadata.appRoot, row.file));
    if (row.type.startsWith('postgres')) assert.ok(row.file.endsWith(`/postgres/src/${row.type === 'postgresIndex' ? 'index' : 'connection'}.js`));
    else assert.equal(row.file, path.join(metadata.appRoot, pins.variants[metadata.variant].modules[row.type].path));
  }
}
export async function verifyFinalizedFiles(directory, metadata, result) {
  assert.equal(path.basename(result.receiptFile), `app-${metadata.pid}.final-capture.json`);
  const receiptFile = await ownedFile(directory, result.receiptFile);
  assert.equal(await sha256(receiptFile), result.receiptSha256, 'Final receipt hash mismatch');
  const receipt = await readJson(receiptFile), { receiptFile: ignoredFile, receiptSha256: ignoredHash, ...returned } = result;
  assert.deepEqual(receipt, returned, 'Server receipt and independent disk read differ'); validateCounters(receipt, metadata);
  const observerFile = await ownedFile(directory, receipt.observerFile), recordFile = await ownedFile(directory, receipt.recordFile);
  assert.equal(path.basename(observerFile), `app-${metadata.pid}.observer.json`);
  assert.equal(path.basename(recordFile), `app-${metadata.pid}.ndjson`);
  assert.equal(await sha256(observerFile), receipt.observerSha256, 'Observer hash mismatch');
  assert.equal(await sha256(recordFile), receipt.recordFileSha256, 'Counter NDJSON hash mismatch');
  const observer = await readJson(observerFile);
  for (const key of Object.keys(receipt.observer)) assert.deepEqual(observer[key], receipt.observer[key]);
  assert.deepEqual(observer.counters, receipt.counters);
  const size = (await lstat(recordFile)).size; assert.ok(size <= 256 * 1024 * 1024, 'Counter log exceeds bounded read');
  assert.equal(size, observer.bytesWritten);
  let lines = 0, finalLine, finalized, lastSample; const markers = [], acknowledged = [], identities = new Set(), loaded = new Map();
  const input = createReadStream(recordFile), reader = readline.createInterface({ input, crlfDelay: Infinity });
  try { for await (const line of reader) {
    assert.ok(line && Buffer.byteLength(line) <= 1024 * 1024, 'Malformed/oversized counter record');
    const row = JSON.parse(line); lines++;
    assert.ok(integer(row.atMs)); assert.notEqual(row.kind, 'diagnostic-fatal');
    assert.notEqual(row.kind, 'diagnostic-observer-fatal');
    if (row.kind === 'postcommit-marker') {
      assert.ok(typeof row.runId === 'string' && row.runId && integer(row.index));
      assert.match(row.markerCode, /^[a-z0-9]{2}$/); assert.ok(integer(row.sourceSeq) && row.sourceSeq > 0);
      assert.match(row.identitySha256, /^[a-f0-9]{64}$/); assert.equal(identities.has(row.identitySha256), false, 'Duplicate postcommit identity hash');
      identities.add(row.identitySha256); markers.push(row);
    } else if (row.kind === 'outer-transaction-completion-ack') {
      assert.ok(integer(row.beginId) && row.beginId > 0); assert.equal(typeof row.apiAlreadyRejected, 'boolean'); acknowledged.push(row);
    } else if (row.kind === 'instrumented-module') {
      const { atMs, kind, ...module } = row, previous = loaded.get(module.type);
      if (previous) assert.deepEqual(previous, module, 'Conflicting logged module hook');
      loaded.set(module.type, module);
    }
    else if (row.kind === 'app-sample') lastSample = row;
    else if (row.kind === 'diagnostic-capture-finalized') { assert.equal(finalized, undefined); finalized = row; finalLine = lines; }
  } } finally { reader.close(); input.destroy(); }
  assert.equal(lines, observer.recordsWritten); assert.ok(finalized && lastSample);
  assert.equal(finalLine, lines, 'Finalized record must be the capture boundary');
  const byType = rows => [...rows].sort((left, right) => left.type.localeCompare(right.type));
  assert.deepEqual(byType(loaded.values()), byType(receipt.modules), 'Counter log must prove every receipt hook');
  assert.deepEqual(finalized.counters, receipt.counters); assert.deepEqual(lastSample.counters, receipt.counters);
  assert.equal(finalized.v8CpuSampling, false); assert.equal(lastSample.fatalDiagnosticErrors, 0);
  assert.equal(lastSample.localAppend.pending, 0); assert.ok(lastSample.localAppend.calls > 0);
  assert.ok(Object.values(lastSample.portAppends).some(row => row.calls > 0 && row.events > 0));
  for (const row of Object.values(lastSample.portAppends)) assert.equal(row.pending, 0);
  assert.equal(markers.length, receipt.counters.postCommitMarkers);
  assert.equal(acknowledged.filter(row => row.completion === 'commit').length, receipt.counters.outerCommitAcknowledged);
  assert.equal(acknowledged.filter(row => row.completion === 'prepare').length, receipt.counters.outerPrepareAcknowledged);
  assert.ok(acknowledged.every(row => ['commit', 'prepare'].includes(row.completion)));
  assert.equal(new Set(acknowledged.map(row => row.beginId)).size, acknowledged.length, 'Duplicate outer completion ACK');
  return { receipt, receiptFile, receiptSha256: result.receiptSha256, observerFile, observerSha256: receipt.observerSha256,
    recordFile, recordFileSha256: receipt.recordFileSha256, markers, recordCount: lines };
}
export async function finalizeCounterCapture() {
  const directory = await ownedDirectory(process.env.PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_DIR), names = await readdir(directory);
  const matches = names.filter(name => /^app-\d+\.metadata\.json$/.test(name)); assert.equal(matches.length, 1);
  const metadataFile = await ownedFile(directory, path.join(directory, matches[0])), metadata = await readJson(metadataFile);
  assert.ok(integer(metadata.pid) && metadata.pid > 0); assert.equal(matches[0], `app-${metadata.pid}.metadata.json`);
  assert.equal(metadata.role, 'app'); assert.equal(metadata.diagnosticOnly, true); assert.equal(metadata.performanceAcceptanceEligible, false);
  assert.equal(metadata.variant, process.env.PAPERCLIP_RESOURCE_VARIANT); assert.ok(pins.variants[metadata.variant]);
  assert.equal(metadata.sourceRevision, pins.variants[metadata.variant].revision); assert.equal(metadata.node, pins.runtime.node);
  assert.equal(metadata.appRoot, await realpath(process.env.PAPERCLIP_INGESTION_APP_ROOT));
  assert.equal(metadata.pinsSha256, await sha256(pinsFile));
  assert.equal(metadata.definitionsSha256, await sha256(new URL('./DEFINITIONS.md', import.meta.url)));
  assert.equal(metadata.v8CpuSampling, false);
  assert.deepEqual(names.filter(name => /^app-\d+\.inspector\.json$/.test(name)), [`app-${metadata.pid}.inspector.json`]);
  const inspectorFile = await ownedFile(directory, path.join(directory, `app-${metadata.pid}.inspector.json`));
  const inspector = await readJson(inspectorFile), url = validateInspector(inspector, metadata.pid);
  const requestedAtMs = Date.now(), result = await evaluateCapture(url, metadata.pid);
  const verified = await verifyFinalizedFiles(directory, metadata, result);
  assert.ok(result.finalizedAtMs >= requestedAtMs);
  const acknowledgement = { diagnosticOnly: true, performanceAcceptanceEligible: false,
    scope: 'COMBINED-H5E-RESOURCE', pid: metadata.pid, finalizedBeforePlaywrightWebServerTeardown: true,
    requestedAtMs, finalizedAtMs: result.finalizedAtMs, acknowledgedAtMs: Date.now(), v8CpuSampling: false,
    metadataFile, inspectorFile, receiptFile: verified.receiptFile, receiptSha256: verified.receiptSha256,
    observerFile: verified.observerFile, observerSha256: verified.observerSha256,
    recordFile: verified.recordFile, recordFileSha256: verified.recordFileSha256,
    observer: result.observer, counters: result.counters,
    boundary: 'Independent finite CDP finalization and hash reread before normal Playwright teardown; not a workload/exit/SIGTERM or performance acceptance ACK' };
  const acknowledgementFile = path.join(path.dirname(directory), 'COUNTER-ONLY-before-teardown-ack.json');
  await writeFile(acknowledgementFile, JSON.stringify(acknowledgement, null, 2) + '\n', { flag: 'wx' });
  return { ...acknowledgement, acknowledgementFile };
}
