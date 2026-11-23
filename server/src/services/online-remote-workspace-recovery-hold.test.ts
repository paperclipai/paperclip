import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, closeRegisteredClients, companies, completionContracts, createDb, environmentLeases, environments,
  executionWorkspaceSnapshots, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, projects,
  workspaceOperations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { migrateRemoteWorkspace } from "./remote-workspace-migration.js";
import { getWorkspaceSnapshot, loadWorkspaceSnapshotArchive } from "./remote-workspace-snapshot-storage.js";
import { restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { inspectWorkspaceRecoverySource } from "./workspace-recovery-source.js";
import { inspectOnlineLegacyWorkspaceRecoveryHold, inspectOnlineLegacyWorkspaceRecoverySource } from "./online-legacy-workspace-recovery.js";
import { tryLockNativeWorkspaceFinalization } from "./native-runtime/native-workspace-finalization-ownership.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { createSystemRecovery } from "./system-recovery-state.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("remote recovery hold beside a legacy Git source", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  let home: string, storage: StorageService;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("online-remote-hold-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    if (database) await closeRegisteredClients(database.connectionString);
    await database?.cleanup();
  });
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pc-remote-hold-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "61".repeat(32));
    storage = createStorageService(createLocalDiskStorageProvider(path.join(home, "objects")));
  });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });
  const execute = promisify(execFile);
  async function git(cwd: string, ...args: string[]) {
    return (await execute("git", ["-c", `core.hooksPath=${os.devNull}`, "-C", cwd, ...args], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" },
    })).stdout.trim();
  }
  async function fixture() {
    const companyId = randomUUID(), projectId = randomUUID(), runId = randomUUID(), remoteId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Remote hold", issuePrefix: `H${companyId.slice(0, 6)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Legacy project" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Held remote worker", adapterType: "paperclip_runner" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, projectId, title: "Earlier local task", status: "blocked", statusVersion: 28 }).returning();
    const root = resolveManagedProjectWorkspaceDir({ companyId, projectId });
    await fs.mkdir(root, { recursive: true }); await fs.writeFile(path.join(root, "saved.txt"), "preserved local work\n");
    await git(root, "init", "-q", "-b", "main"); await git(root, "add", "."); await git(root, "commit", "-qm", "Local work");
    const repoUrl = "https://example.invalid/legacy.git";
    await git(root, "remote", "add", "origin", repoUrl);
    const [legacy] = await db.insert(executionWorkspaces).values({ companyId, projectId, sourceIssueId: issue.id,
      name: "Old local workspace", providerType: "git_worktree", mode: "isolated_workspace", strategyType: "git_worktree",
      cwd: root, providerRef: root, repoUrl, branchName: "main" }).returning();
    const [leafIssue] = await db.insert(issues).values({ companyId, projectId, title: "Local leaf" }).returning();
    const cwd = path.join(root, ".paperclip", "worktrees", "leaf"); await git(root, "worktree", "add", "-qb", "leaf", cwd);
    const [leaf] = await db.insert(executionWorkspaces).values({ companyId, projectId, sourceIssueId: leafIssue.id,
      name: "Selected local leaf", providerType: "git_worktree", mode: "isolated_workspace", strategyType: "git_worktree",
      cwd, providerRef: cwd, repoUrl, branchName: "leaf", baseRef: "main" }).returning();
    const [environment] = await db.insert(environments).values({ name: runId, driver: "daytona" }).returning();
    const [baseline] = await db.insert(executionWorkspaceSnapshots).values({ companyId, executionWorkspaceId: remoteId,
      sourceOperationId: randomUUID(), sourceRunId: randomUUID(), generation: 10, epoch: 8, status: "committed",
      sha256: "89".repeat(32), manifestDigest: "90".repeat(32), objectKey: `${companyId}/retained-baseline`, byteSize: 281 }).returning();
    const reference = { schema: "paperclip.remote-workspace-run.v1", workspaceId: remoteId, leaseId: randomUUID(),
      providerLeaseId: randomUUID(), remoteCwd: `/workspaces/${remoteId}`, epoch: 9, state: "prepared", snapshotId: baseline.id };
    const authority = { schema: "paperclip.remote-workspace.v1", epoch: reference.epoch, snapshotId: baseline.id, source: { kind: "empty" },
      location: { environmentId: environment.id, leaseId: reference.leaseId, providerLeaseId: reference.providerLeaseId,
        remoteCwd: reference.remoteCwd }, writerRunId: runId, dirty: true };
    const [remote] = await db.insert(executionWorkspaces).values({ id: remoteId, companyId, projectId, sourceIssueId: issue.id,
      name: "Separate remote workspace", providerType: "cloud_sandbox", mode: "isolated_workspace", strategyType: "project_primary",
      cwd: reference.remoteCwd, metadata: { remoteWorkspace: authority } }).returning();
    const contractId = randomUUID(), resultId = randomUUID(), cause = "native_workspace_sync_out_retry_exhausted";
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId: issue.id, revision: 1,
      schemaVersion: "v1", policyVersion: "v1", risk: "low", completionAuthority: "agent", incompleteCriteriaPolicy: "block",
      contractJson: {}, canonicalSha256: "45".repeat(32), createdByActorType: "system", createdByActorId: "fixture" });
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: agent.id, nativeIssueId: issue.id,
      status: "failed", runtimeMode: "native", finishedAt: new Date(), completionContractId: contractId,
      runnerProfileJson: { remoteWorkspace: reference }, resultJson: { retained: "remote result remains held" } }).returning();
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId: issue.id, runId, completionContractId: contractId,
      serverFingerprint: runId, schemaStatus: "accepted", resultJson: { terminal: { runTerminalState: "succeeded" } }, canonicalSha256: "67".repeat(32) });
    const [owner] = await db.insert(nativeRunFinalizations).values({ companyId, issueId: issue.id, runId,
      phase: "terminal_failure", resultId, failureCode: cause, nextAttemptAt: null, recoveryHistory: [{ preserved: true }] }).returning();
    const [lease] = await db.insert(environmentLeases).values({ id: reference.leaseId, companyId, issueId: issue.id,
      heartbeatRunId: runId, executionWorkspaceId: remoteId, environmentId: environment.id, provider: "daytona",
      providerLeaseId: reference.providerLeaseId, status: "released", cleanupStatus: "success", leasePolicy: "ephemeral",
      metadata: { agentId: agent.id, remoteCwd: reference.remoteCwd } }).returning();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue.id, kind: "active_run_watchdog",
      cause, fingerprint: nativeSha256({ runId, failureCode: cause }), ownerType: "board", returnOwnerAgentId: agent.id,
      nextAction: "Preserve remote work", evidence: { runId, systemRecovery: { ...createSystemRecovery(runId),
        phase: "preserve_files", state: "exhausted", attempts: 4, retriesUsed: 3 }, workspaceRecovery: {
        schema: "paperclip.workspace-recovery.v1", runId, status: "blocked", stage: "verifying_stop", attempt: 4, requestIds: [] } } }).returning();
    await db.update(issues).set({ executionWorkspaceId: remoteId }).where(eq(issues.id, issue.id));
    return { companyId, workspaceId: leaf.id, root, cwd, legacy, remote, run, owner, lease, action, reference, authority, issue, baseline };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function retained(f: Fixture) {
    return {
      remote: await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.remote.id)),
      run: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)),
      owner: await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id)),
      lease: await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)),
      action: await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id)),
      result: await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.run.id)),
      baseline: await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, f.baseline.id)),
      issue: await db.select().from(issues).where(eq(issues.id, f.issue.id)),
    };
  }
  const migrate = (f: Fixture) => migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: f.workspaceId, apply: true });
  const hold = async (f: Fixture) => {
    const [recovery] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id));
    return inspectOnlineLegacyWorkspaceRecoveryHold(db, { workspace: f.legacy, recovery });
  };
  it("imports old local bytes while preserving the same-task remote recovery obligation", async () => {
    const f = await fixture(), before = await retained(f);
    const inspected = await inspectWorkspaceRecoverySource(db, { companyId: f.companyId, issueId: f.issue.id, runId: f.run.id, actionId: f.action.id });
    expect(inspected.sources[0].remoteWorkspace?.id).toBe(f.remote.id);
    expect(await inspectOnlineLegacyWorkspaceRecoverySource(db, { workspace: f.legacy, runId: f.run.id })).toBeNull();
    expect(await hold(f)).toMatchObject({ finalizedHold: null, remoteHold: {
      schema: "paperclip.remote-workspace-preservation.v1", runId: f.run.id, workspaceId: f.remote.id,
    } });
    const put = storage.putFile.bind(storage);
    vi.spyOn(storage, "putFile").mockImplementationOnce(async input => {
      await db.transaction(async tx => expect(await tryLockNativeWorkspaceFinalization(tx as unknown as Db, {
        companyId: f.companyId, runId: f.run.id,
      })).toBe(false));
      return put(input);
    });
    await expect(migrate(f)).resolves.toMatchObject({ applied: true });
    expect(await retained(f)).toEqual(before);
    const operations = await db.select().from(workspaceOperations).where(eq(workspaceOperations.companyId, f.companyId));
    expect(operations).toHaveLength(1);
    expect(operations[0].metadata?.legacyRecoverySources ?? []).toEqual([]);
    const [saved] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    const authority = readRemoteWorkspaceAuthority(saved.metadata)!;
    const reference = (await getWorkspaceSnapshot(db, { ...f, snapshotId: authority.snapshotId! }))!;
    const archivePath = path.join(home, "local.pcws"), targetDir = path.join(home, "cold");
    await loadWorkspaceSnapshotArchive({ storage, reference, targetPath: archivePath });
    await fs.rename(f.root, f.root + ".original-retained");
    await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: reference.manifestDigest });
    expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("preserved local work\n");
    expect(await retained(f)).toEqual(before);
  });
  it.each(["malformed", "foreign", "same-local", "dual-reference", "owner", "controller", "physical-owner",
    "active-writer", "epoch", "allocation", "result", "task", "history-marker", "recovery-state", "action-fingerprint", "baseline"])(
    "refuses an unsafe remote-only hold with %s binding", async change => {
      const f = await fixture();
      if (change === "malformed") await db.update(heartbeatRuns).set({ runnerProfileJson: {
        remoteWorkspace: { ...f.reference, unexpected: true },
      } }).where(eq(heartbeatRuns.id, f.run.id));
      if (change === "foreign") {
        const companyId = randomUUID();
        await db.insert(companies).values({ id: companyId, name: "Foreign", issuePrefix: `X${companyId.slice(0, 6)}` });
        await db.update(executionWorkspaces).set({ companyId }).where(eq(executionWorkspaces.id, f.remote.id));
      }
      if (change === "same-local") await db.update(heartbeatRuns).set({ runnerProfileJson: {
        remoteWorkspace: { ...f.reference, workspaceId: f.legacy.id },
      } }).where(eq(heartbeatRuns.id, f.run.id));
      if (change === "dual-reference") await db.update(heartbeatRuns).set({ runnerProfileJson: {
        ...f.run.runnerProfileJson, nativeWorkspaceSync: { schema: "unrecognized legacy reference" },
      } }).where(eq(heartbeatRuns.id, f.run.id));
      if (change === "owner") await db.update(nativeRunFinalizations).set({ leaseOwner: "unreleased-owner", leaseExpiresAt: new Date(0) })
        .where(eq(nativeRunFinalizations.runId, f.run.id));
      if (change === "controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) })
        .where(eq(heartbeatRuns.id, f.run.id));
      if (change === "physical-owner") await db.update(heartbeatRuns).set({ runnerProfileJson: {
        ...f.run.runnerProfileJson, nativeWorkspaceFinalizationOwner: { token: "unreleased-copyback" },
      } }).where(eq(heartbeatRuns.id, f.run.id));
      if (change === "active-writer") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.run.agentId,
        nativeIssueId: f.issue.id, status: "running", runtimeMode: "native", startedAt: new Date() });
      if (change === "epoch") await db.update(executionWorkspaces).set({ metadata: {
        remoteWorkspace: { ...f.authority, epoch: f.authority.epoch + 1 },
      } }).where(eq(executionWorkspaces.id, f.remote.id));
      if (change === "allocation") await db.update(environmentLeases).set({ providerLeaseId: randomUUID() })
        .where(eq(environmentLeases.id, f.lease.id));
      if (change === "result") await db.update(nativeRunResults).set({ schemaStatus: "rejected" })
        .where(eq(nativeRunResults.runId, f.run.id));
      if (change === "task") await db.update(issues).set({ checkoutRunId: f.run.id }).where(eq(issues.id, f.issue.id));
      if (change === "history-marker") await db.update(issueRecoveryActions).set({ evidence: {
        ...f.action.evidence, historicalWorkspaceSource: { schema: "paperclip.historical-workspace-source.v1", runId: f.run.id, leaseIds: [f.lease.id] },
      } }).where(eq(issueRecoveryActions.id, f.action.id));
      if (change === "recovery-state") await db.update(issueRecoveryActions).set({ evidence: {
        ...f.action.evidence, systemRecovery: { ...createSystemRecovery(f.run.id), state: "running" },
      } }).where(eq(issueRecoveryActions.id, f.action.id));
      if (change === "action-fingerprint") await db.update(issueRecoveryActions).set({ fingerprint: "00".repeat(32) })
        .where(eq(issueRecoveryActions.id, f.action.id));
      if (change === "baseline") await db.update(executionWorkspaceSnapshots).set({ status: "deleted" })
        .where(eq(executionWorkspaceSnapshots.id, f.baseline.id));
      const before = await retained(f), put = vi.spyOn(storage, "putFile");
      expect(await hold(f)).toBeNull();
      await expect(migrate(f)).rejects.toThrow();
      expect(put).not.toHaveBeenCalled();
      expect(await db.select().from(workspaceOperations).where(eq(workspaceOperations.companyId, f.companyId))).toEqual([]);
      expect(await retained(f)).toEqual(before);
      expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("preserved local work\n");
    });
  it("does not import while the remote finalizer fence is owned", async () => {
    const f = await fixture(), before = await retained(f);
    expect(await hold(f)).not.toBeNull();
    await db.transaction(async tx => {
      expect(await tryLockNativeWorkspaceFinalization(tx as unknown as Db, { companyId: f.companyId, runId: f.run.id })).toBe(true);
      await expect(migrate(f)).rejects.toThrow("remote_copyback_owned");
    });
    expect(await retained(f)).toEqual(before);
  });
  it.each(["authority", "lease", "action", "accepted-result", "baseline"])("refuses publication after remote %s changes", async change => {
    const f = await fixture(), initial = await hold(f), put = storage.putFile.bind(storage);
    expect(initial).not.toBeNull();
    vi.spyOn(storage, "putFile").mockImplementationOnce(async input => {
      const uploaded = await put(input);
      if (change === "authority") await db.update(executionWorkspaces).set({ metadata: {
        ...f.remote.metadata, preservedNote: "changed while local capture was running",
      } }).where(eq(executionWorkspaces.id, f.remote.id));
      if (change === "lease") await db.update(environmentLeases).set({ metadata: { ...f.lease.metadata, changed: true } })
        .where(eq(environmentLeases.id, f.lease.id));
      if (change === "action") await db.update(issueRecoveryActions).set({ evidence: { ...f.action.evidence, coordinatorAttempt: 4 } })
        .where(eq(issueRecoveryActions.id, f.action.id));
      if (change === "accepted-result") await db.update(nativeRunResults).set({ resultJson: { terminal: { runTerminalState: "succeeded" }, changed: true } })
        .where(eq(nativeRunResults.runId, f.run.id));
      if (change === "baseline") await db.update(executionWorkspaceSnapshots).set({ manifestDigest: "91".repeat(32) })
        .where(eq(executionWorkspaceSnapshots.id, f.baseline.id));
      expect((await hold(f))?.fingerprint).not.toBe(initial!.fingerprint);
      return uploaded;
    });
    await expect(migrate(f)).rejects.toThrow("remote_workspace_migration_blocked:online_workspace_source_scope_changed");
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    expect(readRemoteWorkspaceAuthority(workspace.metadata)).toBeNull();
    expect((await db.select().from(workspaceOperations).where(eq(workspaceOperations.companyId, f.companyId)))[0].status).toBe("running");
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("preserved local work\n");
  });
});
