import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recordLegacyWorkspaceRestoreFailure, legacyExecutionNeedsReconciliationWithEvidence, terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";
import { hasConversationContinuationPolicy, conversationRecoveryActionPredicate } from "../services/conversation-continuation.js";
import { settleStopOnlyCleanup } from "../services/sandbox-stop-and-retain.js";
import { hasRequiredWorkspaceRecovery } from "../services/workspace-restore-recovery-state.js";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const support = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("legacy remote workspace recovery", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { if (externalTestDatabaseUrl) db = createDb(externalTestDatabaseUrl);
    else { temporary = await startEmbeddedPostgresTestDatabase("legacy-workspace-recovery-"); db = createDb(temporary.connectionString); } }, 30_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });
  async function seed(options: { local?: boolean; taskDone?: boolean; reusable?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Workspace recovery", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Engineer", role: "engineer", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Restore files", status: options.taskDone ? "done" : "in_progress", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "legacy", contextSnapshot: { issueId } }).returning();
    if (options.local) await db.insert(environments).values({ name: "Local", driver: "local" }).onConflictDoNothing();
    const [environment] = options.local ? await db.select().from(environments).where(eq(environments.driver, "local"))
      : await db.insert(environments).values({ name: `Isolated test sandbox ${runId}`, driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId, environmentId: environment.id,
      status: "active", leasePolicy: options.reusable ? "reuse_by_environment" : "ephemeral",
      provider: options.local ? "local" : "daytona", providerLeaseId: randomUUID(),
      metadata: { driver: options.local ? "local" : "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: !options.local },
    }).returning();
    return { companyId, runId, issueId, run, lease };
  }
  const patch = { errorCode: "workspace_restore_failed", finishedAt: new Date(), resultJson: {
    workspaceRestoreFailure: "restore_failed", conversationContinuation: "continue_conversation_v1",
  } };
  const readLease = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0];

  it.each([false, true])("persists terminal status, stop-only source and board action atomically (task done=%s)", async taskDone => {
    const f = await seed({ taskDone, reusable: true });
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, { ...f.run, status: "failed", ...patch })).toBe(true);
    const failed = await terminalizeLegacyExecution({ db, run: f.run, status: "failed", patch });
    expect(failed?.status).toBe("failed");
    expect(failed?.resultJson?.workspaceRestoreRecovery).toMatchObject({ leaseIds: [f.lease.id] });
    expect(hasConversationContinuationPolicy(failed?.resultJson)).toBe(false);
    const lease = await readLease(f.lease.id);
    expect(lease).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure", metadata: {
      sandboxStopAndRetain: { companyId: f.companyId, runId: f.runId, leaseId: f.lease.id, providerLeaseId: f.lease.providerLeaseId },
      pendingCleanupInFlight: false,
    } });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(action).toMatchObject({ ownerType: "board", evidence: { workspaceRestoreRecovery: { leaseIds: [f.lease.id] } } });
    expect(await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.id, action.id), conversationRecoveryActionPredicate()))).toEqual([]);
    // A new controller uses the durable stop-only intent. It cannot turn a
    // successful stop into proof that the workspace files were restored.
    const receipt = { schema: "paperclip.remote-termination.v1", runId: f.runId, companyId: f.companyId,
      leaseId: lease.id, provider: lease.provider, providerLeaseId: lease.providerLeaseId, state: "stopped", confirmedAt: new Date().toISOString() };
    await settleStopOnlyCleanup(db, lease, { attemptId: String(lease.metadata?.pendingCleanupAttemptId), receipt });
    expect(await readLease(lease.id)).toMatchObject({ status: "released", leasePolicy: "retain_on_failure", metadata: { remoteExecutionTermination: { state: "stopped" } } });
    expect(hasRequiredWorkspaceRecovery(failed?.resultJson)).toBe(true);
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, failed!)).toBe(true);
    // A late adapter metadata write cannot erase the source pin when its
    // in-memory result predates the terminal transaction.
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, { ...failed!, resultJson: patch.resultJson })).toBe(true);
    const repeated = await terminalizeLegacyExecution({ db, run: failed!, status: "failed", patch });
    expect(repeated?.resultJson?.workspaceRestoreRecovery).toMatchObject({ leaseIds: [f.lease.id] });
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))).toHaveLength(1);
  });

  it("leaves local lock retry and successful remote cleanup policy unchanged", async () => {
    const local = await seed({ local: true });
    const failure = { ...patch, resultJson: { ...patch.resultJson, workspaceRestoreFailure: "restore_lock_timeout" } };
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, { ...local.run, status: "failed", ...failure })).toBe(false);
    expect(await readLease(local.lease.id)).toMatchObject({ status: "active", leasePolicy: "ephemeral" });
    const remote = await seed();
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, { ...remote.run, status: "succeeded", resultJson: {} })).toBe(false);
    expect(await readLease(remote.lease.id)).toMatchObject({ status: "active", leasePolicy: "ephemeral" });
  });

  it("does not retain another run's lease or revive an already released source", async () => {
    const f = await seed(), other = await seed();
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date() }).where(eq(environmentLeases.id, f.lease.id));
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, { ...f.run, status: "failed", ...patch })).toBe(false);
    await terminalizeLegacyExecution({ db, run: f.run, status: "failed", patch });
    expect(await readLease(f.lease.id)).toMatchObject({ status: "released", leasePolicy: "ephemeral" });
    expect(await readLease(other.lease.id)).toMatchObject({ status: "active", leasePolicy: "ephemeral" });
  });

  it("keeps a competing physical owner out of the stop receipt", async () => {
    const f = await seed(), other = await seed();
    await db.update(environmentLeases).set({ providerLeaseId: f.lease.providerLeaseId }).where(eq(environmentLeases.id, other.lease.id));
    await terminalizeLegacyExecution({ db, run: f.run, status: "failed", patch });
    expect(await readLease(f.lease.id)).toMatchObject({ status: "pending_cleanup", metadata: { sandboxStopAndRetain: { runId: f.runId } } });
    expect(await readLease(other.lease.id)).toMatchObject({ status: "active", heartbeatRunId: other.runId });
  });


  it("keeps the original source if host finalization fails after adapter settlement", async () => {
    const f = await seed();
    await recordLegacyWorkspaceRestoreFailure(db, f.run, patch.resultJson);
    const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(current.status).toBe("running");
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toHaveLength(1);
    expect(hasRequiredWorkspaceRecovery(current.resultJson)).toBe(true);
    expect(await readLease(f.lease.id)).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure" });
    // A restart's process-loss finalization sees the durable obligation, even
    // when its own result predates the restore failure.
    const stale = { stopReason: "process_lost" };
    const failed = await terminalizeLegacyExecution({ db, run: f.run, status: "failed", reconcileIfNeeded: true, patch: { errorCode: "process_lost", resultJson: stale } });
    expect(hasRequiredWorkspaceRecovery(failed?.resultJson)).toBe(true);
    expect(await readLease(f.lease.id)).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure" });
    expect(hasConversationContinuationPolicy(failed?.resultJson)).toBe(false);
  });


  it("records a repair action when cancellation wins before adapter copy-back reports failure", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), resultJson: { executionCancellation: { state: "acknowledged", proof: "provider_termination_receipt" } } }).where(eq(heartbeatRuns.id, f.runId));
    await recordLegacyWorkspaceRestoreFailure(db, f.run, patch.resultJson);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.status).toBe("cancelled");
    expect(run.resultJson?.executionCancellation).toMatchObject({ state: "acknowledged", proof: "provider_termination_receipt" });
    expect(hasRequiredWorkspaceRecovery(run.resultJson)).toBe(true);
    expect(await readLease(f.lease.id)).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure" });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toHaveLength(1);
  });

  it.each(["write_condition", "native_takeover"])("preserves the existing terminal-write fence for %s", async scenario => {
    const f = await seed();
    if (scenario === "native_takeover") await db.update(heartbeatRuns).set({ runtimeMode: "native" }).where(eq(heartbeatRuns.id, f.runId));
    const failed = await terminalizeLegacyExecution({ db, run: f.run, status: "failed", patch,
      reconcileIfNeeded: true, ...(scenario === "write_condition" ? { writeConditions: [sql`false`] } : {}),
    });
    expect(failed).toBeNull();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("running");
    expect(await readLease(f.lease.id)).toMatchObject({ status: "active", leasePolicy: "ephemeral" });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
  });

  it("rolls back terminal status and retention together on a failed transaction", async () => {
    const f = await seed();
    await expect(db.transaction(async tx => { await terminalizeLegacyExecution({ db: tx as unknown as typeof db, run: f.run, status: "failed", patch }); throw new Error("outer transaction failed"); })).rejects.toThrow("outer transaction failed");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("running");
    expect(await readLease(f.lease.id)).toMatchObject({ status: "active", leasePolicy: "ephemeral" });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
  });
});
