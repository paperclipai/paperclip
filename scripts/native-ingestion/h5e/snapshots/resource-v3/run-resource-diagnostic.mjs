import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, open, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRelease, MAIN, MAX_MS, hash, json, shaFile, scalarBounds } from './resource-contract.mjs';
import { owningAttempt, markerCoverage, bindAcknowledgement, assertNoCpuProfiles } from './counter-proofs.mjs';
import { stopPgService } from './pg-service.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const protocolFiles = ['native-event-ingestion.journey.ts', 'playwright-native-ingestion.config.ts', 'fixtures/in-feed-codex.mjs',
  'fixtures/native-ingestion-bin/codex', 'fixtures/composer-stop-codex-loader.mjs', 'fixtures/native-ingestion-bootstrap.mjs',
  'fixtures/native-ingestion-remote-server.mjs', 'fixtures/native-ingestion-protocol-qualification.mjs', 'fixtures/native-ingestion-h5.mjs'];
export function diagnosticPlan(release, port) {
  assert.ok(['SMALL', 'FULL'].includes(release.workload));
  const loader = './server/node_modules/tsx/dist/loader.mjs';
  const fixture = path.join(release.harnessRoot, 'tests/e2e/fixtures');
  const command = `${quote(release.nodeExecutable)} --import ${loader} ${quote(path.join(fixture, 'native-ingestion-bootstrap.mjs'))} && ${quote(release.nodeExecutable)} --import ${quote(path.join(here, 'counter-preload.mjs'))} --import ${quote(path.join(here, 'pg-service-preload.mjs'))} --import ${loader} ${quote(path.join(fixture, 'native-ingestion-remote-server.mjs'))} --compiled-entry=server/dist/index.js`;
  const binary = path.join(release.appRoot, 'packages/paperclip-runner/runner/target/release/paperclip-runnerd');
  return { executable: release.nodeExecutable, cwd: release.harnessRoot,
    args: ['node_modules/@playwright/test/cli.js', 'test', '--config', path.join(here, 'resource-wrapper.config.mts')],
    environment: { NODE_ENV: 'test', NODE_OPTIONS: '', PAPERCLIP_CI_PROFILE: 'false',
      PAPERCLIP_INGESTION_HARNESS_ROOT: release.harnessRoot, PAPERCLIP_INGESTION_APP_ROOT: release.appRoot,
      PAPERCLIP_INGESTION_EVIDENCE_DIR: release.output, PAPERCLIP_INGESTION_OBSERVATION_MODE: 'h5c-observe-original-sla-independent-agents-settlement',
      PAPERCLIP_INGESTION_SMOKE: release.workload === 'SMALL' ? '1' : '0',
      PAPERCLIP_INGESTION_VARIANT: `RESOURCE-${release.workload}-${release.variant}`, PAPERCLIP_INGESTION_TRANSPORT: 'sandbox-remote-with-local-stop',
      PAPERCLIP_E2E_PORT: String(port), PAPERCLIP_RUNNER_BINARY: binary, PAPERCLIP_RUNNER_REMOTE_BINARY_PATH: binary,
      PAPERCLIP_RESOURCE_COUNTER_RELEASE: 'combined-h5e-resource-v2', PAPERCLIP_RESOURCE_VARIANT: release.variant,
      PAPERCLIP_RESOURCE_PINS_FILE: release.counterPinsFile, PAPERCLIP_RESOURCE_PINS_SHA256: release.counterPinsSha256,
      PAPERCLIP_RESOURCE_CPU_PROFILE: '0', PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_FS: '0',
      PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_DIR: path.join(release.output, 'profile'),
      PAPERCLIP_RESOURCE_RELEASE_FILE: release.releaseFile, PAPERCLIP_RESOURCE_RELEASE_SHA256: release.releaseSha256,
      PAPERCLIP_INGESTION_DRIVER_DEPENDENCIES: 'Frozen H5e independent locked driver; own qualified CF app; Node counters + isolated systemd PG diagnostic, never latency acceptance',
      PAPERCLIP_INGESTION_SERVER_COMMAND: command } };
}
export function assertOutcome(exit, report, evidence, flush, release) {
  assert.equal(exit.code, 0); assert.equal(exit.signal, null); assert.equal(exit.watchdogExpired, false); owningAttempt(report);
  for (const key of ['complete', 'observationComplete', 'diagnosticOnly']) assert.equal(evidence[key], true);
  assert.equal(evidence.performanceAcceptanceEligible, false); assert.equal(evidence.qualificationOnly, release.workload === 'SMALL');
  assert.equal(evidence.workloadSha256, MAIN.workload); assert.equal(evidence.measurementSha256, MAIN.measurement);
  assert.equal(evidence.harnessProvenance.sourceRevision, MAIN.revision); assert.equal(evidence.harnessProvenance.sourceStatus, '');
  assert.equal(evidence.sourceRevision, release.build.revision); assert.equal(evidence.compiledBuildRevision, release.build.revision);
  assert.equal(evidence.cleanup.complete, true); assert.deepEqual(evidence.cleanup.errors, []);
  const expected = release.workload === 'SMALL' ? [['qualification', 3, 16, false], ['operator-stop', 1, 512, true]] :
    [['paced', 1, 128, false], ['burst16', 1, 16, false], ['burst128', 10, 128, false], ['burst512', 100, 512, false],
      ['existing-history', 10, 128, false], ['operator-stop', 1, 512, true]];
  assert.deepEqual(evidence.cases.map(row => [row.name, row.runs, row.events, row.stop]), expected);
  assert.equal(flush.complete, true); assert.equal(flush.finalizedBeforeNormalAppTeardown, true);
  assert.equal(flush.procReceipt.completed, true); assert.equal(flush.sqlReceipt.completed, true);
  assert.equal(flush.counter.finalizedBeforePlaywrightWebServerTeardown, true);
}
export function ownerWindowReport(evidence, appSamples) {
  return evidence.cases.filter(item => !item.stop).flatMap(item => {
    const denominator = item.durable.reduce((sum, row) => sum + row.individualDeltas, 0);
    assert.equal(denominator, item.runs * item.events);
    return [['terminal', item.settledAtMs], ['fully-verified', item.h5.independentDrain.verifiedAtMs]].map(([boundary, end]) => {
      const window = appSamples.filter(row => row.atMs >= item.epochMs && row.atMs <= end);
      const numerators = { serverNodeCpuMicros: scalarBounds(appSamples, item.epochMs, end, row => row.cpuMicros, true),
        serverQueryBuildAttempts: scalarBounds(appSamples, item.epochMs, end, row => row.counters.queryBuildAttempts),
        serverOuterCommitAcknowledged: scalarBounds(appSamples, item.epochMs, end, row => row.counters.outerCommitAcknowledged) };
      for (const value of Object.values(numerators)) if (value.eligible) Object.assign(value, { lowerPerDurableTextDelta: value.lower / denominator, upperPerDurableTextDelta: value.upper / denominator });
      return { case: item.name, boundary, startMs: item.epochMs, endMs: end, denominator,
        denominatorKind: 'Independent source-clock-matched durable text deltas; all server/background/observer work remains in the scoped numerator',
        numerators, sampledRssMaximumBytes: Math.max(0, ...window.map(row => row.rssBytes)),
        sampledNormalizedQueueMaximum: Math.max(0, ...window.map(row => row.actualNormalizedQueueDepth)),
        eventLoop: { histogramResolutionMs: 20, sampleCount: window.length,
          maximumObservedDelayMs: Math.max(0, ...window.map(row => row.eventLoopDelayMaxMs ?? 0)),
          sampledP95ValuesMs: window.map(row => row.eventLoopDelayP95Ms), p99Claim: false } };
    });
  });
}
async function freePort() {
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function execute(plan, output) {
  const stream = (await open(path.join(output, 'playwright.log'), 'wx')).createWriteStream();
  const child = spawn(plan.executable, plan.args, { cwd: plan.cwd, env: { ...process.env, ...plan.environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
  let watchdogExpired = false, forced;
  const timer = setTimeout(() => { watchdogExpired = true; child.kill('SIGTERM'); forced = setTimeout(() => child.kill('SIGKILL'), 30000); }, MAX_MS);
  try { return await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, watchdogExpired })); }); }
  finally { clearTimeout(timer); clearTimeout(forced); await new Promise(resolve => stream.end(resolve)); }
}
async function main() {
  if (!process.argv.includes('--execute')) { console.log(JSON.stringify({ sourceOnly: true, diagnosticOnly: true, performanceAcceptanceEligible: false,
    frozenMain: MAIN.revision, workloads: ['SMALL', 'FULL'], B2Build: (await json(new URL('./known-builds.json', import.meta.url))).B2, B2ServingQualified: false, execution: 'Requires frozen root release, independent review, serving preflight pins and separate quiet window' })); return; }
  const option = key => process.argv.find(value => value.startsWith('--' + key + '='))?.slice(key.length + 3);
  const releaseFile = option('release'), releaseSha256 = option('release-sha256');
  const context = await loadRelease(releaseFile, releaseSha256), { release, helper, qualified, pins } = context;
  release.releaseFile = releaseFile; release.releaseSha256 = releaseSha256;
  assertNoCpuProfiles(process.execArgv, process.env); assert.equal(process.env.DATABASE_URL, undefined);
  const git = (directory, ...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  assert.equal(git(release.appRoot, 'rev-parse', 'HEAD'), release.build.revision); assert.equal(git(release.appRoot, 'status', '--porcelain'), '');
  assert.equal(git(release.harnessRoot, 'rev-parse', 'HEAD'), MAIN.revision); assert.equal(git(release.harnessRoot, 'status', '--porcelain'), '');
  assert.equal(hash(Buffer.concat(await Promise.all(protocolFiles.map(file => readFile(path.join(release.harnessRoot, 'tests/e2e', file)))))), MAIN.measurement);
  assert.equal(await shaFile(path.join(release.harnessRoot, 'pnpm-lock.yaml')), MAIN.lock);
  assert.equal(await shaFile(path.join(release.harnessRoot, 'scripts/compare-native-ingestion-browser.ts')), MAIN.comparator);
  const require = createRequire(path.join(release.harnessRoot, 'package.json')); assert.equal(require('@playwright/test/package.json').version, pins.runtime.playwright);
  const runtimeChecks = await helper.validateRuntimeChecks(release.runtimeChecks, release.appRoot, process.env);
  await mkdir(release.output, { recursive: false, mode: 0o700 }); await mkdir(path.join(release.output, 'profile'), { mode: 0o700 });
  await save(path.join(release.output, 'root-release.json'), await json(releaseFile));
  let primary, exit, report, evidence, flush, coverage, ownerResources, cleanup;
  try {
    await helper.physicalQuietGuard({ receiptFile: path.join(release.output, 'physical-quiet-pre.json'), phase: 'pre-arm', armStage: 'RESOURCE-' + release.workload });
    const inventory = await helper.validateActualInventory(release.build, qualified.manifest), ui = await helper.assertNoPreferredUiShadow(release.appRoot);
    const plan = diagnosticPlan(release, await freePort()), environment = { ...process.env, ...plan.environment };
    await helper.assertPathNode(environment, release.nodeExecutable, release.appRoot); assertNoCpuProfiles([], environment);
    await save(path.join(release.output, 'command.json'), { ...plan, runtimeChecks, inventory, ui, diagnosticOnly: true, performanceAcceptanceEligible: false });
    exit = await execute(plan, release.output); await save(path.join(release.output, 'driver-exit.json'), exit); report = await json(path.join(release.output, 'playwright.json'));
    const attempt = owningAttempt(report); evidence = attempt.attachment.body ? JSON.parse(Buffer.from(attempt.attachment.body, 'base64')) : await json(attempt.attachment.path);
    await save(path.join(release.output, 'RESOURCE-owning-browser-evidence.json'), evidence);
    flush = await json(path.join(release.output, 'COMBINED-resource-before-teardown.json')); assertOutcome(exit, report, evidence, flush, release);
    process.env.PAPERCLIP_RESOURCE_PINS_FILE = release.counterPinsFile; process.env.PAPERCLIP_RESOURCE_PINS_SHA256 = release.counterPinsSha256;
    const capture = await import('./counter-capture-client.mjs');
    const directory = await capture.ownedDirectory(path.join(release.output, 'profile'));
    const metadata = await json(await capture.ownedFile(directory, flush.counter.metadataFile));
    const receipt = await json(await capture.ownedFile(directory, flush.counter.receiptFile));
    bindAcknowledgement(flush.counter, metadata, receipt);
    const checked = await capture.verifyFinalizedFiles(directory, metadata, { ...receipt, receiptFile: flush.counter.receiptFile, receiptSha256: flush.counter.receiptSha256 });
    coverage = markerCoverage(evidence, checked.markers);
    await save(path.join(release.output, 'RESOURCE-marker-coverage.json'), coverage);
    const appSamples = (await readFile(checked.recordFile, 'utf8')).trim().split('\n').map(row => JSON.parse(row)).filter(row => row.kind === 'app-sample');
    ownerResources = release.workload === 'FULL' ? ownerWindowReport(evidence, appSamples) : { ratiosEligible: false, reason: 'SMALL hook/lifecycle qualification only' };
    await save(path.join(release.output, 'owner-resource-windows.json'), ownerResources);
    if (release.workload === 'FULL') await promisify(execFile)(release.pythonExecutable, [path.join(here, 'analyze-pg-windows.py'),
      '--proc', path.join(release.output, 'external-proc.jsonl'), '--owning', path.join(release.output, 'RESOURCE-owning-browser-evidence.json'),
      '--flush', path.join(release.output, 'COMBINED-resource-before-teardown.json'), '--coverage', path.join(release.output, 'RESOURCE-marker-coverage.json'),
      '--output', path.join(release.output, 'pg-resource-windows.json')], { timeout: 10000, maxBuffer: 1024 * 1024 });
    if (release.workload === 'FULL') {
      const pgResources = await json(path.join(release.output, 'pg-resource-windows.json'));
      const ownerLoaded = ownerResources.filter(row => row.case === 'burst512');
      const pgLoaded = pgResources.windows.filter(row => row.case === 'burst512');
      assert.equal(ownerLoaded.length, 2); assert.equal(pgLoaded.length, 2);
      assert.ok(ownerLoaded.every(row => Object.values(row.numerators).every(value => value.eligible)), 'Loaded owner resource precision failed; retain raw without ratios');
      assert.ok(pgLoaded.every(row => row.pgClusterCpu.boundaryEligible), 'Loaded PG resource precision failed; retain raw without ratios');
    }
  } catch (error) { primary = error; }
  // Prestarted PG outlives normal app teardown; retire only this recorded unit.
  try { cleanup = await stopPgService(release); }
  catch (error) { primary ??= error; cleanup = { complete: false, error: String(error.message) }; }
  try { await helper.physicalQuietGuard({ receiptFile: path.join(release.output, 'physical-quiet-post.json'), phase: 'post-arm', armStage: 'RESOURCE-' + release.workload, primaryFailureAlreadyPresent: Boolean(primary) }); }
  catch (error) { primary ??= error; }
  await save(path.join(release.output, 'resource-outcome.json'), { complete: !primary, diagnosticOnly: true, performanceAcceptanceEligible: false,
    exit, owningReportSha256: report ? await shaFile(path.join(release.output, 'playwright.json')) : null,
    flush, coverage, ownerResources, cleanup, failure: primary ? String(primary.stack ?? primary) : null,
    limitations: ['Unprofiled performance acceptance is separate', 'No shutdown CPU in event ratios', 'PG aggregate includes maintenance and SQL observer',
      'Proc CPU is observed lower bound; provider role completeness unproved', 'Rows returned/locks sampled are not global rows examined or exact lock wait/hold',
      'Original deadline misses and failures remain in owning raw evidence; completed diagnostic alone establishes no performance gain'] });
  if (primary) throw primary;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
