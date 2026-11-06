import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, closeRegisteredClients, companies, createDb, environmentLeases, environments,
  executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { inspectOnlineLegacyWorkspaceRecoveryHold, inspectOnlineLegacyWorkspaceRecoverySource,
  lockOnlineLegacyWorkspaceRecoverySources } from "./online-legacy-workspace-recovery.js";
import { tryLockNativeWorkspaceFinalization } from "./native-runtime/native-workspace-finalization-ownership.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("online legacy source preservation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("online-legacy-preservation-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    if (database) await closeRegisteredClients(database.connectionString);
    await database?.cleanup();
  });
  async function fixture() {
    const companyId = randomUUID(), workspaceId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Legacy preservation", issuePrefix: `P${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Historical native worker", adapterType: "paperclip_runner" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Preserve old files", status: "blocked" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ id: workspaceId, companyId,
      sourceIssueId: issue.id, providerType: "local_fs", mode: "isolated_workspace", strategyType: "project_primary", name: "Legacy files" }).returning();
    const reference = { schema: "paperclip.native-workspace-sync/v3" as const, state: "prepared" as const,
      workspaceId, leaseId: randomUUID(), providerLeaseId: randomUUID(), remoteCwd: "/workspaces/retained",
      descriptorSha256: "12".repeat(32), baselineSha256: "34".repeat(32), resourceDisposition: "destroy" as const };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: agent.id, nativeIssueId: issue.id,
      status: "failed", runtimeMode: "native", processPid: 4321, processGroupId: 4321,
      processStartedAt: new Date("2026-01-01T00:00:00Z"), runnerProfileJson: { nativeWorkspaceSync: reference },
      resultJson: { checkpoint: "preserve this result", workspaceRestoreRecovery: {
        schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [reference.leaseId] } } });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: issue.id, runId, phase: "terminal_failure",
      failureCode: "native_workspace_sync_out_retry_exhausted", recoveryHistory: [{ checkpoint: "preserve owner history" }] });
    const [environment] = await db.insert(environments).values({ name: runId, driver: "daytona" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ id: reference.leaseId, companyId, issueId: issue.id,
      environmentId: environment.id, heartbeatRunId: runId, executionWorkspaceId: workspaceId,
      provider: "daytona", providerLeaseId: reference.providerLeaseId, leasePolicy: "retain_on_failure",
      status: "retained", metadata: { remoteCwd: reference.remoteCwd } }).returning();
    return { companyId, workspace, runId, agent, issue, reference, lease };
  }
  async function retained(f: Awaited<ReturnType<typeof fixture>>) {
    return {
      runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)),
      owners: await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.companyId, f.companyId)),
      leases: await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId)),
      issues: await db.select().from(issues).where(eq(issues.companyId, f.companyId)),
      actions: await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId)),
    };
  }
  const inspect = (f: Awaited<ReturnType<typeof fixture>>) => inspectOnlineLegacyWorkspaceRecoverySource(db, f);

  it("preserves every source and historical process identity while unrelated object-backed work remains active", async () => {
    const f = await fixture();
    const [other] = await db.insert(issues).values({ companyId: f.companyId, title: "Current unrelated work" }).returning();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id, nativeIssueId: other.id,
      runtimeMode: "native", status: "running", controllerLeaseExpiresAt: new Date(Date.now() + 60_000),
      runnerProfileJson: { remoteWorkspace: { schema: "paperclip.remote-workspace-run.v1" } } });
    const before = await retained(f), source = await inspect(f);
    expect(source).toMatchObject({ runId: f.runId, issueId: f.issue.id, reference: f.reference,
      recoveryAllocations: [{ leaseId: f.lease.id, providerLeaseId: f.lease.providerLeaseId, remoteCwd: f.reference.remoteCwd }],
      onlineProof: { schema: "paperclip.online-legacy-workspace-preservation.v1" } });
    await db.transaction(async tx => {
      expect(await lockOnlineLegacyWorkspaceRecoverySources(tx as unknown as Db, { companyId: f.companyId, sources: [source!] })).toBe(true);
      expect(await inspectOnlineLegacyWorkspaceRecoverySource(tx, f)).toEqual(source);
      await db.transaction(async otherTx => {
        expect(await tryLockNativeWorkspaceFinalization(otherTx as unknown as Db, f)).toBe(false);
      });
    });
    expect(await retained(f)).toEqual(before);
    expect(before.runs.find(run => run.id === f.runId)?.processPid).toBe(4321);
    expect(before.leases[0].metadata?.remoteExecutionTermination).toBeUndefined();
  });

  it("does not mistake the migration's own journal updates for a changed recovery source", async () => {
    const f = await fixture(), source = await inspect(f);
    const [workspace] = await db.update(executionWorkspaces).set({
      metadata: { remoteWorkspaceMigration: { operationId: randomUUID(), phase: "capturing" } }, updatedAt: new Date(),
    }).where(eq(executionWorkspaces.id, f.workspace.id)).returning();
    expect(await inspectOnlineLegacyWorkspaceRecoverySource(db, { workspace, runId: f.runId })).toEqual(source);
  });

  it.each(["expired_coordinator", "physical_owner", "live_controller", "malformed_source", "missing_allocation"])("blocks uncertain %s without taking ownership", async change => {
    const f = await fixture();
    if (change === "expired_coordinator") await db.update(nativeRunFinalizations).set({ leaseOwner: "old-owner", leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (change === "physical_owner") await db.update(heartbeatRuns).set({ runnerProfileJson: {
      nativeWorkspaceSync: f.reference, nativeWorkspaceFinalizationOwner: { token: "unfinished-physical-copyback" } } }).where(eq(heartbeatRuns.id, f.runId));
    if (change === "live_controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, f.runId));
    if (change === "malformed_source") await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: { invalid: true } } }).where(eq(heartbeatRuns.id, f.runId));
    if (change === "missing_allocation") await db.update(environmentLeases).set({ providerLeaseId: randomUUID() }).where(eq(environmentLeases.id, f.lease.id));
    const before = await retained(f);
    expect(await inspect(f)).toBeNull();
    expect(await retained(f)).toEqual(before);
  });

  it("keeps the source local while its physical finalizer lock is held", async () => {
    const f = await fixture(), source = await inspect(f);
    await db.transaction(async tx => {
      expect(await tryLockNativeWorkspaceFinalization(tx as unknown as Db, f)).toBe(true);
      await db.transaction(async other => {
        expect(await lockOnlineLegacyWorkspaceRecoverySources(other as unknown as Db, { companyId: f.companyId, sources: [source!] })).toBe(false);
      });
    });
  });

  it("preserves all declared allocations for an ownerless result-less finalization", async () => {
    const f = await fixture();
    const [second] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issue.id,
      heartbeatRunId: f.runId, environmentId: f.lease.environmentId, provider: "daytona", providerLeaseId: randomUUID(),
      leasePolicy: "retain_on_failure", status: "retained", metadata: { remoteCwd: "/workspaces/second" } }).returning();
    await db.update(heartbeatRuns).set({ runnerProfileJson: {}, resultJson: { checkpoint: "retain",
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [second.id, f.lease.id] } } }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, f.runId));
    const before = await retained(f), source = await inspect(f);
    expect(source?.reference).toBeNull();
    expect(source?.recoveryAllocations?.map(item => item.leaseId).sort()).toEqual([f.lease.id, second.id].sort());
    expect(source?.unresolvedFinalization).toEqual({ phase: "observed", leaseOwner: null, leaseExpiresAt: null });
    expect(await retained(f)).toEqual(before);
    await db.update(environmentLeases).set({ environmentId: null }).where(eq(environmentLeases.id, second.id));
    expect(await inspect(f)).toBeNull();
  });

  it.each(["checkpoint", "allocation", "new_owner"])("invalidates publication when %s changes after capture", async change => {
    const f = await fixture(), source = await inspect(f);
    await db.transaction(async tx => {
      expect(await lockOnlineLegacyWorkspaceRecoverySources(tx as unknown as Db, { companyId: f.companyId, sources: [source!] })).toBe(true);
      if (change === "checkpoint") await db.update(nativeRunFinalizations).set({ recoveryHistory: [{ checkpoint: "new intent" }] }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (change === "allocation") await db.update(environmentLeases).set({ metadata: { remoteCwd: "/different-source" } }).where(eq(environmentLeases.id, f.lease.id));
      if (change === "new_owner") await db.update(heartbeatRuns).set({ runnerProfileJson: {
        nativeWorkspaceSync: f.reference, nativeWorkspaceFinalizationOwner: { token: "uncertain owner" } } }).where(eq(heartbeatRuns.id, f.runId));
      const current = await inspectOnlineLegacyWorkspaceRecoverySource(tx, f);
      expect(isDeepStrictEqual(current, source)).toBe(false);
    });
  });

  it("retains ordinary task warnings and requires a settled source for file-bearing holds", async () => {
    const f = await fixture();
    const [warning] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issue.id,
      kind: "configuration_validation", cause: "configuration_incomplete", fingerprint: randomUUID(), nextAction: "Keep warning" }).returning();
    const before = await retained(f);
    expect(await inspectOnlineLegacyWorkspaceRecoveryHold(db, { workspace: f.workspace, recovery: warning })).toMatchObject({ finalizedHold: null });
    expect(await inspectOnlineLegacyWorkspaceRecoveryHold(db, { workspace: f.workspace,
      recovery: { ...warning, evidence: { workspaceRecovery: { status: "blocked" } } } })).toBeNull();
    expect(await retained(f)).toEqual(before);
  });

  it("locks the exact finalized held run while leaving the warning and checkpoint intact", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: {
      ...f.reference, state: "finalized", finalHostSha256: "56".repeat(32) } } }).where(eq(heartbeatRuns.id, f.runId));
    const [recovery] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issue.id,
      kind: "active_run_watchdog", cause: "native_continuation_requires_reconciliation", fingerprint: randomUUID(),
      nextAction: "Keep the task held", evidence: { runId: f.runId, nativeFailureBlock: { retained: true } } }).returning();
    const before = await retained(f), held = await inspectOnlineLegacyWorkspaceRecoveryHold(db, { workspace: f.workspace, recovery });
    expect(held?.finalizedHold).toMatchObject({ runId: f.runId, actionId: recovery.id, sourceWorkspaceId: f.workspace.id });
    await db.transaction(async tx => {
      expect(await lockOnlineLegacyWorkspaceRecoverySources(tx as unknown as Db, {
        companyId: f.companyId, sources: [], holds: [held!] })).toBe(true);
      await db.transaction(async other => expect(await tryLockNativeWorkspaceFinalization(other as unknown as Db, f)).toBe(false));
    });
    expect(await retained(f)).toEqual(before);
  });
});
