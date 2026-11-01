import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, applyPendingMigrations, closeRegisteredClients, companies, createDb, environmentLeases, environments,
  executionWorkspaces, executionWorkspaceSnapshots, heartbeatRuns, issues, projects, workspaceOperations, workspaceRuntimeServices, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, type RemoteWorkspaceAuthority } from "@paperclipai/shared";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { environmentService } from "./environments.js";
import { executionWorkspaceService, toExecutionWorkspace } from "./execution-workspaces.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { cleanupExecutionWorkspaceArtifacts, ensureRuntimeServicesForRun, restartDesiredRuntimeServicesOnStartup, startRuntimeServicesForWorkspaceControl } from "./workspace-runtime.js";
import { withExecutionWorkspaceLifecycleLock } from "./execution-workspace-lifecycle-lock.js";
import { workspaceOperationService } from "./workspace-operations.js";
import { inventoryRemoteWorkspaceMigration } from "./remote-workspace-migration.js";
import { hasPendingNestedCloneMigration, isNestedCloneMigrationCandidate, listNestedCloneMigrationNames,
  migrateNestedRepositoryClone, pendingNestedCloneMigrationNames } from "./nested-clone-migration.js";

const url = resolveExternalTestDatabaseUrl("PAPERCLIP_REMOTE_WORKSPACE_LIFECYCLE_TEST_DATABASE_URL");
describe.skipIf(!url)("remote workspace close and allocation cleanup", () => {
  let db: Db;
  const directories: string[] = [];
  beforeAll(async () => { await applyPendingMigrations(url!); db = createDb(url!); }, 120_000);
  beforeEach(async () => {
    await db.execute(sql`set client_min_messages = warning`);
    await db.execute(sql`truncate table companies, execution_workspace_snapshots, environments restart identity cascade`);
  });
  afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
  afterAll(async () => { await closeRegisteredClients(url!, { scope: "database" }); });

  async function fixture(receiptState: "destroyed" | "stopped" | "invalid" = "destroyed") {
    const [company] = await db.insert(companies).values({ name: "Remote close", issuePrefix: "RC" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Native worker", adapterType: "paperclip_runner" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Saved work", status: "done",
      completedAt: new Date(0), assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
      nativeIssueId: issue.id, runtimeMode: "native", status: "succeeded", finishedAt: new Date() }).returning();
    const [environment] = await db.insert(environments).values({ name: `Remote close ${randomUUID()}`, driver: "sandbox", config: { provider: "daytona" } }).returning();
    const cwd = await mkdtemp(join(tmpdir(), "paperclip-remote-close-")); directories.push(cwd);
    await writeFile(join(cwd, "host-sentinel.txt"), "Host files must never be cleaned as remote files.");
    const workspaceId = randomUUID(), leaseId = randomUUID(), snapshotId = randomUUID(), providerLeaseId = `allocation-${randomUUID()}`;
    const authority: RemoteWorkspaceAuthority = { schema: "paperclip.remote-workspace.v1", epoch: 1,
      snapshotId, source: { kind: "empty" }, writerRunId: null, dirty: false,
      location: { environmentId: environment.id, leaseId, providerLeaseId, remoteCwd: cwd } };
    const [workspace] = await db.insert(executionWorkspaces).values({ id: workspaceId, companyId: company.id, sourceIssueId: issue.id,
      name: "Remote files", cwd, providerRef: cwd, providerType: "cloud_sandbox", mode: "isolated_workspace",
      strategyType: "git_worktree", status: "active", metadata: { remoteWorkspace: authority } }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, issue.id));
    await db.insert(executionWorkspaceSnapshots).values({ id: snapshotId, companyId: company.id,
      executionWorkspaceId: workspace.id, sourceOperationId: randomUUID(), sourceRunId: run.id,
      generation: 1, epoch: 1, status: "committed", objectKey: "saved-workspace-object", sha256: "a".repeat(64), byteSize: 1 });
    await db.insert(environmentLeases).values({ id: leaseId, companyId: company.id, environmentId: environment.id,
      heartbeatRunId: run.id, issueId: issue.id, executionWorkspaceId: workspace.id, provider: "daytona", providerLeaseId,
      leasePolicy: "ephemeral", status: "active", metadata: { driver: "sandbox", remoteCwd: cwd } });
    const environmentsSvc = environmentService(db);
    const base = environmentRuntimeService(db).getDriver("sandbox")!;
    const destroyProvider = vi.fn(async (input: Parameters<NonNullable<typeof base.destroyRunLease>>[0]) => environmentsSvc.releaseLease(input.lease.id, "released", {
      cleanupStatus: "success", remoteExecutionTermination: remoteTerminationReceipt(input.lease, {
        state: receiptState === "stopped" ? "stopped" : "destroyed",
        providerLeaseId: receiptState === "invalid" ? "wrong-allocation" : input.lease.providerLeaseId,
      }),
    }));
    const runtime = environmentRuntimeService(db, { drivers: [{ ...base, destroyRunLease: destroyProvider }] });
    const inspectLocal = vi.fn(async () => { throw new Error("Controller Git inspection must not run"); });
    const service = executionWorkspaceService(db, { destroyRemoteWorkspaceLease: input => runtime.destroyRemoteWorkspaceLease(input),
      inspectGitCloseReadiness: inspectLocal, workspaceReaperCooldownDays: 0, gitCacheExpirationEnabled: true,
      gitRestorePoints: undefined });
    return { company, issue, run, workspace, snapshotId, authority, service, destroyProvider, inspectLocal, cwd, environmentsSvc, leaseId };
  }
  const current = async (id: string) => (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id)))[0]!;

  it.each([true, false])("rejects automatic Core services before controller access (skip provision: %s)", async skipHostProvision => {
    const f = await fixture();
    const inspect = vi.spyOn(fs, "lstat");
    const log = vi.fn();
    await expect(ensureRuntimeServicesForRun({ db, runId: f.run.id,
      agent: { id: f.run.agentId, companyId: f.company.id, name: "Native worker" }, issue: null,
      workspace: { cwd: f.cwd, baseCwd: f.cwd, source: "task_session", projectId: null, workspaceId: null,
        repoUrl: null, repoRef: null, strategy: "git_worktree", branchName: null, worktreePath: f.cwd,
        warnings: [], created: false, branchCreatedByRuntime: false }, executionWorkspaceId: f.workspace.id,
      config: { workspaceRuntime: { services: [{ name: "web", command: "/__paperclip_missing_remote_service__", cwd: "." }] } },
      adapterEnv: {}, skipHostProvision, onLog: log,
    })).rejects.toMatchObject({ code: "workspace_validation_failed", resultJson: { reason: "remote_workspace_runtime_services_unsupported" } });
    expect(inspect).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(await readFile(join(f.cwd, "host-sentinel.txt"), "utf8")).toContain("never be cleaned");
  });

  it.each(["remote", "import"])("does not inspect or recover nested controller clones under a %s storage fence", async mode => {
    const f = await fixture();
    const [project] = await db.insert(projects).values({ companyId: f.company.id, name: "Remote project" }).returning();
    await db.update(executionWorkspaces).set({ projectId: project.id,
      ...(mode === "import" ? { providerType: "local_fs" } : {}),
      metadata: { ...(mode === "remote" ? { remoteWorkspace: f.authority } : {
        remoteWorkspaceMigration: { schema: "paperclip.remote-workspace-migration.v1", state: "running", operationId: randomUUID() },
      }),
      nestedCloneMigrationPending: { "repo-123456789abc": { phase: "cleanup" } } } }).where(eq(executionWorkspaces.id, f.workspace.id));
    const workspace = await current(f.workspace.id);
    const inspect = vi.spyOn(fs, "lstat");
    expect(isNestedCloneMigrationCandidate(workspace)).toBe(false);
    expect(hasPendingNestedCloneMigration(workspace)).toBe(false);
    expect(pendingNestedCloneMigrationNames(workspace)).toEqual([]);
    expect(await listNestedCloneMigrationNames(db, workspace)).toEqual([]);
    expect(await migrateNestedRepositoryClone(db, workspace, "repo-123456789abc")).toMatchObject({ outcome: "skipped", reason: "not_candidate" });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("closes remote compute under the lifecycle fence and keeps saved files and host paths intact", async () => {
    const f = await fixture();
    await f.service.update(f.workspace.id, { metadata: { userNote: "Keep", remoteWorkspace: { ...f.authority, dirty: false, location: null } } });
    expect(readRemoteWorkspaceAuthority((await current(f.workspace.id)).metadata)?.location).toEqual(f.authority.location);
    await expect(f.service.update(f.workspace.id, { providerType: "local_fs" })).rejects.toThrow("sandbox storage");
    const readiness = await f.service.getCloseReadiness(f.workspace.id);
    expect(readiness).toMatchObject({ state: "ready", git: null, isDestructiveCloseAllowed: true });
    expect(readiness!.plannedActions.map(action => action.kind)).toEqual(["archive_record", "remove_provider_workspace"]);
    const archived = await f.service.archiveWorkspaceUnderLifecycleLock({ id: f.workspace.id, patch: {}, closedAt: new Date() });
    if (archived?.outcome !== "archived") throw new Error("Expected a close receipt");
    await f.service.fenceClosedWorkspaceDestruction({ workspaceId: f.workspace.id, capturedGeneration: archived.capturedGeneration,
      destroy: () => f.service.cleanupRemoteStorage(archived.workspace) });
    expect(f.destroyProvider).toHaveBeenCalledTimes(1);
    expect(f.destroyProvider.mock.calls[0]![0].lease).toMatchObject({ status: "pending_cleanup", leasePolicy: "ephemeral" });
    expect(readRemoteWorkspaceAuthority((await current(f.workspace.id)).metadata)).toMatchObject({ location: null, snapshotId: f.snapshotId });
    expect((await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, f.snapshotId)))[0]!.status).toBe("committed");
    expect(await readFile(join(f.cwd, "host-sentinel.txt"), "utf8")).toContain("never be cleaned");
    expect(f.inspectLocal).not.toHaveBeenCalled();
    await expect(cleanupExecutionWorkspaceArtifacts({ workspace: f.workspace })).rejects.toThrow("sandbox lifecycle");
  });

  it.each(["stopped", "invalid"] as const)("retains location until destruction is proved (%s)", async state => {
    const f = await fixture(state);
    await db.update(executionWorkspaces).set({ status: "archived", closedAt: new Date() }).where(eq(executionWorkspaces.id, f.workspace.id));
    await expect(f.service.cleanupRemoteStorage(toExecutionWorkspace({ ...f.workspace, status: "archived" }))).rejects.toThrow("remote_workspace_cleanup_unconfirmed");
    expect(readRemoteWorkspaceAuthority((await current(f.workspace.id)).metadata)?.location).toEqual(f.authority.location);
  });

  it("blocks close while a save is pending and leaves the allocation available for recovery", async () => {
    const f = await fixture();
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { ...f.authority, dirty: true, writerRunId: f.run.id } } })
      .where(eq(executionWorkspaces.id, f.workspace.id));
    expect(await f.service.getCloseReadiness(f.workspace.id)).toMatchObject({ state: "blocked", isDestructiveCloseAllowed: false });
    expect(f.destroyProvider).not.toHaveBeenCalled();
  });

  it("preserves the automatic delivery gate and retries an explicitly closed remote allocation", async () => {
    const f = await fixture();
    const active = await f.service.sweepTerminalWorkspaces();
    expect(active).toMatchObject({ archived: 0, skippedUndelivered: 1 });
    expect(f.destroyProvider).not.toHaveBeenCalled();
    await db.update(executionWorkspaces).set({ status: "cleanup_failed", closedAt: new Date() }).where(eq(executionWorkspaces.id, f.workspace.id));
    const closed = await f.service.sweepTerminalWorkspaces();
    expect(closed).toMatchObject({ archived: 1, cleanupFailed: 0 });
    expect(f.destroyProvider).toHaveBeenCalledTimes(1);
    expect(readRemoteWorkspaceAuthority((await current(f.workspace.id)).metadata)?.location).toBeNull();
    expect(await readFile(join(f.cwd, "host-sentinel.txt"), "utf8")).toContain("never be cleaned");
    expect(f.inspectLocal).not.toHaveBeenCalled();
  });

  it("reopens saved remote work by changing its lifecycle without rebuilding a controller folder", async () => {
    const f = await fixture();
    await db.update(executionWorkspaces).set({ status: "archived", closedAt: new Date(),
      metadata: { remoteWorkspace: { ...f.authority, location: null } } }).where(eq(executionWorkspaces.id, f.workspace.id));
    const reopened = await f.service.reopenClosedIsolatedExecutionWorkspaceForIssue({ workspaceId: f.workspace.id,
      issue: { id: f.issue.id, companyId: f.company.id, projectId: null }, actor: { actorType: "user", agentId: null },
      authorizationActor: { type: "board", source: "local_implicit", isInstanceAdmin: true } });
    expect(reopened).toMatchObject({ ok: true, reopened: true, workspace: { status: "active", closedAt: null } });
    expect(readRemoteWorkspaceAuthority((await current(f.workspace.id)).metadata)).toMatchObject({ snapshotId: f.snapshotId, location: null });
    expect(f.destroyProvider).not.toHaveBeenCalled();
    expect(f.inspectLocal).not.toHaveBeenCalled();
    expect(await readFile(join(f.cwd, "host-sentinel.txt"), "utf8")).toContain("never be cleaned");
  });

  it.each([
    { caller: "direct", state: "remote" }, { caller: "startup", state: "remote" },
    { caller: "direct", state: "migrating" }, { caller: "startup", state: "migrating" },
  ] as const)("rechecks $caller control authority after waiting for $state migration publication", async ({ caller, state }) => {
    const f = await fixture();
    const escaped = join(f.cwd, "unexpected-start.txt");
    const command = `node -e 'require("fs").writeFileSync(${JSON.stringify(escaped)},"unexpected")'`;
    const config = { desiredState: "running", runtimeProvisionCommand: command,
      workspaceRuntime: { services: [{ name: "web", command, cwd: "." }] } };
    await db.update(executionWorkspaces).set({ providerType: "local_fs", strategyType: "project_primary", metadata: { config } })
      .where(eq(executionWorkspaces.id, f.workspace.id));
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let ready!: (pid: number) => void;
    const locked = new Promise<number>(resolve => { ready = resolve; });
    const migration = withExecutionWorkspaceLifecycleLock(db, f.workspace.id, async tx => {
      const [row] = await tx.execute(sql`select pg_backend_pid() as pid`);
      ready(Number(row.pid));
      await released;
      await db.update(executionWorkspaces).set({ providerType: state === "remote" ? "cloud_sandbox" : "local_fs",
        metadata: state === "remote" ? { config, remoteWorkspace: f.authority } : { config,
          remoteWorkspaceMigration: { schema: "paperclip.remote-workspace-migration.v1", state: "running" } } })
        .where(eq(executionWorkspaces.id, f.workspace.id));
    });
    const blocker = await locked;
    const starting = caller === "startup" ? restartDesiredRuntimeServicesOnStartup(db) : startRuntimeServicesForWorkspaceControl({
      db, actor: { id: null, companyId: f.company.id, name: "Board" }, issue: null, executionWorkspaceId: f.workspace.id,
      workspace: { cwd: f.cwd, baseCwd: f.cwd, source: "task_session", projectId: null, workspaceId: null,
        repoUrl: null, repoRef: null, strategy: "project_primary", branchName: null, worktreePath: null,
        warnings: [], created: false, branchCreatedByRuntime: false }, config, adapterEnv: {},
    });
    const settled = starting.then(value => ({ value }), error => ({ error }));
    try {
      // Prove the stale request is waiting on the actual PostgreSQL lifecycle
      // fence, then switch authority before admitting it. No timing sleep.
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`select count(*)::int as waiting from pg_stat_activity
          where ${blocker} = any(pg_blocking_pids(pid))`);
        expect(Number(row.waiting)).toBeGreaterThan(0);
      });
    } finally { release(); }
    await migration;
    const result = await settled;
    if (caller === "startup") expect(result).toMatchObject({ value: { restarted: 0, failed: 1 } });
    else expect(result).toMatchObject({ error: { status: state === "remote" ? 422 : 409,
      details: { code: state === "remote" ? "remote_workspace_runtime_commands_unsupported" : "workspace_runtime_migration_in_progress" } } });
    await expect(fs.access(escaped)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await db.select().from(workspaceRuntimeServices)).toEqual([]);
    expect(await readFile(join(f.cwd, "host-sentinel.txt"), "utf8")).toContain("never be cleaned");
  });

  it("publishes runtime admission before releasing the migration fence and keeps migration operations blocking", async () => {
    const f = await fixture();
    await db.update(executionWorkspaces).set({ providerType: "local_fs", strategyType: "project_primary", metadata: {} })
      .where(eq(executionWorkspaces.id, f.workspace.id));
    const operations = workspaceOperationService(db);
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    let admitted!: () => void;
    const admission = new Promise<void>(resolve => { admitted = resolve; });
    const running = operations.createRecorder({ companyId: f.company.id, executionWorkspaceId: f.workspace.id }).recordOperation({
      phase: "workspace_provision", metadata: { action: "run" },
      admit: publish => withExecutionWorkspaceLifecycleLock(db, f.workspace.id, async () => { await publish(); }),
      run: async () => { admitted(); await finished; return {}; },
    });
    try {
      await admission;
      const inventory = await withExecutionWorkspaceLifecycleLock(db, f.workspace.id,
        () => inventoryRemoteWorkspaceMigration(db, { companyId: f.company.id, workspaceId: f.workspace.id }));
      expect(inventory.reasons).toContain("workspace_operation_unresolved");
    } finally { finish(); }
    await running;
    const [migration] = await db.insert(workspaceOperations).values({ companyId: f.company.id, executionWorkspaceId: f.workspace.id,
      phase: "remote_workspace_migration", status: "running", metadata: {}, startedAt: new Date(0), updatedAt: new Date(0) }).returning();
    await expect(operations.assertRuntimeControlAvailable({ executionWorkspaceId: f.workspace.id, action: "start" }))
      .rejects.toMatchObject({ status: 409, details: { activeOperationId: migration.id } });
    expect((await operations.getById(migration.id))?.status).toBe("running");
  });

  it("does not resolve a controller folder when a remote control has no selected services", async () => {
    const f = await fixture();
    await expect(startRuntimeServicesForWorkspaceControl({ db,
      actor: { id: null, companyId: f.company.id, name: "Board" }, issue: null, executionWorkspaceId: f.workspace.id,
      workspace: { get cwd(): string { throw new Error("Empty control read a controller folder"); },
        baseCwd: f.cwd, source: "task_session", projectId: null, workspaceId: null, repoUrl: null, repoRef: null,
        strategy: "git_worktree", branchName: null, worktreePath: null, warnings: [], created: false, branchCreatedByRuntime: false },
      config: { desiredState: "stopped", workspaceRuntime: { services: [{ name: "web", command: "node web.js" }] } },
      adapterEnv: {}, respectDesiredStates: true,
    })).resolves.toEqual([]);
  });
});
