import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  authUsers,
  companyMemberships,
  companies,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { currentProcessSpaceHash } from "../services/controller-process-identity.js";
import { heartbeatService } from "../services/heartbeat.js";
import { settleHeldInterruptedPreparation } from "../services/interrupted-preparation-hold-settlement.js";
import { isAbandonedPreparedRemoteWorkspace } from "../services/remote-workspace-abandoned-preparation.js";
import { inspectWorkspaceRecoverySource } from "../services/workspace-recovery-source.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { requestTaskRetry } from "../services/task-retry.js";
import { legacyControllerBootId } from "../services/legacy-controller-lease.js";
import { createOwnershipReportState, runOwnershipReconciliationPass } from "../services/recovery/ownership-invariant-report.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const KIND = "legacy_interrupted_preparation_hold";

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
  return pid;
}

/**
 * The K2-during-preparation shape from Daytona warm wave w-20261108T142906-s9501
 * (t05, run c99b3a2e): a scheduled retry was 2 s into preparation when a
 * graceful shutdown interrupted it. The draining process recorded a
 * preserve-without-replay hold, because its own controller was still live and
 * the sandbox lease was still cleaning up. The lease was released with a
 * confirmed stop moments later and the next process booted, but nothing
 * re-judged the hold, so the task waited for a manual Retry.
 */
