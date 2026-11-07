import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, completionContracts, databaseWorkPending, environmentLeases, reconcileDatabaseWork, heartbeatRunEvents, heartbeatRuns, issues, issueRelations,
  issueTreeHolds, issueTreeHoldMembers, issueRecoveryActions, nativeRunFinalizations, nativeRunResults, nativeRunnerCheckpoints } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import type { NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>(),
  executeNativeSession: provider.execute,
}));
import { DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { describeEmbeddedPostgres, nativeRestartFixture, remotePreparedWorkspace } from "../../__tests__/helpers/native-restart.js";
import { nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../delivery-work-notifications.js";
import { claimNativeSessionResumptions } from "./native-finalization-reconciler.js";
import { cancelNativeSession, executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { claimNativeRestartRecoveries, currentNativeControllerIdentity, NATIVE_RESTART_RECOVERY_FAILED } from "./native-restart-recovery.js";
import { readSystemRecovery, SYSTEM_RECOVERY_MAX_RETRIES } from "../system-recovery-state.js";
import { recoveryService } from "../recovery/service.js";
import { issueService } from "../issues.js";
import { hasPendingRunCleanup } from "../execution-blocker.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { nativeManualAdmissionHoldsExecution } from "./native-runner-ownership.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";
import { releaseSettledNativeRunProcess } from "../native-local-process-stop.js";
import { createHeartbeatQueue } from "../heartbeat/queue.js";
import { createHeartbeatQueueTestDependencies } from "../../__tests__/helpers/heartbeat-queue.js";
import { instanceSettingsService } from "../instance-settings.js";
import { claimCancellationRequest } from "./native-cancellation-request.js";

describeEmbeddedPostgres("remote native retry execution admission", () => {
  const environment = nativeRestartFixture();

  async function failedRemoteRun(storage: "classic" | "remote" | "plugin") {
    const { companyId, agentId, runtimeRoot } = environment.current;
    const fixture = await environment.seedRun(`REMOTE-RETRY-${storage}-${randomUUID()}`);
    await fixture.db.update(agents).set({ status: "active" }).where(eq(agents.id, agentId));
    const controller = { bootId: randomUUID(), generation: 1, leaseOwner: randomUUID() };
    await fixture.db.update(nativeRunFinalizations).set({
      controllerBootId: controller.bootId, controllerGeneration: controller.generation,
      leaseOwner: controller.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    const authority = new DurablePrpControlPlane({
      stateDirectory: resolve(runtimeRoot, fixture.runId),
      identity: { runId: fixture.runId, normalizedSessionId: fixture.native.normalizedSessionId,
        runnerInstanceId: fixture.native.runnerInstanceId, environmentLeaseId: fixture.native.environmentLeaseId,
        turnId: fixture.native.turnId, itemId: fixture.native.itemId },
      expectedRunnerVersion: "retry-admission-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}`,
    });
    authority.setCheckpointPersistence(nativeRunnerCheckpointWriter(fixture.db, {
      companyId, issueId: fixture.issueId, runId: fixture.runId, authorityRunId: fixture.runId,
      ...controller,
    }));
    await authority.flushCheckpoint();
    await authority.stop();
    const classic = remotePreparedWorkspace();
    const remote = { schema: "paperclip.remote-workspace-run.v1", workspaceId: classic.workspaceId,
      leaseId: classic.leaseId, providerLeaseId: classic.providerLeaseId, remoteCwd: classic.remoteCwd,
      epoch: 1, state: "prepared", snapshotId: null };
    const checkpoint = { backendKind: "acpx", driverKind: "acpx_runtime", sessionId: "provider-session",
      providerSessionId: "provider-session", activeTurnId: "retained-turn", semanticResult: null,
      pendingRuntimeRequests: [], terminalTurns: [], identity: { companyId, agentId,
        issueId: fixture.issueId, runId: fixture.runId, sessionId: fixture.native.normalizedSessionId } };
    const [pluginLease] = storage === "plugin" ? await fixture.db.insert(environmentLeases).values({ companyId,
      issueId: fixture.issueId, heartbeatRunId: fixture.runId, provider: "daytona", providerLeaseId: randomUUID(),
      status: "active", leasePolicy: "ephemeral", metadata: { runnerTaskLease: true },
    }).returning({ id: environmentLeases.id }) : [];
    await fixture.db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(),
      processPid: 1386, processStartedAt: new Date("2026-11-01T12:00:00Z"),
      nativePhase: "retryable_failure", errorCode: "native_session_interrupted",
      runnerProfileJson: { ...fixture.preparedProfile, nativeExecutionInput: { binding: {
        companyId, agentId, issueId: fixture.issueId, runId: fixture.runId } }, sessionCheckpoint: checkpoint,
        ...(storage === "plugin" ? { nativeWorkspaceSync: null, remoteWorkspace: null }
          : storage === "classic" ? { nativeWorkspaceSync: classic } : { remoteWorkspace: remote }) },
    }).where(eq(heartbeatRuns.id, fixture.runId));
    await fixture.db.update(nativeRunFinalizations).set({ phase: "retryable_failure", attempt: 1,
      leaseOwner: null, leaseExpiresAt: null, recoveryState: "resuming_session",
      failureCode: "native_session_interrupted", nextAttemptAt: new Date(0),
      failureDetail: { recoveryMode: "exact_checkpoint_resume", providerSessionEstablished: true,
        checkpointExists: true, providerEventsExist: true },
    }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    await fixture.db.update(issues).set({ executionRunId: null, checkoutRunId: null })
      .where(eq(issues.id, fixture.issueId));
    return { ...fixture, companyId, agentId, checkpoint, pluginLeaseId: pluginLease?.id };
  }

  async function manuallyHeldRemoteRun() {
    const f = await failedRemoteRun("remote");
    await f.db.update(issues).set({ executionRunId: f.runId, checkoutRunId: f.runId }).where(eq(issues.id, f.issueId));
    await f.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      status: "succeeded", createdAt: new Date(Date.now() + 1_000) });
    await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", runIds: [f.runId] });
    return f;
  }

  it.each(["background sweep", "terminal cleanup", "pending cleanup", "queue release", "agent release"] as const)
  ("preserves a manual native execution hold through %s", async entry => {
    const f = await manuallyHeldRemoteRun();
    const [before] = await f.db.select().from(issues).where(eq(issues.id, f.issueId));
    if (entry === "background sweep") expect(await recoveryService(f.db, { enqueueWakeup: vi.fn() })
      .sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId })).toMatchObject({ cleared: 0 });
    if (entry === "terminal cleanup") {
      await expect(issueService(f.db).assertCheckoutOwner(f.issueId, f.agentId, randomUUID()))
        .rejects.toMatchObject({ status: 409 });
    }
    if (entry === "agent release") await expect(issueService(f.db).release(f.issueId, f.agentId, randomUUID()))
      .rejects.toMatchObject({ status: 409 });
    if (entry === "pending cleanup") expect(await hasPendingRunCleanup(f.db, f.companyId, f.runId)).toBe(true);
    if (entry === "queue release") await createPostgresWakeQueueAdapter(f.db, {
      resolveResponsibleUserId: async () => "operator", getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
    }).withIssueExecutionLock({ companyId: f.companyId, runId: f.runId, now: new Date() },
      async () => ({ outcome: { kind: "released" }, postCommitEffects: [] }));
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toEqual(before);
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
      .toMatchObject({ processPid: 1386, runnerProfileJson: { sessionCheckpoint: f.checkpoint } });
  });

  it.each(["execution", "checkout"] as const)("preserves a manual hold referenced only by the %s binding", async pointer => {
    const f = await manuallyHeldRemoteRun();
    await f.db.update(issues).set(pointer === "execution" ? { checkoutRunId: null } : { executionRunId: null })
      .where(eq(issues.id, f.issueId));
    expect(await recoveryService(f.db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId }))
      .toMatchObject({ cleared: 0 });
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject(pointer === "execution" ? { executionRunId: f.runId, checkoutRunId: null } : { executionRunId: null, checkoutRunId: f.runId });
  });

  it("rechecks a newly committed manual hold under the issue lock before background cleanup", async () => {
    const f = await manuallyHeldRemoteRun();
    const [hold] = await f.db.select({ failureCode: nativeRunFinalizations.failureCode,
      failureDetail: nativeRunFinalizations.failureDetail }).from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, f.runId));
    await f.db.update(nativeRunFinalizations).set({ failureCode: null, failureDetail: null })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    const beforeStaleLockClear = vi.fn(async (issueId: string) => {
      if (issueId === f.issueId) await f.db.update(nativeRunFinalizations).set(hold)
        .where(eq(nativeRunFinalizations.runId, f.runId));
    });
    expect(await recoveryService(f.db, { enqueueWakeup: vi.fn(), beforeStaleLockClear })
      .sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId })).toMatchObject({ cleared: 0 });
    expect(beforeStaleLockClear).toHaveBeenCalledExactlyOnceWith(f.issueId);
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ executionRunId: f.runId, checkoutRunId: f.runId });
  });

  it("defers a new wake behind the manual owner without clearing it or dispatching", async () => {
    const f = await manuallyHeldRemoteRun();
    await f.db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    const [agent] = await f.db.select().from(agents).where(eq(agents.id, f.agentId));
    const dependencies = createHeartbeatQueueTestDependencies(f.db);
    dependencies.getAgent.mockResolvedValue(agent);
    dependencies.instanceSettings.getExperimental.mockImplementation(() => instanceSettingsService(f.db).getExperimental());
    dependencies.wakeQueue.admitWakeBehindIssueExecution.mockResolvedValue({ kind: "deferred" });
    await createHeartbeatQueue(f.db, dependencies).enqueueWakeup(f.agentId, { source: "assignment", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
    expect(dependencies.executeRun).not.toHaveBeenCalled();
    expect(dependencies.wakeQueue.admitWakeBehindIssueExecution).toHaveBeenCalledOnce();
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ executionRunId: f.runId, checkoutRunId: f.runId });
  });

  it("retains the hold until every exact remote lease is confirmed stopped, then permits ordinary checkout", async () => {
    const f = await manuallyHeldRemoteRun();
    const scope = { companyId: f.companyId, runId: f.runId, issueId: f.issueId };
    expect(await nativeManualAdmissionHoldsExecution(f.db, scope)).toBe(true);
    expect(await nativeManualAdmissionHoldsExecution(f.db, { ...scope, companyId: randomUUID() })).toBe(false);
    expect(await nativeManualAdmissionHoldsExecution(f.db, { ...scope, runId: randomUUID() })).toBe(false);
    expect(await nativeManualAdmissionHoldsExecution(f.db, { ...scope, issueId: randomUUID() })).toBe(false);
    const leases = await f.db.insert(environmentLeases).values([1, 2].map(index => ({ companyId: f.companyId,
      issueId: f.issueId, heartbeatRunId: f.runId, provider: "daytona", providerLeaseId: `fixture-${index}-${randomUUID()}`,
      status: "released", releasedAt: new Date(), cleanupStatus: "success", metadata: {},
    }))).returning();
    expect(await nativeManualAdmissionHoldsExecution(f.db, scope)).toBe(true);
    for (let index = 0; index < leases.length; index += 1) {
      const lease = leases[index];
      await f.db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease,
        { providerLeaseId: lease.providerLeaseId, state: "stopped" }) } }).where(eq(environmentLeases.id, lease.id));
      expect(await nativeManualAdmissionHoldsExecution(f.db, scope)).toBe(index < leases.length - 1);
    }
    expect(await releaseSettledNativeRunProcess(f.db, f.runId)).toBe("released");
    expect(await hasPendingRunCleanup(f.db, f.companyId, f.runId)).toBe(false);
    expect(await recoveryService(f.db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId }))
      .toMatchObject({ cleared: 1 });
    const actorRunId = randomUUID();
    await f.db.insert(heartbeatRuns).values({ id: actorRunId, companyId: f.companyId, agentId: f.agentId,
      status: "running", invocationSource: "manual", contextSnapshot: { issueId: f.issueId } });
    expect(await issueService(f.db).assertCheckoutOwner(f.issueId, f.agentId, actorRunId))
      .toMatchObject({ executionRunId: actorRunId, checkoutRunId: actorRunId });
  });

  it.each(["ordinary terminal", "accepted result"] as const)("does not preserve unrelated %s ownership", async state => {
    const f = await manuallyHeldRemoteRun();
    if (state === "ordinary terminal") await f.db.update(nativeRunFinalizations).set({ failureDetail: null })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    else {
      const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const [result] = await f.db.insert(nativeRunResults).values({ companyId: f.companyId, issueId: f.issueId,
        runId: f.runId, completionContractId: run.completionContractId!, serverFingerprint: randomUUID(),
        canonicalSha256: "a".repeat(64), schemaStatus: "accepted", resultJson: {} }).returning();
      await f.db.update(nativeRunFinalizations).set({ resultId: result.id }).where(eq(nativeRunFinalizations.runId, f.runId));
    }
    expect(await nativeManualAdmissionHoldsExecution(f.db, { companyId: f.companyId, runId: f.runId, issueId: f.issueId })).toBe(false);
    expect(await recoveryService(f.db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId }))
      .toMatchObject({ cleared: 1 });
  });

  it("admits an explicit correlated Stop for the preserved manual execution", async () => {
    const f = await manuallyHeldRemoteRun();
    const requestId = randomUUID();
    expect(await claimCancellationRequest(f.db, f.runId, f.companyId, requestId, "operator"))
      .toMatchObject({ resultJson: { startupCancellation: { cancellationRequestId: requestId, retryCancellation: true } } });
    const stop = await cancelNativeSession(f.runId, "Operator Stop", { db: f.db, scope: "run", cancellationRequestId: requestId });
    expect(stop).toMatchObject({ dispatched: false, auditId: expect.any(String) });
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "terminal_failure", failureCode: "native_retry_cancelled" });
    expect(await nativeManualAdmissionHoldsExecution(f.db, { companyId: f.companyId, runId: f.runId, issueId: f.issueId })).toBe(true);
    expect(await recoveryService(f.db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId }))
      .toMatchObject({ cleared: 0 });
    expect(await cancelNativeSession(f.runId, "Repeat Operator Stop", { db: f.db, scope: "run", cancellationRequestId: requestId }))
      .toMatchObject({ auditId: stop.auditId });
    await f.db.update(nativeRunFinalizations).set({ failureCode: "native_restart_recovery_blocked" })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await cancelNativeSession(f.runId, "Resume recorded Stop", { db: f.db, scope: "run", cancellationRequestId: requestId }))
      .toMatchObject({ auditId: stop.auditId });
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ failureCode: "native_retry_cancelled" });
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ executionRunId: f.runId, checkoutRunId: f.runId });
  });

  it.each(["classic", "remote", "plugin"] as const)("reclaims the exact failed %s execution before remote inspection", async storage => {
    const fixture = await failedRemoteRun(storage);
    expect(await claimNativeSessionResumptions({ db: fixture.db, runnerInstanceId: "ordinary-resumer",
      runIds: [fixture.runId] })).toEqual([]);
    const [claim] = await claimNativeRestartRecoveries({ db: fixture.db,
      controller: environment.current.successor, restartKind: "hard", runIds: [fixture.runId] });
    expect(claim).toMatchObject({ kind: "reattach_remote_runner", runId: fixture.runId, providerAttempt: 2 });
    expect((await fixture.db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0])
      .toMatchObject({ executionRunId: fixture.runId, status: "in_progress", assigneeAgentId: fixture.agentId });
    expect((await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId)))[0])
      .toMatchObject({ status: "running", processPid: 1386,
        runnerProfileJson: { sessionCheckpoint: fixture.checkpoint } });
    expect((await fixture.db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, fixture.runId)))[0])
      .toMatchObject({ attempt: 2, phase: "observed", recoveryState: "awaiting_runner_reattach" });
  });

  it.each(["company", "run", "issue"] as const)("does not use a plugin lease from another %s", async scope => {
    const f = await failedRemoteRun("plugin");
    if (!f.pluginLeaseId) throw new Error("Expected a plugin allocation");
    const foreignId = randomUUID();
    if (scope === "company") {
      await f.db.insert(companies).values({ id: foreignId, name: "Other company", issuePrefix: foreignId.slice(0, 8) });
      await f.db.update(environmentLeases).set({ companyId: foreignId }).where(eq(environmentLeases.id, f.pluginLeaseId));
    } else if (scope === "run") {
      await f.db.insert(heartbeatRuns).values({ id: foreignId, companyId: f.companyId, agentId: f.agentId, status: "failed" });
      await f.db.update(environmentLeases).set({ heartbeatRunId: foreignId }).where(eq(environmentLeases.id, f.pluginLeaseId));
    } else {
      await f.db.insert(issues).values({ id: foreignId, companyId: f.companyId, title: "Other task" });
      await f.db.update(environmentLeases).set({ issueId: foreignId }).where(eq(environmentLeases.id, f.pluginLeaseId));
    }
    const onClaim = vi.fn();
    expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", runIds: [f.runId], onClaim }))
      .toMatchObject([{ kind: "blocked", runId: f.runId, reason: "issue_execution_lock_changed" }]);
    expect(onClaim).not.toHaveBeenCalled();
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ executionRunId: null, checkoutRunId: null });
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "retryable_failure", attempt: 1 });
  });

  it.each((["remote", "plugin"] as const).flatMap(storage => (["done", "cancelled", "blocked", "paused-agent", "pending-agent-approval", "reassigned",
    "dependency", "tree-pause", "native-stop", "operator-stop", "execution-owner", "checkout-owner",
    "queued-input", "newer-completed-input", "wrong-checkpoint", "missing-authority"] as const).map(gate => [storage, gate] as const)))
  ("preserves a %s retry held by %s", async (storage, gate) => {
    const f = await failedRemoteRun(storage);
    const { db } = f;
    if (["done", "cancelled", "blocked"].includes(gate)) {
      await db.update(issues).set({ status: gate }).where(eq(issues.id, f.issueId));
    } else if (gate === "paused-agent" || gate === "pending-agent-approval") {
      await db.update(agents).set({ status: gate === "paused-agent" ? "paused" : "pending_approval" }).where(eq(agents.id, f.agentId));
    } else if (gate === "reassigned") {
      const nextAgent = randomUUID();
      await db.insert(agents).values({ id: nextAgent, companyId: f.companyId, name: "Next owner", status: "active" });
      await db.update(issues).set({ assigneeAgentId: nextAgent }).where(eq(issues.id, f.issueId));
    } else if (gate === "dependency") {
      const dependency = randomUUID();
      await db.insert(issues).values({ id: dependency, companyId: f.companyId, title: "Required input", status: "todo" });
      await db.insert(issueRelations).values({ companyId: f.companyId, issueId: dependency, relatedIssueId: f.issueId, type: "blocks" });
    } else if (gate === "tree-pause") {
      const holdId = randomUUID();
      await db.insert(issueTreeHolds).values({ id: holdId, companyId: f.companyId, rootIssueId: f.issueId, mode: "pause" });
      await db.insert(issueTreeHoldMembers).values({ holdId, companyId: f.companyId, issueId: f.issueId,
        issueTitle: "Paused work", issueStatus: "in_progress" });
    } else if (gate === "native-stop" || gate === "operator-stop") {
      await db.update(heartbeatRuns).set({ resultJson: gate === "native-stop"
        ? { nativeCancellation: { scope: "run", dispatchState: "pending" } }
        : { cancellation: { source: "operator", expected: true, initiator: { type: "user" },
          reason: "Stop", recordedAt: new Date().toISOString() } } }).where(eq(heartbeatRuns.id, f.runId));
    } else if (["execution-owner", "checkout-owner", "queued-input", "newer-completed-input"].includes(gate)) {
      const nextRun = randomUUID();
      await db.insert(heartbeatRuns).values({ id: nextRun, companyId: f.companyId, agentId: f.agentId,
        issueId: f.issueId, contextSnapshot: { issueId: f.issueId, wakeReason: "issue_comment" },
        invocationSource: "manual", createdAt: new Date(Date.now() + 1_000),
        status: gate === "queued-input" ? "queued" : gate === "newer-completed-input" ? "succeeded" : "failed" });
      if (gate === "execution-owner" || gate === "checkout-owner") await db.update(issues)
        .set(gate === "execution-owner" ? { executionRunId: nextRun } : { checkoutRunId: nextRun }).where(eq(issues.id, f.issueId));
    } else if (gate === "wrong-checkpoint") {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run.runnerProfileJson,
        sessionCheckpoint: { ...f.checkpoint, identity: { ...f.checkpoint.identity, runId: randomUUID() } },
      } }).where(eq(heartbeatRuns.id, f.runId));
    } else if (gate === "missing-authority") {
      await db.delete(nativeRunnerCheckpoints).where(and(eq(nativeRunnerCheckpoints.companyId, f.companyId),
        eq(nativeRunnerCheckpoints.runId, f.runId)));
    }
    const beforeTask = (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0];
    const beforeRun = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0];
    const beforeOwner = (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0];
    const dispositions = await claimNativeRestartRecoveries({ db,
      controller: environment.current.successor, restartKind: "hard", runIds: [f.runId] });
    expect(dispositions.every(value => value.kind === "blocked")).toBe(true);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toEqual(beforeTask);
    const [afterRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [afterOwner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    if (["done", "cancelled", "newer-completed-input", "execution-owner", "checkout-owner", "queued-input"].includes(gate)) {
      expect(afterOwner).toMatchObject({ phase: "terminal_failure", attempt: 1, nextAttemptAt: null,
        failureDetail: { systemRecovery: { state: "exhausted" } } });
      expect(afterRun).toMatchObject({ status: "failed", processPid: beforeRun.processPid,
        runnerProfileJson: beforeRun.runnerProfileJson });
      return;
    }
    expect(afterRun).toEqual(beforeRun);
    expect(afterOwner.failureDetail).toMatchObject(beforeOwner.failureDetail!);
    expect({ ...afterOwner, nextAttemptAt: beforeOwner.nextAttemptAt, updatedAt: beforeOwner.updatedAt,
      recoveryHistory: beforeOwner.recoveryHistory, failureDetail: beforeOwner.failureDetail }).toEqual(beforeOwner);
    if (gate === "execution-owner") expect(afterOwner).toEqual(beforeOwner);
    else expect(afterOwner.nextAttemptAt!.getTime()).toBeGreaterThan(beforeOwner.nextAttemptAt!.getTime());
  });

  it.each(["remote", "plugin"] as const)("waits for the exact old %s controller lease and keeps future retries quiet", async storage => {
    const f = await failedRemoteRun(storage);
    const now = new Date(), deadline = new Date(now.getTime() + 60_000);
    await f.db.update(nativeRunFinalizations).set({ nextAttemptAt: deadline })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", now, runIds: [f.runId] })).toEqual([]);
    await f.db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(0), leaseOwner: "old-owner", leaseExpiresAt: deadline })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", now, runIds: [f.runId] })).toMatchObject([{ kind: "awaiting_evidence", reason: "remote_controller_lease_live" }]);
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBeNull();
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("failed");
  });

  it.each(["remote", "plugin"] as const)("grants two competing controllers only one original %s execution", async storage => {
    const f = await failedRemoteRun(storage);
    const claims = (await Promise.all([environment.current.successor,
      { ...environment.current.successor, bootId: randomUUID() }].map(controller =>
      claimNativeRestartRecoveries({ db: f.db, controller, restartKind: "hard", runIds: [f.runId] })))).flat();
    expect(claims.filter(claim => claim.kind === "reattach_remote_runner")).toHaveLength(1);
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ controllerGeneration: 2, attempt: 2 });
    expect(await f.db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.runId),
      eq(heartbeatRunEvents.eventType, "native.recovery.execution_reclaimed")))).toHaveLength(1);
  });

  it.each(["remote", "plugin"] as const)("rolls back the %s task, owner, run, and recovery event together", async storage => {
    const f = await failedRemoteRun(storage);
    await expect(f.db.transaction(async tx => {
      const claims = await claimNativeRestartRecoveries({ db: tx as unknown as typeof f.db,
        controller: environment.current.successor, restartKind: "hard", runIds: [f.runId] });
      expect(claims).toMatchObject([{ kind: "reattach_remote_runner" }]);
      throw new Error("rollback admission");
    })).rejects.toThrow("rollback admission");
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBeNull();
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("failed");
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "retryable_failure", controllerGeneration: 1, leaseOwner: null, attempt: 1 });
    expect(await f.db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.runId),
      eq(heartbeatRunEvents.eventType, "native.recovery.execution_reclaimed")))).toEqual([]);
  });

  it.each([
    ["succeeded", "2026-11-01T12:00:00.000600Z", 1, true],
    ["succeeded", "2026-11-01T12:00:00.000000Z", 1, true],
    ["failed", "2026-11-01T12:00:00.000000Z", 1, true],
    ["failed", "2026-11-01T12:00:00.000600Z", 1, true],
    ["succeeded", "2026-11-01T12:00:00.000599Z", 1, false],
    ["failed", "2026-11-01T12:00:00.000601Z", -1, true],
    ["failed", "2026-11-01T12:00:00.000600Z", -1, false],
  ] as const)("uses canonical source order for %s input at %s with ID offset %s", async (status, timestamp, offset, superseded) => {
    const f = await failedRemoteRun("remote");
    const idHex = (BigInt(`0x${f.runId.replaceAll("-", "")}`) + BigInt(offset)).toString(16).padStart(32, "0");
    const nextId = `${idHex.slice(0, 8)}-${idHex.slice(8, 12)}-${idHex.slice(12, 16)}-${idHex.slice(16, 20)}-${idHex.slice(20)}`;
    const sourceTimestamp = timestamp.endsWith(".000000Z") ? timestamp : "2026-11-01T12:00:00.000600Z";
    await f.db.update(heartbeatRuns).set({ createdAt: sql`${sourceTimestamp}::timestamptz` })
      .where(eq(heartbeatRuns.id, f.runId));
    await f.db.insert(heartbeatRuns).values({ id: nextId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, invocationSource: "manual", status, createdAt: sql`${timestamp}::timestamptz` });
    const [disposition] = await claimNativeRestartRecoveries({ db: f.db,
      controller: environment.current.successor, restartKind: "hard", runIds: [f.runId] });
    expect(disposition).toMatchObject(superseded
      ? { kind: "blocked", reason: "native_retry_source_superseded" }
      : { kind: "reattach_remote_runner", providerAttempt: 2 });
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId)
      .toBe(superseded ? null : f.runId);
  });

  it.each((["remote", "plugin"] as const).flatMap(storage => (["released", "retained"] as const).map(lock => [storage, lock] as const)))
  ("exhausts the existing attempt budget after repeated %s snapshot failures with a %s task lock", async (storage, lock) => {
    const f = await failedRemoteRun(storage);
    if (lock === "retained") await f.db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
    const [issue] = await f.db.select().from(issues).where(eq(issues.id, f.issueId));
    const [contract] = await f.db.select().from(completionContracts).where(eq(completionContracts.issueId, f.issueId));
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId: f.companyId, runId: f.runId, issueId: f.issueId, agentId: f.agentId, executionWorkspaceId: f.runId },
      provider: { kind: "codex", model: "gpt-5.6-luna" },
      task: { identifier: issue.identifier!, title: issue.title, description: null, prompt: "Continue retained work.", workMode: "standard" },
      workspace: { cwd: environment.current.runtimeRoot, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: f.native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue, { revision: contract.revision }) },
      interactionResponses: [], credentialBindings: [],
    };
    await f.db.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
      || ${JSON.stringify({ nativeExecutionInput: execution })}::jsonb` }).where(eq(heartbeatRuns.id, f.runId));
    provider.execute.mockReset().mockRejectedValue(new Error("PRP command session.snapshot failed: original provider unavailable"));
    const controller = await currentNativeControllerIdentity();
    for (const attempt of [2, 3]) {
      await f.db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.runId));
      const [claim] = await claimNativeRestartRecoveries({ db: f.db, controller, restartKind: "hard", runIds: [f.runId] });
      expect(claim).toMatchObject({ kind: "reattach_remote_runner", providerAttempt: attempt });
      if (claim.kind !== "reattach_remote_runner") throw new Error("Expected exact remote recovery claim");
      await expect(executePaperclipNativeSession({ db: f.db, execution, runnerInstanceId: f.native.runnerInstanceId,
        leaseOwner: claim.leaseOwner, restartRecovery: claim,
        backend: { descriptor: async () => { throw new Error("Unexpected descriptor call"); },
          openSession: async () => { throw new Error("Unexpected session launch"); } },
      })).rejects.toThrow("PRP command session.snapshot failed");
      const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(owner).toMatchObject({ attempt, phase: attempt === 3 ? "terminal_failure" : "retryable_failure",
        failureCode: attempt === 3 ? "native_session_retry_exhausted" : "native_session_interrupted",
        recoveryState: attempt === 3 ? "blocked" : "resuming_session", leaseOwner: null });
      expect(owner.nextAttemptAt === null).toBe(attempt === 3);
      if (lock === "released") await f.db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
    }
    expect(provider.execute).toHaveBeenCalledTimes(2);
    expect(await claimNativeRestartRecoveries({ db: f.db, controller, restartKind: "hard", runIds: [f.runId] })).toEqual([]);
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ status: "blocked", executionRunId: null });
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
      .toMatchObject({ status: "failed", nativePhase: "terminal_failure", errorCode: "native_session_interrupted",
        processPid: 1386, runnerProfileJson: { sessionCheckpoint: f.checkpoint } });
  });

  it.each((["remote", "plugin"] as const).flatMap(storage => (["released", "retained"] as const).map(lock => [storage, lock] as const)))
  ("does not admit another failed %s retry when the persisted provider budget is already exhausted with a %s task lock", async (storage, lock) => {
    const f = await failedRemoteRun(storage);
    if (lock === "retained") await f.db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
    await f.db.update(nativeRunFinalizations).set({ attempt: 3 }).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", runIds: [f.runId] })).toMatchObject([{ kind: "blocked", reason: "execution_recovery_budget_exhausted" }]);
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBeNull();
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "terminal_failure", attempt: 3, leaseOwner: null, nextAttemptAt: null,
        failureCode: "native_restart_recovery_blocked", failureDetail: { reason: "execution_recovery_budget_exhausted" } });
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
      .toMatchObject({ status: "failed", nativePhase: "terminal_failure", processPid: 1386,
        runnerProfileJson: { sessionCheckpoint: f.checkpoint } });
    expect(await f.db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
      eq(issueRecoveryActions.kind, "active_run_watchdog"))))
      .toMatchObject([{ ownerType: "board", evidence: { runId: f.runId, reason: "execution_recovery_budget_exhausted" } }]);
    expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", runIds: [f.runId] })).toEqual([]);
  });

  it("persists a blocked retry deadline and records only changed hold reasons", async () => {
    const f = await failedRemoteRun("remote");
    await f.db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    const now = new Date();
    const attempt = (at: Date) => claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", runIds: [f.runId], now: at });
    const [first] = await attempt(now);
    expect(first).toMatchObject({ kind: "blocked", reason: "native_retry_admission_ineligible", transitionUnchanged: false });
    if (!("retryAt" in first) || !first.retryAt) throw new Error("missing first retry deadline");
    expect(first.retryAt.getTime() - now.getTime()).toBeGreaterThanOrEqual(24_000);
    expect(first.retryAt.getTime() - now.getTime()).toBeLessThanOrEqual(36_000);
    expect(await attempt(new Date(first.retryAt.getTime() - 1))).toEqual([]);
    const [second] = await attempt(first.retryAt);
    expect(second).toMatchObject({ kind: "blocked", transitionUnchanged: true });
    if (!("retryAt" in second) || !second.retryAt) throw new Error("missing second retry deadline");
    expect(second.retryAt.getTime() - first.retryAt.getTime()).toBeGreaterThanOrEqual(48_000);
    let [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(owner).toMatchObject({ phase: "retryable_failure", attempt: 1,
      nextAttemptAt: second.retryAt, recoveryHistory: [{ reason: "native_retry_admission_ineligible" }] });
    await f.db.update(agents).set({ status: "active" }).where(eq(agents.id, f.agentId));
    await f.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      status: "succeeded", createdAt: new Date(now.getTime() + 1_000) });
    expect(await attempt(second.retryAt)).toMatchObject([{ kind: "blocked", reason: "native_retry_source_superseded" }]);
    [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(owner.recoveryHistory).toMatchObject([{ reason: "native_retry_admission_ineligible" }, { reason: "native_retry_source_superseded" }]);
  });

  it("registers recovery work intent before writing a blocked retry deadline", async () => {
    const f = await failedRemoteRun("remote");
    await f.db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    const transaction = f.db.transaction.bind(f.db);
    let writes = 0;
    const interception = vi.spyOn(f.db, "transaction").mockImplementation((async (callback, options) => transaction(async tx => {
      const update = tx.update.bind(tx);
      const updates = vi.spyOn(tx, "update").mockImplementation((table => {
        if (Object.is(table, nativeRunFinalizations)) {
          writes += 1;
          expect(databaseWorkPending(f.db, DELIVERY_QUEUES.nativeProcessSessions)).toBe(true);
        }
        return update(table);
      }) as typeof tx.update);
      try { return await callback(tx); } finally { updates.mockRestore(); }
    }, options)) as typeof f.db.transaction);
    try {
      expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
        restartKind: "hard", runIds: [f.runId] })).toMatchObject([{ kind: "blocked" }]);
      expect(writes).toBe(1);
    } finally { interception.mockRestore(); }
  });

  it.each(["done", "cancelled", "superseded"] as const)("settles a permanently %s remote retry without recurring work", async gate => {
    for (const lock of ["released", "retained"]) {
      const f = await failedRemoteRun("remote");
      if (lock === "retained") await f.db.update(issues).set({ executionRunId: f.runId, checkoutRunId: f.runId })
        .where(eq(issues.id, f.issueId));
      if (gate === "superseded") await f.db.insert(heartbeatRuns).values({ companyId: f.companyId,
        agentId: f.agentId, issueId: f.issueId, status: "succeeded", createdAt: new Date(Date.now() + 1_000) });
      else await f.db.update(issues).set({ status: gate }).where(eq(issues.id, f.issueId));
      const onClaim = vi.fn();
      const environmentWake = vi.fn(), stopWatchingEnvironment = subscribeDeliveryWork(f.db, DELIVERY_QUEUES.nativeEnvironmentSettlement, environmentWake);
      const [disposition] = await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
        restartKind: "hard", runIds: [f.runId], onClaim });
      expect(disposition).toMatchObject({ kind: "blocked" });
      expect(disposition).not.toHaveProperty("retryAt");
      expect(onClaim).not.toHaveBeenCalled();
      expect(environmentWake).not.toHaveBeenCalled();
      stopWatchingEnvironment();
      expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({
        executionRunId: lock === "retained" ? f.runId : null, checkoutRunId: lock === "retained" ? f.runId : null });
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
        .toMatchObject({ phase: "terminal_failure", nextAttemptAt: null, attempt: 1 });
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
        .toMatchObject({ processPid: 1386, runnerProfileJson: { sessionCheckpoint: f.checkpoint } });
      const wake = vi.fn(), unsubscribe = subscribeDeliveryWork(f.db, DELIVERY_QUEUES.nativeProcessSessions, wake);
      const transaction = vi.spyOn(f.db, "transaction");
      try {
        for (const elapsed of [30_000, 60_000, 3_600_000]) expect(await claimNativeRestartRecoveries({ db: f.db,
          controller: environment.current.successor, restartKind: "hard", runIds: [f.runId],
          now: new Date(Date.now() + elapsed), onClaim })).toEqual([]);
        expect(transaction).not.toHaveBeenCalled();
        expect(wake).not.toHaveBeenCalled();
      } finally { transaction.mockRestore(); unsubscribe(); }
    }
  });

  it.each(["superseded", "released"] as const)("settles a %s bootstrap retry that lost its task lock instead of re-checking forever", async lock => {
    const f = await failedRemoteRun("remote");
    // A bootstrap retry follows a pre-provider failure: no checkpoint, provider session or provider events.
    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const { sessionCheckpoint: _checkpoint, ...profile } = run.runnerProfileJson ?? {};
    await f.db.update(heartbeatRuns).set({ errorCode: "provider_session_open_rejected", runnerProfileJson: profile })
      .where(eq(heartbeatRuns.id, f.runId));
    await f.db.delete(nativeRunnerCheckpoints)
      .where(and(eq(nativeRunnerCheckpoints.companyId, f.companyId), eq(nativeRunnerCheckpoints.runId, f.runId)));
    await f.db.update(nativeRunFinalizations).set({ failureCode: "provider_session_open_rejected", failureDetail: {
      recoveryMode: "bootstrap_retry", providerSessionEstablished: false, checkpointExists: false, providerEventsExist: false,
    } }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (lock === "superseded") {
      const [newer] = await f.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
        status: "running", createdAt: new Date(Date.now() + 1_000) }).returning({ id: heartbeatRuns.id });
      await f.db.update(issues).set({ executionRunId: newer.id }).where(eq(issues.id, f.issueId));
    }
    const onClaim = vi.fn();
    const attempt = (now: Date) => claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", runIds: [f.runId], now, onClaim });
    let now = new Date();
    let passes = 0;
    for (; passes <= SYSTEM_RECOVERY_MAX_RETRIES + 1; passes++) {
      const [disposition] = await attempt(now);
      expect(disposition).toMatchObject({ kind: "blocked" });
      const [coordinator] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      if (coordinator.phase === "terminal_failure") break;
      if (!("retryAt" in disposition) || !disposition.retryAt) throw new Error("a deferred bootstrap retry must persist its deadline");
      expect(coordinator.nextAttemptAt).toEqual(disposition.retryAt);
      now = disposition.retryAt;
    }
    expect(passes).toBe(lock === "superseded" ? 0 : SYSTEM_RECOVERY_MAX_RETRIES);
    expect(onClaim).not.toHaveBeenCalled();
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "terminal_failure", nextAttemptAt: null, attempt: 1, failureCode: "native_restart_recovery_blocked" });
    expect(await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))
      .toMatchObject([{ ownerType: "board", wakePolicy: null }]);
    const transaction = vi.spyOn(f.db, "transaction");
    try {
      for (const elapsed of [30_000, 3_600_000]) expect(await attempt(new Date(now.getTime() + elapsed))).toEqual([]);
      expect(transaction).not.toHaveBeenCalled();
    } finally { transaction.mockRestore(); }
  });

  it.each(["paused", "Stop", "missing-authority"] as const)("bounds %s holds and preserves the provider and own task lock for manual reconciliation", async gate => {
    const f = await failedRemoteRun("remote");
    if (gate === "paused") await f.db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    if (gate === "Stop") await f.db.update(heartbeatRuns).set({ resultJson: {
      nativeCancellation: { scope: "run", dispatchState: "pending" },
    } }).where(eq(heartbeatRuns.id, f.runId));
    if (gate === "missing-authority") await f.db.delete(nativeRunnerCheckpoints)
      .where(and(eq(nativeRunnerCheckpoints.companyId, f.companyId), eq(nativeRunnerCheckpoints.runId, f.runId)));
    await f.db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
    await f.db.update(nativeRunFinalizations).set({ attempt: 3 }).where(eq(nativeRunFinalizations.runId, f.runId));
    let now = new Date();
    const onClaim = vi.fn();
    const environmentWake = vi.fn(), stopWatchingEnvironment = subscribeDeliveryWork(f.db, DELIVERY_QUEUES.nativeEnvironmentSettlement, environmentWake);
    for (let index = 0; index <= SYSTEM_RECOVERY_MAX_RETRIES; index += 1) {
      const [disposition] = await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
        restartKind: "hard", runIds: [f.runId], now, onClaim });
      const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      const policy = readSystemRecovery(owner.failureDetail);
      expect(policy).not.toBeNull();
      expect(owner.attempt).toBe(3);
      if (index < SYSTEM_RECOVERY_MAX_RETRIES) {
        expect(owner.phase).toBe("retryable_failure");
        expect(policy).toMatchObject({ state: "awaiting_evidence" });
        expect(disposition).toHaveProperty("retryAt", owner.nextAttemptAt);
        now = owner.nextAttemptAt!;
      } else {
        expect(owner).toMatchObject({ phase: "terminal_failure", nextAttemptAt: null });
        expect(policy).toMatchObject({ state: "exhausted" });
        expect(disposition).not.toHaveProperty("retryAt");
      }
    }
    expect(onClaim).not.toHaveBeenCalled();
    expect(environmentWake).not.toHaveBeenCalled();
    stopWatchingEnvironment();
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ executionRunId: f.runId });
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
      .toMatchObject({ processPid: 1386, runnerProfileJson: { sessionCheckpoint: f.checkpoint } });
    expect(await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))
      .toMatchObject([{ ownerType: "board", wakePolicy: null,
        evidence: { automaticAdmissionExhausted: true, executorStopEvidence: "unverified", providerPid: 1386, checkpointPreserved: true },
        nextAction: expect.stringContaining("original executor stop and state remain unverified") }]);
    expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", runIds: [f.runId], now: new Date(now.getTime() + 3_600_000) })).toEqual([]);
  });

  it("settles the old admission policy while preserving a newer active execution and its binding", async () => {
    const f = await failedRemoteRun("remote");
    const newerRunId = randomUUID();
    await f.db.insert(heartbeatRuns).values({ id: newerRunId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, status: "running", invocationSource: "manual", createdAt: new Date(Date.now() + 1_000) });
    await f.db.update(issues).set({ executionRunId: newerRunId, checkoutRunId: newerRunId }).where(eq(issues.id, f.issueId));
    const [task] = await f.db.select().from(issues).where(eq(issues.id, f.issueId));
    const [newer] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, newerRunId));
    const environmentWake = vi.fn(), unsubscribe = subscribeDeliveryWork(f.db, DELIVERY_QUEUES.nativeEnvironmentSettlement, environmentWake);
    const onClaim = vi.fn();
    try {
      expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
        restartKind: "hard", runIds: [f.runId], onClaim }))
        .toMatchObject([{ kind: "blocked", reason: "native_retry_source_superseded" }]);
      expect(onClaim).not.toHaveBeenCalled();
      expect(environmentWake).not.toHaveBeenCalled();
      expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toEqual(task);
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, newerRunId)))[0]).toEqual(newer);
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
        .toMatchObject({ phase: "terminal_failure", nextAttemptAt: null, failureDetail: { systemRecovery: { state: "exhausted" } } });
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
        .toMatchObject({ processPid: 1386, runnerProfileJson: { sessionCheckpoint: f.checkpoint } });
      const transactions = vi.spyOn(f.db, "transaction");
      try {
        expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
          restartKind: "hard", runIds: [f.runId], now: new Date(Date.now() + 3_600_000) })).toEqual([]);
        expect(transactions).not.toHaveBeenCalled();
      } finally { transactions.mockRestore(); }
    } finally { unsubscribe(); }
  });

  it("resumes the original provider when eligibility returns before admission backoff exhausts", async () => {
    const f = await failedRemoteRun("remote");
    await f.db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", runIds: [f.runId] });
    const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    await f.db.update(agents).set({ status: "active" }).where(eq(agents.id, f.agentId));
    expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", runIds: [f.runId], now: owner.nextAttemptAt! }))
      .toMatchObject([{ kind: "reattach_remote_runner", providerAttempt: 2, runId: f.runId }]);
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
      .toMatchObject({ status: "running", processPid: 1386, runnerProfileJson: { sessionCheckpoint: f.checkpoint } });
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBe(f.runId);
  });

  it("does not settle permanently ineligible work while the original controller is active", async () => {
    const f = await failedRemoteRun("remote");
    await f.db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    const [before] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const wake = vi.fn(), unsubscribe = subscribeDeliveryWork(f.db, DELIVERY_QUEUES.nativeProcessSessions, wake);
    try {
      expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
        restartKind: "hard", runIds: [f.runId], liveRunExecutions: new Set([f.runId]) }))
        .toMatchObject([{ kind: "awaiting_evidence", reason: "current_controller_preparing" }]);
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(before);
      expect(wake).not.toHaveBeenCalled();
      expect(await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
    } finally { unsubscribe(); }
  });

  it("keeps a retry deadline that changed after discovery read-only and quiet", async () => {
    const f = await failedRemoteRun("remote");
    await f.db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    const deadline = new Date(Date.now() + 60_000);
    const transaction = f.db.transaction.bind(f.db);
    const interception = vi.spyOn(f.db, "transaction").mockImplementationOnce((async (callback, options) => {
      await f.db.update(nativeRunFinalizations).set({ nextAttemptAt: deadline }).where(eq(nativeRunFinalizations.runId, f.runId));
      return transaction(callback, options);
    }) as typeof f.db.transaction);
    const wake = vi.fn(), unsubscribe = subscribeDeliveryWork(f.db, DELIVERY_QUEUES.nativeProcessSessions, wake);
    try {
      expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
        restartKind: "hard", runIds: [f.runId] })).toMatchObject([{ kind: "blocked", retryAt: deadline, transitionUnchanged: true }]);
      const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(owner).toMatchObject({ nextAttemptAt: deadline, recoveryHistory: [], phase: "retryable_failure", attempt: 1 });
      expect(wake).not.toHaveBeenCalled();
    } finally { interception.mockRestore(); unsubscribe(); }
  });

  it("rolls back work intent when the locked retry deadline update matches no row", async () => {
    const f = await failedRemoteRun("remote");
    await f.db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    const name = `retry_noop_${f.runId.replaceAll("-", "")}`;
    await f.db.execute(sql.raw(`create function ${name}() returns trigger language plpgsql as $$begin return null; end$$`));
    await f.db.execute(sql.raw(`create trigger ${name} before update on native_run_finalizations for each row
      when (old.run_id = '${f.runId}'::uuid) execute function ${name}()`));
    const [before] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    try {
      const now = new Date();
      await expect(claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
        restartKind: "hard", runIds: [f.runId], now })).resolves.toEqual([{ kind: "awaiting_evidence",
          runId: f.runId, reason: NATIVE_RESTART_RECOVERY_FAILED, retryAt: new Date(now.getTime() + 30_000) }]);
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(before);
      await reconcileDatabaseWork(f.db, DELIVERY_QUEUES.nativeProcessSessions);
      expect(databaseWorkPending(f.db, DELIVERY_QUEUES.nativeProcessSessions)).toBe(false);
    } finally {
      await f.db.execute(sql.raw(`drop trigger ${name} on native_run_finalizations`));
      await f.db.execute(sql.raw(`drop function ${name}()`));
    }
  });

  it("does not publish or log a deferred transition when an ineligible retry still has a live lease", async () => {
    const f = await failedRemoteRun("remote");
    const now = new Date(), leaseDeadline = new Date(now.getTime() + 60_000);
    await f.db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    await f.db.update(nativeRunFinalizations).set({ leaseOwner: "live-controller", leaseExpiresAt: leaseDeadline })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    const [before] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const wake = vi.fn(), unsubscribe = subscribeDeliveryWork(f.db, DELIVERY_QUEUES.nativeProcessSessions, wake);
    try {
      for (let index = 0; index < 2; index += 1) {
        expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
          restartKind: "hard", runIds: [f.runId], now })).toMatchObject([{ kind: "blocked",
            retryAt: leaseDeadline, transitionUnchanged: true }]);
        expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(before);
        expect(wake).not.toHaveBeenCalled();
      }
    } finally { unsubscribe(); }
  });

  it.each(["released", "retained"] as const)("keeps exhausted %s retries fenced behind live owners, Stops and newer input", async lock => {
    for (const gate of ["live-owner", "Stop", "newer-input", "missing-authority"]) {
      const f = await failedRemoteRun("remote");
      if (lock === "retained") await f.db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
      await f.db.update(nativeRunFinalizations).set({ attempt: 3,
        ...(gate === "live-owner" ? { leaseOwner: "live-controller", leaseExpiresAt: new Date(Date.now() + 60_000) } : {}),
      }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (gate === "Stop") await f.db.update(heartbeatRuns).set({ resultJson: {
        nativeCancellation: { scope: "run", dispatchState: "pending" },
      } }).where(eq(heartbeatRuns.id, f.runId));
      if (gate === "newer-input") await f.db.insert(heartbeatRuns).values({ companyId: f.companyId,
        agentId: f.agentId, issueId: f.issueId, status: "succeeded", createdAt: new Date(Date.now() + 1_000) });
      if (gate === "missing-authority") await f.db.delete(nativeRunnerCheckpoints)
        .where(and(eq(nativeRunnerCheckpoints.companyId, f.companyId), eq(nativeRunnerCheckpoints.runId, f.runId)));
      const onClaim = vi.fn();
      expect((await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
        restartKind: "hard", runIds: [f.runId], onClaim }))[0].kind).toBe(gate === "live-owner" ? "awaiting_evidence" : "blocked");
      expect(onClaim).not.toHaveBeenCalled();
      expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBe(lock === "retained" ? f.runId : null);
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
        .toMatchObject({ phase: gate === "newer-input" ? "terminal_failure" : "retryable_failure", attempt: 3 });
      const actions = await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      if (gate === "newer-input") expect(actions).toMatchObject([{ ownerType: "board", wakePolicy: null }]);
      else expect(actions).toEqual([]);
    }
  });

  it("preserves the charged attempt when replacing an active remote controller", async () => {
    const f = await failedRemoteRun("remote");
    await f.db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
    await f.db.update(heartbeatRuns).set({ status: "running", nativePhase: "observed" }).where(eq(heartbeatRuns.id, f.runId));
    await f.db.update(nativeRunFinalizations).set({ attempt: 2, phase: "observed", failureCode: null, failureDetail: null })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", runIds: [f.runId] })).toMatchObject([{ kind: "reattach_remote_runner", providerAttempt: 2 }]);
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "observed", attempt: 2, controllerGeneration: 2 });
  });

  it("ignores another company's newer input when reclaiming this company's execution", async () => {
    const f = await failedRemoteRun("remote");
    const foreignCompany = randomUUID(), foreignAgent = randomUUID();
    await f.db.insert(companies).values({ id: foreignCompany, name: "Other company", issuePrefix: "FOREIGN" });
    await f.db.insert(agents).values({ id: foreignAgent, companyId: foreignCompany, name: "Other agent", status: "active" });
    await f.db.insert(heartbeatRuns).values({ companyId: foreignCompany, agentId: foreignAgent,
      status: "queued", contextSnapshot: { issueId: f.issueId }, createdAt: new Date(Date.now() + 1_000) });
    expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", runIds: [f.runId] })).toMatchObject([{ kind: "reattach_remote_runner" }]);
  });
});
