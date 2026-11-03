import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@paperclipai/db';
import { resolveExternalTestDatabaseUrl } from './helpers/external-test-database.js';
import { prepareMaintenanceRuntime } from './helpers/maintenance/runtime-build.js';
import { startMaintenanceServer, withMaintenanceProvider } from './helpers/maintenance/server-harness.js';
import { managedSleepConfiguration, managedSleepServerOptions, managedTenantActor, provisionManagedSleepCompany } from './helpers/maintenance/managed-profile.js';
import { createMaintenanceS3Boundary } from './helpers/maintenance/s3-boundary.js';
import { stabilizeEarlyDiagnostics } from './helpers/maintenance/early-diagnostic-stabilization.js';
import { CLOUD_CONTROL_AUDIENCE, CLOUD_CONTROL_HEADER, CLOUD_CONTROL_JWS_TYPE, CLOUD_RUNTIME_IDENTITY_ISSUER } from '../services/cloud-runtime-identity.js';

const requested = process.env.PAPERCLIP_SLEEP_MANAGED_PREFLIGHT === '1';
const databaseUrl = resolveExternalTestDatabaseUrl('PAPERCLIP_SLEEP_MANAGED_PREFLIGHT_TEST_DATABASE_URL');
if (requested && !databaseUrl) throw new Error('Managed preflight requires an explicit dedicated external *_test URL; no embedded allocation');
if (requested && process.env.PAPERCLIP_MAINTENANCE_KEEP_ARTIFACTS !== '1') throw new Error('Managed preflight requires retained raw evidence');
const cloudCheckout = process.env.PAPERCLIP_SLEEP_CLOUD_CHECKOUT, cloudSha = process.env.PAPERCLIP_SLEEP_CLOUD_SHA;
if (requested && (!cloudCheckout || !/^[a-f0-9]{40}$/.test(cloudSha ?? ''))) throw new Error('Managed preflight requires the exact reviewed private Cloud checkout/SHA');

