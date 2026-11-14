import { executionWorkspaceService } from "./execution-workspaces.js";
import { readSystemRecovery, createSystemRecovery, failSystemRecovery, reserveSystemRecoveryAttempt, SystemRecoveryFailure } from "./system-recovery-state.js";
import { adoptSystemRecovery } from "./system-recovery.js";
import { requestTaskRetry } from "./task-retry.js";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { agents, environmentLeases, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, agentWakeupRequests, executionWorkspaces } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { recoverRetainedWorkspace, retainedWorkspaceCandidates } from "./workspace-recovery.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerWorkspaceRecoveryWork } from "./workspace-recovery-work.js";
import { heartbeatService } from "./heartbeat.js";
import { hasVerifiedWorkspaceRepair } from "./workspace-recovery-receipt.js";
import { claimNativeSessionResumptions } from "./native-runtime/native-finalization-reconciler.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { useWorkspaceRecoveryFixture, action, db, run, seed } from "./__tests__/workspace-recovery-fixture.js";
const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

describe("automatic retained workspace recovery", () => {
  useWorkspaceRecoveryFixture(targets);

  it("unblocks a pending workspace selection only after a superseded retry's real files are preserved", async () => {
    const f = await seed();
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    const source = await run(f.runId);
    await db.update(heartbeatRuns).set({ resultJson: null, nativePhase: "retryable_failure",
      startedAt: new Date(1), finishedAt: new Date(2) }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ phase: "retryable_failure", attempt: 1,
      recoveryState: "resuming_session", nextAttemptAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.runId));
    await db.update(environmentLeases).set({ status: "active", leasePolicy: "ephemeral",
      releasedAt: null, cleanupStatus: null, metadata: f.lease.metadata }).where(eq(environmentLeases.id, f.lease.id));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, runtimeMode: "native", status: "succeeded", nativePhase: "committed",
      startedAt: new Date(3), finishedAt: new Date(4), contextSnapshot: { previousRunId: f.runId, taskRetryRequestId: randomUUID() } });
    await db.insert(executionWorkspaces).values({ id: f.issueId, companyId: f.companyId, sourceIssueId: f.issueId,
      name: "Shared files", mode: "shared_workspace", strategyType: "project_primary", cwd: f.host });
    const actor = { type: "board" as const, source: "local_implicit" as const, isInstanceAdmin: true };
    const workspaces = executionWorkspaceService(db);
    await workspaces.selectTaskWorkspace({ companyId: f.companyId, issueId: f.issueId, actor,
      selection: { kind: "existing", workspaceId: f.issueId }, expectedBindingRevision: 0, requestKey: randomUUID() });
    const admission = { companyId: f.companyId, issueId: f.issueId, actor, runId: randomUUID() };
    await expect(workspaces.applyPendingTaskWorkspaceSelection(admission)).rejects.toThrow("Previous task run still owns workspace recovery");
    expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "recovery", runIds: [f.runId] })).toEqual([]);
    await expect(workspaces.applyPendingTaskWorkspaceSelection(admission)).rejects.toThrow("Previous task run still owns workspace recovery");
    const [preservation] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await recoverRetainedWorkspace({ ...f.input, actionId: preservation.id });
    expect(readSystemRecovery((await action(preservation.id)).evidence)?.state).toBe("complete");
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
    expect(await workspaces.applyPendingTaskWorkspaceSelection(admission)).toBe(true);
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task).toMatchObject({ status: "blocked", assigneeAgentId: source.agentId, executionWorkspaceId: f.issueId,
      workspacePendingSelection: null, executionWorkspaceSettings: { mode: "shared_workspace" } });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(2);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.companyId, f.companyId))).toHaveLength(0);
  }, 30_000);

  it.each(["HTTP Retry", "manual admission Retry", "new comment", "automatic cleanup"] as const)("repairs a retained failure through %s without admitting work before verified stop", async entry => {
    const f = await seed("native", true, "keep_running");
    const source = await run(f.runId);
    const manual = entry === "manual admission Retry";
    await db.update(heartbeatRuns).set({ resultJson: null,
      errorCode: manual ? "native_restart_recovery_blocked" : "execution_finalization_deadline_exceeded",
      ...(manual ? { processPid: 1386, nativePhase: "terminal_failure" } : {}) })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.update(environmentLeases).set({ status: "active", leasePolicy: "reuse_by_environment",
      releasedAt: null, cleanupStatus: null, metadata: f.lease.metadata }).where(eq(environmentLeases.id, f.lease.id));
    if (manual) {
      const systemRecovery = failSystemRecovery(reserveSystemRecoveryAttempt(createSystemRecovery(f.runId))!,
        new SystemRecoveryFailure("allocation_ownership_ambiguous", "user_action_required"));
      await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", resultId: null,
        failureCode: "native_restart_recovery_blocked", failureDetail: { recoveryMode: "exact_checkpoint_resume", systemRecovery } })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      await db.update(issues).set({ executionRunId: f.runId, checkoutRunId: f.runId }).where(eq(issues.id, f.issueId));
      await db.update(issueRecoveryActions).set({ status: "active", outcome: "blocked", cause: "native_restart_recovery_blocked",
        fingerprint: `native-restart:${f.runId}`, returnOwnerAgentId: source.agentId, wakePolicy: null, maxAttempts: 3,
        evidence: { runId: f.runId, automaticAdmissionExhausted: true, executorStopEvidence: "unverified",
          providerPid: 1386, checkpointPreserved: true },
        nextAction: "Automatic admission checks exhausted; original executor stop and state remain unverified" })
        .where(eq(issueRecoveryActions.id, f.actionId));
    } else {
      await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "blocked",
        cause: "execution_finalization_deadline_exceeded", evidence: { runId: f.runId, providerOwnership: "unverified",
          automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } }).where(eq(issueRecoveryActions.id, f.actionId));
    }
    // Leave admission observable without substituting a fake model turn.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
    let releaseStop!: () => void;
    const stopped = new Promise<void>(resolve => { releaseStop = resolve; });
    f.runtime.retryPendingSandboxTeardown.mockImplementation(async () => {
      await stopped;
      return { providerLeaseId: f.providerLeaseId, state: "stopped" };
    });
    const errors = vi.fn(), heartbeat = heartbeatService(db, { environmentRuntime: f.environmentRuntime });
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: errors });
    const worker = registerWorkspaceRecoveryWork(db, coordinator, f.environmentRuntime, heartbeat.resumeRemoteStopComments);
    const successors = () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    try {
      await worker.ready;
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "board" }; next(); });
      app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
      app.use(errorHandler);
      let requestId: string | undefined;
      let commentId: string | undefined;
      if (manual) expect((await request(app).get(`/api/issues/${f.issueId}`).expect(200)).body.interruption)
        .toMatchObject({ state: "failed", canRetry: true, observedRunId: f.runId });
      if (entry === "HTTP Retry" || manual) {
        const body = { idempotencyKey: randomUUID(), observedRunId: f.runId };
        const retry = await request(app).post(`/api/issues/${f.issueId}/retry`).send(body).expect(202);
        requestId = retry.body.requestId;
        expect((await request(app).post(`/api/issues/${f.issueId}/retry`).send(body).expect(202)).body.requestId).toBe(requestId);
      } else if (entry === "new comment") {
        const response = await request(app).post(`/api/issues/${f.issueId}/comments`)
          .send({ body: "Is this fixed?" }).expect(201);
        commentId = response.body.id;
        expect(await successors()).toHaveLength(0);
      } else {
        const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
          authorType: "user", authorUserId: "board", body: "Is this fixed?" }).returning();
        commentId = comment.id;
        const wake = { source: "automation" as const, triggerDetail: "system" as const,
          reason: "issue_reopened_via_comment", requestedByActorType: "user" as const, requestedByActorId: "board",
          payload: { issueId: f.issueId, commentId: comment.id, mutation: "comment" },
          contextSnapshot: { source: "issue.comment.reopen", issueId: f.issueId, wakeCommentId: comment.id },
        };
        await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: source.agentId,
          source: wake.source, triggerDetail: wake.triggerDetail, reason: wake.reason,
          requestedByActorType: "user", requestedByActorId: "board", status: "deferred_issue_execution",
          payload: { ...wake.payload, _paperclipWakeContext: { ...wake.contextSnapshot, wakeReason: wake.reason,
            wakeSource: wake.source, wakeTriggerDetail: wake.triggerDetail, wakeCommentIds: [comment.id] } },
        });
        expect(await successors()).toHaveLength(0);
        if (entry === "automatic cleanup") await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 0 });
      }
      await expect.poll(() => f.runtime.retryPendingSandboxTeardown.mock.calls.length, { timeout: 20_000 }).toBe(1);
      if (!manual) {
        if (requestId) await heartbeat.resumeTaskRetry(f.companyId, requestId);
        else await heartbeat.resumeQueuedRuns();
      }
      expect(await successors()).toHaveLength(0);
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0].metadata)
        .not.toHaveProperty("remoteExecutionTermination");
      if (manual) expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
        .toMatchObject({ executionRunId: f.runId, checkoutRunId: f.runId });
      await expect(readFile(path.join(f.host, "saved.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      releaseStop();
      await expect.poll(async () => (await successors()).length, { timeout: 20_000 }).toBe(1);
      const [successor] = await successors();
      if (commentId) expect(successor.contextSnapshot?.wakeCommentIds).toContain(commentId);
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
      expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
      if (requestId) expect(await readFreshWorkspaceReadiness(db, successor)).toMatchObject({ mode: "resume_preserved_workspace" });
      else expect(successor.contextSnapshot?.previousRunId).toBe(f.runId);
      await Promise.all([requestId ? heartbeat.resumeTaskRetry(f.companyId, requestId) : heartbeat.resumeQueuedRuns(),
        heartbeat.resumeRemoteStopComments(await run(f.runId))]);
      expect(await successors()).toHaveLength(1);
      expect(f.runtime.resumeRunLease).toHaveBeenCalledOnce();
      expect((await run(f.runId)).status).toBe("failed");
      const reloaded = await request(app).get(`/api/issues/${f.issueId}/recovery-actions`).expect(200);
      expect(reloaded.body.active).toBeNull();
      const records = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      expect(records.some(record => readSystemRecovery(record.evidence)?.state === "complete")).toBe(true);
      expect(errors).not.toHaveBeenCalled();
    } finally { releaseStop(); await coordinator.stop(); await worker.stop(); }
  }, 40_000);

  it("wakes physical preservation from HTTP Retry before passive history without replaying the provider", async () => {
    for (let index = 0; index < 5; index++) {
      const old = await seed();
      await recoverRetainedWorkspace(old.input);
      await db.update(issueRecoveryActions).set({
        id: `00000000-000${index}-4000-8000-${randomUUID().slice(-12)}`,
      }).where(eq(issueRecoveryActions.id, old.actionId));
    }
    const f = await seed();
    await adoptSystemRecovery(db, f);
    const before = await action(f.actionId);
    const exhausted = failSystemRecovery(readSystemRecovery(before.evidence)!,
      new SystemRecoveryFailure("source_binding_invalid", "service_required"));
    await db.update(issueRecoveryActions).set({ cause: "native_workspace_sync_out_retry_exhausted",
      evidence: { ...before.evidence, systemRecovery: exhausted } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    const errors = vi.fn();
    const competingCleanup = await retainedWorkspaceCandidates(db, undefined, false, true);
    expect(competingCleanup).toHaveLength(5);
    expect(competingCleanup.every(row => row.action.id.startsWith("00000000"))).toBe(true);
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: errors });
    const recovered = vi.fn(async () => {});
    const worker = registerWorkspaceRecoveryWork(db, coordinator, f.environmentRuntime, recovered);
    try {
      await worker.ready;
      await db.update(agents).set({ status: "paused" }).where(eq(agents.companyId, f.companyId));
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "board" }; next(); });
      app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
      app.use(errorHandler);
      const body = { idempotencyKey: randomUUID(), observedRunId: f.runId };
      const retry = await request(app).post(`/api/issues/${f.issueId}/retry`).send(body).expect(202);
      const repeated = await request(app).post(`/api/issues/${f.issueId}/retry`).send(body).expect(202);
      const coalesced = await request(app).post(`/api/issues/${f.issueId}/retry`)
        .send({ ...body, idempotencyKey: randomUUID() }).expect(202);
      expect(repeated.body.requestId).toBe(retry.body.requestId);
      expect(coalesced.body.requestId).toBe(retry.body.requestId);
      await expect.poll(async () => readSystemRecovery((await action(f.actionId)).evidence)?.state,
        { timeout: 20_000 }).toBe("complete");
      expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(f.runtime.resumeRunLease.mock.calls.filter(([input]) => input.lease.id === f.lease.id)).toHaveLength(1);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.companyId, f.companyId))).toHaveLength(0);
      const reloaded = await request(app).get(`/api/issues/${f.issueId}/recovery-actions`).expect(200);
      expect(JSON.stringify(reloaded.body)).toContain('"state":"complete"');
      expect(errors).not.toHaveBeenCalled();
    } finally { await coordinator.stop(); await worker.stop(); }
  }, 30_000);

  it("coalesces Retry while preservation owns its physical operation", async () => {
    const f = await seed();
    await adoptSystemRecovery(db, f);
    const resume = f.runtime.resumeRunLease.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.runtime.resumeRunLease.mockImplementation(async input => { await gate; return resume(input); });
    const preserving = recoverRetainedWorkspace(f.input);
    let requestId: string | null | undefined;
    try {
      await expect.poll(() => f.runtime.resumeRunLease.mock.calls.length).toBe(1);
      const request = { db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
        idempotencyKey: randomUUID(), observedRunId: f.runId };
      const first = await requestTaskRetry(request);
      requestId = first.requestId;
      const second = await requestTaskRetry({ ...request, idempotencyKey: randomUUID() });
      expect(second.requestId).toBe(first.requestId);
    } finally { release(); await preserving; }
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.intentId).toBe(requestId);
    expect(f.runtime.resumeRunLease.mock.calls.filter(([input]) => input.lease.id === f.lease.id)).toHaveLength(1);
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
  }, 30_000);

});
