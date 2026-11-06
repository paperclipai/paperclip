import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, environmentLeases, heartbeatRuns, nativeRunFinalizations, nativeRunResults, completionContracts, applyPendingMigrations, closeRegisteredClients, companies, createDb, executionWorkspaceSnapshots,
  executionWorkspaceRuntimeLeases, executionWorkspaces, issueRecoveryActions, issues, projects, projectWorkspaces, workspaceOperations, workspaceRuntimeServices } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { migrateWorkspaceTrees } from "./remote-workspace-migration-batch.js";
import { inventoryRemoteWorkspaceMigration, migrateRemoteWorkspace } from "./remote-workspace-migration.js";
import { getWorkspaceSnapshot, loadWorkspaceSnapshotArchive } from "./remote-workspace-snapshot-storage.js";
import { restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { captureTaskDirectorySnapshot, removeTaskDirectoryTree } from "./isolated-task-directory-snapshot.js";
import { captureRestorePoint, sealRestorePoint } from "./git-restore-point.js";
import type { TaskDirectoryRestorePointRef } from "./isolated-task-directory-retention.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { cleanupExecutionWorkspaceArtifacts } from "./workspace-runtime.js";
import { workspaceOperationService } from "./workspace-operations.js";
import { resumeNativeWorkspaceSync } from "./native-runtime/native-workspace-sync.js";
import { claimNativeSessionResumptions } from "./native-runtime/native-finalization-reconciler.js";
import { claimNativeRestartRecoveries } from "./native-runtime/native-restart-recovery.js";
import { attemptNativeWorkspaceFinalization } from "./native-runtime/native-workspace-finalizer.js";
import { managedProjectCheckoutName } from "./managed-project-checkout-name.js";
import { captureGitWorkspaceContents, readManagedCheckoutContents } from "./git-workspace-contents.js";
import { isolatedRemoteSourcePath } from "./isolated-remote-workspace-source.js";
import { verifiedGitCacheSource } from "./git-workspace-restoration.js";

const execute = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execute("git", ["-C", cwd, ...args], { env: { ...process.env,
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_AUTHOR_NAME: "Migration", GIT_COMMITTER_NAME: "Migration",
  GIT_AUTHOR_EMAIL: "migration@example.test", GIT_COMMITTER_EMAIL: "migration@example.test" } })).stdout.trim();

