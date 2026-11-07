import { defaultCadenceNetwork, installDefaultCadenceNetwork, allowDefaultCadenceOrigin } from './helpers/maintenance/default-cadence-network.js';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, chmod, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { applyPendingMigrations, createDb } from '@paperclipai/db';
import { resolveExternalTestDatabaseUrl } from './helpers/external-test-database.js';
import { startMaintenanceServer, withMaintenanceProvider, type MaintenanceRuntimeSecrets } from './helpers/maintenance/server-harness.js';
import { createMaintenanceS3Boundary } from './helpers/maintenance/s3-boundary.js';
import { provisionManagedSleepCompany, managedTenantActor } from './helpers/maintenance/managed-profile.js';
import { startDefaultCadenceBridge } from './helpers/maintenance/default-cadence-bridge.js';
import { prepareStatusInterval, prepareGitHubObject, statusObjectGitHubBoundary } from './helpers/maintenance/status-object-producers.js';

const enabled = process.env.PAPERCLIP_STATUS_OBJECT_SLEEP_ACCEPTANCE === '1';
const owner = process.env.PAPERCLIP_STATUS_OBJECT_SLEEP_OWNER;
const stage = process.env.PAPERCLIP_STATUS_OBJECT_SLEEP_STAGE;
const diagnostic = process.env.PAPERCLIP_STATUS_OBJECT_SLEEP_DIAGNOSTIC === '1';
const appUrl = resolveExternalTestDatabaseUrl('PAPERCLIP_SKILL_DEFAULT_CADENCE_TEST_DATABASE_URL');
const cloudUrl = resolveExternalTestDatabaseUrl('PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_TEST_DATABASE_URL');
const cloudCheckout = process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_CHECKOUT;
const cloudSha = process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_SHA;
const cloudNode = process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_NODE;
const evidence = process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_EVIDENCE;
if (enabled) {
  installDefaultCadenceNetwork();
  assert(owner === 'status' || owner === 'object'); assert(stage === 'bootstrap' || stage === 'cycle' || (stage === 'identity' && owner === 'status'));
  if (diagnostic) assert((owner === 'object' && stage === 'bootstrap') || (owner === 'status' && stage === 'identity'));
  assert(appUrl && cloudUrl && cloudCheckout && cloudNode && evidence && /^[a-f0-9]{40}$/.test(cloudSha ?? ''));
  assert.equal(process.env.PAPERCLIP_MAINTENANCE_KEEP_ARTIFACTS, '1');
}
type Observation = { id: string; next_at: Date; last_at: Date; value: string; version: string; claim: string | null; pending: number; policy: unknown; last_run_id: string | null; generation_issue_id: string | null; run_started_at: Date | null; run_status: string | null; generation_status: string | null };
type ObservedRow = Omit<Observation, 'last_at' | 'next_at' | 'run_started_at' | 'value'> & {
  last_at: Date | string | null; next_at: Date | string | null; run_started_at: Date | string | null; value: string | null;
};
function producedTimestamp(value: unknown, field: string): Date {
  assert(value instanceof Date || (typeof value === 'string' && value.trim().length > 0), `Invalid produced ${field}`);
  const parsed = value instanceof Date ? value : new Date(value);
  assert(Number.isFinite(parsed.getTime()), `Invalid produced ${field}`);
  return parsed;
}
type AgentReceipt = { event: string; at: number; pid: number; runId: string; guard: ReturnType<typeof defaultCadenceNetwork> };

