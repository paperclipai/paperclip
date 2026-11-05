import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir, open } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = arg('root') ?? process.cwd();
const harnessRoot = arg('harness-root') ?? root;
const trees = { B0: arg('b0-root') ?? '/private/tmp/paperclip-native-event-baseline', B1: root,
  B2: arg('b2-root') ?? '/private/tmp/paperclip-native-event-batching' };
const tree = arg('tree'), smoke = process.argv.includes('--smoke');
const out = arg('output');
if (!process.argv.includes('--execute')) {
  console.log('PROFILE ONLY; no load launched. After quiet-window release: node scripts/native-ingestion/diagnostic-run.mjs --execute --tree=B0|B1|B2 --output=/tmp/<new-directory> [--smoke]');
  process.exit(0);
}
assert.ok(trees[tree], 'Choose B0, B1 or B2'); assert.ok(out?.startsWith('/private/tmp/') || out?.startsWith('/tmp/'));
await mkdir(out, { recursive: false });
const profiles = path.join(out, 'profile'); await mkdir(profiles);
const cpuProfileDirectory = path.join(profiles, 'cpu');
if (!smoke) await mkdir(cpuProfileDirectory);
const getJson = async file => JSON.parse(await readFile(file, 'utf8'));
const saveJson = async (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const readNdjson = async file => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(value => JSON.parse(value));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const portServer = net.createServer();
await new Promise((resolve, reject) => { portServer.once('error', reject); portServer.listen(0, '127.0.0.1', resolve); });
const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
const bootstrap = path.join(harnessRoot, 'tests/e2e/fixtures/native-ingestion-bootstrap.mjs');
const preload = path.join(import.meta.dirname, 'diagnostic-preload.mjs');
const providerCommand = path.join(profiles, 'codex-profile-only');
await writeFile(providerCommand, `#!/bin/sh\nexec env NODE_ENV=test PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_DIR=${quote(profiles)} ${quote(process.execPath)} --import ${quote(preload)} ${quote(path.join(harnessRoot, 'tests/e2e/fixtures/in-feed-codex.mjs'))} --ingestion-stream-fixture "$@"\n`, { mode: 0o755 });
const cpuProfileFlags = smoke ? '' : ` --cpu-prof --cpu-prof-dir=${quote(cpuProfileDirectory)}`;
const command = `node --import ./server/node_modules/tsx/dist/loader.mjs ${quote(bootstrap)} && node${cpuProfileFlags} --import ${quote(preload)} --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js`;
const env = { PAPERCLIP_E2E_PORT: String(port), PAPERCLIP_INGESTION_SMOKE: smoke ? '1' : '0',
  PAPERCLIP_INGESTION_VARIANT: `PROFILE-ONLY-${tree}`, PAPERCLIP_INGESTION_APP_ROOT: trees[tree],
  PAPERCLIP_INGESTION_EVIDENCE_DIR: out, PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_DIR: profiles,
  PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_CODEX_COMMAND: providerCommand,
  PAPERCLIP_INGESTION_DRIVER_DEPENDENCIES: 'Driver-only tooling links to frozen B1 locked dependencies; each app owns independent installs',
  PAPERCLIP_INGESTION_SERVER_COMMAND: command };
const logHandle = await open(path.join(out, 'playwright.log'), 'wx'), log = logHandle.createWriteStream();
const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/e2e/playwright-native-ingestion.config.ts'],
  { cwd: harnessRoot, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
const startedAtMs = Date.now();
await saveJson(path.join(out, 'command.json'), { diagnosticOnly: true, tree, sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: trees[tree], encoding: 'utf8' }).trim(),
  childPid: child.pid, startedAtMs, env, preloadSha256: createHash('sha256').update(await readFile(preload)).digest('hex') });