describe.skipIf(!requested)('actual managed fixture preflight (no browser, cooldown or quiet claim)', () => {
  beforeAll(async () => { await prepareMaintenanceRuntime(); }, 210_000);
  it('provisions through real managed auth and completes a process run before strict activity diagnostics', async () => {
    if (execFileSync('git', ['-C', cloudCheckout!, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== cloudSha) throw new Error('Cloud source does not match the reviewed preflight SHA');
    const { startQualificationBroker } = await import(pathToFileURL(path.join(cloudCheckout!, 'scripts/sleep-qualification-broker.mjs')).href);
    const broker = await startQualificationBroker(); const s3 = createMaintenanceS3Boundary();
    const collectorRequests: string[] = [];
    const collector = createServer(async (req, res) => { for await (const _chunk of req) { /* Fully consume actual exports. */ } collectorRequests.push(req.url!); res.setHeader('content-type', 'application/json'); res.end('{}'); });
    try {
      await withMaintenanceProvider(s3.server, async s3Origin => withMaintenanceProvider(collector, async origin => {
        const pair = generateKeyPairSync('ed25519');
        const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'managed-preflight', alg: 'EdDSA', use: 'sig' };
        const configuration = managedSleepConfiguration(origin, true);
        const server = await startMaintenanceServer(databaseUrl!, { ...managedSleepServerOptions(configuration, JSON.stringify({ keys: [jwk] }), s3Origin, broker),
          captureIdleWork: process.env.PAPERCLIP_SLEEP_MANAGED_PREFLIGHT_DIAGNOSTICS === '1' });
        const fixture = createDb(databaseUrl!, { maxConnections: 1 });
        const control = (action: string, idleCapabilities?: unknown) => {
          const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url'), now = Math.floor(Date.now() / 1000);
          const header = encode({ alg: 'EdDSA', typ: CLOUD_CONTROL_JWS_TYPE, kid: jwk.kid });
          const payload = encode({ v: 1, iss: CLOUD_RUNTIME_IDENTITY_ISSUER, aud: CLOUD_CONTROL_AUDIENCE, sub: 'maintenance-stack', action, requestId: randomUUID(), iat: now, exp: now + 60, ...(idleCapabilities ? { idleCapabilities } : {}) });
          return { [CLOUD_CONTROL_HEADER]: `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`, 'ascii'), pair.privateKey).toString('base64url')}` };
        };
        let failure: { error: unknown } | undefined;
        try {
          await writeFile(path.join(server.directory, 'managed-preflight-startup.json'), JSON.stringify({ configuration, snapshot: await server.snapshot(), s3: s3.snapshot() }, null, 2));
          expect(s3.snapshot().errors).toEqual([]);
          const company = await provisionManagedSleepCompany(server, fixture);
          await expect(server.api('POST', '/companies', { name: 'Must remain platform managed' })).rejects.toThrow('cloud_managed');
          // Reuse the combined case's real vault/continuity/enrollment owners.
          // The strict broker capability is unavailable before event-wake enrollment.
          const github = await server.prepareGitHub(company.id);
          await server.api('PATCH', `/tool-connections/${github.connectionId}`, { enabled: true });
          const githubContinuity = await server.settleGitHub(github);
          await writeFile(path.join(server.directory, 'managed-preflight-binding.json'), JSON.stringify({ githubContinuity, brokerBinding: await broker.binding(), boundary: broker.boundary }, null, 2));
          await expect.poll(async () => (await broker.binding())?.bindings.length, { timeout: 30_000 }).toBe(1);
          const brokerBinding = await broker.binding();
          await writeFile(path.join(server.directory, 'managed-preflight-binding.json'), JSON.stringify({ githubContinuity, brokerBinding, boundary: broker.boundary }, null, 2));
          expect(brokerBinding?.instanceId).toBe(broker.variables.PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID);
          expect(brokerBinding?.bindings).toEqual([[`${github.grantId}_101`, company.id, managedTenantActor.userId,
            'github.code', '101', github.connectionId, github.grantId]]);
          const agent = await server.api<{ id: string }>('POST', `/companies/${company.id}/agents`, { name: 'Managed preflight process', role: 'general', adapterType: 'process',
            adapterConfig: { command: process.execPath, args: ['-e', "console.log('managed-preflight-useful-work')"], cwd: server.directory }, runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: true } } });
          const key = await server.api<{ id: string; token: string }>('POST', `/agents/${agent.id}/keys`, { name: 'Actual managed preflight key' });
          const issue = await server.api<{ id: string }>('POST', `/companies/${company.id}/issues`, { title: 'One actual managed process run', status: 'todo', assigneeAgentId: agent.id }, { Authorization: `Bearer ${key.token}` });
          await expect.poll(async () => { const [run] = await fixture.$client`select status from heartbeat_runs where issue_id=${issue.id} order by created_at desc limit 1`; return run?.status; }, { timeout: 30_000 }).toBe('succeeded');
          await server.api('PATCH', `/issues/${issue.id}`, { status: 'done' });
          const [executions] = await fixture.$client`select count(*)::int as count from heartbeat_runs where issue_id=${issue.id}`; expect(executions.count).toBe(1);
          await server.api('GET', '/agents/me', undefined, { Authorization: `Bearer ${key.token}` }); const apiSucceededAt = performance.now();
          const activity = await server.snapshot();
          await writeFile(path.join(server.directory, 'managed-preflight-setup.json'), JSON.stringify({ company, githubContinuity, brokerBinding,
            agentId: agent.id, keyId: key.id, issueId: issue.id, executions: executions.count, activity, s3: s3.snapshot() }, null, 2));
          expect(activity.managed?.apiActivityActive).toBe(true);
          await server.settled(500, 0, { managedSetupRecovery: true });
          const drain = await server.api<{ ownerId: string }>('POST', '/instance/task-drain', { purpose: 'idle', ttlMs: 240_000 }, control('task-drain:start'));
          try {
            const capabilities = { incomingWake: await broker.capability(drain.ownerId), deadlineCatalog: 'domain_deadlines_v1' };
            const read = () => server.api<any>('GET', `/instance/task-drain?idleSleepSafety=1&idleSleepDiagnostics=1&scheduledWake=domain-deadlines-v1&ownerId=${drain.ownerId}`, undefined, control('task-drain:read', capabilities));
            const proof = await stabilizeEarlyDiagnostics(server, { ownerId: drain.ownerId, apiSucceededAt, read,
              persist: observations => writeFile(path.join(server.directory, 'managed-preflight-diagnostic-attempts.json'), JSON.stringify(observations, null, 2)) });
            await writeFile(path.join(server.directory, 'managed-preflight-receipt.json'), JSON.stringify({ companyId: company.id, proof, s3: s3.snapshot(), collectorRequests,
              boundary: 'Actual managed startup/provisioning/key activity/process outcome; no browser, real cooldown/quiet, eligibility, provider suspension or durable S3 claim' }, null, 2));
          } finally { await server.api('DELETE', `/instance/task-drain?ownerId=${drain.ownerId}`, undefined, control('task-drain:stop')); }
        } catch (error) { failure = { error }; throw error; }
        finally {
          const errors: unknown[] = [];
          try { await writeFile(path.join(server.directory, 'managed-preflight-s3-before-cleanup.json'), JSON.stringify(s3.snapshot(), null, 2)); } catch (error) { errors.push(error); }
          try { await server.stop(); } catch (error) { errors.push(error); }
          try { await fixture.$client.end({ timeout: 1 }); } catch (error) { errors.push(error); }
          try { await writeFile(path.join(server.directory, 'managed-preflight-s3-after-cleanup.json'), JSON.stringify(s3.snapshot(), null, 2)); } catch (error) { errors.push(error); }
          if (s3.snapshot().errors.length) errors.push(new Error(`S3 fixture boundary failed: ${JSON.stringify(s3.snapshot().errors)}`));
          if (errors.length) throw new AggregateError([...(failure ? [failure.error] : []), ...errors], 'Managed preflight or owned cleanup failed');
        }
      }));
    } finally { await broker.stop(); }
  }, 180_000);
});
