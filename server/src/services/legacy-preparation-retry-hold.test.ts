import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, environmentLeases, executionWorkspaces,
  heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { requestTaskRetry } from "./task-retry.js";
import { heartbeatService } from "./heartbeat.js";
import { getExecutionBlocker } from "./execution-blocker.js";

describe("Retry of a legacy preparation that automatic recovery stopped", () => {
  let postgres: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    postgres = await startEmbeddedPostgresTestDatabase("legacy-preparation-retry-");
    db = createDb(postgres.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await postgres?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID();
    const parentId = randomUUID(), sourceId = randomUUID(), actionId = randomUUID();
    const workspaceId = randomUUID(), leaseId = randomUUID(), providerLeaseId = randomUUID();
    const actorId = "board", now = Date.now(), error = "Worker process exited (code=null, signal=SIGKILL)";
    const controllerProcess = { pid: 3, bootId: randomUUID(), hostHash: "f".repeat(32), processStartedAt: new Date(now - 3_600_000).toISOString() };
    await db.insert(companies).values({ id: companyId, name: "Legacy preparation", issuePrefix: `L${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "idle",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Repair a failed run", status: "blocked", assigneeAgentId: agentId });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "Task workspace", providerType: "cloud_sandbox" });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
    await db.insert(heartbeatRuns).values({ id: parentId, companyId, agentId, issueId, status: "failed",
      runtimeMode: "legacy", errorCode: "environment_provider_unavailable", executionStage: "preparing",
      createdAt: new Date(now - 600_000), startedAt: new Date(now - 590_000), finishedAt: new Date(now - 400_000),
      contextSnapshot: { issueId }, runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      resultJson: { stopReason: "adapter_failed", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    const scheduledRetryAt = new Date(now - 300_000);
    const [source] = await db.insert(heartbeatRuns).values({ id: sourceId, companyId, agentId, issueId, status: "failed",
      runtimeMode: "legacy", errorCode: "setup_failed", error, executionStage: "preparing", invocationSource: "automation",
      createdAt: new Date(now - 360_000), startedAt: new Date(now - 250_000), finishedAt: new Date(now - 200_000),
      retryOfRunId: parentId, scheduledRetryAt, scheduledRetryAttempt: 2, scheduledRetryReason: "transient_failure",
      controllerBootId: controllerProcess.bootId, controllerProcess,
      usageJson: { ledgerScope: { issueId, projectId: null, billingCode: null } },
      contextSnapshot: { issueId, taskId: issueId, retryOfRunId: parentId, retryReason: "transient_failure",
        scheduledRetryAt: scheduledRetryAt.toISOString(), scheduledRetryAttempt: 2, wakeReason: "transient_failure_retry" },
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" },
        chatControlRecoveryAdmission: { phase: "required", runId: sourceId, agentId, issueId, version: 1, companyId } },
      resultJson: { stopReason: "adapter_failed", failureCause: "JsonRpcCallError", timeoutFired: false, timeoutSource: "config",
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, timeoutConfigured: false, effectiveTimeoutSec: 0 },
    }).returning();
    const event = { companyId, agentId, runId: sourceId, stream: "system" };
    await db.insert(heartbeatRunEvents).values([
      { ...event, seq: 1, eventType: "lifecycle", level: "info", createdAt: new Date(scheduledRetryAt.getTime() + 200),
        message: "Scheduled retry became due and was promoted to the queued run pool",
        payload: { scheduledRetryAt: scheduledRetryAt.toISOString(), scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 2 } },
      { ...event, seq: 2, eventType: "error", level: "error", message: error },
      { ...event, seq: 3, eventType: "lifecycle", level: "info", message: "task.run.measured",
        payload: { phase: "task.run.measured", outcome: "failed", durationMs: 141_150, durableSettlement: true } },
      { ...event, seq: 4, eventType: "lifecycle", level: "warn",
        message: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
        payload: { cause: "legacy_execution_requires_reconciliation", replay: "blocked", recoveryActionId: actionId,
          automaticRecovery: "preserve_without_replay_v1" } },
    ]);
    const releasedAt = new Date(now - 150_000);
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, heartbeatRunId: sourceId,
      executionWorkspaceId: workspaceId, provider: "daytona", providerLeaseId, status: "expired",
      leasePolicy: "reuse_by_environment", releasedAt, cleanupStatus: "success", failureReason: "pending_cleanup_retry",
      metadata: { pendingCleanupInFlight: false, remoteExecutionTermination: { schema: "paperclip.remote-termination.v1",
        companyId, runId: sourceId, leaseId, provider: "daytona", providerLeaseId, state: "destroyed",
        confirmedAt: releasedAt.toISOString() } } });
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: sourceId,
      status: "resolved", outcome: "blocked",
      nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
      evidence: { runId: sourceId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" });
    return { companyId, issueId, agentId, actorId, source, actionId, leaseId };
  }

  it("starts the person's Retry once the stopped preparation's sandbox is destroyed", async () => {
    const f = await seed();
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ cause: "legacy_execution_requires_reconciliation", canRetry: true });
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: f.actorId,
      observedRunId: f.source.id, idempotencyKey: randomUUID(), actorSource: "local_implicit" });
    expect(receipt).toMatchObject({ accepted: true });
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
    expect(wake.payload?.executionWait).toBeUndefined();
    expect(wake).toMatchObject({ status: "coalesced", runId: expect.any(String) });
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    expect(successor.status).toBe("queued");
    expect(successor.contextSnapshot).toMatchObject({ previousRunId: f.source.id, taskRetryRequestId: receipt.requestId });
  });

  it.each(["foreign_hold", "provider_event", "unstopped_lease", "unsaved_remote_workspace"] as const)(
    "keeps the Retry held when the stopped preparation is not proven: %s", async gate => {
      const f = await seed();
      if (gate === "foreign_hold") {
        const [other] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
          kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: randomUUID(),
          status: "resolved", outcome: "blocked", nextAction: "Other run.",
          evidence: { runId: randomUUID(), automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } }).returning();
        await db.update(heartbeatRunEvents).set({ payload: { cause: "legacy_execution_requires_reconciliation", replay: "blocked",
          recoveryActionId: other.id, automaticRecovery: "preserve_without_replay_v1" } })
          .where(and(eq(heartbeatRunEvents.runId, f.source.id), eq(heartbeatRunEvents.seq, 4)));
      }
      if (gate === "provider_event") await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId,
        runId: f.source.id, seq: 5, eventType: "tool.execution.started", stream: "system" });
      if (gate === "unstopped_lease") await db.update(environmentLeases).set({ metadata: { pendingCleanupInFlight: false } })
        .where(eq(environmentLeases.id, f.leaseId));
      if (gate === "unsaved_remote_workspace") await db.update(heartbeatRuns).set({ runnerProfileJson: {
        ...f.source.runnerProfileJson, remoteWorkspace: { schema: "paperclip.remote-workspace-run.v1", workspaceId: randomUUID(),
          leaseId: f.leaseId, providerLeaseId: randomUUID(), remoteCwd: "/fixture", epoch: 1, state: "prepared", snapshotId: null } } })
        .where(eq(heartbeatRuns.id, f.source.id));
      const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: f.actorId,
        observedRunId: f.source.id, idempotencyKey: randomUUID(), actorSource: "local_implicit" });
      await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId!);
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
      expect(wake).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        eq(heartbeatRuns.status, "queued")))).toHaveLength(0);
    });
});