let metadata, clusterPid;
const processSamples = [];
const cpuMillis = value => value.split(':').map(Number).reduce((total, part) => total * 60 + part, 0) * 1000;
const clockTicks = process.platform === 'linux' ? Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) : null;
const sample = async () => {
  if (!metadata) {
    const names = (await readdir(profiles)).filter(name => /^app-\d+\.metadata\.json$/.test(name));
    if (!names.length) return; assert.equal(names.length, 1); metadata = await getJson(path.join(profiles, names[0]));
  }
  if (!clusterPid) {
    try {
      const config = await getJson(metadata.configPath), directory = config.database.embeddedPostgresDataDir;
      assert.ok(directory.includes('/paperclip-e2e-home-'), 'Sampler may only inspect this disposable fixture database');
      clusterPid = Number((await readFile(path.join(directory, 'postmaster.pid'), 'utf8')).split('\n')[0]);
      assert.ok(Number.isSafeInteger(clusterPid) && clusterPid > 1);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,time=,rss=,comm='], { encoding: 'utf8' });
  const processes = output.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d:.]+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), cpuMillis: cpuMillis(match[3]), rssBytes: Number(match[4]) * 1024, executable: path.basename(match[5]) }] : [];
  });
  const ownedPg = new Set(clusterPid ? [clusterPid] : []);
  for (let pass = 0; pass < 4; pass++) for (const proc of processes) if (ownedPg.has(proc.parentPid) && /^postgres/.test(proc.executable)) ownedPg.add(proc.pid);
  const pg = processes.filter(proc => ownedPg.has(proc.pid) && /^postgres/.test(proc.executable));
  if (clockTicks) for (const proc of pg) {
    try {
      const stat = await readFile(`/proc/${proc.pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      proc.cpuMillis = (Number(fields[11]) + Number(fields[12])) / clockTicks * 1000;
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
  }
  const app = processes.find(proc => proc.pid === metadata.pid);
  processSamples.push({ atMs: Date.now(), app, postgres: pg });
};
let sampling = false, samplingError;
const timer = setInterval(() => {
  if (sampling) return; sampling = true;
  sample().catch(error => { samplingError = String(error.stack ?? error); child.kill('SIGTERM'); }).finally(() => { sampling = false; });
}, 1000);
const terminate = signal => child.kill(signal);
const sigint = () => terminate('SIGINT'), sigterm = () => terminate('SIGTERM');
process.once('SIGINT', sigint); process.once('SIGTERM', sigterm);
const watchdog = setTimeout(() => { samplingError = '20-minute diagnostic resource watchdog expired'; child.kill('SIGTERM'); }, 20 * 60_000);
const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
clearInterval(timer); clearTimeout(watchdog); process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
while (sampling) await new Promise(resolve => setTimeout(resolve, 20));
await new Promise(resolve => log.end(resolve));
await saveJson(path.join(out, 'process-samples.json'), { diagnosticOnly: true, intervalMs: 1000, childExit: exit, samplingError, 
  cpuResolutionMillis: clockTicks ? 1000 / clockTicks : 10,
  cpuSource: clockTicks ? 'Owned PostgreSQL /proc/PID/stat utime+stime ticks' : 'ps process CPU time, 10ms on this macOS host',
  boundary: 'Task-owned app PID and embedded cluster PID plus PostgreSQL descendants; PID/PPID/CPU/RSS/comm only, no argv or credentials',
  limitation: '1-second polling can miss short-lived backends and CPU accrued after their final observation; PostgreSQL CPU is sampled process CPU, not exact accounting', samples: processSamples });
assert.equal(samplingError, undefined, 'Diagnostic process sampler failed; preserve process-samples.json');
assert.equal(exit.code, 0, `Diagnostic fixture failed: ${JSON.stringify(exit)}; preserve log`);
const browser = await getJson(path.join(out, 'playwright.json'));
const attachments = [];
function visit(value) {
  if (Array.isArray(value)) for (const child of value) visit(child);
  else if (value && typeof value === 'object') {
    if (value.attachments) attachments.push(...value.attachments.filter(item => item.name === 'native-ingestion-evidence'));
    for (const [key, child] of Object.entries(value)) if (key !== 'attachments') visit(child);
  }
}
visit(browser); assert.equal(attachments.length, 1);
const attachment = attachments[0];
const evidence = attachment.body ? JSON.parse(Buffer.from(attachment.body, 'base64').toString()) : await getJson(attachment.path);
assert.equal(evidence.complete, true);
assert.equal(evidence.diagnosticOnly, true, 'The raw fixture attachment must identify profiling before extraction');
assert.equal(evidence.performanceAcceptanceEligible, false);
await saveJson(path.join(out, 'PROFILE-ONLY-browser-evidence.json'), evidence);
const files = await readdir(profiles);
const rows = (await Promise.all(files.filter(file => file.endsWith('.ndjson')).map(file => readNdjson(path.join(profiles, file))))).flat();
const moduleTypes = new Set(rows.filter(row => row.kind === 'instrumented-module').map(row => row.type));
assert.deepEqual([...moduleTypes].sort(), ['port', 'postgres', 'queue', 'resolver'], 'All diagnostic anchors must actually be exercised');
assert.equal(rows.filter(row => row.kind === 'diagnostic-fatal').length, 0, 'A diagnostic assertion failed inside the non-consequential observer');
const emissions = rows.filter(row => row.kind === 'provider-emission'), commits = rows.filter(row => row.kind === 'postcommit-marker');
const samples = rows.filter(row => row.kind === 'app-sample').sort((a, b) => a.atMs - b.atMs);
const cases = await Promise.all(evidence.cases.map(async item => {
  const codes = new Set(item.durable.map(proof => proof.markerCode));
  const offered = emissions.filter(row => codes.has(row.markerCode)), persisted = commits.filter(row => codes.has(row.markerCode));
  const key = row => `${row.markerCode}:${row.index}`;
  const originalClocks = item.clockEvidence.flatMap(stream => stream.emissions);
  const originalByMarker = new Map(originalClocks.map(row => [key(row), row]));
  assert.equal(originalByMarker.size, originalClocks.length, 'Duplicate original source-clock marker');
  const durableByMarker = new Map(item.durable.flatMap(proof => Array.from({ length: proof.individualDeltas }, (_, index) =>
    [`${proof.markerCode}:${index}`, { runId: proof.runId, nonce: proof.token, markerCode: proof.markerCode, index }])));
  const rawMarkersWithoutOriginalClock = offered.filter(row => !originalByMarker.has(key(row))).map(key);
  if (!item.stop) assert.equal(rawMarkersWithoutOriginalClock.length, 0, 'Every normally emitted marker needs an original clock');
  assert.equal(new Set(offered.map(key)).size, offered.length, 'Duplicate provider emission marker');
  assert.equal(new Set(persisted.map(key)).size, persisted.length, 'Duplicate committed marker');
  const offeredKeys = new Set(offered.map(key)), persistedKeys = new Set(persisted.map(key));
  const markerCoverage = {
    expectedDurableMarkers: durableByMarker.size,
    missingPostcommitObservation: [...durableByMarker.keys()].filter(value => !persistedKeys.has(value)),
    postcommitAbsentFromDurablePrefix: persisted.filter(row => !durableByMarker.has(key(row))).map(key),
    postcommitWithoutProviderObservation: persisted.filter(row => !offeredKeys.has(key(row))).map(key),
    postcommitWithoutOriginalClock: persisted.filter(row => !originalByMarker.has(key(row))).map(key),
    mismatchedRunOrNonce: persisted.filter(row => {
      const durable = durableByMarker.get(key(row)), original = originalByMarker.get(key(row));
      return durable && original && (row.runId !== durable.runId || original.nonce !== durable.nonce);
    }).map(key),
  };
  markerCoverage.complete = Object.entries(markerCoverage).every(([name, value]) => name === 'expectedDurableMarkers' || value.length === 0);
  // Incomplete observation is distinct from a correctly observed, cancelled raw
  // tail. Preserve the mismatch even if teardown killed a diagnostic observer.
  await saveJson(path.join(out, `${item.name}-marker-coverage.json`), markerCoverage);
  assert.equal(markerCoverage.complete, true, 'Incomplete diagnostic observer coverage; do not interpret its backlog as all durable commits');
  if (!item.stop) {
    assert.equal(offered.length, item.runs * item.events); assert.equal(persisted.length, offered.length);
    assert.deepEqual([...new Set(persisted.map(key))].sort(), [...new Set(offered.map(key))].sort());
  }
  assert.ok(offered.length > 0 && persisted.length > 0);
  const begin = Math.min(...originalClocks.map(row => row.intendedMs)), end = begin + item.drainThroughTerminalMs;
  const during = samples.filter(row => row.atMs >= begin && row.atMs <= end);
  assert.ok(during.length > 0, 'No app resource samples in measured diagnostic interval');
  const preceding = [...samples].reverse().find(row => row.atMs < begin), following = samples.find(row => row.atMs > end);
  assert.ok(preceding && following, 'Resource counter boundaries were not captured');
  const deltas = Object.fromEntries(['sqlCalls', 'begins', 'commits', 'rollbacks', 'savepoints', 'releases', 'committedEvents'].map(name => [name, following.counters[name] - preceding.counters[name]]));
  const changes = [...offered.map(row => ({ atMs: row.atMs, delta: 1 })), ...persisted.map(row => ({ atMs: row.atMs, delta: -1 }))].sort((a, b) => a.atMs - b.atMs || b.delta - a.delta);
  let backlog = 0, peakBacklog = 0;
  for (const change of changes) { backlog += change.delta; peakBacklog = Math.max(peakBacklog, backlog); }
  const bracketed = samples.filter(row => row.atMs > preceding.atMs && row.atMs <= following.atMs);
  const appCpuMicros = bracketed.reduce((total, row) => total + row.cpuMicros, 0);
  const pgBefore = [...processSamples].reverse().find(row => row.atMs <= begin), pgAfter = processSamples.find(row => row.atMs >= end);
  assert.ok(pgBefore && pgAfter, 'PG CPU needs an explicit before/after boundary');
  const pg = processSamples.filter(row => row.atMs > pgBefore.atMs && row.atMs <= pgAfter.atMs);
  const previousByPid = new Map(pgBefore.postgres.map(proc => [proc.pid, proc.cpuMillis])); let pgCpuMillis = 0;
  for (const row of pg) for (const proc of row.postgres) {
    const previous = previousByPid.get(proc.pid);
    pgCpuMillis += previous === undefined || proc.cpuMillis < previous ? proc.cpuMillis : proc.cpuMillis - previous;
    previousByPid.set(proc.pid, proc.cpuMillis);
  }
  return { name: item.name, interval: { begin, end }, providerMarkers: offered.length, postcommitMarkers: persisted.length,
    emittedToCommittedBacklogPeak: peakBacklog, finalUncommittedMarkers: backlog, originalClockCount: originalClocks.length, rawMarkersWithoutOriginalClock, markerCoverage,
    finalBacklogInterpretation: item.stop ? 'Cancellation may intentionally leave raw unacknowledged output uncommitted under the preserved transport policy' : 'Must be zero after full terminal drainage',
    actualNormalizedQueuePeakInBracketedWindow: Math.max(...bracketed.map(row => row.queuePeakSinceSample)),
    actualNormalizedQueueDepthAtLastPreterminalSample: during.at(-1).actualNormalizedQueueDepth,
    actualNormalizedQueueDepthAtPostterminalBoundary: following.actualNormalizedQueueDepth,
    appCpuWindow: { begin: preceding.atMs, end: following.atMs }, pgCpuWindow: { begin: pgBefore.atMs, end: pgAfter.atMs },
    appCpuMicros, appCpuMicrosPerMarker: appCpuMicros / persisted.length, sampledPgCpuMillis: pgCpuMillis,
    appCpuMicrosPerCommittedNormalizedEvent: appCpuMicros / deltas.committedEvents,
    sampledPgCpuMillisPerMarker: pgCpuMillis / persisted.length, appRssPeakBytes: Math.max(...during.map(row => row.rssBytes)),
    appHeapPeakBytes: Math.max(...during.map(row => row.heapUsedBytes)),
    eventLoopDelayPeakMs: Math.max(...during.map(row => row.eventLoopDelayMaxMs ?? 0)),
    eventLoopUtilizationMedian: during.map(row => row.eventLoopUtilization).sort((a, b) => a - b)[Math.floor(during.length / 2)],
    databaseCounterDeltas: deltas, sqlCallsPerMarker: deltas.sqlCalls / persisted.length,
    sqlCallsPerCommittedNormalizedEvent: deltas.sqlCalls / deltas.committedEvents,
    transactionsBegunPerMarker: deltas.begins / persisted.length,
    transactionsBegunPerCommittedNormalizedEvent: deltas.begins / deltas.committedEvents,
    counterBoundaryOvershootMs: { before: begin - preceding.atMs, after: following.atMs - end }, resourceSampleCount: during.length };
}));
const cpuProfiles = smoke ? [] : await Promise.all((await readdir(cpuProfileDirectory)).filter(file => file.endsWith('.cpuprofile')).map(async file => ({
  file: path.join(cpuProfileDirectory, file), sha256: createHash('sha256').update(await readFile(path.join(cpuProfileDirectory, file))).digest('hex'),
})));
if (!smoke) assert.ok(cpuProfiles.length > 0, 'Full profile must capture the app-only Node CPU profile');
const summary = { diagnosticOnly: true, performanceAcceptanceEligible: false, tree, sourceRevision: evidence.sourceRevision,
  complete: true, cases, cpuProfiles, processScope: { appCpuAndMemory: 'Server Node process only; excludes Rust Runner/providers and the external load driver', postgresMemory: 'Per-process RSS; summing it double-counts shared pages' }, disclosures: ['CPU/RSS/heap describe the server Node process, not the Rust Runner, provider or whole host fleet',
    'PostgreSQL memory is per-process RSS; a sum would double-count shared pages and is not unique physical memory',
    'Actual normalized queue excludes iterator/collector/in-flight append and raw transport buffers',
    'Raw provider-observer emission-minus-postcommit is a full-path backlog proxy, distinct from the actual normalized queue',
    'Original intended/emitted clocks come from the separate streamed HTTP source channel in browser evidence; no clocks are synthesized for cancelled unmatched raw tail',
    'Resource samples use 250ms app / 1s process polling. CPU/SQL phase boundaries are approximate, with overshoot reported',
    'SQL counts are query-build attempts across the whole app including API reads, lifecycle work, COMMIT and savepoints; no parameters or SQL text are logged',
    'Bracketed whole-app CPU/SQL windows can include postterminal verification reads; per-marker ratios are diagnostic whole-app costs, not append-only costs',
    'Postcommit observation happens after the durable outer transaction, so its timestamp is an upper bound',
    'Full diagnostics also run app-only Node --cpu-prof; CPU sampling and observer overhead are excluded from acceptance timing claims'] };
await saveJson(path.join(out, 'PROFILE-ONLY-summary.json'), summary);
console.log(JSON.stringify(summary, null, 2));
