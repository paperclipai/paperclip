import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const layers = ['workerQuiet', 'eligibility', 'databaseSuspension', 'hostSuspension', 'backupPersistence', 'inboundWake', 'timedWake', 'returnToIdle'];
const result = (verdict, reason) => ({ verdict, reason });
const announcementFeed = 'https://pages.paperclip.ing/announcements/v1/current.json';
const observedAnnouncement = announcement => announcement?.intercepted === true
  && Array.isArray(announcement.requests) && announcement.requests.length > 0
  && announcement.requests.every(url => url === announcementFeed)
  && Array.isArray(announcement.unmatched) && announcement.unmatched.length === 0;
const signalKeys = ['telemetryRequests', 'traceRequests', 'exportedSpans', 'qualificationSpans', 'metricRequests', 'logRequests', 'malformedTraceRequests', 'unexpectedRequests'];
const knownSignalCounts = signal => signal && signalKeys.every(key => Number.isSafeInteger(signal[key]) && signal[key] >= 0);

/** Preserve actual cumulative app-server snapshots; IPC reads create no HTTP traffic. */
export function observeIncomingHttpWindow(before, after) {
  return { before, after, requests: after?.requests - before?.requests };
}
const knownIncomingHttpSnapshot = snapshot => snapshot?.source === 'node-http-server-events'
  && typeof snapshot.captureId === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(snapshot.captureId)
  && snapshot.installed === true && snapshot.valid === true
  && Number.isSafeInteger(snapshot.requests) && snapshot.requests >= 0 && stamp(snapshot.observedAt);
export const observedNoIncomingHttp = (observation, quiet) => knownIncomingHttpSnapshot(observation?.before)
  && knownIncomingHttpSnapshot(observation?.after) && observation.before.captureId === observation.after.captureId
  && stamp(quiet?.startedAt) && stamp(quiet?.finishedAt) && Date.parse(quiet.finishedAt) >= Date.parse(quiet.startedAt)
  && Date.parse(observation.before.observedAt) <= Date.parse(quiet.startedAt)
  && Date.parse(observation.after.observedAt) >= Date.parse(quiet.finishedAt)
  && Number.isSafeInteger(observation.requests) && observation.requests === 0
  && observation.after.requests - observation.before.requests === observation.requests;

/** Count actual collector requests and OTLP span records, never request-as-span estimates. */
export function observeConfiguredSignals(requests) {
  const observed = Object.fromEntries(signalKeys.map(key => [key, 0]));
  for (const request of requests) {
    if (typeof request?.path !== 'string' || !request.path.startsWith('/') || request.path.startsWith('//')) { observed.unexpectedRequests++; continue; }
    const pathname = new URL(request.path, 'http://owned-collector').pathname;
    if (pathname === '/telemetry') { observed.telemetryRequests++; continue; }
    if (pathname === '/v1/metrics') { observed.metricRequests++; continue; }
    if (pathname === '/v1/logs') { observed.logRequests++; continue; }
    if (pathname !== '/v1/traces') { observed.unexpectedRequests++; continue; }
    observed.traceRequests++;
    try {
      if (!Array.isArray(request.body?.resourceSpans)) throw new Error('Missing resourceSpans');
      let spans = 0, qualificationSpans = 0;
      for (const resource of request.body.resourceSpans) {
        if (!Array.isArray(resource?.scopeSpans)) throw new Error('Missing scopeSpans');
        for (const scope of resource.scopeSpans) {
          if (!Array.isArray(scope?.spans)) throw new Error('Missing spans');
          for (const span of scope.spans) {
            if (typeof span?.name !== 'string' || !span.name) throw new Error('Invalid span');
            spans++; if (span.name === 'sleep-qualification-stimulus') qualificationSpans++;
          }
        }
      }
      observed.exportedSpans += spans; observed.qualificationSpans += qualificationSpans;
    } catch { observed.malformedTraceRequests++; }
  }
  return observed;
}

