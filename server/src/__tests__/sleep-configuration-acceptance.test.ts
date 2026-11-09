import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@paperclipai/db';
import { resolveExternalTestDatabaseUrl } from './helpers/external-test-database.js';
import { configuredSleepFeatures, finalizeLocalSleepReceipt, observeConfiguredSignals, observeIncomingHttpWindow, observedNoIncomingHttp, sleepConfigurationDigest } from '../../../scripts/sleep-qualification/evidence.mjs';
import { idleBackupArchiveNames, observeIdleBackupCheckpoint } from './helpers/maintenance/backup-observation.js';
import { stabilizeEarlyDiagnostics } from './helpers/maintenance/early-diagnostic-stabilization.js';
import { createMaintenanceS3Boundary } from './helpers/maintenance/s3-boundary.js';
import { managedSleepConfiguration, managedSleepServerOptions, provisionManagedSleepCompany } from './helpers/maintenance/managed-profile.js';
import { prepareMaintenanceRuntime } from './helpers/maintenance/runtime-build.js';
import { produceCompletedToolReview } from './helpers/maintenance/configuration-producers.js';
import { observeMaintenanceBrowser } from './helpers/maintenance/browser-observation.js';
import { startMaintenanceServer, withMaintenanceProvider } from './helpers/maintenance/server-harness.js';
import { CLOUD_CONTROL_AUDIENCE, CLOUD_CONTROL_HEADER, CLOUD_CONTROL_JWS_TYPE, CLOUD_RUNTIME_IDENTITY_ISSUER } from '../services/cloud-runtime-identity.js';

const databaseUrl = resolveExternalTestDatabaseUrl('PAPERCLIP_SLEEP_ACCEPTANCE_TEST_DATABASE_URL');
if (process.env.PAPERCLIP_SLEEP_CONFIGURED_ACCEPTANCE === '1' && !databaseUrl) throw new Error('Configured acceptance requires an explicit dedicated PAPERCLIP_SLEEP_ACCEPTANCE_TEST_DATABASE_URL; embedded allocation is forbidden');
const cloudSha = process.env.PAPERCLIP_SLEEP_CLOUD_SHA;
if (process.env.PAPERCLIP_SLEEP_CONFIGURED_ACCEPTANCE === '1' && !/^[a-f0-9]{40}$/.test(cloudSha ?? '')) throw new Error('Configured acceptance requires the exact PAPERCLIP_SLEEP_CLOUD_SHA');
const cloudCheckout = process.env.PAPERCLIP_SLEEP_CLOUD_CHECKOUT;
if (process.env.PAPERCLIP_SLEEP_CONFIGURED_ACCEPTANCE === '1' && !cloudCheckout) throw new Error('Configured acceptance requires a reviewed PAPERCLIP_SLEEP_CLOUD_CHECKOUT with its built qualification broker adapter');
const enabled = process.env.PAPERCLIP_SLEEP_CONFIGURED_ACCEPTANCE === '1' && Boolean(databaseUrl);
const quietMs = 90_000, apiCooldownMs = 600_000;
if (enabled && process.env.PAPERCLIP_MAINTENANCE_KEEP_ARTIFACTS !== '1') throw new Error('Configured qualification requires retained raw evidence');

