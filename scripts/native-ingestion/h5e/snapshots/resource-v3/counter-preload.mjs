import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import inspector from 'node:inspector';
import { createCounters } from './counters.mjs';
import { hash, pins, pinsFile, symbolName, transform } from './transforms.mjs';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.PAPERCLIP_RESOURCE_COUNTER_RELEASE, 'combined-h5e-resource-v2', 'Separate reviewed resource release required');
assert.equal(process.version, pins.runtime.node);
assert.equal(process.env.PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_FS ?? '0', '0');
assert.equal(process.env.PAPERCLIP_RESOURCE_CPU_PROFILE ?? '0', '0', 'No V8 CPU sampling in counter-only runs');
const variant = process.env.PAPERCLIP_RESOURCE_VARIANT;
assert.ok(pins.variants[variant]);
const appRoot = realpathSync(process.env.PAPERCLIP_INGESTION_APP_ROOT);
assert.equal(JSON.parse(readFileSync(path.join(appRoot, 'server/dist/build-info.json'), 'utf8')).commit, pins.variants[variant].revision);
assert.ok(process.argv.some(value => value === '--compiled-entry=server/dist/index.js' || /\/server\/dist\/index\.js$/.test(value)));
const directory = process.env.PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_DIR;
assert.ok(path.isAbsolute(directory ?? ''));
mkdirSync(directory, { recursive: true });
const canonical = realpathSync(directory), temporary = realpathSync('/tmp');
assert.ok(canonical.startsWith(temporary + path.sep));
assert.equal(path.basename(canonical), 'profile');
assert.equal(statSync(canonical).uid, process.getuid());
assert.equal(statSync(path.dirname(canonical)).uid, process.getuid());
const stem = path.join(canonical, `app-${process.pid}`), file = `${stem}.ndjson`;
const queue = [], modules = new Map(), queues = new Set(), fatalErrors = [];
const stats = { maximumPendingRecords: 262144, maximumPendingBytes: 64 * 1024 * 1024,
  recordsWritten: 0, bytesWritten: 0, flushCalls: 0, flushMillis: 0, recordEncodingMillis: 0,
  pendingRecordsPeak: 0, pendingBytesPeak: 0, errors: 0 };
