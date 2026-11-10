import { defaultCadenceNetwork, installDefaultCadenceNetwork, allowDefaultCadenceOrigin } from './helpers/maintenance/default-cadence-network.js';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { applyPendingMigrations, createDb } from '@paperclipai/db';
import { resolveExternalTestDatabaseUrl } from './helpers/external-test-database.js';
import { githubFixture } from './helpers/github-skills.js';
import { startMaintenanceServer, withMaintenanceProvider } from './helpers/maintenance/server-harness.js';
import { createMaintenanceS3Boundary } from './helpers/maintenance/s3-boundary.js';
import { provisionManagedSleepCompany, managedTenantActor } from './helpers/maintenance/managed-profile.js';
import { startDefaultCadenceBridge } from './helpers/maintenance/default-cadence-bridge.js';

const enabled = process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_ACCEPTANCE === '1';
const stage = process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_STAGE ?? 'two-cycle';
if (enabled && !['bootstrap', 'two-cycle'].includes(stage)) throw new Error('Default cadence stage must be bootstrap or two-cycle');
if (enabled) installDefaultCadenceNetwork();
const databaseUrl = resolveExternalTestDatabaseUrl('PAPERCLIP_SKILL_DEFAULT_CADENCE_TEST_DATABASE_URL');
const cloudDatabaseUrl = resolveExternalTestDatabaseUrl('PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_TEST_DATABASE_URL');
const cloudCheckout = process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_CHECKOUT;
const cloudSha = process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_SHA;
const cloudNode = process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_NODE;
const evidence = process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_EVIDENCE;
if (enabled && (!databaseUrl || !cloudDatabaseUrl || !cloudCheckout || !cloudNode || !evidence || !/^[a-f0-9]{40}$/.test(cloudSha ?? '')
  || process.env.PAPERCLIP_MAINTENANCE_KEEP_ARTIFACTS !== '1')) throw new Error('Default cadence witness requires two explicit owned DBs, pinned Cloud checkout/Node22, and retained evidence');



