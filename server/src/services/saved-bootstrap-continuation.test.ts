import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, environmentLeases, executionWorkspaces,
  executionWorkspaceSnapshots, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues,
  workspaceOperations, nativeRunFinalizations, approvals, issueApprovals, issueComments } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { requestTaskRetry } from "./task-retry.js";
import { heartbeatService } from "./heartbeat.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import { createSystemRecovery } from "./system-recovery-state.js";
import { hasVerifiedWorkspaceRepair } from "./workspace-recovery-receipt.js";
import { isFailedNativePreparationRetryAncestor } from "./cancelled-native-startup.js";
import { withQueuedCommentIdsInWakePayload } from "./issue-queued-comment-queue.js";

const logs = vi.hoisted(() => new Map<string, string>());
vi.mock("./run-log-store.js", async importOriginal => {
  const original = await importOriginal<typeof import("./run-log-store.js")>();
  return { ...original, getRunLogStore: () => ({ ...original.getRunLogStore(),
    read: async (handle: { logRef: string }) => {
      const content = logs.get(handle.logRef);
      if (content === undefined) throw new Error("Fixture log missing");
      return { content };
    } }) };
});

describe("saved bootstrap continuation admission", () => {
  let postgres: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    postgres = await startEmbeddedPostgresTestDatabase("saved-bootstrap-");
    db = createDb(postgres.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await postgres?.cleanup(); });

  async function seed(hostLog: boolean, configured = false) {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID();
    const sourceId = randomUUID(), childId = randomUUID(), actionId = randomUUID();
    const workspaceId = randomUUID(), leaseId = randomUUID(), snapshotId = randomUUID();
    const snapshotOperationId = randomUUID(), recoveryOperationId = randomUUID();
    const providerLeaseId = randomUUID(), actorId = "board", now = Date.now();
    const sha256 = "a".repeat(64), error = "native_harness_storage_owner_missing";
    const startedAt = new Date(now - 60_000), finishedAt = new Date(now - 40_000);
    await db.insert(companies).values({ id: companyId, name: "Saved bootstrap", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner",
      status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Report the existing repair status",
      status: "todo", assigneeAgentId: agentId });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      mode: "isolated_workspace", strategyType: "isolated_workspace", name: "Recovered files",
      metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1", epoch: 1, snapshotId,
        source: { kind: "empty" }, location: null, writerRunId: null, dirty: false } } });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
    const restore = { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] };
    const chunk = "[paperclip] Enabled run-scoped skills from issue mentions: fixture/status-report\n";
    const log = JSON.stringify({ ts: startedAt.toISOString(), attemptId: randomUUID(), stream: "stdout", chunk, seq: 1 }) + "\n";
    logs.set(`${companyId}/${agentId}/${sourceId}`, log);
    const [source] = await db.insert(heartbeatRuns).values({ id: sourceId, companyId, issueId, agentId,
      status: "failed", runtimeMode: "legacy", errorCode: "adapter_failed", error, executionStage: "preparing",
      startedAt, finishedAt, createdAt: startedAt, controllerBootId: randomUUID(),
      sessionIdBefore: randomUUID(),
      contextSnapshot: { issueId, skillSelectionSnapshot: true, skillVersions: { "fixture/status-report": randomUUID(),
        ...(configured ? { "fixture/configured-skill": randomUUID() } : {}) } },
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" },
        remoteWorkspace: { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId, providerLeaseId,
          remoteCwd: "/fixture/saved-work", epoch: 1, state: "saved", snapshotId } },
      resultJson: { stopReason: "adapter_failed", executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: restore },
      ...(hostLog ? { logStore: "s3_segments", logRef: `${companyId}/${agentId}/${sourceId}`,
        logBytes: Buffer.byteLength(log), logSha256: createHash("sha256").update(log).digest("hex"),
        stdoutExcerpt: chunk, stderrExcerpt: "", lastOutputAt: startedAt, lastOutputSeq: 1,
        lastOutputStream: "stdout", lastOutputBytes: Buffer.byteLength(log) } : {}),
    }).returning();
    await db.insert(heartbeatRunEvents).values([
      { companyId, agentId, runId: sourceId, seq: 1, eventType: "lifecycle", level: "info", stream: "system", message: "run started" },
      { companyId, agentId, runId: sourceId, seq: 2, eventType: "error", level: "error", stream: "system", message: error },
      { companyId, agentId, runId: sourceId, seq: 3, eventType: "lifecycle", level: "info", stream: "system", message: "task.run.measured",
        payload: { phase: "task.run.measured", outcome: "failed", durationMs: 20_000, durableSettlement: true } },
    ]);
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, heartbeatRunId: sourceId,
      executionWorkspaceId: workspaceId, provider: "daytona", providerLeaseId, status: "released",
      cleanupStatus: "success", leasePolicy: "retain_on_failure", releasedAt: finishedAt,
      metadata: { remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId,
        runId: sourceId, leaseId, provider: "daytona", providerLeaseId, state: "stopped", confirmedAt: finishedAt.toISOString() } } });
    await db.insert(executionWorkspaceSnapshots).values({ id: snapshotId, companyId, executionWorkspaceId: workspaceId,
      sourceOperationId: snapshotOperationId, sourceRunId: sourceId, generation: 1, epoch: 1, status: "committed", sha256 });
    const scope = { companyId, issueId, heartbeatRunId: sourceId, executionWorkspaceId: workspaceId,
      status: "succeeded", finishedAt };
    await db.insert(workspaceOperations).values([
      { ...scope, id: snapshotOperationId, phase: "remote_workspace_snapshot", metadata: { snapshotId, sha256, epoch: 1, generation: 1 } },
      { ...scope, id: recoveryOperationId, phase: "workspace_recovery", metadata: { recoveryActionId: actionId,
        storage: "remote_workspace", leaseId, providerLeaseId, snapshotId, sha256, epoch: 1, generation: 1 } },
      { ...scope, phase: "workspace_finalize", metadata: { owningService: "workspace_recovery", preservationOperationIds: [recoveryOperationId] } },
    ]);
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: sourceId,
      status: "resolved", outcome: "blocked", nextAction: "Continue the saved request.",
      evidence: { runId: sourceId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" },
        workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: restore,
        systemRecovery: { ...createSystemRecovery(sourceId), state: "complete", phase: "reconcile_effects", attempts: 1,
          preservationOperationIds: [recoveryOperationId] }, continuationDelivery: "invalidated",
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: sourceId, status: "recovered",
          stage: "saving_receipts", attempt: 1, attemptLimit: 6, requestIds: [] } } });
    const [child] = await db.insert(heartbeatRuns).values({ id: childId, companyId, issueId, agentId,
      status: "failed", runtimeMode: "legacy", errorCode: "setup_failed", executionStage: "preparing",
      error: "The workspace still has an unfinished writer or save operation.", retryOfRunId: sourceId,
      startedAt: new Date(now - 30_000), finishedAt: new Date(now - 20_000), createdAt: new Date(now - 30_000),
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      resultJson: { stopReason: "adapter_failed", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { issueId, retryOfRunId: sourceId, retryReason: "native_session_interrupted" },
    }).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" });
    const [comment] = await db.insert(issueComments).values({ companyId, issueId,
      authorType: "user", authorUserId: actorId, body: "What is the latest status?", createdAt: new Date(now - 10_000) }).returning();
    const [savedQueue] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand",
      reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: actorId,
      payload: withQueuedCommentIdsInWakePayload({ issueId, executionWait: { reason: "execution_recovery" } }, [comment.id]) }).returning();
    expect(await hasVerifiedWorkspaceRepair(db, source)).toBe(true);
    return { source, child, companyId, issueId, agentId, actorId, leaseId, comment, savedQueue };
  }

  it.each([{ hostLog: false, configured: false }, { hostLog: true, configured: false }, { hostLog: true, configured: true }])(
    "dispatches one saved-status turn after a certified bootstrap with host log=$hostLog, configured=$configured", async ({ hostLog, configured }) => {
    const f = await seed(hostLog, configured);
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId,
      actorId: f.actorId, observedRunId: f.child.id, idempotencyKey: randomUUID(), actorSource: "local_implicit" });
    expect((await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: f.actorId,
      observedRunId: f.child.id, idempotencyKey: randomUUID(), actorSource: "local_implicit" })).requestId).toBe(receipt.requestId);
    const heartbeat = heartbeatService(db);
    await Promise.all([heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!), heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!)]);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
    const queued = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(queued, JSON.stringify(wake.payload)).toHaveLength(1);
    expect(wake).toMatchObject({ status: "coalesced", runId: queued[0].id });
    expect(queued[0].contextSnapshot?.wakeCommentIds).toContain(f.comment.id);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.savedQueue.id)))[0])
      .toMatchObject({ status: "coalesced", runId: queued[0].id });
    expect(await isFailedNativePreparationRetryAncestor(db, f.source, undefined)).toBe(true);
    await expect(buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      runId: queued[0].id, context: queued[0].contextSnapshot!, summary: null, exposeLowTrustRaw: false }))
      .resolves.toMatchObject({ interruptedRunId: f.child.id });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.source.id)))[0])
      .toMatchObject({ status: "failed", resultJson: f.source.resultJson });
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))[0].evidence.automaticRecovery)
      .toMatchObject({ actionOutcome: "unknown", replay: "explicit_user_continuation" });
  });

  it.each(["provider_started", "provider_event", "native_checkpoint", "missing_stop", "missing_selection",
    "changed_hash", "unknown_output", "pending_approval", "operator_stop"] as const)(
    "does not admit the host-log continuation after a late gate changes: %s", async gate => {
      const f = await seed(true);
      const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId,
        actorId: f.actorId, observedRunId: f.child.id, idempotencyKey: randomUUID(), actorSource: "local_implicit" });
      if (gate === "provider_started") await db.update(heartbeatRuns).set({ resultJson: { ...f.source.resultJson,
        executionRecovery: { kind: "bootstrap", providerWorkStarted: true } } }).where(eq(heartbeatRuns.id, f.source.id));
      if (gate === "provider_event") await db.insert(heartbeatRunEvents).values({ companyId: f.companyId,
        agentId: f.agentId, runId: f.source.id, seq: 4, eventType: "tool.execution.started" });
      if (gate === "native_checkpoint") {
        await db.update(heartbeatRuns).set({ nativeIssueId: f.issueId }).where(eq(heartbeatRuns.id, f.source.id));
        await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId,
          runId: f.source.id, phase: "running", attempt: 1, controllerGeneration: 1 });
      }
      if (gate === "missing_stop") await db.update(environmentLeases).set({ metadata: {} }).where(eq(environmentLeases.id, f.leaseId));
      if (gate === "missing_selection") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId } })
        .where(eq(heartbeatRuns.id, f.source.id));
      if (gate === "changed_hash") await db.update(heartbeatRuns).set({ logSha256: "b".repeat(64) }).where(eq(heartbeatRuns.id, f.source.id));
      if (gate === "unknown_output") {
        const record = JSON.parse(logs.get(f.source.logRef!)!);
        record.chunk = "Provider says it completed an external action\n";
        const content = JSON.stringify(record) + "\n";
        logs.set(f.source.logRef!, content);
        await db.update(heartbeatRuns).set({ stdoutExcerpt: record.chunk, logBytes: Buffer.byteLength(content),
          lastOutputBytes: Buffer.byteLength(content), logSha256: createHash("sha256").update(content).digest("hex") })
          .where(eq(heartbeatRuns.id, f.source.id));
      }
      if (gate === "pending_approval") {
        const [approval] = await db.insert(approvals).values({ companyId: f.companyId, type: "hire_agent", status: "pending", payload: {} }).returning();
        await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issueId, approvalId: approval.id });
      }
      if (gate === "operator_stop") await db.update(issues).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(issues.id, f.issueId));
      const heartbeat = heartbeatService(db);
      await Promise.all([heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!), heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!)]);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued"))))
        .toHaveLength(0);
    });
});