/** Coverage booleans come from recorded activity; the evaluator also checks their provenance. */
export function configuredSleepFeatures({ announcement, signalObservation, backupCheckpoint }) {
  const known = knownSignalCounts(signalObservation);
  return { telemetry: Boolean(known && signalObservation.telemetryRequests > 0), announcements: Boolean(observedAnnouncement(announcement)),
    automaticBackups: backupCheckpoint?.owner === 'normal-idle-checkpoint' && backupCheckpoint.wakeMarkerObserved === true
      && backupCheckpoint.failureObserved === false && Array.isArray(backupCheckpoint.archives) && backupCheckpoint.archives.length > 0,
    otel: Boolean(known && signalObservation.traceRequests > 0 && signalObservation.exportedSpans > 0
      && signalObservation.qualificationSpans > 0 && signalObservation.qualificationSpans <= signalObservation.exportedSpans
      && signalObservation.metricRequests === 0 && signalObservation.logRequests === 0
      && signalObservation.malformedTraceRequests === 0 && signalObservation.unexpectedRequests === 0),
    exportedSpans: known ? signalObservation.exportedSpans : 0 };
}
const validBackupCheckpoint = (backup, inRun, quietFinishedAt) => backup?.owner === 'normal-idle-checkpoint' && backup.wakeMarkerObserved === true
  && backup.failureObserved === false && inRun(backup.startedAt) && inRun(backup.observedAt)
  && Date.parse(backup.startedAt) >= Date.parse(quietFinishedAt) && Date.parse(backup.observedAt) >= Date.parse(backup.startedAt) && Array.isArray(backup.archives) && backup.archives.length > 0
  && backup.archives.every(archive => typeof archive.name === 'string' && /^[^/\\]+\.sql\.gz$/.test(archive.name)
    && finite(archive.bytes) && archive.bytes > 0 && finite(archive.sqlBytes) && archive.sqlBytes > 0
    && /^[a-f0-9]{64}$/.test(archive.sha256 ?? '') && archive.gzipVerified === true && archive.fixtureIdentifierFound === true
    && ['birthtime', 'mtime'].includes(archive.createdAtSource)
    && inRun(archive.createdAt) && Date.parse(archive.createdAt) >= Date.parse(backup.startedAt) && Date.parse(archive.createdAt) <= Date.parse(backup.observedAt));

/** Canonical logical configuration: ephemeral collector addresses are bound separately. */
export function logicalSleepConfiguration(configuration) {
  if (!configuration || typeof configuration.announcements !== 'boolean' || typeof configuration.serveUi !== 'boolean'
    || typeof configuration.telemetryOrigin !== 'string' || typeof configuration.otelOrigin !== 'string'
    || (configuration.managedInstance !== undefined && typeof configuration.managedInstance !== 'boolean')
    || (configuration.deploymentMode !== undefined && !['authenticated', 'local_trusted'].includes(configuration.deploymentMode))
    || (configuration.storageProvider !== undefined && !['s3', 'local_disk'].includes(configuration.storageProvider))
    || typeof configuration.automaticBackups?.idleCheckpoint !== 'boolean'
    || !finite(configuration.automaticBackups?.intervalMinutes) || configuration.automaticBackups.intervalMinutes < 1) {
    throw new Error('sleep_qualification_configuration_invalid');
  }
  return { automaticBackups: { intervalMinutes: configuration.automaticBackups.intervalMinutes,
    idleCheckpoint: configuration.automaticBackups.idleCheckpoint }, announcements: configuration.announcements,
    telemetry: Boolean(configuration.telemetryOrigin), otel: { enabled: Boolean(configuration.otelOrigin), protocol: 'http/json' }, serveUi: configuration.serveUi, managedInstance: configuration.managedInstance ?? false,
    deploymentMode: configuration.deploymentMode ?? 'local_trusted', storageProvider: configuration.storageProvider ?? 'local_disk' };
}
export const sleepConfigurationDigest = configuration => createHash('sha256').update(JSON.stringify(logicalSleepConfiguration(configuration))).digest('hex');

