import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, completionContracts, createDb, environmentLeases, environments, executionWorkspaceSnapshots, executionWorkspaces, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, projects, projectWorkspaces, workspaceOperations, workspaceRuntimeServices, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, readRemoteWorkspaceRunReference } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { migrateRemoteWorkspace } from "./remote-workspace-migration.js";
import { getWorkspaceSnapshot, loadWorkspaceSnapshotArchive } from "./remote-workspace-snapshot-storage.js";
import { restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { tryLockNativeWorkspaceFinalization } from "./native-runtime/native-workspace-finalization-ownership.js";
import { recordNativeFinalizationFailure } from "./native-runtime/native-run-finalizer.js";
import { inspectOnlineWorkspaceSource } from "./online-workspace-source.js";
import { inspectOnlineLegacyWorkspaceRecoverySource } from "./online-legacy-workspace-recovery.js";
import { inspectWorkspaceRecoverySource } from "./workspace-recovery-source.js";
import { createSystemRecovery } from "./system-recovery-state.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { adoptHistoricalWorkspaceRecoveries } from "./workspace-recovery-backfill.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("covered historical prepared-source preservation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>, home: string, storage: StorageService;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("covered-historical-source-");
    db = createDb(database.connectionString, { maxConnections: 1 });
    await db.execute(sql`set client_min_messages = warning`);
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "covered-historical-source-")));
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
    await db.delete(nativeRunResults);
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(completionContracts);
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

  async function coveredFixture() {
    const f = await recoveryFixture(), cause = "native_workspace_sync_out_retry_exhausted", contractId = randomUUID(), resultId = randomUUID();
    const reference = { ...f.run.runnerProfileJson!.nativeWorkspaceSync as Record<string, unknown>, resourceDisposition: "keep_running" };
    await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.run.nativeIssueId!, revision: 1,
      schemaVersion: "v1", policyVersion: "v1", risk: "low", completionAuthority: "agent", incompleteCriteriaPolicy: "block",
      contractJson: {}, canonicalSha256: "45".repeat(32), createdByActorType: "system", createdByActorId: "fixture" });
    await db.update(heartbeatRuns).set({ completionContractId: contractId, completionContractSha256: "45".repeat(32),
      runnerProfileJson: { ...f.run.runnerProfileJson, nativeWorkspaceSync: reference },
      resultJson: { retained: "original failed export" } }).where(eq(heartbeatRuns.id, f.run.id));
    await db.insert(nativeRunResults).values({ id: resultId, companyId: f.companyId, issueId: f.run.nativeIssueId!, runId: f.run.id,
      completionContractId: contractId, serverFingerprint: "retained accepted result", schemaStatus: "accepted",
      resultJson: { terminal: { runTerminalState: "succeeded" }, retained: "original result" }, canonicalSha256: "67".repeat(32) });
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", resultId, failureCode: cause, nextAttemptAt: null,
      recoveryHistory: [{ retained: "remote export remains unresolved" }] }).where(eq(nativeRunFinalizations.runId, f.run.id));
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date("2026-01-01T00:00:00Z") })
      .where(eq(environmentLeases.id, f.lease.id));
    await db.update(issues).set({ status: "blocked", statusVersion: 6, executionRunId: null, checkoutRunId: null })
      .where(eq(issues.id, f.run.nativeIssueId!));
    await db.update(issueRecoveryActions).set({ cause, ownerType: "board", ownerAgentId: null, returnOwnerAgentId: f.run.agentId,
      wakePolicy: null, fingerprint: nativeSha256({ runId: f.run.id, failureCode: cause }), evidence: {
        runId: f.run.id, coordinatorAttempt: 3, workspaceFinalizeAttempt: 3,
        systemRecovery: { ...createSystemRecovery(f.run.id), state: "exhausted" },
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: f.run.id, status: "blocked", stage: "verifying_stop", attempt: 4, requestIds: [] },
        previousWorkspaceRecovery: { retained: "original recovery history" },
      } }).where(eq(issueRecoveryActions.id, f.warning.id));
    await adoptHistoricalWorkspaceRecoveries(db);
    const [warning] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.warning.id));
    expect(warning.evidence.historicalWorkspaceSource).toEqual({ schema: "paperclip.historical-workspace-source.v1", runId: f.run.id, leaseIds: [f.lease.id] });
    return { ...f, ...await gitFixture(f), warning };
  }
  async function retained(f: Awaited<ReturnType<typeof coveredFixture>>) {
    return { run: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0],
      owner: (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id)))[0],
      result: await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.run.id)),
      lease: (await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0],
      task: (await db.select().from(issues).where(eq(issues.id, f.run.nativeIssueId!)))[0],
      warning: (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.warning.id)))[0] };
  }
  it("imports and cold-restores a selected Git leaf while preserving its peer's canonical historical recovery", async () => {
    const f = await coveredFixture(), selected = { companyId: f.companyId, workspaceId: f.child.id };
    const before = await retained(f), unrelated = await remoteWriter(f.companyId, f.run.agentId);
    expect(await inspectOnlineLegacyWorkspaceRecoverySource(db, { workspace: (await stored(f.workspaceId))!, runId: f.run.id })).not.toBeNull();
    expect((await inspectWorkspaceRecoverySource(db, { companyId: f.companyId, issueId: f.run.nativeIssueId!, runId: f.run.id, actionId: f.warning.id })).sources.map(s=>s.lease.id)).toEqual([f.lease.id]);
    const scope = await inspectOnlineWorkspaceSource(db, f.child), put = storage.putFile.bind(storage);
    vi.spyOn(storage, "putFile").mockImplementationOnce(async input => {
      await db.transaction(async tx => expect(await tryLockNativeWorkspaceFinalization(tx as unknown as Db, { companyId: f.companyId, runId: f.run.id })).toBe(false));
      return put(input);
    });
    await expect(migrateRemoteWorkspace({ db, storage, ...selected, apply: true })).resolves.toMatchObject({ applied: true });
    expect(scope?.workspaceIds).toContain(f.workspaceId);
    expect(scope?.companions.find(c=>c.workspaceId===f.workspaceId)?.holds).toHaveLength(1);
    expect(await retained(f)).toEqual(before);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unrelated.id)))[0]).toEqual(unrelated);
    const authority = readRemoteWorkspaceAuthority((await stored(f.child.id))!.metadata)!;
    const ref = (await getWorkspaceSnapshot(db, { ...selected, snapshotId: authority.snapshotId! }))!;
    const cipher = await storage.getObject(f.companyId, ref.objectKey), chunks: Buffer[] = [];
    for await (const part of cipher.stream) chunks.push(Buffer.from(part));
    expect(Buffer.concat(chunks).subarray(0, 7).toString()).toBe("PCWSE1\n");
    const head = await git(f.child.cwd!, "rev-parse", "HEAD"), parked = path.join(home, "parked-original");
    await fs.rename(f.cwd, parked);
    try {
      const archivePath = path.join(home, "selected.pcws"), targetDir = path.join(home, "restored");
      await loadWorkspaceSnapshotArchive({ storage, reference: ref, targetPath: archivePath });
      await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: ref.manifestDigest });
      expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
      expect(await git(targetDir, "rev-parse", "HEAD")).toBe(head);
    } finally { await fs.rename(parked, f.cwd); }
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
  });
  it.each(["schema", "run", "duplicate", "extra", "foreign", "missing", "malformed", "unknown-field", "provider", "cwd", "owner", "task"])("refuses a historical source with invalid %s binding without changing the hold", async mode => {
    const f = await coveredFixture(), marker = f.warning.evidence.historicalWorkspaceSource as Record<string, unknown>;
    if (mode === "schema") marker.schema = "unrecognized";
    if (mode === "run") marker.runId = randomUUID();
    if (mode === "duplicate") marker.leaseIds = [f.lease.id, f.lease.id];
    if (mode === "extra") marker.leaseIds = [f.lease.id, randomUUID()];
    if (mode === "missing") marker.leaseIds = [randomUUID()];
    if (mode === "foreign") {
      const companyId = randomUUID(); await db.insert(companies).values({ id: companyId, name: "Foreign retained source", issuePrefix: "FOREIGN" });
      const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: f.lease.environmentId,
        provider: "daytona", providerLeaseId: randomUUID(), leasePolicy: "retain_on_failure", status: "retained" }).returning();
      marker.leaseIds = [lease.id];
    }
    if (mode === "unknown-field") marker.additionalSource = randomUUID();
    await db.update(issueRecoveryActions).set({ evidence: { ...f.warning.evidence,
      historicalWorkspaceSource: mode === "malformed" ? [marker] : marker } }).where(eq(issueRecoveryActions.id, f.warning.id));
    if (mode === "provider") await db.update(environmentLeases).set({ providerLeaseId: randomUUID() }).where(eq(environmentLeases.id, f.lease.id));
    if (mode === "cwd") { const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      await db.update(environmentLeases).set({ metadata: { ...lease.metadata, remoteCwd: "/different" } }).where(eq(environmentLeases.id, f.lease.id)); }
    if (mode === "owner") await db.update(nativeRunFinalizations).set({ leaseOwner: "unreleased", leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.run.id));
    if (mode === "task") { const run = await remoteWriter(f.companyId, f.run.agentId);
      await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, f.run.nativeIssueId!)); }
    const before = await retained(f);
    expect(await inspectOnlineWorkspaceSource(db, f.child)).toBeNull();
    await expect(migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: f.child.id, apply: true })).rejects.toThrow();
    expect(await db.select().from(workspaceOperations)).toEqual([]); expect(await db.select().from(executionWorkspaceSnapshots)).toEqual([]);
    expect(await retained(f)).toEqual(before);
    expect(await fs.readFile(path.join(f.child.cwd!, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
  });
  it("retains the uploaded snapshot but refuses publication if the peer historical marker changes", async () => {
    const f = await coveredFixture(), before = await retained(f), put = storage.putFile.bind(storage);
    vi.spyOn(storage, "putFile").mockImplementationOnce(async input => {
      const result = await put(input);
      const marker = f.warning.evidence.historicalWorkspaceSource as Record<string, unknown>;
      await db.update(issueRecoveryActions).set({ evidence: { ...f.warning.evidence,
        historicalWorkspaceSource: { ...marker, leaseIds: [randomUUID()] } } }).where(eq(issueRecoveryActions.id, f.warning.id));
      return result;
    });
    await expect(migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: f.child.id, apply: true })).rejects.toThrow();
    expect(readRemoteWorkspaceAuthority((await stored(f.child.id))!.metadata)).toBeNull();
    const [snapshot] = await db.select().from(executionWorkspaceSnapshots); expect(snapshot.status).toBe("uploaded");
    expect((await storage.headObject(f.companyId, snapshot.objectKey!)).exists).toBe(true);
    const after = await retained(f);
    expect({ ...after, warning: undefined }).toEqual({ ...before, warning: undefined });
    expect(after.warning.evidence.historicalWorkspaceSource).not.toEqual(before.warning.evidence.historicalWorkspaceSource);
    expect(await fs.readFile(path.join(f.child.cwd!, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
  });

});
