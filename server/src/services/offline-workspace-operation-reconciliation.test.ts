import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, closeRegisteredClients, companies, completionContracts, createDb, executionWorkspaces,
  heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, workspaceOperations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { reconcileOfflineWorkspaceOperations } from "./offline-workspace-operation-reconciliation.js";
import { inventoryRemoteWorkspaceMigration, migrateRemoteWorkspace } from "./remote-workspace-migration.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("offline workspace operation receipts", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("offline-operation-receipts-");
    db = createDb(database.connectionString);
    vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
  }, 60_000);
  afterAll(async () => {
    if (database) await closeRegisteredClients(database.connectionString);
    await database?.cleanup(); vi.unstubAllEnvs();
  });
  async function fixture() {
    const companyId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), workspaceId = randomUUID();
    const contractId = randomUUID(), resultId = randomUUID(), operationId = randomUUID(), receiptId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Historical receipts", issuePrefix: `O${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Worker", adapterType: "paperclip_runner" }).returning();
    await db.insert(issues).values({ id: issueId, companyId, title: "Saved work", status: "done" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      mode: "isolated_workspace", strategyType: "project_primary", providerType: "local_fs", name: "Retained files", cwd: "/retained" });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {}, canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    const profile = { nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v3", state: "finalized", workspaceId,
      leaseId: randomUUID(), providerLeaseId: randomUUID(), remoteCwd: "/work", descriptorSha256: "a".repeat(64),
      baselineSha256: "b".repeat(64), finalHostSha256: "c".repeat(64), resourceDisposition: "keep_running" } };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: agent.id, nativeIssueId: issueId, runtimeMode: "native",
      status: "succeeded", completionContractId: contractId, runnerProfileJson: profile, finishedAt: new Date() });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: contractId,
      serverFingerprint: resultId, schemaStatus: "accepted", resultJson: {}, canonicalSha256: resultId });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, resultId, phase: "committed" });
    const metadata = { owningService: "native_workspace_finalizer", original: "keep" };
    await db.insert(workspaceOperations).values({ id: operationId, companyId, executionWorkspaceId: workspaceId,
      heartbeatRunId: runId, issueId, phase: "workspace_finalize", status: "running", metadata,
      createdAt: new Date("2026-01-01"), startedAt: new Date("2026-01-01") });
    await db.insert(workspaceOperations).values({ id: receiptId, companyId, executionWorkspaceId: workspaceId,
      heartbeatRunId: runId, issueId, phase: "workspace_finalize", status: "succeeded",
      createdAt: new Date("2026-01-02"), startedAt: new Date("2026-01-02"), finishedAt: new Date("2026-01-02") });
    return { companyId, issueId, runId, workspaceId, resultId, operationId, receiptId, metadata, profile };
  }
  const reconcile = (companyId: string) => reconcileOfflineWorkspaceOperations(db,
    { companyId, writersStopped: true, signal: new AbortController().signal });
  const operation = async (id: string) => (await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, id)))[0]!;

  it("fails only the superseded attempt and atomically retains receipt provenance and audit", async () => {
    const f = await fixture();
    const runBefore = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const coordinatorBefore = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const receiptBefore = await operation(f.receiptId), attemptBefore = await operation(f.operationId);
    expect(await reconcile(f.companyId)).toMatchObject({ inspected: 1, reconciled: 1, held: [] });
    expect(await operation(f.operationId)).toMatchObject({ status: "failed", metadata: { ...attemptBefore.metadata,
      offlineReconciliation: { reason: "superseded_workspace_finalization", supersedingOperationId: f.receiptId,
        resultId: f.resultId, finalHostSha256: "c".repeat(64), previousStatus: "running" } } });
    expect(await operation(f.receiptId)).toEqual(receiptBefore);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId))).toEqual(runBefore);
    expect(await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId))).toEqual(coordinatorBefore);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, f.operationId)))
      .toEqual([expect.objectContaining({ action: "workspace_operation.reconciled", details: expect.objectContaining({ supersedingOperationId: f.receiptId }) })]);
    expect(await reconcile(f.companyId)).toMatchObject({ reconciled: 0 });
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, f.operationId))).toHaveLength(1);
  });

  it("unblocks the real workspace importer only after reconciling the obsolete attempt", async () => {
    const f = await fixture(), root = await mkdtemp(path.join(os.tmpdir(), "offline-receipt-import-"));
    try {
      const cwd = path.join(root, "source"); await mkdir(cwd);
      await writeFile(path.join(cwd, "saved.txt"), "Retained local work\n");
      await db.update(executionWorkspaces).set({ cwd, providerRef: cwd }).where(eq(executionWorkspaces.id, f.workspaceId));
      await db.update(issues).set({ executionWorkspaceId: f.workspaceId }).where(eq(issues.id, f.issueId));
      const storage = createStorageService(createLocalDiskStorageProvider(path.join(root, "objects")));
      const request = { db, storage, companyId: f.companyId, workspaceId: f.workspaceId, apply: true, writersStopped: true };
      expect((await inventoryRemoteWorkspaceMigration(db, request)).reasons).toContain("workspace_operation_unresolved");
      await expect(migrateRemoteWorkspace(request)).rejects.toThrow("workspace_operation_unresolved");
      expect(await reconcile(f.companyId)).toMatchObject({ reconciled: 1 });
      await expect(migrateRemoteWorkspace(request)).resolves.toMatchObject({ applied: true, eligible: true });
      expect(await readFile(path.join(cwd, "saved.txt"), "utf8")).toBe("Retained local work\n");
      expect((await operation(f.receiptId)).status).toBe("succeeded");
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
      expect(workspace.metadata?.remoteWorkspace).toMatchObject({ schema: "paperclip.remote-workspace.v1", snapshotId: expect.any(String) });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["missing_receipt", "failed_receipt", "earlier_receipt", "unfinished_receipt", "wrong_workspace", "wrong_run",
    "unexported", "missing_hash", "wrong_reference", "workspace_owner", "coordinator_owner", "uncommitted",
    "missing_result", "rejected_result", "controller_lease", "uncertain", "save_work", "legacy_prepare"])("holds incomplete proof: %s", async kind => {
    const f = await fixture();
    if (kind === "missing_receipt") await db.delete(workspaceOperations).where(eq(workspaceOperations.id, f.receiptId));
    if (kind === "failed_receipt") await db.update(workspaceOperations).set({ status: "failed" }).where(eq(workspaceOperations.id, f.receiptId));
    if (kind === "earlier_receipt") await db.update(workspaceOperations).set({ createdAt: new Date("2025-12-31") }).where(eq(workspaceOperations.id, f.receiptId));
    if (kind === "unfinished_receipt") await db.update(workspaceOperations).set({ finishedAt: null }).where(eq(workspaceOperations.id, f.receiptId));
    if (kind === "wrong_workspace") await db.update(workspaceOperations).set({ executionWorkspaceId: null }).where(eq(workspaceOperations.id, f.receiptId));
    if (kind === "wrong_run") await db.update(workspaceOperations).set({ heartbeatRunId: null }).where(eq(workspaceOperations.id, f.receiptId));
    if (["unexported", "missing_hash", "wrong_reference"].includes(kind)) await db.update(heartbeatRuns).set({ runnerProfileJson: {
      ...f.profile, nativeWorkspaceSync: { ...f.profile.nativeWorkspaceSync,
        ...(kind === "unexported" ? { state: "prepared" } : kind === "missing_hash" ? { finalHostSha256: null } : { workspaceId: randomUUID() }) },
    } }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "workspace_owner") await db.update(heartbeatRuns).set({ runnerProfileJson: { ...f.profile,
      nativeWorkspaceFinalizationOwner: { token: "retained-owner" } } }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "controller_lease") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(heartbeatRuns.id, f.runId));
    if (kind === "coordinator_owner") await db.update(nativeRunFinalizations).set({ leaseOwner: "retained-owner" }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (kind === "uncommitted") await db.update(nativeRunFinalizations).set({ phase: "result_accepted" }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (kind === "missing_result") await db.update(nativeRunFinalizations).set({ resultId: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (kind === "rejected_result") await db.update(nativeRunResults).set({ schemaStatus: "rejected" }).where(eq(nativeRunResults.id, f.resultId));
    if (kind === "uncertain" || kind === "save_work") await db.update(workspaceOperations).set({ metadata: { ...f.metadata,
      ...(kind === "uncertain" ? { uncertain: true } : { saveWork: { unknown: true, activeIds: [randomUUID()] } }) },
    }).where(eq(workspaceOperations.id, f.operationId));
    if (kind === "legacy_prepare") {
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.runId));
      await db.update(workspaceOperations).set({ phase: "worktree_prepare", metadata: { refreshedUnstartedWorktree: true } })
        .where(eq(workspaceOperations.id, f.operationId));
    }
    const before = await operation(f.operationId);
    expect(await reconcile(f.companyId)).toMatchObject({ inspected: 1, reconciled: 0, held: [{ operationId: f.operationId }] });
    expect(await operation(f.operationId)).toEqual(before);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, f.operationId))).toHaveLength(0);
  });

  it("requires the explicit stopped-writer acknowledgement as well as the maintenance switch", async () => {
    const f = await fixture();
    await expect(reconcileOfflineWorkspaceOperations(db, { companyId: f.companyId, writersStopped: false,
      signal: new AbortController().signal })).rejects.toThrow("offline_maintenance_required");
    vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "false");
    try { await expect(reconcile(f.companyId)).rejects.toThrow("offline_maintenance_required"); }
    finally { vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true"); }
    expect((await operation(f.operationId)).status).toBe("running");
  });

  it.each(["running", "queued"])("retains active %s execution as an offline blocker", async status => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, f.runId));
    try { await expect(reconcile(f.companyId)).rejects.toThrow("active_execution_requires_drain"); }
    finally { await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId)); }
    expect((await operation(f.operationId)).status).toBe("running");
  });

  it("keeps a never-started queued turn and only changes the requested company", async () => {
    const f = await fixture(), other = await fixture();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [queued] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: run.agentId, status: "queued" }).returning();
    const otherBefore = await operation(other.operationId);
    expect(await reconcile(f.companyId)).toMatchObject({ reconciled: 1 });
    expect(await operation(other.operationId)).toEqual(otherBefore);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id)))[0]).toEqual(queued);
  });

  it("retains an expired legacy controller lease while reconciling its obsolete receipt", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date("2026-01-01") }).where(eq(heartbeatRuns.id, f.runId));
    const before = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(await reconcile(f.companyId)).toMatchObject({ reconciled: 1 });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId))).toEqual(before);
  });

  it("does not change historical operations after remote workspace authority is published", async () => {
    const f = await fixture();
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1" } } })
      .where(eq(executionWorkspaces.id, f.workspaceId));
    const before = await operation(f.operationId);
    expect(await reconcile(f.companyId)).toMatchObject({ inspected: 0, reconciled: 0 });
    expect(await operation(f.operationId)).toEqual(before);
  });

  it.each(["coordinator", "run", "workspace", "receipt", "attempt"])("holds a busy %s row and succeeds after the actual writer releases it", async kind => {
    const f = await fixture();
    let release!: () => void, ready!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { ready = resolve; });
    const writer = db.transaction(async tx => {
      if (kind === "coordinator") await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)).for("update");
      else if (kind === "workspace") await tx.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId)).for("update");
      else if (kind === "run") await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)).for("update");
      else await tx.select().from(workspaceOperations).where(eq(workspaceOperations.id, kind === "receipt" ? f.receiptId : f.operationId)).for("update");
      ready(); await barrier;
    });
    await locked;
    try {
      expect(await reconcile(f.companyId)).toMatchObject({ reconciled: 0,
        held: [{ operationId: f.operationId, reason: "execution_rows_busy" }] });
      expect((await operation(f.operationId)).status).toBe("running");
    } finally { release(); await writer; }
    expect(await reconcile(f.companyId)).toMatchObject({ reconciled: 1 });
  });

  it("does not steal the finalizer's advisory ownership", async () => {
    const f = await fixture();
    let release!: () => void, ready!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { ready = resolve; });
    const writer = db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`native-workspace-finalization:${f.companyId}:${f.runId}`}, 0))`);
      ready(); await barrier;
    });
    await locked;
    try { expect(await reconcile(f.companyId)).toMatchObject({ reconciled: 0,
      held: [{ operationId: f.operationId, reason: "finalization_owner_busy" }] }); }
    finally { release(); await writer; }
    expect(await reconcile(f.companyId)).toMatchObject({ reconciled: 1 });
  });

  it("rolls back the attempt when the activity audit cannot persist", async () => {
    const f = await fixture();
    await db.execute(sql.raw(`create function reject_operation_audit() returns trigger language plpgsql as $$
      begin raise exception 'audit unavailable' using errcode = '23514'; end $$`));
    await db.execute(sql.raw(`create trigger reject_operation_audit before insert on activity_log for each row
      when (new.entity_id = '${f.operationId}') execute function reject_operation_audit()`));
    const before = await operation(f.operationId);
    try {
      await expect(reconcile(f.companyId)).rejects.toMatchObject({ cause: { code: "23514" } });
      expect(await operation(f.operationId)).toEqual(before);
    } finally {
      await db.execute(sql`drop trigger reject_operation_audit on activity_log`);
      await db.execute(sql`drop function reject_operation_audit()`);
    }
  });
});
