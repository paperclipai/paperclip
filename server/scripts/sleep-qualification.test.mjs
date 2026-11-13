import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { configuredSleepFeatures, evaluateSleepQualification, observeConfiguredSignals, observeIncomingHttpWindow, sleepConfigurationDigest, finalizeLocalSleepReceipt } from '../../scripts/sleep-qualification/evidence.mjs';
const configuration = { automaticBackups: { intervalMinutes: 60, idleCheckpoint: true }, announcements: true, telemetryOrigin: 'http://127.0.0.1:4318/telemetry', otelOrigin: 'http://127.0.0.1:4318', serveUi: true };
// Independent preflight contract, not copied from the receipt/digest implementation.
const configDigest = createHash('sha256').update(JSON.stringify({ automaticBackups: { intervalMinutes: 60, idleCheckpoint: true }, announcements: true, telemetry: true, otel: { enabled: true, protocol: 'http/json' }, serveUi: true, managedInstance: false, deploymentMode: 'local_trusted', storageProvider: 'local_disk' })).digest('hex');
const expected = { appSha: 'a'.repeat(40), cloudSha: 'b'.repeat(40), target: 'owned-fixture', configDigest };
function fixture() {
  return { version: 1, ...expected, configuration: structuredClone(configuration), collectorOrigins: { telemetry: configuration.telemetryOrigin, otel: configuration.otelOrigin },
    announcement: { intercepted: true, requests: ['https://pages.paperclip.ing/announcements/v1/current.json'], unmatched: [] },
    signalObservation: { telemetryRequests: 1, traceRequests: 1, exportedSpans: 1, qualificationSpans: 1, metricRequests: 0, logRequests: 0, malformedTraceRequests: 0, unexpectedRequests: 0 },
    backupCheckpoint: { owner: 'normal-idle-checkpoint', startedAt: '2099-01-01T00:12:31Z', observedAt: '2099-01-01T00:13:00Z', wakeMarkerObserved: true, failureObserved: false, archives: [{ name: 'owned.sql.gz', bytes: 128, sqlBytes: 256, sha256: 'd'.repeat(64), gzipVerified: true, fixtureIdentifierFound: true, createdAt: '2099-01-01T00:12:45Z', createdAtSource: 'birthtime' }] }, startedAt: '2099-01-01T00:00:00Z', finishedAt: '2099-01-01T01:00:00Z',
    features: { telemetry: true, announcements: true, automaticBackups: true, otel: true, exportedSpans: 1 },
    quiet: { startedAt: '2099-01-01T00:11:00Z', finishedAt: '2099-01-01T00:12:30Z', elapsedMs: 90_000, clock: 'real', sqlQueries: 0, connectionsOpened: 0, connectionsRemaining: 0, nonDatabaseRequests: 0, nonDatabaseBytes: 0,
      observerRequests: observeIncomingHttpWindow(
        { source: 'node-http-server-events', captureId: '11111111-1111-4111-8111-111111111111', installed: true, valid: true, requests: 12, observedAt: '2099-01-01T00:11:00Z' },
        { source: 'node-http-server-events', captureId: '11111111-1111-4111-8111-111111111111', installed: true, valid: true, requests: 12, observedAt: '2099-01-01T00:12:30Z' }) },
    eligibility: { observedAt: '2099-01-01T00:13:00Z', backgroundWork: 'none', ownedHold: true, unchangedGeneration: true, apiCooldownElapsedMs: 600_000 } };
}
function deployed() {
  const f = fixture();
  f.provider = { ...expected, live: true, observedAt: '2099-01-01T00:14:00Z', observerRequests: [{ method: 'GET', boundary: 'provider-control-plane' }],
    neon: { identityVerified: true, currentState: 'idle', pendingState: null },
    railway: { identityVerified: true, state: 'OBSERVED', services: [{ identityVerified: true, state: 'OBSERVED', backupsEnabled: false, backupStorageVerified: false, allDeploymentsStopped: true }] } };
  return f;
}
test('local configured quiet leaves every provider and wake claim inconclusive', () => {
  const r = evaluateSleepQualification(fixture(), expected).layers;
  assert.equal(r.workerQuiet.verdict, 'VERIFIED'); assert.equal(r.eligibility.verdict, 'VERIFIED');
  for (const key of ['hostSuspension', 'databaseSuspension', 'backupPersistence', 'inboundWake', 'timedWake']) assert.equal(r[key].verdict, 'INCONCLUSIVE');
});
test('wrong source, target and configuration evidence cannot be combined', () => {
  for (const key of Object.keys(expected)) { const f = fixture(); f[key] = 'wrong'; assert.throws(() => evaluateSleepQualification(f, expected), /identity/); }
  const f = deployed(); f.provider.target = 'foreign'; assert.throws(() => evaluateSleepQualification(f, expected), /provider_identity/);
});
test('fake time, a no-op exporter, open connections, observer health requests and a shortened cooldown fail', () => {
  for (const change of [f => f.quiet.clock = 'qualified', f => f.features.exportedSpans = 0, f => f.quiet.connectionsRemaining = 1,
    f => { f.quiet.observerRequests.after.requests++; f.quiet.observerRequests.requests++; }, f => f.quiet.nonDatabaseBytes = 1, f => f.quiet.elapsedMs = 89_999]) {
    const f = fixture(); change(f); assert.equal(evaluateSleepQualification(f, expected).layers.workerQuiet.verdict, 'NOT VERIFIED');
  }
  const f = fixture(); f.eligibility.apiCooldownElapsedMs = 599_999; assert.equal(evaluateSleepQualification(f, expected).layers.eligibility.verdict, 'NOT VERIFIED');
});
test('incoming HTTP observation must be installed, intact and cover the whole window; legacy empty lists are not evidence', () => {
  const changes = [f => f.quiet.observerRequests = [], f => delete f.quiet.observerRequests,
    f => f.quiet.observerRequests.before.installed = false, f => f.quiet.observerRequests.after.installed = false,
    f => f.quiet.observerRequests.before.valid = false, f => f.quiet.observerRequests.after.valid = false,
    f => delete f.quiet.observerRequests.before, f => delete f.quiet.observerRequests.after,
    f => f.quiet.observerRequests.before.source = 'harness-api-only', f => f.quiet.observerRequests.after.source = 'unknown',
    f => f.quiet.observerRequests.after.captureId = '22222222-2222-4222-8222-222222222222',
    f => f.quiet.observerRequests.before.captureId = '',
    f => f.quiet.observerRequests.before.observedAt = '2099-01-01T00:11:00.001Z',
    f => f.quiet.observerRequests.after.observedAt = '2099-01-01T00:12:29.999Z',
    f => f.quiet.observerRequests.before.observedAt = '2098-12-31T23:59:59Z',
    f => f.quiet.observerRequests.after.observedAt = '2099-01-01T01:00:01Z',
    f => f.quiet.observerRequests.after.observedAt = 'invalid',
    f => f.quiet.observerRequests.after.requests--,
    // A forged zero cannot hide an actual request while SQL and outbound counters remain zero.
    f => f.quiet.observerRequests.after.requests++,
    f => f.quiet.observerRequests.requests = 1];
  for (const point of ['before', 'after']) {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '12']) {
      changes.push(f => f.quiet.observerRequests[point].requests = value);
    }
  }
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0']) changes.push(f => f.quiet.observerRequests.requests = value);
  for (const change of changes) {
    const f = fixture(); change(f);
    assert.equal(f.quiet.sqlQueries, 0); assert.equal(f.quiet.nonDatabaseRequests, 0);
    assert.equal(evaluateSleepQualification(f, expected).layers.workerQuiet.verdict, 'NOT VERIFIED');
  }
});
test('configured feature claims require complete announcement and integer collector observations', () => {
  const changes = [f => delete f.announcement, f => f.announcement.intercepted = false,
    f => f.announcement.requests = [], f => f.announcement.requests = ['https://foreign.example/feed'],
    f => f.announcement.unmatched.push('https://foreign.example/feed'), f => delete f.announcement.unmatched,
    f => delete f.signalObservation, f => f.signalObservation.telemetryRequests = 0,
    f => f.signalObservation.traceRequests = 0, f => f.signalObservation.exportedSpans = 0,
    f => f.signalObservation.qualificationSpans = 0, f => f.signalObservation.qualificationSpans = 2,
    f => f.signalObservation.metricRequests = 1, f => f.signalObservation.logRequests = 1,
    f => f.signalObservation.malformedTraceRequests = 1, f => f.signalObservation.unexpectedRequests = 1,
    f => f.features.telemetry = false, f => f.features.announcements = false, f => f.features.otel = false];
  for (const key of Object.keys(fixture().signalObservation)) {
    changes.push(f => delete f.signalObservation[key]);
    for (const value of [-1, 0.5, NaN, Infinity, '1']) changes.push(f => f.signalObservation[key] = value);
  }
  for (const change of changes) { const f = fixture(); change(f); assert.equal(evaluateSleepQualification(f, expected).layers.workerQuiet.verdict, 'NOT VERIFIED'); }
});
test('assembled receipts derive coverage from actual named spans and requests, including unwanted exporters', () => {
  const requests = [{ path: '/telemetry', body: {} }, { path: '/v1/traces', body: { resourceSpans: [{ scopeSpans: [{ spans: [
    { name: 'ordinary-http' }, { name: 'sleep-qualification-stimulus' },
  ] }] }] } }];
  const f = fixture(); f.signalObservation = observeConfiguredSignals(requests); f.features = configuredSleepFeatures(f);
  assert.deepEqual(f.signalObservation, { telemetryRequests: 1, traceRequests: 1, exportedSpans: 2, qualificationSpans: 1,
    metricRequests: 0, logRequests: 0, malformedTraceRequests: 0, unexpectedRequests: 0 });
  assert.equal(f.features.exportedSpans, 2); // One trace request contained two real span records.
  assert.equal(finalizeLocalSleepReceipt(f, expected, () => f.finishedAt).report.layers.workerQuiet.verdict, 'VERIFIED');
  for (const extra of [{ path: '/v1/metrics?batch=1', body: {} }, { path: '/v1/logs', body: {} },
    { path: '/unmatched', body: {} }, { path: '/v1/traces', body: { resourceSpans: [{}] } }]) {
    const changed = fixture(); changed.signalObservation = observeConfiguredSignals([...requests, extra]); changed.features = configuredSleepFeatures(changed);
    assert.equal(evaluateSleepQualification(changed, expected).layers.workerQuiet.verdict, 'NOT VERIFIED');
  }
  const noop = fixture(); noop.signalObservation = observeConfiguredSignals([{ path: '/telemetry', body: {} },
    { path: '/v1/traces', body: { resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'other', attributes: [{ value: 'sleep-qualification-stimulus' }] }] }] }] } }]);
  noop.features = configuredSleepFeatures(noop); assert.equal(noop.signalObservation.qualificationSpans, 0);
  assert.equal(evaluateSleepQualification(noop, expected).layers.workerQuiet.verdict, 'NOT VERIFIED');
});
test('registry sleep, incomplete deployment inventory and a failed metadata read cannot prove providers stopped', () => {
  const f = deployed(); f.provider.neon = { currentState: 'sleeping', identityVerified: true }; f.provider.railway.services = [];
  let r = evaluateSleepQualification(f, expected).layers; assert.equal(r.databaseSuspension.verdict, 'INCONCLUSIVE'); assert.equal(r.hostSuspension.verdict, 'INCONCLUSIVE');
  f.provider.neon = { currentState: 'idle', pendingState: 'active', identityVerified: true }; r = evaluateSleepQualification(f, expected).layers; assert.equal(r.databaseSuspension.verdict, 'NOT VERIFIED');
});
test('useful authorized deadline outcome requires a durable alarm before the exact stop proof', () => {
  const f = deployed(); f.timedWake = { stimulusAt: '2099-01-01T00:20:00Z', finishedAt: '2099-01-01T00:21:00Z', ordinaryProducer: true, authorizationVerified: true, persistedOutcomeVerified: true, duplicateEffects: 0, sameFinalGeneration: true, alarmPersistedAt: '2099-01-01T00:13:30Z' };
  assert.equal(evaluateSleepQualification(f, expected).layers.timedWake.verdict, 'VERIFIED');
  for (const change of [x => x.timedWake.alarmPersistedAt = '2099-01-01T00:15:00Z', x => x.timedWake.sameFinalGeneration = false, x => x.timedWake.persistedOutcomeVerified = false, x => x.timedWake.duplicateEffects = 1]) {
    const x = structuredClone(f); change(x); assert.equal(evaluateSleepQualification(x, expected).layers.timedWake.verdict, 'NOT VERIFIED');
  }
});
test('writable path alone cannot establish backup persistence across stop and wake', () => {
  const f = deployed(); f.provider.storage = { identityVerified: true, volumeId: 'volume', beforeVolumeId: 'volume', afterVolumeId: 'volume', mountPath: '/paperclip', backupsEnabledBefore: true, backupsEnabledAfter: true, sentinelBefore: 'd'.repeat(64), sentinelAfter: 'd'.repeat(64), beforeAt: '2099-01-01T00:13:00Z', afterAt: '2099-01-01T00:25:00Z' };
  assert.equal(evaluateSleepQualification(f, expected).layers.backupPersistence.verdict, 'VERIFIED');
  for (const change of [x => delete x.provider.storage.volumeId, x => x.provider.storage.afterVolumeId = 'replacement', x => x.provider.storage.backupsEnabledAfter = false, x => x.provider.storage.sentinelAfter = 'e'.repeat(64)]) {
    const x = structuredClone(f); change(x); assert.equal(evaluateSleepQualification(x, expected).layers.backupPersistence.verdict, 'INCONCLUSIVE');
  }
});

