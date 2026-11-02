import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { evaluateSleepQualification } from '../../scripts/sleep-qualification/evidence.mjs';
const expected = { appSha: 'a'.repeat(40), cloudSha: 'b'.repeat(40), target: 'owned-fixture', configDigest: 'c'.repeat(64) };
function fixture() {
  return { version: 1, ...expected, startedAt: '2099-01-01T00:00:00Z', finishedAt: '2099-01-01T01:00:00Z',
    features: { telemetry: true, announcements: true, automaticBackups: true, otel: true, exportedSpans: 1 },
    quiet: { startedAt: '2099-01-01T00:11:00Z', finishedAt: '2099-01-01T00:12:30Z', elapsedMs: 90_000, clock: 'real', sqlQueries: 0, connectionsOpened: 0, connectionsRemaining: 0, nonDatabaseRequests: 0, nonDatabaseBytes: 0, observerRequests: [] },
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
    f => f.quiet.observerRequests.push({ path: '/api/health' }), f => f.quiet.nonDatabaseBytes = 1, f => f.quiet.elapsedMs = 89_999]) {
    const f = fixture(); change(f); assert.equal(evaluateSleepQualification(f, expected).layers.workerQuiet.verdict, 'NOT VERIFIED');
  }
  const f = fixture(); f.eligibility.apiCooldownElapsedMs = 599_999; assert.equal(evaluateSleepQualification(f, expected).layers.eligibility.verdict, 'NOT VERIFIED');
});
test('registry sleep, incomplete deployment inventory and a failed metadata read cannot prove providers stopped', () => {
  const f = deployed(); f.provider.neon = { currentState: 'sleeping', identityVerified: true }; f.provider.railway.services = [];
  let r = evaluateSleepQualification(f, expected).layers; assert.equal(r.databaseSuspension.verdict, 'INCONCLUSIVE'); assert.equal(r.hostSuspension.verdict, 'INCONCLUSIVE');
  f.provider.neon = { currentState: 'idle', pendingState: 'active', identityVerified: true }; r = evaluateSleepQualification(f, expected).layers; assert.equal(r.databaseSuspension.verdict, 'INCONCLUSIVE');
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