describe.skipIf(!enabled)('configured assembled sleep qualification (explicit owned external PostgreSQL only)', () => {
  beforeAll(async () => { await prepareMaintenanceRuntime(); }, 210_000);
  it('retains normal credentials, completed work and a future routine through a real cooldown and quiet window', async () => {
    const phase = (name: string) => console.info(JSON.stringify({ qualificationPhase: name, at: new Date().toISOString() }));
    phase('starting-owned-fixtures');
    const collectorRequests: Array<{ path: string; body: unknown }> = [];
    const collector = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      collectorRequests.push({ path: req.url!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      res.setHeader('Content-Type', 'application/json'); res.end('{}');
    });
    if (execFileSync('git', ['-C', cloudCheckout!, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== cloudSha) throw new Error('Qualification Cloud checkout does not match the exact requested SHA');
    const { startQualificationBroker } = await import(pathToFileURL(path.join(cloudCheckout!, 'scripts/sleep-qualification-broker.mjs')).href);
    const broker = await startQualificationBroker();
    const s3 = createMaintenanceS3Boundary();
    try {
    await withMaintenanceProvider(s3.server, async s3Origin => {
    await withMaintenanceProvider(collector, async origin => {
      const pair = generateKeyPairSync('ed25519');
      const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'sleep-qualification', alg: 'EdDSA', use: 'sig' };
      const configuration = managedSleepConfiguration(origin, process.env.PAPERCLIP_SLEEP_BROWSER_ACCEPTANCE === '1');
      // Independent intended logical contract; collector ports are observed separately.
      const expected = { target: 'owned-local-assembled', appSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), cloudSha: cloudSha!,
        configDigest: createHash('sha256').update(JSON.stringify({ automaticBackups: { intervalMinutes: 60, idleCheckpoint: true }, announcements: true,
          telemetry: true, otel: { enabled: true, protocol: 'http/json' }, serveUi: process.env.PAPERCLIP_SLEEP_BROWSER_ACCEPTANCE === '1',
          managedInstance: true, deploymentMode: 'authenticated', storageProvider: 's3' })).digest('hex'),
        collectorOrigins: { telemetry: `${origin}/telemetry`, otel: origin } };
      expect(sleepConfigurationDigest(configuration)).toBe(expected.configDigest);
      const startedAt = new Date().toISOString();
      const server = await startMaintenanceServer(databaseUrl!, managedSleepServerOptions(configuration, JSON.stringify({ keys: [jwk] }), s3Origin, broker));
      phase('actual-server-ready');
      let fixture = createDb(databaseUrl!, { maxConnections: 1 });
      const control = (action: string, idleCapabilities?: unknown) => {
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const now = Math.floor(Date.now() / 1000);
        const header = encode({ alg: 'EdDSA', typ: CLOUD_CONTROL_JWS_TYPE, kid: jwk.kid });
        const payload = encode({ v: 1, iss: CLOUD_RUNTIME_IDENTITY_ISSUER, aud: CLOUD_CONTROL_AUDIENCE, sub: 'maintenance-stack', action, requestId: randomUUID(), iat: now, exp: now + 60, ...(idleCapabilities ? { idleCapabilities } : {}) });
        return { [CLOUD_CONTROL_HEADER]: `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`, 'ascii'), pair.privateKey).toString('base64url')}` };
      };
      let failure: { error: unknown } | undefined;
      try {
        await writeFile(path.join(server.directory, 'sleep-managed-startup.json'), JSON.stringify(await server.snapshot(), null, 2));
        const company = await provisionManagedSleepCompany(server, fixture);
        expect(await server.api('GET', '/announcements/current')).toMatchObject({ id: 'new-projects' });
        const announcement = (await server.snapshot()).announcement;
        expect(announcement?.intercepted).toBe(true);
        expect(announcement?.requests).toEqual(['https://pages.paperclip.ing/announcements/v1/current.json']);
        expect(announcement?.unmatched).toEqual([]);
        const agent = await server.api<{ id: string }>('POST', `/companies/${company.id}/agents`, { name: 'Owned process worker', role: 'general', adapterType: 'process',
          adapterConfig: { command: process.execPath, args: ['-e', "console.log('sleep-acceptance-useful-work')"], cwd: server.directory }, runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: true } } });
        const chatHistory = await server.produceChatHistory();
        const toolHistory = await produceCompletedToolReview(server, fixture, company.id);
        const github = await server.prepareGitHub(company.id);
        await server.api('PATCH', `/tool-connections/${github.connectionId}`, { enabled: true });
        const githubContinuity = await server.settleGitHub(github);
        await expect.poll(async () => (await broker.binding())?.bindings.length, { timeout: 30_000 }).toBe(1);
        await broker.enqueue();
        await broker.deliver(`http://127.0.0.1:${server.port}`, () => control('connector-events:wake')[CLOUD_CONTROL_HEADER]);
        // The normally enabled connection owner leases and acknowledges the real sealed event.
        await expect.poll(async () => {
          const [delivery] = await fixture.$client`select status from connection_event_deliveries where provider_delivery_id='qualification-delivery'`;
          return delivery?.status;
        }, { timeout: 30_000 }).toBe('processed');
        expect(await broker.pending()).toEqual([]);
        const brokerBinding = await broker.binding();
        expect(brokerBinding?.bindings).toHaveLength(1);
        const key = await server.api<{ id: string; token: string }>('POST', `/agents/${agent.id}/keys`, { name: 'Retained qualification credential' });
        const issue = await server.api<{ id: string }>('POST', `/companies/${company.id}/issues`, { title: 'Owned completed history', status: 'todo', assigneeAgentId: agent.id });
        await expect.poll(async () => {
          const [run] = await fixture.$client`select status from heartbeat_runs where issue_id=${issue.id} order by created_at desc limit 1`;
          return run?.status;
        }, { timeout: 30_000 }).toBe('succeeded');
        await server.api('PATCH', `/issues/${issue.id}`, { status: 'done' });
        const routine = await server.api<{ id: string }>('POST', `/companies/${company.id}/routines`, { title: 'Harmless future obligation', assigneeAgentId: agent.id });
        await server.api('POST', `/routines/${routine.id}/triggers`, { kind: 'schedule', cronExpression: (() => { const next = new Date(Date.now() + 24 * 60 * 60_000); return `0 ${next.getUTCHours()} ${next.getUTCDate()} ${next.getUTCMonth() + 1} *`; })(), timezone: 'UTC' });
        await server.api('GET', '/agents/me', undefined, { Authorization: `Bearer ${key.token}` });
        const lastAuthenticatedApiAt = performance.now();
        await writeFile(path.join(server.directory, 'sleep-setup-receipt.json'), JSON.stringify({ ...expected, configuration, company,
          agentId: agent.id, keyId: key.id, announcement, chatHistory, toolHistory, githubContinuity, brokerBinding,
          brokerBoundary: broker.boundary, s3: s3.snapshot(), snapshot: await server.snapshot(),
          boundary: 'Actual managed startup/tenant provisioning/producers; Cloud front door, GitHub HTTP and S3 service are owned simulated transports' }, null, 2));
        expect(s3.snapshot().errors).toEqual([]);
        let browser;
        try {
          browser = process.env.PAPERCLIP_SLEEP_BROWSER_ACCEPTANCE === '1' ? await observeMaintenanceBrowser(`http://127.0.0.1:${server.port}`, 'Organize your work.', server.tenantHeaders) : undefined;
          await writeFile(path.join(server.directory, 'sleep-browser-receipt.json'), JSON.stringify({ browser, observedAt: new Date().toISOString() }, null, 2));
        } catch (error) {
          await writeFile(path.join(server.directory, 'sleep-browser-error.json'), JSON.stringify({ observedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }, null, 2));
          throw error;
        }
        // Setup-only owner settling never substitutes for the later full quiet window.
        await server.settled(500, 0, { managedSetupRecovery: true });
        const earlyDrain = await server.api<{ ownerId: string }>('POST', '/instance/task-drain', { purpose: 'idle', ttlMs: 240_000 }, control('task-drain:start'));
        try {
          const earlyCapabilities = { incomingWake: await broker.capability(earlyDrain.ownerId), deadlineCatalog: 'domain_deadlines_v1' };
          const earlyRead = () => server.api<any>('GET', `/instance/task-drain?idleSleepSafety=1&idleSleepDiagnostics=1&scheduledWake=domain-deadlines-v1&ownerId=${earlyDrain.ownerId}`, undefined, control('task-drain:read', earlyCapabilities));
          const early = await stabilizeEarlyDiagnostics(server, { ownerId: earlyDrain.ownerId, apiSucceededAt: lastAuthenticatedApiAt, read: earlyRead,
            persist: observations => writeFile(path.join(server.directory, 'sleep-early-diagnostic-attempts.json'), JSON.stringify(observations, null, 2)) });
          await writeFile(path.join(server.directory, 'sleep-early-diagnostics.json'), JSON.stringify(early, null, 2));
        } finally { await server.api('DELETE', `/instance/task-drain?ownerId=${earlyDrain.ownerId}`, undefined, control('task-drain:stop')); }
        // Anchor the full cooldown to a genuine successful opaque-key request.
        await server.api('GET', '/agents/me', undefined, { Authorization: `Bearer ${key.token}` });
        const lastApiActivity = performance.now();
        await fixture.$client.end({ timeout: 1 });
        await server.trace();
        phase('first-real-ten-minute-api-cooldown');
        // The real authenticated-use cooldown is part of ordinary behavior.
        // No fake clock, production timing override, tenant health poll or SQL observer.
        await delay(apiCooldownMs + 100);
        await server.settled();
        const activeSignals = observeConfiguredSignals(collectorRequests);
        expect(activeSignals.qualificationSpans).toBeGreaterThan(0);
        expect(activeSignals.telemetryRequests).toBeGreaterThan(0);
        const before = await server.snapshot(), queries = server.proxy.queries.length, transport = server.proxy.transport;
        const wallStart = performance.now(), quietStartedAt = new Date().toISOString();
        phase('first-real-ninety-second-quiet-window');
        await delay(quietMs);
        const elapsedMs = performance.now() - wallStart, quietFinishedAt = new Date().toISOString();
        const after = await server.snapshot(), finalTransport = server.proxy.transport;
        const quiet = { startedAt: quietStartedAt, finishedAt: quietFinishedAt, elapsedMs, clock: 'real',
          sqlQueries: server.proxy.queries.length - queries,
          connectionsOpened: finalTransport.connectionsOpened - transport.connectionsOpened,
          connectionsRemaining: finalTransport.connectionsOpened - finalTransport.connectionsClosed,
          nonDatabaseRequests: after.outgoingHttpRequests - before.outgoingHttpRequests,
          nonDatabaseBytes: after.network.nonDatabaseBytesWritten - before.network.nonDatabaseBytesWritten,
          observerRequests: observeIncomingHttpWindow(before.incomingHttp, after.incomingHttp) };
        await writeFile(path.join(server.directory, 'sleep-first-frozen-quiet.json'), JSON.stringify({ quiet, announcementBefore: before.announcement, announcementAfter: after.announcement }, null, 2));
        const signalObservation = observeConfiguredSignals(collectorRequests);
        await writeFile(path.join(server.directory, 'sleep-first-signal-observation.json'), JSON.stringify(signalObservation, null, 2));
        expect(signalObservation.qualificationSpans).toBeGreaterThan(0);
        expect(signalObservation.telemetryRequests).toBeGreaterThan(0);
        expect(signalObservation.metricRequests).toBe(0); expect(signalObservation.logRequests).toBe(0);
        expect(signalObservation.malformedTraceRequests).toBe(0); expect(signalObservation.unexpectedRequests).toBe(0);
        expect(quiet.elapsedMs).toBeGreaterThanOrEqual(quietMs);
        expect(quiet.sqlQueries).toBe(0);
        expect(quiet.connectionsOpened).toBe(0);
        expect(quiet.connectionsRemaining).toBe(0);
        expect(quiet.nonDatabaseRequests).toBe(0);
        expect(quiet.nonDatabaseBytes).toBe(0);
        // The installed listener must have observed the actual setup HTTP traffic.
        expect(quiet.observerRequests.before.requests).toBeGreaterThan(0);
        expect(observedNoIncomingHttp(quiet.observerRequests, quiet)).toBe(true);
        expect(after.announcement).toEqual(before.announcement);
        const backupNamesBefore = await idleBackupArchiveNames(server.directory);
        const checkpointStartedAt = new Date().toISOString();
        const drain = await server.api<{ ownerId: string }>('POST', '/instance/task-drain', { purpose: 'idle', ttlMs: 240_000 }, control('task-drain:start'));
        const capabilities = { incomingWake: await broker.capability(drain.ownerId), deadlineCatalog: 'domain_deadlines_v1' };
        const read = () => server.api<any>('GET', `/instance/task-drain?idleSleepSafety=1&scheduledWake=domain-deadlines-v1&ownerId=${drain.ownerId}`, undefined, control('task-drain:read', capabilities));
        const initial = await read();
        await writeFile(path.join(server.directory, 'sleep-initial-safety.json'), JSON.stringify(initial, null, 2));
        const final = await read();
        phase('first-owned-eligibility-reports-read');
        // Persist raw refusal evidence before any assertion can terminate the case.
        await writeFile(path.join(server.directory, 'sleep-initial-final-safety.json'), JSON.stringify({ initial, final }, null, 2));
        if (initial.idleSleepSafety.backgroundWork !== 'none' || final.idleSleepSafety.backgroundWork !== 'none') {
          const diagnostic = await server.api<any>('GET', `/instance/task-drain?idleSleepSafety=1&idleSleepDiagnostics=1&scheduledWake=domain-deadlines-v1&ownerId=${drain.ownerId}`, undefined, control('task-drain:read', capabilities));
          await writeFile(path.join(server.directory, 'sleep-refusal-diagnostics.json'), JSON.stringify(diagnostic, null, 2));
        }
        const { parseApiWakeAdmission, authorizeApiWakeAdmission } = await import('../services/idle-api-wake-admission.js');
        const assertIncomingProof = (report: any, incomingWake: any, ownerId: string) => {
          expect(report.idleSleepSafety.incomingWake).toEqual(incomingWake);
          const admission = parseApiWakeAdmission(report.idleSleepSafety.apiWakeAdmission);
          expect(admission).toMatchObject({ stackId: 'maintenance-stack', ownerId,
            capabilityGeneration: incomingWake.generation, challenge: incomingWake.apiKeyProof.challenge });
          expect(authorizeApiWakeAdmission(admission, { stackId: 'maintenance-stack', token: key.token, now: Date.now() })).toBeDefined();
        };
        assertIncomingProof(initial, capabilities.incomingWake, drain.ownerId);
        assertIncomingProof(final, capabilities.incomingWake, drain.ownerId);
        expect(final.idleSleepSafety.apiWakeAdmission).toEqual(initial.idleSleepSafety.apiWakeAdmission);
        const proof = final.idleSleepSafety;
        const backupCheckpoint = await observeIdleBackupCheckpoint(server.directory, backupNamesBefore, checkpointStartedAt, company.id);
        const observations = { version: 1, ...expected, startedAt,
          configuration, browser, s3: s3.snapshot(), announcement: after.announcement, chatHistory, toolHistory, githubContinuity, brokerBinding, brokerBoundary: broker.boundary, backupCheckpoint,
          signalObservation, features: configuredSleepFeatures({ announcement: after.announcement, signalObservation, backupCheckpoint }),
          quiet,
          eligibility: { observedAt: new Date().toISOString(), backgroundWork: proof.backgroundWork, ownedHold: final.ownerId === drain.ownerId, apiCooldownElapsedMs: performance.now() - lastApiActivity,
            unchangedGeneration: /^[a-f0-9]{64}$/.test(proof.deadlineProof?.generation ?? '') && initial.idleSleepSafety.deadlineProof?.generation === proof.deadlineProof?.generation }, initial, final,
          live: { databaseSuspension: 'INCONCLUSIVE', hostSuspension: 'INCONCLUSIVE', backupPersistence: 'INCONCLUSIVE', reason: 'Local actual server with simulated Cloud signer; no deployed provider target authorized' },
          coverage: { announcements: 'Actual route, validated feed/cache and UI with one named injected provider transport fetch; DNS/HTTPS guard covered separately, not exercised here.', browser: browser ? 'Actual Chromium foreground/background measured, then closed before server quiet window' : 'Closed; set PAPERCLIP_SLEEP_BROWSER_ACCEPTANCE=1 with built UI and headed Chromium for background/active evidence', broker: 'Retained enabled connection, actual encrypted OAuth vault, actual continuity/binding owners and signed/sealed production broker delivery; host capability from actual ConnectorStore', history: 'Normal task/credential/routine, actual tool review rejection/outbox retirement, actual signed chat ingress completion and endpoint archival' } };
        await writeFile(path.join(server.directory, 'sleep-configuration-observations.json'), JSON.stringify(observations, null, 2));
        const { receipt, report } = finalizeLocalSleepReceipt(observations, expected);
        await writeFile(path.join(server.directory, 'sleep-configuration-receipt.json'), JSON.stringify(receipt, null, 2));
        await writeFile(path.join(server.directory, 'sleep-configuration-evaluation.json'), JSON.stringify(report, null, 2));
        expect(proof.version).toBe(3); expect(proof.backgroundWork).toBe('none');
        expect(proof.deadlineProof).toMatchObject({ catalog: 'domain_deadlines_v1', generation: expect.stringMatching(/^[a-f0-9]{64}$/) });
        fixture = createDb(databaseUrl!, { maxConnections: 1 });
        const [retained] = await fixture.$client`select (select count(*)::int from agent_api_keys where id=${key.id}) as keys, (select count(*)::int from issues where id=${issue.id}) as issues, (select count(*)::int from routines where id=${routine.id}) as routines, (select enabled from tool_connections where id=${github.connectionId}) as github_enabled`;
        expect(retained).toEqual({ keys: 1, issues: 1, routines: 1, github_enabled: true });
        await server.api('DELETE', `/instance/task-drain?ownerId=${drain.ownerId}`, undefined, control('task-drain:stop'));
        const nextIssue = await server.api<{ id: string }>('POST', `/companies/${company.id}/issues`, { title: 'First ordinary producer after quiet', status: 'todo', assigneeAgentId: agent.id }, { Authorization: `Bearer ${key.token}` });
        const reactivationApiAt = performance.now();
        await expect.poll(async () => {
          const [run] = await fixture.$client`select status from heartbeat_runs where issue_id=${nextIssue.id} order by created_at desc limit 1`;
          return run?.status;
        }, { timeout: 30_000 }).toBe('succeeded');
        await server.api('PATCH', `/issues/${nextIssue.id}`, { status: 'done' });
        const [executions] = await fixture.$client`select count(*)::int as count from heartbeat_runs where issue_id=${nextIssue.id}`;
        expect(executions.count).toBe(1);
        await fixture.$client.end({ timeout: 1 });
        phase('reactivation-real-ten-minute-api-cooldown');
        await delay(apiCooldownMs + 100);
        await server.settled();
        const resumed = await server.snapshot(), resumedQueries = server.proxy.queries.length, resumedTransport = server.proxy.transport;
        const resumedStart = performance.now(), resumedStartedAt = new Date().toISOString();
        phase('reactivation-real-ninety-second-quiet-window');
        await delay(quietMs);
        const resumedElapsedMs = performance.now() - resumedStart, resumedFinishedAt = new Date().toISOString();
        const resumedEnd = await server.snapshot(), resumedFinalTransport = server.proxy.transport;
        // Freeze every measurement before signed drain/proof requests do SQL.
        const resumedQuiet = { startedAt: resumedStartedAt, finishedAt: resumedFinishedAt, elapsedMs: resumedElapsedMs, clock: 'real',
          sqlQueries: server.proxy.queries.length - resumedQueries,
          connectionsOpened: resumedFinalTransport.connectionsOpened - resumedTransport.connectionsOpened,
          connectionsRemaining: resumedFinalTransport.connectionsOpened - resumedFinalTransport.connectionsClosed,
          nonDatabaseRequests: resumedEnd.outgoingHttpRequests - resumed.outgoingHttpRequests,
          nonDatabaseBytes: resumedEnd.network.nonDatabaseBytesWritten - resumed.network.nonDatabaseBytesWritten,
          observerRequests: observeIncomingHttpWindow(resumed.incomingHttp, resumedEnd.incomingHttp) };
        await writeFile(path.join(server.directory, 'sleep-resumed-frozen-quiet.json'), JSON.stringify({ quiet: resumedQuiet, announcementBefore: resumed.announcement, announcementAfter: resumedEnd.announcement }, null, 2));
        const resumedSignals = observeConfiguredSignals(collectorRequests);
        await writeFile(path.join(server.directory, 'sleep-resumed-signal-observation.json'), JSON.stringify(resumedSignals, null, 2));
        expect(resumedSignals.qualificationSpans).toBeGreaterThan(0);
        expect(resumedSignals.telemetryRequests).toBeGreaterThan(0);
        expect(resumedSignals.metricRequests).toBe(0); expect(resumedSignals.logRequests).toBe(0);
        expect(resumedSignals.malformedTraceRequests).toBe(0); expect(resumedSignals.unexpectedRequests).toBe(0);
        expect(resumedQuiet.elapsedMs).toBeGreaterThanOrEqual(quietMs);
        expect(resumedQuiet.sqlQueries).toBe(0);
        expect(resumedQuiet.connectionsOpened).toBe(0);
        expect(resumedQuiet.connectionsRemaining).toBe(0);
        expect(resumedQuiet.nonDatabaseRequests).toBe(0);
        expect(resumedQuiet.nonDatabaseBytes).toBe(0);
        expect(resumedQuiet.observerRequests.before.requests).toBeGreaterThan(0);
        expect(observedNoIncomingHttp(resumedQuiet.observerRequests, resumedQuiet)).toBe(true);
        expect(resumedEnd.announcement).toEqual(resumed.announcement);
        expect(resumedEnd.announcement?.unmatched).toEqual([]);
        const resumedDrain = await server.api<{ ownerId: string }>('POST', '/instance/task-drain', { purpose: 'idle', ttlMs: 240_000 }, control('task-drain:start'));
        const resumedCapabilities = { incomingWake: await broker.capability(resumedDrain.ownerId), deadlineCatalog: 'domain_deadlines_v1' };
        const readResumed = () => server.api<any>('GET', `/instance/task-drain?idleSleepSafety=1&scheduledWake=domain-deadlines-v1&ownerId=${resumedDrain.ownerId}`, undefined, control('task-drain:read', resumedCapabilities));
        const resumedInitial = await readResumed();
        await writeFile(path.join(server.directory, 'sleep-resumed-initial-safety.json'), JSON.stringify(resumedInitial, null, 2));
        const resumedProof = await readResumed();
        await writeFile(path.join(server.directory, 'sleep-resumed-initial-final-safety.json'), JSON.stringify({ initial: resumedInitial, final: resumedProof }, null, 2));
        if (resumedInitial.idleSleepSafety.backgroundWork !== 'none' || resumedProof.idleSleepSafety.backgroundWork !== 'none') {
          const diagnostic = await server.api<any>('GET', `/instance/task-drain?idleSleepSafety=1&idleSleepDiagnostics=1&scheduledWake=domain-deadlines-v1&ownerId=${resumedDrain.ownerId}`, undefined, control('task-drain:read', resumedCapabilities));
          await writeFile(path.join(server.directory, 'sleep-resumed-refusal-diagnostics.json'), JSON.stringify(diagnostic, null, 2));
        }
        assertIncomingProof(resumedInitial, resumedCapabilities.incomingWake, resumedDrain.ownerId);
        assertIncomingProof(resumedProof, resumedCapabilities.incomingWake, resumedDrain.ownerId);
        expect(resumedProof.idleSleepSafety.apiWakeAdmission).toEqual(resumedInitial.idleSleepSafety.apiWakeAdmission);
        expect(resumedProof.idleSleepSafety.deadlineProof?.generation).toMatch(/^[a-f0-9]{64}$/);
        expect(resumedProof.idleSleepSafety.deadlineProof?.generation).toBe(resumedInitial.idleSleepSafety.deadlineProof?.generation);
        expect(resumedProof.idleSleepSafety.backgroundWork).toBe('none');
        await writeFile(path.join(server.directory, 'sleep-local-reactivation-receipt.json'), JSON.stringify({
          version: 1, actualProducer: 'POST company issues with process assignee using the retained opaque key after owned drain release', executions: executions.count,
          realApiCooldownElapsedMs: performance.now() - reactivationApiAt,
          quiet: resumedQuiet,
          signalObservation: resumedSignals,
          realElapsedMs: resumedQuiet.elapsedMs, sqlQueries: resumedQuiet.sqlQueries,
          networkRequests: resumedQuiet.nonDatabaseRequests,
          initial: resumedInitial,
          eligibility: resumedProof.idleSleepSafety,
          boundary: 'Actual local application reactivation, real cooldown and fresh eligibility; no provider suspension or deployed inbound-wake claim',
        }, null, 2));
        const s3Evidence = s3.snapshot();
        await writeFile(path.join(server.directory, 'sleep-s3-boundary.json'), JSON.stringify(s3Evidence, null, 2));
        expect(s3Evidence.errors).toEqual([]);
        phase('configured-qualification-receipts-complete');
      } catch (error) { failure = { error }; throw error; }
      finally {
        const errors: unknown[] = [];
        try { await writeFile(path.join(server.directory, 'sleep-s3-before-cleanup.json'), JSON.stringify(s3.snapshot(), null, 2)); } catch (error) { errors.push(error); }
        try { await server.stop(); } catch (error) { errors.push(error); }
        try { await fixture.$client.end(); } catch (error) { errors.push(error); }
        // Shutdown can flush storage; capture and validate only after child exit.
        try { await writeFile(path.join(server.directory, 'sleep-s3-after-cleanup.json'), JSON.stringify(s3.snapshot(), null, 2)); } catch (error) { errors.push(error); }
        if (s3.snapshot().errors.length) errors.push(new Error(`S3 fixture boundary failed: ${JSON.stringify(s3.snapshot().errors)}`));
        if (errors.length) throw new AggregateError([...(failure ? [failure.error] : []), ...errors], 'Configured work or owned cleanup failed');
      }
    });
    });
    } finally { await broker.stop(); }
  }, 1_800_000);
});