test('unknown backup policy and unverified enabled storage cannot certify a stopped host or wake', () => {
  for (const change of [x => delete x.provider.railway.state, x => x.provider.railway.state = 'INCONCLUSIVE',
    x => delete x.provider.railway.services[0].backupsEnabled, x => x.provider.railway.services[0].backupsEnabled = null,
    x => x.provider.railway.services[0].state = 'INCONCLUSIVE', x => x.provider.railway.services[0].backupsEnabled = true]) {
    const f = deployed(); change(f);
    f.inboundWake = { stimulusAt: '2099-01-01T00:20:00Z', finishedAt: '2099-01-01T00:21:00Z', ordinaryProducer: true, authorizationVerified: true, persistedOutcomeVerified: true, duplicateEffects: 0 };
    f.timedWake = { ...f.inboundWake, alarmPersistedAt: '2099-01-01T00:13:30Z', sameFinalGeneration: true };
    const r = evaluateSleepQualification(f, expected).layers;
    assert.equal(r.hostSuspension.verdict, 'INCONCLUSIVE'); assert.equal(r.inboundWake.verdict, 'INCONCLUSIVE'); assert.equal(r.timedWake.verdict, 'INCONCLUSIVE');
  }
  const f = deployed(); assert.equal(evaluateSleepQualification(f, expected).layers.hostSuspension.verdict, 'VERIFIED');
  f.provider.railway.services[0].backupsEnabled = true; f.provider.railway.services[0].backupStorageVerified = true;
  assert.equal(evaluateSleepQualification(f, expected).layers.hostSuspension.verdict, 'VERIFIED');
});

