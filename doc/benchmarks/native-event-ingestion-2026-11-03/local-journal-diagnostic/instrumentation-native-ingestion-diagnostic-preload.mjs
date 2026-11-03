import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import inspector from 'node:inspector';

const directory = process.env.PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_DIR;
assert.equal(process.env.NODE_ENV, 'test', 'Diagnostic instrumentation is test-only');
assert.ok(directory?.startsWith('/private/tmp/') || directory?.startsWith('/tmp/'), 'Use an owned private temporary diagnostic directory');
mkdirSync(directory, { recursive: true });
const role = process.argv.includes('--ingestion-stream-fixture') ? 'provider'
  : process.argv.some(value => /\/server\/dist\/index\.js$/.test(value)) ? 'app' : 'other';
const file = path.join(directory, `${role}-${process.pid}.ndjson`);
const metadata = { diagnosticOnly: true, role, pid: process.pid, parentPid: process.ppid, startedAtMs: Date.now(),
  cwd: process.cwd(), configPath: role === 'app' ? process.env.PAPERCLIP_CONFIG : undefined,
  disclosure: 'Profile-only instrumentation; never use these timings for unprofiled acceptance' };
writeFileSync(path.join(directory, `${role}-${process.pid}.metadata.json`), JSON.stringify(metadata, null, 2));
const queue = [];
const record = value => queue.push({ atMs: Date.now(), ...value });
function flush() { if (queue.length) appendFileSync(file, queue.splice(0).map(value => JSON.stringify(value)).join('\n') + '\n'); }
const markerPattern = /INGEST_([a-z0-9]+)_(\d+)_(\d+)_(\d+)/g;
const markers = text => {
  if (typeof text !== 'string') return [];
  const compact = [...text.matchAll(/\[([a-z0-9]{2})([a-z0-9]{1,3})\]/g)].map(match => ({ markerCode: match[1], index: Number.parseInt(match[2], 36) }));
  if (compact.length) return compact;
  return [...text.matchAll(markerPattern)].map(match => ({ nonce: match[1], index: Number(match[2]), intendedMs: Number(match[3]), emittedMs: Number(match[4]) }));
};
process.once('exit', flush);
setInterval(flush, 250).unref();

