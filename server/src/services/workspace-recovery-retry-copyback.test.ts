import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { admitExplicitNativeContinuation } from "./explicit-native-continuation.js";
import { classifyEnvironmentCapabilities, environmentRuntimeService } from "./environment-runtime.js";
import { taskInterruptionPresentation } from "./task-interruption-presentation.js";
import * as nativeWorkspaceSync from "./native-runtime/native-workspace-sync.js";
import { nativeWorkspaceSyncStateRoot, prepareNativeWorkspaceSync } from "./native-runtime/native-workspace-sync.js";
import { registerCancelledWorkspacePreservationWork, preserveTaskRemoteWorkspaceWriter, preserveOrphanedNativeWorkspace } from "./native-runtime/native-failed-workspace-recovery.js";
import { readSystemRecovery, createSystemRecovery } from "./system-recovery-state.js";
import { adoptSystemRecovery } from "./system-recovery.js";
import { getStorageService } from "../storage/index.js";
import { migrateRemoteWorkspace } from "./remote-workspace-migration.js";
import { attachPreservedWorkspaceSnapshots, verifiedWorkspaceSnapshotReceipt } from "./workspace-recovery-snapshot.js";
import { requestTaskRetry } from "./task-retry.js";
import { requestInterruptedNativeTurnRetry, requestRestartInterruptedTurnRetry } from "./heartbeat/restart-interrupted-turn.js";
import { startTaskDrain, stopTaskDrain } from "./task-admission.js";
import { activityLog, companies, environmentLeases, environments, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, agentWakeupRequests, workspaceOperations, executionWorkspaces, withDedicatedDbConnection } from "@paperclipai/db";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { resumePreservedResultFinalization } from "./preserved-result-finalization.js";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { EnvironmentLease } from "@paperclipai/shared";
import { nativeWorkspaceExportPendingForResource } from "./native-runtime/native-workspace-finalization-state.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { prepareStoppedSandboxForRecovery, settleStopOnlyCleanup } from "./sandbox-stop-and-retain.js";
import { recoverRetainedWorkspace, requestWorkspaceRecovery, reconcileRetainedWorkspaces } from "./workspace-recovery.js";
import * as activity from "./activity-log.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { heartbeatService } from "./heartbeat.js";
import { hasVerifiedWorkspaceRepair, readWorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { createSavedWorkspaceLoader, prepareRemoteWorkspace, readRemoteWorkspaceAuthority, reserveRemoteWorkspace } from "./remote-workspaces.js";
import { canonicalProviderPackJson } from "./native-runtime/remote-provider-pack-verification.js";
import { REMOTE_WORKSPACE_SANDBOX_DISK_FULL } from "./remote-workspace-transport.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { useWorkspaceRecoveryFixture, acceptedRemoteExport, action, connectionString, db, failedWarmSource, makeRetryDue, receiptOnlyRecoveryApp, root, run, seed } from "./__tests__/workspace-recovery-fixture.js";
const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

describe("automatic retained workspace recovery", () => {
  useWorkspaceRecoveryFixture(targets);

  it("recovers files after Stop finds no live controller without replaying the cancelled chat", async () => {
    const f = await seed("native", true, "destroy", false, true), original = await run(f.runId);
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    await db.update(issues).set({ conversationAgentId: original.agentId, conversationUserId: "operator",
      conversationState: "active", status: "in_review" }).where(eq(issues.id, f.issueId));
    const nativeCancellation = { schema: "paperclip.native-cancellation.v1", runId: f.runId, companyId: f.companyId,
      issueId: f.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: false,
      intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() };
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled", resultJson: {
      nativeCancellation, cancelledByActorType: "user", cancelledByUserId: "operator",
      executionCancellation: { state: "requested", requestedAt: new Date().toISOString() },
    } }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(environmentLeases).set({ status: "active", releasedAt: null, cleanupStatus: null,
      metadata: f.lease.metadata }).where(eq(environmentLeases.id, f.lease.id));
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    try {
      await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
      const [preservation] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId));
      expect(preservation).toBeDefined();
      await recoverRetainedWorkspace({ ...f.input, actionId: preservation.id });
      expect(readSystemRecovery((await action(preservation.id)).evidence)?.state).toBe("complete");
      expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
      expect(await run(f.runId)).toMatchObject({ status: "cancelled", resultJson: { nativeCancellation },
        runnerProfileJson: { nativeWorkspaceSync: { state: "finalized" } } });
      expect(f.runtime.retryPendingSandboxTeardown).toHaveBeenCalled();
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0].metadata)
        .toHaveProperty("remoteExecutionTermination");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("in_review");
    } finally { await worker.stop(); }
  }, 30_000);

  // S51: a user's comment started a native turn in a managed sandbox. A server
  // restart, or a same-run retry after a turn ended without a result, claimed it
  // for reattachment, but its original runner or sandbox was gone
  // (`native_remote_recovery_lease_mismatch`, `runner_remote_process_identity_unavailable`).
  // Saved-work recovery then recovered the files. The task must continue
  // without a second message.
  async function restartAllocationLostSource(turn: "none" | "settled" | "in_flight" | "unproven",
    error = "native_remote_recovery_lease_mismatch") {
    const f = await seed("native");
    const original = await run(f.runId);
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "local-board", body: "Please review the change." }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: original.agentId,
      source: "automation", triggerDetail: "system", reason: "issue_commented", status: "failed", runId: f.runId,
      requestedByActorType: "user", requestedByActorId: "local-board", finishedAt: new Date(),
      payload: { issueId: f.issueId, commentId: comment.id, mutation: "comment" } }).returning();
    await db.update(heartbeatRuns).set({ errorCode: "setup_failed", error,
      wakeupRequestId: wake.id, responsibleUserId: "local-board", startedAt: new Date(Date.now() - 60_000),
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: comment.id, wakeCommentIds: [comment.id] },
      resultJson: { ...original.resultJson, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    }).where(eq(heartbeatRuns.id, f.runId));
    for (const eventType of turn === "none" ? [] : turn === "in_flight" ? ["turn.started"] : ["turn.started", turn === "settled" ? "turn.completed" : "turn.failed"])
      await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId,
        agentId: original.agentId, eventType, stream: "system", level: "info", message: eventType,
        // A driver that lost its event stream ends the turn without a provider terminal.
        ...(turn === "unproven" && eventType === "turn.failed" ? { payload: { prpEvent: { eventType, payload: { providerTerminalObserved: false } } } } : {}) });
    const claim = { kind: "reattach_remote_runner" as const, runId: f.runId, leaseOwner: `boot:1:${randomUUID()}`,
      controllerGeneration: 1, providerAttempt: 0, restartKind: "hard" as const, recoveryRequestId: null,
      remote: { providerLeaseId: f.providerLeaseId, remoteCwd: f.remote } };
    return { ...f, comment, wake, claim, agentId: original.agentId };
  }
  const queuedSuccessors = async (companyId: string) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued")));
  async function systemWake(f: Awaited<ReturnType<typeof restartAllocationLostSource>>, proof?: { providerTurnIssued?: false }) {
    await db.update(agentWakeupRequests).set({ requestedByActorType: "system", requestedByActorId: null,
      reason: "issue_monitor_due" }).where(eq(agentWakeupRequests.id, f.wake.id));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, wakeReason: "issue_monitor_due" } })
      .where(eq(heartbeatRuns.id, f.runId));
    // The executor's refused reattachment (see withRemoteRunnerTurnProof).
    if (proof) await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: f.agentId,
      eventType: "native.remote_runner_recovery_failed", stream: "system", level: "error", message: "Could not verify the existing remote runner.",
      payload: { remoteRunnerRecovery: { stage: "process_verification", reason: "process_not_running",
        runnerLifecycle: "ready", runnerSettled: false, ...proof } } });
  }

  it.each([
    { title: "the first attachment found the previous runner gone", turn: "none" as const, error: "runner_remote_process_identity_unavailable", initial: true },
    { title: "the first replacement could not archive remote state", turn: "none" as const, error: "runner_continuity_break_archive_failed", initial: true },
    { title: "a restart lost its sandbox before the turn started", turn: "none" as const, error: "native_remote_recovery_lease_mismatch", initial: false },
    { title: "a same-run retry found the settled turn's remote runner gone", turn: "settled" as const, error: "runner_remote_process_identity_unavailable", initial: false },
    { title: "a same-run retry found the settled turn's sandbox lease gone", turn: "settled" as const, error: "native_remote_recovery_lease_mismatch", initial: false },
    { title: "a same-run retry named the lease check that failed", turn: "settled" as const, error: "native_remote_recovery_lease_mismatch: stage=environment_acquire field=lease_status", initial: false },
    // Staging class T (c14bab19): a monitor wake's session snapshot timed out
    // before any turn, then the same-run retry found the Runner gone. Its
    // controller journal proved no turn command was ever issued, so nothing can
    // be repeated and the run's responsible user's Retry continues it once.
    { title: "a system wake's run found its runner gone and its journal proved no turn", turn: "none" as const, error: "runner_remote_process_identity_unavailable", initial: false, system: true },
  ])("continues a user turn once, without a second message, after $title and recovery saved the work", async ({ turn, error, initial, system }) => {
    const f = await restartAllocationLostSource(turn, error);
    if (system) await systemWake(f, { providerTurnIssued: false });
    const service = heartbeatService(db, { environmentRuntime: f.environmentRuntime });
    // Keep the agent's only slot busy so the successor stays observable as queued.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const request = () => initial ? requestInterruptedNativeTurnRetry(db, f.runId) : requestRestartInterruptedTurnRetry(db, f.claim);
    const requested = await request();
    expect(requested).toMatchObject({ requested: true });
    // A duplicate hook call (for example a second restart sweep) is idempotent.
    expect(await request()).toMatchObject({ requested: true });
    // Saved-work recovery runs first; its completion hook resumes saved input.
    await vi.waitFor(async () => {
      await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, current => service.resumeRemoteStopComments(current)) ?? []);
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    }, { timeout: 10_000, interval: 10 });
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    await vi.waitFor(async () => expect(await queuedSuccessors(f.companyId)).toHaveLength(1), { timeout: 10_000, interval: 50 });
    const [successor] = await queuedSuccessors(f.companyId);
    expect(successor.contextSnapshot).toMatchObject({ previousRunId: f.runId, wakeReason: "task_retry", forceFreshSession: true });
    const retries = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.reason, "task_retry")));
    expect(retries.filter(wake => wake.idempotencyKey?.startsWith("task-retry:"))).toHaveLength(1);
    expect(retries[0]).toMatchObject({ requestedByActorType: "user", requestedByActorId: "local-board" });
    const activity = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
      eq(activityLog.action, "issue.retry_requested")));
    expect(activity).toMatchObject([{ actorType: "system", actorId: "restart-recovery",
      details: { initiatedBy: "restart_recovery", onBehalfOfUserId: "local-board", sourceRunId: f.runId } }]);
    // Ordinary dispatch replays are idempotent.
    await service.resumeRemoteStopComments(await run(f.runId));
    expect(await queuedSuccessors(f.companyId)).toHaveLength(1);
    // If that automatic Retry also loses its runner, it gets no second automatic attempt.
    const [retryRun] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      nativeIssueId: f.issueId, runtimeMode: "native", status: "failed", finishedAt: new Date(), error,
      wakeupRequestId: successor.wakeupRequestId, contextSnapshot: successor.contextSnapshot }).returning();
    await db.update(agentWakeupRequests).set({ runId: retryRun.id }).where(eq(agentWakeupRequests.id, successor.wakeupRequestId!));
    expect(await requestRestartInterruptedTurnRetry(db, { ...f.claim, runId: retryRun.id }))
      .toEqual({ requested: false, reason: "automatic_retry_used" });
  }, 30_000);

  it.each([
    { title: "its provider turn was still in flight", change: "turn" },
    { title: "its provider turn ended without an observed provider terminal", change: "unproven" },
    { title: "the source was a system wake whose provider turn settled", change: "system" },
    // No run events is not proof: a turn can reach the provider before its
    // events are stored. Only the controller journal can prove it.
    { title: "the source was a system wake with no run events but no journal proof", change: "system_unproven" },
    { title: "the source was a system wake whose run used a tool before its turn event", change: "system_tool" },
    { title: "the source was a system wake whose run had no responsible user", change: "system_unowned" },
    { title: "the failure was not a lost runner or allocation", change: "error" },
    // Staging class P: the new sandbox had no Runner state to resume the saved
    // provider session. The Runner now names it, so the run ends with the
    // permanent code and Retry continues in a fresh provider session.
    { title: "the Runner had no saved state to resume the provider session", change: "unrestorable" },
  ])("does not continue automatically when $title, and offers a Retry that works on first use", async ({ change }) => {
    const f = await restartAllocationLostSource(change === "turn" ? "in_flight" : change === "unproven" ? "unproven"
      : change === "system" ? "settled" : "none");
    if (change.startsWith("system")) await systemWake(f, change === "system_unproven" ? undefined : { providerTurnIssued: false });
    if (change === "system_tool") await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId,
      agentId: f.agentId, eventType: "tool.execution.started", stream: "system", level: "info", message: "tool" });
    if (change === "system_unowned") await db.update(heartbeatRuns).set({ responsibleUserId: null }).where(eq(heartbeatRuns.id, f.runId));
    if (change === "error") await db.update(heartbeatRuns).set({ error: "native_provider_terminal_failed" }).where(eq(heartbeatRuns.id, f.runId));
    if (change === "unrestorable") await db.update(heartbeatRuns).set({ errorCode: "native_provider_state_incompatible",
      error: "native_session_recovery_failed: NativeRunnerResumeStateUnavailableError: PRP provider resume state is unavailable" })
      .where(eq(heartbeatRuns.id, f.runId));
    const service = heartbeatService(db, { environmentRuntime: f.environmentRuntime });
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    expect(await requestRestartInterruptedTurnRetry(db, f.claim)).toMatchObject({ requested: false,
      ...(change === "turn" || change === "unproven" ? { reason: "provider_turn_unsettled" } : {}) });
    await vi.waitFor(async () => {
      await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, current => service.resumeRemoteStopComments(current)) ?? []);
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    }, { timeout: 10_000, interval: 10 });
    expect(await queuedSuccessors(f.companyId)).toHaveLength(0);
    // The recovered hold offers the same Retry that POST /issues/:id/retry performs.
    const issue = (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0];
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ runId: f.runId, canRetry: true, workspaceRecovery: { status: "recovered" } });
    expect(blocker?.nextAction).toMatch(/Retry/);
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true, observedRunId: f.runId });
    // First use: one deliberate click queues exactly one successor.
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
      actorSource: "local_implicit", idempotencyKey: randomUUID(), observedRunId: f.runId });
    expect(receipt).toMatchObject({ accepted: true });
    await service.resumeTaskRetry(f.companyId, receipt.requestId!);
    const successors = await queuedSuccessors(f.companyId);
    expect(successors).toHaveLength(1);
    expect(successors[0].contextSnapshot).toMatchObject({ previousRunId: f.runId, taskRetryRequestId: receipt.requestId,
      forceFreshSession: true });
  }, 30_000);

  // S54: the automatic Retry's own run then lost its runner too. Saved-work
  // recovery recovered its files and the hold offered Retry, but a click was
  // admitted and never started a run; a second click joined the stuck intent.
  async function failRetrySuccessorWithLostRunner(f: Awaited<ReturnType<typeof restartAllocationLostSource>>) {
    const [successor] = await queuedSuccessors(f.companyId);
    const runId = successor.id;
    await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native", nativeIssueId: f.issueId, issueId: f.issueId,
      errorCode: "setup_failed", error: "native_remote_recovery_lease_mismatch", startedAt: new Date(Date.now() - 30_000),
      finishedAt: new Date(), responsibleUserId: "local-board" }).where(eq(heartbeatRuns.id, runId));
    await db.update(agentWakeupRequests).set({ status: "failed", runId, finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, successor.wakeupRequestId!));
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId, phase: "terminal_failure" });
    for (const eventType of ["turn.started", "turn.completed"])
      await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId, agentId: f.agentId, eventType,
        stream: "system", level: "info", message: eventType });
    const [environment] = await db.insert(environments).values({ name: runId, driver: "sandbox" }).returning();
    const providerLeaseId = randomUUID(), remote = path.join(root, runId, "remote");
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: runId,
      environmentId: environment.id, provider: "daytona", providerLeaseId, leasePolicy: "retain_on_failure", status: "released",
      cleanupStatus: "success", releasedAt: new Date(),
      metadata: { remoteCwd: remote, driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true } }).returning();
    const target: AdapterSandboxExecutionTarget = { ...targets.get(f.lease.id)!, leaseId: lease.id, remoteCwd: remote,
      sandboxLeaseAcquisition: { outcome: "created", providerLeaseId } };
    targets.set(lease.id, target);
    expect(await prepareNativeWorkspaceSync({ db, companyId: f.companyId, workspaceId: f.issueId, workspaceLocalDir: f.host,
      runId, lease: lease as EnvironmentLease, target, resourceDisposition: "destroy" })).not.toBeNull();
    await writeFile(path.join(remote, "retry-work.txt"), "retry turn work\n");
    const recovery = { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [lease.id] };
    await db.update(heartbeatRuns).set({ resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: recovery,
      conversationContinuation: "continue_conversation_v1" } }).where(eq(heartbeatRuns.id, runId));
    await db.update(environmentLeases).set({ metadata: { ...lease.metadata,
      remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId, state: "stopped" }) } }).where(eq(environmentLeases.id, lease.id));
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
      ownerType: "board", cause: "native_continuation_requires_reconciliation", fingerprint: runId, nextAction: "Manual repair required",
      evidence: { runId, workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: recovery } }).returning();
    const environmentRuntime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox",
      acquireRunLease: vi.fn(), releaseRunLease: vi.fn(),
      resumeRunLease: vi.fn(async (input: { lease: EnvironmentLease }) => ({ providerLeaseId: input.lease.providerLeaseId,
        metadata: { remoteCwd: (input.lease.metadata as { remoteCwd?: string }).remoteCwd } })),
      retryPendingSandboxTeardown: vi.fn(async (input: { lease: EnvironmentLease }) => ({ providerLeaseId: input.lease.providerLeaseId, state: "stopped" })),
      resolveCapabilities: async () => classifyEnvironmentCapabilities({ verifiedMethods: [], declared: null, narrowing: null }),
    }] });
    return { runId, hold, environmentRuntime, claim: { ...f.claim, runId, remote: { providerLeaseId, remoteCwd: remote } } };
  }

  async function recoverRetryLostRunner() {
    const f = await restartAllocationLostSource("settled", "runner_remote_process_identity_unavailable");
    const service = heartbeatService(db, { environmentRuntime: f.environmentRuntime });
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    expect(await requestRestartInterruptedTurnRetry(db, f.claim)).toMatchObject({ requested: true });
    await vi.waitFor(async () => {
      await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, current => service.resumeRemoteStopComments(current)) ?? []);
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    }, { timeout: 10_000, interval: 10 });
    await vi.waitFor(async () => expect(await queuedSuccessors(f.companyId)).toHaveLength(1), { timeout: 10_000, interval: 50 });
    const second = await failRetrySuccessorWithLostRunner(f);
    const secondService = heartbeatService(db, { environmentRuntime: second.environmentRuntime });
    // That automatic Retry's own loss is left to the user's visible Retry.
    expect(await requestRestartInterruptedTurnRetry(db, second.claim)).toEqual({ requested: false, reason: "automatic_retry_used" });
    await vi.waitFor(async () => {
      await Promise.all(await reconcileRetainedWorkspaces(db, second.environmentRuntime, current => secondService.resumeRemoteStopComments(current)) ?? []);
      expect(readSystemRecovery((await action(second.hold.id)).evidence)?.state).toBe("complete");
    }, { timeout: 10_000, interval: 10 });
    expect(await queuedSuccessors(f.companyId)).toHaveLength(0);
    const issue = (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0];
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ runId: second.runId, cause: "native_continuation_requires_reconciliation", canRetry: true,
      nextAction: "Saved work recovered. Retry or send a message to continue." });
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ canRetry: true, observedRunId: second.runId });
    return { ...f, ...second, service: secondService, issue };
  }

  it("starts exactly one run when Retry is pressed after the automatic Retry's own run lost its runner", async () => {
    const f = await recoverRetryLostRunner();
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
      actorSource: "local_implicit", idempotencyKey: randomUUID(), observedRunId: f.runId });
    expect(receipt).toMatchObject({ accepted: true });
    await f.service.resumeTaskRetry(f.companyId, receipt.requestId!);
    const successors = await queuedSuccessors(f.companyId);
    expect(successors).toHaveLength(1);
    expect(successors[0].contextSnapshot).toMatchObject({ previousRunId: f.runId, taskRetryRequestId: receipt.requestId });
    // A replayed dispatch and a second click do not start another run.
    await f.service.resumeTaskRetry(f.companyId, receipt.requestId!);
    await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
      actorSource: "local_implicit", idempotencyKey: randomUUID(), observedRunId: f.runId });
    expect(await queuedSuccessors(f.companyId)).toHaveLength(1);
  }, 60_000);

  it("does not let a Retry that could not start swallow a later Retry", async () => {
    const f = await recoverRetryLostRunner();
    // The first click's intent is declined at dispatch: its requester no longer
    // has access. It must name that gate instead of waiting silently.
    const first = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "departed-user",
      actorSource: "session", idempotencyKey: randomUUID(), observedRunId: f.runId });
    expect(first).toMatchObject({ accepted: true });
    await f.service.resumeTaskRetry(f.companyId, first.requestId!);
    expect(await queuedSuccessors(f.companyId)).toHaveLength(0);
    const [declined] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, first.requestId!));
    expect(declined).toMatchObject({ status: "deferred_issue_execution", runId: null,
      payload: { executionWait: { reason: "retry_authority_denied" } } });
    expect(await taskInterruptionPresentation(db, f.issue)).toMatchObject({ state: "failed", canRetry: true,
      retryWait: { reason: "retry_authority_denied" } });
    // A later click is a fresh attempt under the clicker's authority, not the stuck intent.
    const second = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
      actorSource: "local_implicit", idempotencyKey: randomUUID(), observedRunId: f.runId });
    expect(second).toMatchObject({ accepted: true });
    expect(second.requestId).not.toBe(first.requestId);
    await f.service.resumeTaskRetry(f.companyId, second.requestId!);
    // A late dispatch of the replaced intent cannot start a second run.
    await f.service.resumeTaskRetry(f.companyId, first.requestId!);
    const successors = await queuedSuccessors(f.companyId);
    expect(successors).toHaveLength(1);
    expect(successors[0].contextSnapshot).toMatchObject({ previousRunId: f.runId, taskRetryRequestId: second.requestId });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, first.requestId!)))[0])
      .toMatchObject({ status: "skipped", error: "task_retry_replaced", runId: null });
    const activity = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
      eq(activityLog.action, "issue.retry_requested"), eq(activityLog.actorId, "local-board")));
    expect(activity.at(-1)?.details).toMatchObject({ requestId: second.requestId, replacedRequestId: first.requestId });
  }, 60_000);

  it("dispatches a Retry accepted during the pre-deploy drain once the restarted server resumes", async () => {
    const f = await recoverRetryLostRunner();
    startTaskDrain({ ttlMs: null });
    let receipt: Awaited<ReturnType<typeof requestTaskRetry>>;
    try {
      receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
        actorSource: "local_implicit", idempotencyKey: randomUUID(), observedRunId: f.runId });
      expect(receipt).toMatchObject({ accepted: true });
      await f.service.resumeTaskRetry(f.companyId, receipt.requestId!);
      expect(await queuedSuccessors(f.companyId)).toHaveLength(0);
    } finally { stopTaskDrain(); }
    // The drain is process-local; a restarted server redelivers the saved intent.
    const restarted = heartbeatService(db, { environmentRuntime: f.environmentRuntime });
    await restarted.resumeExecutionWaitComments({ companyId: f.companyId });
    await restarted.resumeExecutionWaitComments({ companyId: f.companyId });
    const successors = await queuedSuccessors(f.companyId);
    expect(successors).toHaveLength(1);
    expect(successors[0].contextSnapshot).toMatchObject({ previousRunId: f.runId, taskRetryRequestId: receipt!.requestId });
  }, 60_000);

  it.each([false, true])("recovers an exact warm native source for an already saved Retry without replaying its failed generation: exportOnly=%s", async exportOnly => {
    const f = await failedWarmSource(exportOnly);
    expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
    const resumed = vi.fn();
    await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, resumed) ?? []);
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
    const current = await action(f.actionId);
    expect(current.evidence.nativeSourceRetention).toMatchObject({ schema: "paperclip.native-source-retention.v1",
      sourceRunId: f.runId, requestId: f.retry.requestId, previousGeneration: f.failed });
    expect(readSystemRecovery(current.evidence)).toMatchObject({ state: "complete", intentId: f.retry.requestId });
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0])
      .toMatchObject({ status: "released", leasePolicy: "reuse_by_environment", cleanupStatus: "success" });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    const snapshot = await action(f.actionId);
    await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, resumed) ?? []);
    expect(await action(f.actionId)).toEqual(snapshot);
    expect(f.runtime.resumeRunLease).toHaveBeenCalledOnce();
    const source = await run(f.runId);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
    const service = heartbeatService(db, { environmentRuntime: f.environmentRuntime });
    await Promise.all([service.resumeTaskRetry(f.companyId, f.retry.requestId!), service.resumeTaskRetry(f.companyId, f.retry.requestId!)]);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    if (exportOnly) {
      expect(successors).toHaveLength(0);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.retry.requestId!)))[0])
        .toMatchObject({ status: "coalesced", runId: f.runId });
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].phase).toBe("workspace_finalizing");
    } else {
      expect(successors).toHaveLength(1);
      expect(successors[0].contextSnapshot).toMatchObject({ taskRetryRequestId: f.retry.requestId, previousRunId: f.runId });
      expect(await readFreshWorkspaceReadiness(db, successors[0])).toMatchObject({ mode: "resume_preserved_workspace" });
    }
  }, 30_000);

  it.each(["throw", "skip"])("keeps completion and the saved Retry pending when policy settlement must %s", async failure => {
    const f = await failedWarmSource(true), trigger = `native_retention_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      ${failure === "throw" ? "RAISE EXCEPTION 'test policy write failed';" : "RETURN NULL;"} END $$`));
    try {
      await db.execute(sql.raw(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON environment_leases FOR EACH ROW
        WHEN (NEW.id = '${f.lease.id}'::uuid AND OLD.lease_policy = 'retain_on_failure' AND NEW.lease_policy = 'reuse_by_environment')
        EXECUTE FUNCTION ${trigger}()`));
      await recoverRetainedWorkspace(f.input);
      const held = readSystemRecovery((await action(f.actionId)).evidence)!;
      expect(held.state).toBe(failure === "throw" ? "scheduled" : "awaiting_evidence");
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
      expect(await resumePreservedResultFinalization(db, f.companyId, f.runId)).toBe(false);
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0].leasePolicy).toBe("retain_on_failure");
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.retry.requestId!)))[0])
        .toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${trigger} ON environment_leases`));
      await db.execute(sql.raw(`DROP FUNCTION ${trigger}()`));
    }
    const pending = await action(f.actionId), state = readSystemRecovery(pending.evidence)!;
    await db.update(issueRecoveryActions).set({ evidence: { ...pending.evidence, systemRecovery: { ...state, nextAttemptAt: 0 } } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    await recoverRetainedWorkspace(f.input);
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0].leasePolicy).toBe("reuse_by_environment");
    expect(await resumePreservedResultFinalization(db, f.companyId, f.runId)).toBe(true);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.retry.requestId!)))[0])
      .toMatchObject({ status: "coalesced", runId: f.runId });
  }, 30_000);

  it.each([
    ["reuse_by_environment", false], ["reuse_by_environment", true], ["retain_on_failure", true], ["ephemeral", true],
  ] as const)("settles snapshot-only source preservation without making its unfinished allocation reusable: policy=%s acceptedResult=%s", async (leasePolicy, acceptedResult) => {
    const f = await failedWarmSource(acceptedResult);
    if (leasePolicy !== "reuse_by_environment") {
      await db.update(environmentLeases).set({ leasePolicy }).where(eq(environmentLeases.id, f.lease.id));
      const sourceAction = await action(f.actionId);
      await db.update(issueRecoveryActions).set({ evidence: { ...sourceAction.evidence,
        systemRecovery: createSystemRecovery(f.runId, f.retry.requestId!) } }).where(eq(issueRecoveryActions.id, f.actionId));
    }
    targets.get(f.lease.id)!.runner!.syncIn = async () => ({ filesTransferred: 0, bytesTransferred: 0, operations: [] });
    targets.get(f.lease.id)!.runner!.syncOut = async operations => {
      for (const operation of operations) for (const file of operation.files)
        await cp(file.sourcePath, file.targetPath, { recursive: true, dereference: false });
      return { filesTransferred: 2, bytesTransferred: 0, operations: [] };
    };
    await rm(path.join(nativeWorkspaceSyncStateRoot(), f.runId), { recursive: true });
    await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, vi.fn()) ?? []);
    expect(await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, f.runId),
      eq(workspaceOperations.phase, "workspace_recovery_snapshot"), eq(workspaceOperations.status, "succeeded")))).toHaveLength(1);
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    expect(lease).toMatchObject({ status: "released", leasePolicy: leasePolicy === "ephemeral" ? "ephemeral" : "retain_on_failure", cleanupStatus: "success" });
    if (leasePolicy === "reuse_by_environment") expect(lease.metadata?.nativeSourceRetention).toMatchObject({ settlement: "snapshot_retained" });
    else expect(lease.metadata?.nativeSourceRetention).toBeUndefined();
    expect(await nativeWorkspaceExportPendingForResource(db, lease, randomUUID())).toBe(true);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].phase).toBe("terminal_failure");
    await recoverRetainedWorkspace(f.input);
    expect(f.runtime.resumeRunLease).toHaveBeenCalledOnce();
    const source = await run(f.runId);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
    const service = heartbeatService(db, { environmentRuntime: f.environmentRuntime });
    if (acceptedResult) {
      const operationIds = readSystemRecovery((await action(f.actionId)).evidence)!.preservationOperationIds;
      const receiptInput = { companyId: f.companyId, issueId: f.issueId, runId: f.runId, actionId: f.actionId, operationIds };
      expect(await verifiedWorkspaceSnapshotReceipt(db, receiptInput)).not.toBeNull();
      for (const patch of [{ companyId: randomUUID() }, { issueId: randomUUID() }, { runId: randomUUID() },
        { actionId: randomUUID() }, { operationIds: [randomUUID()] }])
        expect(await verifiedWorkspaceSnapshotReceipt(db, { ...receiptInput, ...patch })).toBeNull();
      const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, operationIds[0]));
      await db.update(workspaceOperations).set({ metadata: { ...operation.metadata, providerLeaseId: randomUUID() } })
        .where(eq(workspaceOperations.id, operation.id));
      try {
        await service.resumeTaskRetry(f.companyId, f.retry.requestId!);
        expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.retry.requestId!)))[0])
          .toMatchObject({ status: "deferred_issue_execution", runId: null });
      } finally { await db.update(workspaceOperations).set({ metadata: operation.metadata }).where(eq(workspaceOperations.id, operation.id)); }
    }
    await Promise.all([service.resumeTaskRetry(f.companyId, f.retry.requestId!), service.resumeTaskRetry(f.companyId, f.retry.requestId!)]);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(successors).toHaveLength(1);
    const [successor] = successors;
    expect(await readFreshWorkspaceReadiness(db, successor)).toMatchObject({ mode: "fresh_isolated_workspace",
      retryIntentId: f.retry.requestId, sourceRunId: f.runId, retainedSourceIds: [f.lease.id] });
    const fresh = path.join(root, randomUUID()); await mkdir(fresh);
    const attached = await attachPreservedWorkspaceSnapshots({ db, companyId: f.companyId, issueId: f.issueId,
      sourceRunIds: [successor.id], cwd: fresh });
    expect(attached).toHaveLength(1);
    expect(await readFile(path.join(attached[0].path, "files", "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
    if (acceptedResult) expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId)))[0])
      .toMatchObject({ schemaStatus: "accepted", resultJson: { terminal: { runTerminalState: "succeeded" } } });
  }, 30_000);

  it.each(["no_request", "unauthorized", "already_adopted", "prior_export", "other_failure", "wrong_cwd", "writer", "newer_terminal", "controller", "older_lease", "foreign_lease"])(
    "does not adopt a held warm source with %s", async reason => {
      const f = await failedWarmSource();
      if (reason === "no_request") await db.update(agentWakeupRequests).set({ status: "failed" }).where(eq(agentWakeupRequests.id, f.retry.requestId!));
      if (reason === "unauthorized") {
        const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.retry.requestId!));
        await db.update(agentWakeupRequests).set({ payload: { ...wake.payload, taskRetry: {
          ...(wake.payload!.taskRetry as object), actorSource: "session" } } }).where(eq(agentWakeupRequests.id, wake.id));
      }
      if (["already_adopted", "prior_export", "other_failure"].includes(reason)) await db.update(issueRecoveryActions).set({ evidence: {
        ...(await action(f.actionId)).evidence,
        ...(reason === "already_adopted" ? { nativeSourceRetention: { schema: "paperclip.native-source-retention.v1" } } : {}),
        ...(reason === "prior_export" ? { systemRecovery: { ...f.failed, preservationOperationIds: [randomUUID()] } } : {}),
        ...(reason === "other_failure" ? { systemRecovery: { ...f.failed, failure: { ...f.failed.failure!, code: "source_unavailable" } } } : {}),
      } }).where(eq(issueRecoveryActions.id, f.actionId));
      if (reason === "wrong_cwd") await db.update(environmentLeases).set({ metadata: { ...f.lease.metadata, remoteCwd: "/wrong" } }).where(eq(environmentLeases.id, f.lease.id));
      if (reason === "writer" || reason === "newer_terminal") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: (await run(f.runId)).agentId,
        issueId: f.issueId, nativeIssueId: f.issueId, status: reason === "writer" ? "queued" : "succeeded", runtimeMode: "native",
        createdAt: new Date(Date.now() + 1000) });
      if (reason === "controller") await db.update(nativeRunFinalizations).set({ leaseOwner: "live-controller" }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (reason === "older_lease" || reason === "foreign_lease") {
        const companyId = reason === "foreign_lease" ? randomUUID() : f.companyId;
        if (companyId !== f.companyId) await db.insert(companies).values({ id: companyId, name: "Other allocation owner", issuePrefix: `F${companyId.slice(0, 6)}` });
        await db.insert(environmentLeases).values({ companyId, provider: "daytona", providerLeaseId: f.providerLeaseId,
          status: "released", leasePolicy: "reuse_by_environment" });
      }
      const before = await action(f.actionId);
      await recoverRetainedWorkspace(f.input);
      const after = await action(f.actionId);
      // An exhausted source that cannot be adopted is only handed to the board.
      // Its recovery state, evidence and retention stay untouched.
      const spent = readSystemRecovery(before.evidence)?.state === "exhausted" && before.ownerType === "system";
      const stable = (row: typeof after) => ({ ...row, updatedAt: null, ownerType: null, nextAction: null,
        evidence: { ...row.evidence, workspaceRecovery: { ...(row.evidence.workspaceRecovery as object), message: null } } });
      if (spent) {
        expect(after).toMatchObject({ ownerType: "board", nextAction: expect.stringMatching(/Paperclip refused to recover the saved files: .*Retry runs the check again/) });
        expect(stable(after)).toEqual(stable(before));
      } else expect(after).toEqual(before);
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0].leasePolicy).toBe("reuse_by_environment");
      expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
      expect(f.runtime.retryPendingSandboxTeardown).not.toHaveBeenCalled();
    },
  );

  it.each(["retained", "removed", "child", "expired-owner", "no-descriptor"])("preserves an old sandbox after storage migration without writing its old host (%s)", async mode => {
    vi.stubEnv("DATABASE_URL", connectionString);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "63".repeat(32));
    const f = await seed("native", mode !== "no-descriptor");
    // The fixture's command runner supports native copyback; the provider
    // snapshot boundary separately needs its real-file syncOut capability.
    targets.get(f.lease.id)!.runner!.syncIn = async operations => {
      for (const operation of operations) for (const file of operation.files)
        await cp(file.sourcePath, file.targetPath, { recursive: true, dereference: false });
      return { filesTransferred: 2, bytesTransferred: 0, operations: [] };
    };
    targets.get(f.lease.id)!.runner!.syncOut = async operations => {
      for (const operation of operations) for (const file of operation.files)
        await cp(file.sourcePath, file.targetPath, { recursive: true, dereference: false });
      return { filesTransferred: 2, bytesTransferred: 0, operations: [] };
    };
    if (mode === "no-descriptor") {
      const secondId = randomUUID(), secondProviderId = randomUUID(), secondRemote = path.join(root, secondId);
      await cp(f.remote, secondRemote, { recursive: true });
      const second: typeof f.lease = { ...f.lease, id: secondId, providerLeaseId: secondProviderId,
        metadata: { ...f.lease.metadata, remoteCwd: secondRemote } };
      second.metadata = { ...second.metadata,
        remoteExecutionTermination: remoteTerminationReceipt(second, { providerLeaseId: secondProviderId, state: "stopped" }) };
      await db.insert(environmentLeases).values(second);
      targets.set(secondId, { ...targets.get(f.lease.id)!, leaseId: secondId, remoteCwd: secondRemote });
      f.runtime.retryPendingSandboxTeardown.mockImplementation(async ({ lease }) => ({
        providerLeaseId: lease.providerLeaseId!, state: "stopped",
      }));
      f.runtime.resumeRunLease.mockImplementation(async ({ lease }) => ({ providerLeaseId: lease.providerLeaseId!,
        metadata: { remoteCwd: lease.metadata!.remoteCwd as string } }));
      const source = await run(f.runId);
      await db.update(heartbeatRuns).set({ resultJson: { ...source.resultJson,
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.lease.id, secondId] },
      } }).where(eq(heartbeatRuns.id, f.runId));
    }
    const sourceIssueId = mode === "child" ? randomUUID() : f.issueId;
    if (mode === "child") {
      await db.insert(issues).values({ id: sourceIssueId, companyId: f.companyId, title: "Ancestor workspace owner" });
      await db.update(issues).set({ parentId: sourceIssueId }).where(eq(issues.id, f.issueId));
    }
    await db.insert(executionWorkspaces).values({ id: f.issueId, companyId: f.companyId, sourceIssueId,
      name: "Existing files", mode: "isolated_workspace", strategyType: "project_primary", providerType: "local_fs", cwd: f.host });
    await db.update(issues).set({ executionWorkspaceId: f.issueId }).where(eq(issues.id, f.issueId));
    if (mode === "expired-owner" || mode === "no-descriptor") await db.update(nativeRunFinalizations).set({ phase: "observed",
      leaseOwner: "stopped-old-controller", leaseExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    try {
      await migrateRemoteWorkspace({ db, storage: getStorageService(), companyId: f.companyId,
        workspaceId: f.issueId, apply: true, writersStopped: true });
      if (mode !== "retained") await rm(f.host, { recursive: true });
      await requestWorkspaceRecovery({ ...f, idempotencyKey: randomUUID(), actorId: "board" });
      await recoverRetainedWorkspace(f.input);
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
      expect(await readFile(path.join(f.host, "saved.txt")).catch(() => null)).toBeNull();
      expect(await run(f.runId)).toMatchObject({ status: "failed", runnerProfileJson: mode === "no-descriptor" ? {} : { nativeWorkspaceSync: { state: "prepared" } } });
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ workspaceRepairRequired: false });
      const restored = path.join(root, randomUUID()); await mkdir(restored);
      const copies = await attachPreservedWorkspaceSnapshots({ db, companyId: f.companyId, issueId: f.issueId,
        sourceRunIds: [f.runId], cwd: restored });
      expect(copies).toHaveLength(mode === "no-descriptor" ? 2 : 1);
      expect(await readFile(path.join(copies[0]!.path, "files", "saved.txt"), "utf8")).toBe("finished work\n");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
      if (mode === "no-descriptor") {
        const source = await run(f.runId);
        await db.update(heartbeatRuns).set({ resultJson: { ...source.resultJson,
          workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.lease.id] },
        } }).where(eq(heartbeatRuns.id, f.runId));
        expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
        await db.update(heartbeatRuns).set({ resultJson: source.resultJson }).where(eq(heartbeatRuns.id, f.runId));
        for (const copy of copies) {
          await db.update(workspaceOperations).set({ status: "running" }).where(eq(workspaceOperations.id, copy.operationId));
          expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
          await db.update(workspaceOperations).set({ status: "succeeded" }).where(eq(workspaceOperations.id, copy.operationId));
        }
        const [allocation] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
        await db.update(environmentLeases).set({ providerLeaseId: randomUUID() }).where(eq(environmentLeases.id, f.lease.id));
        expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
        await db.update(environmentLeases).set({ providerLeaseId: allocation.providerLeaseId }).where(eq(environmentLeases.id, f.lease.id));
        expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
      }
      if (mode === "child" || mode === "expired-owner" || mode === "no-descriptor") {
        // The parent must not receive the child's task-scoped recovery copy.
        if (mode === "child") expect(await attachPreservedWorkspaceSnapshots({ db, companyId: f.companyId, issueId: sourceIssueId,
          sourceRunIds: [f.runId], cwd: restored })).toHaveLength(0);
        vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "false");
        const nextRunId = randomUUID(), nextLeaseId = randomUUID(), sourceRun = await run(f.runId);
        const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
          authorType: "user", authorUserId: "operator", body: "/new" }).returning();
        const continuationInput = { db, companyId: f.companyId, issueId: f.issueId,
          agentId: sourceRun.agentId, actorType: "user", actorId: "operator", reason: "issue_commented",
          commentId: comment.id, successorRunId: nextRunId };
        if (mode === "expired-owner" || mode === "no-descriptor") {
          for (const changed of [{ phase: "retryable_failure", leaseOwner: null }, { phase: "observed", leaseOwner: "new-controller" }]) {
            await db.update(nativeRunFinalizations).set(changed).where(eq(nativeRunFinalizations.runId, f.runId));
            expect(await admitExplicitNativeContinuation({ ...continuationInput, dryRun: true })).toBeNull();
          }
          await db.update(nativeRunFinalizations).set({ phase: "observed", leaseOwner: null }).where(eq(nativeRunFinalizations.runId, f.runId));
          await db.update(heartbeatRuns).set({ runnerProfileJson: { ...sourceRun.runnerProfileJson,
            legacyWorkspaceRecoveryMigration: { invalid: true } } }).where(eq(heartbeatRuns.id, f.runId));
          expect(await admitExplicitNativeContinuation({ ...continuationInput, dryRun: true })).toBeNull();
          await db.update(heartbeatRuns).set({ runnerProfileJson: sourceRun.runnerProfileJson }).where(eq(heartbeatRuns.id, f.runId));
        }
        expect(await admitExplicitNativeContinuation(continuationInput)).toMatchObject({ previousRunId: f.runId, commentId: comment.id });
        await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId, agentId: sourceRun.agentId,
          nativeIssueId: f.issueId, runtimeMode: "native", status: "running" });
        const storage = { ...getStorageService(), provider: "s3" as const };
        const reserved = await reserveRemoteWorkspace({ db, storage, companyId: f.companyId, issueId: f.issueId,
          runId: nextRunId, agentId: sourceRun.agentId, environmentId: f.lease.environmentId!,
          projectId: null, projectWorkspaceId: null, existingWorkspaceId: f.issueId, source: { kind: "empty" } });
        const [lease] = await db.insert(environmentLeases).values({ id: nextLeaseId, companyId: f.companyId,
          issueId: f.issueId, heartbeatRunId: nextRunId, environmentId: f.lease.environmentId,
          provider: "daytona", providerLeaseId: randomUUID(), status: "active" }).returning();
        const nextRoot = path.join(root, nextRunId); await mkdir(nextRoot);
        const target = { ...targets.get(f.lease.id)!, leaseId: nextLeaseId, remoteCwd: await realpath(nextRoot) };
        const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved,
          runId: nextRunId, lease: lease as EnvironmentLease, target });
        expect(prepared.workspace.sourceIssueId).toBe(sourceIssueId);
        expect(await readFile(path.join(prepared.remoteRoot, ".paperclip-recovered", copies[0]!.operationId, "files", "saved.txt"), "utf8"))
          .toBe("finished work\n");
      }
      if (mode === "retained" || mode === "no-descriptor") {
        const [receipt] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, copies[0]!.operationId));
        for (const metadata of [{ ...receipt.metadata, leaseId: randomUUID() }, { ...receipt.metadata, providerLeaseId: randomUUID() },
          { ...receipt.metadata, recoveryActionId: randomUUID() }, { ...receipt.metadata, archive: { broken: true } }]) {
          await db.update(workspaceOperations).set({ metadata }).where(eq(workspaceOperations.id, receipt.id));
          expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
        }
        await db.update(workspaceOperations).set({ metadata: receipt.metadata, status: "running" }).where(eq(workspaceOperations.id, receipt.id));
        expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
        await db.update(workspaceOperations).set({ status: "succeeded" }).where(eq(workspaceOperations.id, receipt.id));
        expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
      }
    } finally {
      // This journey admits a successor; retire that fixture writer before the
      // next case exercises the instance-wide offline migration fence.
      await db.update(heartbeatRuns).set({ status: "cancelled" }).where(and(
        eq(heartbeatRuns.companyId, f.companyId), inArray(heartbeatRuns.status, ["queued", "running"])));
      vi.unstubAllEnvs();
    }
  }, 30_000);

  async function exhaustedAcceptedRemoteWriter(leasePolicy: "ephemeral" | "reuse_by_environment" = "ephemeral") {
    const f = await acceptedRemoteExport();
    await db.update(issueRecoveryActions).set({ status: "cancelled", cause: "native_workspace_sync_out_failed",
      evidence: { runId: f.runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
    }).where(eq(issueRecoveryActions.id, f.actionId));
    await db.update(heartbeatRuns).set({ errorCode: "native_workspace_sync_out_retry_exhausted" })
      .where(eq(heartbeatRuns.id, f.runId));
    const [lease] = await db.update(environmentLeases).set({ leasePolicy })
      .where(eq(environmentLeases.id, f.lease.id)).returning();
    const stopping = (await prepareStoppedSandboxForRecovery(db, lease))!;
    const stopped = (await settleStopOnlyCleanup(db, stopping, {
      attemptId: String(stopping.metadata!.pendingCleanupAttemptId),
      receipt: { providerLeaseId: f.providerLeaseId, state: "stopped" },
    }))!;
    const source = await run(f.runId);
    const [preparation] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId,
      issueId: f.issueId, runtimeMode: "legacy", status: "failed", executionStage: "preparing",
      startedAt: new Date(), finishedAt: new Date(), errorCode: "setup_failed",
      error: "The workspace still has an unfinished writer or save operation.",
      contextSnapshot: { issueId: f.issueId, executionWorkspaceId: f.workspaceId },
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    }).returning();
    return { ...f, stopped, preparation };
  }

  it.each(["bound writer", "orphaned lease", "reusable writer"] as const)("retains an exhausted accepted remote copy-back through its %s", async entry => {
    const f = await exhaustedAcceptedRemoteWriter(entry === "reusable writer" ? "reuse_by_environment" : "ephemeral");
    const [result] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.resultId));
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const historical = await action(f.actionId);
    if (entry === "orphaned lease") expect(await preserveOrphanedNativeWorkspace(db, f.stopped)).toBe(true);
    else await preserveTaskRemoteWorkspaceWriter(db, f.companyId, f.issueId);
    expect((await run(f.runId)).resultJson).toMatchObject({ workspaceRestoreFailure: "restore_failed",
      workspaceRestoreRecovery: { leaseIds: [f.lease.id] } });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "terminal_failure", resultId: result.id, leaseOwner: null });
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.resultId)))[0]).toEqual(result);
    expect(await action(f.actionId)).toEqual(historical);
    expect(await run(f.preparation.id)).toEqual(f.preparation);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toEqual(task);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(2);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
  }, 30_000);

  it.each(["active-finalizer", "retryable", "other-failure", "live-controller", "unfinished-run", "missing-stop",
    "rejected-result", "new-writer", "saved-workspace", "wrong-epoch", "native-sync", "source-binding"] as const)(
    "keeps accepted remote copy-back held when its %s proof changes", async gate => {
    const f = await exhaustedAcceptedRemoteWriter();
    const source = await run(f.runId);
    if (gate === "active-finalizer") await db.update(nativeRunFinalizations).set({ leaseOwner: "live-finalizer" })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    if (gate === "retryable") await db.update(nativeRunFinalizations).set({ phase: "retryable_failure" })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    if (gate === "other-failure") await db.update(nativeRunFinalizations).set({ failureCode: "native_workspace_sync_out_unsafe_archive" })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    if (gate === "live-controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(heartbeatRuns.id, f.runId));
    if (gate === "unfinished-run") await db.update(heartbeatRuns).set({ finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    if (gate === "missing-stop") await db.update(environmentLeases).set({ metadata: { ...f.stopped.metadata,
      remoteExecutionTermination: null } }).where(eq(environmentLeases.id, f.lease.id));
    if (gate === "rejected-result") await db.update(nativeRunResults).set({ schemaStatus: "rejected" })
      .where(eq(nativeRunResults.id, f.resultId));
    if (gate === "new-writer" || gate === "saved-workspace") {
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
      const authority = readRemoteWorkspaceAuthority(workspace.metadata)!;
      await db.update(executionWorkspaces).set({ metadata: { ...workspace.metadata, remoteWorkspace: { ...authority,
        writerRunId: gate === "new-writer" ? randomUUID() : null, dirty: gate === "new-writer" } } })
        .where(eq(executionWorkspaces.id, f.workspaceId));
    }
    if (gate === "wrong-epoch") await db.update(heartbeatRuns).set({ runnerProfileJson: { ...source.runnerProfileJson,
      remoteWorkspace: { ...(source.runnerProfileJson!.remoteWorkspace as object), epoch: 99 } } }).where(eq(heartbeatRuns.id, f.runId));
    if (gate === "native-sync") await db.update(heartbeatRuns).set({ runnerProfileJson: { ...source.runnerProfileJson,
      nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v3" } } }).where(eq(heartbeatRuns.id, f.runId));
    if (gate === "source-binding") await db.update(environmentLeases).set({ metadata: { ...f.stopped.metadata, remoteCwd: "/other" } })
      .where(eq(environmentLeases.id, f.lease.id));
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    const [result] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.resultId));
    await preserveTaskRemoteWorkspaceWriter(db, f.companyId, f.issueId);
    expect((await run(f.runId)).resultJson).not.toHaveProperty("workspaceRestoreRecovery");
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0]).toEqual(lease);
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.resultId)))[0]).toEqual(result);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(1);
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
  }, 30_000);

  it("repairs an older accepted remote writer before one HTTP Retry continues a newer failed preparation", async () => {
    const f = await exhaustedAcceptedRemoteWriter();
    const [result] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.resultId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.preparation.agentId, status: "running" });
    const receipt = (await request(receiptOnlyRecoveryApp()).post(`/api/issues/${f.issueId}/retry`)
      .send({ observedRunId: f.preparation.id, idempotencyKey: randomUUID() }).expect(202)).body;
    expect((await run(f.runId)).resultJson).toHaveProperty("workspaceRestoreRecovery");
    const records = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId));
    const preservation = records.find(record => record.id !== f.actionId && record.evidence.runId === f.runId
      && record.evidence.workspaceRestoreRecovery)!;
    expect(preservation).toBeDefined();
    const input = { ...f.input, actionId: preservation.id };
    await adoptSystemRecovery(db, input);
    await recoverRetainedWorkspace(input);
    expect(readWorkspaceRecovery((await action(preservation.id)).evidence)?.status).toBe("recovered");
    const heartbeat = heartbeatService(db);
    await Promise.all([heartbeat.resumeTaskRetry(f.companyId, receipt.requestId),
      heartbeat.resumeTaskRetry(f.companyId, receipt.requestId)]);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${receipt.requestId}`));
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ status: "queued", contextSnapshot: { previousRunId: f.preparation.id } });
    const recovered = await run(f.runId), reference = recovered.runnerProfileJson!.remoteWorkspace as { snapshotId: string };
    const saved = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId: f.workspaceId,
      snapshotId: reference.snapshotId });
    try { expect(await readFile(path.join(saved.root, "saved.txt"), "utf8")).toBe("finished work\n"); }
    finally { await saved.cleanup(); }
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.resultId)))[0]).toEqual(result);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "terminal_failure", resultId: result.id });
    expect(await run(f.preparation.id)).toEqual(f.preparation);
  }, 30_000);

  async function pressuredToolCache(pressure: "transfer" | "sandbox-write" = "transfer") {
    const f = await acceptedRemoteExport();
    const runner = path.join(f.remote, ".paperclip-runtime", "paperclip-runner");
    const pack = path.join(runner, "provider-pack"), sessions = path.join(runner, "sessions", "retained");
    await mkdir(path.join(pack, "node_modules"), { recursive: true });
    await mkdir(path.join(pack, "provider-assets")); await mkdir(sessions, { recursive: true });
    await writeFile(path.join(pack, "node_modules", "installed-tool"), "rebuildable dependency\n");
    await writeFile(path.join(pack, "provider-assets", "installed-agent"), "rebuildable provider\n");
    await writeFile(path.join(sessions, "pending-receipt.json"), "uncertain action history\n");
    const payload = { target: { platform: "linux", architecture: "x64" } };
    const digest = `sha256:${createHash("sha256").update(canonicalProviderPackJson(payload)).digest("hex")}`;
    await writeFile(path.join(pack, "provider-pack.json"), JSON.stringify({
      schema: "paperclip-runner/remote-provider-pack/v1", digest, payload,
    }));
    const before = await run(f.runId);
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...before.runnerProfileJson,
      nativeProviderPackAdmissionState: { schema: "paperclip.native-provider-pack-admission-state.v1",
        state: "verified", admissionEpoch: randomUUID() },
      nativeProviderPackAdmission: { schema: "paperclip.native-provider-pack-admission.v1", stage: "session_admitted",
        authority: "core_verified_selection", runId: f.runId, companyId: f.companyId, agentId: before.agentId,
        providerPackDigest: digest },
    } }).where(eq(heartbeatRuns.id, f.runId));
    const target = targets.get(f.lease.id)!, syncOut = target.runner!.syncOut!, execute = target.runner!.execute;
    let transfers = 0, sandboxWriteFailures = 0;
    const readonlyExports: Array<Parameters<typeof syncOut>[0][number]["files"][number]> = [];
    if (pressure === "sandbox-write") target.runner!.execute = async input => {
      const fault = `(()=>{const fs=require('node:fs/promises'),sync=require('node:fs');
        const full=()=>${JSON.stringify([path.join(pack, "node_modules"), path.join(pack, "provider-assets")])}.some(p=>sync.existsSync(p));
        const statfs=fs.statfs;fs.statfs=async(...args)=>{const value=await statfs(...args);
          return full()?{...value,bavail:typeof value.bavail==='bigint'?0n:0}:value;};
        for(const name of ['mkdir','writeFile','appendFile','mkdtemp','copyFile','rename','open']){
          const original=fs[name];fs[name]=async(...args)=>{
            const writes=name!=='open'||typeof args[1]!=='string'||/[wa+]/.test(args[1]);
            if(full()&&writes&&!(name==='mkdir'&&sync.existsSync(args[0])))throw Object.assign(new Error('No space left on device'),{code:'ENOSPC'});
            return original(...args);};}})();`;
      const args = input.command === "node" && input.args?.[0] === "-e"
        ? ["-e", fault + input.args[1], ...input.args.slice(2)] : input.args;
      const response = await execute({ ...input, args });
      if (response.stderr === REMOTE_WORKSPACE_SANDBOX_DISK_FULL) sandboxWriteFailures++;
      return response;
    };
    target.runner!.syncOut = async operations => {
      const mappings = operations.flatMap(operation => operation.files);
      if (mappings.some(mapping => mapping.kind === "directory")) {
        // These regressions isolate journaled cache reclamation after BOTH
        // export paths fail. Directory-export recovery has its own real-provider
        // coverage; this boundary explicitly cannot perform that alternative.
        readonlyExports.push(...mappings);
        throw new Error("cache-reclaim fixture directory export unavailable");
      }
      transfers++;
      if (pressure === "transfer" && (await Promise.all(["node_modules", "provider-assets"].map(name =>
        lstat(path.join(pack, name)).then(() => true, () => false)))).some(Boolean))
        throw new Error(REMOTE_WORKSPACE_SANDBOX_DISK_FULL);
      return syncOut(operations);
    };
    return { ...f, runner, pack, sessions, digest, transfers: () => transfers, readonlyExports,
      sandboxWriteFailures: () => sandboxWriteFailures };
  }

  it("recovers when sandbox writes fail before any archive can be created", async () => {
    const f = await pressuredToolCache("sandbox-write");
    const target = targets.get(f.lease.id)!, execute = target.runner!.execute;
    const staging = path.join(f.remote, ".paperclip-runtime", "workspace-snapshots");
    const before = await readdir(staging).catch(() => []);
    let committedPreparation = false;
    target.runner!.execute = async input => {
      if (input.args?.[2] === "reclaim") {
        const records = await withDedicatedDbConnection(db, observer => observer.select().from(workspaceOperations).where(and(
          eq(workspaceOperations.companyId, f.companyId), eq(workspaceOperations.heartbeatRunId, f.runId),
          eq(workspaceOperations.phase, "native_provider_cache_reclaim_prepare"))));
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ status: "succeeded", metadata: { intentOnly: true,
          inventory: { availableBytesBefore: 0 } } });
        expect(await readdir(staging).catch(() => [])).toEqual(before);
        committedPreparation = true;
      }
      return execute(input);
    };
    await recoverRetainedWorkspace(f.input);
    expect(committedPreparation).toBe(true);
    expect(f.sandboxWriteFailures()).toBe(1);
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).toBe("recovered");
    expect(f.transfers()).toBe(1);
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    const authority = readRemoteWorkspaceAuthority(workspace.metadata)!;
    const saved = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId: f.workspaceId,
      snapshotId: authority.snapshotId! });
    try { expect(await readFile(path.join(saved.root, "saved.txt"), "utf8")).toBe("finished work\n"); }
    finally { await saved.cleanup(); }
    const [prepared] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, f.companyId),
      eq(workspaceOperations.phase, "native_provider_cache_reclaim_prepare")));
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.preservationOperationIds).not.toContain(prepared.id);
    expect(await readFile(path.join(f.sessions, "pending-receipt.json"), "utf8")).toBe("uncertain action history\n");
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
  }, 30_000);

  it("reclaims only a verified inactive tool installation before retrying the same workspace save", async () => {
    const f = await pressuredToolCache();
    await recoverRetainedWorkspace(f.input);
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).toBe("recovered");
    expect(f.transfers()).toBe(2);
    expect(f.readonlyExports).toEqual([{ kind: "directory", sourcePath: await realpath(f.remote),
      targetPath: expect.stringMatching(/[/]source$/), followSymlinks: false, preserveSourceEntries: true,
      exclude: [".paperclip-runtime"] }]);
    await expect(lstat(path.join(f.pack, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(f.pack, "provider-assets"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(path.join(f.pack, "provider-pack.json"), "utf8")).digest).toBe(f.digest);
    expect(await readFile(path.join(f.sessions, "pending-receipt.json"), "utf8")).toBe("uncertain action history\n");
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    const authority = readRemoteWorkspaceAuthority(workspace.metadata)!;
    const saved = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId: f.workspaceId,
      snapshotId: authority.snapshotId! });
    try { expect(await readFile(path.join(saved.root, "saved.txt"), "utf8")).toBe("finished work\n"); }
    finally { await saved.cleanup(); }
    const audits = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, f.companyId),
      eq(workspaceOperations.phase, "native_provider_cache_reclaim")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ status: "succeeded", heartbeatRunId: f.runId,
      metadata: { manifestDigest: f.digest, changed: true, sessionDirectoryPreserved: true } });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
  }, 30_000);

  it("keeps lost cache acknowledgements separate from later verified workspace preservation", async () => {
    const f = await pressuredToolCache(), target = targets.get(f.lease.id)!, execute = target.runner!.execute;
    let lost = false;
    target.runner!.execute = async input => {
      const result = await execute(input);
      if (!lost && input.args?.[2] === "reclaim") {
        lost = true;
        return { ...result, exitCode: null, timedOut: true, stdout: "", stderr: "" };
      }
      return result;
    };
    await recoverRetainedWorkspace(f.input);
    expect(lost).toBe(true);
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).not.toBe("recovered");
    expect(f.transfers()).toBe(1);
    const [audit] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, f.companyId),
      eq(workspaceOperations.phase, "native_provider_cache_reclaim")));
    expect(audit).toMatchObject({ status: "failed", metadata: { outcome: "unconfirmed" } });
    await makeRetryDue(f.actionId);
    await recoverRetainedWorkspace(f.input);
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).toBe("recovered");
    expect(f.transfers()).toBe(2);
    expect(await readFile(path.join(f.sessions, "pending-receipt.json"), "utf8")).toBe("uncertain action history\n");
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
  }, 30_000);

  it("does not delete caches when Core cannot commit the prepared journal", async () => {
    const f = await pressuredToolCache("sandbox-write"), trigger = `cache_prepare_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'test cache preparation write failed'; END $$`));
    try {
      await db.execute(sql.raw(`CREATE TRIGGER ${trigger} BEFORE INSERT ON workspace_operations FOR EACH ROW
        WHEN (NEW.company_id = '${f.companyId}'::uuid AND NEW.phase = 'native_provider_cache_reclaim_prepare')
        EXECUTE FUNCTION ${trigger}()`));
      await recoverRetainedWorkspace(f.input);
      expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).not.toBe("recovered");
      expect(f.sandboxWriteFailures()).toBe(1);
      expect(f.transfers()).toBe(0);
      expect(await readFile(path.join(f.pack, "node_modules", "installed-tool"), "utf8")).toBe("rebuildable dependency\n");
      expect(await readFile(path.join(f.pack, "provider-assets", "installed-agent"), "utf8")).toBe("rebuildable provider\n");
      expect(await readFile(path.join(f.sessions, "pending-receipt.json"), "utf8")).toBe("uncertain action history\n");
      const records = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, f.companyId),
        eq(workspaceOperations.phase, "native_provider_cache_reclaim_prepare")));
      expect(records).toHaveLength(0);
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${trigger} ON workspace_operations`));
      await db.execute(sql.raw(`DROP FUNCTION ${trigger}()`));
    }
  }, 30_000);

  it("does not reclaim a replacement after an acknowledged cleanup and a later save failure", async () => {
    const f = await pressuredToolCache(), target = targets.get(f.lease.id)!, syncOut = target.runner!.syncOut!;
    let transfers = 0;
    target.runner!.syncOut = async operations => {
      // Fail the second sealed-archive transfer, after cache cleanup, rather
      // than consuming this fault on the earlier read-only directory fallback.
      if (operations.some(operation => operation.files.some(mapping => mapping.kind === "directory"))) return syncOut(operations);
      if (++transfers === 2) throw new Error("controlled later transfer failure");
      return syncOut(operations);
    };
    await recoverRetainedWorkspace(f.input);
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).not.toBe("recovered");
    const [completed] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, f.companyId),
      eq(workspaceOperations.phase, "native_provider_cache_reclaim"), eq(workspaceOperations.status, "succeeded")));
    expect(completed.metadata).toMatchObject({ outcome: "evicted", changed: true });
    await mkdir(path.join(f.pack, "node_modules"));
    await writeFile(path.join(f.pack, "node_modules", "replacement-tool"), "replacement installation\n");
    let repeatedDeletion = false;
    const execute = target.runner!.execute;
    target.runner!.execute = async input => {
      if (input.args?.[2] === "reclaim") repeatedDeletion = true;
      return execute(input);
    };
    await makeRetryDue(f.actionId);
    await recoverRetainedWorkspace(f.input);
    expect(repeatedDeletion).toBe(false);
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).not.toBe("recovered");
    expect(await readFile(path.join(f.pack, "node_modules", "replacement-tool"), "utf8")).toBe("replacement installation\n");
    expect(await readFile(path.join(f.sessions, "pending-receipt.json"), "utf8")).toBe("uncertain action history\n");
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
  }, 30_000);

  it.each(["unchanged", "replaced"])("resumes a Core-prepared deletion only for an %s installation", async installation => {
    const f = await pressuredToolCache(), target = targets.get(f.lease.id)!, execute = target.runner!.execute;
    const interruptedTarget = await realpath(path.join(f.pack, "node_modules"));
    let interrupted = false;
    target.runner!.execute = async input => {
      if (!interrupted && input.args?.[2] === "reclaim") {
        interrupted = true;
        const fault = `(()=>{const fs=require('node:fs/promises'),remove=fs.rm;
          fs.rm=async(p,options)=>{const result=await remove(p,options);
            if(p===${JSON.stringify(interruptedTarget)})process.exit(77);return result;};})();`;
        return execute({ ...input, args: ["-e", fault + input.args[1], ...input.args.slice(2)] });
      }
      return execute(input);
    };
    await recoverRetainedWorkspace(f.input);
    expect(interrupted).toBe(true);
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).not.toBe("recovered");
    await expect(lstat(path.join(f.pack, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(f.pack, "provider-assets", "installed-agent"), "utf8")).toBe("rebuildable provider\n");
    if (installation === "replaced") {
      await mkdir(path.join(f.pack, "node_modules"));
      await writeFile(path.join(f.pack, "node_modules", "replacement-tool"), "replacement installation\n");
    }
    await makeRetryDue(f.actionId);
    await recoverRetainedWorkspace(f.input);
    if (installation === "unchanged") {
      expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).toBe("recovered");
      expect(f.transfers()).toBe(3);
      await expect(lstat(path.join(f.pack, "provider-assets"))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).not.toBe("recovered");
      expect(f.transfers()).toBe(2);
      expect(await readFile(path.join(f.pack, "node_modules", "replacement-tool"), "utf8")).toBe("replacement installation\n");
      expect(await readFile(path.join(f.pack, "provider-assets", "installed-agent"), "utf8")).toBe("rebuildable provider\n");
    }
    const preparations = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, f.companyId),
      eq(workspaceOperations.phase, "native_provider_cache_reclaim_prepare")));
    expect(preparations).toHaveLength(1);
    expect(await readFile(path.join(f.sessions, "pending-receipt.json"), "utf8")).toBe("uncertain action history\n");
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
  }, 30_000);

  it.each(["unchanged", "full_disk", "replacement", "staged_replacement", "marker_replaced"])(
    "resumes deletion interrupted inside a cache without directory creation times: %s", async scenario => {
    const f = await pressuredToolCache(), target = targets.get(f.lease.id)!, execute = target.runner!.execute;
    await writeFile(path.join(f.pack, "node_modules", "installed-tool"), Buffer.alloc(1024 * 1024, 7));
    await writeFile(path.join(f.pack, "node_modules", "remaining-tool"), "remaining rebuildable dependency\n");
    const interruptedTarget = await realpath(path.join(f.pack, "node_modules"));
    let interrupted = false, cleanupConfirmed = false;
    const syncOut = target.runner!.syncOut!;
    target.runner!.syncOut = async operations => {
      if (!cleanupConfirmed) throw new Error(REMOTE_WORKSPACE_SANDBOX_DISK_FULL);
      return syncOut(operations);
    };
    target.runner!.execute = async input => {
      if (input.command !== "node" || input.args?.[0] !== "-e") return execute(input);
      let fault = `(()=>{const fs=require('node:fs/promises'),stat=fs.lstat,open=fs.open;
        fs.lstat=async(...args)=>{const value=await stat(...args);
          if(args[1]?.bigint)value.birthtimeNs=0n;return value;};
        fs.open=async(...args)=>{const handle=await open(...args),stat=handle.stat.bind(handle);
          handle.stat=async(...args)=>{const value=await stat(...args);if(args[0]?.bigint)value.birthtimeNs=0n;return value;};return handle;};})();`;
      if (scenario === "full_disk") fault += `(()=>{const fs=require('node:fs/promises'),sync=require('node:fs');
        const full=()=>{try{return sync.statSync(${JSON.stringify(path.join(f.pack, "node_modules", "installed-tool"))}).size>0;}catch{return false;}};
        const statfs=fs.statfs;fs.statfs=async(...args)=>{const value=await statfs(...args);return full()?{...value,bavail:0}:value;};
        for(const name of ['mkdir','writeFile','appendFile','mkdtemp','copyFile','rename','open']){
          const original=fs[name];fs[name]=async(...args)=>{const writes=name!=='open'||(typeof args[1]==='number'
            ?!!(args[1]&(sync.constants.O_CREAT|sync.constants.O_TRUNC)):typeof args[1]==='string'&&/[wa]/.test(args[1]));
            if(full()&&writes&&!(name==='mkdir'&&sync.existsSync(args[0])))throw Object.assign(new Error('No space left on device'),{code:'ENOSPC'});
            return original(...args);};}})();`;
      if (input.args[2] === "reclaim") {
        const [prepared] = await withDedicatedDbConnection(db, observer => observer.select().from(workspaceOperations).where(and(
          eq(workspaceOperations.companyId, f.companyId), eq(workspaceOperations.phase, "native_provider_cache_reclaim_prepare"))));
        expect(prepared.metadata?.staged).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "node_modules", marker: expect.objectContaining({ generation: expect.stringMatching(/^c:/) }) }),
        ]));
      }
      if (!interrupted && input.args[2] === "reclaim") {
        interrupted = true;
        fault += `(()=>{const fs=require('node:fs/promises'),path=require('node:path'),remove=fs.rm;
          fs.rm=async(p,options)=>{if(p===${JSON.stringify(interruptedTarget)}||p.startsWith(${JSON.stringify(interruptedTarget + ".paperclip-reclaim-")})){
            await fs.unlink(path.join(p===${JSON.stringify(interruptedTarget)}?p:path.dirname(p),'installed-tool'));process.exit(77);
          }return remove(p,options);};})();`;
      }
      const result = await execute({ ...input, args: ["-e", fault + input.args[1], ...input.args.slice(2)] });
      if (input.args[2] === "reclaim" && result.exitCode === 0) cleanupConfirmed = true;
      return result;
    };
    await recoverRetainedWorkspace(f.input);
    expect(interrupted).toBe(true);
    expect(cleanupConfirmed).toBe(false);
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).not.toBe("recovered");
    const [prepared] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, f.companyId),
      eq(workspaceOperations.phase, "native_provider_cache_reclaim_prepare")));
    const staged = path.join(f.pack, `node_modules.paperclip-reclaim-${prepared.id}`);
    const interruptedDirectory = await lstat(staged).then(() => staged, () => path.join(f.pack, "node_modules"));
    await expect(lstat(path.join(interruptedDirectory, "installed-tool"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(path.join(interruptedDirectory, "remaining-tool"))).isFile()).toBe(true);
    const remainingBeforeRetry = await readFile(path.join(interruptedDirectory, "remaining-tool"), "utf8");
    if (scenario === "replacement") {
      await mkdir(path.join(f.pack, "node_modules"));
      await writeFile(path.join(f.pack, "node_modules", "replacement-tool"), "replacement installation\n");
    }
    if (scenario === "staged_replacement") {
      await rename(staged, `${staged}.original`);
      await mkdir(staged);
      await writeFile(path.join(staged, "replacement-tool"), "replacement installation\n");
    }
    if (scenario === "marker_replaced") {
      const marker = path.join(staged, `.paperclip-reclaim-${prepared.id}.json`), bytes = await readFile(marker);
      await rename(marker, `${marker}.original`);
      await writeFile(marker, bytes);
    }
    await makeRetryDue(f.actionId);
    await recoverRetainedWorkspace(f.input);
    if (["unchanged", "full_disk"].includes(scenario)) {
      expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).toBe("recovered");
      expect(cleanupConfirmed).toBe(true);
      expect(await readdir(staged)).toEqual([`.paperclip-reclaim-${prepared.id}.json`]);
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
      const authority = readRemoteWorkspaceAuthority(workspace.metadata)!;
      const saved = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId: f.workspaceId, snapshotId: authority.snapshotId! });
      try { expect(await readFile(path.join(saved.root, "saved.txt"), "utf8")).toBe("finished work\n"); }
      finally { await saved.cleanup(); }
    } else {
      expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).not.toBe("recovered");
      expect(cleanupConfirmed).toBe(false);
      if (scenario === "replacement") expect(await readFile(path.join(f.pack, "node_modules", "replacement-tool"), "utf8")).toBe("replacement installation\n");
      if (scenario === "staged_replacement") expect(await readFile(path.join(staged, "replacement-tool"), "utf8")).toBe("replacement installation\n");
      else expect(await readFile(path.join(staged, "remaining-tool"), "utf8")).toBe(remainingBeforeRetry);
    }
    expect(await readFile(path.join(f.sessions, "pending-receipt.json"), "utf8")).toBe("uncertain action history\n");
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
  }, 30_000);

  it.each(["space_available", "later_cache", "denied_open"])("recovers read-only provider assets without directory creation times: %s", async scenario => {
    const f = await pressuredToolCache(), target = targets.get(f.lease.id)!, execute = target.runner!.execute;
    const assets = path.join(f.pack, "provider-assets"), executable = path.join(assets, "cursor-executable");
    const metadata = path.join(assets, "cursor-metadata.json"), writable = path.join(assets, "installed-agent");
    await writeFile(executable, "immutable executable\n"); await chmod(executable, 0o500);
    await writeFile(metadata, "immutable metadata\n"); await chmod(metadata, 0o400);
    await writeFile(writable, Buffer.alloc(1024 * 1024, 7));
    const dependency = path.join(f.pack, "node_modules", "installed-tool");
    if (scenario === "later_cache") await chmod(dependency, 0o500);
    let inspected = false;
    target.runner!.execute = async input => {
      if (input.command !== "node" || input.args?.[0] !== "-e") return execute(input);
      if (input.args[2] === "reclaim") {
        const [prepared] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, f.companyId),
          eq(workspaceOperations.phase, "native_provider_cache_reclaim_prepare")));
        const staged = path.join(f.pack, `provider-assets.paperclip-reclaim-${prepared.id}`);
        expect(await readFile(path.join(staged, "cursor-executable"), "utf8")).toBe("immutable executable\n");
        expect((await lstat(path.join(staged, "cursor-executable"))).mode & 0o777).toBe(0o500);
        expect(await readFile(path.join(staged, "cursor-metadata.json"), "utf8")).toBe("immutable metadata\n");
        expect((await lstat(path.join(staged, "cursor-metadata.json"))).mode & 0o777).toBe(0o400);
        if (scenario === "space_available") expect(await readFile(path.join(staged, "installed-agent"))).toEqual(Buffer.alloc(1024 * 1024, 7));
        inspected = true;
      }
      const fault = `(()=>{const fs=require('node:fs/promises'),sync=require('node:fs'),stat=fs.lstat,open=fs.open,statfs=fs.statfs;
        const full=()=>${JSON.stringify(scenario)}!=='space_available'&&(()=>{try{return sync.statSync(${JSON.stringify(writable)}).size>0;}catch{return false;}})();
        fs.statfs=async(...args)=>{const value=await statfs(...args);return full()?{...value,bavail:0}:value;};
        fs.lstat=async(...args)=>{const value=await stat(...args);if(args[1]?.bigint)value.birthtimeNs=0n;return value;};
        fs.open=async(...args)=>{if(typeof args[1]==='number'&&(args[1]&sync.constants.O_RDWR)){
          const value=sync.lstatSync(args[0]);if(!(value.mode&0o222)||(${JSON.stringify(scenario)}==='denied_open'&&args[0].endsWith('/node_modules/installed-tool')))
            throw Object.assign(new Error('Permission denied'),{code:'EACCES'});
          if(${JSON.stringify(scenario)}==='space_available')throw Error('unnecessary_cache_write');
        }
          const creates=typeof args[1]==='number'?!!(args[1]&(sync.constants.O_CREAT|sync.constants.O_TRUNC)):/[wa]/.test(args[1]);
          if(full()&&creates)throw Object.assign(new Error('No space left on device'),{code:'ENOSPC'});
          const handle=await open(...args),stat=handle.stat.bind(handle);
          handle.stat=async(...args)=>{const value=await stat(...args);if(args[0]?.bigint)value.birthtimeNs=0n;return value;};return handle;};})();`;
      return execute({ ...input, args: ["-e", fault + input.args[1], ...input.args.slice(2)] });
    };
    await recoverRetainedWorkspace(f.input);
    expect(inspected).toBe(true);
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).toBe("recovered");
    expect(await readFile(path.join(f.sessions, "pending-receipt.json"), "utf8")).toBe("uncertain action history\n");
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    const authority = readRemoteWorkspaceAuthority(workspace.metadata)!;
    const saved = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId: f.workspaceId, snapshotId: authority.snapshotId! });
    try { expect(await readFile(path.join(saved.root, "saved.txt"), "utf8")).toBe("finished work\n"); }
    finally { await saved.cleanup(); }
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
  }, 30_000);

  it.each(["acknowledgement", "journal", "marker_write"])("resumes cache staging after its %s is interrupted", async failure => {
    const f = await pressuredToolCache(), target = targets.get(f.lease.id)!, execute = target.runner!.execute;
    await writeFile(path.join(f.pack, "node_modules", "installed-tool"), Buffer.alloc(1024 * 1024, 7));
    await writeFile(path.join(f.pack, "node_modules", "remaining-tool"), "remaining rebuildable dependency\n");
    let lost = false, reclaimCalls = 0, cleanupConfirmed = false;
    const syncOut = target.runner!.syncOut!, trigger = `cache_stage_${randomUUID().replaceAll("-", "")}`;
    target.runner!.syncOut = async operations => {
      if (!cleanupConfirmed) throw new Error(REMOTE_WORKSPACE_SANDBOX_DISK_FULL);
      return syncOut(operations);
    };
    target.runner!.execute = async input => {
      if (input.command !== "node" || input.args?.[0] !== "-e") return execute(input);
      let fault = `(()=>{const fs=require('node:fs/promises'),stat=fs.lstat,open=fs.open;
        fs.lstat=async(...args)=>{const value=await stat(...args);if(args[1]?.bigint)value.birthtimeNs=0n;return value;};
        fs.open=async(...args)=>{const handle=await open(...args),stat=handle.stat.bind(handle);
          handle.stat=async(...args)=>{const value=await stat(...args);if(args[0]?.bigint)value.birthtimeNs=0n;return value;};return handle;};})();`;
      if (failure === "marker_write" && !lost && input.args[2] === "stage") {
        lost = true;
        fault += `(()=>{const fs=require('node:fs/promises'),open=fs.open;
          fs.open=async(...args)=>{const handle=await open(...args),write=handle.writeFile.bind(handle);
            if(args[0].includes('/.paperclip-reclaim-'))handle.writeFile=async bytes=>{await write(bytes.slice(0,32));process.exit(77);};
            return handle;};})();`;
      }
      const result = await execute({ ...input, args: ["-e", fault + input.args[1], ...input.args.slice(2)] });
      if (input.args[2] === "reclaim") { reclaimCalls++; if (result.exitCode === 0) cleanupConfirmed = true; }
      if (failure === "acknowledgement" && !lost && input.args[2] === "stage") {
        lost = true;
        return { ...result, exitCode: null, timedOut: true, stdout: "", stderr: "" };
      }
      return result;
    };
    if (failure === "journal") {
      await db.execute(sql.raw(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'test staged cache journal write failed'; END $$`));
      await db.execute(sql.raw(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON workspace_operations FOR EACH ROW
        WHEN (NEW.company_id = '${f.companyId}'::uuid AND NEW.phase = 'native_provider_cache_reclaim_prepare')
        EXECUTE FUNCTION ${trigger}()`));
    }
    try {
      await recoverRetainedWorkspace(f.input);
      expect(reclaimCalls).toBe(0);
      expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).not.toBe("recovered");
      const [prepared] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, f.companyId),
        eq(workspaceOperations.phase, "native_provider_cache_reclaim_prepare")));
      expect(prepared.metadata?.staged).toBeUndefined();
      const staged = path.join(f.pack, `node_modules.paperclip-reclaim-${prepared.id}`);
      const preserved = await lstat(staged).then(() => staged, () => path.join(f.pack, "node_modules"));
      expect((await lstat(path.join(preserved, "remaining-tool"))).isFile()).toBe(true);
    } finally {
      if (failure === "journal") {
        await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${trigger} ON workspace_operations`));
        await db.execute(sql.raw(`DROP FUNCTION ${trigger}()`));
      }
    }
    await makeRetryDue(f.actionId);
    await recoverRetainedWorkspace(f.input);
    expect(reclaimCalls).toBe(1);
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).toBe("recovered");
    const prepared = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, f.companyId),
      eq(workspaceOperations.phase, "native_provider_cache_reclaim_prepare")));
    expect(prepared).toHaveLength(1);
    expect(await readFile(path.join(f.sessions, "pending-receipt.json"), "utf8")).toBe("uncertain action history\n");
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
  }, 30_000);

  it.each(["pending", "foreign", "lease", "active", "recoverable", "manifest", "symlink"])("keeps files intact when %s cache authority is unproven", async failure => {
    const f = await pressuredToolCache(), before = await run(f.runId);
    if (failure === "pending") await db.update(heartbeatRuns).set({ runnerProfileJson: { ...before.runnerProfileJson,
      nativeProviderPackAdmissionState: { schema: "paperclip.native-provider-pack-admission-state.v1",
        state: "pending", admissionEpoch: randomUUID() } } }).where(eq(heartbeatRuns.id, f.runId));
    if (failure === "foreign") await db.update(heartbeatRuns).set({ runnerProfileJson: { ...before.runnerProfileJson,
      nativeProviderPackAdmission: { ...before.runnerProfileJson!.nativeProviderPackAdmission as Record<string, unknown>,
        companyId: randomUUID() } } }).where(eq(heartbeatRuns.id, f.runId));
    if (failure === "lease") await db.update(heartbeatRuns).set({ runnerProfileJson: { ...before.runnerProfileJson,
      remoteWorkspace: { ...before.runnerProfileJson!.remoteWorkspace as Record<string, unknown>, leaseId: randomUUID() } } })
      .where(eq(heartbeatRuns.id, f.runId));
    if (failure === "active") await db.update(nativeRunFinalizations).set({ leaseOwner: "another-controller" })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    if (failure === "recoverable") await db.update(nativeRunFinalizations).set({ failureDetail: { recoverable: true } })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    if (failure === "manifest") await writeFile(path.join(f.pack, "provider-pack.json"), JSON.stringify({
      schema: "paperclip-runner/remote-provider-pack/v1", digest: `sha256:${"f".repeat(64)}`, payload: {},
    }));
    if (failure === "symlink") {
      const outside = path.join(path.dirname(f.remote), "retained-installation");
      await mkdir(outside); await writeFile(path.join(outside, "installed-tool"), "rebuildable dependency\n");
      await rm(path.join(f.pack, "node_modules"), { recursive: true });
      await symlink(outside, path.join(f.pack, "node_modules"));
    }
    await recoverRetainedWorkspace(f.input);
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).not.toBe("recovered");
    expect(f.transfers()).toBe(["lease", "active"].includes(failure) ? 0 : 1);
    expect(await readFile(path.join(f.pack, "node_modules", "installed-tool"), "utf8")).toBe("rebuildable dependency\n");
    expect(await readFile(path.join(f.sessions, "pending-receipt.json"), "utf8")).toBe("uncertain action history\n");
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
  }, 30_000);

});