const url = process.env.PAPERCLIP_TEST_DATABASE_URL;
if (url && !/^remote_workspace_[a-z_]*test$/.test(new URL(url).pathname.slice(1))) throw new Error("Disposable remote_workspace_*test database required");
const support = url ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("remote workspace migration", () => {
  let db: ReturnType<typeof createDb>, root: string, storage: StorageService;
  const servers: Server[] = [];
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    if (url) { await applyPendingMigrations(url); db = createDb(url); }
    else { temporary = await startEmbeddedPostgresTestDatabase("workspace-migration-"); db = createDb(temporary.connectionString); }
  }, 90_000);
  afterAll(async () => { if (url) await closeRegisteredClients(url, { scope: "database" }); else await temporary?.cleanup(); });
  beforeEach(async () => { vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "61".repeat(32));
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-migration-test-")); storage = createStorageService(createLocalDiskStorageProvider(path.join(root, "objects"))); });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    vi.unstubAllEnvs(); await db.delete(activityLog); await db.delete(workspaceOperations); await db.delete(executionWorkspaceSnapshots);
    await db.delete(workspaceRuntimeServices); await db.delete(executionWorkspaceRuntimeLeases);
    await db.delete(nativeRunFinalizations); await db.delete(nativeRunResults); await db.delete(heartbeatRuns); await db.delete(completionContracts);
    await db.delete(issues); await db.delete(agents); await db.delete(executionWorkspaces); await db.delete(projectWorkspaces); await db.delete(projects);
    await db.delete(companies); await fs.rm(root, { recursive: true, force: true });
  });
  async function seed() {
    const companyId = randomUUID(), workspaceId = randomUUID(), cwd = path.join(root, "original"); await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "saved.txt"), "original saved work\n");
    await db.insert(companies).values({ id: companyId, name: "Migration", issuePrefix: `M${companyId.slice(0, 6)}` });
    const [issue] = await db.insert(issues).values({ companyId, title: "Existing task" }).returning();
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issue!.id, mode: "isolated_workspace",
      strategyType: "project_primary", providerType: "local_fs", name: "Existing workspace", cwd, providerRef: cwd, metadata: { retainedNote: "keep" } });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issue!.id));
    return { companyId, workspaceId, issueId: issue!.id, cwd };
  }
  async function workspace(id: string) { return (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id)))[0]!; }
  async function nestedFixture() {
    const parent = await seed(), workspaceId = randomUUID();
    const cwd = path.join(parent.cwd, ".paperclip", "worktrees", "child");
    await fs.mkdir(cwd, { recursive: true }); await fs.writeFile(path.join(cwd, "child.txt"), "saved child edits\n");
    const [issue] = await db.insert(issues).values({ companyId: parent.companyId, title: "Nested task" }).returning();
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId: parent.companyId, sourceIssueId: issue!.id,
      name: "Child workspace", mode: "isolated_workspace", strategyType: "project_primary", providerType: "local_fs", cwd, providerRef: cwd });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issue!.id));
    return { parent, child: { companyId: parent.companyId, workspaceId, issueId: issue!.id, cwd } };
  }
  it("requires offline maintenance for overlapping physical workspace paths", async () => {
    const { parent, child } = await nestedFixture();
    await expect(migrateRemoteWorkspace({ db, storage, ...child, apply: true })).rejects.toThrow("overlapping_workspace_requires_maintenance");
    await expect(migrateRemoteWorkspace({ db, storage, ...parent, apply: true })).rejects.toThrow("overlapping_workspace_requires_maintenance");
    expect(await fs.readFile(path.join(child.cwd, "child.txt"), "utf8")).toBe("saved child edits\n");
  });
  it("imports nested task files before their parent and retains independently restorable copies", async () => {
    const { parent, child } = await nestedFixture(); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    await migrateRemoteWorkspace({ db, storage, ...child, apply: true, writersStopped: true });
    await migrateRemoteWorkspace({ db, storage, ...parent, apply: true, writersStopped: true });
    await fs.rm(parent.cwd, { recursive: true });
    for (const [name, fixture] of [["parent", parent], ["child", child]] as const) {
      const authority = readRemoteWorkspaceAuthority((await workspace(fixture.workspaceId)).metadata)!;
      const ref = await getWorkspaceSnapshot(db, { ...fixture, snapshotId: authority.snapshotId! });
      const archivePath = path.join(root, `${name}.pcws`), targetDir = path.join(root, `restored-${name}`);
      await loadWorkspaceSnapshotArchive({ storage, reference: ref!, targetPath: archivePath });
      await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: ref!.manifestDigest });
      expect(await fs.readFile(path.join(targetDir, name === "parent" ? "saved.txt" : "child.txt"), "utf8"))
        .toBe(name === "parent" ? "original saved work\n" : "saved child edits\n");
      if (name === "parent") {
        expect(await fs.stat(path.join(targetDir, ".paperclip", "worktrees", "child")).catch(() => null)).toBeNull();
        const [snapshot] = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, ref!.id));
        expect(snapshot.metadata?.importedWorkspaceChildren).toEqual([expect.objectContaining({ workspaceId: child.workspaceId,
          relativePath: ".paperclip/worktrees/child" })]);
      }
    }
  });
  it("requires the offline entry point even when a caller asserts writers stopped", async () => {
    const { parent } = await nestedFixture();
    await expect(migrateRemoteWorkspace({ db, storage, ...parent, apply: true, writersStopped: true })).rejects.toThrow("offline_maintenance_required");
    await expect(migrateWorkspaceTrees(db, { storage, signal: new AbortController().signal, phase: () => {} })).rejects.toThrow("offline_maintenance_required");
  });
  it.each(["running", "queued"])("refuses offline archived imports while any execution is running or requeued (%s)", async status => {
    const f = await seed(); await retainDirectory(f); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Unrelated writer" }).returning();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent!.id, status, startedAt: status === "queued" ? new Date() : null });
    await expect(migrateWorkspaceTrees(db, { storage, signal: new AbortController().signal, phase: () => {} }))
      .rejects.toThrow("active_execution_requires_drain");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
  });
  it.each(["startedAt", "runtimeModeResolvedAt", "processPid", "processStartedAt", "runnerInstanceId", "nativeSessionId", "nativePhase", "controllerLeaseExpiresAt", "executionStage", "checkpoint", "finalizer", "lease"])("keeps queued execution with %s as an offline blocker", async evidence => {
    const f = await seed(); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Retained execution" }).returning();
    const patch = evidence.endsWith("At") ? { [evidence]: new Date() }
      : evidence === "processPid" ? { processPid: 123 }
      : evidence.endsWith("Id") ? { [evidence]: randomUUID() }
      : evidence === "nativePhase" ? { nativePhase: "observed" }
      : evidence === "executionStage" ? { executionStage: "dispatch" }
      : evidence === "checkpoint" ? { runnerProfileJson: { sessionCheckpoint: {} } } : {};
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent!.id,
      nativeIssueId: evidence === "finalizer" ? f.issueId : null, status: "queued", ...patch }).returning();
    if (evidence === "finalizer") await db.insert(nativeRunFinalizations).values({ companyId: f.companyId,
      issueId: f.issueId, runId: run!.id, phase: "observed" });
    if (evidence === "lease") await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: run!.id });
    await expect(migrateWorkspaceTrees(db, { storage, signal: new AbortController().signal, phase: () => {} }))
      .rejects.toThrow("active_execution_requires_drain");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
  });
  it("preserves an unstarted queued turn during offline import while live migration still refuses it", async () => {
    const f = await seed();
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Queued turn" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent!.id,
      issueId: f.issueId, status: "queued", contextSnapshot: { issueId: f.issueId, executionWorkspaceId: f.workspaceId } }).returning();
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("active_execution");
    vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    await migrateRemoteWorkspace({ db, storage, ...f, apply: true, writersStopped: true });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)))[0]).toEqual(run);
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).not.toBeNull();
  });
  it.each([["stranded_assigned_issue", "stranded_assigned_issue"], ["configuration_validation", "configuration_incomplete"],
    ["missing_disposition", "successful_run_missing_state"], ["deliberate_wait_without_target", "deliberate_wait_without_target"]])("preserves a task-only %s warning through offline file migration", async (kind, cause) => {
    const f = await seed();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind, cause, fingerprint: randomUUID(), nextAction: "Keep the existing task warning", evidence: { latestRunStatus: "failed" } }).returning();
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("workspace_recovery_unresolved");
    vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    await migrateRemoteWorkspace({ db, storage, ...f, apply: true, writersStopped: true });
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id)))[0]).toEqual(action);
    const authority = readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)!;
    const ref = await getWorkspaceSnapshot(db, { ...f, snapshotId: authority.snapshotId! });
    const archivePath = path.join(root, "task-warning.pcws"), targetDir = path.join(root, "restored-task-warning");
    await fs.rm(f.cwd, { recursive: true });
    await loadWorkspaceSnapshotArchive({ storage, reference: ref!, targetPath: archivePath });
    await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: ref!.manifestDigest });
    expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("original saved work\n");
  });
  it.each(["workspaceRestoreRecovery", "workspaceRecovery", "historicalWorkspaceSource", "systemRecovery", "nativeFailureBlock", "export-cause", "unknown-kind", "workspace_validation", "active_run_watchdog"])("retains unresolved file or execution recovery as an offline blocker (%s)", async mode => {
    const f = await seed(); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: mode === "unknown-kind" ? "future_recovery" : ["workspace_validation", "active_run_watchdog"].includes(mode) ? mode : "configuration_validation",
      cause: mode === "export-cause" ? "native_workspace_sync_out_unrecoverable" : mode === "workspace_validation" ? "workspace_validation_failed"
        : mode === "active_run_watchdog" ? "native_session_interrupted" : "configuration_incomplete",
      fingerprint: randomUUID(), nextAction: "Preserve unresolved recovery", evidence: ["export-cause", "unknown-kind", "workspace_validation", "active_run_watchdog"].includes(mode) ? {}
        : { [mode]: mode === "systemRecovery" ? { state: "running" } : { schema: "unverified" } } });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true, writersStopped: true })).rejects.toThrow("workspace_recovery_unresolved");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
  });
  it("rechecks a task warning that becomes file recovery during upload", async () => {
    const f = await seed(); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    const [action] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "configuration_validation", cause: "configuration_incomplete", fingerprint: randomUUID(), nextAction: "Repair configuration" }).returning();
    const put = storage.putFile.bind(storage);
    storage.putFile = async input => { const result = await put(input);
      await db.update(issueRecoveryActions).set({ evidence: { historicalWorkspaceSource: { schema: "paperclip.historical-workspace-source.v1" } } })
        .where(eq(issueRecoveryActions.id, action!.id)); return result; };
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true, writersStopped: true })).rejects.toThrow("workspace_recovery_unresolved");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
  });
  it("detects overlapping folders reached through symlinked parent directories", async () => {
    const f = await seed(), alias = path.join(root, "alias"); await fs.symlink(root, alias);
    await db.insert(executionWorkspaces).values({ companyId: f.companyId, name: "Physical alias", mode: "isolated_workspace",
      strategyType: "project_primary", providerType: "local_fs", cwd: path.join(alias, "original") });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("overlapping_workspace_requires_maintenance");
  });
  it.each(["current", "legacy"])("keeps the parent capture scope when children migrate between retries (%s)", async journal => {
    const { parent, child } = await nestedFixture(); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    const put = storage.putFile.bind(storage); let fail = true;
    storage.putFile = async input => { const saved = await put(input); if (fail) { fail = false; throw new Error("upload reply lost"); } return saved; };
    await expect(migrateRemoteWorkspace({ db, storage, ...parent, apply: true, writersStopped: true })).rejects.toThrow("upload reply lost");
    if (journal === "legacy") {
      const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.executionWorkspaceId, parent.workspaceId));
      const metadata = { ...operation!.metadata }; delete metadata.nestedWorkspaceScope;
      await db.update(workspaceOperations).set({ metadata }).where(eq(workspaceOperations.id, operation!.id));
    }
    await migrateRemoteWorkspace({ db, storage, ...child, apply: true, writersStopped: true });
    await migrateRemoteWorkspace({ db, storage, ...parent, apply: true, writersStopped: true });
    const authority = readRemoteWorkspaceAuthority((await workspace(parent.workspaceId)).metadata)!;
    const reference = await getWorkspaceSnapshot(db, { ...parent, snapshotId: authority.snapshotId! });
    const archivePath = path.join(root, "retried-parent.pcws"), targetDir = path.join(root, "retried-parent");
    await loadWorkspaceSnapshotArchive({ storage, reference: reference!, targetPath: archivePath });
    await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: reference!.manifestDigest });
    expect(await fs.readFile(path.join(targetDir, ".paperclip/worktrees/child/child.txt"), "utf8")).toBe("saved child edits\n");
  });
  async function failedCopybackFixture() {
    const f = await seed(), runId = randomUUID();
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Historical agent", adapterType: "paperclip_runner" }).returning();
    const reference = { schema: "paperclip.native-workspace-sync/v3", state: "prepared", workspaceId: f.workspaceId,
      leaseId: randomUUID(), providerLeaseId: randomUUID(), remoteCwd: "/workspaces/task",
      descriptorSha256: "12".repeat(32), baselineSha256: "34".repeat(32), finalHostSha256: null, resourceDisposition: "stop_and_retain" };
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: agent!.id, nativeIssueId: f.issueId,
      runtimeMode: "native", status: "failed", finishedAt: new Date(), runnerProfileJson: { nativeWorkspaceSync: reference } });
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId, phase: "terminal_failure" });
    return { ...f, runId, reference };
  }
  it("carries unresolved copyback forward during offline migration without declaring recovery complete", async () => {
    const f = await failedCopybackFixture();
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("remote_copyback_unresolved");
    vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    await migrateRemoteWorkspace({ db, storage, ...f, apply: true, writersStopped: true });
    const row = await workspace(f.workspaceId);
    expect(readRemoteWorkspaceAuthority(row.metadata)?.snapshotId).toBeTruthy();
    expect(row.metadata?.remoteWorkspaceRecoverySourceRunIds).toEqual([f.runId]);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run).toMatchObject({ status: "failed", runnerProfileJson: { nativeWorkspaceSync: f.reference } });
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("original saved work\n");
    // An old copyback must not recreate or mutate the predecessor's local folder.
    await expect(resumeNativeWorkspaceSync({ db, runId: f.runId, target: { kind: "remote", transport: "sandbox", remoteCwd: f.reference.remoteCwd } }))
      .rejects.toThrow("native_workspace_sync_source_migrated");
  });
  it.each(["controller", "finalizer", "live-finalizer", "task", "descriptor"])("keeps unsafe legacy copyback blocked (%s)", async mode => {
    const f = await failedCopybackFixture(); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    if (mode === "controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, f.runId));
    if (mode === "finalizer") await db.update(nativeRunFinalizations).set({ leaseOwner: randomUUID() }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (mode === "live-finalizer") await db.update(nativeRunFinalizations).set({ phase: "observed", leaseOwner: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (mode === "task") {
      const [other] = await db.insert(issues).values({ companyId: f.companyId, title: "Different task" }).returning();
      await db.update(executionWorkspaces).set({ sourceIssueId: other!.id }).where(eq(executionWorkspaces.id, f.workspaceId));
    }
    if (mode === "descriptor") await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: { ...f.reference, descriptorSha256: "invalid" } } }).where(eq(heartbeatRuns.id, f.runId));
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true, writersStopped: true })).rejects.toThrow("remote_copyback_unresolved");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
  });
  it.each(["retryable_failure", "observed", "no-descriptor"])("preserves an abandoned %s coordinator without replaying its old agent turn", async mode => {
    const phase = mode === "no-descriptor" ? "observed" : mode;
    const f = await failedCopybackFixture(); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    const [oldRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const checkpoint = { providerSessionId: "original-provider-session", sequence: 17 };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...(mode === "no-descriptor" ? {} : oldRun!.runnerProfileJson),
      sessionCheckpoint: checkpoint } }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ assigneeAgentId: oldRun!.agentId, status: "in_progress" })
      .where(eq(issues.id, f.issueId));
    await db.update(nativeRunFinalizations).set({ phase, leaseOwner: phase === "observed" ? "old-controller" : null,
      leaseExpiresAt: phase === "observed" ? new Date(Date.now() - 60_000) : null,
      nextAttemptAt: new Date(Date.now() - 30_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    const [before] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    await migrateRemoteWorkspace({ db, storage, ...f, apply: true, writersStopped: true });
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)?.snapshotId).toBeTruthy();
    await db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
    expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "replacement", runIds: [f.runId] })).toEqual([]);
    expect(await claimNativeRestartRecoveries({ db, restartKind: "hard", runIds: [f.runId] })).toEqual([]);
    const [after] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    if (before!.leaseOwner) {
      expect(after).toMatchObject({ ...before, leaseOwner: null, leaseExpiresAt: null, updatedAt: expect.any(Date),
        recoveryHistory: [{ event: "legacy_workspace_migration_owner_released", workspaceId: f.workspaceId,
          operationId: expect.any(String), previousOwner: { phase, leaseOwner: before!.leaseOwner,
            leaseExpiresAt: before!.leaseExpiresAt!.toISOString() } }] });
    } else expect(after).toEqual(before);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toMatchObject({
      status: "failed", runnerProfileJson: { ...(mode === "no-descriptor" ? {} : { nativeWorkspaceSync: f.reference }), sessionCheckpoint: checkpoint,
        legacyWorkspaceRecoveryMigration: { workspaceId: f.workspaceId } },
    });
  });
  it.each(["prepared", "finalized", "missing-receipt", "failed-receipt"])("keeps accepted-result finalization independent of migrated file storage (%s)", async mode => {
    const state = mode === "prepared" ? "prepared" : "finalized";
    const f = await failedCopybackFixture(); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    const contractId = randomUUID(), resultId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.issueId, revision: 1,
      schemaVersion: "v1", policyVersion: "v1", risk: "low", completionAuthority: "agent", incompleteCriteriaPolicy: "block",
      contractJson: {}, canonicalSha256: "12".repeat(32), createdByActorType: "system", createdByActorId: "test" });
    await db.update(heartbeatRuns).set({ status: "succeeded", completionContractId: contractId,
      runnerProfileJson: { nativeWorkspaceSync: { ...f.reference, state, finalHostSha256: state === "finalized" ? "56".repeat(32) : null } } })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.insert(nativeRunResults).values({ id: resultId, companyId: f.companyId, issueId: f.issueId, runId: f.runId,
      completionContractId: contractId, serverFingerprint: "saved-result", schemaStatus: "accepted", resultJson: { saved: true }, canonicalSha256: "34".repeat(32) });
    await db.update(nativeRunFinalizations).set({ phase: "retryable_failure", resultId }).where(eq(nativeRunFinalizations.runId, f.runId));
    const operationId = randomUUID();
    if (mode === "finalized" || mode === "failed-receipt") await db.insert(workspaceOperations).values({ id: operationId,
      companyId: f.companyId, executionWorkspaceId: f.workspaceId, heartbeatRunId: f.runId, issueId: f.issueId,
      phase: "workspace_finalize", status: mode === "finalized" ? "succeeded" : "failed" });
    const [before] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const migrate = () => migrateRemoteWorkspace({ db, storage, ...f, apply: true, writersStopped: true });
    if (mode !== "finalized") await expect(migrate()).rejects.toThrow(state === "prepared"
      ? "remote_copyback_unresolved" : "execution_finalization_unresolved");
    else {
      await migrate();
      expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)?.snapshotId).toBeTruthy();
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!.runnerProfileJson)
        .not.toHaveProperty("legacyWorkspaceRecoveryMigration");
      expect(await attemptNativeWorkspaceFinalization({ db, runId: f.runId }))
        .toMatchObject({ kind: "completed", operation: { id: operationId } });
    }
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(before);
  });
  it("migrates historical records without borrowing another workspace's finalizer", async () => {
    const f = await failedCopybackFixture(); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    const otherId = randomUUID(), cwd = path.join(root, "longer-historical-folder"); await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "history.txt"), "prior task files\n");
    await db.insert(executionWorkspaces).values({ id: otherId, companyId: f.companyId, sourceIssueId: f.issueId,
      name: "Historical workspace", mode: "isolated_workspace", strategyType: "project_primary", providerType: "local_fs", cwd });
    await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await migrateWorkspaceTrees(db, { storage, signal: new AbortController().signal, phase: () => {} })).toBe(2);
    for (const id of [f.workspaceId, otherId]) expect(readRemoteWorkspaceAuthority((await workspace(id)).metadata)?.snapshotId).toBeTruthy();
  });
  it("rejects a legacy descriptor changed while its local files are uploading", async () => {
    const f = await failedCopybackFixture(); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    const put = storage.putFile.bind(storage);
    storage.putFile = async input => {
      const result = await put(input);
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: { ...f.reference, providerLeaseId: randomUUID() } } }).where(eq(heartbeatRuns.id, f.runId));
      return result;
    };
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true, writersStopped: true })).rejects.toThrow("remote_workspace_migration_source_changed");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
  });
  it("rejects a descriptor-free allocation changed during upload", async () => {
    const f = await failedCopybackFixture(); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    await db.insert(environmentLeases).values({ id: f.reference.leaseId, companyId: f.companyId,
      issueId: f.issueId, heartbeatRunId: f.runId, provider: "daytona", providerLeaseId: f.reference.providerLeaseId,
      status: "released", metadata: { remoteCwd: f.reference.remoteCwd } });
    await db.update(heartbeatRuns).set({ runnerProfileJson: {}, resultJson: {
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.reference.leaseId] },
    } }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, f.runId));
    const put = storage.putFile.bind(storage);
    storage.putFile = async input => {
      const result = await put(input);
      await db.update(environmentLeases).set({ providerLeaseId: randomUUID() }).where(eq(environmentLeases.id, f.reference.leaseId));
      return result;
    };
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true, writersStopped: true }))
      .rejects.toThrow("remote_workspace_migration_source_changed");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
  });
  it("does not release a coordinator whose expired owner changed during upload", async () => {
    const f = await failedCopybackFixture(); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    await db.update(nativeRunFinalizations).set({ phase: "observed", leaseOwner: "journaled-owner",
      leaseExpiresAt: new Date(Date.now() - 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    const put = storage.putFile.bind(storage);
    storage.putFile = async input => {
      const result = await put(input);
      await db.update(nativeRunFinalizations).set({ leaseOwner: "different-owner" }).where(eq(nativeRunFinalizations.runId, f.runId));
      return result;
    };
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true, writersStopped: true }))
      .rejects.toThrow("remote_workspace_migration_source_changed");
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "observed", leaseOwner: "different-owner", recoveryHistory: [] });
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
  });
  it("preserves a child task's recovery reference to its ancestor's workspace", async () => {
    const f = await failedCopybackFixture(); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    const [parent] = await db.insert(issues).values({ companyId: f.companyId, title: "Parent task" }).returning();
    await db.update(issues).set({ parentId: parent!.id }).where(eq(issues.id, f.issueId));
    await db.update(executionWorkspaces).set({ sourceIssueId: parent!.id }).where(eq(executionWorkspaces.id, f.workspaceId));
    await migrateRemoteWorkspace({ db, storage, ...f, apply: true, writersStopped: true });
    expect((await workspace(f.workspaceId)).sourceIssueId).toBe(parent!.id);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!.executionWorkspaceId).toBe(f.workspaceId);
    await expect(resumeNativeWorkspaceSync({ db, runId: f.runId, target: { kind: "remote", transport: "sandbox", remoteCwd: f.reference.remoteCwd } }))
      .rejects.toThrow("native_workspace_sync_source_migrated");
  });
  it("fails closed if the durable legacy migration receipt changes", async () => {
    const f = await failedCopybackFixture(); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    await migrateRemoteWorkspace({ db, storage, ...f, apply: true, writersStopped: true });
    const row = await workspace(f.workspaceId);
    await db.update(executionWorkspaces).set({ metadata: { ...row.metadata, legacyWorkspaceRecoveryMigration: { operationId: randomUUID() } } }).where(eq(executionWorkspaces.id, f.workspaceId));
    await expect(resumeNativeWorkspaceSync({ db, runId: f.runId, target: { kind: "remote", transport: "sandbox", remoteCwd: f.reference.remoteCwd } }))
      .rejects.toThrow("legacy_workspace_migration_receipt_invalid");
  });
  it("blocks distinct legacy records that alias the same folder", async () => {
    const f = await seed(), id = randomUUID();
    await db.insert(executionWorkspaces).values({ id, companyId: f.companyId, name: "Historical alias", mode: "isolated_workspace", strategyType: "project_primary", providerType: "local_fs", cwd: f.cwd });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("overlapping_workspace_requires_maintenance");
  });
  it.each(["cleanup_failed", "adapter_managed"])("blocks enrollment instead of abandoning unsupported local files (%s)", async kind => {
    const f = await seed(); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    await db.update(executionWorkspaces).set(kind === "cleanup_failed" ? { status: kind } : { providerType: kind })
      .where(eq(executionWorkspaces.id, f.workspaceId));
    await expect(migrateWorkspaceTrees(db, { storage, signal: new AbortController().signal, phase: () => {} }))
      .rejects.toThrow(kind === "cleanup_failed" ? "workspace_not_active" : "workspace_provider_unsupported");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("original saved work\n");
  });
  it.each(["changed", "corrupt", "late-change", "abort"])("keeps the parent local when nested coverage is unsafe (%s)", async mode => {
    const { parent, child } = await nestedFixture(); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    await migrateRemoteWorkspace({ db, storage, ...child, apply: true, writersStopped: true });
    const authority = readRemoteWorkspaceAuthority((await workspace(child.workspaceId)).metadata)!;
    const reference = await getWorkspaceSnapshot(db, { ...child, snapshotId: authority.snapshotId! });
    const controller = new AbortController();
    if (mode === "changed") await fs.writeFile(path.join(child.cwd, "child.txt"), "changed child bytes");
    if (mode === "corrupt") await storage.deleteObject(child.companyId, reference!.objectKey);
    if (mode === "late-change" || mode === "abort") {
      const put = storage.putFile.bind(storage); let once = true;
      storage.putFile = async input => { const result = await put(input); if (once) { once = false;
        if (mode === "abort") controller.abort(); else await fs.writeFile(path.join(child.cwd, "child.txt"), "changed during upload");
      } return result; };
    }
    await expect(migrateRemoteWorkspace({ db, storage, ...parent, apply: true, writersStopped: true, signal: controller.signal })).rejects.toThrow();
    expect(readRemoteWorkspaceAuthority((await workspace(parent.workspaceId)).metadata)).toBeNull();
    expect(await fs.readFile(path.join(parent.cwd, "saved.txt"), "utf8")).toBe("original saved work\n");
    if (mode === "abort") {
      await migrateRemoteWorkspace({ db, storage, ...parent, apply: true, writersStopped: true });
      expect(readRemoteWorkspaceAuthority((await workspace(parent.workspaceId)).metadata)?.snapshotId).toBeTruthy();
    }
  });
  it("resumes an interrupted maintenance batch in leaf-first order without duplicating imports", async () => {
    const { parent, child } = await nestedFixture(); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    const seen: string[] = [], controller = new AbortController();
    await expect(migrateWorkspaceTrees(db, { storage, signal: controller.signal, phase: name => {
      seen.push(name); if (name === `workspace:${parent.workspaceId}`) controller.abort();
    } })).rejects.toThrow();
    expect(seen).toEqual([`workspace:${child.workspaceId}`, `workspace:${parent.workspaceId}`]);
    const childAuthority = readRemoteWorkspaceAuthority((await workspace(child.workspaceId)).metadata);
    expect(await migrateWorkspaceTrees(db, { storage, signal: new AbortController().signal, phase: () => {} })).toBe(1);
    expect(await migrateWorkspaceTrees(db, { storage, signal: new AbortController().signal, phase: () => {} })).toBe(0);
    expect(readRemoteWorkspaceAuthority((await workspace(child.workspaceId)).metadata)).toEqual(childAuthority);
  });
  it("checks transitive nested coverage before omitting a child tree", async () => {
    const { parent, child } = await nestedFixture(); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    const id = randomUUID(), cwd = path.join(child.cwd, ".paperclip", "worktrees", "grandchild");
    await fs.mkdir(cwd, { recursive: true }); await fs.writeFile(path.join(cwd, "deep.txt"), "deep work");
    const [issue] = await db.insert(issues).values({ companyId: parent.companyId, title: "Grandchild task" }).returning();
    await db.insert(executionWorkspaces).values({ id, companyId: parent.companyId, sourceIssueId: issue!.id,
      name: "Grandchild", mode: "isolated_workspace", strategyType: "project_primary", providerType: "local_fs", cwd });
    await migrateRemoteWorkspace({ db, storage, companyId: parent.companyId, workspaceId: id, apply: true, writersStopped: true });
    await migrateRemoteWorkspace({ db, storage, ...child, apply: true, writersStopped: true });
    await fs.writeFile(path.join(cwd, "deep.txt"), "new deep work");
    await expect(migrateRemoteWorkspace({ db, storage, ...parent, apply: true, writersStopped: true })).rejects.toThrow("nested_workspace_source_changed");
    expect(readRemoteWorkspaceAuthority((await workspace(parent.workspaceId)).metadata)).toBeNull();
  });
  async function gitArchiveFixture(repoUrl = "https://example.invalid/repository.git", home = root) {
    const f = await seed(), projectId = randomUUID(), projectWorkspaceId = randomUUID(), branchName = "saved-task";
    vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    const base = resolveManagedProjectWorkspaceDir({ companyId: f.companyId, projectId, repoName: "repository" });
    await fs.mkdir(base, { recursive: true }); await git(base, "init", "-q", "-b", "main");
    await fs.writeFile(path.join(base, "base.txt"), "base\n"); await git(base, "add", "."); await git(base, "commit", "-qm", "base");
    await git(base, "remote", "add", "origin", repoUrl); const upstream = await git(base, "rev-parse", "HEAD");
    const cwd = path.join(base, ".paperclip", "worktrees", branchName);
    await git(base, "worktree", "add", "-b", branchName, cwd);
    await fs.copyFile(path.join(f.cwd, "saved.txt"), path.join(cwd, "saved.txt")); await fs.rm(f.cwd, { recursive: true });
    await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "saved task commit"); const commit = await git(cwd, "rev-parse", "HEAD");
    await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Archived project" });
    await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId: f.companyId, projectId, name: "Source", cwd: base, repoUrl });
    await db.update(executionWorkspaces).set({ cwd, providerRef: cwd, projectId, projectWorkspaceId, repoUrl, baseRef: "main",
      branchName, strategyType: "git_worktree", providerType: "git_worktree", metadata: { createdByRuntime: true, gitBranchOwnershipVersion: 1 } }).where(eq(executionWorkspaces.id, f.workspaceId));
    return { ...f, cwd, base, upstream, commit, projectId, projectWorkspaceId, repoUrl, branchName };
  }
  it.each(["legacy", "verified", "retry"])("recovers an archived Git workspace from its exact branch-deletion receipt (%s)", async receiptKind => {
    const f = await gitArchiveFixture(), closedAt = new Date();
    await db.update(executionWorkspaces).set({ status: "archived", closedAt }).where(eq(executionWorkspaces.id, f.workspaceId));
    if (receiptKind !== "verified") {
      await git(f.base, "merge", "--ff-only", f.branchName);
      await git(f.base, "worktree", "remove", f.cwd);
      const receipt = await git(f.base, "branch", "-d", f.branchName);
      await db.insert(workspaceOperations).values({ companyId: f.companyId, executionWorkspaceId: f.workspaceId,
        phase: "worktree_cleanup", status: "succeeded", command: `git branch -d ${f.branchName}`,
        stdoutExcerpt: receipt, startedAt: new Date(), finishedAt: new Date() });
    } else {
      const cleaned = await cleanupExecutionWorkspaceArtifacts({ workspace: await workspace(f.workspaceId),
        projectWorkspace: { cwd: f.base, cleanupCommand: null }, expectedBranchHeadSha: f.commit, runCleanupCommands: false,
        recorder: workspaceOperationService(db).createRecorder({ companyId: f.companyId, executionWorkspaceId: f.workspaceId, issueId: f.issueId }) });
      expect(cleaned.warnings).toEqual([]);
    }
    await fs.writeFile(path.join(f.base, "base.txt"), "newer default branch\n");
    await git(f.base, "add", "base.txt"); await git(f.base, "commit", "-qm", "new default branch work");
    if (receiptKind === "retry") {
      const put = storage.putFile.bind(storage); let fail = true;
      storage.putFile = async input => { const result = await put(input); if (fail) { fail = false; throw new Error("upload reply lost"); } return result; };
      await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("upload reply lost");
    }
    await migrateRemoteWorkspace({ db, storage, ...f, apply: true });
    const row = await workspace(f.workspaceId), authority = readRemoteWorkspaceAuthority(row.metadata)!;
    expect(row.status).toBe("archived"); expect(authority.source).toMatchObject({ kind: "git", ref: f.commit });
    await fs.rm(f.base, { recursive: true });
    const ref = await getWorkspaceSnapshot(db, { ...f, snapshotId: authority.snapshotId! });
    const archivePath = path.join(root, "legacy-git.pcws"), targetDir = path.join(root, "restored-legacy-git");
    await loadWorkspaceSnapshotArchive({ storage, reference: ref!, targetPath: archivePath });
    await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: ref!.manifestDigest });
    expect(await git(targetDir, "rev-parse", "HEAD")).toBe(f.commit);
    expect(await fs.readFile(path.join(targetDir, "base.txt"), "utf8")).toBe("base\n");
    expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("original saved work\n");
  });
  it.each(["valid", "foreign-cache", "wrong-origin", "missing-receipt", "revoked-receipt", "private-cache", "journaled-shared", "journaled-source-changed"])("recovers deleted isolated history only from an authorized receipt and project object cache (%s)", async state => {
    const f = await gitArchiveFixture(), privateBase = isolatedRemoteSourcePath(f.companyId, f.issueId);
    const privateCwd = path.join(privateBase, ".paperclip", "worktrees", f.branchName);
    await fs.mkdir(path.dirname(privateBase), { recursive: true });
    await git(root, "clone", "--no-hardlinks", f.base, privateBase);
    await git(privateBase, "remote", "set-url", "origin", f.repoUrl);
    await git(privateBase, "worktree", "add", "-b", f.branchName, privateCwd, `origin/${f.branchName}`);
    await git(privateBase, "merge", "--ff-only", f.branchName);
    await git(privateBase, "worktree", "remove", privateCwd);
    const receipt = await git(privateBase, "branch", "-d", f.branchName);
    await git(f.base, "merge", "--ff-only", f.branchName); await git(f.base, "worktree", "remove", f.cwd);
    await git(f.base, "branch", "-d", f.branchName);
    if (!["private-cache", "journaled-shared", "journaled-source-changed"].includes(state)) await fs.rm(privateBase, { recursive: true });
    const closedAt = new Date();
    await db.update(executionWorkspaces).set({ cwd: privateCwd, providerRef: privateCwd, status: "archived", closedAt,
      metadata: { createdByRuntime: true, gitBranchOwnershipVersion: 1, isolatedRemoteSource: {
        schema: "paperclip.isolated-remote-source.v1", companyId: f.companyId, issueId: f.issueId, repoUrl: f.repoUrl } } })
      .where(eq(executionWorkspaces.id, f.workspaceId));
    if (state !== "missing-receipt") await db.insert(workspaceOperations).values({ companyId: f.companyId,
      executionWorkspaceId: f.workspaceId, phase: "worktree_cleanup", status: "succeeded",
      command: `git --git-dir=temporary branch -d ${f.branchName}`, stdoutExcerpt: receipt,
      startedAt: new Date(), finishedAt: new Date(), metadata: { cleanupAction: "branch_delete", workspaceId: f.workspaceId,
        branchName: f.branchName, workspacePath: privateCwd } });
    // Keep ordinary private-workspace restoration strict. This project cache
    // supplies immutable Git objects only for the proven deleted commit.
    await expect(verifiedGitCacheSource(await workspace(f.workspaceId), f.base)).rejects.toThrow();
    await fs.writeFile(path.join(f.base, "base.txt"), "new shared checkout\n");
    await fs.writeFile(path.join(f.base, "unrelated.txt"), "not task history\n");
    await git(f.base, "add", "."); await git(f.base, "commit", "-qm", "new shared default");
    if (state === "wrong-origin" || state === "private-cache") await git(f.base, "remote", "set-url", "origin", "https://example.invalid/foreign.git");
    if (state === "foreign-cache") {
      const foreign = resolveManagedProjectWorkspaceDir({ companyId: randomUUID(), projectId: f.projectId, repoName: "repository" });
      await fs.mkdir(path.dirname(foreign), { recursive: true }); await fs.rename(f.base, foreign);
      await db.update(projectWorkspaces).set({ cwd: foreign }).where(eq(projectWorkspaces.id, f.projectWorkspaceId));
    }
    if (state === "revoked-receipt") {
      const put = storage.putFile.bind(storage);
      storage.putFile = async input => {
        const result = await put(input);
        await db.update(workspaceOperations).set({ status: "failed" }).where(and(
          eq(workspaceOperations.executionWorkspaceId, f.workspaceId), eq(workspaceOperations.phase, "worktree_cleanup")));
        return result;
      };
    }
    if (state.startsWith("journaled-")) {
      const put = storage.putFile.bind(storage); let fail = true;
      storage.putFile = async input => { const saved = await put(input); if (fail) { fail = false; throw new Error("upload reply lost"); } return saved; };
      await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("upload reply lost");
      const [operation] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.executionWorkspaceId, f.workspaceId), eq(workspaceOperations.phase, "remote_workspace_migration")));
      await db.update(workspaceOperations).set({ metadata: { ...operation!.metadata,
        archivedGitSource: { ...(operation!.metadata!.archivedGitSource as object), sourcePath: f.base } } }).where(eq(workspaceOperations.id, operation!.id));
      if (state === "journaled-source-changed") await git(f.base, "remote", "set-url", "origin", "https://example.invalid/foreign.git");
    }
    if (!["valid", "private-cache", "journaled-shared"].includes(state)) {
      await expect(migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: f.workspaceId, apply: true })).rejects.toThrow();
      expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull(); return;
    }
    await migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: f.workspaceId, apply: true });
    const row = await workspace(f.workspaceId), authority = readRemoteWorkspaceAuthority(row.metadata)!;
    expect(row.status).toBe("archived"); expect(authority.source).toMatchObject({ kind: "git", ref: f.commit });
    await fs.rm(f.base, { recursive: true });
    await fs.rm(privateBase, { recursive: true, force: true });
    const ref = await getWorkspaceSnapshot(db, { ...f, snapshotId: authority.snapshotId! });
    const archivePath = path.join(root, "isolated-history.pcws"), targetDir = path.join(root, "restored-isolated-history");
    await loadWorkspaceSnapshotArchive({ storage, reference: ref!, targetPath: archivePath });
    await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: ref!.manifestDigest });
    expect(await git(targetDir, "rev-parse", "HEAD")).toBe(f.commit);
    expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("original saved work\n");
    expect(await fs.readFile(path.join(targetDir, "base.txt"), "utf8")).toBe("base\n");
    expect(await fs.stat(path.join(targetDir, "unrelated.txt")).catch(() => null)).toBeNull();
  });
  it.each(["valid", "changed-branch", "competing-owner", "registered-branch", "unowned", "missing-branch", "active-online", "active-offline", "user-owned-receipt", "user-owned-force-receipt", "user-owned-revoked-receipt", "user-owned-quoted-receipt", "detached-registration", "orphan-index"])("preserves a missing checkout from its retained owned branch (%s)", async mode => {
    const f = await gitArchiveFixture(undefined, mode === "user-owned-quoted-receipt" ? path.join(root, "home with spaces") : root), closedAt = new Date();
    const active = mode.startsWith("active-");
    await db.update(executionWorkspaces).set({ status: active ? "active" : "archived", closedAt: active ? null : closedAt })
      .where(eq(executionWorkspaces.id, f.workspaceId));
    if (mode === "user-owned-quoted-receipt") {
      await db.update(executionWorkspaces).set({ metadata: { createdByRuntime: false, gitBranchOwnershipVersion: 1 } }).where(eq(executionWorkspaces.id, f.workspaceId));
      const cleaned = await cleanupExecutionWorkspaceArtifacts({ workspace: await workspace(f.workspaceId),
        projectWorkspace: { cwd: f.base, cleanupCommand: null }, runCleanupCommands: false, forceWorktreeRemoval: false,
        recorder: workspaceOperationService(db).createRecorder({ companyId: f.companyId, executionWorkspaceId: f.workspaceId, issueId: f.issueId }) });
      expect(cleaned.warnings).toEqual([]);
    } else if (mode === "detached-registration") {
      await git(f.cwd, "checkout", "--detach");
      await fs.writeFile(path.join(f.cwd, "newer.txt"), "recoverable detached work");
      await git(f.cwd, "add", "."); await git(f.cwd, "commit", "-qm", "newer detached work");
      await fs.rm(f.cwd, { recursive: true });
    } else await git(f.base, "worktree", "remove", f.cwd);
    await fs.writeFile(path.join(f.base, "base.txt"), "new shared default branch\n");
    await git(f.base, "add", "."); await git(f.base, "commit", "-qm", "unrelated shared work");
    if (mode === "orphan-index") {
      const admin = path.join(f.base, ".git", "worktrees", "orphan");
      await fs.mkdir(admin, { recursive: true }); await fs.copyFile(path.join(f.base, ".git", "index"), path.join(admin, "index"));
      await fs.writeFile(path.join(admin, "locked"), "retained staged recovery work\n");
    }
    if (mode === "changed-branch") {
      const put = storage.putFile.bind(storage);
      storage.putFile = async input => { const saved = await put(input); await git(f.base, "update-ref", `refs/heads/${f.branchName}`, await git(f.base, "rev-parse", "HEAD")); return saved; };
    }
    if (mode === "competing-owner") {
      const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Different branch owner" }).returning();
      await db.insert(executionWorkspaces).values({ companyId: f.companyId, sourceIssueId: issue!.id, projectId: f.projectId,
        name: "Other owner", mode: "isolated_workspace", strategyType: "git_worktree", providerType: "git_worktree",
        repoUrl: f.repoUrl, branchName: f.branchName, cwd: path.join(root, "other-owner") });
    }
    if (mode === "registered-branch") await git(f.base, "worktree", "add", path.join(root, "registered"), f.branchName);
    if (mode.startsWith("user-owned-") && mode !== "user-owned-quoted-receipt") {
      await db.update(executionWorkspaces).set({ metadata: { createdByRuntime: false, gitBranchOwnershipVersion: 1 } }).where(eq(executionWorkspaces.id, f.workspaceId));
      const [receipt] = await db.insert(workspaceOperations).values({ companyId: f.companyId, executionWorkspaceId: f.workspaceId,
        phase: "worktree_cleanup", status: "succeeded", startedAt: new Date(), finishedAt: new Date(),
        command: `git worktree remove ${mode === "user-owned-force-receipt" ? "--force " : ""}${f.cwd}`,
        metadata: { cleanupAction: "worktree_remove", workspaceId: f.workspaceId, workspacePath: f.cwd, branchName: f.branchName } }).returning();
      if (mode === "user-owned-revoked-receipt") {
        const put = storage.putFile.bind(storage);
        storage.putFile = async input => { const saved = await put(input); await db.update(workspaceOperations).set({ status: "failed" })
          .where(eq(workspaceOperations.id, receipt!.id)); return saved; };
      }
    }
    if (mode === "unowned") await db.update(executionWorkspaces).set({ metadata: { gitBranchOwnershipVersion: 1 } }).where(eq(executionWorkspaces.id, f.workspaceId));
    if (mode === "missing-branch") await git(f.base, "branch", "-D", f.branchName);
    const offline = mode === "active-offline";
    if (offline) vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    const migrate = () => migrateRemoteWorkspace({ db, storage, ...f, apply: true, writersStopped: offline });
    if (!["valid", "active-offline", "user-owned-receipt", "user-owned-quoted-receipt"].includes(mode)) {
      await expect(migrate()).rejects.toThrow();
      expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull(); return;
    }
    await migrate();
    const row = await workspace(f.workspaceId), authority = readRemoteWorkspaceAuthority(row.metadata)!;
    expect(row.status).toBe(active ? "active" : "archived");
    expect(authority.source).toMatchObject({ kind: "git", ref: f.commit });
    const [operation] = await db.select().from(workspaceOperations).where(and(
      eq(workspaceOperations.executionWorkspaceId, f.workspaceId), eq(workspaceOperations.phase, "remote_workspace_migration")));
    expect(operation!.metadata?.archivedGitSource).toMatchObject({ commit: f.commit, retainedBranch: f.branchName });
    await fs.rm(f.base, { recursive: true });
    const ref = await getWorkspaceSnapshot(db, { ...f, snapshotId: authority.snapshotId! });
    const archivePath = path.join(root, "retained-branch.pcws"), targetDir = path.join(root, "restored-retained-branch");
    await loadWorkspaceSnapshotArchive({ storage, reference: ref!, targetPath: archivePath });
    await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: ref!.manifestDigest });
    expect(await git(targetDir, "rev-parse", "HEAD")).toBe(f.commit);
    expect(await fs.readFile(path.join(targetDir, "base.txt"), "utf8")).toBe("base\n");
    expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("original saved work\n");
  });
  async function serveRepository() {
    const directory = path.join(root, "http"), bare = path.join(directory, "repository.git");
    await fs.mkdir(bare, { recursive: true }); await git(bare, "init", "--bare", "--initial-branch=main");
    const server = createServer(async (request, response) => {
      const relative = new URL(request.url!, "http://localhost").pathname.slice(1);
      const target = path.resolve(directory, relative);
      if (!target.startsWith(`${directory}/`)) { response.writeHead(403).end(); return; }
      try { response.end(await fs.readFile(target)); } catch { response.writeHead(404).end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("test server not bound");
    return { bare, repoUrl: `http://127.0.0.1:${address.port}/repository.git` };
  }
  it.each(["present", "pruned", "retry", "missing-base", "missing-base-retry", "missing-base-uploaded-retry", "missing-base-changed-retry", "nested", "unapproved-nested", "missing", "expired", "corrupt"])("preserves archived Git edits or refuses an unavailable restore point (%s)", async state => {
    const remote = state.startsWith("missing-base") ? await serveRepository() : null;
    const f = await gitArchiveFixture(remote?.repoUrl);
    if (remote) { await git(remote.bare, "fetch", f.base, "main:refs/heads/main"); await git(remote.bare, "update-server-info"); }
    await fs.writeFile(path.join(f.cwd, "saved.txt"), "staged edit\n"); await git(f.cwd, "add", "saved.txt");
    await fs.writeFile(path.join(f.cwd, "saved.txt"), "unstaged edit\n");
    const captured = (await captureRestorePoint({ cwd: f.cwd, upstreamCommits: [f.upstream] }))!;
    const id = randomUUID(), generation = 1, sealed = await sealRestorePoint(captured.payload,
      { companyId: f.companyId, workspaceId: f.workspaceId, restorePointId: id, generation });
    const objectKey = `${f.companyId}/git-restore-points/${f.workspaceId}/${generation}/${id}.pcrp`;
    await storage.putFile({ companyId: f.companyId, namespace: "git-restore-points", objectKey,
      originalFilename: "git.pcrp", contentType: "application/octet-stream", body: sealed.ciphertext });
    const restorePoint = { schema: "paperclip.git-restore-point.v1", id, generation, objectKey, byteSize: sealed.ciphertext.length,
      sha256: sealed.sha256, key: sealed.key, head: captured.manifest.head, index: captured.manifest.index,
      worktree: captured.manifest.worktree, ignored: captured.manifest.ignored, modes: captured.manifest.modes, headOnRemote: false };
    let contents;
    if (state === "nested" || state === "unapproved-nested") {
      const sourceCwd = path.join(root, "nested-source");
      await fs.mkdir(sourceCwd); await git(sourceCwd, "init", "-q", "-b", "main");
      await fs.writeFile(path.join(sourceCwd, "nested.txt"), "nested source work\n");
      await git(sourceCwd, "add", "."); await git(sourceCwd, "commit", "-qm", "nested source");
      const source = { id: randomUUID(), repoUrl: pathToFileURL(sourceCwd).href, repoRef: "main", cwd: sourceCwd };
      const name = managedProjectCheckoutName(source), nestedCwd = path.join(f.cwd, ".paperclip-repositories", name);
      await git(f.cwd, "clone", source.repoUrl, nestedCwd); await git(nestedCwd, "checkout", "--detach");
      await fs.mkdir(path.join(nestedCwd, ".claude"));
      await fs.writeFile(path.join(nestedCwd, ".claude", "settings.local.json"), '{"permissions":{"allow":["Read"]}}');
      contents = await captureGitWorkspaceContents(f.cwd, { companyId: f.companyId, workspaceId: f.workspaceId },
        [await readManagedCheckoutContents(nestedCwd, name, source)]);
      if (state === "nested") await db.insert(projectWorkspaces).values({ ...source, companyId: f.companyId, projectId: f.projectId, name: "Nested source" });
    }
    await db.update(executionWorkspaces).set({ status: "archived", closedAt: new Date(), metadata: {
      createdByRuntime: true, gitBranchOwnershipVersion: 1, gitCacheRestoration: { schema: "paperclip.git-cache-restoration.v2", companyId: f.companyId,
        workspaceId: f.workspaceId, sourceIssueId: f.issueId, repoUrl: f.repoUrl, commit: f.commit, branchName: f.branchName,
        sourceKind: "managed_project", projectId: f.projectId, sourcePath: f.base, worktreePath: f.cwd,
        gitBranchOwnershipVersion: 1, verifiedAt: new Date().toISOString(), restorePoint, contents },
    } }).where(eq(executionWorkspaces.id, f.workspaceId));
    await git(f.base, "worktree", "remove", "--force", f.cwd); await git(f.base, "branch", "-D", f.branchName);
    if (state.startsWith("missing-base")) await fs.rm(f.base, { recursive: true });
    if (state === "unapproved-nested") {
      await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow();
      expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
      expect((await workspace(f.workspaceId)).status).toBe("archived");
      return;
    }
    if (state === "pruned") {
      await git(f.base, "reflog", "expire", "--expire=now", "--all");
      await git(f.base, "gc", "--prune=now");
      await expect(git(f.base, "cat-file", "-e", `${f.commit}^{commit}`)).rejects.toThrow();
    }
    if (["missing", "expired", "corrupt"].includes(state)) {
      if (state === "missing") await storage.deleteObject(f.companyId, objectKey);
      else {
        const row = await workspace(f.workspaceId);
        const recipe = row.metadata!.gitCacheRestoration as Record<string, unknown>;
        await db.update(executionWorkspaces).set({ metadata: { ...row.metadata, gitCacheRestoration: { ...recipe,
          restorePoint: { ...restorePoint, ...(state === "expired" ? { expiredAt: new Date().toISOString() } : { sha256: "00".repeat(32) }) },
        } } }).where(eq(executionWorkspaces.id, f.workspaceId));
      }
      await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow();
      const row = await workspace(f.workspaceId);
      expect(row).toMatchObject({ status: "archived", providerType: "git_worktree", cwd: f.cwd });
      expect(readRemoteWorkspaceAuthority(row.metadata)).toBeNull();
      expect(await fs.stat(f.cwd).catch(() => null)).toBeNull();
      return;
    }
    if (state === "retry" || state === "missing-base-retry" || state === "missing-base-changed-retry") {
      const put = storage.putFile.bind(storage); let fail = true;
      storage.putFile = async input => { const result = await put(input); if (fail) { fail = false; throw new Error("upload reply lost"); } return result; };
      await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("upload reply lost");
    }
    if (state === "missing-base-uploaded-retry") {
      const get = storage.getObject.bind(storage); let reads = 0;
      storage.getObject = async (...args) => {
        if (args[1].includes("/workspace-snapshots/") && ++reads === 2) throw new Error("restore reply lost");
        return get(...args);
      };
      await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("restore reply lost");
      expect((await db.select().from(executionWorkspaceSnapshots))[0]?.status).toBe("uploaded");
    }
    const interrupted = state.startsWith("missing-base-")
      ? (await db.select().from(workspaceOperations).where(eq(workspaceOperations.phase, "remote_workspace_migration")))[0] : null;
    if (interrupted) {
      const tree = await git(remote!.bare, "rev-parse", "main^{tree}");
      const next = await git(remote!.bare, "commit-tree", tree, "-p", f.upstream, "-m", "unrelated remote release");
      await git(remote!.bare, "update-ref", "refs/heads/main", next);
      await git(remote!.bare, "update-ref", "refs/heads/new-unrelated-branch", next);
      await git(remote!.bare, "update-server-info");
    }
    if (state === "missing-base-changed-retry") {
      const get = storage.getObject.bind(storage); let expire = true;
      storage.getObject = async (...args) => {
        const result = await get(...args);
        if (expire && args[1].includes("/workspace-snapshots/")) {
          expire = false;
          const row = await workspace(f.workspaceId);
          const recipe = row.metadata!.gitCacheRestoration as Record<string, unknown>;
          await db.update(executionWorkspaces).set({ metadata: { ...row.metadata, gitCacheRestoration: {
            ...recipe, restorePoint: { ...restorePoint, expiredAt: new Date().toISOString() },
          } } }).where(eq(executionWorkspaces.id, f.workspaceId));
        }
        return result;
      };
      await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("remote_workspace_migration_publication_changed");
      expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
      expect((await workspace(f.workspaceId)).status).toBe("archived");
      expect((await db.select().from(executionWorkspaceSnapshots))[0]?.status).toBe("uploaded");
      return;
    }
    await migrateRemoteWorkspace({ db, storage, ...f, apply: true });
    if (interrupted) {
      const operations = await db.select().from(workspaceOperations).where(eq(workspaceOperations.phase, "remote_workspace_migration"));
      expect(operations).toHaveLength(1);
      expect(operations[0]).toMatchObject({ id: interrupted.id, status: "succeeded" });
    }
    const authority = readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)!;
    await fs.rm(f.base, { recursive: true, force: true }); await fs.rm(path.join(root, "nested-source"), { recursive: true, force: true }); await storage.deleteObject(f.companyId, objectKey);
    const ref = await getWorkspaceSnapshot(db, { ...f, snapshotId: authority.snapshotId! });
    const archivePath = path.join(root, "retained-git.pcws"), targetDir = path.join(root, "restored-retained-git");
    await loadWorkspaceSnapshotArchive({ storage, reference: ref!, targetPath: archivePath });
    await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: ref!.manifestDigest });
    expect(await git(targetDir, "rev-parse", "HEAD")).toBe(f.commit);
    if (state === "nested") {
      expect(await fs.readFile(path.join(targetDir, ".paperclip-repositories", contents!.checkouts[0]!.name, "nested.txt"), "utf8")).toBe("nested source work\n");
      expect(JSON.parse(await fs.readFile(path.join(targetDir, ".paperclip-repositories", contents!.checkouts[0]!.name, ".claude/settings.local.json"), "utf8")))
        .toEqual({ permissions: { allow: ["Read"] } });
    }
    expect(await git(targetDir, "show", ":saved.txt")).toBe("staged edit");
    expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("unstaged edit\n");
  });
  async function retainDirectory(f: Awaited<ReturnType<typeof seed>>) {
    const captured = await captureTaskDirectorySnapshot(f.cwd), id = randomUUID(), generation = 1;
    const sealed = await sealRestorePoint(captured.payload, { companyId: f.companyId, workspaceId: f.workspaceId, restorePointId: id, generation });
    const objectKey = `${f.companyId}/git-restore-points/${f.workspaceId}/${generation}/task-directory/${id}.pcrp`;
    await storage.putFile({ companyId: f.companyId, namespace: "git-restore-points", objectKey,
      originalFilename: "retained.pcrp", contentType: "application/octet-stream", body: sealed.ciphertext });
    const ref: TaskDirectoryRestorePointRef = { schema: "paperclip.task-directory-restore-point.v1", id, generation,
      objectKey, sha256: sealed.sha256, byteSize: sealed.ciphertext.length, key: sealed.key,
      digest: captured.digest, files: captured.files, excluded: captured.excluded };
    await db.update(executionWorkspaces).set({ status: "archived", closedAt: new Date(), metadata: {
      isolatedTaskDirectoryRetention: { schema: "paperclip.task-directory-retention.v1", generation, removed: true,
        trash: path.join(root, "removed-trash"), restorePoint: ref },
    } }).where(eq(executionWorkspaces.id, f.workspaceId));
    await fs.rm(f.cwd, { recursive: true });
    return ref;
  }
  it("imports an archived directory from its encrypted restore point after the old folder is gone", async () => {
    const f = await seed(), retained = await retainDirectory(f);
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: true });
    await migrateRemoteWorkspace({ db, storage, ...f, apply: true });
    const saved = await workspace(f.workspaceId), authority = readRemoteWorkspaceAuthority(saved.metadata)!;
    expect(saved.status).toBe("archived");
    expect(await fs.stat(f.cwd).catch(() => null)).toBeNull();
    await storage.deleteObject(f.companyId, retained.objectKey);
    const ref = await getWorkspaceSnapshot(db, { ...f, snapshotId: authority.snapshotId! });
    const archivePath = path.join(root, "retained.pcws"), targetDir = path.join(root, "restored-retained");
    await loadWorkspaceSnapshotArchive({ storage, reference: ref!, targetPath: archivePath });
    await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: ref!.manifestDigest });
    expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("original saved work\n");
  });
  it.each(["missing", "expired", "corrupt"])("does not replace an unavailable retained directory with an empty workspace (%s)", async failure => {
    const f = await seed(), retained = await retainDirectory(f);
    if (failure === "missing") await storage.deleteObject(f.companyId, retained.objectKey);
    else {
      const row = await workspace(f.workspaceId);
      const retention = row.metadata!.isolatedTaskDirectoryRetention as Record<string, unknown>;
      await db.update(executionWorkspaces).set({ metadata: { ...row.metadata, isolatedTaskDirectoryRetention: {
        ...retention, restorePoint: { ...retained, ...(failure === "expired" ? { expiredAt: new Date().toISOString() } : { sha256: "00".repeat(32) }) },
      } } }).where(eq(executionWorkspaces.id, f.workspaceId));
    }
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow();
    const row = await workspace(f.workspaceId);
    expect(row).toMatchObject({ status: "archived", providerType: "local_fs", cwd: f.cwd });
    expect(readRemoteWorkspaceAuthority(row.metadata)).toBeNull();
    expect(await fs.stat(f.cwd).catch(() => null)).toBeNull();
  });
  it("keeps newly restored local files when they appear during an archived import", async () => {
    const f = await seed(); await retainDirectory(f);
    const put = storage.putFile.bind(storage);
    storage.putFile = async input => {
      const result = await put(input);
      await fs.mkdir(f.cwd); await fs.writeFile(path.join(f.cwd, "saved.txt"), "new local edits\n");
      return result;
    };
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("remote_workspace_migration_source_changed");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("new local edits\n");
  });
  it("preserves an archived workspace without reopening its task or losing its files", async () => {
    const f = await seed(), closedAt = new Date("2026-10-20T12:00:00Z");
    await db.update(executionWorkspaces).set({ status: "archived", closedAt }).where(eq(executionWorkspaces.id, f.workspaceId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).resolves.toMatchObject({ applied: true });
    const saved = await workspace(f.workspaceId), authority = readRemoteWorkspaceAuthority(saved.metadata)!;
    expect(saved.status).toBe("archived"); expect(saved.closedAt).toEqual(closedAt);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue).toMatchObject({ status: "done", executionWorkspaceId: f.workspaceId });
    const ref = await getWorkspaceSnapshot(db, { ...f, snapshotId: authority.snapshotId! });
    await fs.rm(f.cwd, { recursive: true });
    const archivePath = path.join(root, "archived.pcws"), targetDir = path.join(root, "restored-archived");
    await loadWorkspaceSnapshotArchive({ storage, reference: ref!, targetPath: archivePath });
    await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: ref!.manifestDigest });
    expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("original saved work\n");
  });
  it("imports a historical workspace without replacing the task's current workspace", async () => {
    const f = await seed(), currentId = randomUUID(), currentCwd = path.join(root, "current");
    await fs.mkdir(currentCwd); await fs.writeFile(path.join(currentCwd, "saved.txt"), "newer current work\n");
    await db.insert(executionWorkspaces).values({ id: currentId, companyId: f.companyId, sourceIssueId: f.issueId,
      mode: "isolated_workspace", strategyType: "project_primary", providerType: "local_fs", name: "Current workspace", cwd: currentCwd });
    await db.update(issues).set({ executionWorkspaceId: currentId }).where(eq(issues.id, f.issueId));
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).resolves.toMatchObject({ applied: true });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue?.executionWorkspaceId).toBe(currentId);
    expect(await fs.readFile(path.join(currentCwd, "saved.txt"), "utf8")).toBe("newer current work\n");
    expect(readRemoteWorkspaceAuthority((await workspace(currentId)).metadata)).toBeNull();
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)?.snapshotId).toBeTruthy();
  });
  it("refuses publication when the task changes its workspace during import", async () => {
    const f = await seed(), put = storage.putFile.bind(storage);
    storage.putFile = async input => {
      const result = await put(input);
      await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, f.issueId));
      return result;
    };
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("remote_workspace_migration_source_changed");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("original saved work\n");
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("remote_workspace_migration_source_changed");
  });
  it("defaults to dry run and preserves both database authority and local files", async () => {
    const f = await seed(); expect(await migrateRemoteWorkspace({ db, storage, ...f })).toMatchObject({ eligible: true, applied: false, alreadyMigrated: false });
    expect((await workspace(f.workspaceId)).providerType).toBe("local_fs");
    expect(await db.select().from(workspaceOperations)).toHaveLength(0);
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("original saved work\n");
  });
  it("verifies saved files, switches authority once, and retains the original folder", async () => {
    const f = await seed();
    expect(await migrateRemoteWorkspace({ db, storage, ...f, apply: true })).toMatchObject({ applied: true, alreadyMigrated: true });
    const row = await workspace(f.workspaceId), authority = readRemoteWorkspaceAuthority(row.metadata);
    expect(authority).toMatchObject({ epoch: 1, location: null, dirty: false, writerRunId: null });
    expect(authority?.snapshotId).toMatch(/^[a-f0-9-]{36}$/);
    expect(row.metadata?.retainedNote).toBe("keep"); expect(row.metadata?.remoteWorkspaceMigration).toBeUndefined();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("original saved work\n");
    expect(await migrateRemoteWorkspace({ db, storage, ...f, apply: true })).toMatchObject({ replayed: true });
    expect(await db.select().from(executionWorkspaceSnapshots)).toHaveLength(1);
    expect(await db.select().from(activityLog)).toHaveLength(1);
  });
  it.each([false, true])("removes plaintext verification files with read-only folders after import (source changed: %s)", async sourceChanged => {
    const f = await seed(), protectedDir = path.join(f.cwd, "protected"), scratchRoot = path.join(root, "scratch");
    await fs.mkdir(protectedDir); await fs.mkdir(scratchRoot);
    await fs.writeFile(path.join(protectedDir, "saved.txt"), "read-only saved work\n", { mode: 0o444 });
    await fs.chmod(protectedDir, 0o555);
    vi.stubEnv("TMPDIR", scratchRoot);
    const get = storage.getObject.bind(storage); let reads = 0;
    if (sourceChanged) storage.getObject = async (...args) => {
      if (++reads === 2) await fs.writeFile(path.join(f.cwd, "saved.txt"), "new local work\n");
      return get(...args);
    };
    try {
      const migration = migrateRemoteWorkspace({ db, storage, ...f, apply: true });
      if (sourceChanged) {
        await expect(migration).rejects.toThrow("remote_workspace_migration_source_changed");
        expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
      } else {
        await expect(migration).resolves.toMatchObject({ applied: true, alreadyMigrated: true });
        expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)?.snapshotId).toBeTruthy();
      }
      expect(await fs.readdir(scratchRoot)).toEqual([]);
      expect((await fs.stat(protectedDir)).mode & 0o777).toBe(0o555);
      expect((await fs.stat(path.join(protectedDir, "saved.txt"))).mode & 0o777).toBe(0o444);
      expect(await fs.readFile(path.join(protectedDir, "saved.txt"), "utf8")).toBe("read-only saved work\n");
    } finally {
      await fs.chmod(protectedDir, 0o755);
      await removeTaskDirectoryTree(scratchRoot);
    }
  });
  it("resumes an interrupted upload with the original operation identity", async () => {
    const f = await seed(), put = storage.putFile.bind(storage); let fail = true;
    storage.putFile = async input => { const saved = await put(input); if (fail) { fail = false; throw new Error("upload reply lost"); } return saved; };
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("upload reply lost");
    const before = await inventoryRemoteWorkspaceMigration(db, f); expect(before.operationId).not.toBeNull();
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
    expect(await migrateRemoteWorkspace({ db, storage, ...f, apply: true })).toMatchObject({ applied: true });
    const operations = await db.select().from(workspaceOperations); expect(operations).toHaveLength(1); expect(operations[0]?.id).toBe(before.operationId);
  });
  it("still rejects local source edits after an interrupted upload", async () => {
    const f = await seed(), put = storage.putFile.bind(storage); let fail = true;
    storage.putFile = async input => { const saved = await put(input); if (fail) { fail = false; throw new Error("upload reply lost"); } return saved; };
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("upload reply lost");
    await fs.writeFile(path.join(f.cwd, "saved.txt"), "new local edits\n");
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("remote_workspace_snapshot_operation_content_changed");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("new local edits\n");
  });
  it("imports dirty unpushed Git work and restores it after the original folder disappears", async () => {
    const f = await seed(); await git(f.cwd, "init", "-q", "-b", "feature");
    await git(f.cwd, "add", "."); await git(f.cwd, "commit", "-qm", "unpushed work");
    await git(f.cwd, "remote", "add", "origin", "https://example.invalid/repository.git");
    const head = await git(f.cwd, "rev-parse", "HEAD");
    await fs.writeFile(path.join(f.cwd, "saved.txt"), "staged edit\n"); await git(f.cwd, "add", "saved.txt");
    await fs.writeFile(path.join(f.cwd, "saved.txt"), "unstaged edit\n");
    await db.update(executionWorkspaces).set({ repoUrl: "https://example.invalid/repository.git", branchName: "feature" }).where(eq(executionWorkspaces.id, f.workspaceId));
    await migrateRemoteWorkspace({ db, storage, ...f, apply: true });
    const authority = readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)!;
    const ref = await getWorkspaceSnapshot(db, { ...f, snapshotId: authority.snapshotId! });
    await fs.rm(f.cwd, { recursive: true });
    const archivePath = path.join(root, "cold.pcws"), targetDir = path.join(root, "cold");
    await loadWorkspaceSnapshotArchive({ storage, reference: ref!, targetPath: archivePath });
    await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: ref!.manifestDigest });
    expect(await git(targetDir, "rev-parse", "HEAD")).toBe(head);
    expect(await git(targetDir, "show", ":saved.txt")).toBe("staged edit");
    expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("unstaged edit\n");
  });
  it("blocks unresolved writers and explicitly parallel shared workspaces", async () => {
    const f = await seed();
    await db.update(executionWorkspaces).set({ mode: "shared_workspace" }).where(eq(executionWorkspaces.id, f.workspaceId));
    await db.update(issues).set({ executionWorkspaceSettings: { sharedWorkspaceConcurrency: "allow" } }).where(eq(issues.id, f.issueId));
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: false, reasons: ["parallel_shared_writers_unsupported"] });
    await db.update(issues).set({ executionWorkspaceSettings: { sharedWorkspaceConcurrency: "serialize" } }).where(eq(issues.id, f.issueId));
    await db.insert(workspaceOperations).values({ companyId: f.companyId, executionWorkspaceId: f.workspaceId, phase: "workspace_command", status: "running" });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("workspace_operation_unresolved");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
  });
  it.each(["parallel", "orphan", "stale-binding"])("keeps offline enrollment blocked on unresolved workspace semantics (%s)", async mode => {
    const f = await failedCopybackFixture(); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, f.runId));
    await db.update(heartbeatRuns).set({ runnerProfileJson: null }).where(eq(heartbeatRuns.id, f.runId));
    if (mode === "parallel") {
      await db.update(executionWorkspaces).set({ mode: "shared_workspace" }).where(eq(executionWorkspaces.id, f.workspaceId));
      await db.update(issues).set({ executionWorkspaceSettings: { sharedWorkspaceConcurrency: "allow" } }).where(eq(issues.id, f.issueId));
    } else if (mode === "orphan") await db.update(executionWorkspaces).set({ sourceIssueId: null }).where(eq(executionWorkspaces.id, f.workspaceId));
    else await db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
    const reason = mode === "parallel" ? "parallel_shared_writers_unsupported" : mode === "orphan" ? "task_binding_required" : "task_writer_bound";
    await expect(migrateWorkspaceTrees(db, { storage, signal: new AbortController().signal, phase: () => {} })).rejects.toThrow(reason);
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("original saved work\n");
  });
  it.each(["running", "starting", "unknown", "failed"])("blocks a %s local service after its control lease expires", async status => {
    const f = await seed(), serviceId = randomUUID();
    await db.insert(executionWorkspaceRuntimeLeases).values({ companyId: f.companyId, executionWorkspaceId: f.workspaceId,
      ownerKey: `issue:${f.issueId}`, ownerIssueId: f.issueId, lastAction: "start", expiresAt: new Date(Date.now() - 60_000) });
    await db.insert(workspaceRuntimeServices).values({ id: serviceId, companyId: f.companyId, executionWorkspaceId: f.workspaceId,
      scopeType: "execution_workspace", scopeId: f.workspaceId, serviceName: "Synthetic preview", status,
      lifecycle: "shared", provider: "local_process", command: "node synthetic-preview.js", cwd: f.cwd });
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: false, reasons: ["workspace_runtime_service_unsettled"] });
    expect(await migrateRemoteWorkspace({ db, storage, ...f })).toMatchObject({ applied: false, eligible: false });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("workspace_runtime_service_unsettled");
    expect((await workspace(f.workspaceId)).providerType).toBe("local_fs");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
    expect(await db.select().from(workspaceOperations)).toHaveLength(0);
    expect(await db.select().from(executionWorkspaceSnapshots)).toHaveLength(0);
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("original saved work\n");
    await db.$client`update workspace_runtime_services set status = 'stopped' where id = ${serviceId}::uuid`;
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: true, reasons: [] });
  });
  it.each([{ repository: { phase: "cleanup" } }, "unrecognized-state"])("blocks an unresolved or malformed nested clone migration marker: %j", async marker => {
    const f = await seed();
    await db.update(executionWorkspaces).set({ metadata: { retainedNote: "keep", nestedCloneMigrationPending: marker } }).where(eq(executionWorkspaces.id, f.workspaceId));
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: false, reasons: ["nested_clone_migration_unresolved"] });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("nested_clone_migration_unresolved");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("original saved work\n");
  });
  it("blocks a running project service inherited by a shared workspace", async () => {
    const f = await seed(), projectId = randomUUID(), projectWorkspaceId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Shared synthetic project" });
    await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId: f.companyId, projectId,
      name: "Shared synthetic source", sourceType: "local", cwd: f.cwd });
    await db.update(executionWorkspaces).set({ mode: "shared_workspace", projectId, projectWorkspaceId }).where(eq(executionWorkspaces.id, f.workspaceId));
    await db.insert(workspaceRuntimeServices).values({ id: randomUUID(), companyId: f.companyId, projectWorkspaceId,
      scopeType: "project_workspace", scopeId: projectWorkspaceId, serviceName: "Inherited preview", status: "running",
      lifecycle: "shared", provider: "local_process", cwd: f.cwd });
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: false, reasons: ["workspace_runtime_service_unsettled"] });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("workspace_runtime_service_unsettled");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("original saved work\n");
  });
  it("rechecks a service that becomes unresolved during snapshot verification", async () => {
    const f = await seed(), get = storage.getObject.bind(storage); let reads = 0;
    storage.getObject = async (...args) => {
      if (++reads === 2) await db.insert(workspaceRuntimeServices).values({ id: randomUUID(), companyId: f.companyId,
        executionWorkspaceId: f.workspaceId, scopeType: "execution_workspace", scopeId: f.workspaceId,
        serviceName: "Late synthetic preview", status: "running", lifecycle: "shared", provider: "local_process", cwd: f.cwd });
      return get(...args);
    };
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("workspace_runtime_service_unsettled");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("original saved work\n");
  });
  it("rechecks a writer that appears while the restored copy is being verified", async () => {
    const f = await seed(), get = storage.getObject.bind(storage); let reads = 0;
    storage.getObject = async (...args) => {
      if (++reads === 2) await db.insert(workspaceOperations).values({ companyId: f.companyId, executionWorkspaceId: f.workspaceId,
        phase: "workspace_command", status: "running" });
      return get(...args);
    };
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("workspace_operation_unresolved");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
  });
  it("preserves a local edit made during verification and refuses activation", async () => {
    const f = await seed(), get = storage.getObject.bind(storage); let reads = 0;
    storage.getObject = async (...args) => { if (++reads === 2) await fs.writeFile(path.join(f.cwd, "saved.txt"), "new local work\n"); return get(...args); };
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("source_changed");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("new local work\n");
  });
});