if (role === 'provider') {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const finish = () => {
      flush();
      process.removeListener(signal, finish);
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    process.once(signal, finish);
  }
  const original = process.stdout.write;
  let pending = '';
  process.stdout.write = function (chunk, ...args) {
    const result = original.call(this, chunk, ...args);
    pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    for (;;) {
      const end = pending.indexOf('\n'); if (end < 0) break;
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.method === 'item/agentMessage/delta') {
        for (const marker of markers(message.params?.delta)) record({ kind: 'provider-emission', ...marker });
      } else if (message.method === 'turn/completed') {
        record({ kind: 'provider-terminal' });
        flush(); // Provider teardown can precede the periodic diagnostic flush.
      }
    }
    return result;
  };
} else if (role === 'app') {
  // The production provider environment sanitizer intentionally strips loader
  // options. A separate test-only command wrapper explicitly starts the
  // diagnostic observer; production environment policy stays untouched.
  const providerCommand = process.env.PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_CODEX_COMMAND;
  assert.ok(providerCommand?.startsWith(directory + '/'), 'An owned profile-only provider wrapper is required');
  const key = Symbol.for('paperclip.native-ingestion.diagnostic');
  const queues = new Set();
  const committed = new Set();
  const fatalErrors = [];
  const filesystem = {};
  const fsObservation = process.env.PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_FS === '1';
  const counters = { normalizedEvents: 0, committedEvents: 0, duplicateReceipts: 0, committedMarkers: 0,
    sqlCalls: 0, begins: 0, commits: 0, rollbacks: 0, savepoints: 0, releases: 0, queueHighWater: 0 };
  const sqlVerbs = {};
  let queuePeakSinceSample = 0;
  function queueDepth() {
    let depth = 0, active = 0;
    for (const reference of queues) {
      const value = reference.deref();
      if (!value) { queues.delete(reference); continue; }
      depth += value.__nativeIngestionDiagnosticDepth(); active++;
    }
    return { depth, active };
  }
  globalThis[key] = {
    serialize(candidate) {
      const row = filesystem.fullSnapshotSerialization ??= { calls: 0, successes: 0, errors: 0, millis: 0, bytesAttempted: 0 };
      row.calls++; const started = performance.now(); let value;
      try { value = JSON.stringify(candidate); row.successes++; }
      catch (error) { row.errors++; throw error; }
      finally { row.millis += performance.now() - started; }
      row.bytesAttempted += typeof value === 'string' ? Buffer.byteLength(value) : 0;
      return value;
    },
    syncWork(name, work, bytes = 0) {
      const row = filesystem[name] ??= { calls: 0, successes: 0, errors: 0, millis: 0, bytesAttempted: 0 };
      row.calls++; row.bytesAttempted += bytes; const began = performance.now();
      try { const value = work(); row.successes++; return value; } catch (error) { row.errors++; throw error; }
      finally { row.millis += performance.now() - began; }
    },
    async asyncWork(name, work, bytes = 0) {
      const row = filesystem[name] ??= { calls: 0, successes: 0, errors: 0, millis: 0, bytesAttempted: 0 };
      row.calls++; row.bytesAttempted += bytes; const began = performance.now();
      try { const value = await work(); row.successes++; return value; } catch (error) { row.errors++; throw error; }
      finally { row.millis += performance.now() - began; }
    },
    registerQueue(value) { queues.add(new WeakRef(value)); },
    observeQueue() {
      const { depth } = queueDepth();
      queuePeakSinceSample = Math.max(queuePeakSinceSample, depth);
      counters.queueHighWater = Math.max(counters.queueHighWater, depth);
    },
    normalized(event) { counters.normalizedEvents++; },
    postCommit(event, disposition) { try {
      if (disposition === 'duplicate') { counters.duplicateReceipts++; return; }
      assert.equal(disposition, 'committed');
      const identity = `${event.runId}:${event.sourceInstanceId}:${event.sourceEventId}`;
      assert.equal(committed.has(identity), false, 'A committed source identity was observed twice');
      committed.add(identity); counters.committedEvents++;
      if (event.eventType !== 'item.delta') return;
      for (const marker of markers(event.payload?.text)) {
        counters.committedMarkers++; record({ kind: 'postcommit-marker', runId: event.runId, sourceSeq: event.sourceSeq,
          identitySha256: createHash('sha256').update(identity).digest('hex'), ...marker });
      }
    } catch (error) {
      // The existing persistence observer has a deliberately non-consequential
      // catch. Persist an explicit fatal flag instead of trusting propagation.
      const message = String(error.message ?? error);
      fatalErrors.push(message); record({ kind: 'diagnostic-fatal', message });
    }
    },
    sql(statement) {
      counters.sqlCalls++;
      const verb = statement.trim().match(/^[a-z]+/i)?.[0].toLowerCase() ?? 'other';
      sqlVerbs[verb] = (sqlVerbs[verb] ?? 0) + 1;
      if (verb === 'begin') counters.begins++;
      else if (verb === 'commit') counters.commits++;
      else if (verb === 'rollback') counters.rollbacks++;
      else if (verb === 'savepoint') counters.savepoints++;
      else if (verb === 'release') counters.releases++;
    },
  };
  const call = `globalThis[Symbol.for('paperclip.native-ingestion.diagnostic')]`;
  const allowed = {
    queue: new Set(['f8cb9fd06a567831cff886251c79eb73810a83d1384fb2b61851587a30832869']),
    port: new Set(['49a971a961d831dc4dbea39c715abb371609464797bbfcc58ac911792d8b945c', 'd3cf1203feb7f0b74c6799a289799990b932a837475e857732c7340876fd4f66']),
    postgres: new Set(['b57261592f135d127b8e7267c78981eb2c5f4751259641b782ba621b89d939d1']),
    resolver: new Set(['92031b6800bfb2356812d6fdc28af89143e1ffea37d2060879515d04667c5f3c']),
    core: new Set(['15bffae6e51d1e07f3635d37ce3fa2e8af18783b93331b477deeb82908aab212']),
    staged: new Set(['cd3a3f09c0890e26d57ca18def4890874f985f7a8c571ad4b92d4ed2578c0554']),
  };
  function replaceExactly(source, anchor, replacement) {
    assert.equal(source.split(anchor).length - 1, 1, `Diagnostic anchor must occur exactly once: ${anchor}`);
    return source.replace(anchor, replacement);
  }
  registerHooks({ load(url, context, nextLoad) {
    let type;
    if (/\/server\/dist\/vendor\/paperclip-runner\/drivers\/codex\/codex-session-state\.js$/.test(url)) type = 'queue';
    else if (/\/server\/dist\/services\/native-runtime\/paperclip-control-plane-port\.js$/.test(url)) type = 'port';
    else if (/\/postgres\/src\/connection\.js$/.test(url)) type = 'postgres';
    else if (/\/server\/dist\/vendor\/paperclip-runner\/drivers\/codex\/codex-command\.js$/.test(url)) type = 'resolver';
    else if (fsObservation && /\/server\/dist\/vendor\/paperclip-runner\/control-plane\/durable-prp-control-plane\.js$/.test(url)) type = 'core';
    else if (fsObservation && /\/server\/dist\/vendor\/paperclip-runner\/control-plane\/staged-private-write\.js$/.test(url)) type = 'staged';
    if (!type) return nextLoad(url, context);
    const original = readFileSync(fileURLToPath(url), 'utf8');
    const sha256 = createHash('sha256').update(original).digest('hex');
    assert.ok(allowed[type].has(sha256), `Unknown compiled ${type} artifact: ${sha256}`);
    let source = original;
    if (type === 'queue') {
      source = replaceExactly(source, 'class AsyncQueue {', `class AsyncQueue {\nconstructor() { ${call}.registerQueue(this); }\n__nativeIngestionDiagnosticDepth() { return this.#values.length; }`);
      source = replaceExactly(source, 'const waiter = this.#waiters.shift();', `${call}.normalized(value);\nconst waiter = this.#waiters.shift();`);
      source = replaceExactly(source, 'this.#values.push(value);', `{ this.#values.push(value); ${call}.observeQueue(); }`);
    } else if (type === 'port') {
      source = replaceExactly(source, 'await this.#onEventPersistence?.(', `${call}.postCommit(event, persisted.disposition);\nawait this.#onEventPersistence?.(`);
    } else if (type === 'postgres') {
      source = replaceExactly(source, "typeof options.debug === 'function' && options.debug(id, string, parameters, types)", `${call}.sql(string)\n    typeof options.debug === 'function' && options.debug(id, string, parameters, types)`);
    } else if (type === 'core') {
      assert.equal(source.split('JSON.stringify(candidate)').length - 1, 3, 'All three full-candidate serialization sites must match');
      source = source.replaceAll('JSON.stringify(candidate)', `${call}.serialize(candidate)`);
      source = replaceExactly(source, '        fsyncSync(descriptor);\n    }\n    finally {', `        ${call}.syncWork('directoryFsync', () => fsyncSync(descriptor));\n    }\n    finally {`);
      source = replaceExactly(source, '        fsyncSync(descriptor);', `        ${call}.syncWork('atomicFileFsync', () => fsyncSync(descriptor));`);
      source = replaceExactly(source, '        writeFileSync(descriptor, contents, "utf8");', `        ${call}.syncWork('atomicWrite', () => writeFileSync(descriptor, contents, "utf8"), Buffer.byteLength(contents));`);
    } else if (type === 'staged') {
      source = replaceExactly(source, '            await file.writeFile(contents, "utf8");', `            await ${call}.asyncWork('stagedWrite', () => file.writeFile(contents, "utf8"), Buffer.byteLength(contents));`);
      source = replaceExactly(source, '            await file.sync();', `            await ${call}.asyncWork('stagedFileFsync', () => file.sync());`);
    } else {
      source = `export const resolveCodexCommand = () => ${JSON.stringify(providerCommand)}; export const resolvePinnedCodexCommand = resolveCodexCommand;`;
    }
    record({ kind: 'instrumented-module', type, sha256, file: fileURLToPath(url) });
    return { format: 'module', shortCircuit: true, source };
  } });
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
  let previousCpu = process.cpuUsage(), previousTime = performance.now(), previousElu = performance.eventLoopUtilization();
  const sample = () => {
    const now = performance.now(), currentCpu = process.cpuUsage(), currentElu = performance.eventLoopUtilization();
    const memory = process.memoryUsage(), actualQueue = queueDepth();
    record({ kind: 'app-sample', intervalMs: now - previousTime, cpuMicros: currentCpu.user + currentCpu.system - previousCpu.user - previousCpu.system,
      rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external,
      eventLoopUtilization: performance.eventLoopUtilization(currentElu, previousElu).utilization,
      eventLoopDelayCount: delay.count, eventLoopDelayMaxMs: delay.count ? delay.max / 1e6 : null,
      eventLoopDelayP95Ms: delay.count ? delay.percentile(95) / 1e6 : null,
      actualNormalizedQueueDepth: actualQueue.depth, liveQueueObjects: actualQueue.active, queuePeakSinceSample,
      counters: { ...counters }, filesystem: structuredClone(filesystem), sqlVerbs: { ...sqlVerbs }, fatalDiagnosticErrors: fatalErrors.length });
    queuePeakSinceSample = 0; previousCpu = currentCpu; previousTime = now; previousElu = currentElu; delay.reset();
  };
  setInterval(sample, 250).unref();
  process.once('exit', () => { sample(); flush(); });
  if (process.env.PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_INSPECTOR === '1') {
    inspector.open(0, '127.0.0.1');
    writeFileSync(path.join(directory, `app-${process.pid}.inspector.json`), JSON.stringify({ diagnosticOnly: true, pid: process.pid, url: inspector.url() }));
  }
  record({ kind: 'diagnostic-disclosure', queue: 'Actual private normalized AsyncQueue buffered values; excludes runtime collector, iterator pending read, in-flight append and transport queue',
    sql: 'All PostgreSQL protocol query-build attempts, transaction and savepoint commands included; parameters and SQL text are never logged',
    commit: 'Existing port persistence-observation callsite after outer database transaction resolves; callback timestamp is an upper bound on commit time',
    overhead: 'Queue observation scans weak references after every buffered push; diagnostic overhead is intentionally excluded from acceptance measurements' });
}