let pendingBytes = 0, failed = false, finalized = false;
function fatal(message) {
  failed = true; stats.errors++;
  try { writeFileSync(`${stem}.observer-fatal.json`, JSON.stringify({ diagnosticOnly: true,
    atMs: Date.now(), message, pendingRecords: queue.length, pendingBytes, observer: stats })); } catch {}
  process.exit(86);
}
function record(value) {
  if (failed || finalized) return;
  const started = performance.now(); let line;
  try { line = JSON.stringify({ atMs: Date.now(), ...value }) + '\n'; }
  catch { fatal('Counter record encoding failed'); }
  const bytes = Buffer.byteLength(line); stats.recordEncodingMillis += performance.now() - started;
  if (queue.length >= stats.maximumPendingRecords || pendingBytes + bytes > stats.maximumPendingBytes) fatal('Counter append buffer overflow');
  queue.push(line); pendingBytes += bytes;
  stats.pendingRecordsPeak = Math.max(stats.pendingRecordsPeak, queue.length);
  stats.pendingBytesPeak = Math.max(stats.pendingBytesPeak, pendingBytes);
}
function flush() {
  if (failed || !queue.length) return;
  const started = performance.now(); stats.flushCalls++;
  try {
    appendFileSync(file, queue.join('')); stats.recordsWritten += queue.length; stats.bytesWritten += pendingBytes;
    queue.length = 0; pendingBytes = 0;
  } catch { fatal('Counter append failed'); }
  finally { stats.flushMillis += performance.now() - started; }
}
const counters = createCounters(record), portAppends = {};
const localAppend = { calls: 0, successes: 0, errors: 0, pending: 0, millis: 0, bytesAttempted: 0 };
let queuePeakSinceSample = 0, queueHighWater = 0;
function queueDepth() {
  let depth = 0, active = 0;
  for (const ref of queues) {
    const value = ref.deref(); if (!value) { queues.delete(ref); continue; }
    depth += value.__resourceCounterDepth(); active++;
  }
  return { depth, active };
}
const api = { ...counters,
  registerQueue(value) { if (!finalized) queues.add(new WeakRef(value)); },
  observeQueue() {
    if (finalized) return;
    const { depth } = queueDepth(); queuePeakSinceSample = Math.max(queuePeakSinceSample, depth); queueHighWater = Math.max(queueHighWater, depth);
  },
  postCommit(event, disposition) {
    if (finalized) return;
    try { counters.postCommit(event, disposition); }
    catch { fatalErrors.push('Postcommit identity/counter invariant failed'); record({ kind: 'diagnostic-fatal', category: 'postcommit-invariant' }); }
  },
  async portAppend(method, size, work) {
    if (finalized) return work();
    const row = portAppends[method] ??= { calls: 0, events: 0, successes: 0, errors: 0,
      pending: 0, pendingPeak: 0, millis: 0, inputSizeHistogram: {} };
    row.calls++; row.events += size; row.pending++; row.pendingPeak = Math.max(row.pendingPeak, row.pending);
    row.inputSizeHistogram[size] = (row.inputSizeHistogram[size] ?? 0) + 1;
    const started = performance.now();
    try { const result = await work(); row.successes++; return result; }
    catch (error) { row.errors++; throw error; }
    finally { row.pending--; row.millis += performance.now() - started; }
  },
  async localAppend(work, bytes) {
    if (finalized) return work();
    localAppend.calls++; localAppend.pending++; localAppend.bytesAttempted += bytes;
    const started = performance.now();
    try { const result = await work(); localAppend.successes++; return result; }
    catch (error) { localAppend.errors++; throw error; }
    finally { localAppend.pending--; localAppend.millis += performance.now() - started; }
  },
};
// After the explicit final boundary, outstanding application work is outside the
// capture. Hooks keep product behavior but never mutate frozen final counters.
for (const method of Object.keys(counters).filter(name => name !== 'snapshot' && name !== 'postCommit')) {
  api[method] = (...args) => finalized ? undefined : counters[method](...args);
}
globalThis[Symbol.for(symbolName)] = api;
const metadata = { diagnosticOnly: true, performanceAcceptanceEligible: false, role: 'app',
  pid: process.pid, parentPid: process.ppid, startedAtMs: Date.now(), configPath: process.env.PAPERCLIP_CONFIG,
  appRoot, variant, sourceRevision: pins.variants[variant].revision, node: process.version,
  v8CpuSampling: false, samplingIntervalMs: 1000, eventLoopHistogramResolutionMs: 20,
  pinsSha256: hash(readFileSync(pinsFile)),
  definitionsSha256: hash(readFileSync(new URL('./DEFINITIONS.md', import.meta.url))),
  disclosure: 'Counter-only server Node diagnostic; observer overhead excluded from all acceptance arms' };
