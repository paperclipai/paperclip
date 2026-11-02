import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const layers = ['workerQuiet', 'eligibility', 'databaseSuspension', 'hostSuspension', 'backupPersistence', 'inboundWake', 'timedWake', 'returnToIdle'];
const result = (verdict, reason) => ({ verdict, reason });

/** Evaluate this campaign's measured boundaries. A local run cannot certify a provider. */
export function evaluateSleepQualification(receipt, expected) {
  if (!receipt || receipt.version !== 1 || !expected || !sha(expected.appSha)
    || !sha(expected.cloudSha) || typeof expected.target !== 'string' || !expected.target
    || typeof expected.configDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expected.configDigest)
    || !stamp(receipt.startedAt) || !stamp(receipt.finishedAt)
    || Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)
    || ['appSha', 'cloudSha', 'target', 'configDigest'].some(key => receipt[key] !== expected[key])) {
    throw new Error('sleep_qualification_identity_or_window_invalid');
  }
  const output = Object.fromEntries(layers.map(layer => [layer, result('INCONCLUSIVE', 'No evidence for this layer')]));
  const inRun = value => stamp(value) && Date.parse(value) >= Date.parse(receipt.startedAt) && Date.parse(value) <= Date.parse(receipt.finishedAt);
  const quiet = receipt.quiet;
  if (quiet) {
    const valid = inRun(quiet.startedAt) && inRun(quiet.finishedAt) && finite(quiet.elapsedMs)
      && Date.parse(quiet.finishedAt) - Date.parse(quiet.startedAt) >= 90_000 && quiet.elapsedMs >= 90_000
      && quiet.clock === 'real' && finite(quiet.sqlQueries) && finite(quiet.connectionsOpened)
      && finite(quiet.connectionsRemaining) && finite(quiet.nonDatabaseRequests) && finite(quiet.nonDatabaseBytes)
      && Array.isArray(quiet.observerRequests) && quiet.observerRequests.length === 0
      && receipt.features?.telemetry === true && receipt.features?.announcements === true
      && receipt.features?.automaticBackups === true
      && receipt.features?.otel === true && receipt.features?.exportedSpans > 0;
    const idle = valid && quiet.sqlQueries === 0 && quiet.connectionsOpened === 0 && quiet.connectionsRemaining === 0
      && quiet.nonDatabaseRequests === 0 && quiet.nonDatabaseBytes === 0;
    output.workerQuiet = result(idle ? 'VERIFIED' : 'NOT VERIFIED', idle ? 'Real configured quiet window, including closed DB connections' : 'Configured real quiet window missing, contaminated, or active');
  }
  const eligibility = receipt.eligibility;
  if (eligibility) {
    const valid = inRun(eligibility.observedAt) && eligibility.backgroundWork === 'none'
      && eligibility.ownedHold === true && eligibility.unchangedGeneration === true
      && eligibility.apiCooldownElapsedMs >= 600_000;
    output.eligibility = result(valid ? 'VERIFIED' : 'NOT VERIFIED', valid ? 'Owned stable safety proof after real API activity cooldown' : 'Safety proof or real API activity cooldown not established');
  }
  const provider = receipt.provider;
  if (provider) {
    if (!provider.live || provider.target !== expected.target || provider.configDigest !== expected.configDigest
      || provider.appSha !== expected.appSha || provider.cloudSha !== expected.cloudSha
      || !inRun(provider.observedAt)) {
      throw new Error('sleep_qualification_provider_identity_invalid');
    }
    const untouched = Array.isArray(provider.observerRequests)
      && provider.observerRequests.every(entry => entry.boundary === 'provider-control-plane' && (entry.method === 'GET' || (entry.provider === 'railway' && entry.method === 'POST' && entry.operation === 'query-only')));
    const endpoint = provider.neon;
    if (untouched && endpoint?.identityVerified === true && endpoint.currentState === 'idle' && endpoint.pendingState === null) {
      output.databaseSuspension = result('VERIFIED', 'Exact endpoint idle from live Neon control-plane metadata');
    }
    const services = provider.railway?.services;
    if (untouched && provider.railway?.identityVerified === true && Array.isArray(services) && services.length > 0
      && services.every(service => service.identityVerified === true && service.allDeploymentsStopped === true)) {
      output.hostSuspension = result('VERIFIED', 'Every exact owned service has stopped deployments');
    }
    const storage = provider.storage;
    if (output.hostSuspension.verdict === 'VERIFIED' && storage?.identityVerified === true
      && storage.volumeId && storage.beforeVolumeId === storage.volumeId && storage.afterVolumeId === storage.volumeId
      && storage.mountPath === '/paperclip' && storage.backupsEnabledBefore === true && storage.backupsEnabledAfter === true
      && /^[a-f0-9]{64}$/.test(storage.sentinelBefore ?? '') && storage.sentinelBefore === storage.sentinelAfter
      && inRun(storage.beforeAt) && inRun(storage.afterAt) && Date.parse(storage.beforeAt) < Date.parse(provider.observedAt)
      && Date.parse(storage.afterAt) > Date.parse(provider.observedAt)) {
      output.backupPersistence = result('VERIFIED', 'Attached volume and fsynced sentinel survive owned stop/wake with backups enabled');
    }
  }
  for (const [layer, kind] of [['inboundWake', 'inbound'], ['timedWake', 'deadline']]) {
    const wake = receipt[layer];
    if (!wake) continue;
    const sleeping = output.databaseSuspension.verdict === 'VERIFIED' && output.hostSuspension.verdict === 'VERIFIED';
    const chronology = provider && inRun(wake.stimulusAt) && inRun(wake.finishedAt)
      && Date.parse(wake.stimulusAt) > Date.parse(provider.observedAt) && Date.parse(wake.finishedAt) >= Date.parse(wake.stimulusAt);
    const alarm = kind !== 'deadline' || (inRun(wake.alarmPersistedAt)
      && Date.parse(wake.alarmPersistedAt) < Date.parse(provider.observedAt) && wake.sameFinalGeneration === true);
    const verified = sleeping && chronology && alarm && wake.ordinaryProducer === true
      && wake.authorizationVerified === true && wake.persistedOutcomeVerified === true && wake.duplicateEffects === 0;
    output[layer] = result(verified ? 'VERIFIED' : 'NOT VERIFIED', verified ? `Useful authorized ${kind} wake after provider sleep` : `Missing provider sleep, chronology, authorization or useful ${kind} outcome`);
  }
  if (receipt.returnToIdle) {
    const lastWake = Math.max(...['inboundWake', 'timedWake'].filter(layer => receipt[layer]).map(layer => Date.parse(receipt[layer].finishedAt)));
    const idle = receipt.returnToIdle;
    const usefulWake = ['inboundWake', 'timedWake'].some(layer => output[layer].verdict === 'VERIFIED');
    const valid = usefulWake && Number.isFinite(lastWake) && inRun(idle.observedAt) && Date.parse(idle.observedAt) > lastWake
      && idle.freshQuietWindowMs >= 90_000 && idle.backgroundWork === 'none' && idle.ownedHold === true;
    output.returnToIdle = result(valid ? 'VERIFIED' : 'NOT VERIFIED', valid ? 'Fresh quiet owned proof after useful wake' : 'No fresh quiet proof after useful wake');
  }
  return { version: 1, target: expected.target, appSha: expected.appSha, cloudSha: expected.cloudSha, configDigest: expected.configDigest, layers: output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [receiptPath, expectedPath, outputPath] = process.argv.slice(2);
  if (!receiptPath || !expectedPath || !outputPath) throw new Error('Usage: node scripts/sleep-qualification/evidence.mjs receipt.json expected.json output.json');
  const report = evaluateSleepQualification(JSON.parse(await readFile(receiptPath, 'utf8')), JSON.parse(await readFile(expectedPath, 'utf8')));
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify(report) + '\n');
  if (Object.values(report.layers).some(layer => layer.verdict === 'NOT VERIFIED')) process.exitCode = 1;
}