suite("held interrupted preparations on the shared ownership path", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "", agentId = "", environmentId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-interrupted-preparation-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID(); agentId = randomUUID(); environmentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "IPH",
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: "Sandbox", driver: "sandbox", status: "active",
      config: { provider: "fake" } });
    await db.insert(authUsers).values({ id: "local-board", name: "Local operator", email: "local-board@example.invalid",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "local-board", membershipRole: "owner" });
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(environmentLeases);
    await db.delete(executionWorkspaces);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
  });

  afterAll(async () => { await temporary?.cleanup(); });

  /** The draining controller, now exited, in this PID space. */
  async function deadController(overrides: Record<string, unknown> = {}) {
    const bootId = randomUUID();
    return { bootId, process: { bootId, pid: await exitedPid(), hostHash: currentProcessSpaceHash(),
      processStartedAt: new Date(Date.now() - 60_000).toISOString(), ...overrides } as Record<string, unknown> | null };
  }

  async function interruptedPreparation(options: { controller?: { bootId: string; process: Record<string, unknown> | null };
    leaseReleased?: boolean; holdEvidence?: Record<string, unknown>; run?: Partial<typeof heartbeatRuns.$inferInsert>;
    issueStatus?: string } = {}) {
    const issueId = randomUUID(), runId = randomUUID(), leaseId = randomUUID(), providerLeaseId = `sandbox-${leaseId}`;
    const finishedAt = new Date(Date.now() - 10_000);
    const controller = options.controller ?? await deadController();
    // Terminalization projected the task to blocked and kept a receipt so the
    // settle can restore exactly that projection.
    await db.insert(issues).values({ id: issueId, companyId, title: "Warm follow-up", status: options.issueStatus ?? "blocked",
      assigneeAgentId: agentId, statusVersion: 2 });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "automation",
      responsibleUserId: "local-board", issueId,
      status: "interrupted", errorCode: "server_shutdown_interrupted", runtimeMode: "legacy", executionStage: "preparing",
      startedAt: new Date(finishedAt.getTime() - 2_000), finishedAt, nextEventSeq: 1,
      controllerBootId: controller.bootId, controllerProcess: controller.process,
      scheduledRetryAttempt: 1, scheduledRetryReason: "transient_failure",
      contextSnapshot: { issueId },
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      resultJson: { stopReason: "interrupted", cancellation: { reason: "Server shutdown interrupted execution",
        source: "shutdown", expected: true, initiator: { type: "system" }, recordedAt: finishedAt.toISOString() } },
      ...options.run });
    const released = options.leaseReleased !== false;
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, issueId, heartbeatRunId: runId,
      status: released ? "released" : "pending_cleanup", cleanupStatus: released ? "success" : "failed",
      leasePolicy: "reuse_by_environment", provider: "fake", providerLeaseId,
      releasedAt: released ? new Date(finishedAt.getTime() + 2_000) : null,
      metadata: released ? { remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId, runId,
        leaseId, provider: "fake", providerLeaseId, state: "stopped", confirmedAt: finishedAt.toISOString() } } : {} });
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "execution_reconciliation", cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${runId}`, status: "resolved", outcome: "blocked", ownerType: "board",
      nextAction: "Inspect the stopped provider and recorded actions.", resolvedAt: finishedAt,
      evidence: { runId, automaticRecovery: { policy: "preserve_without_replay_v1", runId, replay: "blocked",
        actionOutcome: "unknown", recordedAt: finishedAt.toISOString() },
        nativeBootstrapFailureBlock: { runId, previousStatus: "in_progress", statusVersion: 2 },
        ...options.holdEvidence } }).returning();
    return { issueId, runId, holdId: hold!.id };
  }

  const hold = async (id: string) => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!;
  const pass = async () => (await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: true }))
    .kinds.find(entry => entry.kind === KIND);

  it("replays a preparation a restart interrupted once its controller is proven gone", async () => {
    // The heartbeat service registers the resume path that schedules the replay.
    heartbeatService(db);
    const f = await interruptedPreparation();
    expect(await pass()).toMatchObject({ inProgress: 1, settled: 1 });
    // The task is unblocked and an uncharged interrupted-preparation successor exists.
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ status: "in_progress" });
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.runId));
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ scheduledRetryReason: "interrupted_preparation" });
    const settled = await hold(f.holdId);
    expect(settled).toMatchObject({ status: "resolved", outcome: "false_positive" });
    expect(settled.evidence).toMatchObject({ automaticRecovery: { replay: "allowed" },
      bootstrapPreparationContinuation: "delivered", bootstrapPreparationSettledAt: expect.any(String) });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!.resultJson)
      .toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
    const [audit] = await db.select().from(activityLog).where(and(eq(activityLog.runId, f.runId),
      eq(activityLog.action, "issue.recovery_action_resolved")));
    expect(audit?.details).toMatchObject({ reason: "native_bootstrap_stopped_before_provider", ownerProof: "pid_dead" });
  });

  it.each([
    ["provider work may have started", async () => {
      const f = await interruptedPreparation();
      await db.insert(heartbeatRunEvents).values({ companyId, runId: f.runId, agentId, seq: 1, eventType: "turn.started",
        stream: "system", level: "info", message: "turn started" });
      return f;
    }],
    ["its controller stamp is from another process space", async () =>
      interruptedPreparation({ controller: await deadController({ hostHash: "other-container" }) })],
    ["it has no controller stamp", async () =>
      interruptedPreparation({ controller: { bootId: randomUUID(), process: null } })],
    ["its controller is this process", async () => interruptedPreparation({ controller: { bootId: legacyControllerBootId,
      process: { bootId: legacyControllerBootId, pid: process.pid, hostHash: currentProcessSpaceHash(), processStartedAt: null } } })],
    ["its sandbox lease is still cleaning up", async () => interruptedPreparation({ leaseReleased: false })],
    ["an operator confirmed the owner gone on the hold", async () =>
      interruptedPreparation({ holdEvidence: { ownerGoneAttestation: { actorId: "board-user" } } })],
    ["the user already continued", async () =>
      interruptedPreparation({ holdEvidence: { explicitUserContinuation: { actorId: "board-user" } } })],
    ["it is a workspace-restore hold owned by restore recovery", async () =>
      interruptedPreparation({ holdEvidence: { workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [] } } })],
  ] as const)("keeps the hold when %s", async (_label, arrange) => {
    const f = await arrange();
    const before = await hold(f.holdId);
    expect((await pass())?.settled ?? 0).toBe(0);
    expect(await hold(f.holdId)).toEqual(before);
  });

  async function preparedRemoteWorkspace(runId: string, issueId: string, options: { receipt?: Record<string, unknown>;
    savedSnapshotId?: string | null; authority?: Record<string, unknown>; profile?: Record<string, unknown> } = {}) {
    const workspaceId = randomUUID(), leaseId = randomUUID(), providerLeaseId = `sandbox-${leaseId}`;
    const remoteCwd = `/home/daytona/paperclip-workspace/.paperclip-workspaces/${workspaceId}-1-${leaseId}`;
    const location = { environmentId, leaseId, providerLeaseId, remoteCwd };
    const source = { kind: "git", repoUrl: "https://github.com/paperclipai/paperclip.git", ref: "a".repeat(40),
      branchMode: "create", branchName: "IPH-1-change" };
    const authority = { schema: "paperclip.remote-workspace.v1", epoch: 2, source, location: null, dirty: false, writerRunId: null,
      snapshotId: options.savedSnapshotId ?? null, ...options.authority };
    const receipts = [{ schema: "paperclip.remote-workspace-abandoned-epoch.v1", epoch: 1, runId,
      snapshotId: options.savedSnapshotId ?? null, location, providerRef: remoteCwd, abandonedAt: new Date().toISOString(), ...options.receipt }];
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId, mode: "isolated_workspace",
      strategyType: "git_worktree", name: "Remote workspace", status: "active", providerType: "git_worktree",
      metadata: { remoteWorkspace: authority, remoteWorkspaceAbandonedEpochs: receipts } });
    await db.update(heartbeatRuns).set({ runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" },
      remoteWorkspace: { schema: "paperclip.remote-workspace-run.v1", state: "prepared", workspaceId, epoch: 1, leaseId,
        providerLeaseId, remoteCwd, snapshotId: null }, ...options.profile } }).where(eq(heartbeatRuns.id, runId));
    return { leaseId };
  }

  const runRow = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;

  it("replays a restore-recovery hold saved by an older build once the workspace retired the run's epoch", async () => {
    heartbeatService(db);
    const f = await interruptedPreparation();
    const { leaseId } = await preparedRemoteWorkspace(f.runId, f.issueId);
    const restore = { workspaceRestoreFailure: "restore_failed",
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] } };
    const run = await runRow(f.runId);
    await db.update(heartbeatRuns).set({ resultJson: { ...run.resultJson, ...restore } }).where(eq(heartbeatRuns.id, f.runId));
    const saved = await hold(f.holdId);
    await db.update(issueRecoveryActions).set({ evidence: { ...saved.evidence, ...restore,
      systemRecovery: { schema: "paperclip.system-recovery.v1", policyVersion: 1, state: "exhausted", phase: "verify_execution",
        sourceRunId: f.runId, attempts: 1, retriesUsed: 0, revision: 5, nextAttemptAt: null,
        failure: { code: "source_binding_invalid", retryClass: "service_required", sourceVerification: { reason: "workspace_reference_mismatch" } } } } })
      .where(eq(issueRecoveryActions.id, f.holdId));
    expect(await pass()).toMatchObject({ inProgress: 1, settled: 1 });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ status: "in_progress" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.runId))).toHaveLength(1);
  });

  function controllerLeaseLostRun(finishedAt = new Date(Date.now() - 10_000)): Partial<typeof heartbeatRuns.$inferInsert> {
    return { status: "failed", errorCode: "controller_lease_lost", error: "Legacy controller lease lost",
      scheduledRetryAttempt: 0, scheduledRetryReason: null,
      resultJson: { stopReason: "adapter_failed", timeoutFired: false,
        cancellation: { reason: "Legacy controller lease lost (renewal_deadline)", source: "controller_lease", expected: false,
          initiator: { type: "system" }, recordedAt: finishedAt.toISOString() },
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        controllerLeaseLoss: { cause: "renewal_deadline", renewalCount: 25, deadlineLateMs: 673, sinceRenewalMs: 36396,
          renewalPendingMs: 29436 } } };
  }

  async function leaseLostSavedFilesHold(options: { keepStatusReceipt: boolean }) {
    const f = await interruptedPreparation({ run: controllerLeaseLostRun() });
    const { leaseId } = await preparedRemoteWorkspace(f.runId, f.issueId);
    const restore = { workspaceRestoreFailure: "restore_failed",
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] } };
    const run = await runRow(f.runId);
    await db.update(heartbeatRuns).set({ resultJson: { ...run.resultJson, ...restore } }).where(eq(heartbeatRuns.id, f.runId));
    const saved = await hold(f.holdId);
    const { nativeBootstrapFailureBlock, ...staged } = saved.evidence;
    await db.update(issueRecoveryActions).set({ kind: "active_run_watchdog", evidence: { ...staged, ...restore,
      ...(options.keepStatusReceipt ? { nativeBootstrapFailureBlock } : {}),
      originalFailureCode: "controller_lease_lost", continuationDelivery: "invalidated",
      historicalWorkspaceSource: { schema: "paperclip.historical-workspace-source.v1", runId: f.runId, leaseIds: [leaseId] },
      workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: f.runId, status: "blocked", stage: "verifying_stop",
        attempt: 1, attemptLimit: 6, retryable: true, requestIds: [],
        message: "Automatic recovery of saved work failed (last failure: source_unavailable). Retry to try again; the agent will not repeat its work." },
      systemRecovery: { schema: "paperclip.system-recovery.v1", policyVersion: 1, capturePolicyVersion: 2, state: "exhausted",
        phase: "verify_execution", sourceRunId: f.runId, generationId: randomUUID(), attemptId: randomUUID(), intentId: null,
        attempts: 1, retriesUsed: 0, revision: 2, nextAttemptAt: null, providerCooldownAt: null, freshAttemptRunId: null,
        preservationOperationIds: [], failure: { code: "source_unavailable", retryClass: "use_alternative_strategy",
          evidenceFingerprint: "a".repeat(64) } } } })
      .where(eq(issueRecoveryActions.id, f.holdId));
    return f;
  }

  it("replays a preparation that lost its controller lease before provider work instead of holding it for reconciliation", async () => {
    heartbeatService(db);
    const f = await leaseLostSavedFilesHold({ keepStatusReceipt: true });
    await expect(inspectWorkspaceRecoverySource(db, { companyId, issueId: f.issueId, runId: f.runId, actionId: f.holdId }))
      .rejects.toMatchObject({ code: "source_unavailable", retryClass: "use_alternative_strategy" });
    expect(await pass()).toMatchObject({ inProgress: 1, settled: 1 });
    expect(await hold(f.holdId)).toMatchObject({ status: "resolved", outcome: "false_positive" });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ status: "in_progress" });
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.runId));
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ scheduledRetryReason: "interrupted_preparation" });
  });

  it("clears the saved-files gate of a lost-lease preparation that an older release blocked, so one Retry continues it", async () => {
    const heartbeat = heartbeatService(db);
    const f = await leaseLostSavedFilesHold({ keepStatusReceipt: false });
    expect(await getExecutionBlocker(db, companyId, f.issueId)).toMatchObject({ cause: "legacy_execution_requires_reconciliation" });
    expect(await pass()).toMatchObject({ inProgress: 1, settled: 1 });
    expect(await hold(f.holdId)).toMatchObject({ status: "resolved", outcome: "false_positive",
      evidence: expect.objectContaining({ bootstrapPreparationContinuation: "deferred" }) });
    expect(await getExecutionBlocker(db, companyId, f.issueId)).toBeNull();
    const receipt = await requestTaskRetry({ db, companyId, issueId: f.issueId, actorId: "local-board",
      actorSource: "local_implicit", idempotencyKey: randomUUID(), observedRunId: f.runId });
    expect(receipt).toMatchObject({ accepted: true });
    await heartbeat.resumeTaskRetry(companyId, receipt.requestId!);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
    expect(wake?.status).not.toBe("deferred_issue_execution");
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.issueId, f.issueId),
      inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry", "succeeded", "failed"]),
      ne(heartbeatRuns.id, f.runId)))).not.toHaveLength(0);
  }, 60_000);

  it.each([
    ["an in-progress continuation", "in_progress", { retryReason: "issue_continuation_needed", source: "issue.continuation_recovery" }, 2],
    ["a todo task that never reached checkout", "todo", {}, 12],
  ] as const)("bounds repeated lost leases before provider work for %s, then lets Retry continue", async (_label, status, firstContext, cap) => {
    const heartbeat = heartbeatService(db);
    const controller = await deadController();
    const issueId = randomUUID(), firstRunId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Lease loop", status,
      assigneeAgentId: agentId, statusVersion: 2 });
    const lostLease = (runId: string, context: Record<string, unknown>, retry: Partial<typeof heartbeatRuns.$inferInsert> = {}) => {
      const finishedAt = new Date(Date.now() - 30 * 60_000);
      return { ...controllerLeaseLostRun(finishedAt), id: runId, companyId, agentId, invocationSource: "automation",
        responsibleUserId: "local-board", issueId, runtimeMode: "legacy", executionStage: "preparing",
        startedAt: new Date(finishedAt.getTime() - 2_000), finishedAt, nextEventSeq: 1,
        controllerBootId: controller.bootId, controllerProcess: controller.process,
        runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
        contextSnapshot: { issueId, ...context }, ...retry } as typeof heartbeatRuns.$inferInsert;
    };
    await db.insert(heartbeatRuns).values(lostLease(firstRunId, { ...firstContext }));
    let latest: string = firstRunId;
    let successors = 0;
    for (let round = 0; round < 40; round += 1) {
      await heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId });
      const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
      if (task!.status === "blocked") break;
      expect(task!.status).toBe(status);
      const [next] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, latest));
      expect(next).toBeDefined();
      expect(next!.contextSnapshot).toMatchObject({ retryReason: "interrupted_preparation",
        executionRetryAccounting: { interruptedPreparations: successors + 1 } });
      successors += 1;
      const finished = lostLease(next!.id, next!.contextSnapshot ?? {}, {
        scheduledRetryAttempt: next!.scheduledRetryAttempt, scheduledRetryReason: next!.scheduledRetryReason,
        retryOfRunId: latest, wakeupRequestId: next!.wakeupRequestId });
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: finished.errorCode, error: finished.error,
        resultJson: finished.resultJson, startedAt: finished.startedAt, finishedAt: finished.finishedAt,
        executionStage: "preparing", controllerBootId: finished.controllerBootId, controllerProcess: finished.controllerProcess,
        runnerProfileJson: finished.runnerProfileJson }).where(eq(heartbeatRuns.id, next!.id));
      latest = next!.id;
    }
    expect(successors).toBe(cap);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "blocked" });
    const receipt = await requestTaskRetry({ db, companyId, issueId, actorId: "local-board",
      actorSource: "local_implicit", idempotencyKey: randomUUID(), observedRunId: latest });
    expect(receipt).toMatchObject({ accepted: true });
  }, 120_000);

  it.each([
    ["provider work started", { kind: "bootstrap", providerWorkStarted: true }],
    ["it has no no-provider-work certificate", undefined],
  ] as const)("keeps a lost-lease preparation held when %s", async (_label, executionRecovery) => {
    const f = await interruptedPreparation({ run: controllerLeaseLostRun() });
    const run = await runRow(f.runId);
    await db.update(heartbeatRuns).set({ resultJson: { ...run.resultJson, executionRecovery } })
      .where(eq(heartbeatRuns.id, f.runId));
    const before = await hold(f.holdId);
    expect((await pass())?.settled ?? 0).toBe(0);
    expect(await hold(f.holdId)).toEqual(before);
  });

  it("reports a retired prepared epoch to workspace recovery as an unavailable source, not a binding failure", async () => {
    const f = await interruptedPreparation();
    await preparedRemoteWorkspace(f.runId, f.issueId);
    await expect(inspectWorkspaceRecoverySource(db, { companyId, issueId: f.issueId, runId: f.runId, actionId: f.holdId }))
      .rejects.toMatchObject({ code: "source_unavailable", retryClass: "use_alternative_strategy" });
  });

  const proofCases: Array<[string, { authority?: Record<string, unknown>; profile?: Record<string, unknown>; writer?: boolean }, boolean]> = [
    ["the workspace is still at the run's epoch", { authority: { epoch: 1 } }, false],
    ["the run is still the workspace writer", { writer: true }, false],
    ["the run also has a native workspace sync reference", { profile: { nativeWorkspaceSync: { state: "prepared" } } }, false],
    ["the receipt matches the run's exact epoch and allocation", {}, true],
  ];
  it.each(proofCases)("treats the prepared workspace as retired only when proven: %s", async (_label, options, expected) => {
    const f = await interruptedPreparation();
    const authority = options.writer ? { writerRunId: f.runId } : options.authority;
    await preparedRemoteWorkspace(f.runId, f.issueId, { profile: options.profile, authority });
    expect(await isAbandonedPreparedRemoteWorkspace(db, await runRow(f.runId))).toBe(expected);
  });

  it.each([
    ["before its first save finished", null],
    ["after its first save committed", randomUUID()],
  ] as const)("replays a remote preparation whose unsaved epoch the workspace already retired %s", async (_label, savedSnapshotId) => {
    heartbeatService(db);
    const f = await interruptedPreparation();
    await preparedRemoteWorkspace(f.runId, f.issueId, { savedSnapshotId });
    expect(await pass()).toMatchObject({ inProgress: 1, settled: 1 });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ status: "in_progress" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.runId))).toHaveLength(1);
  });

  it.each([
    ["the retired epoch belongs to another run", { receipt: { runId: randomUUID() } }],
    ["the retired epoch was another allocation", { receipt: { location: { leaseId: randomUUID() } } }],
  ] as const)("keeps a remote preparation hold when %s", async (_label, options) => {
    const f = await interruptedPreparation();
    await preparedRemoteWorkspace(f.runId, f.issueId, options);
    const before = await hold(f.holdId);
    expect((await pass())?.settled ?? 0).toBe(0);
    expect(await hold(f.holdId)).toEqual(before);
  });

  it("settles exactly once when two processes judge the same hold", async () => {
    heartbeatService(db);
    const f = await interruptedPreparation();
    const record = { recordId: f.runId, companyId, runId: f.runId, issueId: f.issueId, owner: { kind: "none" as const },
      updatedAt: null };
    const context = { now: new Date(), proof: { verdict: "gone" as const, reason: "pid_dead" as const } };
    const outcomes = await Promise.all([settleHeldInterruptedPreparation(db, record, context),
      settleHeldInterruptedPreparation(db, record, context)]);
    expect(outcomes.filter(outcome => outcome.settled)).toHaveLength(1);
    const resolutions = await db.select().from(activityLog).where(and(eq(activityLog.runId, f.runId),
      eq(activityLog.action, "issue.recovery_action_resolved")));
    expect(resolutions).toHaveLength(1);
  });
});