/** Finish after observations, then validate the exact serialized local receipt. */
export function finalizeLocalSleepReceipt(observations, expected, now = () => new Date().toISOString()) {
  const receipt = { ...observations, finishedAt: now() };
  const report = evaluateSleepQualification(receipt, expected);
  if (report.layers.workerQuiet.verdict !== 'VERIFIED' || report.layers.eligibility.verdict !== 'VERIFIED') {
    throw new Error('sleep_qualification_local_evidence_invalid');
  }
  return { receipt, report };
}

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
  if (sleepConfigurationDigest(receipt.configuration) !== expected.configDigest) throw new Error('sleep_qualification_configuration_digest_invalid');
  const origins = receipt.collectorOrigins;
  if (!origins || origins.telemetry !== receipt.configuration.telemetryOrigin || origins.otel !== receipt.configuration.otelOrigin
    || (expected.collectorOrigins && (origins.telemetry !== expected.collectorOrigins.telemetry || origins.otel !== expected.collectorOrigins.otel))) {
    throw new Error('sleep_qualification_collector_origins_invalid');
  }
  const output = Object.fromEntries(layers.map(layer => [layer, result('INCONCLUSIVE', 'No evidence for this layer')]));
  const inRun = value => stamp(value) && Date.parse(value) >= Date.parse(receipt.startedAt) && Date.parse(value) <= Date.parse(receipt.finishedAt);
  const quiet = receipt.quiet;
  if (quiet) {
    const observedFeatures = configuredSleepFeatures(receipt);
    const valid = inRun(quiet.startedAt) && inRun(quiet.finishedAt) && finite(quiet.elapsedMs)
      && Date.parse(quiet.finishedAt) - Date.parse(quiet.startedAt) >= 90_000 && quiet.elapsedMs >= 90_000
      && quiet.clock === 'real' && finite(quiet.sqlQueries) && finite(quiet.connectionsOpened)
      && finite(quiet.connectionsRemaining) && finite(quiet.nonDatabaseRequests) && finite(quiet.nonDatabaseBytes)
      && observedNoIncomingHttp(quiet.observerRequests, quiet)
      && inRun(quiet.observerRequests.before.observedAt) && inRun(quiet.observerRequests.after.observedAt)
      && observedFeatures.telemetry && observedFeatures.announcements && observedFeatures.otel
      && Object.entries(observedFeatures).every(([key, value]) => receipt.features?.[key] === value)
      && receipt.features?.telemetry === true && receipt.features?.announcements === true
      && receipt.features?.automaticBackups === true && validBackupCheckpoint(receipt.backupCheckpoint, inRun, quiet.finishedAt)
      && receipt.features?.otel === true && receipt.features?.exportedSpans > 0;
    const idle = valid && quiet.sqlQueries === 0 && quiet.connectionsOpened === 0 && quiet.connectionsRemaining === 0
      && quiet.nonDatabaseRequests === 0 && quiet.nonDatabaseBytes === 0;
    output.workerQuiet = result(idle ? 'VERIFIED' : 'NOT VERIFIED', idle ? 'Real configured quiet window, including closed DB connections' : 'Configured real quiet window missing, contaminated, or active');
  }
  const eligibility = receipt.eligibility;
  if (eligibility) {
    const valid = inRun(eligibility.observedAt) && eligibility.backgroundWork === 'none'
      && eligibility.ownedHold === true && eligibility.unchangedGeneration === true
      && finite(eligibility.apiCooldownElapsedMs) && eligibility.apiCooldownElapsedMs >= 600_000;
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
    if (untouched && endpoint?.identityVerified === true && (endpoint.currentState === 'active'
      || (endpoint.currentState === 'idle' && endpoint.pendingState === 'active'))) {
      output.databaseSuspension = result('NOT VERIFIED', 'Exact Neon endpoint is active or becoming active');
    }
    const services = provider.railway?.services;
    if (untouched && provider.railway?.identityVerified === true && provider.railway.state === 'OBSERVED' && Array.isArray(services) && services.length > 0
      && services.every(service => service.identityVerified === true && service.state === 'OBSERVED' && service.allDeploymentsStopped === true
        && typeof service.backupsEnabled === 'boolean' && (service.backupsEnabled === false || service.backupStorageVerified === true))) {
      output.hostSuspension = result('VERIFIED', 'Every exact owned service has stopped deployments');
    }
    if (untouched && provider.railway?.identityVerified === true && Array.isArray(services)
      && services.some(service => service.identityVerified === true && service.state === 'OBSERVED' && service.allDeploymentsStopped === false)) {
      output.hostSuspension = result('NOT VERIFIED', 'An exact observed owned service still has running deployments');
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
    if (!sleeping) { output[layer] = result('INCONCLUSIVE', 'Exact provider sleep and known backup policy have not been established'); continue; }
    const verified = sleeping && chronology && alarm && wake.ordinaryProducer === true
      && wake.authorizationVerified === true && wake.persistedOutcomeVerified === true && wake.duplicateEffects === 0;
    output[layer] = result(verified ? 'VERIFIED' : 'NOT VERIFIED', verified ? `Useful authorized ${kind} wake after provider sleep` : `Missing provider sleep, chronology, authorization or useful ${kind} outcome`);
  }
  if (receipt.returnToIdle) {
    const presentWakes = ['inboundWake', 'timedWake'].filter(layer => Object.hasOwn(receipt, layer));
    const everyWakeInRun = presentWakes.every(layer => inRun(receipt[layer]?.stimulusAt) && inRun(receipt[layer]?.finishedAt)
      && Date.parse(receipt[layer].finishedAt) >= Date.parse(receipt[layer].stimulusAt));
    const lastWake = Math.max(...presentWakes.map(layer => Date.parse(receipt[layer]?.finishedAt)));
    const idle = receipt.returnToIdle;
    const usefulWake = ['inboundWake', 'timedWake'].some(layer => output[layer].verdict === 'VERIFIED');
    const valid = usefulWake && everyWakeInRun && Number.isFinite(lastWake) && inRun(idle.observedAt) && Date.parse(idle.observedAt) > lastWake
      && inRun(idle.quietStartedAt) && inRun(idle.quietFinishedAt)
      && Date.parse(idle.quietStartedAt) >= lastWake && Date.parse(idle.quietFinishedAt) <= Date.parse(idle.observedAt)
      && Date.parse(idle.quietFinishedAt) - Date.parse(idle.quietStartedAt) >= 90_000
      && finite(idle.freshQuietWindowMs) && idle.freshQuietWindowMs >= 90_000
      && idle.freshQuietWindowMs <= Date.parse(idle.quietFinishedAt) - Date.parse(idle.quietStartedAt) && idle.backgroundWork === 'none' && idle.ownedHold === true;
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