function woken() {
  const f = deployed();
  f.inboundWake = { stimulusAt: '2099-01-01T00:20:00Z', finishedAt: '2099-01-01T00:21:00Z', ordinaryProducer: true, authorizationVerified: true, persistedOutcomeVerified: true, duplicateEffects: 0 };
  f.returnToIdle = { quietStartedAt: '2099-01-01T00:31:00Z', quietFinishedAt: '2099-01-01T00:32:30Z', observedAt: '2099-01-01T00:33:00Z', freshQuietWindowMs: 90_000, backgroundWork: 'none', ownedHold: true };
  return f;
}
test('return to idle requires a real 90-second window after the latest wake', () => {
  assert.equal(evaluateSleepQualification(woken(), expected).layers.returnToIdle.verdict, 'VERIFIED');
  for (const finishedAt of ['invalid', '2098-12-31T23:59:59Z', '2099-01-01T01:00:01Z']) {
    const f = woken(); f.timedWake = { ...f.inboundWake, finishedAt, alarmPersistedAt: '2099-01-01T00:13:30Z', sameFinalGeneration: true };
    assert.equal(evaluateSleepQualification(f, expected).layers.inboundWake.verdict, 'VERIFIED');
    assert.equal(evaluateSleepQualification(f, expected).layers.returnToIdle.verdict, 'NOT VERIFIED');
  }

  for (const change of [
    f => f.returnToIdle.quietFinishedAt = '2099-01-01T00:31:00.001Z',
    f => { f.returnToIdle.quietStartedAt = '2099-01-01T00:19:00Z'; f.returnToIdle.quietFinishedAt = '2099-01-01T00:20:30Z'; },
    f => f.returnToIdle.quietStartedAt = '2098-12-31T23:00:00Z',
    f => f.returnToIdle.quietFinishedAt = '2099-01-01T01:00:01Z',
    f => f.returnToIdle.quietFinishedAt = '2099-01-01T00:30:00Z',
    f => f.returnToIdle.observedAt = '2099-01-01T00:32:00Z',
    f => f.returnToIdle.freshQuietWindowMs = Infinity,
    f => f.returnToIdle.freshQuietWindowMs = 90_001,
    f => delete f.returnToIdle.quietStartedAt,
  ]) {
    const f = woken(); change(f); assert.equal(evaluateSleepQualification(f, expected).layers.returnToIdle.verdict, 'NOT VERIFIED');
  }
});
test('exact observed active providers are negative evidence while unknown identity stays inconclusive', () => {
  for (const state of [{ currentState: 'active', pendingState: null }, { currentState: 'idle', pendingState: 'active' }]) {
    const f = deployed(); Object.assign(f.provider.neon, state);
    assert.equal(evaluateSleepQualification(f, expected).layers.databaseSuspension.verdict, 'NOT VERIFIED');
    f.provider.neon.identityVerified = false;
    assert.equal(evaluateSleepQualification(f, expected).layers.databaseSuspension.verdict, 'INCONCLUSIVE');
  }
  const f = deployed(); f.provider.railway.services[0].allDeploymentsStopped = false;
  assert.equal(evaluateSleepQualification(f, expected).layers.hostSuspension.verdict, 'NOT VERIFIED');
  f.provider.railway.services[0].identityVerified = false;
  assert.equal(evaluateSleepQualification(f, expected).layers.hostSuspension.verdict, 'INCONCLUSIVE');
});