describe.skipIf(!enabled)('status and external-object actual signed cold-owner handoff', () => {
  const runAcceptance = async (): Promise<void> => {
    assert(appUrl && cloudUrl && cloudCheckout && cloudNode && evidence);
    assert.equal(execFileSync('git', ['-C', cloudCheckout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), cloudSha);
    assert.match(execFileSync(cloudNode, ['--version'], { encoding: 'utf8' }), /^v22\./);
    await applyPendingMigrations(appUrl);
    const upstream = statusObjectGitHubBoundary(), s3 = createMaintenanceS3Boundary();
    const pair = generateKeyPairSync('ed25519');
    const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'signed-owner', alg: 'EdDSA', use: 'sig' };
    const privateJwk = JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: jwk.kid, alg: 'EdDSA', use: 'sig' });
    const jwks = JSON.stringify({ keys: [jwk] });
    const statePath = path.join(evidence, 'status-provider-state.json');
    const childPids: number[] = [];
    let boundaryAdvanced = false;
    const physical: Array<{ kind: string; at: number; pid?: number }> = [];
    let server: Awaited<ReturnType<typeof startMaintenanceServer>> | undefined;
    let bridge: Awaited<ReturnType<typeof startDefaultCadenceBridge>> | undefined;
    const phases: Array<{ name: string; at: number; queryCount?: number; pending?: number }> = [];
    const phase = (name: string) => {
      phases.push({ name, at: Date.now(), queryCount: server?.proxy.queries.length, pending: server?.proxy.pending });
    };
    let secretsDirectory: string | undefined;
    let primary: { error: unknown } | undefined;
    const failures: Array<{ stage: string; error: unknown }> = [];
    let status: Awaited<ReturnType<typeof prepareStatusInterval>> | undefined;
    const agentReceipts = async (): Promise<AgentReceipt[]> => {
      if (owner !== 'status') return [];
      try { return (await readFile(statePath + '.runs.jsonl', 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; }
    };
    const record = async (name: string, value: unknown) => writeFile(path.join(evidence, name + '.json'), JSON.stringify(value, null, 2));
    const proxyEvidence = () => server ? { queries: [...server.proxy.queries], frames: server.proxy.frames, transport: server.proxy.transport,
      pending: server.proxy.pending, starting: server.proxy.starting, errors: server.proxy.errors.map(error => error.stack ?? String(error)) } : undefined;
    try {
      secretsDirectory = await mkdtemp(path.join(tmpdir(), 'paperclip-owner-runtime-secrets-'));
      await chmod(secretsDirectory, 0o700);
      const secretsPath = path.join(secretsDirectory, 'runtime-secrets.json');
      const runtimeSecrets: MaintenanceRuntimeSecrets = {
        PAPERCLIP_AGENT_JWT_SECRET: randomUUID(), PAPERCLIP_DECISION_SIGNING_SECRET: randomUUID(),
        PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: randomUUID(), BETTER_AUTH_SECRET: randomUUID(),
        PAPERCLIP_SECRETS_MASTER_KEY: randomBytes(32).toString('hex'),
      };
      const retainRuntimeSecrets = async (value: MaintenanceRuntimeSecrets, label: string, exclusive = false) => {
        const bytes = JSON.stringify(value);
        await writeFile(secretsPath, bytes, { mode: 0o600, flag: exclusive ? 'wx' : 'w' });
        const mode = (await stat(secretsPath)).mode & 0o777;
        assert.equal(mode, 0o600);
        await record(label, { names: Object.keys(value).sort(), sha256: createHash('sha256').update(bytes).digest('hex'),
          changedNames: Object.keys(value).filter(key => value[key as keyof MaintenanceRuntimeSecrets] !== runtimeSecrets[key as keyof MaintenanceRuntimeSecrets]).sort(),
          fileMode: mode, directoryMode: (await stat(secretsDirectory!)).mode & 0o777, values: 'Not retained in evidence; private runtime file deleted after all owners stop' });
      };
      await retainRuntimeSecrets(runtimeSecrets, 'runtime-secret-profile', true);
      if (diagnostic) await record('diagnostic-mode', { instrumented: true, capture: 'Existing passive idle-work capture and timestamped proxy query metadata',
        initialPostproductionSettleDeadlineMs: 30_000, identityPostgenerationSettleDeadlineMs: 30_000, preproductionSetupObservationMs: 61_000, quietMs: 500,
        owner, stage, boundary: 'Diagnostic evidence only; normal product startup, work, promises and admission retained' });
      await withMaintenanceProvider(s3.server, s3Origin => withMaintenanceProvider(upstream.server, async githubOrigin => {
        const boot = async () => {
          const retainedSecrets = JSON.parse(await readFile(secretsPath, 'utf8')) as MaintenanceRuntimeSecrets;
          const started = await startMaintenanceServer(appUrl, {
            childEntry: new URL('./helpers/maintenance/status-object-child.ts', import.meta.url),
            childPreload: new URL('../../../scripts/fixtures/skill-default-cadence-network-guard.cjs', import.meta.url),
            databasePoolMax: 2, runtimeSecrets: retainedSecrets, artifactRoot: evidence, githubOrigin, clock: false, controlJwks: jwks, captureIdleWork: diagnostic,
            cloud: { jwks, s3Origin, standby: false }, tenantActor: managedTenantActor,
            configuration: { managedInstance: true, deploymentMode: 'authenticated', storageProvider: 's3', announcements: false,
              managedFeatures: owner === 'status' ? { enableStatusCards: true } : { enableExternalObjects: true } },
          });
          assert(started.pid); childPids.push(started.pid);
          try {
            expect(started.childGuard).toMatchObject({ loaded: true, pid: started.pid, ppid: process.pid, sourceHash: defaultCadenceNetwork().sourceHash });
            allowDefaultCadenceOrigin(`http://127.0.0.1:${started.port}`);
            if (status) await status.writeExpectedApiOrigin(started);
            return started;
          } catch (error) {
            try { await started.stop(); } catch (error) { failures.push({ stage: 'boot-origin-cleanup', error }); }
            throw error;
          }
        };
        try {
          server = await boot(); phase('app-ready');
          const setupDb = createDb(appUrl, { maxConnections: 1 });
          let company: Awaited<ReturnType<typeof provisionManagedSleepCompany>>;
          try { company = await provisionManagedSleepCompany(server, setupDb); }
          catch (error) { primary ??= { error }; throw error; }
          finally {
            try { await setupDb.$client.end({ timeout: 1 }); }
            catch (error) { if (primary) failures.push({ stage: 'setup-close', error }); else throw error; }
          }
          phase('normal-producer-entered');
          if (owner === 'status') status = await prepareStatusInterval(server, company.id, statePath);
          else {
            const object = await prepareGitHubObject(server, company.id);
            phase('object-plain-issue-created');
            const setupAgents = await server.api<unknown[]>('GET', `/companies/${company.id}/agents`);
            expect(setupAgents).toHaveLength(0);
            phase('object-setup-reconciliation-entered');
            const setup = await server.settled(500, 0, { managedSetupRecovery: true });
            expect(setup.startup.phase).toBe('ready'); expect(setup.idle.active).toBe(0);
            expect(upstream.requests).toHaveLength(0);
            phase('object-setup-reconciliation-returned');
            await record('object-preproduction-setup', { issueId: object.issueId, observationBudgetMs: 61_000, quietMs: 500,
              setup, agentCount: setupAgents.length, phases: [...phases], requests: [...upstream.requests], producer: 'Normal plain-issue POST then description-only URL PATCH after real setup reconciliation' });
            phase('object-reference-patch-entered');
            await object.addReference();
            phase('object-reference-patch-returned');
          }
          phase('normal-producer-returned');
          const readProduced = async (): Promise<Observation | undefined> => {
            const url = new URL(appUrl); url.searchParams.set('application_name', 'status-object-readonly-observer');
            const db = createDb(url.href, { maxConnections: 1 });
            let readFailure: { error: unknown } | undefined;
            try {
              const rows = await db.$client.begin('read only', tx => owner === 'status'
                ? tx<ObservedRow[]>`select c.id,c.next_eval_at as next_at,c.last_generated_at as last_at,d.latest_body as value,d.latest_revision_number::text as version,
                    c.generating_issue_id as claim,c.refresh_policy as policy,
                    (select count(*)::int from status_card_updates u where u.card_id=c.id and u.status='running') as pending,
                    u.run_id as last_run_id,u.generation_issue_id,r.started_at as run_started_at,r.status as run_status,gi.status as generation_status
                    from status_cards c join documents d on d.id=c.document_id and d.company_id=c.company_id
                    left join lateral (select run_id,generation_issue_id from status_card_updates u where u.card_id=c.id and u.kind!='compile' and u.status='ok' order by u.finished_at desc limit 1) u on true
                    left join heartbeat_runs r on r.id=u.run_id and r.company_id=c.company_id
                    left join issues gi on gi.id=u.generation_issue_id and gi.company_id=c.company_id where c.company_id=${company.id} and c.id=${status!.cardId}`
                : tx<ObservedRow[]>`select o.id,o.next_refresh_at as next_at,o.last_resolved_at as last_at,o.display_title as value,o.xmin::text as version,
                    o.refresh_token::text as claim,(select count(*)::int from external_object_mentions m where m.object_id=o.id and m.company_id=o.company_id) as pending,
                    o.data as policy,null::text as last_run_id,null::text as generation_issue_id,null::timestamptz as run_started_at,null::text as run_status,null::text as generation_status
                    from external_objects o where o.company_id=${company.id} and o.provider_key='github' and o.external_id='acme/sleep-object#issues/7'`);
              if (rows.length === 0) return undefined;
              assert.equal(rows.length, 1);
              const row = rows[0]!;
              assert(Object.hasOwn(row, 'last_at'), 'Produced projection is missing last_at');
              if (row.last_at === null) return undefined;
              const last_at = producedTimestamp(row.last_at, 'timestamp');
              const next_at = producedTimestamp(row.next_at, 'deadline');
              const run_started_at = row.run_started_at === null ? null : producedTimestamp(row.run_started_at, 'run start');
              assert(typeof row.value === 'string', 'Invalid produced value');
              assert.equal(typeof row.version, 'string', 'Invalid produced version');
              return { ...row, last_at, next_at, run_started_at, value: row.value };
            } catch (error) { readFailure = { error }; throw error; }
            finally {
              try { await db.$client.end({ timeout: 1 }); }
              catch (error) { if (readFailure) failures.push({ stage: 'observer-close', error }); else throw error; }
            }
          };
          const persisted = async () => { const row = await readProduced(); assert(row, 'No produced row'); return row; };
          const marker = (revision: number) => owner === 'status' ? `Useful status revision ${revision}.` : `Useful GitHub object revision ${revision}`;
          const initialBy = Date.now() + 30_000;
          let produced = await readProduced();
          while (!produced && Date.now() < initialBy) { await delay(50); produced = await readProduced(); }
          assert(produced, 'No produced row within 30000ms');
          expect(produced.value).toContain(marker(1)); phase('useful-v1-observed');
          if (stage === 'identity') {
            assert(status);
            const identityDb = createDb(appUrl, { maxConnections: 1 });
            let controlPrimary: { error: unknown } | undefined;
            try {
              const identity = async () => {
                const rows = await identityDb.$client.begin('read only', tx => tx<Array<{ agent_id: string; company_id: string; algorithm: string; key_id: string; ciphertext_hash: string }>>`
                  select agent_id,company_id,algorithm,key_id,md5(private_key_material::text) as ciphertext_hash
                  from agent_identity_keys where company_id=${company.id} and agent_id=${status!.agentId}`);
                assert.equal(rows.length, 1); return rows[0]!;
              };
              const useful = async (revision: number) => {
                const deadline = Date.now() + 30_000;
                let row = await persisted();
                while ((!row.value.includes(marker(revision)) || row.run_status !== 'succeeded' || row.generation_status !== 'done') && Date.now() < deadline) {
                  await delay(50); row = await persisted();
                }
                expect(row.value).toContain(marker(revision)); expect(row.run_status).toBe('succeeded');
                expect(row.generation_status).toBe('done'); expect(row.claim).toBeNull();
                return row;
              };
              const first = await useful(1), before = await identity();
              const restart = async (kind: string) => {
                assert(server); const old = server;
                await old.stop(); server = undefined; physical.push({ kind: `${kind}-stopped`, at: Date.now(), pid: old.pid });
                server = await boot(); physical.push({ kind: `${kind}-started`, at: Date.now(), pid: server.pid });
                expect(server.pid).not.toBe(old.pid);
              };
              await restart('identity-same-key');
              await status.revision(2);
              await server!.api('POST', `/status-cards/${status.cardId}/refresh`, { full: true });
              const second = await useful(2);
              phase('identity-useful-v2-observed');
              if (diagnostic) await record('diagnostic-useful-v2', { second, phases: [...phases], proxy: proxyEvidence() });
              const retained = await identity();
              expect(second.last_run_id).not.toBe(first.last_run_id); expect(retained).toEqual(before);
              const starts = (await agentReceipts()).filter(event => event.event === 'started');
              expect(starts).toHaveLength(2); expect(starts[1]!.runId).toBe(second.last_run_id);
              if (diagnostic) {
                phase('identity-postgeneration-settle-entered');
                await record('diagnostic-postgeneration-settle-entered', { phases: [...phases], proxy: proxyEvidence() });
                const firstStartedAt = Date.now();
                const settled = await server!.settled().catch(async firstError => {
                  phase('identity-postgeneration-first-settle-failed');
                  try { await record('diagnostic-first-settle-failure', { error: firstError instanceof Error ? firstError.stack : String(firstError),
                    startedAt: firstStartedAt, endedAt: Date.now(), elapsedMs: Date.now() - firstStartedAt, phases: [...phases], proxy: proxyEvidence() }); }
                  catch (error) { failures.push({ stage: 'diagnostic-first-failure-evidence', error }); }
                  phase('identity-postgeneration-continuation-entered');
                  const continuationStartedAt = Date.now();
                  try {
                    const continuation = await server!.settled();
                    phase('identity-postgeneration-continuation-returned');
                    try { await record('diagnostic-settle-continuation', { firstAssertionFailed: true, outcome: 'naturally_settled_after_failed_bound',
                      startedAt: continuationStartedAt, endedAt: Date.now(), elapsedMs: Date.now() - continuationStartedAt,
                      continuation, phases: [...phases], proxy: proxyEvidence() }); }
                    catch (error) { failures.push({ stage: 'diagnostic-continuation-evidence', error }); }
                  } catch (continuationError) {
                    phase('identity-postgeneration-continuation-failed');
                    try { await record('diagnostic-settle-continuation', { firstAssertionFailed: true, outcome: 'failed_again',
                      error: continuationError instanceof Error ? continuationError.stack : String(continuationError),
                      startedAt: continuationStartedAt, endedAt: Date.now(), elapsedMs: Date.now() - continuationStartedAt,
                      phases: [...phases], proxy: proxyEvidence() }); }
                    catch (error) { failures.push({ stage: 'diagnostic-continuation-evidence', error }); }
                  }
                  throw firstError;
                });
                phase('identity-postgeneration-settle-returned');
                await record('diagnostic-postgeneration-settled', { settled, phases: [...phases], proxy: proxyEvidence() });
              }
              const alteredSecrets = { ...runtimeSecrets, PAPERCLIP_SECRETS_MASTER_KEY: randomBytes(32).toString('hex') };
              expect(alteredSecrets.PAPERCLIP_SECRETS_MASTER_KEY).not.toBe(runtimeSecrets.PAPERCLIP_SECRETS_MASTER_KEY);
              await retainRuntimeSecrets(alteredSecrets, 'runtime-secret-negative-profile');
              await restart('identity-wrong-master');
              await status.revision(3);
              await server!.api('POST', `/status-cards/${status.cardId}/refresh`, { full: true });
              const latestRun = async () => identityDb.$client.begin('read only', tx => tx<Array<{ id: string; status: string; error_code: string | null; error: string | null }>>`
                select id,status,error_code,error from heartbeat_runs where company_id=${company.id} and agent_id=${status!.agentId}
                order by created_at desc limit 1`).then(rows => rows[0]);
              const failedBy = Date.now() + 30_000;
              let rejected = await latestRun();
              while ((!rejected || rejected.id === second.last_run_id || rejected.status !== 'failed') && Date.now() < failedBy) {
                await delay(50); rejected = await latestRun();
              }
              assert(rejected); expect(rejected.id).not.toBe(second.last_run_id); expect(rejected.status).toBe('failed');
              expect(rejected.error_code).toBe('setup_failed'); expect(rejected.error).toContain('Secret decryption failed');
              expect((await agentReceipts()).filter(event => event.event === 'started')).toEqual(starts);
              const afterRejected = await identity(); expect(afterRejected).toEqual(before);
              await record('cold-identity-control', { first, second, before, retained, afterRejected, rejected, physical,
                agentReceipts: await agentReceipts(), boundary: 'Actual normal manual refresh generations and cold process restarts; no scheduled-alarm/cadence claim; wrong master key must fail closed before agent entry' });
              return;
            } catch (error) { controlPrimary = { error }; throw error; }
            finally {
              try { await identityDb.$client.end({ timeout: 1 }); }
              catch (error) { if (controlPrimary) failures.push({ stage: 'identity-observer-close', error }); else throw error; }
            }
          }
          phase('initial-settled-entered');
          if (owner === 'status') await server.settled(500, 0, { managedSetupRecovery: true });
          else await server.settled();
          phase('initial-settled-returned');
          if (diagnostic) await record('diagnostic-initial-settled', { phases, proxy: { queries: [...server.proxy.queries],
            frames: server.proxy.frames, transport: server.proxy.transport, pending: server.proxy.pending, starting: server.proxy.starting } });
          const initial = await persisted();
          assert(initial.next_at && initial.last_at);
          const originalD = new Date(initial.next_at).getTime();
          expect(originalD - new Date(initial.last_at).getTime()).toBe(owner === 'status' ? 900_000 : 300_000);
          expect(initial.claim).toBeNull();
          if (owner === 'status') {
            expect(initial.policy).toMatchObject({ mode: 'interval', intervalMinutes: 15 });
            expect(initial.pending).toBe(0); expect(initial.run_status).toBe('succeeded'); expect(initial.generation_status).toBe('done');
            await server.api('POST', `/companies/${company.id}/issues`, { title: 'A changed real persisted blocker', status: 'blocked', priority: 'medium' });
            await server.settled(500, 0, { managedSetupRecovery: true });
            expect((await persisted()).value).toBe(initial.value);
            expect(new Date((await persisted()).next_at).getTime()).toBe(originalD);
          } else expect(initial.pending).toBeGreaterThan(0);
          bridge = await startDefaultCadenceBridge({ checkout: cloudCheckout, node: cloudNode,
            physicalStop: async () => {
              assert(server); const old = server;
              physical.push({ kind: 'stop-entered', at: Date.now(), pid: old.pid });
              await old.stop(); server = undefined; physical.push({ kind: 'stopped', at: Date.now(), pid: old.pid });
              if (!boundaryAdvanced) {
                if (status) await status.revision(2); else upstream.revision(2);
                boundaryAdvanced = true;
              }
            },
            physicalWake: async () => {
              assert(!server); server = await boot(); physical.push({ kind: 'cold-started', at: Date.now(), pid: server.pid });
              return { origin: `http://127.0.0.1:${server.port}` };
            } });
          assert(bridge.pid); childPids.push(bridge.pid);
          await bridge.rpc('initialize', { databaseUrl: cloudUrl, migrationsPath: path.join(cloudCheckout, 'migrations'),
            appOrigin: `http://127.0.0.1:${server.port}`, privateJwk, jwks });
          await server.settled();
          if (owner === 'object') expect((await bridge.rpc('legacy')).idleSleepSafe).not.toBe(true);
          const requestStart = upstream.requests.length, agentStart = (await agentReceipts()).length;
          const beforeSleepSnapshot = await server.snapshot();
          const sleep = await bridge.rpc('sleep');
          expect(server).toBeUndefined();
          expect(new Date(sleep.alarm.next_wake_at).getTime()).toBe(originalD);
          const wakeAt = new Date(sleep.alarm.next_attempt_at).getTime();
          expect(wakeAt).toBe(originalD - 120_000);
          const ack = sleep.events.find((event: { kind: string }) => event.kind === 'durable-alarm-before-stop');
          assert(ack); expect(typeof sleep.alarm.operation_lock_id).toBe('string'); expect(sleep.alarm.operation_lock_id.length).toBeGreaterThan(0);
          expect(ack.row.operation_lock_id).toBe(sleep.alarm.operation_lock_id);
          expect(ack.row.generation).toBe(sleep.alarm.generation);
          expect(ack.at).toBeLessThanOrEqual(physical.find(event => event.kind === 'stop-entered')!.at);
          await record('bootstrap-receipt', { owner, stage, originalD, wakeAt, initial, beforeSleepSnapshot, sleep, physical, requests: upstream.requests, agentReceipts: await agentReceipts() });
          if (stage === 'bootstrap') return;
          await delay(Math.max(0, wakeAt - Date.now()) + 25);
          const wake = await bridge.rpc('wake'); assert(server);
          expect(childPids.filter(pid => pid !== bridge!.pid)).toHaveLength(2);
          expect(physical.find(event => event.kind === 'cold-started')!.pid).not.toBe(physical.find(event => event.kind === 'stopped')!.pid);
          await server.settled();
          const feature = await server.api<Record<string, boolean>>('GET', '/instance/settings/experimental');
          expect(feature[owner === 'status' ? 'enableStatusCards' : 'enableExternalObjects']).toBe(true);
          await server.settled();
          const quiet = async () => {
            assert(server); const before = await server.snapshot();
            const queries = server.proxy.queries.length, requests = upstream.requests.length, agents = (await agentReceipts()).length;
            const started = Date.now(); await delay(10_000);
            const after = await server.snapshot();
            expect(server.proxy.queries.length).toBe(queries); expect(upstream.requests.length).toBe(requests);
            expect((await agentReceipts()).length).toBe(agents); expect(after.outgoingHttpRequests).toBe(before.outgoingHttpRequests);
            return { started, ended: Date.now(), queries, requests, agents, before, after };
          };
          expect((await persisted()).value).toBe(initial.value);
          expect(new Date((await persisted()).next_at).getTime()).toBe(originalD);
          const earlyQuiet = await quiet();
          expect(earlyQuiet.ended).toBeLessThan(originalD);
          expect((await persisted()).version).toBe(initial.version);
          await delay(Math.max(0, originalD - Date.now()) + 25);
          const changedBy = Date.now() + 30_000;
          let observed = await persisted();
          while (!observed.value.includes(marker(2)) && Date.now() < changedBy) { await delay(50); observed = await persisted(); }
          expect(observed.value).toContain(marker(2));
          if (owner === 'status') {
            const startedAt = Date.now(), queriesBefore = server.proxy.queries.length, pendingBefore = server.proxy.pending;
            const settled = await server.settled(500, 0, { managedSetupRecovery: true });
            const endedAt = Date.now();
            await record('status-postgeneration-observation', { startedAt, endedAt, elapsedMs: endedAt - startedAt,
              timeoutMs: 61_000, quietMs: 500, queriesBefore, queriesAfter: server.proxy.queries.length,
              pendingBefore, pendingAfter: server.proxy.pending, settled,
              boundary: 'Bounded recovery reconciliation observation; the subsequent real 10s SQL/network/producer quiet window is separate' });
          } else await server.settled();
          const changed = await persisted();
          expect(changed.version).not.toBe(initial.version); expect(new Date(changed.last_at).getTime()).toBeGreaterThanOrEqual(originalD);
          expect(new Date(changed.last_at).getTime()).toBeLessThan(originalD + 30_000);
          expect(changed.claim).toBeNull();
          if (owner === 'status') {
            expect(changed.value).toContain('A changed real persisted blocker');
            expect(changed.policy).toEqual(initial.policy); expect(changed.pending).toBe(0); expect(changed.run_status).toBe('succeeded'); expect(changed.generation_status).toBe('done');
            expect(new Date(changed.run_started_at!).getTime()).toBeGreaterThanOrEqual(originalD);
            const starts = (await agentReceipts()).slice(agentStart).filter(event => event.event === 'started');
            expect(starts).toHaveLength(1); expect(starts[0]!.at).toBeGreaterThanOrEqual(originalD);
            expect(starts[0]!.runId).toBe(changed.last_run_id);
          } else {
            const requests = upstream.requests.slice(requestStart); expect(requests.length).toBeGreaterThan(0);
            expect(Math.min(...requests.map(request => request.at))).toBeGreaterThanOrEqual(originalD);
            expect(changed.pending).toBeGreaterThan(0);
          }
          expect(new Date(changed.next_at).getTime() - new Date(changed.last_at).getTime()).toBe(owner === 'status' ? 900_000 : 300_000);
          const settledQuiet = await quiet();
          await record('cold-owner-cycle-receipt', { owner, originalD, wakeAt, initial, sleep, wake, changed, physical, earlyQuiet, settledQuiet,
            requests: upstream.requests, agents: await agentReceipts(), s3: s3.snapshot(), boundary: 'Actual signed app/Cloud/SQL alarm and owner; controlled localhost GitHub, deterministic process model, S3 and physical child only' });
        } catch (error) {
          primary ??= { error }; phase('primary-caught');
          try { await record('primary-before-cleanup', { error: error instanceof Error ? error.stack : String(error), serverOutput: server?.output, bridgeOutput: bridge?.output, physical, diagnostic, phases,
            proxy: proxyEvidence() }); }
          catch (error) { failures.push({ stage: 'primary-evidence', error }); }
          throw error;
        } finally {
          if (diagnostic) {
            phase('diagnostic-owner-close-entered');
            try { await record('diagnostic-before-owner-close', { phases: [...phases], proxy: proxyEvidence() }); }
            catch (error) { failures.push({ stage: 'diagnostic-close-evidence', error }); }
          }
          const currentBridge = bridge; bridge = undefined;
          try { await currentBridge?.close(); } catch (error) { failures.push({ stage: 'bridge-close', error }); }
          const currentServer = server; server = undefined;
          try { await currentServer?.stop(); } catch (error) { failures.push({ stage: 'server-stop', error }); }
        }
      }));
    } catch (error) {
      if (!primary) primary = { error };
      else if (error !== primary.error) failures.push({ stage: 'provider-cleanup', error });
      try { await record('attempt-failure', { error: primary.error instanceof Error ? primary.error.stack : String(primary.error), physical }); }
      catch (error) { failures.push({ stage: 'attempt-evidence', error }); }
    } finally {
      const currentBridge = bridge; bridge = undefined;
      try { await currentBridge?.close(); } catch (error) { failures.push({ stage: 'final-bridge-close', error }); }
      const currentServer = server; server = undefined;
      try { await currentServer?.stop(); } catch (error) { failures.push({ stage: 'final-server-stop', error }); }
      try {
        const uncertainOwners = failures.filter(({ stage }) => ['boot-origin-cleanup', 'bridge-close', 'server-stop',
          'final-bridge-close', 'final-server-stop'].includes(stage)).map(({ stage }) => stage);
        if (secretsDirectory && uncertainOwners.length) {
          const ownedPath = path.join(secretsDirectory, 'runtime-secrets.json');
          let sha256: string | undefined;
          try { sha256 = createHash('sha256').update(await readFile(ownedPath)).digest('hex'); }
          catch (error) { failures.push({ stage: 'runtime-secret-retained-hash', error }); }
          await record('runtime-secret-retained', { ownedPath, sha256, uncertainOwners,
            reason: 'Owner closure failed; private profile retained for exact owner audit and normal cleanup' });
        } else if (secretsDirectory) await rm(secretsDirectory, { recursive: true, force: true });
      } catch (error) { failures.push({ stage: 'runtime-secret-cleanup', error }); }
      try {
        const agents = await agentReceipts();
        const events = (await readFile(process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG!, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        expect(events.filter(event => event.event === 'blocked')).toEqual([]);
        for (const pid of [process.pid, process.ppid, ...childPids, ...agents.map(agent => agent.pid)]) {
          expect(events).toContainEqual(expect.objectContaining({ event: 'preloaded', pid, sourceHash: defaultCadenceNetwork().sourceHash }));
        }
        await record('final-parent-guard', { stats: defaultCadenceNetwork(), physical, childPids, agents });
        expect(defaultCadenceNetwork().offhostAttempts).toEqual([]);
      } catch (error) { failures.push({ stage: 'guard-evidence', error }); }
      try { await record('cleanup-guard-failures', failures.map(({ stage, error }) => ({ stage, error: error instanceof Error ? error.stack : String(error) }))); }
      catch (error) { failures.push({ stage: 'cleanup-evidence', error }); }
    }
    if (primary) throw primary.error;
    if (failures.length) throw new AggregateError(failures.map(failure => failure.error), 'Owner acceptance cleanup or guard failed');
  };
  const registrations = [
    { owner: 'status', stage: 'bootstrap', diagnostic: false, name: 'status bootstrap: publishes a signed original-deadline alarm before physical stop' },
    { owner: 'status', stage: 'cycle', diagnostic: false, name: 'status cycle: publishes useful work at the original interval after cold wake' },
    { owner: 'status', stage: 'identity', diagnostic: false, name: 'status identity: retains encrypted identity across cold boots and rejects a changed master key' },
    { owner: 'object', stage: 'bootstrap', diagnostic: false, name: 'object bootstrap: publishes a signed built-in GitHub deadline before physical stop' },
    { owner: 'object', stage: 'cycle', diagnostic: false, name: 'object cycle: refreshes built-in GitHub data at the original deadline after cold wake' },
    { owner: 'status', stage: 'identity', diagnostic: true, name: 'status identity diagnostic: observes post-generation recovery and preserves the first failed bound' },
    { owner: 'object', stage: 'bootstrap', diagnostic: true, name: 'object bootstrap diagnostic: retains passive setup SQL and work evidence' },
  ] as const;
  for (const registration of registrations) {
    it.skipIf(owner !== registration.owner || stage !== registration.stage || diagnostic !== registration.diagnostic)(
      registration.name, runAcceptance,
      registration.stage === 'identity' ? 240_000 : registration.stage === 'bootstrap' ? 850_000 : 1_250_000,
    );
  }
});
