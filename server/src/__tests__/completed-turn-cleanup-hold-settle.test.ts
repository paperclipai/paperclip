import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  controllerInstances,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  workspaceOperations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { currentControllerBootId, currentProcessSpaceHash } from "../services/controller-process-identity.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { registerControllerInstanceDb, resetControllerInstanceLeaseForTests } from "../services/controller-instance-lease.js";
import { createOwnershipReportState, runOwnershipReconciliationPass } from "../services/recovery/ownership-invariant-report.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const KIND = "native_completed_turn_cleanup_hold";

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
  return pid;
}

/**
 * The staging shape of a run that completed its provider turn after a restart
 * orphaned one tool callback. Close could not prove the drain, so the run
 * failed with `native_session_cleanup_quarantined`, and the system recorded two
 * resolved-but-blocked no-replay holds for it:
 * - the cleanup-quarantine hold (board owner, no workspace evidence), and
 * - a continuation hold whose workspace recovery saved the files ("Saved work
 *   recovered. Send a message to continue.", no Retry, no continuation).
 * The task waited on a child task and stayed blocked after deploys.
 */
suite("completed-turn cleanup holds on the shared ownership path", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "", agentId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-completed-turn-cleanup-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID(); agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "CTC",
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(workspaceOperations);
    await db.delete(nativeRunFinalizations);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
  });

  afterAll(async () => { await temporary?.cleanup(); });

  async function quarantinedRun(options: { controllerAlive?: boolean; turnCompleted?: boolean; filesSaved?: boolean;
    controllerBootId?: string; hostHashUnrecorded?: boolean } = {}) {
    const issueId = randomUUID(), runId = randomUUID(), leaseId = randomUUID();
    const finishedAt = new Date(Date.now() - 60_000);
    await db.insert(issues).values({ id: issueId, companyId, title: "Set up visual reviews", status: "blocked",
      assigneeAgentId: agentId, statusVersion: 6 });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "automation", issueId,
      nativeIssueId: issueId,
      status: "failed", errorCode: "native_session_cleanup_quarantined", runtimeMode: "native",
      error: "native_session_cleanup_quarantined: prior session cleanup requires operator recovery",
      startedAt: new Date(finishedAt.getTime() - 16 * 60_000), finishedAt, nextEventSeq: 1, contextSnapshot: { issueId },
      runnerProfileJson: { sessionCheckpoint: { identity: { runId }, activeTurnId: null,
        terminal: { turnTerminalState: options.turnCompleted === false ? "interrupted" : "completed" } } } });
    // The controller that closed the session and held the in-process gate.
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure", attempt: 2,
      leaseOwner: null, failureCode: "native_session_cleanup_quarantined", recoveryState: "blocked", controllerGeneration: 2,
      ...(options.controllerAlive
        ? { controllerBootId: currentControllerBootId(), controllerPid: process.pid, controllerHostHash: currentProcessSpaceHash(),
          controllerProcessStartedAt: new Date(Date.now() - process.uptime() * 1_000) }
        : { controllerBootId: options.controllerBootId ?? randomUUID(), controllerPid: await exitedPid(),
          controllerHostHash: options.hostHashUnrecorded ? null : currentProcessSpaceHash(),
          controllerProcessStartedAt: new Date(finishedAt.getTime() - 20 * 60_000) }) });
    const noReplay = { runId, policy: "preserve_without_replay_v1", replay: "blocked",
      recordedAt: finishedAt.toISOString(), actionOutcome: "unknown" };
    const [quarantineHold] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", status: "resolved", outcome: "blocked", ownerType: "board", returnOwnerAgentId: agentId,
      cause: "native_session_cleanup_quarantined", fingerprint: randomUUID().replaceAll("-", ""), attemptCount: 1, maxAttempts: 3,
      nextAction: "Workspace repair required. Verify safe staging or repair before continuing.", resolvedAt: finishedAt,
      evidence: { runId, recoveryMode: "exact_checkpoint_resume", automaticRecovery: noReplay,
        sourceFailureCode: "native_session_cleanup_quarantined", coordinatorAttempt: 2,
        nativeFailureBlock: { runId, statusVersion: 6 }, recoveryDisposition: "native_session_cleanup_quarantined",
        providerSessionEstablished: true } }).returning();
    // The workspace recovery receipt: the saved files and their finalize step.
    const [saved] = await db.insert(workspaceOperations).values({ companyId, issueId, heartbeatRunId: runId,
      phase: "workspace_recovery", status: options.filesSaved === false ? "running" : "succeeded", metadata: {} }).returning();
    const preservationOperationIds = [saved!.id];
    const [filesHold] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", status: "resolved", outcome: "blocked", ownerType: "system",
      cause: "native_continuation_requires_reconciliation", fingerprint: `native-workspace:${runId}`, attemptCount: 1,
      nextAction: "The original sandbox is retained for workspace repair.", resolvedAt: finishedAt,
      evidence: { runId, automaticRecovery: noReplay,
        systemRecovery: { schema: "paperclip.system-recovery.v1", policyVersion: 1, phase: "reconcile_effects", state: "complete",
          sourceRunId: runId, attempts: 1, retriesUsed: 0, revision: 4, failure: null, intentId: null, deadlineAt: null,
          nextAttemptAt: null, firstFailureAt: null, freshAttemptRunId: null, providerCooldownAt: null,
          attemptId: randomUUID(), generationId: randomUUID(), preservationOperationIds },
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId, stage: "saving_receipts", status: "recovered",
          attempt: 1, retryable: true, requestIds: [], attemptLimit: 6 },
        originalFailureCode: "native_session_cleanup_quarantined", continuationDelivery: "invalidated",
        workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] },
        historicalWorkspaceSource: { schema: "paperclip.historical-workspace-source.v1", runId, leaseIds: [leaseId] },
        previousWorkspaceRecovery: null } }).returning();
    await db.update(workspaceOperations).set({ metadata: { recoveryActionId: filesHold!.id } })
      .where(eq(workspaceOperations.id, saved!.id));
    await db.insert(workspaceOperations).values({ companyId, issueId, heartbeatRunId: runId, phase: "workspace_finalize",
      status: "succeeded", metadata: { owningService: "workspace_recovery", preservationOperationIds } });
    return { issueId, runId, quarantineHoldId: quarantineHold!.id, filesHoldId: filesHold!.id };
  }

  const hold = async (id: string) => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!;
  const pass = async () => (await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: true }))
    .kinds.find(entry => entry.kind === KIND);

  it("settles both no-replay holds once the controller that held the cleanup gate is gone", async () => {
    const f = await quarantinedRun();
    // As on staging: the files hold blocks the task with no Retry and no continuation.
    expect(await getExecutionBlocker(db, companyId, f.issueId)).toMatchObject({ recoveryActionId: f.filesHoldId,
      canRetry: false, canContinue: false });

    expect(await pass()).toMatchObject({ inProgress: 1, settled: 1 });
    for (const id of [f.quarantineHoldId, f.filesHoldId]) {
      const settled = await hold(id);
      expect(settled).toMatchObject({ status: "resolved", outcome: "restored", ownerType: "system" });
      expect(settled.evidence.automaticRecovery).toBeUndefined();
      expect(settled.evidence.completedTurnCleanupSettlement).toMatchObject({ runId: f.runId });
    }
    expect(await getExecutionBlocker(db, companyId, f.issueId)).toBeNull();
    // Settling replays nothing: no new run, and the task keeps its own wait.
    expect((await db.select().from(heartbeatRuns)).map(run => run.id)).toEqual([f.runId]);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ status: "blocked" });
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.recovery_action_resolved"))).toHaveLength(1);
    // Bounded: nothing is left to list.
    expect(await pass()).toMatchObject({ inProgress: 0 });
  }, 60_000);

  it("proves a controller saved before its PID space was recorded gone through its stopped server boot", async () => {
    const bootId = randomUUID();
    await db.insert(controllerInstances).values({ bootId, processSpace: "old-container", pid: 7,
      leaseExpiresAt: new Date(Date.now() - 5 * 60_000), stoppedAt: new Date(Date.now() - 4 * 60_000) });
    registerControllerInstanceDb(db);
    try {
      const f = await quarantinedRun({ controllerBootId: bootId, hostHashUnrecorded: true });
      expect(await pass()).toMatchObject({ inProgress: 1, settled: 1 });
      expect(await hold(f.quarantineHoldId)).toMatchObject({ outcome: "restored" });
      expect(await getExecutionBlocker(db, companyId, f.issueId)).toBeNull();
    } finally {
      resetControllerInstanceLeaseForTests();
      await db.delete(controllerInstances);
    }
  }, 60_000);

  it("keeps the holds while the controller that may still hold the gate is alive", async () => {
    const f = await quarantinedRun({ controllerAlive: true });
    expect(await pass()).toMatchObject({ inProgress: 1, settled: 0 });
    expect(await hold(f.quarantineHoldId)).toMatchObject({ outcome: "blocked" });
    expect((await hold(f.filesHoldId)).evidence.automaticRecovery).toMatchObject({ replay: "blocked" });
  }, 60_000);

  it("keeps a hold whose files are not saved yet, and settles the run's other hold", async () => {
    const f = await quarantinedRun({ filesSaved: false });
    expect(await pass()).toMatchObject({ settled: 1 });
    expect(await hold(f.quarantineHoldId)).toMatchObject({ outcome: "restored" });
    expect(await hold(f.filesHoldId)).toMatchObject({ outcome: "blocked" });
    expect(await getExecutionBlocker(db, companyId, f.issueId)).toMatchObject({ recoveryActionId: f.filesHoldId });
  }, 60_000);

  it("never settles the holds of a run whose turn did not complete", async () => {
    const f = await quarantinedRun({ turnCompleted: false });
    expect(await pass()).toMatchObject({ inProgress: 0 });
    expect(await hold(f.quarantineHoldId)).toMatchObject({ outcome: "blocked" });
  }, 60_000);
});
