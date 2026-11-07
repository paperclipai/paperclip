import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, environmentLeases, environments, executionWorkspaceSnapshots, executionWorkspaces, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, projects, projectWorkspaces, workspaceOperations, workspaceRuntimeServices, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, readRemoteWorkspaceRunReference } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { resolveManagedProjectWorkspaceDir, resolvePaperclipInstanceRoot } from "../home-paths.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { inventoryRemoteWorkspaceMigration, migrateRemoteWorkspace } from "./remote-workspace-migration.js";
import { getWorkspaceSnapshot, loadWorkspaceSnapshotArchive } from "./remote-workspace-snapshot-storage.js";
import { restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { materializeManagedProjectWorkspace } from "./managed-repository-checkout.js";
import { withExecutionWorkspaceLifecycleLock } from "./execution-workspace-lifecycle-lock.js";
import { IsolatedRepositorySourceBusy, withIsolatedRepositorySourceLock, withWorkspaceSourceLocks } from "./workspace-source-lock.js";
import { tryLockNativeWorkspaceFinalization } from "./native-runtime/native-workspace-finalization-ownership.js";
import { recordNativeFinalizationFailure } from "./native-runtime/native-run-finalizer.js";
import { inspectOnlineWorkspaceSource } from "./online-workspace-source.js";
import { inspectOnlineLegacyWorkspaceRecoveryHold, inspectOnlineLegacyWorkspaceRecoverySource } from "./online-legacy-workspace-recovery.js";
import { nativeWorkspaceSyncInternals } from "./native-runtime/native-workspace-sync.js";
import { readMigratedLegacyWorkspaceSource } from "./legacy-workspace-recovery-migration.js";
import { verifiedWorkspaceRepairReceipt } from "./workspace-recovery-receipt.js";
import { adapterExecutionControls, createAdapterExecutionControl } from "./adapter-execution-control.js";
import { withWorkspaceMoveLocks } from "./isolated-repository-rehome.js";
import { ensureRuntimeServicesForRun, startRuntimeServicesForWorkspaceControl, stopRuntimeServicesForExecutionWorkspace } from "./workspace-runtime.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("online ordinary physical source fence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>, home: string, storage: StorageService;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("online-ordinary-source-");
    db = createDb(database.connectionString, { maxConnections: 1 });
    await db.execute(sql`set client_min_messages = warning`);
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pc-online-source-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "61".repeat(32));
    storage = createStorageService(createLocalDiskStorageProvider(path.join(home, "objects")));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(activityLog);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaceSnapshots);
    await db.delete(workspaceRuntimeServices);
    await db.delete(nativeRunFinalizations);
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });
  async function fixture() {
    const companyId = randomUUID(), projectId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Online source", issuePrefix: `O${companyId.slice(0, 6)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Shared legacy project" });
    const cwd = resolveManagedProjectWorkspaceDir({ companyId, projectId });
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, "saved.txt"), "saved legacy edits\n");
    const aliases = [];
    for (let n = 0; n < 3; n++) {
      const [issue] = await db.insert(issues).values({ companyId, projectId, title: `Legacy task ${n}` }).returning();
      const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId, sourceIssueId: issue.id,
        name: `Alias ${n}`, mode: "shared_workspace", strategyType: "project_primary", providerType: "local_fs", cwd, providerRef: cwd }).returning();
      await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, issue.id));
      aliases.push({ issue, workspace });
    }
    return { companyId, projectId, cwd, aliases, workspaceId: aliases[0].workspace.id };
  }
  const execute = promisify(execFile);
  const git = async (cwd: string, ...args: string[]) => (await execute("git", ["-c", `core.hooksPath=${os.devNull}`, "-C", cwd, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Source fixture", GIT_AUTHOR_EMAIL: "source@example.test", GIT_COMMITTER_NAME: "Source fixture", GIT_COMMITTER_EMAIL: "source@example.test" },
  })).stdout.trim();
  async function gitFixture(f = undefined as Awaited<ReturnType<typeof fixture>> | undefined) {
    const base = f ?? await fixture();
    await git(base.cwd, "init", "-q", "-b", "main");
    await git(base.cwd, "add", "."); await git(base.cwd, "commit", "-qm", "Saved legacy work");
    const repoUrl = "https://example.invalid/saved-work.git";
    await git(base.cwd, "remote", "add", "origin", repoUrl);
    for (const alias of base.aliases) await db.update(executionWorkspaces).set({ repoUrl, branchName: "main" })
      .where(eq(executionWorkspaces.id, alias.workspace.id));
    const [issue] = await db.insert(issues).values({ companyId: base.companyId, projectId: base.projectId, title: "Shared Git child" }).returning();
    const cwd = path.join(base.cwd, ".paperclip", "worktrees", "child");
    await git(base.cwd, "worktree", "add", "-qb", "child", cwd);
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: base.companyId, projectId: base.projectId,
      sourceIssueId: issue.id, name: "Shared Git child", mode: "isolated_workspace", strategyType: "git_worktree",
      providerType: "git_worktree", cwd, providerRef: cwd, repoUrl, branchName: "child", baseRef: "main" }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, issue.id));
    return { ...base, child: workspace, repoUrl };
  }
  async function stored(workspaceId: string) {
    return (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId)))[0];
  }
  it("imports an ordinary managed directory without capturing its enclosing host repository", async () => {
    await git(home, "init", "-q", "-b", "main");
    await fs.writeFile(path.join(home, "host-only.txt"), "outside the workspace\n");
    await git(home, "add", "host-only.txt"); await git(home, "commit", "-qm", "Enclosing host repository");
    const head = await git(home, "rev-parse", "HEAD"), f = await fixture();
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: true });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).resolves.toMatchObject({ applied: true });
    const authority = readRemoteWorkspaceAuthority((await stored(f.workspaceId)).metadata)!;
    const reference = await getWorkspaceSnapshot(db, { ...f, snapshotId: authority.snapshotId! });
    const archivePath = path.join(home, "ordinary.pcws"), targetDir = path.join(home, "ordinary-restored");
    await loadWorkspaceSnapshotArchive({ storage, reference: reference!, targetPath: archivePath });
    await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: reference!.manifestDigest });
    expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
    expect(await fs.lstat(path.join(targetDir, ".git")).catch(() => null)).toBeNull();
    expect(await fs.lstat(path.join(targetDir, "host-only.txt")).catch(() => null)).toBeNull();
    expect(await git(home, "rev-parse", "HEAD")).toBe(head);
  });
  it.each([false, true])("does not admit a Git fragment as an ordinary migration source (objects: %s)", async objects => {
    const f = await fixture(), info = path.join(f.cwd, ".git", "info");
    await fs.mkdir(info, { recursive: true });
    await fs.writeFile(path.join(info, "exclude"), "/.paperclip-repositories/\n");
    if (objects) await fs.mkdir(path.join(f.cwd, ".git", "objects"));
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: false,
      reasons: expect.arrayContaining(["online_workspace_source_scope_unproven"]) });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("online_workspace_source_scope_unproven");
    expect(await db.select().from(workspaceOperations)).toEqual([]);
    expect(await fs.readFile(path.join(info, "exclude"), "utf8")).toBe("/.paperclip-repositories/\n");
  });
  it("preserves unmanaged Git import in genuine offline mode while retaining online and drain guards", async () => {
    const f = await fixture(), cwd = path.join(home, "self-hosted-repository"), repoUrl = "https://example.invalid/self-hosted.git";
    await fs.mkdir(cwd); await git(cwd, "init", "-q", "-b", "main");
    await fs.writeFile(path.join(cwd, "saved.txt"), "self-hosted original work\n");
    await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "Self-hosted source");
    await git(cwd, "remote", "add", "origin", repoUrl);
    for (const alias of f.aliases.slice(1)) await db.update(executionWorkspaces).set({ providerType: "plugin" })
      .where(eq(executionWorkspaces.id, alias.workspace.id));
    await db.update(executionWorkspaces).set({ cwd, providerRef: cwd, repoUrl, branchName: "main" })
      .where(eq(executionWorkspaces.id, f.workspaceId));
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: false,
      reasons: expect.arrayContaining(["online_workspace_source_scope_unproven"]) });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("online_workspace_source_scope_unproven");
    vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Offline writer guard" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent.id,
      issueId: f.aliases[0].issue.id, status: "running", runtimeMode: "legacy" }).returning();
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true, writersStopped: true }))
      .rejects.toThrow("active_execution_requires_drain");
    expect(await db.select().from(workspaceOperations)).toEqual([]);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true, writersStopped: true })).resolves.toMatchObject({ applied: true });
    expect(await fs.readFile(path.join(cwd, "saved.txt"), "utf8")).toBe("self-hosted original work\n");
  });
  it.each(["ordinary", "Git"].flatMap(kind => ["cwd", "providerRef", "different", "alias"].map(locator => ({ kind, locator }))))(
    "rejects foreign $kind ownership through $locator source locators", async ({ kind, locator }) => {
      const base = await fixture(), f = kind === "Git" ? await gitFixture(base) : null;
      const workspaceId = f?.child.id ?? base.workspaceId, sourcePath = f?.child.cwd ?? base.cwd;
      const companyId = randomUUID(), unrelated = path.join(home, "foreign-display-root"), alias = path.join(home, "foreign-path-alias");
      await fs.mkdir(unrelated); await fs.symlink(sourcePath, alias);
      await db.insert(companies).values({ id: companyId, name: "Foreign source owner", issuePrefix: "FOREIGN" });
      await db.insert(executionWorkspaces).values({ companyId, name: "Foreign source alias", mode: "shared_workspace",
        strategyType: "project_primary", providerType: "local_fs",
        cwd: locator === "cwd" ? sourcePath : locator === "providerRef" ? null : unrelated,
        providerRef: locator === "cwd" ? null : locator === "alias" ? alias : sourcePath });
      const input = { companyId: base.companyId, workspaceId };
      expect(await inventoryRemoteWorkspaceMigration(db, input)).toMatchObject({ eligible: false });
      await expect(migrateRemoteWorkspace({ db, storage, ...input, apply: true })).rejects.toThrow("remote_workspace_migration_blocked");
      expect(readRemoteWorkspaceAuthority((await stored(workspaceId)).metadata)).toBeNull();
      expect(await db.select().from(executionWorkspaceSnapshots)).toEqual([]);
      expect(await fs.readFile(path.join(sourcePath, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
    });
  it.each(["cwd", "providerRef"] as const)("rejects a mismatched same-company ordinary %s owner", async locator => {
    const f = await fixture(), unrelated = path.join(home, "another-source");
    await fs.mkdir(unrelated);
    await db.update(executionWorkspaces).set({ cwd: locator === "cwd" ? f.cwd : unrelated,
      providerRef: locator === "cwd" ? unrelated : f.cwd }).where(eq(executionWorkspaces.id, f.aliases[1].workspace.id));
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: false });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("online_workspace_source_scope_unproven");
    expect(await db.select().from(workspaceOperations)).toEqual([]);
  });
  it.each(["providerRef", "different", "alias", "secondary-Git"] as const)("requires a proven source for the selected %s locator before fallback", async locator => {
    const base = await fixture(), f = locator === "secondary-Git" ? await gitFixture(base) : null;
    for (const alias of base.aliases.slice(f ? 0 : 1)) await db.update(executionWorkspaces).set({ providerType: "plugin" })
      .where(eq(executionWorkspaces.id, alias.workspace.id));
    const workspaceId = f?.child.id ?? base.workspaceId, sourcePath = f?.child.cwd ?? base.cwd;
    const unrelated = path.join(home, "selected-display-root"); await fs.mkdir(unrelated);
    const alias = path.join(home, "selected-path-alias"); await fs.symlink(sourcePath, alias);
    await db.update(executionWorkspaces).set({ cwd: locator === "providerRef" ? null : unrelated,
      providerRef: locator === "alias" ? alias : sourcePath, repoUrl: null, branchName: null,
      strategyType: "project_primary" }).where(eq(executionWorkspaces.id, workspaceId));
    const input = { companyId: base.companyId, workspaceId };
    expect(await inventoryRemoteWorkspaceMigration(db, input)).toMatchObject({ eligible: false,
      reasons: expect.arrayContaining(["online_workspace_source_scope_unproven"]) });
    await expect(migrateRemoteWorkspace({ db, storage, ...input, apply: true })).rejects.toThrow("online_workspace_source_scope_unproven");
    expect(await db.select().from(workspaceOperations)).toEqual([]);
    expect(await fs.readFile(path.join(sourcePath, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
  });
  it.each(["cwd", "providerRef", "different", "alias"] as const)("reserves every %s source locator before the actual lifecycle owner", async locator => {
    const f = await fixture(), unrelated = path.join(home, "lifecycle-display-root"), alias = path.join(home, "lifecycle-path-alias");
    await fs.mkdir(unrelated); await fs.symlink(f.cwd, alias);
    await db.update(executionWorkspaces).set({ projectId: null,
      cwd: locator === "cwd" ? f.cwd : locator === "providerRef" ? null : unrelated,
      providerRef: locator === "cwd" ? null : locator === "alias" ? alias : f.cwd }).where(eq(executionWorkspaces.id, f.workspaceId));
    let entered!: () => void, release!: () => void, mutated = false;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const owner = withWorkspaceSourceLocks(db, { companyId: f.companyId, projectIds: [f.projectId] }, async () => { entered(); await pending; });
    await started;
    const lifecycle = withExecutionWorkspaceLifecycleLock(db, f.workspaceId, async () => { mutated = true; });
    try {
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event='advisory'`);
        expect(waiting[0].n).toBeGreaterThan(0);
      });
      expect(mutated).toBe(false);
      const key = `execution_workspace_lifecycle:${f.workspaceId}`;
      const locks = await db.execute(sql`select count(*)::int n from pg_locks where locktype='advisory' and granted
        and classid=((hashtextextended(${key},0)>>32)&4294967295)::oid and objid=(hashtextextended(${key},0)&4294967295)::oid`);
      expect(locks[0].n).toBe(0);
    } finally { release(); await owner; await lifecycle; }
    expect(mutated).toBe(true);
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
  });
  function uploadBarrier() {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const put = storage.putFile.bind(storage);
    vi.spyOn(storage, "putFile").mockImplementationOnce(async input => {
      const result = await put(input); entered(); await pending; return result;
    });
    return { started, release };
  }
  async function remoteWriter(companyId: string, agentId: string) {
    const workspaceId = randomUUID(), runId = randomUUID(), leaseId = randomUUID(), providerLeaseId = randomUUID();
    const [issue] = await db.insert(issues).values({ companyId, title: "Unrelated object-backed task" }).returning();
    const [environment] = await db.insert(environments).values({ name: runId, driver: "daytona" }).returning();
    const remoteCwd = `/workspaces/${workspaceId}`;
    const authority = { schema: "paperclip.remote-workspace.v1", epoch: 1, snapshotId: null, source: { kind: "empty" },
      location: { environmentId: environment.id, leaseId, providerLeaseId, remoteCwd }, writerRunId: runId, dirty: true };
    const [workspace] = await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issue.id,
      name: "Unrelated remote writer", mode: "isolated_workspace", strategyType: "project_primary", providerType: "cloud_sandbox",
      cwd: remoteCwd, metadata: { remoteWorkspace: authority } }).returning();
    const reference = { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId, providerLeaseId,
      remoteCwd, epoch: 1, state: "prepared", snapshotId: null };
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId: issue.id,
      nativeIssueId: issue.id, status: "running", runtimeMode: "native", contextSnapshot: { executionWorkspaceId: workspaceId },
      runnerProfileJson: { remoteWorkspace: reference } }).returning();
    await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: runId, issueId: issue.id,
      executionWorkspaceId: workspaceId, environmentId: environment.id, provider: "daytona", providerLeaseId,
      status: "active", metadata: { remoteCwd } });
    expect(readRemoteWorkspaceAuthority(workspace.metadata)).toEqual(authority);
    expect(readRemoteWorkspaceRunReference(run.runnerProfileJson?.remoteWorkspace)).toEqual(reference);
    return run;
  }
  it("imports an alias with unrelated object-backed execution still running and leaves all original files", async () => {
    const f = await fixture();
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Unrelated active agent" }).returning();
    const run = await remoteWriter(f.companyId, agent.id);
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: true });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).resolves.toMatchObject({ applied: true });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toEqual(run);
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
    expect(await stored(f.aliases[1].workspace.id)).toEqual(f.aliases[1].workspace);
    const authority = readRemoteWorkspaceAuthority((await stored(f.workspaceId)).metadata)!;
    const reference = await getWorkspaceSnapshot(db, { ...f, snapshotId: authority.snapshotId! });
    const archivePath = path.join(home, "restored.pcws"), targetDir = path.join(home, "restored");
    await loadWorkspaceSnapshotArchive({ storage, reference: reference!, targetPath: archivePath });
    await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: reference!.manifestDigest });
    expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
  });
  it("fences future issues and alias lifecycle owners while another project can materialize", async () => {
    const f = await fixture(), barrier = uploadBarrier();
    const migration = migrateRemoteWorkspace({ db, storage, ...f, apply: true });
    await Promise.race([barrier.started, migration.then(() => { throw new Error("capture did not reach upload"); })]);
    let lifecycleEntered = false, preparationEntered = false;
    const preparation = withIsolatedRepositorySourceLock(db, f.companyId, randomUUID(), async () => {
      await materializeManagedProjectWorkspace(path.join(f.cwd, "new-issue"), { repoUrl: null });
      preparationEntered = true;
    });
    const lifecycle = withExecutionWorkspaceLifecycleLock(db, f.aliases[1].workspace.id, async () => { lifecycleEntered = true; });
    try {
      expect(await fs.lstat(path.join(f.cwd, "new-issue")).catch(() => null)).toBeNull();
      const unrelated = resolveManagedProjectWorkspaceDir({ companyId: f.companyId, projectId: randomUUID() });
      await withIsolatedRepositorySourceLock(db, f.companyId, randomUUID(), () =>
        materializeManagedProjectWorkspace(unrelated, { repoUrl: null }));
      expect((await fs.stat(unrelated)).isDirectory()).toBe(true);
      await vi.waitFor(async () => {
        const rows = await db.execute(sql`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event='advisory'`);
        expect(rows[0].n).toBeGreaterThan(0);
      });
      expect(lifecycleEntered).toBe(false);
      expect(preparationEntered).toBe(false);
    } finally { barrier.release(); await migration; await lifecycle; await preparation; }
    expect(lifecycleEntered).toBe(true);
    expect(preparationEntered).toBe(true);
  });
  it("checks every alias issue lock before creating a migration journal", async () => {
    const f = await fixture();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const owner = withIsolatedRepositorySourceLock(db, f.companyId, f.aliases[2].issue.id, async () => { entered(); await pending; });
    await started;
    try {
      await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toBeInstanceOf(IsolatedRepositorySourceBusy);
      expect(await db.select().from(workspaceOperations)).toEqual([]);
    } finally { release(); await owner; }
  });
  it("fences the actual rehome and nested-conversion owner through its project source", async () => {
    const f = await fixture();
    let entered!: () => void, release!: () => void, moved = false;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const owner = withWorkspaceSourceLocks(db, { companyId: f.companyId, projectIds: [f.projectId] }, async () => { entered(); await pending; });
    await started;
    const movement = withWorkspaceMoveLocks(db, f.aliases[0].workspace, async () => { moved = true; });
    try {
      await vi.waitFor(async () => {
        const rows = await db.execute(sql`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event='advisory'`);
        expect(rows[0].n).toBeGreaterThan(0);
      });
      expect(moved).toBe(false);
    } finally { release(); await owner; await movement; }
    expect(moved).toBe(true);
  });
  it("keeps runs without runtime services free of source filesystem admission", async () => {
    const f = await fixture(), realpath = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementation(async target => {
      if (String(target).startsWith(home)) throw new Error("runtime sources must stay unused");
      return realpath(target);
    });
    expect(await ensureRuntimeServicesForRun({ db, runId: randomUUID(), executionWorkspaceId: f.workspaceId,
      agent: { id: null, name: "No service owner", companyId: f.companyId }, issue: null, adapterEnv: {}, config: {}, skipHostProvision: true,
      workspace: { cwd: f.cwd, baseCwd: f.cwd, source: "project_primary", projectId: f.projectId, workspaceId: null,
        repoUrl: null, repoRef: null, strategy: "project_primary", branchName: null, branchCreatedByRuntime: false,
        worktreePath: null, warnings: [], created: false } })).toEqual([]);
  });
  it.each(["workspace", "configured", "symlink"] as const)("fences project command provisioning and its running %s CWD without an execution workspace ID", async location => {
    const f = await fixture();
    const startProjectId = location === "configured" ? randomUUID() : f.projectId;
    if (startProjectId !== f.projectId) await db.insert(projects).values({ id: startProjectId, companyId: f.companyId, name: "Service owner" });
    const startCwd = location === "symlink" ? path.join(home, "configured-service-source")
      : resolveManagedProjectWorkspaceDir({ companyId: f.companyId, projectId: startProjectId });
    if (location === "symlink") await fs.symlink(f.cwd, startCwd);
    await fs.mkdir(startCwd, { recursive: true });
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Project command owner" }).returning();
    const [projectWorkspace] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: startProjectId,
      name: "Project source", cwd: startCwd }).returning();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const owner = withWorkspaceSourceLocks(db, { companyId: f.companyId, projectIds: [f.projectId] }, async () => { entered(); await pending; });
    await started;
    const node = JSON.stringify(process.execPath), marker = path.join(startCwd, "runtime-source-marker");
    const services = startRuntimeServicesForWorkspaceControl({ db, actor: agent, issue: null, adapterEnv: {},
      workspace: { cwd: startCwd, baseCwd: startCwd, source: "project_primary", projectId: startProjectId, workspaceId: projectWorkspace.id,
        repoUrl: null, repoRef: null, strategy: "project_primary", branchName: null, branchCreatedByRuntime: false,
        worktreePath: null, warnings: [], created: false },
      config: { runtimeProvisionCommand: `${node} -e ${JSON.stringify("require('node:fs').writeFileSync('runtime-source-marker', 'provisioned')")}`,
        workspaceRuntime: { services: [{ name: "source-fence-proof", cwd: f.cwd, command: `${node} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
          lifecycle: "shared", reuseScope: "project_workspace", stopPolicy: { type: "manual" } }] } },
    });
    try {
      await vi.waitFor(async () => {
        const rows = await db.execute(sql`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event='advisory'`);
        expect(rows[0].n).toBeGreaterThan(0);
      });
      expect(await fs.lstat(marker).catch(() => null)).toBeNull();
    } finally {
      release(); await owner;
      const refs = await services;
      try {
        expect(refs).toHaveLength(1);
        expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: false,
          reasons: expect.arrayContaining(["workspace_runtime_service_unsettled"]) });
        await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("workspace_runtime_service_unsettled");
        expect(readRemoteWorkspaceAuthority((await stored(f.workspaceId)).metadata)).toBeNull();
      } finally {
        for (const ref of refs) await stopRuntimeServicesForExecutionWorkspace({ db, executionWorkspaceId: f.workspaceId, runtimeServiceId: ref.id });
      }
    }
    expect(await fs.readFile(marker, "utf8")).toBe("provisioned");
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: true, reasons: [] });
  });
  it("fences a configured alias of an existing isolated task directory using its original issue key", async () => {
    const f = await fixture(), sourceIssueId = f.aliases[0].issue.id;
    const cwd = path.join(resolvePaperclipInstanceRoot(), "isolated-workspaces", f.companyId, sourceIssueId);
    await fs.mkdir(cwd, { recursive: true });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const owner = withIsolatedRepositorySourceLock(db, f.companyId, sourceIssueId, async () => { entered(); await pending; });
    await started;
    try {
      await expect(withIsolatedRepositorySourceLock(db, f.companyId, randomUUID(), () =>
        materializeManagedProjectWorkspace(path.join(cwd, "new-alias"), { repoUrl: null })))
        .rejects.toBeInstanceOf(IsolatedRepositorySourceBusy);
      expect(await fs.lstat(path.join(cwd, "new-alias")).catch(() => null)).toBeNull();
    } finally { release(); await owner; }
  });
  it("bounds source-lock closures before reserving a connection", async () => {
    await expect(withWorkspaceSourceLocks(db, { companyId: randomUUID(), issueIds: Array.from({ length: 129 }, () => randomUUID()) },
      async () => { throw new Error("scope must not be admitted"); })).rejects.toThrow("workspace_source_scope_limit");
  });
  it.each(["task", "operation", "foreign", "descendant"] as const)("retains the %s guard across the complete alias closure", async kind => {
    const f = await fixture(), alias = f.aliases[2];
    if (kind === "task") {
      const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Alias checkout" }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent.id, status: "succeeded" }).returning();
      await db.update(issues).set({ checkoutRunId: run.id }).where(eq(issues.id, alias.issue.id));
    }
    if (kind === "operation") await db.insert(workspaceOperations).values({ companyId: f.companyId,
      executionWorkspaceId: alias.workspace.id, phase: "cleanup", status: "running" });
    if (kind === "foreign") {
      const companyId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Foreign", issuePrefix: "FOREIGN" });
      await db.insert(executionWorkspaces).values({ companyId, name: "Foreign alias", mode: "shared_workspace",
        strategyType: "project_primary", providerType: "local_fs", cwd: f.cwd });
    }
    if (kind === "descendant") await db.update(executionWorkspaces).set({ cwd: path.join(f.cwd, "child") }).where(eq(executionWorkspaces.id, alias.workspace.id));
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: false });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("remote_workspace_migration_blocked");
    expect(readRemoteWorkspaceAuthority((await stored(f.workspaceId)).metadata)).toBeNull();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
  });
  it("does not count unrelated tenants against the company alias bound", async () => {
    const f = await fixture(), companyId = randomUUID(), cwd = path.join(home, "other-tenant");
    await fs.mkdir(cwd);
    await db.insert(companies).values({ id: companyId, name: "Unrelated tenant", issuePrefix: "OTHER" });
    await db.insert(executionWorkspaces).values(Array.from({ length: 1001 }, () => ({
      companyId, name: "Unrelated workspace", mode: "shared_workspace", strategyType: "project_primary",
      providerType: "local_fs", cwd,
    })));
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: true, reasons: [] });
  });
  it.each(["symlink", "unreadable"] as const)("blocks an unproven foreign %s path even for a single local alias", async kind => {
    const f = await fixture(), companyId = randomUUID(), cwd = path.join(home, "foreign-alias");
    for (const alias of f.aliases.slice(1)) await db.update(executionWorkspaces).set({ providerType: "plugin" })
      .where(eq(executionWorkspaces.id, alias.workspace.id));
    await db.insert(companies).values({ id: companyId, name: "Foreign alias", issuePrefix: "FOREIGN" });
    if (kind === "symlink") await fs.symlink(f.cwd, cwd);
    else {
      const realpath = fs.realpath.bind(fs);
      vi.spyOn(fs, "realpath").mockImplementation(async value => {
        if (value === cwd) throw Object.assign(new Error("fixture path inaccessible"), { code: "EACCES" });
        return realpath(value);
      });
    }
    await db.insert(executionWorkspaces).values({ companyId, name: "Foreign path", mode: "shared_workspace",
      strategyType: "project_primary", providerType: "local_fs", cwd });
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: false,
      reasons: expect.arrayContaining(["online_workspace_source_scope_unproven"]) });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("online_workspace_source_scope_unproven");
    expect(await db.select().from(workspaceOperations)).toEqual([]);
    expect(readRemoteWorkspaceAuthority((await stored(f.workspaceId)).metadata)).toBeNull();
  });
  it("rechecks closure membership before publication and preserves the uploaded journal on change", async () => {
    const f = await fixture(), put = storage.putFile.bind(storage);
    vi.spyOn(storage, "putFile").mockImplementationOnce(async input => {
      const result = await put(input);
      await db.update(executionWorkspaces).set({ providerRef: "/unproven/new/source" }).where(eq(executionWorkspaces.id, f.aliases[2].workspace.id));
      return result;
    });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("online_workspace_source_scope_changed");
    expect(readRemoteWorkspaceAuthority((await stored(f.workspaceId)).metadata)).toBeNull();
    expect((await db.select().from(workspaceOperations))[0].status).toBe("running");
  });
  it("does not publish after the actual source lock connection is terminated", async () => {
    const f = await fixture(), barrier = uploadBarrier();
    const migration = migrateRemoteWorkspace({ db, storage, ...f, apply: true }).then(value => ({ value }), error => ({ error }));
    await Promise.race([barrier.started, migration.then(result => { if ("error" in result) throw result.error; throw new Error("capture did not reach upload"); })]);
    const key = `managed_project_source:${f.companyId}:${f.projectId}`;
    const rows = await db.execute(sql`select distinct a.pid from pg_stat_activity a join pg_locks l on l.pid=a.pid
      where a.datname=current_database() and l.locktype='advisory' and l.granted
      and l.classid=((hashtextextended(${key},0)>>32)&4294967295)::oid
      and l.objid=(hashtextextended(${key},0)&4294967295)::oid`);
    expect(rows).toHaveLength(1);
    await db.execute(sql`select pg_terminate_backend(${Number(rows[0].pid)})`);
    barrier.release();
    expect(await migration).toHaveProperty("error");
    expect(readRemoteWorkspaceAuthority((await stored(f.workspaceId)).metadata)).toBeNull();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
  });
  async function recoveryFixture(descendant = false) {
    const f = await fixture(), runId = randomUUID();
    const issue = descendant ? (await db.insert(issues).values({ companyId: f.companyId, projectId: f.projectId,
      parentId: f.aliases[0].issue.id, title: "Descendant prepared recovery", executionWorkspaceId: f.workspaceId }).returning())[0]
      : f.aliases[0].issue;
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Terminal native worker", adapterType: "paperclip_runner" }).returning();
    const reference = { schema: "paperclip.native-workspace-sync/v3", state: "prepared", workspaceId: f.workspaceId,
      leaseId: randomUUID(), providerLeaseId: randomUUID(), remoteCwd: "/workspaces/retained",
      descriptorSha256: "12".repeat(32), baselineSha256: "34".repeat(32), resourceDisposition: "destroy" };
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: agent.id,
      nativeIssueId: issue.id, status: "failed", runtimeMode: "native", runnerProfileJson: { nativeWorkspaceSync: reference } }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: issue.id,
      runId, phase: "observed" });
    const [environment] = await db.insert(environments).values({ name: runId, driver: "daytona" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ id: reference.leaseId, companyId: f.companyId,
      issueId: issue.id, heartbeatRunId: runId, executionWorkspaceId: f.workspaceId, environmentId: environment.id,
      provider: "daytona", providerLeaseId: reference.providerLeaseId, status: "retained", leasePolicy: "retain_on_failure",
      metadata: { remoteCwd: reference.remoteCwd } }).returning();
    await recordNativeFinalizationFailure({ db, runId, error: new Error("native_workspace_sync_out_unrecoverable"),
      failureScope: "workspace", permanent: true });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [owner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    const [warning] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue.id));
    expect(warning).toMatchObject({ kind: "active_run_watchdog", cause: "native_workspace_sync_out_unrecoverable",
      status: "active", evidence: { runId } });
    return { ...f, run, owner, lease, warning };
  }
  async function artifactFailureFixture(descendant = false) {
    const f = await recoveryFixture(descendant), cause = "runner_remote_provider_artifact_incompatible", statusVersion = 2;
    const profile = { ...f.run.runnerProfileJson, sessionCheckpoint: { backendKind: "runner", providerSessionId: "fixture-established-session" } };
    const restore = { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.lease.id] };
    await db.update(heartbeatRuns).set({ runnerProfileJson: profile, nextEventSeq: 250,
      resultJson: { ...f.run.resultJson, workspaceRestoreRecovery: restore } }).where(eq(heartbeatRuns.id, f.run.id));
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: cause, nextAttemptAt: null })
      .where(eq(nativeRunFinalizations.runId, f.run.id));
    await db.update(issues).set({ status: "blocked", statusVersion, executionRunId: null, checkoutRunId: null })
      .where(eq(issues.id, f.run.nativeIssueId!));
    await db.update(issueRecoveryActions).set({ cause, ownerType: "board", ownerAgentId: null,
      returnOwnerAgentId: f.run.agentId, wakePolicy: null,
      fingerprint: createHash("sha256").update(`${f.run.id}:${cause}`).digest("hex"), evidence: {
        runId: f.run.id, coordinatorAttempt: 3, sourceFailureCode: cause, recoveryDisposition: cause,
        nativeFailureBlock: { runId: f.run.id, statusVersion }, providerSessionEstablished: true, recoveryMode: "exact_checkpoint_resume",
      } }).where(eq(issueRecoveryActions.id, f.warning.id));
    const events = ["session.started", ...Array.from({ length: 124 }, () => ["tool.execution.started", "tool.execution.completed"]).flat()];
    await db.insert(heartbeatRunEvents).values(events.map((eventType, index) => ({ companyId: f.companyId,
      runId: f.run.id, agentId: f.run.agentId, seq: index + 1, eventType })));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    const [owner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id));
    const [warning] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.warning.id));
    const [issue] = await db.select().from(issues).where(eq(issues.id, run.nativeIssueId!));
    return { ...f, run, owner, warning, issue };
  }
  it("preserves provider-established artifact failure holds while migrating local Git aliases and their source recipe", async () => {
    const recovery = await artifactFailureFixture(), f = { ...recovery, ...await gitFixture(recovery) };
    const original = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    const nativeReference = nativeWorkspaceSyncInternals.readReference(f.run.runnerProfileJson!.nativeWorkspaceSync)!;
    const descriptor = nativeWorkspaceSyncInternals.descriptorPath(f.run.id, nativeReference.descriptorSha256);
    expect(await fs.lstat(descriptor).catch(() => null)).toBeNull();
    expect(await inventoryRemoteWorkspaceMigration(db, { ...f, workspaceId: f.child.id })).toMatchObject({ eligible: true });
    await migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: f.child.id, apply: true });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toEqual(original[0]);
    const put = storage.putFile.bind(storage);
    vi.spyOn(storage, "putFile").mockImplementationOnce(async input => {
      await db.transaction(async tx => {
        expect(await tryLockNativeWorkspaceFinalization(tx as unknown as Db, { companyId: f.companyId, runId: f.run.id })).toBe(false);
      });
      return put(input);
    });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).resolves.toMatchObject({ applied: true });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(run).toMatchObject({ status: "failed", resultJson: f.run.resultJson, runnerProfileJson: {
      nativeWorkspaceSync: f.run.runnerProfileJson!.nativeWorkspaceSync, sessionCheckpoint: f.run.runnerProfileJson!.sessionCheckpoint,
    } });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id)))[0]).toEqual(f.owner);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0]).toEqual(f.lease);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.warning.id)))[0]).toEqual(f.warning);
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0]).toEqual(f.issue);
    expect(await db.select().from(heartbeatRunEvents)).toHaveLength(249);
    expect(await readMigratedLegacyWorkspaceSource(db, { companyId: f.companyId, runId: f.run.id,
      reference: nativeReference })).toMatchObject({ runId: f.run.id,
      reference: { state: "prepared" }, recoveryAllocations: [{ leaseId: f.lease.id }] });
    expect(await verifiedWorkspaceRepairReceipt(db, run)).toBeNull();
    const authority = readRemoteWorkspaceAuthority((await stored(f.workspaceId)).metadata)!;
    const reference = await getWorkspaceSnapshot(db, { ...f, snapshotId: authority.snapshotId! });
    const archivePath = path.join(home, "local-preserved.pcws"), targetDir = path.join(home, "local-restored");
    await loadWorkspaceSnapshotArchive({ storage, reference: reference!, targetPath: archivePath });
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
    await fs.rm(f.cwd, { recursive: true });
    await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: reference!.manifestDigest });
    expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
    expect(await fs.lstat(descriptor).catch(() => null)).toBeNull();
  });
  it.each(["stale-block", "foreign-company", "expired-owner", "live-controller", "live-control", "malformed-block", "missing-allocation", "fingerprint"])(
    "keeps a prepared artifact failure held with %s evidence", async mode => {
      const f = await artifactFailureFixture();
      if (mode === "stale-block") await db.update(issues).set({ statusVersion: f.issue.statusVersion + 1 }).where(eq(issues.id, f.issue.id));
      if (mode === "expired-owner") await db.update(nativeRunFinalizations).set({ leaseOwner: "unreleased owner", leaseExpiresAt: new Date(0) })
        .where(eq(nativeRunFinalizations.runId, f.run.id));
      if (mode === "live-controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) })
        .where(eq(heartbeatRuns.id, f.run.id));
      if (mode === "malformed-block") await db.update(issueRecoveryActions).set({ evidence: {
        ...f.warning.evidence, nativeFailureBlock: { runId: f.run.id, statusVersion: String(f.issue.statusVersion) },
      } }).where(eq(issueRecoveryActions.id, f.warning.id));
      if (mode === "missing-allocation") await db.update(heartbeatRuns).set({ resultJson: {
        ...f.run.resultJson, workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [randomUUID()] },
      } }).where(eq(heartbeatRuns.id, f.run.id));
      if (mode === "fingerprint") await db.update(issueRecoveryActions).set({ fingerprint: "00".repeat(32) }).where(eq(issueRecoveryActions.id, f.warning.id));
      const control = createAdapterExecutionControl();
      if (mode === "live-control") adapterExecutionControls.set(f.run.id, control);
      try {
        const [saved] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.warning.id));
        const recovery = mode === "foreign-company" ? { ...saved, companyId: randomUUID() } : saved;
        expect(await inspectOnlineLegacyWorkspaceRecoveryHold(db, { workspace: await stored(f.workspaceId), recovery })).toBeNull();
        if (mode !== "foreign-company") {
          expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: false });
          await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow();
        }
        expect(await db.select().from(workspaceOperations)).toHaveLength(0);
        expect(await db.select().from(executionWorkspaceSnapshots)).toHaveLength(0);
        expect(readRemoteWorkspaceAuthority((await stored(f.workspaceId)).metadata)).toBeNull();
        expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
      } finally { adapterExecutionControls.delete(f.run.id); control.finish(); }
    },
  );
  it.each(["warning", "task", "checkpoint"])("rejects a prepared artifact hold when %s changes during capture", async mode => {
    const f = await artifactFailureFixture(), put = storage.putFile.bind(storage);
    vi.spyOn(storage, "putFile").mockImplementationOnce(async input => {
      const result = await put(input);
      if (mode === "warning") await db.update(issueRecoveryActions).set({ evidence: { ...f.warning.evidence, coordinatorAttempt: 4 } })
        .where(eq(issueRecoveryActions.id, f.warning.id));
      if (mode === "task") await db.update(issues).set({ statusVersion: f.issue.statusVersion + 1 }).where(eq(issues.id, f.issue.id));
      if (mode === "checkpoint") await db.update(heartbeatRuns).set({ runnerProfileJson: { ...f.run.runnerProfileJson,
        sessionCheckpoint: { backendKind: "runner", providerSessionId: "changed-provider-session" },
      } }).where(eq(heartbeatRuns.id, f.run.id));
      return result;
    });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow();
    expect(readRemoteWorkspaceAuthority((await stored(f.workspaceId)).metadata)).toBeNull();
    expect((await db.select().from(workspaceOperations))[0].status).toBe("running");
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id)))[0]).toEqual(f.owner);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0]).toEqual(f.lease);
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
  });
  it.each(["selected", "companion"])("does not publish a %s source while its descendant recovery task is locked", async mode => {
    const recovery = await artifactFailureFixture(true), linked = mode === "companion" ? await gitFixture(recovery) : null;
    const f = { ...recovery, ...linked };
    const descendant = f.issue;
    const input = { companyId: f.companyId, workspaceId: linked?.child.id ?? f.workspaceId };
    expect(await inventoryRemoteWorkspaceMigration(db, input)).toMatchObject({ eligible: true });
    const other = createDb(database.connectionString, { maxConnections: 1 });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const held = other.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, descendant.id)).for("update");
      entered(); await pending;
    });
    await started;
    try {
      await expect(migrateRemoteWorkspace({ db, storage, ...input, apply: true }))
        .rejects.toThrow("remote_workspace_migration_blocked:execution_rows_busy");
      expect(readRemoteWorkspaceAuthority((await stored(input.workspaceId)).metadata)).toBeNull();
      expect((await db.select().from(workspaceOperations))[0].status).toBe("running");
      expect((await db.select().from(issues).where(eq(issues.id, descendant.id)))[0]).toEqual(descendant);
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.warning.id)))[0])
        .toMatchObject({ status: "active", sourceIssueId: descendant.id, evidence: f.warning.evidence });
    } finally { release(); await held; await other.$client.end({ timeout: 1 }); }
  });
  it("discovers all Git companions in one fresh company-scoped scan per inspection", async () => {
    const recovery = await recoveryFixture(), f = await gitFixture(recovery);
    const [finalizedIssue] = await db.insert(issues).values({ companyId: f.companyId, projectId: f.projectId,
      parentId: f.aliases[1].issue.id, title: "Retained finalized companion" }).returning();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: recovery.run.agentId,
      nativeIssueId: finalizedIssue.id, status: "succeeded", runtimeMode: "legacy", runnerProfileJson: {
        nativeWorkspaceSync: { workspaceId: f.aliases[1].workspace.id, state: "finalized" } } });
    const [finalizedRecovery] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId,
      sourceIssueId: finalizedIssue.id, kind: "stranded_assigned_issue", cause: "fixture", fingerprint: randomUUID(),
      ownerType: "board", nextAction: "Retain the original recovery owner" }).returning();
    const foreignCompany = randomUUID();
    await db.insert(companies).values({ id: foreignCompany, name: "Foreign companion", issuePrefix: "FOREIGN" });
    const [foreignAgent] = await db.insert(agents).values({ companyId: foreignCompany, name: "Foreign native worker" }).returning();
    await db.insert(heartbeatRuns).values({ companyId: foreignCompany, agentId: foreignAgent.id, runtimeMode: "native",
      status: "running", runnerProfileJson: { nativeWorkspaceSync: { workspaceId: f.workspaceId, state: "prepared" } } });
    const source = await inspectOnlineLegacyWorkspaceRecoverySource(db, { workspace: f.aliases[0].workspace, runId: recovery.run.id });
    const preparedHold = await inspectOnlineLegacyWorkspaceRecoveryHold(db, { workspace: f.aliases[0].workspace, recovery: recovery.warning });
    const finalizedHold = await inspectOnlineLegacyWorkspaceRecoveryHold(db, { workspace: f.aliases[1].workspace, recovery: finalizedRecovery });
    expect(source).not.toBeNull();
    expect(preparedHold).not.toBeNull();
    expect(finalizedHold).not.toBeNull();
    const selected = await stored(f.child.id), debug = db.$client.options.debug;
    const scans: string[] = [];
    db.$client.options.debug = (_connection, query) => {
      if (query.includes('from "heartbeat_runs"') && query.includes("nativeWorkspaceSync,workspaceId")) scans.push(query);
    };
    try {
      const scope = await inspectOnlineWorkspaceSource(db, selected);
      expect(scope).not.toBeNull();
      expect(scope!.companions).toEqual([...f.aliases.map(alias => alias.workspace.id), f.child.id].sort().map(workspaceId => ({
        workspaceId,
        sources: workspaceId === f.workspaceId ? [source] : [],
        holds: workspaceId === f.workspaceId ? [{ actionId: recovery.warning.id, ...preparedHold }]
          : workspaceId === f.aliases[1].workspace.id ? [{ actionId: finalizedRecovery.id, ...finalizedHold }] : [],
      })));
      expect(scope!.settledRecoveryIssueIds).toContain(finalizedIssue.id);
      expect(scans).toHaveLength(1);

      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: recovery.run.agentId,
        nativeIssueId: f.aliases[2].issue.id, status: "running", runtimeMode: "native",
        runnerProfileJson: { nativeWorkspaceSync: { workspaceId: f.aliases[2].workspace.id, state: "prepared" } } });
      scans.length = 0;
      expect(await inspectOnlineWorkspaceSource(db, selected)).toBeNull();
      expect(scans).toHaveLength(1);
    } finally { db.$client.options.debug = debug; }
  });
  it("imports a shared Git child while a terminal sibling recovery and unrelated remote execution remain intact", async () => {
    const recovery = await recoveryFixture(), f = await gitFixture(recovery);
    const unrelated = await remoteWriter(f.companyId, recovery.run.agentId);
    await fs.writeFile(path.join(f.child.cwd!, "saved.txt"), "staged child work\n");
    await git(f.child.cwd!, "add", ".");
    await fs.writeFile(path.join(f.child.cwd!, "saved.txt"), "unstaged child work\n");
    const input = { companyId: f.companyId, workspaceId: f.child.id };
    expect(await inventoryRemoteWorkspaceMigration(db, input)).toMatchObject({ eligible: true });
    await expect(migrateRemoteWorkspace({ db, storage, ...input, apply: true })).resolves.toMatchObject({ applied: true });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unrelated.id)))[0]).toEqual(unrelated);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, recovery.run.id)))[0]).toEqual(recovery.run);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, recovery.run.id)))[0]).toEqual(recovery.owner);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, recovery.warning.id)))[0]).toEqual(recovery.warning);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, recovery.lease.id)))[0]).toEqual(recovery.lease);
    const authority = readRemoteWorkspaceAuthority((await stored(f.child.id)).metadata)!;
    const reference = await getWorkspaceSnapshot(db, { companyId: f.companyId, workspaceId: f.child.id, snapshotId: authority.snapshotId! });
    const archivePath = path.join(home, "git-child.pcws"), targetDir = path.join(home, "git-child-restored");
    await loadWorkspaceSnapshotArchive({ storage, reference: reference!, targetPath: archivePath });
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
    await fs.rm(f.cwd, { recursive: true });
    await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: reference!.manifestDigest });
    expect(await git(targetDir, "show", ":saved.txt")).toBe("staged child work");
    expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("unstaged child work\n");
    await git(targetDir, "fsck", "--full", "--no-dangling");
  });
  it("takes the original private Git store owner before reserving an import journal", async () => {
    const f = await fixture();
    const [seed] = await db.insert(issues).values({ companyId: f.companyId, title: "Private seed owner" }).returning();
    const source = path.join(resolvePaperclipInstanceRoot(), "isolated-repository-sources", f.companyId, seed.id, "checkout");
    await fs.mkdir(source, { recursive: true }); await git(source, "init", "-q", "-b", "main");
    await fs.writeFile(path.join(source, "saved.txt"), "private seed work\n");
    await git(source, "add", "."); await git(source, "commit", "-qm", "Private seed");
    const repoUrl = "https://example.invalid/private-seed.git";
    await git(source, "remote", "add", "origin", repoUrl);
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Linked task" }).returning();
    const cwd = path.join(f.cwd, ".paperclip", "worktrees", "private-child");
    await git(source, "worktree", "add", "-qb", "private-child", cwd);
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: f.projectId,
      sourceIssueId: issue.id, name: "Private linked source", mode: "isolated_workspace", strategyType: "git_worktree",
      providerType: "git_worktree", cwd, providerRef: cwd, repoUrl, branchName: "private-child" }).returning();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const owner = withIsolatedRepositorySourceLock(db, f.companyId, seed.id, async () => { entered(); await pending; });
    await started;
    const input = { companyId: f.companyId, workspaceId: workspace.id };
    try {
      expect(await inventoryRemoteWorkspaceMigration(db, input)).toMatchObject({ eligible: true });
      await expect(migrateRemoteWorkspace({ db, storage, ...input, apply: true })).rejects.toBeInstanceOf(IsolatedRepositorySourceBusy);
      expect(await db.select().from(workspaceOperations)).toEqual([]);
    } finally { release(); await owner; }
    await expect(migrateRemoteWorkspace({ db, storage, ...input, apply: true })).resolves.toMatchObject({ applied: true });
    expect(await fs.readFile(path.join(source, "saved.txt"), "utf8")).toBe("private seed work\n");
  });
  it.each(["coordinator", "allocation", "locator", "git-metadata"] as const)("rechecks the shared Git companion %s before publication", async change => {
    const recovery = await recoveryFixture(), f = await gitFixture(recovery), barrier = uploadBarrier();
    const migration = migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: f.child.id, apply: true })
      .then(value => ({ value }), error => ({ error }));
    await Promise.race([barrier.started, migration.then(result => { if ("error" in result) throw result.error; throw new Error("capture did not upload"); })]);
    try {
      if (change === "coordinator") await db.update(nativeRunFinalizations).set({ leaseOwner: randomUUID(), leaseExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(nativeRunFinalizations.runId, recovery.run.id));
      if (change === "allocation") await db.update(environmentLeases).set({ metadata: { remoteCwd: "/changed-companion-source" } })
        .where(eq(environmentLeases.id, recovery.lease.id));
      if (change === "locator") await db.update(executionWorkspaces).set({ providerRef: path.join(home, "unproven-companion") })
        .where(eq(executionWorkspaces.id, f.aliases[1].workspace.id));
      if (change === "git-metadata") {
        const administration = await git(f.child.cwd!, "rev-parse", "--absolute-git-dir");
        await fs.writeFile(path.join(administration, "commondir"), path.join(f.cwd, ".git") + "\n");
      }
    } finally { barrier.release(); }
    const result = await migration;
    expect(result).toHaveProperty("error");
    expect("error" in result ? String(result.error) : "").toContain("online_workspace_source_scope_changed");
    expect(readRemoteWorkspaceAuthority((await stored(f.child.id)).metadata)).toBeNull();
    expect((await db.select().from(executionWorkspaceSnapshots))[0].status).toBe("uploaded");
    expect(await fs.readFile(path.join(f.child.cwd!, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
  });
  it("retains an imported nested child's private cache owner through parent source verification", async () => {
    const f = await gitFixture(), sourceIssueId = randomUUID();
    const source = path.join(resolvePaperclipInstanceRoot(), "isolated-repository-sources", f.companyId, sourceIssueId, "checkout");
    await git(f.cwd, "worktree", "remove", f.child.cwd!);
    await fs.mkdir(path.dirname(source), { recursive: true });
    await git(home, "clone", "--no-hardlinks", f.cwd, source);
    await git(source, "remote", "set-url", "origin", f.repoUrl);
    await git(source, "worktree", "add", "-qb", "private-child", f.child.cwd!);
    await db.update(executionWorkspaces).set({ branchName: "private-child" }).where(eq(executionWorkspaces.id, f.child.id));
    await migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: f.child.id, apply: true });
    expect((await stored(f.child.id)).providerType).toBe("cloud_sandbox");
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const owner = withWorkspaceSourceLocks(db, { companyId: f.companyId, issueIds: [sourceIssueId] }, async () => {
      entered(); await pending;
    });
    await started;
    try {
      await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toBeInstanceOf(IsolatedRepositorySourceBusy);
      expect(await db.select().from(workspaceOperations).where(eq(workspaceOperations.executionWorkspaceId, f.workspaceId))).toEqual([]);
    } finally { release(); await owner; }
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).resolves.toMatchObject({ applied: true });
    const authority = readRemoteWorkspaceAuthority((await stored(f.workspaceId)).metadata)!;
    const [snapshot] = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, authority.snapshotId!));
    expect(snapshot.metadata?.importedWorkspaceChildren).toEqual([expect.objectContaining({ workspaceId: f.child.id })]);
    expect(await fs.readFile(path.join(source, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
    expect(await fs.readFile(path.join(f.child.cwd!, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
  });

  it.each(["missing", "deleted"] as const)("rejects a Git parent with %s imported-child snapshot coverage", async state => {
    const f = await gitFixture();
    await migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: f.child.id, apply: true });
    const authority = readRemoteWorkspaceAuthority((await stored(f.child.id)).metadata)!;
    if (state === "missing") await db.delete(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, authority.snapshotId!));
    else await db.update(executionWorkspaceSnapshots).set({ status: "deleted" }).where(eq(executionWorkspaceSnapshots.id, authority.snapshotId!));
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: false,
      reasons: expect.arrayContaining(["overlapping_workspace_requires_maintenance"]) });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("overlapping_workspace_requires_maintenance");
    expect(readRemoteWorkspaceAuthority((await stored(f.workspaceId)).metadata)).toBeNull();
    expect(await db.select().from(workspaceOperations).where(eq(workspaceOperations.executionWorkspaceId, f.workspaceId))).toEqual([]);
    expect(await fs.readFile(path.join(f.child.cwd!, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
  });
  it.each([false, true])("requires exact imported-child coverage for an online shared Git parent (%s)", async changed => {
    const f = await gitFixture();
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: false,
      reasons: expect.arrayContaining(["nested_workspace_import_required"]) });
    await migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: f.child.id, apply: true });
    if (changed) await fs.writeFile(path.join(f.child.cwd!, "new-work.txt"), "changed after child import\n");
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: true });
    const migration = migrateRemoteWorkspace({ db, storage, ...f, apply: true });
    if (changed) {
      await expect(migration).rejects.toThrow("nested_workspace_source_changed");
      expect(readRemoteWorkspaceAuthority((await stored(f.workspaceId)).metadata)).toBeNull();
      expect(await fs.readFile(path.join(f.child.cwd!, "new-work.txt"), "utf8")).toBe("changed after child import\n");
    } else {
      await expect(migration).resolves.toMatchObject({ applied: true });
      const authority = readRemoteWorkspaceAuthority((await stored(f.workspaceId)).metadata)!;
      const [snapshot] = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, authority.snapshotId!));
      expect(snapshot.metadata?.importedWorkspaceChildren).toEqual([expect.objectContaining({ workspaceId: f.child.id })]);
    }
  });
  it("imports a terminal prepared source while retaining its original provider and finalization obligations", async () => {
    const f = await recoveryFixture(), put = storage.putFile.bind(storage);
    const unrelated = await remoteWriter(f.companyId, f.run.agentId);
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: true });
    vi.spyOn(storage, "putFile").mockImplementationOnce(async input => {
      await db.transaction(async tx => {
        expect(await tryLockNativeWorkspaceFinalization(tx as unknown as Db, { companyId: f.companyId, runId: f.run.id })).toBe(false);
      });
      return put(input);
    });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).resolves.toMatchObject({ applied: true });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id)))[0]).toEqual(f.owner);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0]).toEqual(f.lease);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.warning.id)))[0]).toEqual(f.warning);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unrelated.id)))[0]).toEqual(unrelated);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(run.runnerProfileJson?.nativeWorkspaceSync).toEqual(f.run.runnerProfileJson?.nativeWorkspaceSync);
    expect(run.runnerProfileJson?.legacyWorkspaceRecoveryMigration).toMatchObject({ workspaceId: f.workspaceId });
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
  });
  it.each(["expired_owner", "checkpoint", "allocation"] as const)("keeps a prepared source local when %s changes", async change => {
    const f = await recoveryFixture();
    if (change === "expired_owner") await db.update(nativeRunFinalizations).set({ leaseOwner: "still-owned", leaseExpiresAt: new Date(0) })
      .where(eq(nativeRunFinalizations.runId, f.run.id));
    else {
      const put = storage.putFile.bind(storage);
      vi.spyOn(storage, "putFile").mockImplementationOnce(async input => {
        const result = await put(input);
        if (change === "checkpoint") await db.update(nativeRunFinalizations).set({ recoveryHistory: [{ intent: "changed" }] })
          .where(eq(nativeRunFinalizations.runId, f.run.id));
        else await db.update(environmentLeases).set({ metadata: { remoteCwd: "/changed-allocation" } }).where(eq(environmentLeases.id, f.lease.id));
        return result;
      });
    }
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow();
    expect(readRemoteWorkspaceAuthority((await stored(f.workspaceId)).metadata)).toBeNull();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
  });
});