writeFileSync(`${stem}.metadata.json`, JSON.stringify(metadata, null, 2));
const pgSuffixes = { '/postgres/src/index.js': 'postgresIndex', '/postgres/src/connection.js': 'postgresConnection' };
registerHooks({ load(url, context, nextLoad) {
  if (!url.startsWith('file:')) return nextLoad(url, context);
  const pathname = fileURLToPath(url);
  let type = Object.entries(pins.variants[variant].modules).find(([, row]) => pathname === path.join(appRoot, row.path))?.[0];
  if (!type) type = Object.entries(pgSuffixes).find(([suffix]) => pathname.endsWith(suffix))?.[1];
  if (!type) return nextLoad(url, context);
  assert.ok(realpathSync(pathname).startsWith(appRoot + path.sep), 'Counter dependency must be owned by the application tree');
  if (type.startsWith('postgres')) {
    const manifestFile = path.resolve(path.dirname(pathname), '../package.json');
    assert.equal(hash(readFileSync(manifestFile)), pins.postgres.files['package.json']);
    assert.equal(JSON.parse(readFileSync(manifestFile, 'utf8')).version, pins.postgres.version);
  }
  const original = readFileSync(pathname, 'utf8'), source = transform(type, original, variant);
  const qualified = { type, file: pathname, sha256: hash(original), transformed: source !== original,
    qualification: type === 'resolver' ? 'Original compiled file; existing frozen fixture loader chain preserved' : 'Exact original bytes and transformed anchors' };
  const previous = modules.get(type); assert.ok(!previous || previous.file === pathname, 'Multiple sources for one required hook');
  modules.set(type, qualified); record({ kind: 'instrumented-module', ...qualified });
  return type === 'resolver' ? nextLoad(url, context) : { format: 'module', shortCircuit: true, source };
} });
const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
let previousCpu = process.cpuUsage(), previousTime = performance.now(), previousElu = performance.eventLoopUtilization();
function sample() {
  if (finalized || failed) return;
  const now = performance.now(), cpu = process.cpuUsage(), elu = performance.eventLoopUtilization();
  const memory = process.memoryUsage(), actualQueue = queueDepth();
  record({ kind: 'app-sample', intervalMs: now - previousTime,
    cpuMicros: cpu.user + cpu.system - previousCpu.user - previousCpu.system,
    rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external,
    eventLoopUtilization: performance.eventLoopUtilization(elu, previousElu).utilization,
    eventLoopDelayCount: delay.count, eventLoopDelayMaxMs: delay.count ? delay.max / 1e6 : null,
    eventLoopDelayP95Ms: delay.count ? delay.percentile(95) / 1e6 : null,
    actualNormalizedQueueDepth: actualQueue.depth, liveQueueObjects: actualQueue.active,
    queuePeakSinceSample, queueHighWater, counters: counters.snapshot(),
    portAppends: structuredClone(portAppends), localAppend: { ...localAppend },
    fatalDiagnosticErrors: fatalErrors.length, observer: { ...stats } });
  previousCpu = cpu; previousTime = now; previousElu = elu; queuePeakSinceSample = 0; delay.reset();
}
setInterval(() => { sample(); flush(); }, 1000).unref();
process.once('exit', () => { if (!failed && !finalized) { sample(); flush(); } });
// No CPU Profiler is enabled/started. Inspector exists only for an explicit
// independently acknowledged finalization before normal server teardown.
inspector.open(0, '127.0.0.1');
writeFileSync(`${stem}.inspector.json`, JSON.stringify({ diagnosticOnly: true, pid: process.pid, url: inspector.url(), v8CpuSampling: false }));
let capture;
api.finalizeCapture = () => capture ??= Promise.resolve().then(() => {
  assert.equal(failed, false); assert.equal(fatalErrors.length, 0);
  assert.deepEqual([...modules.keys()].sort(), ['port', 'postgresConnection', 'postgresIndex', 'queue', 'resolver', 'runlog'].sort());
  const counts = counters.snapshot();
  for (const key of ['normalizedEvents', 'postCommitEvents', 'postCommitMarkers', 'queryBuildAttempts', 'beginAcknowledged', 'outerCommitAcknowledged']) assert.ok(counts[key] > 0, `Missing exercised counter ${key}`);
  assert.equal(counts.scopesPending, 0, 'Capture has unfinished explicit SQL scopes');
  assert.equal(localAppend.pending, 0);
  for (const row of Object.values(portAppends)) assert.equal(row.pending, 0);
  sample(); record({ kind: 'diagnostic-capture-finalized', v8CpuSampling: false, counters: counts }); flush();
  assert.equal(queue.length, 0); assert.equal(pendingBytes, 0);
  finalized = true; delay.disable(); const finalizedAtMs = Date.now();
  const observerFile = `${stem}.observer.json`;
  writeFileSync(observerFile, JSON.stringify({ diagnosticOnly: true, ...stats,
    pendingRecords: queue.length, pendingBytes, counters: counts }));
  const receiptFile = `${stem}.final-capture.json`;
  const receipt = { diagnosticOnly: true, performanceAcceptanceEligible: false, pid: process.pid,
    finalizedAtMs, capturedBeforePlaywrightTeardown: true, v8CpuSampling: false,
    observerFile, observerSha256: hash(readFileSync(observerFile)),
    recordFile: file, recordFileSha256: hash(readFileSync(file)), counters: counts,
    modules: [...modules.values()], observer: { ...stats, pendingRecords: queue.length, pendingBytes },
    disclosure: 'Complete counter flush through this boundary only; neither a successful workload nor later commit guarantee' };
  writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
  return { ...receipt, receiptFile, receiptSha256: hash(readFileSync(receiptFile)) };
});
record({ kind: 'diagnostic-disclosure', v8CpuSampling: false,
  sql: 'Postgres-js query-build attempts only; no SQL text/parameters',
  commits: 'Successful awaited outer COMMIT ACK; prepared/nested/rollback/failure separate',
  scope: 'Server Node only; frozen H5e provider assembly and recovery unchanged; separate PG service diagnostic' });
