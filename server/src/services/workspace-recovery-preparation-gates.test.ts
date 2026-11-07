import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { heartbeatRunEvents, agents, approvals, costEvents, issueApprovals, environmentLeases, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, agentWakeupRequests, workspaceOperations, issueThreadInteractions, executionWorkspaces, executionWorkspaceSnapshots } from "@paperclipai/db";
import { terminalizeLegacyExecution } from "./legacy-execution-recovery.js";
import * as recoverySources from "./workspace-recovery-source.js";
import { requestedRunCancellation } from "./run-cancellation.js";
import { failSystemRecovery, readSystemRecovery, reserveSystemRecoveryAttempt, SystemRecoveryFailure } from "./system-recovery-state.js";
import { getStorageService } from "../storage/index.js";
import { attachPreservedWorkspaceSnapshots } from "./workspace-recovery-snapshot.js";
import { requestTaskRetry } from "./task-retry.js";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { finalizeNativeRun } from "./native-runtime/native-run-finalizer.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { EnvironmentLease } from "@paperclipai/shared";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { recoverRetainedWorkspace, requestWorkspaceRecovery, scheduleRecoveredWorkspaceCleanup, reconcileRetainedWorkspaces } from "./workspace-recovery.js";
import { heartbeatService } from "./heartbeat.js";
import { hasVerifiedWorkspaceRepair } from "./workspace-recovery-receipt.js";
import { createSavedWorkspaceLoader, readRemoteWorkspaceAuthority, saveRemoteWorkspace } from "./remote-workspaces.js";
import { createReusableLeaseHandoff } from "./environment-lease-handoff.js";
import { preserveRemoteWorkspacePreparationFailure } from "./native-runtime/native-workspace-finalization-state.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { taskInterruptionPresentation } from "./task-interruption-presentation.js";
import { resumePreservedResultFinalization } from "./preserved-result-finalization.js";
import { useWorkspaceRecoveryFixture, acceptedRemoteExport, action, boardRecoveryApp, db, interruptedRemotePreparation, makeRetryDue, root, run, seed, withheldPreparationRetry } from "./__tests__/workspace-recovery-fixture.js";
const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

