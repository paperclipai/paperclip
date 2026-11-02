import { resolveExternalTestDatabaseUrl } from '../__tests__/helpers/external-test-database.js';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { companies, companySkills, companySkillSources, createDb, applyPendingMigrations, projects, projectWorkspaces, projectSkillSources } from '@paperclipai/db';
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from '../__tests__/helpers/embedded-postgres.js';
import { githubFixture } from '../__tests__/helpers/github-skills.js';
import { skillSourceSyncService } from './skill-source-sync.js';
import { skillSourceService, type SkillSourceContext } from './skill-sources.js';
import { enqueueProjectSkillSource, detachProjectSkillSource } from './project-skill-source-bindings.js';
import { createDeliveryWorkCoordinator } from './delivery-work-coordinator.js';
import { idleWorkSnapshot } from './task-admission.js';
import { readIdleSleepSafety } from './idle-sleep-safety.js';
import { companyService } from './companies.js';

const externalUrl = resolveExternalTestDatabaseUrl('PAPERCLIP_SKILL_SYNC_TEST_DATABASE_URL');
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const setup = { refreshUserId: null, refreshAgentId: null, refreshLocalTrusted: true, connectionId: null, refreshGrantId: null };

describe.skipIf(!support.supported)('skill source committed work and deadlines', () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator>;
  let service: ReturnType<typeof skillSourceSyncService>;
  let home: string;
  const oldHome = process.env.PAPERCLIP_HOME;
  let companyId: string;
  let draining: boolean;
  let standby: boolean;
  let calls: string[];
  let errors: unknown[];
  let context: SkillSourceContext;
  let contextFor: ReturnType<typeof vi.fn<() => Promise<SkillSourceContext>>>;
  let reads: ReturnType<typeof vi.fn>;
  let failDeadline: boolean;
  beforeAll(async () => {
    if (externalUrl) await applyPendingMigrations(externalUrl);
    else database = await startEmbeddedPostgresTestDatabase('skill-sync-work-');
    db = createDb(externalUrl ?? database.connectionString, { maxConnections: 4 });
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-sync-work-home-'));
    process.env.PAPERCLIP_HOME = home;
  });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true });
    draining = false; standby = false; calls = []; errors = []; failDeadline = false;
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: 'Skill sync', issuePrefix: 'SSW' });
    const reader = githubFixture({ 'test/SKILL.md': '---\nname: test\ndescription: Test workflow\n---\nFollow the workflow.\n' });
    reads = vi.fn(reader);
    Object.assign(reads, reader);
    context = { actor: { type: 'system' }, setup: { userId: null, localTrusted: true },
      read: () => reads as unknown as ReturnType<SkillSourceContext['read']>, authorize: async () => {}, audit: async () => {} };
    contextFor = vi.fn(async () => context);
  });
  afterEach(async () => {
    await service?.stop();
    await coordinator?.stop();
    vi.useRealTimers();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });
  afterAll(async () => {
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });
  async function workspace(ref = 'main', projectId?: string) {
    if (!projectId) {
      const [project] = await db.insert(projects).values({ companyId, name: ref }).returning();
      projectId = project.id;
    }
    const [row] = await db.insert(projectWorkspaces).values({ companyId, projectId, name: ref,
      repoUrl: 'https://github.com/acme/skills', defaultRef: ref }).returning();
    return row;
  }
  async function source(overrides: Partial<typeof companySkillSources.$inferInsert> = {}) {
    const [row] = await db.insert(companySkillSources).values({ companyId, repositoryUrl: 'https://github.com/acme/skills',
      fullName: 'acme/skills', trackingRef: 'main', refreshLocalTrusted: true, ...overrides }).returning();
    return row;
  }
  async function start() {
    const observed = new Proxy(db, { get(target, key) {
      if (!['select', 'update', 'insert', 'delete', 'execute', 'transaction'].includes(String(key))) return Reflect.get(target, key);
      return (...args: unknown[]) => {
        calls.push(String(key));
        if (key === 'execute' && failDeadline) { failDeadline = false; throw new Error('deadline read failed'); }
        return Reflect.apply(Reflect.get(target, key), target, args);
      };
    } });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining && !standby,
      canReconcile: () => !standby, onError: error => errors.push(error) });
    service = skillSourceSyncService(observed, { context: contextFor });
    await service.start(coordinator).ready;
  }
  async function settle() {
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
  }
  async function quiet(ms = 60_000) {
    const baseline = [...calls];
    await vi.advanceTimersByTimeAsync(ms);
    expect(calls).toEqual(baseline);
  }
  async function imported(id: string) {
    await vi.waitFor(async () => {
      const [row] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.id, id));
      expect(row.sourceId).not.toBeNull();
    });
    await settle();
  }
  async function sleepSafety() {
    const ownerId = randomUUID(), now = Date.now();
    return readIdleSleepSafety(db, () => ({ ownerId, draining: true, activeRuns: 0, pendingWakes: 0,
      startedAt: new Date(now - 1000), expiresAt: new Date(now + 60_000) }), () => now, ownerId, async () => 'none');
  }

  it('stays SQL-quiet empty and with paused sources and retained bindings', async () => {
    await start(); await quiet();
    await coordinator.stop(); await service.stop();
    const row = await source({ automaticUpdates: false });
    const ws = await workspace();
    await db.insert(projectSkillSources).values({ companyId, projectId: ws.projectId, workspaceId: ws.id,
      sourceId: row.id, repositoryUrl: row.repositoryUrl, trackingRef: 'main', active: false, status: 'ready' });
    await start(); await quiet(600_000);
    expect(coordinator.nextWakeAt()).toBeNull();
    expect(reads).not.toHaveBeenCalled();
    expect((await sleepSafety()).backgroundWork).toBe('none');
  });

  it('imports the first real attachment after quiet only when its outer transaction commits', async () => {
    const ws = await workspace(); await start(); await quiet();
    let release!: () => void, written!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { written = resolve; });
    let bindingId = '';
    const transaction = db.transaction(async tx => {
      bindingId = (await enqueueProjectSkillSource(tx as unknown as typeof db, ws, setup))!.id;
      written(); await gate;
    });
    await ready;
    expect(contextFor).not.toHaveBeenCalled();
    expect(idleWorkSnapshot().active).toBeGreaterThan(0);
    release(); await transaction;
    await imported(bindingId);
    expect(await db.select().from(companySkills)).toHaveLength(1);
    expect(coordinator.nextWakeAt()).toBeGreaterThan(Date.now() + 250_000);
    await quiet();
    expect((await sleepSafety()).backgroundWork).toBe('present');
  });

  it('does not import a rolled-back attachment and returns to quiet', async () => {
    const ws = await workspace(); await start();
    await expect(db.transaction(async tx => {
      await enqueueProjectSkillSource(tx as unknown as typeof db, ws, setup);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    await settle(); await quiet();
    expect(contextFor).not.toHaveBeenCalled();
    expect(coordinator.nextWakeAt()).toBeNull();
  });

  it.each(['drain', 'standby'] as const)('retains startup and first attachment during %s', async state => {
    draining = state === 'drain'; standby = state === 'standby';
    const ws = await workspace(); await start();
    const binding = await enqueueProjectSkillSource(db, ws, setup);
    if (state === 'drain') await settle();
    else expect(idleWorkSnapshot().active).toBeGreaterThan(0);
    await quiet(20_000);
    expect(contextFor).not.toHaveBeenCalled();
    draining = false; standby = false;
    await vi.advanceTimersByTimeAsync(5_000); await imported(binding!.id);
  });

  it('recovers a failed sweep after drain without losing its request', async () => {
    const ws = await workspace();
    const binding = await enqueueProjectSkillSource(db, ws, setup);
    await db.update(projectSkillSources).set({ nextSyncAt: new Date(Date.now() + 60_000) }).where(eq(projectSkillSources.id, binding!.id));
    failDeadline = true; await start();
    expect(errors).toHaveLength(1);
    draining = true; await vi.advanceTimersByTimeAsync(5_000); await settle(); await quiet(20_000);
    draining = false; await vi.advanceTimersByTimeAsync(5_000); await settle();
    expect(coordinator.nextWakeAt()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60_000); await imported(binding!.id);
  });

  it('restores retry and lease deadlines on restart without polling between attempts', async () => {
    const ws = await workspace();
    const binding = await enqueueProjectSkillSource(db, ws, setup);
    const leaseAt = Date.now() + 60_000;
    await db.update(projectSkillSources).set({ leaseToken: randomUUID(), leaseExpiresAt: new Date(leaseAt) }).where(eq(projectSkillSources.id, binding!.id));
    contextFor.mockRejectedValueOnce(new Error('temporary provider failure'));
    await start();
    expect(coordinator.nextWakeAt()).toBe(leaseAt);
    await quiet(50_000); await vi.advanceTimersByTimeAsync(11_000); await settle();
    const [failed] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.id, binding!.id));
    expect(failed.status).toBe('error'); expect(failed.failureCount).toBe(1);
    await service.stop(); await coordinator.stop(); await start();
    expect(coordinator.nextWakeAt()).toBe(failed.nextSyncAt.getTime());
    await quiet(60_000); await vi.advanceTimersByTimeAsync(240_000); await imported(binding!.id);
  });

  it('preempts a later deadline on settings and cancels refreshes when paused', async () => {
    const row = await source({ nextSyncAt: new Date(Date.now() + 600_000) });
    await start(); await quiet();
    const sources = skillSourceService(db);
    await sources.settings(companyId, row.id, { revision: row.revision, importNewSkills: true }, context);
    await settle();
    expect(contextFor).toHaveBeenCalled();
    const current = await sources.detail(companyId, row.id);
    await sources.settings(companyId, row.id, { revision: current.revision, automaticUpdates: false }, context);
    await settle(); await quiet(600_000);
    expect(coordinator.nextWakeAt()).toBeNull();
  });

  it('replaces a manual refresh lease with its committed retry deadline', async () => {
    const row = await source({ nextSyncAt: new Date(Date.now() + 3_600_000) });
    await start();
    let rejectRead!: (error: Error) => void, reading!: () => void;
    const ready = new Promise<void>(resolve => { reading = resolve; });
    const response = new Promise<never>((_, reject) => { rejectRead = reject; });
    const refresh = skillSourceService(db).refresh(companyId, row.id, {
      ...context, read: () => Object.assign(async () => { reading(); return response; }, { openSnapshot: context.read(null).openSnapshot }),
    });
    const rejected = expect(refresh).rejects.toThrow('provider unavailable');
    await ready; await settle();
    const [leased] = await db.select().from(companySkillSources).where(eq(companySkillSources.id, row.id));
    expect(leased.leaseToken).not.toBeNull();
    rejectRead(new Error('provider unavailable')); await rejected; await settle();
    const [failed] = await db.select().from(companySkillSources).where(eq(companySkillSources.id, row.id));
    expect(failed.leaseToken).toBeNull();
    expect(coordinator.nextWakeAt()).toBe(failed.nextSyncAt.getTime());
    await quiet(60_000);
    await vi.advanceTimersByTimeAsync(240_000); await settle();
    const [refreshed] = await db.select().from(companySkillSources).where(eq(companySkillSources.id, row.id));
    expect(refreshed.failureCount).toBe(0);
    expect(refreshed.lastSuccessAt).not.toBeNull();
    await quiet(60_000);
  });

  it('aborts provider work on shutdown and leaves the import recoverable', async () => {
    const ws = await workspace(); await start();
    const reader = githubFixture({});
    let reading!: () => void;
    const ready = new Promise<void>(resolve => { reading = resolve; });
    reader.openSnapshot = async (_input, options) => new Promise((_, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
      reading();
    });
    context.read = () => reader;
    const binding = await enqueueProjectSkillSource(db, ws, setup);
    await vi.advanceTimersByTimeAsync(0); await ready;
    await service.stop(); await coordinator.stop();
    const [pending] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.id, binding!.id));
    expect(pending).toMatchObject({ status: 'pending', leaseToken: null, failureCount: 0, sourceId: null });
    await quiet(600_000);
    context.read = () => githubFixture({});
    await start(); await imported(binding!.id);
  });

  it('admits deferred imports after a full batch frees capacity', async () => {
    context.read = () => githubFixture({});
    const ws = await workspace('ref0');
    const bindings = [];
    for (let i = 0; i < 21; i++) {
      const row = i === 0 ? ws : await workspace(`ref${i}`, ws.projectId);
      bindings.push(await enqueueProjectSkillSource(db, row, setup));
    }
    expect(bindings.at(-1)!.active).toBe(false);
    await start(); await settle();
    await vi.advanceTimersByTimeAsync(15_000); await imported(bindings.at(-1)!.id);
    expect(await db.select().from(projectSkillSources).where(eq(projectSkillSources.status, 'ready'))).toHaveLength(21);
  });

  it('preserves a new committed attachment during an active sweep', async () => {
    const first = await workspace('first'), second = await workspace('second');
    await enqueueProjectSkillSource(db, first, setup);
    contextFor.mockImplementationOnce(async () => {
      await enqueueProjectSkillSource(db, second, setup);
      return context;
    });
    await start(); await settle();
    await vi.advanceTimersByTimeAsync(5_000); await settle();
    expect(await db.select().from(projectSkillSources).where(eq(projectSkillSources.status, 'ready'))).toHaveLength(2);
  });

  it('wakes saved work on company reactivation and cancels detached imports', async () => {
    const ws = await workspace();
    const binding = await enqueueProjectSkillSource(db, ws, setup);
    await db.update(companies).set({ status: 'paused' }).where(eq(companies.id, companyId));
    await start(); await quiet();
    expect(coordinator.nextWakeAt()).toBeNull();
    await companyService(db).update(companyId, { status: 'active' });
    await imported(binding!.id);
    const later = await workspace('later');
    draining = true;
    const pending = await enqueueProjectSkillSource(db, later, setup);
    await detachProjectSkillSource(db, companyId, later.id);
    draining = false; await settle();
    const [detached] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.id, pending!.id));
    expect(detached.active).toBe(false); expect(detached.sourceId).toBeNull();
  });

  it('blocks host sleep for a future import until it is detached', async () => {
    const ws = await workspace();
    const binding = await enqueueProjectSkillSource(db, ws, setup);
    await db.update(projectSkillSources).set({ nextSyncAt: new Date(Date.now() + 600_000) }).where(eq(projectSkillSources.id, binding!.id));
    await start();
    expect((await sleepSafety()).backgroundWork).toBe('present');
    await detachProjectSkillSource(db, companyId, ws.id); await settle();
    expect((await sleepSafety()).backgroundWork).toBe('none');
  });
});