test('logical digest is stable across origins and detects changed enabled configuration', () => {
  assert.equal(sleepConfigurationDigest(configuration), configDigest);
  const f = fixture(); f.configuration.telemetryOrigin = 'http://127.0.0.1:5555/telemetry'; f.configuration.otelOrigin = 'http://127.0.0.1:5555';
  f.collectorOrigins = { telemetry: f.configuration.telemetryOrigin, otel: f.configuration.otelOrigin };
  assert.equal(evaluateSleepQualification(f, expected).layers.workerQuiet.verdict, 'VERIFIED');
  assert.throws(() => evaluateSleepQualification(f, { ...expected, collectorOrigins: fixture().collectorOrigins }), /collector_origins/);
  for (const change of [x => x.configuration.announcements = false, x => x.configuration.serveUi = false,
    x => x.configuration.automaticBackups.intervalMinutes = 5, x => x.configuration.automaticBackups.idleCheckpoint = false,
    x => x.configuration.managedInstance = true, x => x.configuration.deploymentMode = 'authenticated', x => x.configuration.storageProvider = 's3',
    x => x.configuration.otelOrigin = '', x => x.configuration.telemetryOrigin = '']) {
    const changed = fixture(); change(changed); assert.throws(() => evaluateSleepQualification(changed, expected), /configuration_digest/);
  }
});
test('configured backup feature requires observed verified owned archives and a wake marker', () => {
  for (const change of [f => delete f.backupCheckpoint, f => f.backupCheckpoint.archives = [],
    f => f.backupCheckpoint.wakeMarkerObserved = false, f => f.backupCheckpoint.failureObserved = true,
    f => f.backupCheckpoint.archives[0].gzipVerified = false, f => f.backupCheckpoint.archives[0].fixtureIdentifierFound = false,
    f => f.backupCheckpoint.archives[0].bytes = 0, f => f.backupCheckpoint.archives[0].sha256 = 'invalid',
    f => f.backupCheckpoint.archives[0].createdAt = '2098-01-01T00:00:00Z',
    f => f.backupCheckpoint.archives[0].createdAtSource = 'unknown',
    f => f.backupCheckpoint.startedAt = '2099-01-01T00:11:00Z']) {
    const f = fixture(); change(f); assert.equal(evaluateSleepQualification(f, expected).layers.workerQuiet.verdict, 'NOT VERIFIED');
  }
});
test('receipt finalization follows observations and validates the actual resulting receipt', () => {
  const f = fixture(); delete f.finishedAt;
  let tick = Date.parse(f.eligibility.observedAt);
  const { receipt, report } = finalizeLocalSleepReceipt(f, expected, () => new Date(++tick).toISOString());
  assert.ok(Date.parse(receipt.finishedAt) > Date.parse(receipt.eligibility.observedAt));
  assert.equal(report.layers.eligibility.verdict, 'VERIFIED');
  assert.throws(() => finalizeLocalSleepReceipt(f, expected, () => f.startedAt), /local_evidence/);
});
test('CLI exits one for known active providers and zero for inconclusive identity', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sleep-evidence-cli-'));
  try {
    const input = path.join(directory, 'receipt.json'), expectedPath = path.join(directory, 'expected.json'), output = path.join(directory, 'report.json');
    await writeFile(expectedPath, JSON.stringify(expected));
    const f = deployed(); f.provider.neon.currentState = 'active';
    for (const [identityVerified, status] of [[true, 1], [false, 0]]) {
      f.provider.neon.identityVerified = identityVerified; await writeFile(input, JSON.stringify(f));
      const child = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/sleep-qualification/evidence.mjs', import.meta.url)), input, expectedPath, output], { encoding: 'utf8' });
      assert.equal(child.status, status, child.stderr);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