describe("automatic retained workspace recovery", () => {
  useWorkspaceRecoveryFixture(targets);

  it.each(["no_certificate", "provider_started", "runtime_selected", "live_controller", "operator_stop", "missing_stop_receipt", "wrong_snapshot", "retry_exhausted", "human_reblock", "paused", "reassigned", "approval"] as const)(
    "keeps lost preparation behind its %s gate after file preservation", async gate => {
    const f = await interruptedRemotePreparation("process_lost");
    await recoverRetainedWorkspace(f.input);
    const source = await run(f.runId);
    if (gate === "no_certificate") await db.update(heartbeatRuns).set({ resultJson: { ...source.resultJson,
      executionRecovery: null } }).where(eq(heartbeatRuns.id, f.runId));
    if (gate === "provider_started") await db.insert(heartbeatRunEvents).values({ companyId: f.companyId,
      runId: f.runId, agentId: source.agentId, seq: 1, eventType: "native.process_start_requested", stream: "system" });
    if (gate === "runtime_selected") await db.update(heartbeatRuns).set({ runtimeModeResolvedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    if (gate === "live_controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, f.runId));
    if (gate === "operator_stop") await db.update(heartbeatRuns).set({ resultJson: { ...source.resultJson,
      cancellation: requestedRunCancellation({ cancelledByActorType: "user", cancelledByUserId: "operator" }, "Stop requested"),
    } }).where(eq(heartbeatRuns.id, f.runId));
    if (gate === "missing_stop_receipt") {
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      await db.update(environmentLeases).set({ metadata: { ...lease.metadata, remoteExecutionTermination: null } }).where(eq(environmentLeases.id, f.lease.id));
    }
    if (gate === "wrong_snapshot") await db.update(heartbeatRuns).set({ runnerProfileJson: { ...source.runnerProfileJson,
      remoteWorkspace: { ...(source.runnerProfileJson!.remoteWorkspace as Record<string, unknown>), snapshotId: randomUUID() },
    } }).where(eq(heartbeatRuns.id, f.runId));
    if (gate === "retry_exhausted") await db.update(heartbeatRuns).set({ scheduledRetryAttempt: 2 }).where(eq(heartbeatRuns.id, f.runId));
    if (gate === "human_reblock") await db.update(issues).set({ statusVersion: 3 }).where(eq(issues.id, f.issueId));
    if (gate === "paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, source.agentId));
    if (gate === "reassigned") await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "board" }).where(eq(issues.id, f.issueId));
    if (gate === "approval") {
      const approvalId = randomUUID();
      await db.insert(approvals).values({ id: approvalId, companyId: f.companyId, type: "hire_agent", status: "pending", payload: {} });
      await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issueId, approvalId });
    }
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeRemoteStopComments(await run(f.runId));
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      eq(heartbeatRuns.retryOfRunId, f.runId)))).toHaveLength(0);
    expect((await run(f.runId)).error).toBe(source.error);
  }, 30_000);

  it.each(["provider_evidence", "exhausted"] as const)("does not replace a withheld retry with %s", async gate => {
    const f = await interruptedRemotePreparation("process_lost"), withheld = await withheldPreparationRetry(f);
    if (gate === "provider_evidence") await db.insert(heartbeatRunEvents).values({ companyId: f.companyId,
      runId: withheld.id, agentId: withheld.agentId, seq: 1, eventType: "tool.execution.started", stream: "system" });
    if (gate === "exhausted") await db.update(heartbeatRuns).set({ scheduledRetryAttempt: 2 }).where(eq(heartbeatRuns.id, withheld.id));
    await recoverRetainedWorkspace(f.input);
    const heartbeat = heartbeatService(db);
    await Promise.all([heartbeat.resumeRemoteStopComments(await run(f.runId)),
      heartbeat.resumeRemoteStopComments(await run(f.runId))]);
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      eq(heartbeatRuns.retryOfRunId, withheld.id)))).toHaveLength(0);
    expect(await run(withheld.id)).toMatchObject({ status: "cancelled", startedAt: null });
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
  }, 30_000);

  it("retries unpublished preparation from its preserved ancestor without an old failure-block receipt", async () => {
    const f = await seed("legacy", false);
    await requestWorkspaceRecovery({ ...f, idempotencyKey: randomUUID(), actorId: "board" });
    await recoverRetainedWorkspace(f.input);
    const ancestor = await run(f.runId), leaseId = randomUUID(), providerLeaseId = randomUUID();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: ancestor.agentId, status: "running" });
    const app = boardRecoveryApp(), heartbeat = heartbeatService(db);
    const first = (await request(app).post(`/api/issues/${f.issueId}/retry`).send({
      observedRunId: f.runId, idempotencyKey: randomUUID(),
    }).expect(202)).body;
    await heartbeat.resumeTaskRetry(f.companyId, first.requestId);
    const admitted = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      eq(heartbeatRuns.status, "queued")));
    expect(admitted).toHaveLength(1);
    const interruptedId = admitted[0].id;
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "interrupted", executionStage: "preparing",
      startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(), controllerBootId: randomUUID(),
      errorCode: "lease_released_before_terminal", error: "Lease released before preparation settled",
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      resultJson: { cancellation: { source: "unknown", expected: false, initiator: { type: "system" },
        reason: "Lease released before preparation settled", recordedAt: new Date().toISOString() } },
    }).where(eq(heartbeatRuns.id, interruptedId));
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issueId));
    const lease = { id: leaseId, companyId: f.companyId, heartbeatRunId: interruptedId,
      provider: "daytona", providerLeaseId };
    await db.insert(environmentLeases).values({ ...lease, issueId: f.issueId, environmentId: f.lease.environmentId,
      status: "released", cleanupStatus: "success", releasedAt: new Date(),
      metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId, state: "stopped" }) },
    });
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: ancestor.agentId,
      cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${interruptedId}`,
      status: "resolved", outcome: "blocked", nextAction: "Recorded actions require reconciliation",
      evidence: { runId: interruptedId, originalFailureCode: "lease_released_before_terminal",
        automaticRecovery: { policy: "preserve_without_replay_v1", runId: interruptedId, replay: "blocked", actionOutcome: "unknown" } },
    });
    const intent = { observedRunId: interruptedId, idempotencyKey: randomUUID() };
    const receipt = (await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body;
    await Promise.all([heartbeat.resumeTaskRetry(f.companyId, receipt.requestId),
      heartbeat.resumeTaskRetry(f.companyId, receipt.requestId)]);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      eq(heartbeatRuns.status, "queued")));
    expect(successors).toHaveLength(1);
    expect(successors[0].contextSnapshot).toMatchObject({ previousRunId: interruptedId });
    expect((await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body.requestId).toBe(receipt.requestId);
    const restored = path.join(root, randomUUID()); await mkdir(restored);
    const copies = await attachPreservedWorkspaceSnapshots({ db, companyId: f.companyId, issueId: f.issueId,
      sourceRunIds: [interruptedId], cwd: restored });
    expect(copies).toHaveLength(1);
    expect(await readFile(path.join(copies[0]!.path, "files", "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  }, 30_000);

  it.each(["local", "none"])("continues verified interrupted preparation with %s leases", async provider => {
    const f = await interruptedRemotePreparation();
    await db.update(heartbeatRuns).set({ runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      resultJson: null }).where(eq(heartbeatRuns.id, f.runId));
    if (provider === "none") await db.delete(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    else await db.update(environmentLeases).set({ provider: "local", metadata: {} }).where(eq(environmentLeases.id, f.lease.id));
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeRemoteStopComments(await run(f.runId));
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.runId));
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });
  }, 30_000);

  it.each(["provider_started", "provider_dispatch_recorded", "runtime_selected", "live_controller", "wrong_snapshot", "operator_stop",
    "operator_stop_metadata", "missing_stop_receipt", "unrecorded_interruption",
    "retry_exhausted", "human_reblock", "paused", "reassigned"] as const)(
    "keeps the interrupted preparation continuation behind %s", async gate => {
      const f = await interruptedRemotePreparation("lease");
      await recoverRetainedWorkspace(f.input);
      const source = await run(f.runId);
      if (gate === "provider_started") await db.insert(heartbeatRunEvents).values({ companyId: f.companyId,
        runId: f.runId, agentId: source.agentId, seq: 1, eventType: "native.process_start_requested", stream: "system" });
      if (gate === "provider_dispatch_recorded") await db.update(heartbeatRuns).set({ resultJson: { ...source.resultJson,
        executionRecovery: { kind: "bootstrap", providerWorkStarted: true }, output: randomBytes(128 * 1024).toString("base64"),
      } }).where(eq(heartbeatRuns.id, f.runId));
      if (gate === "runtime_selected") await db.update(heartbeatRuns).set({ runtimeModeResolvedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      if (gate === "live_controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, f.runId));
      if (gate === "wrong_snapshot") await db.update(heartbeatRuns).set({ runnerProfileJson: { ...source.runnerProfileJson,
        remoteWorkspace: { ...(source.runnerProfileJson!.remoteWorkspace as Record<string, unknown>), snapshotId: randomUUID() },
      } }).where(eq(heartbeatRuns.id, f.runId));
      if (gate === "operator_stop") await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "operator_interrupted" }).where(eq(heartbeatRuns.id, f.runId));
      if (gate === "operator_stop_metadata") await db.update(heartbeatRuns).set({ resultJson: { ...source.resultJson,
        cancellation: requestedRunCancellation({ cancelledByActorType: "user", cancelledByUserId: "operator" }, "Stop requested"),
      } }).where(eq(heartbeatRuns.id, f.runId));
      if (gate === "unrecorded_interruption") await db.update(heartbeatRuns).set({ resultJson: { ...source.resultJson,
        cancellation: null,
      } }).where(eq(heartbeatRuns.id, f.runId));
      if (gate === "missing_stop_receipt") {
        const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
        await db.update(environmentLeases).set({ metadata: { ...lease.metadata, remoteExecutionTermination: null } })
          .where(eq(environmentLeases.id, f.lease.id));
      }
      if (gate === "retry_exhausted") await db.update(heartbeatRuns).set({ scheduledRetryAttempt: 2 }).where(eq(heartbeatRuns.id, f.runId));
      if (gate === "human_reblock") await db.update(issues).set({ statusVersion: 3 }).where(eq(issues.id, f.issueId));
      if (gate === "paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, source.agentId));
      if (gate === "reassigned") await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "board" }).where(eq(issues.id, f.issueId));
      const heartbeat = heartbeatService(db);
      await heartbeat.resumeRemoteStopComments(await run(f.runId));
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        eq(heartbeatRuns.retryOfRunId, f.runId)))).toHaveLength(0);
      if (["provider_started", "provider_dispatch_recorded", "runtime_selected", "live_controller", "wrong_snapshot", "operator_stop",
        "operator_stop_metadata", "missing_stop_receipt", "unrecorded_interruption"].includes(gate)) {
        const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId,
          actorId: "local-board", actorSource: "local_implicit", observedRunId: f.runId, idempotencyKey: randomUUID() });
        await heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!);
        expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
          eq(heartbeatRuns.status, "queued")))).toHaveLength(0);
      }
      if (gate === "human_reblock" || gate === "reassigned") {
        expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("blocked");
      }
      expect((await run(f.runId)).error).toBe(source.error);
    }, 30_000);

  it("uses a pending Retry as the sole successor after interrupted preparation recovers", async () => {
    const f = await interruptedRemotePreparation();
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId,
      actorId: "local-board", actorSource: "local_implicit", observedRunId: f.runId, idempotencyKey: randomUUID() });
    await recoverRetainedWorkspace(f.input);
    const heartbeat = heartbeatService(db);
    await Promise.all([heartbeat.resumeRemoteStopComments(await run(f.runId)),
      heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!)]);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      inArray(heartbeatRuns.status, ["queued", "scheduled_retry"])));
    expect(successors).toHaveLength(1);
    expect(successors[0].status).toBe("queued");
    expect(await readFreshWorkspaceReadiness(db, successors[0])).toMatchObject({ mode: "resume_preserved_workspace" });
  }, 30_000);

  it("cancels the interrupted preparation retry when a user blocks the task before it starts", async () => {
    const f = await interruptedRemotePreparation();
    await recoverRetainedWorkspace(f.input);
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeRemoteStopComments(await run(f.runId));
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.runId));
    expect(successor.status).toBe("scheduled_retry");
    await db.update(issues).set({ status: "blocked", statusVersion: 4 }).where(eq(issues.id, f.issueId));
    await heartbeat.promoteDueScheduledRetries(new Date(Date.now() + 300_000));
    expect(await run(successor.id)).toMatchObject({ status: "cancelled", errorCode: "issue_blocked" });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("blocked");
  }, 30_000);

  it.each([false, true])("keeps Retry behind an accepted remote export and resumes only its saved result (review pending: %s)", async reviewPending => {
    const f = await acceptedRemoteExport();
    const { source, workspaceId, resultId, git, commit } = f;
    const interactionId = randomUUID();
    if (reviewPending) await db.insert(issueThreadInteractions).values({ id: interactionId, companyId: f.companyId,
      issueId: f.issueId, sourceRunId: f.runId, createdByAgentId: source.agentId, kind: "request_confirmation",
      title: "Review saved work", effectiveResolverPolicy: "human_only",
      payload: { version: 1, prompt: "Review before publishing", rejectRequiresReason: true,
        target: { type: "custom", key: "layout_review", label: "Review saved work" } } });
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
    const app = boardRecoveryApp();
    const intent = { observedRunId: f.runId, idempotencyKey: randomUUID() };
    const retry = (await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body;
    expect((await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body.requestId).toBe(retry.requestId);
    await heartbeatService(db).resumeTaskRetry(f.companyId, retry.requestId!);
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text,
        ${heartbeatRuns.contextSnapshot}->>'issueId') = ${f.issueId}`))).toHaveLength(1);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.runId, workspaceRepairRequired: true });
    await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, async () => {
      await heartbeatService(db).resumeTaskRetry(f.companyId, retry.requestId!);
    }) ?? []);
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
    const saved = readRemoteWorkspaceAuthority(workspace.metadata)!;
    const restored = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId, snapshotId: saved.snapshotId! });
    try {
      expect(await readFile(path.join(restored.root, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(await git(["rev-parse", "HEAD"], restored.root)).toBe(commit);
    }
    finally { await restored.cleanup(); }
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(coordinator).toMatchObject({ phase: "workspace_finalizing", resultId });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, retry.requestId!)))[0])
      .toMatchObject({ status: "coalesced", runId: f.runId, payload: { taskRetry: { strategy: "finalize_result" } } });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(2);
    await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ status: reviewPending ? "in_review" : "done", executionRunId: null, checkoutRunId: null });
    expect((await run(f.runId)).status).toBe("succeeded");
    if (reviewPending) expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId)))[0])
      .toMatchObject({ status: "pending", result: null, resolvedAt: null });
  }, 30_000);

  // RC-50: a restart killed the controller that owned the saved-result copyback.
  // s13/t06: the kill landed 2 s after Retry. s12/t01: it landed during a later
  // attempt, after an earlier export failure had already spent one.
  // "exhausted before upgrade": the wave databases, where earlier code already
  // spent the whole budget on rechecks and recorded no hold.
  it.each([
    { wave: "s13", spentAttempts: 0, expectedStrategy: "finalize_result", exhaustedBeforeUpgrade: false },
    { wave: "s12", spentAttempts: 1, expectedStrategy: "continue", exhaustedBeforeUpgrade: false },
    { wave: "exhausted before upgrade", spentAttempts: 0, expectedStrategy: "finalize_result", exhaustedBeforeUpgrade: true },
  ])("lets an accepted Retry finish after a killed copyback owner instead of waiting forever ($wave)", async ({ spentAttempts, expectedStrategy, exhaustedBeforeUpgrade }) => {
    const f = await acceptedRemoteExport();
    const issue = (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0];
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.source.agentId, status: "running" });
    if (spentAttempts) {
      f.runtime.resumeRunLease.mockRejectedValueOnce(new Error("Workspace checkpoint payload mismatch"));
      await recoverRetainedWorkspace(f.input);
      await makeRetryDue(f.actionId);
    }
    const app = boardRecoveryApp();
    const retry = (await request(app).post(`/api/issues/${f.issueId}/retry`)
      .send({ observedRunId: f.runId, idempotencyKey: randomUUID() }).expect(202)).body;
    // The controller that claimed copyback was SIGKILLed on another host
    // (no local proof is possible), leaving its durable receipt behind.
    const dead = { token: randomUUID(), hostname: "killed-controller", pid: 91826,
      controllerBootId: randomUUID(), processStartedAt: new Date().toISOString() };
    const source = await run(f.runId);
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...source.runnerProfileJson, nativeWorkspaceFinalizationOwner: dead } })
      .where(eq(heartbeatRuns.id, f.runId));
    if (exhaustedBeforeUpgrade) {
      const before = await action(f.actionId);
      let spent = readSystemRecovery(before.evidence)!;
      for (let attempt = 0; attempt < 6; attempt++) spent = failSystemRecovery(reserveSystemRecoveryAttempt({ ...spent, nextAttemptAt: null })!,
        new SystemRecoveryFailure("copyback_stop_unconfirmed", "recheck_evidence"), { now: spent.firstFailureAt ?? Date.now() });
      expect(spent.state).toBe("exhausted");
      await db.update(issueRecoveryActions).set({ evidence: { ...before.evidence, systemRecovery: spent } })
        .where(eq(issueRecoveryActions.id, f.actionId));
    }
    for (let pass = 0; pass < 8; pass++) {
      await recoverRetainedWorkspace(f.input);
      await heartbeatService(db).resumeTaskRetry(f.companyId, retry.requestId!);
      if (!exhaustedBeforeUpgrade) await makeRetryDue(f.actionId);
    }
    expect(f.runtime.resumeRunLease).toHaveBeenCalledTimes(spentAttempts);
    // Rechecking an unverifiable owner is not an attempt and never ends in a stale "Retry recovery" handoff.
    const held = await action(f.actionId);
    expect(readSystemRecovery(held.evidence)).toMatchObject(exhaustedBeforeUpgrade
      ? { state: "exhausted", attempts: 6, failure: { code: "copyback_stop_unconfirmed" } }
      : { state: "awaiting_evidence", attempts: spentAttempts, failure: { code: "copyback_stop_unconfirmed" } });
    if (exhaustedBeforeUpgrade) expect(held.nextAction).toContain("confirm that it stopped");
    expect(held.evidence.workspaceOwnerRecovery).toEqual({ state: "operator_required", owner: dead });
    // Retry names the one action that can progress it, instead of "finalizing" forever.
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, retry.requestId!)))[0])
      .toMatchObject({ status: "deferred_issue_execution", payload: { executionWait: { reason: "workspace_owner_stop_required" } } });
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: false,
      retryWait: { reason: "workspace_owner_stop_required" } });
    await request(app).post(`/api/issues/${f.issueId}/recovery-actions/resume-workspace-finalization`).send({
      actionId: f.actionId, runId: f.runId, ownerToken: dead.token, controllerAndCopybackStopped: true,
      stopEvidence: "The killed control-plane process exited and its host was replaced.",
    }).expect(202);
    expect((await run(f.runId)).runnerProfileJson?.nativeWorkspaceFinalizationOwner).toBeUndefined();
    // The same steps the periodic sweep runs for this action.
    await recoverRetainedWorkspace(f.input);
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    await resumePreservedResultFinalization(db, f.companyId, f.runId);
    await heartbeatService(db).resumeTaskRetry(f.companyId, retry.requestId!);
    // The one accepted click now does work: it finishes the saved result, or,
    // after an earlier recovery handoff (s12), continues in exactly one new run.
    const [settled] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, retry.requestId!));
    expect(settled).toMatchObject({ status: "coalesced", runId: expect.any(String) });
    if (expectedStrategy === "finalize_result") {
      expect(settled).toMatchObject({ runId: f.runId, payload: { taskRetry: { strategy: "finalize_result" } } });
      await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ status: "done" });
    } else {
      expect(settled.payload).toMatchObject({ taskRetry: { strategy: "continue" } });
      expect(await db.select({ id: heartbeatRuns.id, previousRunId: sql<string>`${heartbeatRuns.contextSnapshot}->>'previousRunId'` })
        .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued"))))
        .toEqual([{ id: settled.runId, previousRunId: f.runId }]);
    }
  }, 60_000);

  it("preserves an explicitly requested superseded remote export without applying its result over newer work", async () => {
    const f = await acceptedRemoteExport();
    const [later] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.source.agentId,
      issueId: f.issueId, status: "cancelled", runtimeMode: "legacy", finishedAt: new Date(),
      contextSnapshot: { issueId: f.issueId }, createdAt: new Date(f.source.createdAt.getTime() + 1_000) }).returning();
    const [currentWorkspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId,
      sourceIssueId: f.issueId, name: "Newer workspace", cwd: path.join(root, later.id), providerType: "cloud_sandbox",
      mode: "isolated_workspace", strategyType: "project_primary", status: "active" }).returning();
    await db.update(issues).set({ executionWorkspaceId: currentWorkspace.id }).where(eq(issues.id, f.issueId));
    const laterAction = await issueRecoveryActionService(db).upsertSourceScoped({ companyId: f.companyId,
      sourceIssueId: f.issueId, kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation",
      fingerprint: later.id, evidence: { runId: later.id }, nextAction: "Inspect the stopped work",
      ownerType: "board", supersedeOnIdentityChange: true });
    expect((await action(f.actionId)).status).toBe("cancelled");
    await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, async () => {}) ?? []);
    expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
    const app = boardRecoveryApp();
    const recoveryRequest = { actionId: f.actionId, runId: f.runId, idempotencyKey: randomUUID() };
    await request(app).post(`/api/issues/${f.issueId}/recovery-actions/recover-workspace`).send(recoveryRequest).expect(202);
    const admitted = await action(f.actionId);
    await request(app).post(`/api/issues/${f.issueId}/recovery-actions/recover-workspace`).send(recoveryRequest).expect(202);
    expect(await action(f.actionId)).toEqual(admitted);
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, later.id));
    await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, async () => {}) ?? []);
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.failure?.code).toBe("workspace_writer_active");
    expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, later.id));
    await makeRetryDue(f.actionId);
    await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, async () => {}) ?? []);
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    const saved = readRemoteWorkspaceAuthority(workspace.metadata)!;
    const restored = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId: f.workspaceId, snapshotId: saved.snapshotId! });
    try {
      expect(await f.git(["rev-parse", "HEAD"], restored.root)).toBe(f.commit);
      expect(await readFile(path.join(restored.root, "saved.txt"), "utf8")).toBe("finished work\n");
    } finally { await restored.cleanup(); }
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ status: "blocked", executionWorkspaceId: currentWorkspace.id });
    expect(await action(laterAction.id)).toEqual(expect.objectContaining({ status: "active", evidence: { runId: later.id } }));
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "terminal_failure", resultId: f.resultId });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual([]);
  }, 30_000);

  it.each([
    { status: "failed", runtimeMode: "native", scenario: "none" },
    { status: "failed", runtimeMode: "native", scenario: "registration" },
    { status: "failed", runtimeMode: "native", scenario: "registration_after_dispatch" },
    { status: "failed", runtimeMode: "native", scenario: "registration_existing_hold" },
    { status: "failed", runtimeMode: "native", scenario: "registration_existing_hold_after_dispatch" },
    { status: "cancelled", runtimeMode: "native", scenario: "none" },
    { status: "failed", runtimeMode: "legacy", scenario: "final" },
    { status: "failed", runtimeMode: "legacy", scenario: "initial" },
  ] as const)("saves the authoritative remote workspace after $runtimeMode $status without replaying a turn or certifying external effects ($scenario)", async ({ status, runtimeMode, scenario }) => {
    const f = await seed(runtimeMode, false);
    let retryRequestId: string | undefined;
    const remoteCwd = await realpath(f.remote);
    targets.get(f.lease.id)!.remoteCwd = remoteCwd;
    f.runtime.resumeRunLease.mockImplementation(async () => ({ providerLeaseId: f.providerLeaseId, metadata: { remoteCwd } }));
    const workspaceId = randomUUID();
    let authority = { schema: "paperclip.remote-workspace.v1", epoch: 1, snapshotId: null as string | null,
      source: { kind: "empty" }, writerRunId: f.runId, dirty: true,
      location: { environmentId: f.lease.environmentId!, leaseId: f.lease.id,
        providerLeaseId: f.providerLeaseId, remoteCwd } };
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId: f.companyId, sourceIssueId: f.issueId,
      name: "Authoritative remote files", cwd: remoteCwd, providerRef: remoteCwd, providerType: "cloud_sandbox",
      mode: "isolated_workspace", strategyType: "project_primary", status: "active", metadata: { remoteWorkspace: authority } });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, f.issueId));
    const [boundLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    await db.update(environmentLeases).set({ executionWorkspaceId: workspaceId, leasePolicy: "reuse_by_execution_workspace",
      metadata: { ...boundLease.metadata, remoteCwd, agentId: (await run(f.runId)).agentId } })
      .where(eq(environmentLeases.id, f.lease.id));
    const before = await run(f.runId);
    if (scenario === "final") {
      // A reused allocation can fail during preparation, before native input or
      // its finalization coordinator exists. Keep a real saved predecessor and
      // the ordinary exact lease handoff; neither grants a new provider turn.
      const [priorRun] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: before.agentId,
        issueId: f.issueId, nativeIssueId: f.issueId, runtimeMode: "native", status: "succeeded",
        createdAt: new Date(before.createdAt.getTime() - 2_000), finishedAt: new Date(before.createdAt.getTime() - 1_000),
        contextSnapshot: { issueId: f.issueId } }).returning();
      await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId,
        runId: priorRun.id, phase: "committed" });
      const [currentLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      const [priorLease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
        heartbeatRunId: priorRun.id, environmentId: currentLease.environmentId, executionWorkspaceId: workspaceId,
        provider: currentLease.provider, providerLeaseId: f.providerLeaseId, leasePolicy: "reuse_by_environment", status: "active",
        acquiredAt: new Date(currentLease.acquiredAt.getTime() - 1_000), metadata: currentLease.metadata }).returning();
      const priorAuthority = { ...authority, writerRunId: priorRun.id,
        location: { ...authority.location, leaseId: priorLease.id } };
      const [priorWorkspace] = await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: priorAuthority } })
        .where(eq(executionWorkspaces.id, workspaceId)).returning();
      const priorSaved = await saveRemoteWorkspace({ db, workspace: priorWorkspace, runId: priorRun.id,
        lease: priorLease as EnvironmentLease, target: { ...targets.get(f.lease.id)!, leaseId: priorLease.id },
        assertOwned: async () => undefined });
      const handoff = createReusableLeaseHandoff(priorLease, currentLease);
      await db.update(environmentLeases).set({ status: "expired", cleanupStatus: "success", releasedAt: currentLease.acquiredAt,
        metadata: { ...priorLease.metadata, reusableLeaseSuccessor: handoff } }).where(eq(environmentLeases.id, priorLease.id));
      await db.update(environmentLeases).set({ metadata: { ...currentLease.metadata, reusableLeasePredecessor: handoff } })
        .where(eq(environmentLeases.id, currentLease.id));
      authority = { ...authority, epoch: 2, snapshotId: priorSaved.snapshotId };
      await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: authority } })
        .where(eq(executionWorkspaces.id, workspaceId));
      expect(before.runtimeMode).toBe("legacy");
      expect(before.runnerProfileJson?.nativeExecutionInput).toBeUndefined();
      expect(await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId))).toEqual([]);
    }
    if (runtimeMode === "legacy") await writeFile(path.join(f.remote, "pre-native-change.txt"), "current preparation wrote these files\n");
    await db.update(heartbeatRuns).set({ status, runnerProfileJson: { ...before.runnerProfileJson,
      ...(status === "failed" && runtimeMode === "native" ? { nativeResourceDisposition: "destroy" } : {}),
      remoteWorkspace: { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId: f.lease.id,
        providerLeaseId: f.providerLeaseId, remoteCwd, epoch: authority.epoch, state: "prepared", snapshotId: authority.snapshotId } },
      resultJson: { ...before.resultJson, ...(status === "cancelled" ? {
        nativeCancellation: { dispatchState: "acknowledged", requestedAt: new Date().toISOString() },
      } : {}) },
    }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { ...authority, epoch: authority.epoch + 1 } } })
      .where(eq(executionWorkspaces.id, workspaceId));
    await expect(recoverySources.inspectWorkspaceRecoverySource(db, f.input)).rejects.toMatchObject({ code: "source_binding_invalid" });
    expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: authority } })
      .where(eq(executionWorkspaces.id, workspaceId));
    if (runtimeMode === "legacy") {
      // Remote file ownership exists before native runtime selection.
      expect((await recoverySources.inspectWorkspaceRecoverySource(db, f.input)).sources).toHaveLength(1);
      const failedUpload = vi.spyOn(getStorageService(), "putFile").mockRejectedValueOnce(new Error("Synthetic saved-copy outage"));
      try {
        if (scenario === "initial") {
          // Exercise the original setup boundary, not a failed final save that
          // retries the same operation. The initial ledger reservation survives.
          await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
          await db.update(heartbeatRuns).set({ status: "running", finishedAt: null, error: null, errorCode: null, resultJson: null })
            .where(eq(heartbeatRuns.id, f.runId));
          const [originalLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
          const activeMetadata = { ...originalLease.metadata };
          delete activeMetadata.remoteExecutionTermination;
          const [activeLease] = await db.update(environmentLeases).set({ status: "active", releasedAt: null, cleanupStatus: null,
            metadata: activeMetadata }).where(eq(environmentLeases.id, f.lease.id)).returning();
          const [preparing] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
          await expect(saveRemoteWorkspace({ db, workspace: preparing, runId: f.runId, lease: activeLease as EnvironmentLease,
            target: targets.get(f.lease.id)!, assertOwned: async () => undefined, boundary: "initial" }))
            .rejects.toThrow("Synthetic saved-copy outage");
          const preserved = await preserveRemoteWorkspacePreparationFailure(db, activeLease, { assertOwned: async () => undefined });
          expect(preserved?.resultJson).toMatchObject({ workspaceRestoreFailure: "restore_failed",
            workspaceRestoreRecovery: { leaseIds: [f.lease.id] } });
          await terminalizeLegacyExecution({ db, run: preserved!, status: "failed", patch: {
            errorCode: "setup_failed", error: "Synthetic saved-copy outage", finishedAt: new Date(),
            resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
          } });
          const repairs = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId),
            sql`${issueRecoveryActions.evidence}->>'runId' = ${f.runId}`));
          expect(repairs).toHaveLength(1);
          f.actionId = repairs[0].id;
          f.input.actionId = repairs[0].id;
          expect(await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId))).toEqual([]);
          expect((await run(f.runId)).runnerProfileJson).not.toHaveProperty("nativeExecutionInput");
        } else await recoverRetainedWorkspace(f.input);
        expect(failedUpload).toHaveBeenCalledTimes(1);
      } finally { failedUpload.mockRestore(); }
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).not.toBe("complete");
      const [unsaved] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
      expect(readRemoteWorkspaceAuthority(unsaved.metadata)).toMatchObject({ dirty: true, writerRunId: f.runId,
        epoch: authority.epoch, snapshotId: authority.snapshotId });
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
      expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
      if (scenario === "final") await makeRetryDue(f.actionId);
    }
    if (scenario.startsWith("registration")) {
      await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
      await db.update(heartbeatRuns).set({ resultJson: { workspaceRestoreFailure: "restore_failed", originalDiagnostic: true },
        runnerProfileJson: { ...(await run(f.runId)).runnerProfileJson, nativeResourceDisposition: "keep_running" },
      }).where(eq(heartbeatRuns.id, f.runId));
      const [stopped] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      const termination = stopped.metadata!.remoteExecutionTermination as Record<string, unknown>;
      await db.update(environmentLeases).set({ leasePolicy: "reuse_by_environment", releasedAt: new Date(String(termination.confirmedAt)), metadata: { ...stopped.metadata,
        sandboxStopAndRetainReceipt: { ...termination, schema: "paperclip.sandbox-stop-and-retain-receipt.v1",
          pluginId: stopped.metadata!.pluginId, method: "environmentStopLease", requestId: randomUUID() },
      } }).where(eq(environmentLeases.id, f.lease.id));
      const [later] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: before.agentId,
        issueId: f.issueId, runtimeMode: "legacy", status: "failed", errorCode: "setup_failed", finishedAt: new Date(),
        executionStage: "preparing", runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
        createdAt: new Date(before.createdAt.getTime() + 1), contextSnapshot: { issueId: f.issueId },
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      }).returning();
      if (scenario.endsWith("after_dispatch")) await appendHeartbeatRunEvent(db, {
        companyId: f.companyId, runId: later.id, agentId: before.agentId, eventType: "adapter.invoke", stream: "system",
        level: "info", message: "Execution started before the contradictory bootstrap result.", payload: null,
      });
      const existingHold = scenario.includes("existing_hold");
      await issueRecoveryActionService(db).upsertSourceScoped({ companyId: f.companyId, sourceIssueId: f.issueId,
        kind: existingHold ? "active_run_watchdog" : "stranded_assigned_issue",
        cause: existingHold ? "legacy_execution_requires_reconciliation" : "stranded_assigned_issue", fingerprint: `latest-setup:${later.id}`,
        ownerType: "board", nextAction: "Inspect the failed setup before continuing.",
        evidence: existingHold ? { runId: later.id, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } }
          : { latestRunId: later.id, latestRunStatus: "failed", latestRunErrorCode: "setup_failed" } });
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: before.agentId, status: "running" });
      const app = boardRecoveryApp(), retryIntent = { observedRunId: later.id, idempotencyKey: randomUUID() };
      const retry = (await request(app).post(`/api/issues/${f.issueId}/retry`).send(retryIntent).expect(202)).body;
      retryRequestId = retry.requestId;
      expect((await request(app).post(`/api/issues/${f.issueId}/retry`).send(retryIntent).expect(202)).body.requestId).toBe(retryRequestId);
      await heartbeatService(db).resumeTaskRetry(f.companyId, retryRequestId!);
      const [registered] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId),
        sql`${issueRecoveryActions.evidence}->>'runId' = ${f.runId}`));
      expect(registered).toBeDefined();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(3);
      f.actionId = f.input.actionId = registered.id;
      await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, async () => {}) ?? []);
    }
    await recoverRetainedWorkspace(f.input);
    const recoveredAction = await action(f.actionId);
    expect(readSystemRecovery(recoveredAction.evidence)?.state).toBe("complete");
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
    const saved = readRemoteWorkspaceAuthority(workspace.metadata);
    expect(saved).toMatchObject({ dirty: false, writerRunId: null });
    expect(saved?.snapshotId).toBeTruthy();
    const snapshots = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, workspaceId));
    expect(snapshots).toHaveLength(runtimeMode === "legacy" ? 2 : 1);
    expect(snapshots.find(snapshot => snapshot.id === saved!.snapshotId))
      .toMatchObject({ status: "committed", sourceRunId: f.runId, generation: runtimeMode === "legacy" ? 2 : 1 });
    const extracted = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId, snapshotId: saved!.snapshotId! });
    try {
      expect(await readFile(path.join(extracted.root, "saved.txt"), "utf8")).toBe("finished work\n");
      if (runtimeMode === "legacy") expect(await readFile(path.join(extracted.root, "pre-native-change.txt"), "utf8"))
        .toBe("current preparation wrote these files\n");
    }
    finally { await extracted.cleanup(); }
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
    expect(await run(f.runId)).toMatchObject({ status, errorCode: scenario === "initial" ? "setup_failed" : "execution_interrupted",
      runnerProfileJson: { remoteWorkspace: { state: "saved", snapshotId: saved!.snapshotId } } });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
      .toHaveLength(retryRequestId ? 1 : 0);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId))).toHaveLength(0);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, f.runId),
      eq(workspaceOperations.phase, "workspace_recovery_snapshot")))).toHaveLength(0);
    expect(f.runtime.resumeRunLease).toHaveBeenCalledTimes(scenario === "final" ? 2 : 1);
    expect(f.runtime.retryPendingSandboxTeardown).toHaveBeenCalledTimes(runtimeMode === "legacy" ? 2 : 1);
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
    await scheduleRecoveredWorkspaceCleanup(db, await run(f.runId));
    const [settledLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    if (retryRequestId) {
      expect(settledLease).toMatchObject({ status: "released", leasePolicy: "reuse_by_environment" });
      await heartbeatService(db).resumeTaskRetry(f.companyId, retryRequestId);
      await heartbeatService(db).resumeTaskRetry(f.companyId, retryRequestId);
      const queued = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
      if (scenario.endsWith("after_dispatch")) {
        expect(queued).toHaveLength(0);
        expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, retryRequestId)))[0])
          .toMatchObject({ status: "deferred_issue_execution", runId: null });
        return;
      }
      expect(queued).toHaveLength(1);
      expect(await readFreshWorkspaceReadiness(db, queued[0]))
        .toMatchObject({ mode: "resume_preserved_workspace", preservationReceiptId: expect.any(String) });
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ executionWorkspaceId: workspaceId });
      expect((await run(f.runId)).resultJson).toMatchObject({ originalDiagnostic: true });
      expect(f.runtime.resumeRunLease).toHaveBeenCalledTimes(1);
      return;
    }
    if (runtimeMode === "legacy") {
      expect(settledLease).toMatchObject({ status: "released",
        leasePolicy: scenario === "initial" ? "retain_on_failure" : "reuse_by_execution_workspace" });
      expect((await run(f.runId)).runtimeMode).toBe("legacy");
      expect(await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId))).toEqual([]);
      if (scenario === "final") expect(snapshots.find(snapshot => snapshot.id === authority.snapshotId)).toMatchObject({ status: "superseded" });
      else expect(snapshots.find(snapshot => snapshot.generation === 1)).toMatchObject({ status: "pending" });
      // Explicit Retry may admit the preserved files. Saturate agent capacity
      // so this tests admission without dispatching a new agent turn.
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: before.agentId, status: "running" });
      const retry = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
        actorSource: "local_implicit", observedRunId: f.runId, idempotencyKey: randomUUID() });
      await heartbeatService(db).resumeTaskRetry(f.companyId, retry.requestId!);
      const [successor] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
      expect(successor).toBeDefined();
      expect(await readFreshWorkspaceReadiness(db, successor))
        .toMatchObject({ mode: "resume_preserved_workspace", preservationReceiptId: expect.any(String) });
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, successor.id))).toEqual([]);
      expect(f.runtime.resumeRunLease).toHaveBeenCalledTimes(scenario === "final" ? 2 : 1);
      return;
    }
    if (status === "failed") {
      expect(settledLease).toMatchObject({ status: "pending_cleanup", leasePolicy: "ephemeral",
        metadata: { workspaceRecoveryCleanup: { runId: f.runId, snapshotId: saved!.snapshotId, epoch: authority.epoch } } });
      const source = await run(f.runId);
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
      const retry = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
        actorSource: "local_implicit", observedRunId: source.id, idempotencyKey: randomUUID() });
      // The saved, re-stopped sandbox only awaits destroy. That cleanup does not
      // hold the successor: it continues now instead of on the cleanup retry.
      expect(settledLease.metadata?.workspaceRecoveryCleanup).toMatchObject({ stopReceipt: { runId: f.runId, leaseId: settledLease.id } });
      await heartbeatService(db).resumeTaskRetry(f.companyId, retry.requestId!);
      const [successor] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
      expect(successor).toBeDefined();
      const readiness = await readFreshWorkspaceReadiness(db, successor);
      expect(readiness).toMatchObject({ mode: "resume_preserved_workspace", preservationReceiptId: expect.any(String) });
    } else {
      expect(settledLease).toMatchObject({ status: "released", leasePolicy: "reuse_by_execution_workspace" });
      expect(settledLease.metadata?.workspaceRecoveryCleanup).toBeUndefined();
    }
  }, 30_000);

});
