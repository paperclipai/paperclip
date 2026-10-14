import { reserveInitialSkillWork } from '../services/skill-source-import-budget.js';
import { admitDeferredSkillImports, lockSkillImportQueue, MAX_COMPANY_PENDING_SKILL_IMPORTS, MAX_PROJECT_PENDING_SKILL_IMPORTS, SKILL_IMPORT_CAPACITY_WAIT } from '../services/skill-source-import-queue.js';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { activityLog, agents, authUsers, companies, companyMemberships, companySkillSources, companySkillImportBudgets, companySkills, createDb, projects,
  projectWorkspaces, projectSkillSources, projectAccessMembers } from '@paperclipai/db';
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from './helpers/embedded-postgres.js';
import { githubFixture } from './helpers/github-skills.js';
import { enqueueProjectSkillSource, detachProjectSkillSource, projectSkillSetupIdentity } from '../services/project-skill-source-bindings.js';
import { adoptProjectSkillRepository, projectSkillRepositories, skillSourceSyncService } from '../services/skill-source-sync.js';
import { skillSourceService, type SkillSourceContext } from '../services/skill-sources.js';
import { companySkillService } from '../services/company-skills.js';
import { projectService } from '../services/projects.js';
import { skillAccessService, withSkillActor } from '../services/skill-access.js';
import type { AuthorizationActor } from '../services/authorization.js';
import { forbidden, unprocessable } from '../errors.js';

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)('automatic project skill sources', () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const oldHome = process.env.PAPERCLIP_HOME;
  const companyId = randomUUID();
  const md = (name: string) => `---\nname: ${name}\ndescription: Test workflow\n---\nFollow the workflow.\n`;
  let files: Record<string, string> = {};
  let commit = 'a'.repeat(40);
  const downloads = vi.fn();
  const context: SkillSourceContext = { actor: { type: 'system' }, setup: { userId: null, localTrusted: true },
    read: () => {
      const fixture = githubFixture(files, {}, commit), open = fixture.openSnapshot;
      fixture.openSnapshot = async (...args) => { downloads(); return open(...args); };
      return fixture;
    }, authorize: async () => {}, audit: async () => {} };
  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase('paperclip-project-skills-');
    db = createDb(testDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-project-skills-home-'));
    process.env.PAPERCLIP_HOME = home;
    await db.insert(companies).values({ id: companyId, name: 'Project skills', issuePrefix: 'PSK' });
  }, 30000);
  it('requires explicit repair before an agent-created repository can search a person’s GitHub grants', async () => {
    const row = await workspace('agent-repair', 'open');
    const binding = await enqueueProjectSkillSource(db, row);
    const [agent] = await db.insert(agents).values({ companyId, name: 'Agent repository setup', adapterType: 'codex_local', status: 'idle' }).returning();
    await db.update(projectSkillSources).set({ refreshUserId: 'local-board', refreshAgentId: agent!.id, refreshLocalTrusted: true }).where(eq(projectSkillSources.id, binding!.id));
    const provider = vi.spyOn(globalThis, 'fetch');
    try {
      await skillSourceSyncService(db).tick();
      const [saved] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.id, binding!.id));
      expect(saved!.lastError).toMatch(/Choose a GitHub connection/);
      expect(saved!.active).toBe(false);
      expect(provider).not.toHaveBeenCalled();
    } finally { provider.mockRestore(); }
  });
  afterAll(async () => {
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    await testDb?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });
  async function workspace(ref: string, visibility = 'open') {
    const [project] = await db.insert(projects).values({ companyId, name: ref, visibility }).returning();
    const [row] = await db.insert(projectWorkspaces).values({ companyId, projectId: project!.id, name: ref,
      repoUrl: 'https://github.com/acme/skills', defaultRef: ref }).returning();
    return row!;
  }
  const actor = (userId: string): AuthorizationActor => ({ type: 'board', userId, source: 'session', companyIds: [companyId], ignoreInstanceAdmin: true });

  it('bounds per-project pending imports and admits deferred work after capacity frees', async () => {
    await db.update(projectSkillSources).set({ active: false, lastError: null });
    const root = await workspace('quota-root');
    const rows = [];
    for (let index = 0; index <= MAX_PROJECT_PENDING_SKILL_IMPORTS; index++) {
      const [row] = await db.insert(projectWorkspaces).values({ companyId, projectId: root.projectId, name: `Repository ${index}`,
        repoUrl: root.repoUrl, defaultRef: `project-quota-${index}` }).returning();
      rows.push(row!); await enqueueProjectSkillSource(db, row!);
    }
    const pending = await db.select().from(projectSkillSources).where(eq(projectSkillSources.projectId, root.projectId));
    expect(pending.filter(row => row.active)).toHaveLength(MAX_PROJECT_PENDING_SKILL_IMPORTS);
    expect(pending.filter(row => !row.active)).toEqual([expect.objectContaining({ status: 'pending', lastError: SKILL_IMPORT_CAPACITY_WAIT })]);
    await detachProjectSkillSource(db, companyId, rows[0]!.id);
    await admitDeferredSkillImports(db, companyId, new Date());
    const [admitted] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, rows.at(-1)!.id));
    expect(admitted).toMatchObject({ active: true, lastError: null });
    const [extra] = await db.insert(projectWorkspaces).values({ companyId, projectId: root.projectId, name: 'Detached waiting repository', repoUrl: root.repoUrl, defaultRef: 'quota-detached' }).returning();
    await enqueueProjectSkillSource(db, extra!);
    await detachProjectSkillSource(db, companyId, extra!.id);
    await detachProjectSkillSource(db, companyId, rows[1]!.id);
    await admitDeferredSkillImports(db, companyId, new Date());
    const [detached] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, extra!.id));
    expect(detached!.active).toBe(false);
    await db.update(projectSkillSources).set({ active: false, lastError: null });
  });

  it('does not reactivate a deferred import detached after admission selection', async () => {
    const row = await workspace('deferred-removal-race');
    const binding = await enqueueProjectSkillSource(db, row);
    await db.update(projectSkillSources).set({ active: false, lastError: SKILL_IMPORT_CAPACITY_WAIT }).where(eq(projectSkillSources.id, binding!.id));
    let detached = false;
    const database = new Proxy(db, { get(target, key) {
      if (key !== 'transaction') return Reflect.get(target, key);
      return (callback: (tx: unknown) => Promise<unknown>) => target.transaction(async tx => callback(new Proxy(tx, { get(target, key) {
        if (key !== 'update') return Reflect.get(target, key);
        return (table: unknown) => {
          const update = target.update(table as typeof projectSkillSources);
          if (table !== projectSkillSources) return update;
          return { set: (values: Parameters<typeof update.set>[0]) => {
            const set = update.set(values);
            return { where: async (condition: Parameters<typeof set.where>[0]) => {
              if (!detached) { detached = true; await detachProjectSkillSource(db, companyId, row.id); }
              return set.where(condition);
            } };
          } };
        };
      } })));
    } });
    await admitDeferredSkillImports(database, companyId, new Date());
    const [saved] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.id, binding!.id));
    expect(detached).toBe(true);
    expect(saved!.active).toBe(false);
    expect(saved!.lastError).toBeNull();
  });

  it('bounds the company pending queue across projects without losing deferred provenance', async () => {
    const projectsToInsert = Array.from({ length: MAX_COMPANY_PENDING_SKILL_IMPORTS + 1 }, (_, index) => ({ id: randomUUID(), companyId, name: `Quota project ${index}` }));
    await db.insert(projects).values(projectsToInsert);
    const workspaces = await db.insert(projectWorkspaces).values(projectsToInsert.map((project, index) => ({ companyId, projectId: project.id,
      name: 'Repository', repoUrl: 'https://github.com/acme/skills', defaultRef: `company-quota-${index}` }))).returning();
    for (const row of workspaces) await enqueueProjectSkillSource(db, row);
    const pending = await db.select().from(projectSkillSources).where(and(eq(projectSkillSources.companyId, companyId), eq(projectSkillSources.active, true)));
    expect(pending.filter(row => !row.sourceId)).toHaveLength(MAX_COMPANY_PENDING_SKILL_IMPORTS);
    const deferred = await db.select().from(projectSkillSources).where(eq(projectSkillSources.lastError, SKILL_IMPORT_CAPACITY_WAIT));
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.workspaceId).toBeTruthy();
    await db.update(projectSkillSources).set({ active: false, lastError: null });
  });

  it('admits another project beyond a full project’s oldest waiting batch', async () => {
    const full = await workspace('full-admission-project');
    const other = await workspace('other-admission-project');
    const rows = await db.insert(projectWorkspaces).values(Array.from({ length: 120 }, (_, index) => ({ companyId, projectId: full.projectId,
      name: `Queued ${index}`, repoUrl: full.repoUrl, defaultRef: `starvation-${index}` }))).returning();
    await db.insert(projectSkillSources).values(rows.map((row, index) => ({ companyId, projectId: row.projectId, workspaceId: row.id,
      repositoryUrl: row.repoUrl!, trackingRef: row.defaultRef!, active: index < 20,
      lastError: index < 20 ? null : SKILL_IMPORT_CAPACITY_WAIT, createdAt: new Date(0) })));
    const [waiting] = await db.insert(projectSkillSources).values({ companyId, projectId: other.projectId, workspaceId: other.id,
      repositoryUrl: other.repoUrl!, trackingRef: other.defaultRef!, active: false, lastError: SKILL_IMPORT_CAPACITY_WAIT }).returning();
    await admitDeferredSkillImports(db, companyId, new Date());
    const [saved] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.id, waiting!.id));
    expect(saved!.active).toBe(true);
    await db.update(projectSkillSources).set({ active: false, lastError: null });
  });

  it('adoption waits for the company queue before taking repository binding locks', async () => {
    const row = await workspace('adoption-lock-order');
    const binding = await enqueueProjectSkillSource(db, row);
    const [source] = await db.insert(companySkillSources).values({ companyId, repositoryUrl: row.repoUrl!, fullName: 'acme/skills', trackingRef: row.defaultRef! }).returning();
    await db.update(projectSkillSources).set({ sourceId: source!.id }).where(eq(projectSkillSources.id, binding!.id));
    let unlock!: () => void, locked!: () => void;
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    let editTx!: typeof db;
    const edit = db.transaction(async tx => { editTx = tx as unknown as typeof db; await lockSkillImportQueue(editTx, companyId); locked(); await release; });
    await ready;
    const adoption = withSkillActor({ type: 'board', source: 'local_implicit', companyIds: [companyId] },
      () => adoptProjectSkillRepository(db, companyId, row.id, context.authorize));
    try {
      await vi.waitFor(async () => {
        const result = await db.execute(sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%companies%for no key update%'`);
        expect(result.length).toBeGreaterThan(0);
      });
      // A repository edit holding the company lock must still be able to lock
      // this binding. The old inverse adoption order fails with lock_not_available.
      await editTx.execute(sql`select id from project_skill_sources where id = ${binding!.id} for update nowait`);
    } finally { unlock(); await edit; await adoption; }
  });

  it('meters failed initial downloads across workers and retries before provider reads', async () => {
    const budgetCompany = randomUUID();
    await db.insert(companies).values({ id: budgetCompany, name: 'Initial work credits', issuePrefix: 'IWC' });
    const [project] = await db.insert(projects).values({ companyId: budgetCompany, name: 'Repeated failed downloads' }).returning();
    const rows = await db.insert(projectWorkspaces).values(Array.from({ length: 5 }, (_, index) => ({ companyId: budgetCompany,
      projectId: project!.id, name: `Failed ${index}`, repoUrl: 'https://github.com/acme/skills', defaultRef: `failed-${index}` }))).returning();
    for (const row of rows) await enqueueProjectSkillSource(db, row);
    const reads = vi.fn(() => {
      const reader = githubFixture({});
      reader.openSnapshot = async () => { throw unprocessable('Git download exceeds 128 MiB.'); };
      return reader;
    });
    const factory = async (setup: { companyId: string }) => setup.companyId === budgetCompany ? { ...context, read: reads } : context;
    const now = new Date();
    try {
      await skillSourceSyncService(db, { context: factory }).tick(now);
      expect(reads).toHaveBeenCalledTimes(4);
      const [budget] = await db.select().from(companySkillImportBudgets).where(eq(companySkillImportBudgets.companyId, budgetCompany));
      expect(budget!.availableBytes).toBe(0);
      const worker = skillSourceSyncService(db, { context: factory });
      await worker.tick(new Date(now.getTime() + 5 * 60_000));
      expect(reads).toHaveBeenCalledTimes(4);
      const waiting = await db.select().from(projectSkillSources).where(eq(projectSkillSources.companyId, budgetCompany));
      expect(waiting.every(row => row.active && row.status === 'error' && row.lastError?.includes('limited'))).toBe(true);
      await worker.tick(new Date(now.getTime() + 15 * 60_000));
      expect(reads).toHaveBeenCalledTimes(5);
    } finally { await db.update(companies).set({ status: 'archived' }).where(eq(companies.id, budgetCompany)); }
  });

  it('refunds measured small initial imports while completed jobs keep a company budget', async () => {
    const budgetCompany = randomUUID();
    await db.insert(companies).values({ id: budgetCompany, name: 'Small initial imports', issuePrefix: 'SII' });
    const [project] = await db.insert(projects).values({ companyId: budgetCompany, name: 'Small repositories' }).returning();
    const rows = await db.insert(projectWorkspaces).values(Array.from({ length: 6 }, (_, index) => ({ companyId: budgetCompany,
      projectId: project!.id, name: `Small ${index}`, repoUrl: 'https://github.com/acme/skills', defaultRef: `small-${index}` }))).returning();
    for (const row of rows) await enqueueProjectSkillSource(db, row);
    const opened = vi.fn();
    const reads = vi.fn(() => {
      const reader = githubFixture({}), open = reader.openSnapshot!;
      reader.openSnapshot = async (...args) => { opened(); return open(...args); };
      return reader;
    });
    try {
      await skillSourceSyncService(db, { context: async setup => setup.companyId === budgetCompany ? { ...context, read: reads } : context }).tick();
      const bindings = await db.select().from(projectSkillSources).where(eq(projectSkillSources.companyId, budgetCompany));
      expect(bindings.every(row => row.status === 'ready' && row.sourceId)).toBe(true);
      expect(opened).toHaveBeenCalledTimes(6);
      const [budget] = await db.select().from(companySkillImportBudgets).where(eq(companySkillImportBudgets.companyId, budgetCompany));
      expect(budget!.availableBytes).toBeGreaterThan(500 * 1024 * 1024);
    } finally { await db.update(companies).set({ status: 'archived' }).where(eq(companies.id, budgetCompany)); }
  });

  it('does not replenish initial work credits when large measured jobs complete', async () => {
    const budgetCompany = randomUUID();
    await db.insert(companies).values({ id: budgetCompany, name: 'Completed work credits', issuePrefix: 'CWC' });
    const [project] = await db.insert(projects).values({ companyId: budgetCompany, name: 'Large measured imports' }).returning();
    const rows = await db.insert(projectWorkspaces).values(Array.from({ length: 5 }, (_, index) => ({ companyId: budgetCompany,
      projectId: project!.id, name: `Measured ${index}`, repoUrl: 'https://github.com/acme/skills', defaultRef: `measured-${index}` }))).returning();
    for (const row of rows) await enqueueProjectSkillSource(db, row);
    const opened = vi.fn();
    const reads = vi.fn(() => {
      const reader = githubFixture({}), open = reader.openSnapshot!;
      reader.openSnapshot = async (...args) => { opened(); return { ...await open(...args), downloadBytes: 128 * 1024 * 1024 }; };
      return reader;
    });
    try {
      await skillSourceSyncService(db, { context: async setup => setup.companyId === budgetCompany ? { ...context, read: reads } : context }).tick();
      const bindings = await db.select().from(projectSkillSources).where(eq(projectSkillSources.companyId, budgetCompany));
      expect(bindings.filter(row => row.status === 'ready' && row.sourceId)).toHaveLength(4);
      expect(bindings.filter(row => row.status === 'error' && row.lastError?.includes('limited'))).toHaveLength(1);
      expect(opened).toHaveBeenCalledTimes(4);
      const [budget] = await db.select().from(companySkillImportBudgets).where(eq(companySkillImportBudgets.companyId, budgetCompany));
      expect(budget!.availableBytes).toBe(0);
    } finally { await db.update(companies).set({ status: 'archived' }).where(eq(companies.id, budgetCompany)); }
  });

  it('never counts refill time twice when an older sweep reserves after a newer one', async () => {
    const row = await workspace('monotonic-initial-work');
    const binding = await enqueueProjectSkillSource(db, row);
    const token = randomUUID();
    await db.update(projectSkillSources).set({ leaseToken: token }).where(eq(projectSkillSources.id, binding!.id));
    await db.delete(companySkillImportBudgets).where(eq(companySkillImportBudgets.companyId, companyId));
    const older = new Date(), newer = new Date(older.getTime() + 15 * 60_000);
    try {
      await reserveInitialSkillWork(db, binding!, token, newer);
      await reserveInitialSkillWork(db, binding!, token, older);
      const [afterOlder] = await db.select().from(companySkillImportBudgets).where(eq(companySkillImportBudgets.companyId, companyId));
      expect(afterOlder!.updatedAt).toEqual(newer);
      await reserveInitialSkillWork(db, binding!, token, newer);
      const [saved] = await db.select().from(companySkillImportBudgets).where(eq(companySkillImportBudgets.companyId, companyId));
      expect(saved!.availableBytes).toBe(128 * 1024 * 1024);
    } finally {
      await detachProjectSkillSource(db, companyId, row.id);
      await db.delete(companySkillImportBudgets).where(eq(companySkillImportBudgets.companyId, companyId));
    }
  });

  it('does not adopt a stale repository after an editor commits a new selection', async () => {
    const row = await workspace('adoption-stale-selection');
    await enqueueProjectSkillSource(db, row);
    try {
      await withSkillActor({ type: 'board', source: 'local_implicit', companyIds: [companyId] }, async () => {
        await expect(adoptProjectSkillRepository(db, companyId, row.id, async () => {
          await projectService(db).updateWorkspace(row.projectId, row.id, { repoUrl: 'https://github.com/acme/skills-next', defaultRef: 'edited-branch' });
        })).rejects.toThrow(/repository changed/i);
      });
      const saved = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, row.id));
      expect(saved.find(binding => binding.trackingRef === 'edited-branch')!.active).toBe(true);
      expect(saved.find(binding => binding.trackingRef === row.defaultRef)!.active).toBe(false);
    } finally { await detachProjectSkillSource(db, companyId, row.id); }
  });

  it('does not read GitHub or retry an initial job denied by import policy', async () => {
    await db.update(companySkillSources).set({ automaticUpdates: false });
    const row = await workspace('denied-preflight');
    await enqueueProjectSkillSource(db, row);
    const read = vi.fn(context.read);
    const worker = skillSourceSyncService(db, { context: async () => ({ ...context, read,
      authorize: async () => { throw forbidden('Skill import denied by policy.'); } }) });
    expect((await worker.tick()).imported).toBe(0);
    expect(read).not.toHaveBeenCalled();
    const [blocked] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, row.id));
    expect(blocked).toMatchObject({ active: false, status: 'error', sourceId: null });
    await worker.tick(new Date(Date.now() + 60 * 60_000));
    expect(read).not.toHaveBeenCalled();
  });

  it('does not add readers when an import overlaps private source removal', async () => {
    files = { 'race/SKILL.md': md('race workflow') };
    const originalWorkspace = await workspace('removal-race', 'private');
    await enqueueProjectSkillSource(db, originalWorkspace);
    await skillSourceSyncService(db, { context: async () => context }).tick();
    const [origin] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, originalWorkspace.id));
    const sources = skillSourceService(db), skills = companySkillService(db);
    const source = await sources.detail(companyId, origin!.sourceId!);
    const skillId = source.entries[0]!.skillId!;
    const pendingWorkspace = await workspace('removal-race', 'open');
    await enqueueProjectSkillSource(db, pendingWorkspace);
    let removed = false, authorizations = 0;
    const racingContext = { ...context, authorize: async () => {
      if (++authorizations !== 2 || removed) return;
      removed = true;
      await sources.disconnect(companyId, source.id, context, { revision: source.revision, skills: 'copy' });
      await skills.updateFile(companyId, skillId, 'SKILL.md', md('Restricted race edits'));
    } };
    const worker = skillSourceSyncService(db, { context: async () => racingContext });
    expect((await worker.tick()).imported).toBe(0);
    const [pending] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, pendingWorkspace.id));
    expect(pending).toMatchObject({ sourceId: null, status: 'error' });
    const readerId = randomUUID();
    await db.insert(authUsers).values({ id: readerId, name: 'Open reader', email: `${readerId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: 'user', principalId: readerId, membershipRole: 'member', status: 'active' });
    await withSkillActor(actor(readerId), async () => {
      expect(await skills.getById(companyId, skillId)).toBeNull();
      expect(await skills.readFile(companyId, skillId, 'SKILL.md')).toBeNull();
    });
    expect((await worker.tick(new Date(Date.now() + 6 * 60_000))).imported).toBe(1);
    const [retried] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, pendingWorkspace.id));
    expect(retried!.sourceId).not.toBe(source.id);
  });

  it('imports after durable enqueue, imports later additions and avoids unchanged downloads', async () => {
    files = { 'one/SKILL.md': md('one') }; commit = 'a'.repeat(40); downloads.mockClear();
    const row = await workspace('automatic');
    const binding = await enqueueProjectSkillSource(db, row);
    await enqueueProjectSkillSource(db, row);
    expect(await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, row.id))).toHaveLength(1);
    expect((await db.select().from(companySkillSources)).filter(source => source.trackingRef === 'automatic')).toHaveLength(0);
    const worker = skillSourceSyncService(db, { context: async () => context });
    expect((await worker.tick()).imported).toBe(1);
    const [ready] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.id, binding!.id));
    const sourceId = ready!.sourceId!;
    const first = await skillSourceService(db).detail(companyId, sourceId);
    expect(first.accessScope).toBe('projects');
    expect(first.importNewSkills).toBe(true);
    const installedId = first.entries[0]!.skillId!;
    const original = (await companySkillService(db).getById(companyId, installedId))!;
    expect(original.accessSourceId).toBe(sourceId);
    const downloadCount = downloads.mock.calls.length;
    await worker.tick(new Date(Date.now() + 6 * 60_000));
    expect(downloads).toHaveBeenCalledTimes(downloadCount);
    files['one/SKILL.md'] = md('one improved'); files['two/SKILL.md'] = md('two'); commit = 'b'.repeat(40);
    await worker.tick(new Date(Date.now() + 6 * 60_000));
    const updated = await skillSourceService(db).detail(companyId, sourceId);
    expect(updated.entries.filter(entry => entry.skillId)).toHaveLength(2);
    const latest = (await companySkillService(db).getById(companyId, installedId))!;
    expect(latest.id).toBe(original.id);
    expect(latest.currentVersionId).not.toBe(original.currentVersionId);
    const pinned = await companySkillService(db).getVersion(companyId, installedId, original.currentVersionId!);
    expect(pinned!.fileInventory.find(file => file.path === 'SKILL.md')!.content).toBe(md('one'));
    await detachProjectSkillSource(db, companyId, row.id);
    const before = downloads.mock.calls.length;
    await worker.tick(new Date(Date.now() + 6 * 60_000));
    expect(downloads).toHaveBeenCalledTimes(before);
    expect(await companySkillService(db).getById(companyId, installedId)).not.toBeNull();
    expect(await skillSourceService(db).detail(companyId, sourceId)).toMatchObject({ trackingActive: false, syncState: 'paused' });
  });

  it('watches empty repositories, retains folder exclusions and coalesces worker sweeps', async () => {
    files = {}; commit = 'c'.repeat(40);
    const row = await workspace('empty');
    await enqueueProjectSkillSource(db, row);
    const worker = skillSourceSyncService(db, { context: async () => context });
    const first = worker.tick();
    expect(worker.tick()).toBe(first);
    await first;
    const [binding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, row.id));
    expect(binding!.status).toBe('ready');
    const service = skillSourceService(db);
    const source = await service.detail(companyId, binding!.sourceId!);
    await service.refresh(companyId, source.id, context, { revision: source.revision, selectedPaths: [], excludedFolders: ['excluded'] });
    files = { 'excluded/secret/SKILL.md': md('excluded'), 'new/SKILL.md': md('new') }; commit = 'd'.repeat(40);
    await worker.tick(new Date(Date.now() + 6 * 60_000));
    const result = await service.detail(companyId, source.id);
    expect(result.entries.find(entry => entry.path === 'new/SKILL.md')!.skillId).toBeTruthy();
    expect(result.entries.find(entry => entry.path.includes('secret'))!.selection).toBe('excluded');
  });

  it('inherits either project access, rechecks revocation and fails closed after project deletion', async () => {
    files = { 'private/SKILL.md': md('private workflow') }; commit = 'e'.repeat(40);
    const row = await workspace('private', 'private');
    await enqueueProjectSkillSource(db, row);
    await skillSourceSyncService(db, { context: async () => context }).tick();
    const [binding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, row.id));
    expect(binding!.status, binding!.lastError ?? 'initial private binding').toBe('ready');
    const source = await skillSourceService(db).detail(companyId, binding!.sourceId!);
    const skillId = source.entries[0]!.skillId!;
    let privateSnapshotPath = '';
    const privateDerivatives: string[] = [];
    for (const user of ['alice', 'bob']) {
      await db.insert(authUsers).values({ id: user, name: user, email: `${user}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: 'user', principalId: user, membershipRole: 'member', status: 'active' });
    }
    await db.insert(projectAccessMembers).values({ companyId, projectId: row.projectId, subjectType: 'user', subjectId: 'alice' });
    await withSkillActor(actor('alice'), async () => {
      expect(await companySkillService(db).getById(companyId, skillId)).not.toBeNull();
      expect((await companySkillService(db).list(companyId)).some(skill => skill.id === skillId)).toBe(true);
      const skill = (await companySkillService(db).getById(companyId, skillId))!;
      const [runtime] = await companySkillService(db).listRuntimeSkillEntries(companyId, { onlyKeys: new Set([skill.key]) });
      privateSnapshotPath = runtime!.source;
      await expect(companySkillService(db).importFromSource(companyId, runtime!.source)).rejects.toThrow(/Project-derived skill/);
      const fork = await companySkillService(db).forkSkill(companyId, skillId, { slug: 'private-copy' });
      expect(fork.skill.accessSourceId).not.toBe(source.id);
      expect(fork.skill.accessSourceId).toBeTruthy();
      privateDerivatives.push(fork.skill.id);
      await expect(companySkillService(db).updateSkill(companyId, fork.skill.id, { sharingScope: 'public_link' })).rejects.toThrow(/public link/);
      const copy = await companySkillService(db).createLocalSkill(companyId, { name: 'Private derived copy', forkedFromSkillId: skillId });
      expect(copy.accessSourceId).not.toBe(source.id);
      expect(copy.accessSourceId).toBeTruthy();
      privateDerivatives.push(copy.id);
      await expect(companySkillService(db).createLocalSkill(companyId, { name: 'Unsafe publication', forkedFromSkillId: skillId, sharingScope: 'public_link' })).rejects.toThrow(/public link/);
    });
    await withSkillActor(actor('bob'), async () => {
      await expect(companySkillService(db).importFromSource(companyId, privateSnapshotPath)).rejects.toThrow(/not found/);
      expect(await companySkillService(db).getById(companyId, skillId)).toBeNull();
      expect(await companySkillService(db).readFile(companyId, skillId, 'SKILL.md')).toBeNull();
      expect((await skillSourceService(db).list(companyId)).some(item => item.id === source.id)).toBe(false);
      await expect(skillAccessService(db).assertSkill(companyId, skillId)).rejects.toThrow(/not found/);
    });
    const [reader] = await db.insert(agents).values({ companyId, name: 'Private skill reader', adapterType: 'codex_local', status: 'idle' }).returning();
    const [outsider] = await db.insert(agents).values({ companyId, name: 'Unassigned reader', adapterType: 'codex_local', status: 'idle' }).returning();
    for (const agent of [reader!, outsider!]) await db.insert(companyMemberships).values({ companyId, principalType: 'agent', principalId: agent.id, membershipRole: 'member', status: 'active' });
    await db.insert(projectAccessMembers).values({ companyId, projectId: row.projectId, subjectType: 'agent', subjectId: reader!.id });
    const agentActor = (agentId: string, userId: string): AuthorizationActor => ({
      type: 'agent', source: 'agent_jwt', companyId, agentId, runId: randomUUID(), onBehalfOfUserId: userId,
    });
    await withSkillActor(agentActor(reader!.id, 'alice'), async () => {
      expect(await companySkillService(db).readFile(companyId, skillId, 'SKILL.md')).not.toBeNull();
      const skill = (await companySkillService(db).getById(companyId, skillId))!;
      expect(await companySkillService(db).getVersion(companyId, skillId, skill.currentVersionId!)).not.toBeNull();
      expect((await companySkillService(db).listRuntimeSkillEntries(companyId)).some(entry => entry.key === skill.key)).toBe(true);
    });
    for (const denied of [agentActor(reader!.id, 'bob'), agentActor(outsider!.id, 'alice'), { ...agentActor(reader!.id, 'alice'), companyId: randomUUID() }]) {
      await withSkillActor(denied, async () => {
        expect(await companySkillService(db).readFile(companyId, skillId, 'SKILL.md')).toBeNull();
        expect((await companySkillService(db).listRuntimeSkillEntries(companyId)).some(entry => entry.key.includes('private'))).toBe(false);
      });
    }
    const second = await workspace('private', 'private');
    await db.insert(projectAccessMembers).values({ companyId, projectId: second.projectId, subjectType: 'user', subjectId: 'bob' });
    await enqueueProjectSkillSource(db, second);
    await skillSourceSyncService(db, { context: async () => context }).tick();
    const [linked] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, second.id));
    expect(linked!.status, linked!.lastError ?? 'second project binding').toBe('ready');
    expect(linked!.sourceId).toBe(source.id);
    await withSkillActor(actor('bob'), async () => expect(await companySkillService(db).getById(companyId, skillId)).not.toBeNull());
    await db.delete(projectAccessMembers).where(and(eq(projectAccessMembers.projectId, second.projectId), eq(projectAccessMembers.subjectId, 'bob')));
    await withSkillActor(actor('bob'), async () => expect(await companySkillService(db).getById(companyId, skillId)).toBeNull());
    const opened = await workspace('private', 'open');
    await enqueueProjectSkillSource(db, opened);
    await skillSourceSyncService(db, { context: async () => context }).tick();
    await withSkillActor(actor('bob'), async () => {
      expect(await companySkillService(db).getById(companyId, skillId)).not.toBeNull();
      for (const derivativeId of privateDerivatives) {
        expect(await companySkillService(db).getById(companyId, derivativeId)).toBeNull();
        expect(await companySkillService(db).readFile(companyId, derivativeId, 'SKILL.md')).toBeNull();
      }
    });
    await withSkillActor(agentActor(reader!.id, 'bob'), async () => {
      expect(await companySkillService(db).getById(companyId, skillId)).not.toBeNull();
      for (const derivativeId of privateDerivatives) expect(await companySkillService(db).getById(companyId, derivativeId)).toBeNull();
    });
    await db.delete(projects).where(eq(projects.id, row.projectId));
    await db.delete(projects).where(eq(projects.id, second.projectId));
    await withSkillActor(actor('alice'), async () => {
      for (const id of privateDerivatives) expect(await companySkillService(db).getById(companyId, id)).toBeNull();
    });
    await db.delete(projects).where(eq(projects.id, opened.projectId));
    await withSkillActor(actor('alice'), async () => expect(await companySkillService(db).getById(companyId, skillId)).toBeNull());
    expect((await db.select().from(companySkills).where(eq(companySkills.id, skillId)))[0]!.accessSourceId).toBe(source.id);
  });

  it.each(['copy', 'delete'] as const)('removes project tracking with %s while retaining dynamic copy/fork access', async choice => {
    files = { 'private/SKILL.md': md('retained private workflow') }; commit = '9'.repeat(40);
    const row = await workspace(`removed-${choice}`, 'private');
    await enqueueProjectSkillSource(db, row);
    const worker = skillSourceSyncService(db, { context: async () => context });
    await worker.tick();
    const [binding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, row.id));
    const service = skillSourceService(db), skills = companySkillService(db);
    const source = await service.detail(companyId, binding!.sourceId!);
    const original = (await skills.getById(companyId, source.entries[0]!.skillId!))!;
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: 'Source owner', email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: 'user', principalId: userId, membershipRole: 'member', status: 'active' });
    await db.insert(projectAccessMembers).values({ companyId, projectId: row.projectId, subjectType: 'user', subjectId: userId });
    await withSkillActor(actor(userId), async () => {
      const fork = await skills.forkSkill(companyId, original.id, { slug: `retained-${choice}-fork` });
      await skills.updateFile(companyId, fork.skill.id, 'SKILL.md', md('Private fork edits') + '\nConfidential original-project notes.\n');
      const result = await service.disconnect(companyId, source.id, context, { revision: source.revision, skills: choice });
      expect(result).toMatchObject({ copiedCount: choice === 'copy' ? 1 : 0, deletedCount: choice === 'delete' ? 1 : 0 });
      await expect(service.detail(companyId, source.id)).rejects.toThrow(/not found/);
      expect((await service.list(companyId)).some(item => item.id === source.id)).toBe(false);
      expect((await projectSkillRepositories(db, companyId, actor(userId))).find(item => item.workspaceId === row.id)).toMatchObject({ sourceId: null, status: 'available' });
      expect(await skills.getById(companyId, fork.skill.id)).not.toBeNull();
      let retainedVersionId = original.currentVersionId;
      if (choice === 'copy') {
        expect(await skills.getById(companyId, original.id)).toMatchObject({ sourceType: 'local_path', accessSourceId: source.id });
        expect((await skills.readFile(companyId, original.id, '.paperclip-repository/private/SKILL.md'))?.content).toBe(md('retained private workflow'));
        expect((await skills.readFile(companyId, original.id, 'SKILL.md'))?.content).toContain('.paperclip-repository/private/SKILL.md');
        await skills.updateFile(companyId, original.id, 'SKILL.md', md('Private copy edits') + '\nConfidential original-project notes.\n');
        retainedVersionId = (await skills.createVersion(companyId, original.id, { label: 'Private edited copy' })).id;
      } else expect(await skills.getById(companyId, original.id)).toBeNull();
      await db.update(companySkillSources).set({ automaticUpdates: false }).where(eq(companySkillSources.companyId, companyId));
      const before = downloads.mock.calls.length;
      await worker.tick(new Date(Date.now() + 6 * 60_000));
      expect(downloads).toHaveBeenCalledTimes(before);
      // Reattachment retains disconnection; adoption is the deliberate restart action.
      await enqueueProjectSkillSource(db, row);
      await worker.tick(new Date(Date.now() + 6 * 60_000));
      expect(downloads).toHaveBeenCalledTimes(before);
      const legacy = await workspace(`removed-${choice}`, 'open');
      await db.insert(projectAccessMembers).values({ companyId, projectId: legacy.projectId, subjectType: 'user', subjectId: userId });
      // This older workspace has no binding/source ID; one explicit adoption must work.
      await adoptProjectSkillRepository(db, companyId, legacy.id, context.authorize);
      await worker.tick(new Date(Date.now() + 6 * 60_000));
      await expect(service.detail(companyId, source.id)).rejects.toThrow(/not found/);
      const [adopted] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, legacy.id));
      expect(adopted!.status, adopted!.lastError ?? 'adopted binding').toBe('ready');
      expect(adopted!.sourceId).toBeTruthy();
      expect(adopted!.sourceId).not.toBe(source.id);
      const restored = await service.detail(companyId, adopted!.sourceId!);
      expect(restored.enabled).toBe(true);
      expect(restored.lastError).toBeNull();
      expect(restored.entries.filter(entry => entry.skillId)).toHaveLength(1);
      expect(restored.entries[0]!.skillId).not.toBe(original.id);
      if (choice === 'copy') expect(await skills.getById(companyId, original.id)).toMatchObject({ key: original.key, sourceType: 'local_path', currentVersionId: retainedVersionId });
      const readerId = randomUUID();
      await db.insert(authUsers).values({ id: readerId, name: 'Open project reader', email: `${readerId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: 'user', principalId: readerId, membershipRole: 'member', status: 'active' });
      await withSkillActor(actor(readerId), async () => {
        const upstream = restored.entries[0]!.skillId!;
        expect(await skills.getById(companyId, upstream)).not.toBeNull();
        expect(await skills.getById(companyId, fork.skill.id)).toBeNull();
        expect(await skills.readFile(companyId, fork.skill.id, 'SKILL.md')).toBeNull();
        if (choice === 'copy') {
          expect(await skills.getById(companyId, original.id)).toBeNull();
          expect(await skills.readFile(companyId, original.id, 'SKILL.md')).toBeNull();
          expect(await skills.getVersion(companyId, original.id, retainedVersionId!)).toBeNull();
        }
        expect((await skills.readFile(companyId, upstream, '.paperclip-repository/private/SKILL.md'))?.content).not.toContain('Confidential');
        // A guessed hidden slug cannot replace or erase someone else's private fork.
        const publicFork = await skills.forkSkill(companyId, upstream, { slug: `retained-${choice}-fork` });
        expect(publicFork.skill.id).not.toBe(fork.skill.id);
        expect(publicFork.skill.slug).not.toBe(fork.skill.slug);
      });
      expect((await skills.readFile(companyId, fork.skill.id, 'SKILL.md'))?.content).toContain('Confidential original-project notes');
      // Explicit adoption of the original workspace also moves tracking, not provenance.
      await adoptProjectSkillRepository(db, companyId, row.id, context.authorize);
      await worker.tick(new Date(Date.now() + 6 * 60_000));
      const [rebound] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, row.id));
      expect(rebound!.sourceId).toBe(restored.id);
      expect(await skills.getById(companyId, fork.skill.id)).not.toBeNull();
      await db.delete(projects).where(eq(projects.id, legacy.projectId));
      await db.delete(projectAccessMembers).where(and(eq(projectAccessMembers.projectId, row.projectId), eq(projectAccessMembers.subjectId, userId)));
      expect(await skills.getById(companyId, fork.skill.id)).toBeNull();
      if (choice === 'copy') expect(await skills.getById(companyId, original.id)).toBeNull();
      await db.delete(projects).where(eq(projects.id, row.projectId));
      expect(await skills.getById(companyId, fork.skill.id)).toBeNull();
    });
  });

  it('recovers expired jobs, competes through durable leases and respects failed-refresh backoff', async () => {
    await db.update(companySkillSources).set({ automaticUpdates: false });
    files = { 'leased/SKILL.md': md('leased') }; commit = 'f'.repeat(40);
    const row = await workspace('leased');
    const binding = await enqueueProjectSkillSource(db, row);
    await db.update(projectSkillSources).set({ leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(projectSkillSources.id, binding!.id));
    let release!: () => void, scanned!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { scanned = resolve; });
    const blocking: SkillSourceContext = { ...context, read: () => {
      const fixture = context.read(null), open = fixture.openSnapshot!;
      fixture.openSnapshot = async (...args) => { scanned(); await gate; return open(...args); };
      return fixture;
    } };
    const first = skillSourceSyncService(db, { context: async () => blocking }).tick();
    await started;
    expect((await skillSourceSyncService(db, { context: async () => context }).tick()).imported).toBe(0);
    release(); expect((await first).imported).toBe(1);
    const [ready] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.id, binding!.id));
    const sourceId = ready!.sourceId!;
    const service = skillSourceService(db);
    const original = await service.detail(companyId, sourceId);
    const failure: SkillSourceContext = { ...context, read: () => (async () => {
      throw unprocessable('GitHub request limit reached.', { retryAfterMs: 7_200_000 });
    }) as ReturnType<SkillSourceContext['read']> };
    const failedAt = new Date();
    await db.update(companySkillSources).set({ nextSyncAt: failedAt }).where(eq(companySkillSources.id, sourceId));
    await skillSourceSyncService(db, { context: async () => failure }).tick(failedAt);
    const [failed] = await db.select().from(companySkillSources).where(eq(companySkillSources.id, sourceId));
    expect(failed!.failureCount).toBe(1);
    expect(failed!.nextSyncAt.getTime() - failedAt.getTime()).toBeGreaterThanOrEqual(7_200_000);
    expect((await service.detail(companyId, sourceId)).entries[0]!.skillId).toBe(original.entries[0]!.skillId);
    const retryRead = vi.fn(context.read);
    await skillSourceSyncService(db, { context: async () => ({ ...context, read: retryRead }) })
      .tick(new Date(failedAt.getTime() + 6 * 60_000));
    expect(retryRead).not.toHaveBeenCalled();
    await db.update(companySkillSources).set({ automaticUpdates: false, nextSyncAt: new Date() }).where(eq(companySkillSources.id, sourceId));
    await skillSourceSyncService(db, { context: async () => ({ ...context, read: retryRead }) }).tick();
    expect(retryRead).not.toHaveBeenCalled();
  });

  it('skips live leases before bounding import and refresh batches', async () => {
    await db.update(companySkillSources).set({ automaticUpdates: false });
    files = { 'fair/SKILL.md': md('fair') }; commit = '9'.repeat(40);
    const now = new Date();
    const expires = new Date(now.getTime() + 60 * 60_000);
    const busyJobs: string[] = [];
    for (let index = 0; index < 10; index++) {
      const row = await workspace(`busy-import-${index}`);
      const binding = await enqueueProjectSkillSource(db, row);
      busyJobs.push(binding!.id);
      await db.update(projectSkillSources).set({ leaseToken: randomUUID(), leaseExpiresAt: expires,
        nextSyncAt: new Date(now.getTime() - (20 - index) * 1_000) }).where(eq(projectSkillSources.id, binding!.id));
    }
    const ready = await enqueueProjectSkillSource(db, await workspace('ready-import'));
    await db.update(projectSkillSources).set({ nextSyncAt: now }).where(eq(projectSkillSources.id, ready!.id));
    const worker = skillSourceSyncService(db, { context: async () => context });
    expect((await worker.tick(now)).imported).toBe(1);
    const [imported] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.id, ready!.id));
    expect(imported!.sourceId).toBeTruthy();
    for (const id of busyJobs) {
      const [job] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.id, id));
      expect(job).toMatchObject({ sourceId: null, leaseExpiresAt: expires, status: 'pending' });
    }

    const [template] = await db.select().from(companySkillSources).where(eq(companySkillSources.id, imported!.sourceId!));
    await db.update(companySkillSources).set({ automaticUpdates: false });
    const readySourceId = randomUUID();
    await db.insert(companySkillSources).values(Array.from({ length: 11 }, (_, index) => ({
      ...template!, id: index === 10 ? readySourceId : randomUUID(), trackingRef: `fair-refresh-${index}`,
      accessScope: 'company' as const, automaticUpdates: true, nextSyncAt: new Date(now.getTime() - (20 - index) * 1_000),
      leaseToken: index === 10 ? null : randomUUID(), leaseExpiresAt: index === 10 ? null : expires,
    })));
    expect((await worker.tick(now)).checked).toBe(1);
    const [refreshed] = await db.select().from(companySkillSources).where(eq(companySkillSources.id, readySourceId));
    expect(refreshed!.nextSyncAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it('releases interrupted initial imports so a new worker can recover them', async () => {
    await db.update(companySkillSources).set({ automaticUpdates: false });
    files = { 'recovered/SKILL.md': md('recovered') }; commit = '1'.repeat(40);
    const row = await workspace('restart');
    const binding = await enqueueProjectSkillSource(db, row);
    let scanned!: () => void;
    const started = new Promise<void>(resolve => { scanned = resolve; });
    const blocking: SkillSourceContext = { ...context, read: () => {
      const fixture = context.read(null);
      fixture.openSnapshot = async (_input, options) => {
        scanned();
        await new Promise<void>((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
        });
        throw new Error('Unreachable');
      };
      return fixture;
    } };
    const worker = skillSourceSyncService(db, { context: async () => blocking });
    const sweep = worker.tick();
    await started;
    await worker.stop();
    await sweep;
    const [interrupted] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.id, binding!.id));
    expect(interrupted).toMatchObject({ status: 'pending', failureCount: 0, sourceId: null, leaseToken: null, lastError: null });
    expect((await skillSourceSyncService(db, { context: async () => context }).tick()).imported).toBe(1);
  });

  it('keeps deleted setup agents attributable and requires explicit connection repair', async () => {
    await db.update(companySkillSources).set({ automaticUpdates: false });
    files = { 'owned/SKILL.md': md('owned') }; commit = '2'.repeat(40);
    const row = await workspace('deleted-owner');
    const [owner] = await db.insert(agents).values({ companyId, name: 'Source setup agent', adapterType: 'codex_local', status: 'idle' }).returning();
    await enqueueProjectSkillSource(db, row);
    const ownerContext: SkillSourceContext = { ...context, setup: { userId: 'local-board', localTrusted: true, agentId: owner!.id } };
    await skillSourceSyncService(db, { context: async () => ownerContext }).tick();
    const [binding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, row.id));
    const sourceId = binding!.sourceId!;
    await db.delete(agents).where(eq(agents.id, owner!.id));
    await db.update(companySkillSources).set({ nextSyncAt: new Date() }).where(eq(companySkillSources.id, sourceId));
    const [before] = await db.select().from(companySkillSources).where(eq(companySkillSources.id, sourceId));
    expect(before!.refreshAgentId).toBe(owner!.id);
    await skillSourceSyncService(db).tick();
    const [failed] = await db.select().from(companySkillSources).where(eq(companySkillSources.id, sourceId));
    expect(failed!.lastError).toContain('agent who connected');
    expect(failed!.failureCount).toBe(1);
    expect((await skillSourceService(db).detail(companyId, sourceId)).entries[0]!.skillId).toBeTruthy();
  });

  it('backs off a policy denial before acquiring a source lease', async () => {
    await db.update(companySkillSources).set({ automaticUpdates: false });
    files = { 'policy/SKILL.md': md('policy') }; commit = '3'.repeat(40);
    const row = await workspace('policy-denial');
    await enqueueProjectSkillSource(db, row);
    await skillSourceSyncService(db, { context: async () => context }).tick();
    const [binding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, row.id));
    const now = new Date();
    await db.update(companySkillSources).set({ nextSyncAt: now }).where(eq(companySkillSources.id, binding!.sourceId!));
    const authorize = vi.fn(async () => { throw unprocessable('Automatic updates are denied by company policy.'); });
    const worker = skillSourceSyncService(db, { context: async () => ({ ...context, authorize }) });
    await worker.tick(now);
    const [failed] = await db.select().from(companySkillSources).where(eq(companySkillSources.id, binding!.sourceId!));
    expect(failed).toMatchObject({ failureCount: 1, leaseToken: null, lastError: 'Automatic updates are denied by company policy.' });
    expect(failed!.nextSyncAt.getTime()).toBeGreaterThan(now.getTime());
    await worker.tick(new Date(now.getTime() + 1000));
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it('uses bounded skill packages when a tracked repository outgrows the repository limit', async () => {
    await db.update(companySkillSources).set({ automaticUpdates: false });
    files = { 'small/SKILL.md': md('small') }; commit = '4'.repeat(40);
    const row = await workspace('growing-repository');
    await enqueueProjectSkillSource(db, row);
    await skillSourceSyncService(db, { context: async () => context }).tick();
    const [binding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, row.id));
    const service = skillSourceService(db), original = await service.detail(companyId, binding!.sourceId!);
    expect(original.packageMode).toBe('repository');
    const skillId = original.entries[0]!.skillId!;
    files['small/SKILL.md'] = md('small updated'); commit = '5'.repeat(40);
    const growing: SkillSourceContext = { ...context, read: () => {
      const fixture = context.read(null), open = fixture.openSnapshot;
      fixture.openSnapshot = async (...args) => {
        const snapshot = await open(...args);
        for (let index = 0; index < 10000; index++) snapshot.entries.push({ path: `unrelated/${index}.txt`, type: 'blob', mode: '100644', sha: String(index + 1), size: 0 });
        return snapshot;
      };
      return fixture;
    } };
    const result = await service.refresh(companyId, original.id, growing);
    expect(result.source.packageMode).toBe('skills');
    expect(result.warnings.join(' ')).toContain('repository exceeds');
    expect(result.source.entries[0]!.skillId).toBe(skillId);
    expect(result.updated).toHaveLength(1);
    files = { 'small/SKILL.md': md('small with shared guide') + '\nRead [guide](../shared/guide.md).', 'shared/guide.md': 'Now fits in the repository package.' };
    commit = '6'.repeat(40);
    const complete = await service.refresh(companyId, original.id, context);
    expect(complete.source.packageMode).toBe('repository');
    expect(complete.source.entries.find(entry => entry.path === 'small/SKILL.md')!.skillId).toBe(skillId);
    expect((await companySkillService(db).readFile(companyId, skillId, '.paperclip-repository/shared/guide.md'))?.content)
      .toBe('Now fits in the repository package.');
  });

  it('enqueues repository changes atomically, leaves ordinary legacy edits alone and retains old references', async () => {
    await db.update(companySkillSources).set({ automaticUpdates: false });
    const legacy = await workspace('lifecycle');
    const service = projectService(db, { captureWorkspaceUpdates: false });
    await service.updateWorkspace(legacy.projectId, legacy.id, { name: 'Renamed older workspace' });
    expect(await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, legacy.id))).toHaveLength(0);

    await expect(db.transaction(async tx => {
      await projectService(tx as unknown as typeof db, { captureWorkspaceUpdates: false }).createWorkspace(legacy.projectId,
        { repoUrl: 'https://github.com/acme/skills', defaultRef: 'rolled-back' });
      throw new Error('Required project audit failed');
    })).rejects.toThrow('Required project audit failed');
    expect(await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.defaultRef, 'rolled-back'))).toHaveLength(0);
    expect(await db.select().from(projectSkillSources).where(eq(projectSkillSources.trackingRef, 'rolled-back'))).toHaveLength(0);

    files = { 'lifecycle/SKILL.md': md('lifecycle') }; commit = '6'.repeat(40);
    const created = (await service.createWorkspace(legacy.projectId,
      { repoUrl: 'https://github.com/acme/skills', defaultRef: 'lifecycle-created' }))!;
    const worker = skillSourceSyncService(db, { context: async () => context });
    await worker.tick();
    const [originalBinding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, created.id));
    const source = await skillSourceService(db).detail(companyId, originalBinding!.sourceId!);
    const skillId = source.entries[0]!.skillId!;
    const versionId = (await companySkillService(db).getById(companyId, skillId))!.currentVersionId;

    await service.updateWorkspace(legacy.projectId, created.id, { defaultRef: 'lifecycle-next' });
    await worker.tick();
    const bindings = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, created.id));
    expect(bindings).toHaveLength(2);
    expect(bindings.find(binding => binding.id === originalBinding!.id)?.active).toBe(false);
    const current = bindings.find(binding => binding.active)!;
    expect(current.sourceId).not.toBe(source.id);
    const retained = (await companySkillService(db).getById(companyId, skillId))!;
    expect(retained.currentVersionId).toBe(versionId);
    const newSource = await skillSourceService(db).detail(companyId, current.sourceId!);
    expect(newSource.entries[0]!.skillId).not.toBe(skillId);

    await service.updateWorkspace(legacy.projectId, created.id, { defaultRef: 'lifecycle-next' });
    expect(await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, created.id))).toHaveLength(2);
    await service.removeWorkspace(legacy.projectId, created.id);
    expect(await skillSourceService(db).detail(companyId, current.sourceId!)).toMatchObject({ trackingActive: false });
    expect(await companySkillService(db).getById(companyId, skillId)).not.toBeNull();
  });

  it('lets API-key agents attach repositories without inventing a setup person', async () => {
    await db.update(companySkillSources).set({ automaticUpdates: false });
    const project = await workspace('key-agent-parent');
    const [agent] = await db.insert(agents).values({ companyId, name: 'API-key project creator', adapterType: 'codex_local', status: 'idle' }).returning();
    const keyActor: AuthorizationActor = { type: 'agent', source: 'agent_key', agentId: agent!.id, companyId, onBehalfOfUserId: 'unverified-person' };
    const attached = await withSkillActor(keyActor, () => projectService(db, { captureWorkspaceUpdates: false }).createWorkspace(project.projectId,
      { repoUrl: 'https://github.com/acme/skills', defaultRef: 'key-agent' }));
    expect(attached).not.toBeNull();
    const [binding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, attached!.id));
    expect(binding).toMatchObject({ status: 'pending', refreshUserId: null, refreshAgentId: agent!.id, refreshLocalTrusted: false, sourceId: null });
    await detachProjectSkillSource(db, companyId, attached!.id);
  });

  it('requires connection repair before scheduled refresh of API-key public imports', async () => {
    await db.update(companySkillSources).set({ automaticUpdates: false });
    files = {};
    const [agent] = await db.insert(agents).values({ companyId, name: 'API-key source importer', adapterType: 'codex_local', status: 'idle' }).returning();
    const setup = await projectSkillSetupIdentity(db, companyId, { type: 'agent', source: 'agent_key', companyId,
      agentId: agent!.id, onBehalfOfUserId: 'local-board' });
    const imported = await skillSourceService(db).create(companyId, { repositoryUrl: 'https://github.com/acme/skills',
      trackingRef: 'key-generic-public', commitSha: commit, selectedPaths: [] }, { ...context,
      actor: { type: 'agent', agentId: agent!.id }, setup: { userId: setup.refreshUserId, agentId: setup.refreshAgentId, localTrusted: setup.refreshLocalTrusted } });
    const [stored] = await db.select().from(companySkillSources).where(eq(companySkillSources.id, imported.source.id));
    expect(stored).toMatchObject({ refreshUserId: null, refreshAgentId: agent!.id, refreshLocalTrusted: false, connectionId: null });
    await db.insert(activityLog).values({ companyId, actorType: 'agent', actorId: agent!.id, agentId: agent!.id,
      responsibleUserId: 'local-board', action: 'company.skill_source_refreshed', entityType: 'company_skill_source', entityId: imported.source.id });
    await skillSourceSyncService(db).tick(new Date(Date.now() + 6 * 60_000));
    const [checked] = await db.select().from(companySkillSources).where(eq(companySkillSources.id, imported.source.id));
    expect(checked!.lastError).toMatch(/Choose a GitHub connection/);
    expect(checked!.refreshUserId).toBeNull();
    expect(checked!.lastSuccessAt).toEqual(stored!.lastSuccessAt);
    // Migrated sources may lack refreshAgentId; API-key audit responsibility
    // still cannot stand in for an authenticated run's credential authority.
    await db.update(companySkillSources).set({ refreshAgentId: null }).where(eq(companySkillSources.id, imported.source.id));
    await skillSourceSyncService(db).tick(new Date(Date.now() + 12 * 60_000));
    const [legacy] = await db.select().from(companySkillSources).where(eq(companySkillSources.id, imported.source.id));
    expect(legacy!.refreshUserId).toBeNull();
    expect(legacy!.lastError).toMatch(/Choose a GitHub connection/);

  });

  it('follows a changed default branch while an explicit branch remains fixed', async () => {
    await db.update(companySkillSources).set({ automaticUpdates: false });
    let defaultBranch = 'main';
    const originalFiles = { 'workflow/SKILL.md': md('original default') }, nextFiles = { 'workflow/SKILL.md': md('new default') };
    const moving: SkillSourceContext = { ...context, read: () => {
      const reader = (async (url: string) => {
        if (url === '/repos/acme/skills') return { id: 42, full_name: 'acme/skills', default_branch: defaultBranch };
        if (url.startsWith('/repos/acme/skills/commits/')) return { sha: decodeURIComponent(url.split('/commits/')[1]!) === 'main' ? '7'.repeat(40) : '8'.repeat(40) };
        throw new Error('Unexpected request');
      }) as ReturnType<SkillSourceContext['read']>;
      reader.openSnapshot = async (input, options) => githubFixture(input.ref === 'main' ? originalFiles : nextFiles, {}, input.ref === 'main' ? '7'.repeat(40) : '8'.repeat(40)).openSnapshot(input, options);
      return reader;
    } };
    const implicit = await workspace('HEAD');
    await enqueueProjectSkillSource(db, implicit);
    const worker = skillSourceSyncService(db, { context: async () => moving });
    await worker.tick();
    const [defaultBinding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, implicit.id));
    const sourceService = skillSourceService(db);
    const original = await sourceService.detail(companyId, defaultBinding!.sourceId!);
    expect(original.trackingRef).toBe('HEAD');
    const skillId = original.entries[0]!.skillId!;
    const versionId = (await companySkillService(db).getById(companyId, skillId))!.currentVersionId;

    const explicit = await workspace('main');
    await enqueueProjectSkillSource(db, explicit);
    await worker.tick();
    const [fixedBinding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, explicit.id));
    expect(fixedBinding!.sourceId).not.toBe(original.id);
    defaultBranch = 'next-default';
    await worker.tick(new Date(Date.now() + 6 * 60_000));
    expect(await sourceService.detail(companyId, original.id)).toMatchObject({ trackingRef: 'HEAD', lastScanCommit: '8'.repeat(40) });
    expect(await sourceService.detail(companyId, fixedBinding!.sourceId!)).toMatchObject({ trackingRef: 'main', lastScanCommit: '7'.repeat(40) });
    const latest = (await companySkillService(db).getById(companyId, skillId))!;
    expect(latest.currentVersionId).not.toBe(versionId);
    expect(latest.markdown).toBe(md('new default'));
    expect((await companySkillService(db).getVersion(companyId, skillId, versionId!))!.fileInventory[0]!.content).toBe(md('original default'));
    const repeated = await workspace('HEAD');
    await enqueueProjectSkillSource(db, repeated);
    await worker.tick();
    const [reused] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, repeated.id));
    expect(reused!.sourceId).toBe(original.id);
  });
});
