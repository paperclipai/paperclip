import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, closeRegisteredClients, companies, completionContracts, createDb, environmentLeases, environments,
  executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, workspaceOperations } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { inventoryRemoteWorkspaceMigration, migrateRemoteWorkspace } from "./remote-workspace-migration.js";
import { inspectWorkspaceRecoverySource } from "./workspace-recovery-source.js";
import { readMigratedLegacyWorkspaceSource } from "./legacy-workspace-recovery-migration.js";
import { verifiedWorkspaceRepairReceipt } from "./workspace-recovery-receipt.js";
import { createSystemRecovery } from "./system-recovery-state.js";
import { attemptNativeWorkspaceFinalization } from "./native-runtime/native-workspace-finalizer.js";
import { getWorkspaceSnapshot, loadWorkspaceSnapshotArchive } from "./remote-workspace-snapshot-storage.js";
import { restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("finalized workspace recovery preservation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("finalized-recovery-migration-"); db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "finalized-recovery-migration-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "63".repeat(32)); vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
  }, 90_000);
  afterAll(async () => {
    if (database) await closeRegisteredClients(database.connectionString);
    await database?.cleanup(); if (root) await fs.rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
  });
  async function fixture(files = false) {
    const companyId = randomUUID(), workspaceId = randomUUID(), runId = randomUUID(), cwd = path.join(root, workspaceId);
    await fs.mkdir(cwd); await fs.writeFile(path.join(cwd, "saved.txt"), "original held files\n");
    await db.insert(companies).values({ id: companyId, name: "Finalized recovery", issuePrefix: `F${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Historical worker", adapterType: "paperclip_runner" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Held task", status: "blocked" }).returning();
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issue.id,
      mode: "isolated_workspace", strategyType: "project_primary", providerType: "local_fs", cwd, name: "Held files" });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issue.id));
    const reference = { schema: "paperclip.native-workspace-sync/v3" as const, state: "finalized" as const, workspaceId,
      leaseId: randomUUID(), providerLeaseId: randomUUID(), remoteCwd: "/workspaces/task", descriptorSha256: "12".repeat(32),
      baselineSha256: "34".repeat(32), finalHostSha256: "56".repeat(32), resourceDisposition: "destroy" as const };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: agent.id, nativeIssueId: issue.id,
      status: "failed", runtimeMode: "native", runnerProfileJson: { nativeWorkspaceSync: reference }, resultJson: { retained: "result" } });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: issue.id, runId, phase: "terminal_failure" });
    if (files) {
      const [environment] = await db.insert(environments).values({ name: `Historical environment ${workspaceId}`, driver: "daytona" }).returning();
      await db.insert(environmentLeases).values({ id: reference.leaseId, companyId, environmentId: environment.id,
        issueId: issue.id, heartbeatRunId: runId, executionWorkspaceId: workspaceId, provider: "daytona",
        providerLeaseId: reference.providerLeaseId, leasePolicy: "ephemeral", status: "expired", metadata: { remoteCwd: reference.remoteCwd } });
    }
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue.id,
      kind: "active_run_watchdog", cause: "native_continuation_requires_reconciliation", fingerprint: randomUUID(),
      nextAction: "Preserve task hold", evidence: { runId, nativeFailureBlock: { retained: "hold" }, ...(files ? {
        systemRecovery: { ...createSystemRecovery(runId), state: "exhausted" },
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId, status: "blocked", stage: "verifying_stop", attempt: 4, requestIds: [] },
        historicalWorkspaceSource: { schema: "paperclip.historical-workspace-source.v1", runId, leaseIds: [reference.leaseId] },
      } : {}) } }).returning();
    const storage = createStorageService(createLocalDiskStorageProvider(path.join(root, `${workspaceId}-objects`)));
    return { companyId, workspaceId, runId, issueId: issue.id, cwd, reference, action, storage };
  }
  async function preserved(f: Awaited<ReturnType<typeof fixture>>) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [owner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id));
    return { issue, run, owner, action };
  }
  it.each([false, true])("saves held files while preserving task/coordinator/result bytes (file source: %s)", async files => {
    const f = await fixture(files), before = await preserved(f);
    await expect(migrateRemoteWorkspace({ db, ...f, writersStopped: false, apply: true })).rejects.toThrow("workspace_recovery_unresolved");
    await migrateRemoteWorkspace({ db, ...f, writersStopped: true, apply: true });
    const after = await preserved(f);
    expect(after.issue).toEqual(before.issue); expect(after.owner).toEqual(before.owner); expect(after.action).toEqual(before.action);
    if (files) {
      expect(after.run).toEqual({ ...before.run, updatedAt: expect.any(Date), runnerProfileJson: { ...before.run.runnerProfileJson,
        finalizedWorkspaceRecoveryMigration: { workspaceId: f.workspaceId, operationId: expect.any(String), schema: "paperclip.legacy-workspace-recovery-migration.v1" } } });
      const inspected = await inspectWorkspaceRecoverySource(db, { ...f, actionId: f.action.id });
      expect(inspected.sources).toEqual([expect.objectContaining({ preservationOnly: true, reference: f.reference })]);
      expect(inspected.sources[0].lease.metadata).toEqual({ remoteCwd: f.reference.remoteCwd });
    } else expect(after.run).toEqual(before.run);
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    const authority = readRemoteWorkspaceAuthority(workspace.metadata)!;
    const ref = (await getWorkspaceSnapshot(db, { ...f, snapshotId: authority.snapshotId! }))!;
    await fs.rm(f.cwd, { recursive: true });
    const archivePath = path.join(root, `${f.workspaceId}.pcws`), targetDir = path.join(root, `${f.workspaceId}-restored`);
    await loadWorkspaceSnapshotArchive({ storage: f.storage, reference: ref, targetPath: archivePath });
    await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: ref.manifestDigest });
    expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("original held files\n");
  });
  it.each([true, false])("requires a successful receipt for accepted-result retries (receipt: %s)", async saved => {
    const f = await fixture(), contractId = randomUUID(), resultId = randomUUID(), operationId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.issueId, revision: 1,
      schemaVersion: "v1", policyVersion: "v1", risk: "low", completionAuthority: "agent", incompleteCriteriaPolicy: "block",
      contractJson: {}, canonicalSha256: "12".repeat(32), createdByActorType: "system", createdByActorId: "test" });
    await db.update(heartbeatRuns).set({ status: "succeeded", completionContractId: contractId }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(nativeRunResults).values({ id: resultId, companyId: f.companyId, issueId: f.issueId, runId: f.runId,
      completionContractId: contractId, serverFingerprint: "saved-result", schemaStatus: "accepted", resultJson: { saved: true }, canonicalSha256: "34".repeat(32) });
    await db.update(nativeRunFinalizations).set({ phase: "retryable_failure", resultId }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (saved) await db.insert(workspaceOperations).values({ id: operationId, companyId: f.companyId, executionWorkspaceId: null,
      issueId: f.issueId, heartbeatRunId: f.runId, phase: "workspace_finalize", status: "succeeded" });
    const before = await preserved(f);
    if (!saved) {
      await expect(migrateRemoteWorkspace({ db, ...f, apply: true, writersStopped: true })).rejects.toThrow("workspace_recovery_unresolved");
      expect(await preserved(f)).toEqual(before);
      return;
    }
    await migrateRemoteWorkspace({ db, ...f, apply: true, writersStopped: true });
    expect(await preserved(f)).toEqual(before);
    expect(await attemptNativeWorkspaceFinalization({ db, runId: f.runId })).toMatchObject({ kind: "completed", operation: { id: operationId } });
  });
  it.each(["source-run", "controller", "owner", "phase", "descriptor", "file-marker", "allocation", "running-recovery", "unknown-kind"])("keeps an unproven %s hold blocked", async mode => {
    const f = await fixture(true);
    if (mode === "source-run") await db.update(issueRecoveryActions).set({ evidence: { ...f.action.evidence, runId: randomUUID() } }).where(eq(issueRecoveryActions.id, f.action.id));
    if (mode === "controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, f.runId));
    if (mode === "owner") await db.update(nativeRunFinalizations).set({ leaseOwner: "expired-owner", leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (mode === "phase") await db.update(nativeRunFinalizations).set({ phase: "retryable_failure" }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (mode === "descriptor") await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: { ...f.reference, finalHostSha256: null } } }).where(eq(heartbeatRuns.id, f.runId));
    if (mode === "file-marker") await db.update(issueRecoveryActions).set({ evidence: { ...f.action.evidence, historicalWorkspaceSource: { schema: "unverified" } } }).where(eq(issueRecoveryActions.id, f.action.id));
    if (mode === "allocation") await db.update(environmentLeases).set({ heartbeatRunId: null }).where(eq(environmentLeases.id, f.reference.leaseId));
    if (mode === "running-recovery") await db.update(issueRecoveryActions).set({ evidence: { ...f.action.evidence,
      systemRecovery: { ...createSystemRecovery(f.runId), state: "running" } } }).where(eq(issueRecoveryActions.id, f.action.id));
    if (mode === "unknown-kind") await db.update(issueRecoveryActions).set({ kind: "unknown_kind" }).where(eq(issueRecoveryActions.id, f.action.id));
    expect(await inventoryRemoteWorkspaceMigration(db, { ...f, writersStopped: true })).toMatchObject({ eligible: false, reasons: expect.arrayContaining(["workspace_recovery_unresolved"]) });
  });
  it.each(["action", "allocation", "coordinator"])("rechecks the exact %s after upload", async mode => {
    const f = await fixture(true), put = f.storage.putFile.bind(f.storage);
    f.storage.putFile = async input => { const result = await put(input);
      if (mode === "action") await db.update(issueRecoveryActions).set({ evidence: { ...f.action.evidence, retainedChange: true } }).where(eq(issueRecoveryActions.id, f.action.id));
      if (mode === "allocation") await db.update(environmentLeases).set({ providerLeaseId: randomUUID() }).where(eq(environmentLeases.id, f.reference.leaseId));
      if (mode === "coordinator") await db.update(nativeRunFinalizations).set({ failureCode: "changed" }).where(eq(nativeRunFinalizations.runId, f.runId));
      return result;
    };
    await expect(migrateRemoteWorkspace({ db, ...f, apply: true, writersStopped: true })).rejects.toThrow();
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    expect(readRemoteWorkspaceAuthority(workspace.metadata)).toBeNull();
  });
  it("keeps a historical folder separate from its real recovery source", async () => {
    const f = await fixture(true), workspaceId = randomUUID(), cwd = path.join(root, workspaceId); await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "history.txt"), "historical files\n");
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId: f.companyId, sourceIssueId: f.issueId,
      mode: "isolated_workspace", strategyType: "project_primary", providerType: "local_fs", cwd, name: "Other historical folder" });
    await migrateRemoteWorkspace({ db, ...f, workspaceId, apply: true, writersStopped: true });
    const [historical] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
    expect(historical.metadata).not.toHaveProperty("legacyWorkspaceRecoveryMigration");
    expect((await preserved(f)).run.runnerProfileJson).not.toHaveProperty("finalizedWorkspaceRecoveryMigration");
    await migrateRemoteWorkspace({ db, ...f, apply: true, writersStopped: true });
    expect(await readMigratedLegacyWorkspaceSource(db, { ...f, reference: f.reference })).toMatchObject({ reference: f.reference });
  });
  it("discovers a finalized child task's held source when importing its ancestor workspace", async () => {
    const f = await fixture(true);
    const [parent] = await db.insert(issues).values({ companyId: f.companyId, title: "Workspace owner" }).returning();
    await db.update(issues).set({ parentId: parent.id }).where(eq(issues.id, f.issueId));
    await db.update(executionWorkspaces).set({ sourceIssueId: parent.id }).where(eq(executionWorkspaces.id, f.workspaceId));
    const before = await preserved(f);
    await migrateRemoteWorkspace({ db, ...f, apply: true, writersStopped: true });
    expect((await preserved(f)).issue).toEqual(before.issue);
    expect((await preserved(f)).action).toEqual(before.action);
    const inspected = await inspectWorkspaceRecoverySource(db, { ...f, actionId: f.action.id });
    expect(inspected.sources).toEqual([expect.objectContaining({ preservationOnly: true, reference: f.reference })]);
    expect((await preserved(f)).run.runnerProfileJson).toHaveProperty("finalizedWorkspaceRecoveryMigration.workspaceId", f.workspaceId);
  });
  it.each(["old-copyback", "new-snapshot"])("retains verified repair through migration and the execution blocker (%s)", async mode => {
    const f = await fixture(true), operationId = randomUUID();
    await db.update(issueRecoveryActions).set({ evidence: { ...f.action.evidence, workspaceRestoreFailure: "restore_unsafe_archive",
      systemRecovery: { ...createSystemRecovery(f.runId), state: "complete" },
      workspaceRecovery: { ...(f.action.evidence.workspaceRecovery as object), status: "recovered" },
    } }).where(eq(issueRecoveryActions.id, f.action.id));
    const file = (suffix: string) => ({ objectKey: `${f.companyId}/workspace-recovery/${f.runId}/${f.reference.leaseId}/${"78".repeat(32)}.${suffix}`,
      sha256: "78".repeat(32), byteSize: 1 });
    await db.insert(workspaceOperations).values({ id: operationId, companyId: f.companyId, issueId: f.issueId,
      heartbeatRunId: f.runId, phase: mode === "old-copyback" ? "workspace_recovery" : "workspace_recovery_snapshot", status: "succeeded",
      metadata: { schema: "paperclip.workspace-recovery-snapshot.v1", recoveryActionId: f.action.id,
        leaseId: f.reference.leaseId, providerLeaseId: f.reference.providerLeaseId,
        descriptorSha256: f.reference.descriptorSha256, finalHostSha256: f.reference.finalHostSha256,
        archive: file("tar"), manifest: file("jsonl") } });
    await migrateRemoteWorkspace({ db, ...f, apply: true, writersStopped: true });
    expect(await verifiedWorkspaceRepairReceipt(db, (await preserved(f)).run)).toBe(operationId);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({
      recoveryActionId: f.action.id, workspaceRepairRequired: false,
    });
  });
  it("requires every allocation and preserves mixed completed repair receipts", async () => {
    const f = await fixture(true), otherLeaseId = randomUUID(), otherProviderLeaseId = randomUUID();
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.reference.leaseId));
    await db.insert(environmentLeases).values({ ...lease, id: otherLeaseId, providerLeaseId: otherProviderLeaseId });
    await db.update(issueRecoveryActions).set({ evidence: { ...f.action.evidence,
      systemRecovery: { ...createSystemRecovery(f.runId), state: "complete" },
      workspaceRecovery: { ...(f.action.evidence.workspaceRecovery as object), status: "recovered" },
      historicalWorkspaceSource: { schema: "paperclip.historical-workspace-source.v1", runId: f.runId,
        leaseIds: [f.reference.leaseId, otherLeaseId] },
    } }).where(eq(issueRecoveryActions.id, f.action.id));
    await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId,
      heartbeatRunId: f.runId, phase: "workspace_recovery", status: "succeeded", metadata: {
        recoveryActionId: f.action.id, leaseId: f.reference.leaseId, providerLeaseId: f.reference.providerLeaseId,
        descriptorSha256: f.reference.descriptorSha256, finalHostSha256: f.reference.finalHostSha256 } });
    await migrateRemoteWorkspace({ db, ...f, apply: true, writersStopped: true });
    expect(await verifiedWorkspaceRepairReceipt(db, (await preserved(f)).run)).toBeNull();
    const file = (suffix: string) => ({ objectKey: `${f.companyId}/workspace-recovery/${f.runId}/${otherLeaseId}/${"78".repeat(32)}.${suffix}`,
      sha256: "78".repeat(32), byteSize: 1 });
    await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId,
      heartbeatRunId: f.runId, phase: "workspace_recovery_snapshot", status: "succeeded", metadata: {
        schema: "paperclip.workspace-recovery-snapshot.v1", recoveryActionId: f.action.id,
        leaseId: otherLeaseId, providerLeaseId: otherProviderLeaseId,
        archive: file("tar"), manifest: file("jsonl") } });
    expect(await verifiedWorkspaceRepairReceipt(db, (await preserved(f)).run)).not.toBeNull();
  });
  it("preserves an older finalized reference with omitted optional fields", async () => {
    const f = await fixture(true);
    const { resourceDisposition: _disposition, ...legacy } = f.reference;
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: {
      ...legacy, schema: "paperclip.native-workspace-sync/v1",
    } } }).where(eq(heartbeatRuns.id, f.runId));
    await migrateRemoteWorkspace({ db, ...f, apply: true, writersStopped: true });
    const inspected = await inspectWorkspaceRecoverySource(db, { ...f, actionId: f.action.id });
    expect(inspected.sources).toEqual([expect.objectContaining({ preservationOnly: true,
      reference: { ...legacy, schema: "paperclip.native-workspace-sync/v1", resourceDisposition: null } })]);
  });
  it("requires the exact receipt and leaves ordinary finalized references alone", async () => {
    const f = await fixture(true);
    expect(await readMigratedLegacyWorkspaceSource(db, { ...f, reference: f.reference })).toBeNull();
    await migrateRemoteWorkspace({ db, ...f, apply: true, writersStopped: true });
    await expect(readMigratedLegacyWorkspaceSource(db, { ...f, reference: { ...f.reference, descriptorSha256: "78".repeat(32) } }))
      .rejects.toThrow("legacy_workspace_migration_receipt_invalid");
    await db.update(environmentLeases).set({ providerLeaseId: randomUUID() }).where(eq(environmentLeases.id, f.reference.leaseId));
    await expect(readMigratedLegacyWorkspaceSource(db, { ...f, reference: f.reference })).rejects.toThrow("legacy_workspace_migration_receipt_invalid");
  });
});