describe.skipIf(!enabled)('default skill cadence actual signed host handoff', () => {
  it(stage === 'bootstrap' ? 'qualifies actual producer, signed legacy refusal and original-D durable ACK only'
    : 'sleeps and cold-reactivates twice under each original default300s deadline', async () => {
    assert.equal(execFileSync('git', ['-C', cloudCheckout!, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), cloudSha);
    assert.match(execFileSync(cloudNode!, ['--version'], { encoding: 'utf8' }), /^v22\./);
    await applyPendingMigrations(databaseUrl!);

    let upstream = 1;
    const files = () => ({ 'workflow/SKILL.md': `---\nname: default-cadence\ndescription: Useful default cadence workflow\n---\nPersisted useful revision ${upstream}.\n` });
    const commit = () => String(upstream).repeat(40);
    const requests: Array<{ at: number; path: string }> = [];
    const upstreamServer = createServer(async (req, res) => {
      requests.push({ at: Date.now(), path: req.url! });
      try {
        const body = req.url === '/__skill_snapshot' ? { files: files(), commit: commit() }
          : await githubFixture(files(), {}, commit())(req.url!);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body));
      } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }
    });
    const s3 = createMaintenanceS3Boundary();
    const pair = generateKeyPairSync('ed25519');
    const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'default-cadence', alg: 'EdDSA', use: 'sig' };
    const privateJwk = JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: jwk.kid, alg: 'EdDSA', use: 'sig' });
    const jwks = JSON.stringify({ keys: [jwk] });
    const cycles: unknown[] = [];
    const childPids: number[] = [];
    let server: Awaited<ReturnType<typeof startMaintenanceServer>> | undefined;
    let bridge: Awaited<ReturnType<typeof startDefaultCadenceBridge>> | undefined;
    try {
      await withMaintenanceProvider(s3.server, s3Origin => withMaintenanceProvider(upstreamServer, async githubOrigin => {
        try {
        const boot = async () => {
          const started = await startMaintenanceServer(databaseUrl!, {
          childEntry: new URL('./helpers/maintenance/default-cadence-child.ts', import.meta.url),
          childPreload: new URL('../../../scripts/fixtures/skill-default-cadence-network-guard.cjs', import.meta.url),
          databasePoolMax: 2, artifactRoot: evidence, githubOrigin, clock: false, controlJwks: jwks,
          cloud: { jwks, s3Origin, standby: false }, tenantActor: managedTenantActor,
          configuration: { managedInstance: true, deploymentMode: 'authenticated', storageProvider: 's3', announcements: false },
          });
          assert(started.pid); childPids.push(started.pid);
          const guard = started.childGuard as ReturnType<typeof defaultCadenceNetwork>;
          expect(guard.loaded).toBe(true); expect(guard.pid).toBe(started.pid); expect(guard.ppid).toBe(process.pid);
          expect(guard.sourceHash).toBe(defaultCadenceNetwork().sourceHash);
          allowDefaultCadenceOrigin(`http://127.0.0.1:${started.port}`);
          return started;
        };
        server = await boot();


        const setupDb = createDb(databaseUrl!, { maxConnections: 1 });
        const company = await provisionManagedSleepCompany(server, setupDb).finally(() => setupDb.$client.end({ timeout: 1 }));
        await server.settled();
        bridge = await startDefaultCadenceBridge({ checkout: cloudCheckout!, node: cloudNode!,
          physicalStop: async () => { assert(server); await server.stop(); server = undefined; upstream++; },
          physicalWake: async () => { assert(!server); server = await boot(); return { origin: `http://127.0.0.1:${server.port}` }; } });
        assert(bridge.pid); childPids.push(bridge.pid);
        await bridge.rpc('initialize', { databaseUrl: cloudDatabaseUrl, migrationsPath: path.join(cloudCheckout!, 'migrations'),
          appOrigin: `http://127.0.0.1:${server.port}`, privateJwk, jwks });
        await server.settled();

        await server.api('POST', `/companies/${company.id}/projects`, { name: 'Default cadence source',
          workspace: { name: 'Repository', repoUrl: 'https://github.com/acme/skills', defaultRef: 'HEAD' } });
        const persisted = async () => {
          const observerUrl = new URL(databaseUrl!); observerUrl.searchParams.set('application_name', 'skill-default-readonly-observer');
          const observer = createDb(observerUrl.href, { maxConnections: 1 });
          try {
            const rows = await observer.$client.begin('read only', tx => tx`select s.id,s.current_version_id,s.markdown,c.next_sync_at,c.last_success_at,c.last_scan_commit,c.lease_token,c.automatic_updates,c.enabled
            from company_skills s join company_skill_source_entries e on e.skill_id=s.id and e.company_id=s.company_id
            join company_skill_sources c on c.id=e.source_id and c.company_id=s.company_id where s.company_id=${company.id}`);
            assert.equal(rows.length, 1); return rows[0]!;
          } finally { await observer.$client.end({ timeout: 1 }); }
        };
        await expect.poll(async () => {
          try { return (await persisted()).markdown; } catch { return ''; }
        }, { timeout: 30_000 }).toContain('Persisted useful revision 1.');
        const initial = await persisted();
        let priorVersion = initial.current_version_id;
        const legacy = await bridge.rpc('legacy');
        expect(legacy.idleSleepSafe).not.toBe(true);
        for (let cycle = 1; cycle <= 2; cycle++) {
          assert(server);
          await server.settled();
          const source = await persisted();
          const originalD = new Date(source.next_sync_at).getTime();
          expect(originalD - new Date(source.last_success_at).getTime()).toBeGreaterThanOrEqual(300_000);
          expect(originalD - new Date(source.last_success_at).getTime()).toBeLessThan(300_050);
          expect(source.automatic_updates && source.enabled).toBe(true);
          expect(source.lease_token).toBeNull();
          const refreshRequestStart = requests.length;
          const sleep = await bridge.rpc('sleep');
          expect(server).toBeUndefined();
          expect(new Date(sleep.alarm.next_wake_at).getTime()).toBe(originalD);
          const wakeAt = new Date(sleep.alarm.next_attempt_at).getTime();
          expect(wakeAt).toBe(originalD - 120_000);
          await writeFile(path.join(evidence!, `cycle-${cycle}-durable-ack.json`), JSON.stringify({ originalD, sleep, requests }, null, 2));
          if (stage === 'bootstrap') {
            await writeFile(path.join(evidence!, 'bootstrap-only-receipt.json'), JSON.stringify({ stage, originalD, sleep,
              initial, requests, boundary: 'Actual initial useful producer/signed gate/durable ACK/physical child stop only. No due wake or second cycle executed.' }, null, 2));
            return;
          }

          await delay(Math.max(0, wakeAt - Date.now()) + 25);
          const wake = await bridge.rpc('wake');
          assert(server, 'Actual controller provider callback must cold-start a new child');
          await server.settled();

          const before = await persisted();
          expect(before.current_version_id).toBe(priorVersion);
          const snapBefore = await server.snapshot(), queryCount = server.proxy.queries.length, providerCount = requests.length;
          await delay(10_000);
          const snapAfter = await server.snapshot();
          expect(server.proxy.queries.length).toBe(queryCount);
          expect(requests.length).toBe(providerCount);
          expect(snapAfter.outgoingHttpRequests).toBe(snapBefore.outgoingHttpRequests);
          await delay(Math.max(0, originalD - Date.now()) + 25);
          await expect.poll(async () => (await persisted()).markdown, { timeout: 30_000 }).toContain(`Persisted useful revision ${cycle + 1}.`);
          const changed = await persisted();
          expect(changed.current_version_id).not.toBe(priorVersion);
          expect(new Date(changed.last_success_at).getTime()).toBeGreaterThanOrEqual(originalD);
          const refreshRequests = requests.slice(refreshRequestStart);
          expect(refreshRequests.length).toBeGreaterThan(0);
          expect(Math.min(...refreshRequests.map(request => request.at))).toBeGreaterThanOrEqual(originalD);
          priorVersion = changed.current_version_id;
          await server.settled();
          cycles.push({ cycle, originalD, wakeAt, sleep, wake, changed, refreshRequestStart, refreshRequests, quiet: { snapBefore, snapAfter, queryCount, providerCount } });
          await writeFile(path.join(evidence!, 'two-cycle-receipt.json'), JSON.stringify({ cycles, requests, s3: s3.snapshot(),
            boundary: 'Actual app index/routes/source owner and signed Cloud gate/controller/Postgres alarms; controlled localhost Git/S3/process stop only; no Railway/Neon claim' }, null, 2));
        }
        } catch (error) {
          await writeFile(path.join(evidence!, 'primary-failure-before-cleanup.json'), JSON.stringify({
            error: error instanceof Error ? error.stack : String(error), bridgeOutput: bridge?.output, serverOutput: server?.output,
          }, null, 2));
          throw error;
        } finally {
          try { const current = bridge; bridge = undefined; await current?.close(); }
          finally { const current = server; server = undefined; await current?.stop(); }
        }
      }));
    } catch (error) {
      await writeFile(path.join(evidence!, 'attempt-failure.json'), JSON.stringify({ at: new Date().toISOString(),
        error: error instanceof Error ? error.stack : String(error), cycles, requests, bridgeOutput: bridge?.output,
        serverOutput: server?.output, boundary: 'Actual first failure; no automatic retry or assertion/time policy change' }, null, 2));
      throw error;
    } finally {
      try { await bridge?.close(); } finally { await server?.stop(); }
      expect(defaultCadenceNetwork().offhostAttempts).toEqual([]);
      const events = (await readFile(process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG!, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      expect(events.filter(event => event.event === 'blocked')).toEqual([]);
      for (const pid of [process.pid, process.ppid, ...childPids]) {
        expect(events).toContainEqual(expect.objectContaining({ event: 'preloaded', pid, sourceHash: defaultCadenceNetwork().sourceHash }));
      }
    }
  }, 850_000);
});
