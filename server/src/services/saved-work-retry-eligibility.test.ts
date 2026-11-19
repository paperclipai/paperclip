import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, environmentLeases, executionWorkspaces,
  executionWorkspaceSnapshots, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues,
  workspaceOperations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { requestTaskRetry } from "./task-retry.js";
import { heartbeatService } from "./heartbeat.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { taskInterruptionPresentation } from "./task-interruption-presentation.js";
import { REMOTE_WORKSPACE_ABANDONED_EPOCH_SCHEMA } from "./remote-workspace-epoch-abandonment.js";

const logs = vi.hoisted(() => ({ content: new Map<string, string>() }));
vi.mock("./run-log-store.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./run-log-store.js")>();
  return { ...actual, getRunLogStore: () => ({ ...actual.getRunLogStore(),
    read: async (handle: { logRef: string }) => {
      const content = logs.content.get(handle.logRef);
      if (content === undefined) throw new Error("Object log not found");
      return { content };
    } }) };
});

describe("Retry of a task whose saved work recovery settled", () => {
  let postgres: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    postgres = await startEmbeddedPostgresTestDatabase("saved-work-retry-");
    db = createDb(postgres.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await postgres?.cleanup(); });
  beforeEach(() => { logs.content.clear(); });

  const actorId = "board";
  const terminated = (companyId: string, runId: string, leaseId: string, providerLeaseId: string, at: Date) => ({
    pendingCleanupInFlight: false, remoteExecutionTermination: { schema: "paperclip.remote-termination.v1",
      companyId, runId, leaseId, provider: "daytona", providerLeaseId, state: "destroyed", confirmedAt: at.toISOString() } });

  async function base(prefix: string) {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), workspaceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: prefix, issuePrefix: `${prefix}${companyId.slice(0, 5)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codie", adapterType: "paperclip_runner", status: "idle",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue the task", status: "blocked", assigneeAgentId: agentId });
    return { companyId, issueId, agentId, workspaceId };
  }

  async function sourceUnavailable() {
    const f = await base("SU");
    const { companyId, issueId, agentId, workspaceId } = f;
    const firstId = randomUUID(), preparedId = randomUUID(), heldId = randomUUID(), actionId = randomUUID();
    const leaseId = randomUUID(), providerLeaseId = randomUUID(), snapshotId = randomUUID(), now = Date.now();
    const remoteCwd = "/home/daytona/paperclip-workspace";
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "Task workspace", providerType: "cloud_sandbox",
      metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1", epoch: 9, dirty: false, source: { kind: "empty" },
        location: null, snapshotId, writerRunId: null },
      remoteWorkspaceAbandonedEpochs: [{ schema: REMOTE_WORKSPACE_ABANDONED_EPOCH_SCHEMA, runId: preparedId, epoch: 8,
        location: { leaseId, providerLeaseId, remoteCwd, environmentId: randomUUID() }, snapshotId,
        abandonedAt: new Date(now - 500_000).toISOString(), providerRef: remoteCwd }] } });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
    await db.insert(heartbeatRuns).values({ id: firstId, companyId, agentId, issueId, status: "failed", runtimeMode: "legacy",
      errorCode: "process_lost", executionStage: "preparing", invocationSource: "automation",
      createdAt: new Date(now - 900_000), startedAt: new Date(now - 880_000), finishedAt: new Date(now - 800_000),
      contextSnapshot: { issueId }, runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      resultJson: { stopReason: "process_lost", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    const scheduledRetryAt = new Date(now - 780_000), outputAt = new Date(now - 700_000);
    const lines = ["[paperclip] Execution workspace reuse freshness action \"replace\" because execution workspace configuration changed: repo/base ref, environment.\n",
      `[paperclip] Skipping saved session resume for task "${issueId}" because effective run configuration changed: environment.\n`];
    const attemptId = randomUUID();
    const content = lines.map((chunk, index) => JSON.stringify({ ts: (index ? outputAt : new Date(outputAt.getTime() - 5)).toISOString(),
      attemptId, stream: "stdout", chunk, seq: index + 1 }) + "\n").join("");
    const logRef = `${companyId}/${agentId}/${preparedId}`;
    logs.content.set(logRef, content);
    const error = "input.provider.profile does not match the qualified ACPX v1 profile";
    await db.insert(heartbeatRuns).values({ id: preparedId, companyId, agentId, issueId, status: "failed", runtimeMode: "legacy",
      errorCode: "adapter_failed", error, executionStage: "preparing", invocationSource: "automation", retryOfRunId: firstId,
      createdAt: new Date(now - 790_000), startedAt: new Date(now - 760_000), finishedAt: new Date(now - 690_000),
      scheduledRetryAt, scheduledRetryAttempt: 1, scheduledRetryReason: "transient_failure",
      controllerBootId: randomUUID(), logStore: "s3_segments", logRef, logBytes: Buffer.byteLength(content),
      logSha256: createHash("sha256").update(content).digest("hex"), logCompressed: false, stdoutExcerpt: lines.join(""),
      stderrExcerpt: "", lastOutputAt: outputAt, lastOutputSeq: 2, lastOutputStream: "stdout", lastOutputBytes: Buffer.byteLength(content),
      usageJson: { ledgerScope: { issueId, projectId: null, billingCode: null } },
      contextSnapshot: { issueId, retryOfRunId: firstId, wakeReason: "transient_failure_retry", retryReason: "transient_failure",
        scheduledRetryAt: scheduledRetryAt.toISOString(), scheduledRetryAttempt: 1 },
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" },
        remoteWorkspace: { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId, providerLeaseId, remoteCwd,
          epoch: 8, state: "prepared", snapshotId },
        chatControlRecoveryAdmission: { phase: "required", runId: preparedId, agentId, issueId, version: 1, companyId } },
      resultJson: { stopReason: "adapter_failed", failureCause: "native_execution_input_invalid", timeoutFired: false,
        timeoutSource: "config", executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, timeoutConfigured: false,
        effectiveTimeoutSec: 0, systemRecoveryAdoption: { actionId, policyVersion: 1 }, workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] } } });
    const event = { companyId, agentId, runId: preparedId, stream: "system" };
    await db.insert(heartbeatRunEvents).values([
      { ...event, seq: 1, eventType: "lifecycle", level: "info", message: "Scheduled retry became due and was promoted to the queued run pool",
        payload: { scheduledRetryAt: scheduledRetryAt.toISOString(), scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 1 } },
      { ...event, seq: 2, eventType: "lifecycle", level: "info", message: "run started" },
      { ...event, seq: 3, eventType: "error", level: "error", message: error },
      { ...event, seq: 4, eventType: "lifecycle", level: "info", message: "task.run.measured",
        payload: { phase: "task.run.measured", outcome: "failed", durationMs: 318_581, durableSettlement: true } },
    ]);
    const releasedAt = new Date(now - 650_000);
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, heartbeatRunId: preparedId,
      executionWorkspaceId: workspaceId, provider: "daytona", providerLeaseId, status: "expired",
      leasePolicy: "reuse_by_environment", releasedAt, cleanupStatus: "success",
      metadata: terminated(companyId, preparedId, leaseId, providerLeaseId, releasedAt) });
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: preparedId,
      status: "resolved", outcome: "blocked",
      nextAction: "Automatic recovery of saved work failed (last failure: source_unavailable). Retry to try again; the agent will not repeat its work.",
      evidence: { runId: preparedId,
        systemRecovery: { schema: "paperclip.system-recovery.v1", policyVersion: 1, capturePolicyVersion: 2, phase: "verify_execution",
          state: "exhausted", failure: { code: "source_unavailable", retryClass: "use_alternative_strategy", evidenceFingerprint: "a".repeat(64) },
          attempts: 1, intentId: null, revision: 1, attemptId: randomUUID(), deadlineAt: now + 600_000, retriesUsed: 0,
          sourceRunId: preparedId, generationId: randomUUID(), nextAttemptAt: null, firstFailureAt: now - 600_000,
          freshAttemptRunId: null, providerCooldownAt: null, preservationOperationIds: [] },
        automaticRecovery: { runId: preparedId, policy: "preserve_without_replay_v1", replay: "blocked",
          recordedAt: new Date(now - 680_000).toISOString(), actionOutcome: "unknown" },
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: preparedId, stage: "verifying_stop", status: "blocked",
          attempt: 1, attemptLimit: 6, retryable: true, requestIds: [],
          message: "Automatic recovery of saved work failed (last failure: source_unavailable). Retry to try again; the agent will not repeat its work." },
        originalFailureCode: "adapter_failed", continuationDelivery: "invalidated",
        workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] },
        historicalWorkspaceSource: { schema: "paperclip.historical-workspace-source.v1", runId: preparedId, leaseIds: [leaseId] },
        previousWorkspaceRecovery: null } });
    await db.insert(heartbeatRuns).values({ id: heldId, companyId, agentId, issueId, status: "cancelled", runtimeMode: "legacy",
      errorCode: "execution_reconciliation_required", error: "Recovering saved work…", invocationSource: "automation",
      triggerDetail: "system", retryOfRunId: preparedId, createdAt: new Date(now - 680_000), finishedAt: new Date(now - 600_000),
      contextSnapshot: { issueId, taskId: issueId, source: "issue.continuation_recovery", wakeReason: "issue_continuation_needed",
        retryOfRunId: preparedId },
      resultJson: { stopReason: "execution_reconciliation_required", timeoutFired: false,
        executionWait: { issueId, recoveryActionId: actionId }, timeoutSource: "stale_queued_run_gate",
        timeoutConfigured: false, effectiveTimeoutSec: 0 } });
    return { ...f, preparedId, heldId, actionId };
  }

  async function restoredSnapshot() {
    const f = await base("RS");
    const { companyId, issueId, agentId, workspaceId } = f;
    const earlierId = randomUUID(), sourceId = randomUUID(), actionId = randomUUID(), leaseId = randomUUID();
    const providerLeaseId = randomUUID(), snapshotId = randomUUID(), now = Date.now(), sha256 = "c".repeat(64);
    const remoteCwd = `/home/daytona/paperclip-workspace/.paperclip-workspaces/${workspaceId}-1-${leaseId}`;
    const location = { leaseId, providerLeaseId, remoteCwd, environmentId: randomUUID() };
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "Task workspace", providerType: "cloud_sandbox",
      metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1", epoch: 3, dirty: false, source: { kind: "empty" },
        location, snapshotId, writerRunId: null } } });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
    await db.insert(heartbeatRuns).values({ id: earlierId, companyId, agentId, issueId, status: "succeeded", runtimeMode: "native",
      createdAt: new Date(now - 7_200_000), startedAt: new Date(now - 7_100_000), finishedAt: new Date(now - 7_000_000),
      contextSnapshot: { issueId } });
    const [earlierSave] = await db.insert(workspaceOperations).values({ companyId, executionWorkspaceId: workspaceId,
      heartbeatRunId: earlierId, issueId, phase: "remote_workspace_snapshot", status: "succeeded",
      metadata: { boundary: "final", epoch: 3, snapshotId } }).returning();
    await db.insert(executionWorkspaceSnapshots).values({ id: snapshotId, companyId, executionWorkspaceId: workspaceId,
      sourceOperationId: earlierSave.id, sourceRunId: earlierId, generation: 3, epoch: 3, status: "committed",
      objectKey: `${companyId}/workspace-snapshots/${workspaceId}/${snapshotId}/archive`, sha256, byteSize: 48_507_938,
      key: { kind: "fixture" }, manifestDigest: "d".repeat(64) });
    const error = "Request failed with status code 502";
    await db.insert(heartbeatRuns).values({ id: sourceId, companyId, agentId, issueId, status: "failed", runtimeMode: "legacy",
      errorCode: "setup_failed", error, executionStage: "preparing", createdAt: new Date(now - 300_000),
      startedAt: new Date(now - 280_000), finishedAt: new Date(now - 220_000), controllerBootId: randomUUID(),
      usageJson: { ledgerScope: { issueId, projectId: null, billingCode: null } },
      contextSnapshot: { issueId, wakeReason: "task_retry" },
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" },
        remoteWorkspace: { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId, providerLeaseId, remoteCwd,
          epoch: 3, state: "saved", snapshotId } },
      resultJson: { stopReason: "adapter_failed", failureCause: "JsonRpcCallError", timeoutFired: false, timeoutSource: "config",
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, timeoutConfigured: false, effectiveTimeoutSec: 0,
        systemRecoveryAdoption: { actionId, policyVersion: 1 }, workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] } } });
    const event = { companyId, agentId, runId: sourceId, stream: "system" };
    await db.insert(heartbeatRunEvents).values([
      { ...event, seq: 1, eventType: "error", level: "error", message: error },
      { ...event, seq: 2, eventType: "lifecycle", level: "info", message: "task.run.measured",
        payload: { phase: "task.run.measured", outcome: "failed", durationMs: 61_906, durableSettlement: true } },
    ]);
    const releasedAt = new Date(now - 200_000);
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, heartbeatRunId: sourceId,
      executionWorkspaceId: workspaceId, provider: "daytona", providerLeaseId, status: "expired",
      leasePolicy: "reuse_by_environment", releasedAt, cleanupStatus: "success",
      metadata: terminated(companyId, sourceId, leaseId, providerLeaseId, releasedAt) });
    await db.insert(workspaceOperations).values({ companyId, executionWorkspaceId: workspaceId, heartbeatRunId: sourceId, issueId,
      phase: "remote_workspace_restore", status: "succeeded", metadata: { epoch: 3, snapshotId,
        exportCleanup: { state: "cleaned", leaseId, providerLeaseId, remoteCwd, lastError: null,
          stagingRoot: "/home/daytona/paperclip-workspace/.paperclip-workspaces", environmentId: location.environmentId } } });
    const [recovered] = await db.insert(workspaceOperations).values({ companyId, executionWorkspaceId: workspaceId,
      heartbeatRunId: sourceId, issueId, phase: "workspace_recovery", status: "succeeded",
      metadata: { epoch: 3, sha256, leaseId, storage: "remote_workspace", generation: 3, snapshotId, providerLeaseId,
        recoveryActionId: actionId } }).returning();
    await db.insert(workspaceOperations).values({ companyId, heartbeatRunId: sourceId, issueId, phase: "workspace_finalize",
      status: "succeeded", metadata: { owningService: "workspace_recovery", preservationOperationIds: [recovered.id] } });
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: sourceId,
      status: "resolved", outcome: "blocked", nextAction: "Saved work recovered.",
      evidence: { runId: sourceId,
        systemRecovery: { schema: "paperclip.system-recovery.v1", policyVersion: 1, capturePolicyVersion: 2, phase: "reconcile_effects",
          state: "complete", failure: null, attempts: 1, intentId: null, revision: 3, attemptId: randomUUID(), deadlineAt: null,
          retriesUsed: 0, sourceRunId: sourceId, generationId: randomUUID(), nextAttemptAt: null, firstFailureAt: null,
          freshAttemptRunId: null, providerCooldownAt: null, preservationOperationIds: [recovered.id] },
        automaticRecovery: { runId: sourceId, policy: "preserve_without_replay_v1", replay: "blocked",
          recordedAt: new Date(now - 210_000).toISOString(), actionOutcome: "unknown" },
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: sourceId, stage: "saving_receipts", status: "recovered",
          attempt: 1, attemptLimit: 6, retryable: true, requestIds: [] },
        originalFailureCode: "setup_failed", continuationDelivery: "invalidated", workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] },
        historicalWorkspaceSource: { schema: "paperclip.historical-workspace-source.v1", runId: sourceId, leaseIds: [leaseId] },
        previousWorkspaceRecovery: null } });
    return { ...f, sourceId, actionId, snapshotId };
  }

  async function retry(f: { companyId: string; issueId: string }, observedRunId: string) {
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId,
      observedRunId, idempotencyKey: randomUUID(), actorSource: "local_implicit" });
    expect(receipt).toMatchObject({ accepted: true });
    await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId!);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
    return wake;
  }

  async function issue(issueId: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    return row;
  }

  it("offers the same Retry in the task view and the blocker when saved work is no longer available", async () => {
    const f = await sourceUnavailable();
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    const interruption = await taskInterruptionPresentation(db, await issue(f.issueId));
    expect(blocker?.workspaceRecovery).toMatchObject({ status: "blocked", canRetry: true });
    expect(blocker?.canRetry).toBe(true);
    expect(interruption?.canRetry).toBe(true);
  });

  it("offers no Retry in either view while saved-work recovery waits for an unconfirmed file copy to stop", async () => {
    const f = await sourceUnavailable();
    await db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({
      workspaceOwnerRecovery: { state: "operator_required", owner: { pid: 3, token: randomUUID(), hostname: "previous-host" } } })}::jsonb` })
      .where(eq(issueRecoveryActions.id, f.actionId));
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    const interruption = await taskInterruptionPresentation(db, await issue(f.issueId));
    expect(blocker).toMatchObject({ canRetry: false, workspaceRecovery: { status: "blocked", canRetry: false } });
    expect(interruption).toMatchObject({ canRetry: false, retryWait: { reason: "workspace_repair_required" } });
  });

  it("offers no Retry for a held Retry with the generic wait over a hold waiting for an unconfirmed file copy to stop", async () => {
    const f = await sourceUnavailable();
    await db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({
      workspaceOwnerRecovery: { state: "operator_required", owner: { pid: 3, token: randomUUID(), hostname: "previous-host" } } })}::jsonb` })
      .where(eq(issueRecoveryActions.id, f.actionId));
    const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, f.companyId));
    const requestId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: requestId, companyId: f.companyId, agentId: agent.id, source: "on_demand",
      triggerDetail: "manual", reason: "task_retry", status: "deferred_issue_execution", requestedByActorType: "user",
      requestedByActorId: actorId, idempotencyKey: `task-retry:${randomUUID()}`,
      payload: { issueId: f.issueId, executionWait: { reason: "execution_recovery", message: "Waiting for execution recovery. Your message is saved." },
        taskRetry: { schema: "paperclip.task-retry.v1", generationId: requestId, sourceRunId: f.heldId, actorId,
          actorSource: "local_implicit", strategy: "evaluate" } } });
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    const interruption = await taskInterruptionPresentation(db, await issue(f.issueId));
    expect(blocker?.canRetry).toBe(false);
    expect(interruption).toMatchObject({ canRetry: false, retryWait: { reason: "execution_recovery" } });
  });

  it("continues in a fresh session from the recorded work when saved work is no longer available", async () => {
    const f = await sourceUnavailable();
    const wake = await retry(f, f.heldId);
    expect(wake.payload?.executionWait).toBeUndefined();
    expect(wake).toMatchObject({ status: "coalesced", runId: expect.any(String) });
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    expect(["queued", "running"]).toContain(successor.status);
    expect(successor.contextSnapshot).toMatchObject({ taskRetryRequestId: wake.id });
  });

  it("verifies the repair of a restored snapshot that the failed preparation never changed", async () => {
    const f = await restoredSnapshot();
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    const interruption = await taskInterruptionPresentation(db, await issue(f.issueId));
    expect(blocker).toMatchObject({ workspaceRepairRequired: false, canRetry: true,
      workspaceRecovery: { status: "recovered" } });
    expect(interruption?.canRetry).toBe(true);
    const wake = await retry(f, f.sourceId);
    expect(wake).toMatchObject({ status: "coalesced", runId: expect.any(String) });
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    expect(["queued", "running"]).toContain(successor.status);
  });

  it("keeps the repair unverified when the failed preparation may have changed the restored snapshot", async () => {
    const f = await restoredSnapshot();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceId));
    await db.update(heartbeatRuns).set({ resultJson: { ...run.resultJson,
      executionRecovery: { kind: "bootstrap", providerWorkStarted: true } } }).where(eq(heartbeatRuns.id, f.sourceId));
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ workspaceRepairRequired: true, canRetry: false });
    expect(await taskInterruptionPresentation(db, await issue(f.issueId))).toMatchObject({ canRetry: false });
  });

  it("names a refusal that another click cannot change and offers no Retry for it in either view", async () => {
    const f = await restoredSnapshot();
    await db.update(workspaceOperations).set({ status: "failed" }).where(and(eq(workspaceOperations.heartbeatRunId, f.sourceId),
      eq(workspaceOperations.phase, "remote_workspace_restore")));
    await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence},
      '{workspaceRecovery,status}', '"blocked"')` }).where(eq(issueRecoveryActions.id, f.actionId));
    const wake = await retry(f, f.sourceId);
    expect(wake).toMatchObject({ status: "deferred_issue_execution", runId: null,
      payload: { executionWait: { reason: "previous_execution_unverified" } } });
    const interruption = await taskInterruptionPresentation(db, await issue(f.issueId));
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(interruption).toMatchObject({ canRetry: false, retryWait: { reason: "previous_execution_unverified" } });
    expect(blocker?.canRetry).toBe(false);
  });

  it("names the admission refusal of a held Retry and offers Retry only when admission would take it", async () => {
    const f = await restoredSnapshot();
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 3_600_000) })
      .where(eq(heartbeatRuns.id, f.sourceId));
    const wake = await retry(f, f.sourceId);
    expect(wake).toMatchObject({ status: "deferred_issue_execution", runId: null });
    const reason = (wake.payload?.executionWait as { reason?: string } | undefined)?.reason;
    expect(reason).toBeTruthy();
    expect(reason).not.toBe("execution_recovery");
    const interruption = await taskInterruptionPresentation(db, await issue(f.issueId));
    expect(interruption?.retryWait?.reason).toBe(reason);
    expect(interruption?.retryWait?.message).not.toMatch(/execution checks/);
  });
});
