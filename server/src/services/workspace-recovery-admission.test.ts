import { createAdmissionTransactionScope, createWakeAdmissionReader, createWakeAdmissionWriter } from "../modules/wake-queue/adapters/postgres.js";
import { createAdmitWakeBehindIssueExecution } from "../modules/wake-queue/application/use-cases.js";
import { filterZombieCoalesceTarget, heartbeatService } from "./heartbeat.js";
import { mergeCoalescedContextSnapshot } from "./heartbeat/run-preparation.js";
import { recoveryService } from "./recovery/index.js";
import { inspectWorkspaceSource } from "./workspace-source-inspection.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { isPreDispatchExecutionWaitVerified } from "./pre-dispatch-execution-wait.js";
import { heartbeatRunEvents, agents, approvals, budgetPolicies, costEvents, completionContracts, issueApprovals, issueTreeHolds, issueTreeHoldMembers, companies, createDb, environmentLeases, environments, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, agentWakeupRequests, workspaceOperations, plugins } from "@paperclipai/db";
import { createHeartbeatQueue, shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake } from "./heartbeat/queue.js";
import { createHeartbeatQueueTestDependencies } from "../__tests__/helpers/heartbeat-queue.js";
import { recordRequiredWorkspaceRestoreFailure } from "./legacy-execution-recovery.js";
import { admitExplicitNativeContinuation } from "./explicit-native-continuation.js";
import { withQueuedCommentIdsInWakePayload } from "./issue-queued-comment-queue.js";
import * as recoverySources from "./workspace-recovery-source.js";
import { requestedRunCancellation } from "./run-cancellation.js";
import { createHeartbeatRunControl } from "./heartbeat/run-control.js";
import { callbacks } from "./heartbeat/__tests__/run-control-fixtures.js";
import { adapterExecutionControls, createAdapterExecutionControl } from "./adapter-execution-control.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "./delivery-work-notifications.js";
import { prepareHeartbeatWorkspace } from "./heartbeat/workspace-preparation.js";
import { createHeartbeatWorkspaceResolver, resolveExecutionWorkspaceReuseRequestForIssue } from "./heartbeat/workspaces.js";
import { environmentService } from "./environments.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { environmentRunOrchestrator } from "./environment-run-orchestrator.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { workspaceOperationService } from "./workspace-operations.js";
import { instanceSettingsService } from "./instance-settings.js";
import { projectTaskInterruption, taskInterruptionPresentation } from "./task-interruption-presentation.js";
import * as nativeWorkspaceSync from "./native-runtime/native-workspace-sync.js";
import { resumeNativeWorkspaceSync } from "./native-runtime/native-workspace-sync.js";
import { GitShallowMetadataError } from "@paperclipai/adapter-utils/git-workspace-sync";
import { readSystemRecovery, createSystemRecovery, failSystemRecovery, SystemRecoveryFailure } from "./system-recovery-state.js";
import { updateSystemRecovery } from "./system-recovery.js";
import { getStorageService } from "../storage/index.js";
import { attachPreservedWorkspaceSnapshots } from "./workspace-recovery-snapshot.js";
import { adoptHistoricalWorkspaceRecoveries } from "./workspace-recovery-backfill.js";
import { requestTaskRetry } from "./task-retry.js";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { resumePreservedResultFinalization } from "./preserved-result-finalization.js";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { EnvironmentLease } from "@paperclipai/shared";
import { hasRemoteTerminationReceipt, remoteTerminationReceipt } from "./remote-execution-termination.js";
import { prepareStoppedSandboxForRecovery, prepareSandboxStopAndRetain, settleStopOnlyCleanup, readStopOnlyCleanup } from "./sandbox-stop-and-retain.js";
import { recoverRetainedWorkspace, requestWorkspaceRecovery, scheduleRecoveredWorkspaceCleanup, reconcileRetainedWorkspaces, retainedWorkspaceCandidates } from "./workspace-recovery.js";
import * as activity from "./activity-log.js";
import { hasVerifiedWorkspaceRepair, readWorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { prepareRemoteWorkspace, readRemoteWorkspaceAuthority, reserveRemoteWorkspace, saveRemoteWorkspace } from "./remote-workspaces.js";
import { getExecutionBlocker, hasPendingRunCleanup } from "./execution-blocker.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import * as workerProof from "./native-runtime/native-workspace-platform-proof.js";
import { useWorkspaceRecoveryFixture, action, connectionString, db, makeRetryDue, replaceFixtureState, root, run, seed } from "./workspace-recovery.test-fixture.js";
const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

describe("automatic retained workspace recovery", () => {
  useWorkspaceRecoveryFixture(targets);

  it("publishes the committed finalization barrier after real retained workspace recovery", async () => {
    const f = await seed();
    const observed: Array<Promise<Array<{ status: string }>>> = [];
    const stop = subscribeDeliveryWork(db, DELIVERY_QUEUES.nativeStatusReassessment, () => {
      observed.push(db.select({ status: workspaceOperations.status }).from(workspaceOperations).where(and(
        eq(workspaceOperations.companyId, f.companyId), eq(workspaceOperations.heartbeatRunId, f.runId),
        eq(workspaceOperations.phase, "workspace_finalize"),
      )).then(rows => rows));
    });
    try { await recoverRetainedWorkspace(f.input); } finally { stop(); }
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    expect(observed.length).toBeGreaterThan(0);
    expect((await Promise.all(observed)).some(rows => rows.some(row => row.status === "succeeded"))).toBe(true);
  });

  it.each(["retain_on_failure", "reuse_by_environment", "reuse_by_execution_workspace"] as const)("re-enters only the accepted result finalizer for %s, preserving files and failure history", async leasePolicy => {
    const f = await seed("native", true, "keep_running");
    await db.update(environmentLeases).set({ leasePolicy }).where(eq(environmentLeases.id, f.lease.id));
    await db.update(issueRecoveryActions).set({ cause: "native_workspace_sync_out_retry_exhausted" }).where(eq(issueRecoveryActions.id, f.actionId));
    await db.update(heartbeatRuns).set({ resultJson: {} }).where(eq(heartbeatRuns.id, f.runId));
    const contractId = randomUUID(), resultId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.issueId,
      revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {}, canonicalSha256: "contract", createdByActorType: "system", createdByActorId: "test" });
    await db.update(heartbeatRuns).set({ completionContractId: contractId }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(nativeRunResults).values({ id: resultId, companyId: f.companyId, issueId: f.issueId, runId: f.runId,
      completionContractId: contractId, schemaStatus: "accepted", serverFingerprint: "result", canonicalSha256: "result",
      resultJson: { terminal: { runTerminalState: "succeeded" } } });
    await db.update(nativeRunFinalizations).set({ resultId, attempt: 3, failureCode: "native_workspace_sync_out_retry_exhausted" })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await resumePreservedResultFinalization(db, f.companyId, f.runId)).toBe(false);
    const priorAction = await action(f.actionId);
    await db.update(issueRecoveryActions).set({ ownerType: "system", evidence: { ...priorAction.evidence,
      systemRecovery: failSystemRecovery(createSystemRecovery(f.runId),
        new SystemRecoveryFailure("source_binding_invalid", "service_required")),
      workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: f.runId, status: "blocked",
        stage: "verifying_stop", attempt: 1, attemptLimit: 6, requestIds: [] },
    } }).where(eq(issueRecoveryActions.id, f.actionId));
    const request = { ...f.input, actorId: "board", idempotencyKey: randomUUID() };
    await requestWorkspaceRecovery(request);
    const admitted = await action(f.actionId);
    await requestWorkspaceRecovery(request);
    expect(await action(f.actionId)).toEqual(admitted);
    expect(admitted.ownerType).toBe("system");
    await recoverRetainedWorkspace(f.input);
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    const attempts = await Promise.all([resumePreservedResultFinalization(db, f.companyId, f.runId),
      resumePreservedResultFinalization(db, f.companyId, f.runId)]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(coordinator).toMatchObject({ phase: "workspace_finalizing", resultId, attempt: 3 });
    expect(coordinator.recoveryHistory).toEqual([expect.objectContaining({
      kind: "preserved_result_finalization", previousFailureCode: "native_workspace_sync_out_retry_exhausted",
    })]);
    expect(await run(f.runId)).toMatchObject({ status: "failed", errorCode: "execution_interrupted" });
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure" }).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await resumePreservedResultFinalization(db, f.companyId, f.runId)).toBe(false);
    const retry = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
      idempotencyKey: randomUUID(), observedRunId: f.runId });
    expect(await resumePreservedResultFinalization(db, f.companyId, f.runId)).toBe(true);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, retry.requestId!)))[0])
      .toMatchObject({ status: "coalesced", runId: f.runId, payload: { taskRetry: { strategy: "finalize_result" } } });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.companyId, f.companyId))).toHaveLength(1);
  }, 30_000);

  it("preserves a historical legacy source without manufacturing a native descriptor or overwriting current files", async () => {
    const f = await seed("legacy", false);
    await recoverRetainedWorkspace(f.input);
    const operations = await db.select().from(workspaceOperations).where(and(
      eq(workspaceOperations.heartbeatRunId, f.runId), eq(workspaceOperations.phase, "workspace_recovery_snapshot"),
      eq(workspaceOperations.status, "succeeded"),
    ));
    expect(operations).toHaveLength(1);
    expect(operations[0].metadata).toMatchObject({ leaseId: f.lease.id, providerLeaseId: f.providerLeaseId });
    const fresh = path.join(root, randomUUID()); await mkdir(fresh);
    const attached = await attachPreservedWorkspaceSnapshots({ db, companyId: f.companyId, issueId: f.issueId,
      sourceRunIds: [f.runId], cwd: fresh });
    expect(await readFile(path.join(attached[0].path, "files", "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(attached[0].path, "provenance.json"), "utf8")).toContain(f.runId);
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
    expect((await run(f.runId)).runnerProfileJson?.nativeWorkspaceSync).toBeUndefined();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect((await run(f.runId)).status).toBe("failed");
  }, 30_000);

  it("keeps earlier recovered snapshots readable across repeated fresh retries", async () => {
    const f = await seed("legacy", false);
    await recoverRetainedWorkspace(f.input);
    const source = await run(f.runId);
    const replacementId = randomUUID(), laterId = randomUUID(), intentId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: replacementId, companyId: f.companyId, agentId: source.agentId,
        status: "failed", contextSnapshot: { issueId: f.issueId } },
      { id: laterId, companyId: f.companyId, agentId: source.agentId,
        status: "failed", retryOfRunId: replacementId, contextSnapshot: { issueId: f.issueId } },
    ]);
    await db.insert(agentWakeupRequests).values({
      id: intentId, companyId: f.companyId, agentId: source.agentId, runId: replacementId,
      source: "on_demand", triggerDetail: "manual", reason: "task_retry", status: "coalesced",
      requestedByActorType: "user", requestedByActorId: "owner-user",
      payload: { issueId: f.issueId, taskRetry: { schema: "paperclip.task-retry.v1",
        generationId: intentId, sourceRunId: f.runId, actorId: "owner-user", strategy: "fresh_isolated_workspace" } },
    });
    const first = path.join(root, randomUUID()), next = path.join(root, randomUUID());
    await mkdir(first); await mkdir(next);
    await attachPreservedWorkspaceSnapshots({ db, companyId: f.companyId, issueId: f.issueId,
      sourceRunIds: [f.runId], cwd: first });
    const attached = await attachPreservedWorkspaceSnapshots({ db, companyId: f.companyId, issueId: f.issueId,
      sourceRunIds: [laterId], cwd: next });
    expect(attached).toHaveLength(1);
    expect(attached[0].sourceRunId).toBe(f.runId);
    expect(await readFile(path.join(attached[0].path, "files", "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(attached[0].path, "provenance.json"), "utf8")).toContain(f.runId);
    expect(await attachPreservedWorkspaceSnapshots({ db, companyId: f.companyId, issueId: randomUUID(),
      sourceRunIds: [laterId], cwd: next })).toEqual([]);
  }, 30_000);

  it("retains files and the recovery barrier when native export rejects Git metadata", async () => {
    const f = await seed();
    const restore = vi.spyOn(nativeWorkspaceSync, "resumeNativeWorkspaceSync")
      .mockRejectedValueOnce(new GitShallowMetadataError("Git shallow metadata exceeds its byte limit"));
    try { await recoverRetainedWorkspace(f.input); } finally { restore.mockRestore(); }
    expect(readSystemRecovery((await action(f.actionId)).evidence)).toMatchObject({ state: "exhausted",
      failure: { code: "snapshot_verification_failed", retryClass: "service_required" }, preservationOperationIds: [] });
    // A classified failure names its own subsystem; it never gets a provider cause.
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.failure).not.toHaveProperty("cause");
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect((await run(f.runId)).status).toBe("failed");
  }, 30_000);

  it("reconciles an uploaded snapshot after a lost upload acknowledgement without exporting again", async () => {
    const f = await seed("legacy", false);
    const target = targets.get(f.lease.id)!;
    const exportFiles = vi.spyOn(target.runner!, "syncOut");
    const storage = getStorageService(), put = storage.putFile.bind(storage);
    let uploads = 0;
    const lostReply = vi.spyOn(storage, "putFile").mockImplementation(async input => {
      const receipt = await put(input);
      if (++uploads === 2) throw new Error("Lost upload acknowledgement");
      return receipt;
    });
    try { await recoverRetainedWorkspace(f.input); } finally { lostReply.mockRestore(); }
    const [pending] = await db.select().from(workspaceOperations).where(and(
      eq(workspaceOperations.heartbeatRunId, f.runId), eq(workspaceOperations.phase, "workspace_recovery_snapshot")));
    expect(pending.status).toBe("running");
    expect(uploads).toBe(2);
    await makeRetryDue(f.actionId);
    const restarted = createDb(connectionString);
    try { await recoverRetainedWorkspace({ ...f.input, db: restarted }); }
    finally { await restarted.$client.end(); }
    const operations = await db.select().from(workspaceOperations).where(and(
      eq(workspaceOperations.heartbeatRunId, f.runId), eq(workspaceOperations.phase, "workspace_recovery_snapshot")));
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ id: pending.id, status: "succeeded", metadata: pending.metadata });
    expect(exportFiles).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
    exportFiles.mockRestore();
  }, 30_000);

  it.each(["native", "legacy"])("recovers real files without an accepted result or another turn: %s", async mode => {
    const f = await seed(mode);
    await recoverRetainedWorkspace(f.input);
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)).toMatchObject({ status: "recovered", attempt: 1 });
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ workspaceRepairRequired: false });
    expect((await run(f.runId)).status).toBe("failed");
    expect((await action(f.actionId)).evidence.executionReconciliation).toBeUndefined();
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("blocked");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    await recoverRetainedWorkspace(f.input);
    expect(f.runtime.resumeRunLease.mock.calls.filter(([input]) => input.lease.id === f.lease.id)).toHaveLength(1);
    expect(await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, f.companyId), eq(workspaceOperations.phase, "workspace_recovery")))).toHaveLength(1);
  }, 30_000);

  it("recovers a protected retained source through the assembled environment runtime", async () => {
    const f = await seed();
    await db.update(environmentLeases).set({ metadata: { ...f.lease.metadata,
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", runId: f.runId },
      remoteExecutionTermination: remoteTerminationReceipt(f.lease, { providerLeaseId: f.providerLeaseId, state: "stopped" }),
    } }).where(eq(environmentLeases.id, f.lease.id));
    const runtime = f.input.environmentRuntime;
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    const [environment] = await db.select().from(environments).where(eq(environments.id, lease.environmentId!));
    expect(await runtime.resumeRunLease({ environment: environment as never, lease: lease as EnvironmentLease })).toBeNull();
    expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
    await recoverRetainedWorkspace({ ...f.input, environmentRuntime: runtime });
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).toBe("recovered");
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
    expect(f.runtime.resumeRunLease.mock.calls.filter(([input]) => input.lease.id === f.lease.id)).toHaveLength(1);
    expect(f.runtime.resumeRunLease).toHaveBeenCalledWith(expect.objectContaining({ requestedCwd: f.remote }));
    await recoverRetainedWorkspace({ ...f.input, environmentRuntime: runtime });
    expect(f.runtime.resumeRunLease.mock.calls.filter(([input]) => input.lease.id === f.lease.id)).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
  }, 30_000);

  it.each(["changed_claim", "missing_stop_intent", "wrong_lease", "wrong_environment"])(
    "does not reopen a retained source without exact recovery authority: %s", async kind => {
      const f = await seed();
      const runtime = f.input.environmentRuntime;
      const resume = runtime.resumeWorkspaceRecoveryLease.bind(runtime);
      vi.spyOn(runtime, "resumeWorkspaceRecoveryLease").mockImplementationOnce(async input => {
        if (kind === "changed_claim") await db.update(environmentLeases).set({ metadata: sql`
          ${environmentLeases.metadata} || '{"pendingCleanupAttemptId":"other-owner"}'::jsonb`
        }).where(eq(environmentLeases.id, f.lease.id));
        if (kind === "missing_stop_intent") await db.update(environmentLeases).set({ metadata: sql`
          ${environmentLeases.metadata} - 'sandboxStopAndRetain'`
        }).where(eq(environmentLeases.id, f.lease.id));
        return resume({ ...input,
          ...(kind === "wrong_lease" ? { leaseId: randomUUID() } : {}),
          ...(kind === "wrong_environment" ? { environmentId: randomUUID() } : {}),
        });
      });
      await recoverRetainedWorkspace(f.input);
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.failure?.code).toBe("source_binding_invalid");
      expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
      expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    }, 30_000);

  it("forwards only the owned export directory through the sandbox provider boundary", async () => {
    const driver = "sandbox";
    const f = await seed();
    const pluginId = f.lease.metadata!.pluginId as string;
    const manifest: typeof plugins.$inferInsert.manifestJson = { id: `fixture.export-cwd.${pluginId}`, apiVersion: 1, version: "1.0.0",
      displayName: "Fixture export provider", description: "Records provider boundary calls", author: "Paperclip",
      categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
      environmentDrivers: [{ driverKey: "daytona", kind: "sandbox_provider", displayName: "Fixture", configSchema: { type: "object" } }] };
    await db.insert(plugins).values({ id: pluginId, pluginKey: manifest.id,
      packageName: "@fixture/export-cwd", version: manifest.version,
      apiVersion: 1, categories: manifest.categories, manifestJson: manifest, status: "ready", installOrder: 1 });
    const metadata = { ...f.lease.metadata, driver, provider: "daytona", pluginKey: manifest.id,
      sandboxProviderPlugin: true };
    await db.update(environmentLeases).set({ metadata }).where(eq(environmentLeases.id, f.lease.id));
    await db.update(environments).set({ driver, config: { provider: "daytona" } }).where(eq(environments.id, f.lease.environmentId!));
    const call = vi.fn(async (_id: string, method: string, input: Record<string, unknown>) => {
      if (method === "environmentResumeLease") return { providerLeaseId: f.providerLeaseId,
        metadata: { remoteCwd: input.requestedCwd ?? path.dirname(f.remote) } };
      if (method === "environmentStopLease") return { providerLeaseId: f.providerLeaseId, state: "stopped" };
      throw new Error(`Unexpected provider operation: ${method}`);
    });
    const worker = { isRunning: () => true, call, getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentStopLease"] }) } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: worker });
    await recoverRetainedWorkspace({ ...f.input, environmentRuntime: runtime });
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).toBe("recovered");
    expect(call.mock.calls.filter(([, method]) => method === "environmentResumeLease")).toEqual([
      expect.arrayContaining([pluginId, "environmentResumeLease", expect.objectContaining({
        companyId: f.companyId, environmentId: f.lease.environmentId, providerLeaseId: f.providerLeaseId, requestedCwd: f.remote,
      })]),
    ]);
    expect(call.mock.calls.some(([, method]) => ["environmentAcquireLease", "environmentRealizeWorkspace", "environmentDestroyLease"].includes(method))).toBe(false);
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
  }, 30_000);

  it.each(["same", "later"])("prepares the %s task workspace from an ordinary resumed allocation root", async kind => {
    const f = await seed("native", false);
    vi.stubEnv("DATABASE_URL", connectionString);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "62".repeat(32));
    try {
      const allocationRoot = await realpath(f.remote);
      const target = { ...targets.get(f.lease.id)!, remoteCwd: allocationRoot };
      const storage = { ...getStorageService(), provider: "s3" as const };
      const agentId = (await run(f.runId)).agentId;
      await db.update(heartbeatRuns).set({ status: "running", resultJson: {} }).where(eq(heartbeatRuns.id, f.runId));
      const [firstLease] = await db.update(environmentLeases).set({ status: "active", metadata: {
        ...f.lease.metadata, remoteCwd: allocationRoot } }).where(eq(environmentLeases.id, f.lease.id)).returning();
      const reserveInput = { db, storage, companyId: f.companyId, issueId: f.issueId, runId: f.runId, agentId,
        environmentId: f.lease.environmentId!, projectId: null, projectWorkspaceId: null, existingWorkspaceId: null,
        source: { kind: "empty" as const } };
      const first = await prepareRemoteWorkspace({ db, storage, workspace: await reserveRemoteWorkspace(reserveInput),
        runId: f.runId, lease: firstLease as EnvironmentLease, target });
      await writeFile(path.join(first.remoteRoot, "saved.txt"), "prior task work\n");
      await saveRemoteWorkspace({ db, storage, workspace: first.workspace, runId: f.runId, lease: first.lease,
        target, assertOwned: async () => undefined });
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
      await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, f.lease.id));
      const issueId = kind === "same" ? f.issueId : randomUUID();
      if (kind === "later") await db.insert(issues).values({ id: issueId, companyId: f.companyId, assigneeAgentId: agentId,
        title: "A later task", status: "in_progress" });
      const [nextRun] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId, issueId, nativeIssueId: issueId,
        runtimeMode: "native", status: "running", contextSnapshot: { issueId } }).returning();
      const [nextLease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId, heartbeatRunId: nextRun.id,
        environmentId: f.lease.environmentId, provider: "daytona", providerLeaseId: kind === "same" ? f.providerLeaseId : randomUUID(),
        status: "active", metadata: { ...f.lease.metadata, remoteCwd: first.remoteRoot } }).returning();
      f.runtime.resumeRunLease.mockImplementation(async input => ({ providerLeaseId: input.lease.providerLeaseId!,
        metadata: { remoteCwd: allocationRoot } }));
      const [environment] = await db.select().from(environments).where(eq(environments.id, f.lease.environmentId!));
      const resumed = await f.environmentRuntime.resumeRunLease({ environment: environment as never, lease: nextLease as EnvironmentLease });
      expect(resumed?.metadata?.remoteCwd).toBe(allocationRoot);
      expect(f.runtime.resumeRunLease.mock.calls[0]?.[0]).not.toHaveProperty("requestedCwd");
      const nextWorkspace = await reserveRemoteWorkspace({ ...reserveInput, issueId, runId: nextRun.id,
        existingWorkspaceId: kind === "same" ? first.workspace.id : null });
      const prepared = await prepareRemoteWorkspace({ db, storage, workspace: nextWorkspace, runId: nextRun.id,
        lease: nextLease as EnvironmentLease, target: { ...target, remoteCwd: resumed!.metadata!.remoteCwd as string } });
      const expectedRemoteRoot = kind === "same" ? first.remoteRoot : path.join(allocationRoot, ".paperclip-workspaces",
        `${nextWorkspace.id}-${readRemoteWorkspaceAuthority(nextWorkspace.metadata)!.epoch}-${nextLease.id}`);
      expect(prepared.remoteRoot).toBe(expectedRemoteRoot);
      if (kind === "same") expect(await readFile(path.join(prepared.remoteRoot, "saved.txt"), "utf8")).toBe("prior task work\n");
      else expect(prepared.remoteRoot).not.toBe(first.remoteRoot);
      await saveRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId: nextRun.id, lease: prepared.lease,
        target: { ...target, remoteCwd: prepared.remoteRoot }, assertOwned: async () => undefined });
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, nextRun.id));
    } finally { vi.unstubAllEnvs(); }
  }, 30_000);

  it("keeps verified copyback files in the preserved workspace on ordinary Retry", async () => {
    const f = await seed();
    await recoverRetainedWorkspace(f.input);
    const source = await run(f.runId);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
    const request = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board", actorSource: "local_implicit",
      observedRunId: source.id, idempotencyKey: randomUUID() });
    await heartbeatService(db).resumeTaskRetry(f.companyId, request.requestId!);
    const [successor] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(successor).toBeDefined();
    const [receipt] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, f.runId),
      eq(workspaceOperations.phase, "workspace_recovery"), eq(workspaceOperations.status, "succeeded")));
    const readiness = await readFreshWorkspaceReadiness(db, successor);
    expect(readiness).toEqual({ mode: "resume_preserved_workspace", preservationReceiptId: receipt.id });
    const [agent] = await db.select().from(agents).where(eq(agents.id, source.agentId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const localEnvironment = await environmentService(db).ensureLocalEnvironment(f.companyId);
    const prepared = await prepareHeartbeatWorkspace(db, {
      run: successor, agent,
      task: { issueRef: issue, issueId: f.issueId, wasIssueAssignee: issue.assigneeAgentId === agent.id,
        context: { issueId: f.issueId }, responsibleUserId: "local-board",
        previousSessionParams: null, freshWorkspace: readiness },
      policy: { trustPreset: { kind: "standard", preset: "standard", boundary: null, sourcePresets: {} },
        isolatedWorkspacesEnabled: false, effectiveExecutionWorkspaceMode: "shared_workspace",
        requestedExecutionWorkspaceMode: "shared_workspace", useIsolatedTaskDirectory: false,
        nativeChatWorkspaceScope: null, projectExecutionWorkspacePolicy: null, issueExecutionWorkspaceSettings: null,
        environmentExecutionWorkspaceSettings: null, executionPolicy: { executionMode: "any" } },
      environment: { selectedEnvironmentId: localEnvironment.id, localEnvironment, selectedEnvironmentForConfig: localEnvironment,
        environmentResolution: { environmentId: localEnvironment.id, source: "default" },
        resolvedInstanceSettings: await instanceSettingsService(db).get() },
      config: { mergedConfig: { cwd: f.host }, configSnapshot: null, secretManifest: [] },
      reuse: { requestedShouldReuseExisting: false, existingExecutionWorkspace: null, reusableExistingExecutionWorkspace: null,
        workspaceReuseRequest: resolveExecutionWorkspaceReuseRequestForIssue({ issueExecutionWorkspaceId: null,
          issueExecutionWorkspacePreference: null, existingExecutionWorkspaceStatus: null }),
        nativeRecoveryExecutionWorkspaceId: null, persistedNativeExecutionInput: null, isDotRun: false, runOptions: {} },
      services: { envOrchestrator: environmentRunOrchestrator(db), executionWorkspacesSvc: executionWorkspaceService(db),
        workspaceOperationsSvc: workspaceOperationService(db), ...createHeartbeatWorkspaceResolver(db), appendRunEvent: vi.fn() },
      controllerLease: { assertOwned: vi.fn(async () => {}) }, nativeRunnerPreparationSpans: [],
    });
    expect(prepared.executionWorkspace.cwd).toBe(f.host);
    expect(await readFile(path.join(prepared.executionWorkspace.cwd, "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.requestId!));
    expect(wake.payload?.taskRetry).toMatchObject({ strategy: "continue" });
  }, 30_000);

  it("hands a reassigned task to its new assignee once the previous owner's files are recovered", async () => {
    // Shape of a mid-run reassignment: the old owner's run was cancelled for
    // the reassignment, its copyback was retained, and its no-replay hold was
    // recorded after the new assignee's queued wakes had been admitted.
    const f = await seed();
    const previousOwnerId = (await run(f.runId)).agentId;
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "issue_reassigned" }).where(eq(heartbeatRuns.id, f.runId));
    const held = await action(f.actionId);
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "blocked", resolvedAt: new Date(),
      fingerprint: `native-workspace:${f.runId}`, evidence: { ...held.evidence, continuationDelivery: "invalidated",
        automaticRecovery: { policy: "preserve_without_replay_v1", runId: f.runId, replay: "blocked", actionOutcome: "unknown" } },
    }).where(eq(issueRecoveryActions.id, f.actionId));
    const newOwnerId = randomUUID();
    await db.insert(agents).values({ id: newOwnerId, companyId: f.companyId, name: "Reviewer", adapterType: "paperclip_runner",
      status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.update(issues).set({ assigneeAgentId: newOwnerId, status: "in_progress" }).where(eq(issues.id, f.issueId));
    // The new owner's queued wake reached the final dispatch gate after the hold appeared.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: newOwnerId, runtimeMode: "legacy",
      status: "cancelled", finishedAt: new Date(), invocationSource: "automation", errorCode: "execution_reconciliation_required",
      contextSnapshot: { issueId: f.issueId }, resultJson: { stopReason: "execution_reconciliation_required",
        timeoutSource: "stale_queued_run_gate", executionWait: { issueId: f.issueId, recoveryActionId: f.actionId } } });

    // No second executor may touch the workspace while its files are unrecovered.
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.runId, workspaceRepairRequired: true });

    await recoverRetainedWorkspace(f.input);
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
    // The recovered hold no longer binds the board-chosen new owner...
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    // A different reconciliation hold for the same stopped run, without file
    // preservation evidence, still blocks the new owner.
    const [other] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", ownerType: "board", cause: "native_continuation_requires_reconciliation",
      fingerprint: `other:${f.runId}`, nextAction: "Reconcile the stopped run.", evidence: { runId: f.runId } }).returning();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: other.id });
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, other.id));
    // ...and the stranded-work sweep gives that owner a durable next action.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: newOwnerId, status: "running" });
    const pending = () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      inArray(heartbeatRuns.status, ["queued", "scheduled_retry"])));
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
    const successors = await pending();
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ agentId: newOwnerId, contextSnapshot: { issueId: f.issueId } });
    // A fresh turn for the new owner, never a replay of the stopped run.
    expect(successors[0].retryOfRunId).not.toBe(f.runId);
    expect(successors[0].contextSnapshot?.previousRunId).not.toBe(f.runId);
    // Recovery stays bounded: a later sweep observes the pending turn instead of adding another.
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
    expect((await pending()).map(item => item.id)).toEqual([successors[0].id]);
    // The release rests on the durable completed-recovery receipt. Later reuse
    // of the workspace by the new owner changes live workspace evidence, so the
    // live repair check stops verifying; the hold must not re-arm for that owner.
    const stopped = await run(f.runId);
    const sync = stopped.runnerProfileJson?.nativeWorkspaceSync as Record<string, unknown>;
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...stopped.runnerProfileJson,
      nativeWorkspaceSync: { ...sync, finalHostSha256: "f".repeat(64) } } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    await db.update(heartbeatRuns).set({ runnerProfileJson: stopped.runnerProfileJson }).where(eq(heartbeatRuns.id, f.runId));
    // The audit row and its no-replay hold stay intact for the previous owner.
    expect(await action(f.actionId)).toMatchObject({ status: "resolved", outcome: "blocked",
      evidence: { automaticRecovery: { replay: "blocked" } } });
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, successors[0].id));
    await db.update(issues).set({ assigneeAgentId: previousOwnerId }).where(eq(issues.id, f.issueId));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.runId, workspaceRepairRequired: false });
  }, 30_000);

  // Shape of a Stop or reassignment that reached a remote native run while its
  // provider session was still opening: the startup owner fenced the handle, the
  // run settled cancelled with a file-preservation hold, and the follow-up turn
  // (the redirect comment, or the new owner's wake) was already queued.
  async function stopBeforeSessionOpen(f: Awaited<ReturnType<typeof seed>>, options: { errorCode: string; proof?: boolean }) {
    const nativeCancellation = { schema: "paperclip.native-cancellation.v1", runId: f.runId, companyId: f.companyId,
      issueId: f.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
      intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), acknowledgedAt: new Date().toISOString(),
      ...(options.proof === false ? {} : { beforeProviderTurn: true }) };
    const stopped = await run(f.runId);
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: options.errorCode, finishedAt: new Date(),
      resultJson: { ...stopped.resultJson, nativeCancellation, startupCancellation: { errorCode: options.errorCode, beforeNativeSelection: false } },
    }).where(eq(heartbeatRuns.id, f.runId));
    const held = await action(f.actionId);
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "blocked", resolvedAt: new Date(),
      fingerprint: `native-workspace:${f.runId}`, evidence: { ...held.evidence, continuationDelivery: "invalidated",
        automaticRecovery: { policy: "preserve_without_replay_v1", runId: f.runId, replay: "blocked", actionOutcome: "unknown" } },
    }).where(eq(issueRecoveryActions.id, f.actionId));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
  }
  const queueFollowUp = async (f: Awaited<ReturnType<typeof seed>>, agentId: string) =>
    (await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId, runtimeMode: "legacy", status: "queued",
      invocationSource: "on_demand", contextSnapshot: { issueId: f.issueId, wakeReason: "issue_commented" } }).returning())[0]!;
  const pendingTurns = (f: Awaited<ReturnType<typeof seed>>) => db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, f.companyId), inArray(heartbeatRuns.status, ["queued", "scheduled_retry", "running"])));

  it("continues the same agent's redirect once after a Stop that landed before the provider session opened", async () => {
    const f = await seed();
    const agentId = (await run(f.runId)).agentId;
    await stopBeforeSessionOpen(f, { errorCode: "cancelled" });
    // Startup lifecycle from the runner opens no turn and is not provider work.
    for (const [seq, eventType] of ["harness.starting", "harness.ready", "workspace.ready", "runtime.phase.changed",
      "session.starting", "session.started", "session.updated", "auth.credentials.updated"].entries()) await db.insert(heartbeatRunEvents).values({
      companyId: f.companyId, runId: f.runId, agentId, seq: 9_000 + seq, eventType, stream: "system", level: "info",
      message: eventType, sourceEventId: randomUUID() });
    const followUp = await queueFollowUp(f, agentId);
    // No executor may touch the workspace while its files are unrecovered.
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.runId, workspaceRepairRequired: true });
    // The queued follow-up never started and is gated by this hold, so it is not
    // a workspace writer. Recovery must not wait for it.
    await recoverRetainedWorkspace(f.input);
    expect(readSystemRecovery((await action(f.actionId)).evidence)).toMatchObject({ state: "complete" });
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
    // No provider turn ran, so no outcome is unknown: the same agent continues.
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    // Exactly once: the queued follow-up is the only turn, and a sweep adds none.
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
    expect((await pendingTurns(f)).map(item => item.id)).toEqual([followUp.id]);
    // The audit row keeps its no-replay evidence.
    expect(await action(f.actionId)).toMatchObject({ status: "resolved", outcome: "blocked",
      evidence: { automaticRecovery: { replay: "blocked" } } });
  }, 30_000);

  it("hands a task reassigned before the provider session opened to its new owner once", async () => {
    const f = await seed();
    await stopBeforeSessionOpen(f, { errorCode: "issue_reassigned" });
    const newOwnerId = randomUUID();
    await db.insert(agents).values({ id: newOwnerId, companyId: f.companyId, name: "Reviewer", adapterType: "paperclip_runner",
      status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.update(issues).set({ assigneeAgentId: newOwnerId }).where(eq(issues.id, f.issueId));
    const handoff = await queueFollowUp(f, newOwnerId);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.runId, workspaceRepairRequired: true });
    await recoverRetainedWorkspace(f.input);
    expect(readSystemRecovery((await action(f.actionId)).evidence)).toMatchObject({ state: "complete" });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
    expect((await pendingTurns(f)).map(item => item.id)).toEqual([handoff.id]);
  }, 30_000);

  it.each(["no-proof", "turn-event", "provider-event", "unlisted-provider-event", "workspace-diff-event", "running-writer", "other-task-writer",
    "unscoped-queued-writer", "non-gating-hold"] as const)
  ("keeps the stopped agent held when provider work cannot be excluded (%s)", async kind => {
    const f = await seed();
    const agentId = (await run(f.runId)).agentId;
    await stopBeforeSessionOpen(f, { errorCode: "cancelled", proof: kind !== "no-proof" });
    if (kind === "turn-event") await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId,
      eventType: "turn.started", stream: "system", level: "info", message: "turn started" });
    if (kind === "provider-event") await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.runId, agentId,
      seq: 9_999, eventType: "item.completed", stream: "system", level: "info", message: "provider item", sourceEventId: randomUUID() });
    // A runner event outside the startup lifecycle counts as work even when unlisted,
    // including turn-scoped events that share a startup family name.
    if (kind === "unlisted-provider-event" || kind === "workspace-diff-event") await db.insert(heartbeatRunEvents).values({
      companyId: f.companyId, runId: f.runId, agentId, seq: 9_999, stream: "system", level: "info", message: kind,
      eventType: kind === "unlisted-provider-event" ? "delegation.completed" : "workspace.diff.recorded", sourceEventId: randomUUID() });
    if (kind === "running-writer" || kind === "other-task-writer" || kind === "unscoped-queued-writer") {
      // A started turn, or a queued one that this task's dispatch gate does not cover, is a real writer.
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId, runtimeMode: "legacy",
        status: kind === "running-writer" ? "running" : "queued",
        ...(kind === "unscoped-queued-writer" ? { issueId: f.issueId } : {}),
        contextSnapshot: kind === "running-writer" ? { issueId: f.issueId }
          : kind === "other-task-writer" ? { issueId: randomUUID(), executionWorkspaceId: f.issueId } : {} });
      await expect(recoverySources.inspectWorkspaceRecoverySource(db, f)).rejects.toMatchObject({ code: "workspace_writer_active" });
      return;
    }
    if (kind === "non-gating-hold") {
      // A resolved action without a no-replay hold does not gate dispatch, so a
      // queued turn for the task can start and must still count as a writer.
      const held = await action(f.actionId);
      await db.update(issueRecoveryActions).set({ evidence: { ...held.evidence,
        automaticRecovery: { policy: "preserve_without_replay_v1", runId: f.runId, replay: "allowed" } } })
        .where(eq(issueRecoveryActions.id, f.actionId));
      await queueFollowUp(f, agentId);
      await expect(recoverySources.inspectWorkspaceRecoverySource(db, f)).rejects.toMatchObject({ code: "workspace_writer_active" });
      return;
    }
    await queueFollowUp(f, agentId);
    await recoverRetainedWorkspace(f.input);
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.actionId, runId: f.runId });
  }, 30_000);

  it.each(["verified-stop", "no-stop-receipt", "foreign-receipt"] as const)
  ("admits the interrupt redirect once recovery saved and stopped the sandbox, before its destroy finishes (%s)", async kind => {
    // An interrupt comment after the session opened: the run did provider work,
    // its files were recovered, and the stopped sandbox was queued for destroy.
    const f = await seed();
    const source = await run(f.runId);
    const finishedAt = new Date(Date.now() - 60_000);
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "operator_interrupted", finishedAt,
      resultJson: { ...source.resultJson, operatorInterrupted: true, interruptionSource: "issue_comment_interrupt",
        nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: f.runId, companyId: f.companyId,
          issueId: f.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged",
          dispatched: true, intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() } },
    }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
    await recoverRetainedWorkspace(f.input);
    expect(readSystemRecovery((await action(f.actionId)).evidence)).toMatchObject({ state: "complete" });
    await scheduleRecoveredWorkspaceCleanup(db, await run(f.runId));
    const [queued] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    expect(queued).toMatchObject({ status: "pending_cleanup", metadata: { workspaceRecoveryCleanup: { runId: f.runId } } });
    if (kind !== "verified-stop") {
      const cleanup = queued.metadata!.workspaceRecoveryCleanup as Record<string, unknown>;
      const stopReceipt = kind === "foreign-receipt"
        ? { ...(cleanup.stopReceipt as Record<string, unknown>), runId: randomUUID() } : undefined;
      await db.update(environmentLeases).set({ metadata: { ...queued.metadata,
        workspaceRecoveryCleanup: { ...cleanup, stopReceipt } } }).where(eq(environmentLeases.id, f.lease.id));
    }
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "operator", body: "Use the other approach instead." }).returning();
    // The same input as a plain message and as a saved native interrupt send.
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: source.agentId,
      source: "automation", reason: "issue_execution_deferred", status: "deferred_issue_execution",
      requestedByActorType: "system", requestedByActorId: "heartbeat",
      payload: { issueId: f.issueId, _paperclipWakeContext: { wakeCommentIds: [comment.id] },
        queuedCommentInterrupt: { actorId: "operator", requestedAt: new Date().toISOString() } } });
    expect(await hasPendingRunCleanup(db, f.companyId, f.runId)).toBe(kind !== "verified-stop");
    for (const interrupt of [false, true]) {
      const reasons: string[] = [];
      const admitted = await admitExplicitNativeContinuation({ db, companyId: f.companyId, issueId: f.issueId,
        agentId: source.agentId, actorType: "user", actorId: "operator", reason: "issue_commented",
        commentId: comment.id, successorRunId: randomUUID(), dryRun: true, onBlocked: reason => reasons.push(reason),
        ...(interrupt ? { queuedCommentInterruptId: queueId } : {}) });
      if (kind === "verified-stop") {
        // Destroying a stopped sandbox whose files are saved is cleanup, not ownership.
        expect(reasons, JSON.stringify({ interrupt, reasons })).toEqual([]);
        expect(admitted).toMatchObject({ previousRunId: f.runId, commentId: comment.id });
      } else {
        expect(admitted).toBeNull();
        expect(reasons).toContain("remote_cleanup");
      }
    }
  }, 30_000);

  it.each(["verified-stop", "no-stop-receipt"] as const)
  ("starts the interrupt redirect once after recovery when the interrupt landed before the provider turn, without waiting for the destroy (%s)", async kind => {
    // An interrupt comment while an ephemeral-lease run was still starting: the
    // startup owner fenced the handle before any provider turn, its files were
    // recovered, and the re-stopped sandbox was queued for destroy. The queued
    // follow-up was cancelled before start and its comment saved for recovery.
    const f = await seed("native", true, "destroy", false, true);
    const agentId = (await run(f.runId)).agentId;
    await stopBeforeSessionOpen(f, { errorCode: "operator_interrupted" });
    const stopped = await run(f.runId);
    await db.update(heartbeatRuns).set({ resultJson: { ...stopped.resultJson, operatorInterrupted: true,
      interruptionSource: "issue_comment_interrupt", interruptedIssueId: f.issueId, interruptedByActorType: "user",
      interruptedByActorId: "operator", cancelledByActorType: "user", cancelledByUserId: "operator" } })
      .where(eq(heartbeatRuns.id, f.runId));
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "operator", body: "Use the other approach instead." }).returning();
    const context = { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: comment.id, wakeCommentIds: [comment.id] };
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId, runtimeMode: "legacy", status: "cancelled",
      invocationSource: "automation", errorCode: "execution_reconciliation_required", finishedAt: new Date(), contextSnapshot: context });
    const [saved] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId,
      source: "automation", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: "operator",
      payload: { issueId: f.issueId, commentId: comment.id, _paperclipWakeContext: context,
        executionWait: { reason: "execution_recovery", message: "Waiting for execution recovery. Your message is saved." } } }).returning();
    await recoverRetainedWorkspace(f.input);
    expect(readSystemRecovery((await action(f.actionId)).evidence)).toMatchObject({ state: "complete" });
    await scheduleRecoveredWorkspaceCleanup(db, await run(f.runId));
    const [queued] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    expect(queued).toMatchObject({ status: "pending_cleanup", metadata: { workspaceRecoveryCleanup: { runId: f.runId } } });
    if (kind === "no-stop-receipt") {
      const cleanup = queued.metadata!.workspaceRecoveryCleanup as Record<string, unknown>;
      await db.update(environmentLeases).set({ metadata: { ...queued.metadata,
        workspaceRecoveryCleanup: { ...cleanup, stopReceipt: undefined } } }).where(eq(environmentLeases.id, f.lease.id));
    }
    // No provider turn ran, so the no-replay hold does not gate the task.
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    // Recovery hands the saved comment to ordinary admission (onRecovered), twice
    // to prove a repeated sweep adds no second executor.
    for (let pass = 0; pass < 2; pass += 1) await heartbeatService(db).resumeRemoteStopComments(await run(f.runId));
    const turns = await pendingTurns(f);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, saved.id));
    if (kind === "verified-stop") {
      // The destroy is still pending: the follow-up waits on the stop, not on it.
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0])
        .toMatchObject({ status: "pending_cleanup" });
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ agentId, contextSnapshot: { wakeCommentId: comment.id } });
      expect(wake.status).not.toBe("deferred_issue_execution");
    } else {
      // Without a verified stop, the saved comment keeps waiting.
      expect(turns).toEqual([]);
      expect(wake.status).toBe("deferred_issue_execution");
    }
    // The no-replay audit row is untouched.
    expect(await action(f.actionId)).toMatchObject({ status: "resolved", outcome: "blocked",
      evidence: { automaticRecovery: { replay: "blocked" } } });
  }, 30_000);

  it("keeps a snapshot-only recovery held for a new assignee because the task workspace lacks the saved files", async () => {
    const f = await seed("native", false);
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "issue_reassigned" }).where(eq(heartbeatRuns.id, f.runId));
    const held = await action(f.actionId);
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "blocked", resolvedAt: new Date(),
      evidence: { ...held.evidence, automaticRecovery: { policy: "preserve_without_replay_v1", runId: f.runId, replay: "blocked" } },
    }).where(eq(issueRecoveryActions.id, f.actionId));
    const newOwnerId = randomUUID();
    await db.insert(agents).values({ id: newOwnerId, companyId: f.companyId, name: "Reviewer", adapterType: "paperclip_runner", status: "idle" });
    await db.update(issues).set({ assigneeAgentId: newOwnerId, status: "in_progress" }).where(eq(issues.id, f.issueId));
    await recoverRetainedWorkspace(f.input);
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    expect(await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, f.runId),
      eq(workspaceOperations.phase, "workspace_recovery_snapshot"), eq(workspaceOperations.status, "succeeded")))).toHaveLength(1);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.actionId, runId: f.runId });
  }, 30_000);

  it("projects active preservation without waiting input as working, and stale observations as failed", async () => {
    const f = await seed();
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const state = { ...createSystemRecovery(f.runId), state: "running" as const };
    const recovery = { ...await action(f.actionId), evidence: { systemRecovery: state, systemRecoveryActiveAt: Date.now() } };
    const input = { run: await run(f.runId), action: recovery, paused: false, approval: false };
    expect(projectTaskInterruption(issue, input)).toMatchObject({ state: "working", intentId: null, canRetry: false });
    expect(projectTaskInterruption(issue, input, Date.now() + 60_000)).toMatchObject({ state: "failed", canRetry: true });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
  });

  it.each([["native_provider_model_rejected", "choose_model"], ["native_provider_approval_required", "approval"]] as const)(
    "projects %s as the meaningful user action %s", async (errorCode, userAction) => {
      const f = await seed();
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(projectTaskInterruption(issue, { run: { ...await run(f.runId), errorCode }, paused: false, approval: false }))
        .toMatchObject({ state: "waiting_for_user", responsibility: "user", userAction, canRetry: false });
    });

  it("serializes concurrent repairs through the physical workspace lock", async () => {
    const f = await seed(); let ready!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.runtime.resumeRunLease.mockImplementationOnce(async () => { ready(); await gate; return { providerLeaseId: f.providerLeaseId, metadata: { remoteCwd: f.remote } }; });
    const first = recoverRetainedWorkspace(f.input);
    await started;
    try { await recoverRetainedWorkspace(f.input); expect(f.runtime.resumeRunLease.mock.calls.filter(([input]) => input.lease.id === f.lease.id)).toHaveLength(1); }
    finally { release(); await first; }
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).toBe("recovered");
  }, 30_000);

  it.each(["missing_stop", "wrong_stop", "another_owner", "active_writer", "invalid_descriptor"])("retains the source and starts no provider for %s", async kind => {
    const f = await seed();
    if (kind === "missing_stop" || kind === "wrong_stop") await db.update(environmentLeases).set({ metadata: { ...f.lease.metadata,
      ...(kind === "wrong_stop" ? { remoteExecutionTermination: remoteTerminationReceipt({ ...f.lease, id: randomUUID() }, { providerLeaseId: f.providerLeaseId, state: "stopped" }) } : {}) } }).where(eq(environmentLeases.id, f.lease.id));
    if (kind === "missing_stop" || kind === "wrong_stop") f.runtime.retryPendingSandboxTeardown.mockResolvedValue({ providerLeaseId: randomUUID(), state: "unknown" });
    if (kind === "another_owner") await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId, provider: "daytona", providerLeaseId: f.providerLeaseId });
    if (kind === "active_writer") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.lease.heartbeatRunId ? (await run(f.runId)).agentId : "", status: "running", nativeIssueId: f.issueId });
    if (kind === "invalid_descriptor") await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: { schema: "corrupt" } } }).where(eq(heartbeatRuns.id, f.runId));
    await recoverRetainedWorkspace(f.input);
    expect(readSystemRecovery((await action(f.actionId)).evidence)).toMatchObject({ state:
      ["missing_stop", "wrong_stop", "active_writer"].includes(kind) ? "awaiting_evidence" : "exhausted" });
    expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
  }, 30_000);

  it("resumes a copied workspace after a lost stop reply without overwriting later files", async () => {
    const f = await seed();
    f.runtime.retryPendingSandboxTeardown.mockRejectedValueOnce(new Error("stop reply lost"));
    await recoverRetainedWorkspace(f.input);
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)).toMatchObject({ status: "queued", attempt: 1 });
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
    await writeFile(path.join(f.host, "saved.txt"), "later user edit\n");
    const pending = await action(f.actionId);
    await db.update(issueRecoveryActions).set({ evidence: { ...pending.evidence,
      systemRecovery: { ...readSystemRecovery(pending.evidence), nextAttemptAt: 0 } } }).where(eq(issueRecoveryActions.id, f.actionId));
    const request = { ...f.input, idempotencyKey: randomUUID(), actorId: "user" };
    await requestWorkspaceRecovery(request); await requestWorkspaceRecovery(request);
    await recoverRetainedWorkspace(f.input);
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("later user edit\n");
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)).toMatchObject({ status: "recovered", attempt: 2, requestIds: [request.idempotencyKey] });
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
  }, 30_000);

  it("resumes an interrupted file export from persisted state with a new database connection", async () => {
    const f = await seed(), target = targets.get(f.lease.id)!;
    const execute = target.runner!.execute;
    let interrupted = false, interruptExports = true;
    target.runner!.execute = async input => {
      const output = await execute(input);
      if (interruptExports && input.args?.some(arg => arg.includes("tar -cf"))) {
        interrupted = true;
        throw new Error("File export transport interrupted after archive creation");
      }
      return output;
    };
    await recoverRetainedWorkspace(f.input);
    expect(interrupted).toBe(true);
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)).toMatchObject({ status: "queued", stage: "restoring_files", attempt: 1 });
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
    interruptExports = false;
    await writeFile(path.join(f.host, "later.txt"), "work saved during the interruption\n");
    const pending = await action(f.actionId);
    await db.update(issueRecoveryActions).set({ evidence: { ...pending.evidence,
      systemRecovery: { ...readSystemRecovery(pending.evidence), nextAttemptAt: 0 } } }).where(eq(issueRecoveryActions.id, f.actionId));
    const restarted = createDb(connectionString);
    try {
      await recoverRetainedWorkspace({ ...f.input, db: restarted });
      expect(await hasVerifiedWorkspaceRepair(restarted, await run(f.runId))).toBe(true);
      expect(readWorkspaceRecovery((await action(f.actionId)).evidence)).toMatchObject({ status: "recovered", attempt: 2 });
      expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(await readFile(path.join(f.host, "later.txt"), "utf8")).toBe("work saved during the interruption\n");
    } finally { await restarted.$client.end(); target.runner!.execute = execute; }
  }, 30_000);

  it("rejects a recovery request outside the task company", async () => {
    const f = await seed();
    await expect(requestWorkspaceRecovery({ ...f.input, companyId: randomUUID(), actorId: "user", idempotencyKey: randomUUID() })).rejects.toThrow("changed");
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)).toBeNull();
  });

  it.each([false, true])("adopts exact retained leases without a run descriptor (existing action: %s)", async existingAction => {
    const f = await seed("legacy", false);
    await db.update(heartbeatRuns).set({ resultJson: null }).where(eq(heartbeatRuns.id, f.runId));
    if (existingAction) await db.update(issueRecoveryActions).set({ evidence: { runId: f.runId } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    else await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    await adoptHistoricalWorkspaceRecoveries(db);
    const [adopted] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId));
    expect(adopted.evidence.historicalWorkspaceSource).toMatchObject({ runId: f.runId, leaseIds: [f.lease.id] });
    const generation = readSystemRecovery(adopted.evidence)!.generationId;
    expect(await recoverRetainedWorkspace({ ...f.input, actionId: adopted.id })).toBeUndefined();
    expect(readSystemRecovery((await action(adopted.id)).evidence)?.state).toBe("complete");
    await adoptHistoricalWorkspaceRecoveries(db);
    expect(readSystemRecovery((await action(adopted.id)).evidence)?.generationId).toBe(generation);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
  });

  it.each(["native", "legacy", "native_export", "legacy_snapshot", "native_snapshot"])("delivers only saved user input once through ordinary admission: %s", async mode => {
    const f = await seed(mode.startsWith("legacy") ? "legacy" : "native", !mode.endsWith("_snapshot")), commentId = randomUUID(), queueId = randomUUID();
    if (mode === "native_snapshot") {
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: {
        schema: "paperclip.native-workspace-sync/v3", state: "prepared", descriptorSha256: "a".repeat(64),
        baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: f.issueId,
        leaseId: f.lease.id, providerLeaseId: f.providerLeaseId, remoteCwd: f.remote, resourceDisposition: "destroy",
      } } }).where(eq(heartbeatRuns.id, f.runId));
      await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
        kind: "active_run_watchdog", status: "resolved", ownerType: "system", outcome: "blocked",
        cause: "execution_finalization_deadline_exceeded", fingerprint: randomUUID(), nextAction: "Inspect original failure",
        evidence: { runId: f.runId, automaticRecovery: { replay: "blocked" } } });
    }
    if (mode === "native_export") {
      await db.update(issueRecoveryActions).set({ cause: "native_workspace_sync_out_retry_exhausted", evidence: { runId: f.runId } }).where(eq(issueRecoveryActions.id, f.actionId));
      await db.update(heartbeatRuns).set({ resultJson: {} }).where(eq(heartbeatRuns.id, f.runId));
    }
    const source = await run(f.runId);
    // Occupy the agent, not this workspace. This keeps the admitted turn queued
    // so this test does not substitute a model mock for recovery evidence.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "board", body: "Confirm the existing publication. Do not publish it again." });
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: source.agentId,
      source: "automation", reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId: f.issueId, commentId, _paperclipWakeContext: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentIds: [commentId], wakeCommentId: commentId } } });
    await recoverRetainedWorkspace(f.input);
    const service = heartbeatService(db);
    await Promise.all([service.resumeRemoteStopComments(await run(f.runId)), service.resumeRemoteStopComments(await run(f.runId))]);
    const turns = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(turns).toHaveLength(1);
    expect(turns[0].contextSnapshot).toMatchObject({ forceFreshSession: true, previousRunId: f.runId, wakeCommentIds: [commentId] });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId)))[0]).toMatchObject({ status: "coalesced", runId: turns[0].id });
    expect((await run(f.runId)).status).toBe("failed");
    if (mode.endsWith("_snapshot")) {
      expect(await readFreshWorkspaceReadiness(db, turns[0])).toMatchObject({
        mode: "fresh_isolated_workspace", retryIntentId: queueId, sourceRunId: f.runId, retainedSourceIds: [f.lease.id] });
      const fresh = path.join(root, randomUUID()); await mkdir(fresh);
      const attached = await attachPreservedWorkspaceSnapshots({ db, companyId: f.companyId, issueId: f.issueId,
        sourceRunIds: [turns[0].id], cwd: fresh });
      expect(attached).toHaveLength(1);
      expect(await readFile(path.join(attached[0].path, "files", "saved.txt"), "utf8")).toBe("finished work\n");
      expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
      if (mode === "native_snapshot") expect((await run(f.runId)).runnerProfileJson?.nativeWorkspaceSync)
        .toMatchObject({ state: "prepared", finalHostSha256: null });
    }
  }, 30_000);

  it.each(["stopped", "unverified_stop"])("retries a recovered snapshot with sibling holds once: %s", async state => {
    const f = await seed("native", false);
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: {
      schema: "paperclip.native-workspace-sync/v3", state: "prepared", descriptorSha256: "a".repeat(64),
      baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: f.issueId,
      leaseId: f.lease.id, providerLeaseId: f.providerLeaseId, remoteCwd: f.remote, resourceDisposition: "keep_running",
    } } }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "resolved", ownerType: "board", outcome: "blocked",
      cause: "provider_failure_meaning_unverified", fingerprint: randomUUID(), nextAction: "Inspect original failure",
      evidence: { runId: f.runId, automaticRecovery: { replay: "blocked" } } });
    const source = await run(f.runId);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
    await recoverRetainedWorkspace(f.input);
    const recovered = readSystemRecovery((await action(f.actionId)).evidence)!;
    expect(recovered.state).toBe("complete");
    expect(recovered.intentId).toBeNull();
    if (state === "unverified_stop") await db.update(environmentLeases).set({ metadata: f.lease.metadata })
      .where(eq(environmentLeases.id, f.lease.id));
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId,
      actorId: "board", actorSource: "local_implicit", idempotencyKey: randomUUID(), observedRunId: f.runId });
    const service = heartbeatService(db);
    await Promise.all([service.resumeTaskRetry(f.companyId, receipt.requestId!), service.resumeTaskRetry(f.companyId, receipt.requestId!)]);
    const turns = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    if (state === "unverified_stop") {
      expect(turns).toHaveLength(0);
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
      expect(wake.payload?.executionWait).toMatchObject({ reason: "remote_cleanup" });
      const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(await taskInterruptionPresentation(db, task)).toMatchObject({ state: "failed", canRetry: true,
        retryWait: { reason: "remote_cleanup", message: "Retry is waiting for the previous environment to stop. Your message is saved." } });
      const commentId = randomUUID(), messageWakeId = randomUUID();
      await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: "board", body: "Keep my saved message while the previous environment stops." });
      await db.insert(agentWakeupRequests).values({ id: messageWakeId, companyId: f.companyId, agentId: wake.agentId,
        source: "automation", reason: "issue_commented", status: "deferred_issue_execution",
        requestedByActorType: "user", requestedByActorId: "board", requestedAt: new Date(wake.requestedAt.getTime() + 1),
        payload: { issueId: f.issueId, commentId } });
      expect(await taskInterruptionPresentation(db, task)).toMatchObject({ intentId: messageWakeId,
        retryWait: { reason: "remote_cleanup" } });
      await db.update(agentWakeupRequests).set({ status: "coalesced" }).where(eq(agentWakeupRequests.id, receipt.requestId!));
      const newInput = await taskInterruptionPresentation(db, task);
      expect(newInput).toMatchObject({ state: "working", intentId: messageWakeId });
      expect(newInput).not.toHaveProperty("retryWait");
      return;
    }
    expect(turns).toHaveLength(1);
    expect(turns[0].contextSnapshot).toMatchObject({ forceFreshSession: true, previousRunId: f.runId, taskRetryRequestId: receipt.requestId });
    expect(await readFreshWorkspaceReadiness(db, turns[0])).toMatchObject({ mode: "fresh_isolated_workspace", sourceRunId: f.runId });
    const fresh = path.join(root, randomUUID()); await mkdir(fresh);
    const attached = await attachPreservedWorkspaceSnapshots({ db, companyId: f.companyId, issueId: f.issueId,
      sourceRunIds: [turns[0].id], cwd: fresh });
    expect(await readFile(path.join(attached[0].path, "files", "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
    const final = readSystemRecovery((await action(f.actionId)).evidence)!;
    expect(final).toMatchObject({ generationId: recovered.generationId, attempts: recovered.attempts,
      retriesUsed: recovered.retriesUsed, preservationOperationIds: recovered.preservationOperationIds, intentId: receipt.requestId });
    expect((await run(f.runId)).status).toBe("failed");
  }, 30_000);

  it.each(["copyback_unknown", "source_unavailable", "executor_unknown"])("ordinary task Retry evaluates fresh isolation independently: %s", async failure => {
    const f = await seed("legacy", false);
    const source = await run(f.runId);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
    if (failure === "copyback_unknown") await db.update(heartbeatRuns).set({ runnerProfileJson: {
      ...source.runnerProfileJson, nativeWorkspaceFinalizationOwner: {
        token: randomUUID(), hostname: "previous-controller", pid: 123, processStartedAt: new Date().toISOString(),
      },
    } }).where(eq(heartbeatRuns.id, f.runId));
    else f.runtime.resumeRunLease.mockRejectedValue(new Error("Provider source unavailable"));
    await recoverRetainedWorkspace(f.input);
    if (failure === "executor_unknown") await db.update(environmentLeases).set({
      metadata: sql`${environmentLeases.metadata} - 'remoteExecutionTermination'`,
    }).where(eq(environmentLeases.id, f.lease.id));
    const commentId = randomUUID(), queueId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "local-board", body: "Use the completed result. Do not publish it again." });
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: source.agentId,
      source: "on_demand", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: "local-board",
      payload: { issueId: f.issueId, commentId, _paperclipWakeContext: { issueId: f.issueId,
        wakeReason: "issue_commented", wakeCommentIds: [commentId], wakeCommentId: commentId } } });
    const request = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
      actorSource: "local_implicit", observedRunId: f.runId, idempotencyKey: randomUUID() });
    const heartbeat = heartbeatService(db);
    await Promise.all([heartbeat.resumeTaskRetry(f.companyId, request.requestId!), heartbeat.resumeTaskRetry(f.companyId, request.requestId!)]);
    const turns = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(turns).toHaveLength(failure === "executor_unknown" ? 0 : 1);
    if (turns[0]) {
      expect(turns[0].contextSnapshot?.wakeCommentIds).toEqual([commentId]);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId)))[0])
        .toMatchObject({ runId: turns[0].id, status: "coalesced" });
      expect(await readFreshWorkspaceReadiness(db, turns[0])).toMatchObject({ mode: "fresh_isolated_workspace", retryIntentId: request.requestId });
      // A restarted dispatch worker finds the same run and cannot create another.
      await heartbeatService(db).resumeTaskRetry(f.companyId, request.requestId!);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")))).toHaveLength(1);
    }
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
  }, 30_000);

  it("queues cleanup only after verified persistence and keeps it separate from recovery", async () => {
    const f = await seed();
    await scheduleRecoveredWorkspaceCleanup(db, await run(f.runId));
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0].status).toBe("released");
    await recoverRetainedWorkspace(f.input);
    await scheduleRecoveredWorkspaceCleanup(db, await run(f.runId));
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0]).toMatchObject({
      status: "pending_cleanup", leasePolicy: "ephemeral", metadata: { workspaceRecoveryCleanup: { runId: f.runId } } });
    expect(f.runtime.retryPendingSandboxTeardown).toHaveBeenCalledOnce();
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
  }, 30_000);

  it.each(["single", "multiple", "interrupted"])("continues an existing Retry after signed absence evidence for every retained allocation: %s", async mode => {
    const count = mode === "single" ? 1 : 2;
    const f = await seed();
    const leaseIds = [f.lease.id];
    if (count === 2) {
      const [additional] = await db.insert(environmentLeases).values({ ...f.lease, id: randomUUID(),
        providerLeaseId: randomUUID(), status: "pending_cleanup", cleanupStatus: "failed", releasedAt: null }).returning();
      leaseIds.push(additional.id);
      const recovery = { schema: "paperclip.workspace-restore-recovery.v1", leaseIds };
      await db.update(heartbeatRuns).set({ resultJson: sql`${heartbeatRuns.resultJson} || ${JSON.stringify({ workspaceRestoreRecovery: recovery })}::jsonb` })
        .where(eq(heartbeatRuns.id, f.runId));
      await db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({ workspaceRestoreRecovery: recovery })}::jsonb` })
        .where(eq(issueRecoveryActions.id, f.actionId));
    }
    const source = await run(f.runId);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
    const [stoppedLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    expect(await prepareStoppedSandboxForRecovery(db, stoppedLease)).not.toBeNull();
    f.runtime.resumeRunLease.mockRejectedValue(new Error("retained allocation unavailable"));
    f.runtime.retryPendingSandboxTeardown.mockRejectedValue(new Error("retained allocation unavailable"));
    const request = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
      actorSource: "local_implicit", observedRunId: f.runId, idempotencyKey: randomUUID() });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", "fixture-stack");
    vi.stubEnv("PAPERCLIP_CLOUD_API_ORIGIN", "https://cloud.example");
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "fixture-token");
    vi.stubEnv("PAPERCLIP_PRIMARY_HOST", "fixture.paperclip.test");
    vi.stubEnv("PAPERCLIP_AUTH_SECRET", "fixture-auth-secret");
    vi.stubEnv("PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS", JSON.stringify({ keys: [{
      ...publicKey.export({ format: "jwk" }), kid: "absence-test", alg: "EdDSA", use: "sig",
    }] }));
    const originalFetch = globalThis.fetch;
    const observed: string[] = [];
    let interrupted = mode === "interrupted";
    const fetchProof = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (!String(url).endsWith("/v1/tenant/sandbox-absence")) return originalFetch(url, init);
      const binding = JSON.parse(String(init?.body));
      observed.push(binding.leaseId);
      if (mode === "interrupted" && binding.leaseId === f.lease.id && observed.length > 2) return new Response(null, { status: 503 });
      if (interrupted && binding.leaseId !== f.lease.id) return new Response(null, { status: 503 });
      const seconds = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "paperclip-sandbox-absence+jwt", kid: "absence-test" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ v: 1, iss: "paperclip-cloud", aud: "paperclip-sandbox-absence/v1",
        sub: "fixture-stack", ...binding, absent: true, iat: seconds, exp: seconds + 60 })).toString("base64url");
      return Response.json({ receipt: `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}` });
    });
    try {
      await recoverRetainedWorkspace(f.input);
      if (interrupted) {
        expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).not.toBe("exhausted");
        interrupted = false;
        await makeRetryDue(f.actionId);
        await recoverRetainedWorkspace(f.input);
      }
      const leases = await db.select().from(environmentLeases).where(inArray(environmentLeases.id, leaseIds));
      expect(leases).toHaveLength(count);
      expect(observed).toEqual(mode === "interrupted" ? [leaseIds[0], leaseIds[1], leaseIds[1]] : leaseIds);
      for (const lease of leases) expect(lease).toMatchObject({ status: "released", cleanupStatus: "success",
        metadata: { remoteExecutionTermination: { state: "destroyed" } } });
      expect(readSystemRecovery((await action(f.actionId)).evidence)).toMatchObject({
        state: "exhausted", failure: { code: "source_unavailable", retryClass: "use_alternative_strategy" },
      });
      expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
      expect(f.runtime.retryPendingSandboxTeardown).not.toHaveBeenCalled();
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.companyId, f.companyId))).toHaveLength(0);
      const heartbeat = heartbeatService(db);
      await Promise.all([heartbeat.resumeTaskRetry(f.companyId, request.requestId!), heartbeat.resumeTaskRetry(f.companyId, request.requestId!)]);
      const turns = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
      expect(turns).toHaveLength(1);
      expect(await readFreshWorkspaceReadiness(db, turns[0])).toMatchObject({ mode: "fresh_isolated_workspace", retryIntentId: request.requestId });
      expect((await run(f.runId)).status).toBe("failed");
      expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
    } finally { fetchProof.mockRestore(); vi.unstubAllEnvs(); }
  }, 30_000);

  it.each(["pause", "cancelled", "approval", "budget", "reassigned"])("keeps the %s gate after files recover", async gate => {
    const f = await seed(), commentId = randomUUID(), queueId = randomUUID();
    const source = await run(f.runId);
    const [occupied] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" }).returning();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "board", body: "Confirm the existing publication. Do not publish it again." });
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: source.agentId,
      source: "automation", reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId: f.issueId, commentId, _paperclipWakeContext: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentIds: [commentId], wakeCommentId: commentId } } });
    await recoverRetainedWorkspace(f.input);
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
    if (gate === "pause") {
      const holdId = randomUUID();
      await db.insert(issueTreeHolds).values({ id: holdId, companyId: f.companyId, rootIssueId: f.issueId, mode: "pause", status: "active" });
      await db.insert(issueTreeHoldMembers).values({ companyId: f.companyId, holdId, issueId: f.issueId, depth: 0, issueTitle: "Recover existing work", issueStatus: "blocked" });
    }
    if (gate === "cancelled") await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
    if (gate === "approval") {
      const approvalId = randomUUID();
      await db.insert(approvals).values({ id: approvalId, companyId: f.companyId, type: "hire_agent", status: "pending", payload: {} });
      await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issueId, approvalId });
    }
    if (gate === "budget") {
      await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "agent", scopeId: source.agentId,
        windowKind: "calendar_month_utc", amount: 100, hardStopEnabled: true });
      await db.insert(costEvents).values({ companyId: f.companyId, agentId: source.agentId,
        provider: "test", model: "test", costCents: 100, occurredAt: new Date(), billingType: "metered_api" });
    }
    if (gate === "reassigned") await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "board" }).where(eq(issues.id, f.issueId));
    const admission = heartbeatService(db).resumeRemoteStopComments(await run(f.runId));
    if (gate === "budget") await expect(admission).rejects.toThrow("budget hard-stop");
    else await admission;
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.id} not in (${f.runId}::uuid, ${occupied.id}::uuid)`, inArray(heartbeatRuns.status, ["queued", "running"])))).toHaveLength(0);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId)))[0].runId).toBeNull();
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
  }, 30_000);

  it("keeps an unverified old copyback owner fenced without exposing a certification form", async () => {
    const f = await seed();
    const prior = { token: randomUUID(), hostname: "previous-controller", pid: 123, processStartedAt: new Date().toISOString() };
    const source = await run(f.runId);
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...source.runnerProfileJson, nativeWorkspaceFinalizationOwner: prior } }).where(eq(heartbeatRuns.id, f.runId));
    await recoverRetainedWorkspace(f.input);
    expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
    expect((await run(f.runId)).runnerProfileJson?.nativeWorkspaceFinalizationOwner).toEqual(prior);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ workspaceRepairRequired: true,
      workspaceRecovery: { status: "queued", canRetry: false } });
  }, 30_000);

  it("binds the first automatic repair to authoritative old-controller stop proof without an accepted result", async () => {
    const f = await seed("legacy");
    const worker = { provider: "railway" as const, projectId: randomUUID(), environmentId: randomUUID(), serviceId: randomUUID(), deploymentId: randomUUID() };
    const prior = { token: randomUUID(), hostname: "previous-controller", pid: 123, processStartedAt: new Date().toISOString(), worker };
    const source = await run(f.runId);
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...source.runnerProfileJson, nativeWorkspaceFinalizationOwner: prior } }).where(eq(heartbeatRuns.id, f.runId));
    // This is the verified platform boundary. Signature and identity validation
    // have independent coverage in native-workspace-platform-proof.test.ts.
    const proof = vi.spyOn(workerProof, "requestWorkspaceWorkerStopProof").mockResolvedValue({ status: "verified", proof: {
      v: 1, iss: "paperclip-cloud", aud: "paperclip-workspace-worker-stop/v1", sub: "test-stack", stopped: true,
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 30,
      runId: f.runId, ownerToken: prior.token, worker,
    } });
    try {
      await recoverRetainedWorkspace(f.input);
      expect(proof).toHaveBeenCalledWith({ runId: f.runId, ownerToken: prior.token, worker });
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
      expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.companyId, f.companyId))).toHaveLength(0);
    } finally { proof.mockRestore(); }
  }, 30_000);

  it("retries persistence after rollback without repeating or discarding the copied work", async () => {
    const f = await seed();
    const failCommit = vi.spyOn(activity, "persistActivity").mockRejectedValueOnce(new Error("Interrupted receipt transaction"));
    try { await recoverRetainedWorkspace(f.input); } finally { failCommit.mockRestore(); }
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
    expect(await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, f.companyId), eq(workspaceOperations.phase, "workspace_recovery")))).toHaveLength(1);
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    const pending = await action(f.actionId);
    await db.update(issueRecoveryActions).set({ evidence: { ...pending.evidence, systemRecovery: { ...readSystemRecovery(pending.evidence), nextAttemptAt: 0 } } }).where(eq(issueRecoveryActions.id, f.actionId));
    await recoverRetainedWorkspace(f.input);
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
  }, 30_000);

  it("persists six automatic attempts and admits one new generation per deliberate retry", async () => {
    const f = await seed();
    f.runtime.resumeRunLease.mockRejectedValue(new Error("Temporary provider failure"));
    for (let attempt = 1; attempt <= 6; attempt++) {
      await recoverRetainedWorkspace(f.input);
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.attempts).toBe(attempt);
      if (attempt < 6) await makeRetryDue(f.actionId);
    }
    await recoverRetainedWorkspace(f.input);
    expect(f.runtime.resumeRunLease).toHaveBeenCalledTimes(6);
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("exhausted");
    const before = readSystemRecovery((await action(f.actionId)).evidence)!;
    const request = { ...f.input, idempotencyKey: randomUUID(), actorId: "board" };
    await requestWorkspaceRecovery(request); await requestWorkspaceRecovery(request);
    await recoverRetainedWorkspace(f.input); await recoverRetainedWorkspace(f.input);
    const after = readSystemRecovery((await action(f.actionId)).evidence)!;
    expect(f.runtime.resumeRunLease).toHaveBeenCalledTimes(7);
    expect(after.generationId).not.toBe(before.generationId);
    expect(after.attempts).toBe(1);
    expect(after.revision).toBeGreaterThan(before.revision);
  }, 30_000);

  const restartFailure = (diskFull: boolean) => new Error(diskFull
    ? "Sandbox failed to start with state: error, error reason: write /home/daytona/workspace/.git/index: no space left on device"
    : "Sandbox failed to start with state: error");
  const leaseRow = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0]!;

  it.each(["disk_full", "unknown_failure"] as const)("lets saved input continue after a file-preserving restart fails on a sandbox that cannot stop: %s", async failure => {
    const f = await seed(), commentId = randomUUID(), queueId = randomUUID();
    const stopped = (await leaseRow(f.lease.id)).metadata?.remoteExecutionTermination;
    f.runtime.resumeRunLease.mockRejectedValue(restartFailure(failure === "disk_full"));
    f.runtime.retryPendingSandboxTeardown.mockRejectedValue(new Error("Sandbox is in an error state"));
    const source = await run(f.runId);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "board", body: "Continue from a clean workspace." });
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: source.agentId,
      source: "automation", reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId: f.issueId, commentId, _paperclipWakeContext: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentIds: [commentId], wakeCommentId: commentId } } });
    const attempts = failure === "disk_full" ? 1 : 6;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await recoverRetainedWorkspace(f.input);
      if (attempt < attempts) await makeRetryDue(f.actionId);
    }
    await heartbeatService(db).resumeRemoteStopComments(await run(f.runId));
    const turns = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(turns).toHaveLength(1);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId)))[0]).toMatchObject({ status: "coalesced", runId: turns[0].id });
    expect(await readFreshWorkspaceReadiness(db, turns[0])).toMatchObject({ mode: "fresh_isolated_workspace",
      retryIntentId: queueId, sourceRunId: f.runId, retainedSourceIds: [f.lease.id] });
    const lease = await leaseRow(f.lease.id);
    expect(lease).toMatchObject({ status: "released", cleanupStatus: "success" });
    expect(hasRemoteTerminationReceipt(lease)).toBe(true);
    expect(lease.metadata?.remoteExecutionTermination).toEqual(stopped);
    expect(lease.metadata).not.toHaveProperty("sandboxStopAndRetain");
    expect(readSystemRecovery((await action(f.actionId)).evidence)).toMatchObject({ state: "exhausted", attempts,
      failure: failure === "disk_full" ? { code: "source_unavailable", retryClass: "use_alternative_strategy" }
        : { code: "provider_unavailable", retryClass: "retry_transient", cause: { label: "provider_error", code: null, status: null } } });
    if (failure === "disk_full") expect(readSystemRecovery((await action(f.actionId)).evidence)?.failure).not.toHaveProperty("cause");
    expect(f.runtime.resumeRunLease).toHaveBeenCalledTimes(attempts);
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
  }, 60_000);

  it("continues a Retry in a fresh workspace without repeating a restart that cannot succeed", async () => {
    const f = await seed();
    f.runtime.resumeRunLease.mockRejectedValue(restartFailure(true));
    f.runtime.retryPendingSandboxTeardown.mockRejectedValue(new Error("Sandbox is in an error state"));
    const source = await run(f.runId);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
    await recoverRetainedWorkspace(f.input);
    const exhausted = readSystemRecovery((await action(f.actionId)).evidence)!;
    expect(exhausted).toMatchObject({ state: "exhausted", failure: { code: "source_unavailable", retryClass: "use_alternative_strategy" } });
    const request = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
      actorSource: "local_implicit", observedRunId: f.runId, idempotencyKey: randomUUID() });
    expect(request).toMatchObject({ accepted: true, stale: false });
    expect(readSystemRecovery((await action(f.actionId)).evidence)).toMatchObject({ generationId: exhausted.generationId,
      state: "exhausted", attempts: 1, intentId: request.requestId });
    await recoverRetainedWorkspace(f.input);
    expect(f.runtime.resumeRunLease).toHaveBeenCalledOnce();
    const heartbeat = heartbeatService(db);
    await Promise.all([heartbeat.resumeTaskRetry(f.companyId, request.requestId!), heartbeat.resumeTaskRetry(f.companyId, request.requestId!)]);
    const turns = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(turns).toHaveLength(1);
    expect(turns[0].contextSnapshot).toMatchObject({ taskRetryRequestId: request.requestId, previousRunId: f.runId });
    expect(await readFreshWorkspaceReadiness(db, turns[0])).toMatchObject({ mode: "fresh_isolated_workspace",
      retryIntentId: request.requestId, sourceRunId: f.runId });
  }, 30_000);

  it("keeps the stop obligation once the provider has confirmed a restart", async () => {
    const f = await seed();
    f.runtime.resumeRunLease.mockResolvedValue({ providerLeaseId: f.providerLeaseId, metadata: { remoteCwd: path.join(f.remote, "elsewhere") } });
    f.runtime.retryPendingSandboxTeardown.mockRejectedValue(new Error("Provider stop unavailable"));
    await recoverRetainedWorkspace(f.input);
    const lease = await leaseRow(f.lease.id);
    expect(lease).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed" });
    expect(hasRemoteTerminationReceipt(lease)).toBe(false);
    expect(readStopOnlyCleanup(lease)).toMatchObject({ runId: f.runId, leaseId: f.lease.id });
    expect(lease.metadata?.sandboxStopAndRetain).not.toHaveProperty("priorStop");
    expect(f.runtime.retryPendingSandboxTeardown).toHaveBeenCalledOnce();
  }, 30_000);

  it("restores the stop receipt after an interrupted restart that the provider never confirmed", async () => {
    const f = await seed();
    const stopped = (await leaseRow(f.lease.id)).metadata?.remoteExecutionTermination;
    expect(await prepareStoppedSandboxForRecovery(db, await leaseRow(f.lease.id))).not.toBeNull();
    f.runtime.resumeRunLease.mockRejectedValue(restartFailure(true));
    f.runtime.retryPendingSandboxTeardown.mockRejectedValue(new Error("Sandbox is in an error state"));
    await recoverRetainedWorkspace(f.input);
    const lease = await leaseRow(f.lease.id);
    expect(hasRemoteTerminationReceipt(lease)).toBe(true);
    expect(lease.metadata?.remoteExecutionTermination).toEqual(stopped);
    expect(readSystemRecovery((await action(f.actionId)).evidence)).toMatchObject({ state: "exhausted",
      failure: { code: "source_unavailable", retryClass: "use_alternative_strategy" } });
    expect(f.runtime.retryPendingSandboxTeardown).toHaveBeenCalledTimes(2);
    expect(f.runtime.resumeRunLease).toHaveBeenCalledOnce();
  }, 30_000);

  it("discovers historical sources in the periodic sweep without creating a user request", async () => {
    const f = await seed("legacy"), onRecovered = vi.fn(async () => {});
    await expect.poll(async () => {
      await reconcileRetainedWorkspaces(db, f.input.environmentRuntime, onRecovered);
      return readWorkspaceRecovery((await action(f.actionId)).evidence)?.status;
    }, { timeout: 20_000 }).toBe("recovered");
    await expect.poll(() => onRecovered.mock.calls.length).toBeGreaterThan(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
  }, 30_000);

  it("uses the retained-source index rather than scanning unrelated recovery history", async () => {
    const f = await seed();
    await db.insert(issueRecoveryActions).values(Array.from({ length: 3000 }, (_, i) => ({
      companyId: f.companyId, sourceIssueId: f.issueId, status: "resolved", kind: "active_run_watchdog",
      cause: "unrelated_history", fingerprint: `history-${i}`, nextAction: "", evidence: {},
    })));
    await db.execute(sql`analyze ${issueRecoveryActions}`);
    await adoptHistoricalWorkspaceRecoveries(db);
    const plan = await db.execute(sql`explain (analyze, format json) ${retainedWorkspaceCandidates(db)}`);
    expect(JSON.stringify(plan)).toContain("issue_recovery_actions_system_recovery_due_idx");
    expect((await retainedWorkspaceCandidates(db)).length).toBeLessThanOrEqual(5);
  }, 30_000);

  it.each([false, true])("discovers a committed repair with unscheduled destruction without waiting input (reconciled: %s)", async reconciled => {
    const f = await seed();
    await recoverRetainedWorkspace(f.input);
    if (reconciled) {
      const current = await action(f.actionId);
      await db.update(issueRecoveryActions).set({ evidence: { ...current.evidence, executionReconciliation: { runId: f.runId } } }).where(eq(issueRecoveryActions.id, f.actionId));
    }
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0].status).toBe("released");
    const restarted = createDb(connectionString), onRecovered = vi.fn(async (_source: { id: string }) => {});
    try {
      await expect.poll(async () => {
        await reconcileRetainedWorkspaces(restarted, f.input.environmentRuntime, onRecovered);
        return (await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0].status;
      }, { timeout: 20_000 }).toBe("pending_cleanup");
      await expect.poll(() => onRecovered.mock.calls.filter(([source]) => source.id === f.runId).length).toBe(1);
      expect(await retainedWorkspaceCandidates(restarted)).not.toEqual(expect.arrayContaining([expect.objectContaining({ action: expect.objectContaining({ id: f.actionId }) })]));
      expect(f.runtime.resumeRunLease.mock.calls.filter(([input]) => input.lease.id === f.lease.id)).toHaveLength(1);
      expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    } finally {
      await restarted.$client.end();
    }
  }, 30_000);
  async function queuedResetFixture(nativeDescriptor = true, ephemeral = false) {
    const f = await seed("native", nativeDescriptor, "keep_running", false, ephemeral), original = await run(f.runId);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    await db.update(issues).set({ conversationAgentId: original.agentId, conversationUserId: "operator", conversationState: "active", status: "in_progress" }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ status: "cancelled", nativePhase: "terminal_failure", errorCode: "cancelled", resultJson: {
      cancelledByActorType: "user", cancelledByUserId: "operator",
      cancellation: requestedRunCancellation({ cancelledByActorType: "user", cancelledByUserId: "operator" }, "Stop"),
      executionCancellation: { state: "requested", requestedAt: new Date().toISOString() },
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: f.runId, companyId: f.companyId, issueId: f.issueId,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() },
    } }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(environmentLeases).set({ status: "active", releasedAt: null, cleanupStatus: null, metadata: f.lease.metadata }).where(eq(environmentLeases.id, f.lease.id));
    const [reset] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "operator", body: "/new" }).returning();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId, { conversationResetCommentId: reset.id })).toBeNull();
    const context = { source: "issue.comment", issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: reset.id, wakeCommentIds: [reset.id] };
    const payload = withQueuedCommentIdsInWakePayload({ issueId: f.issueId, commentId: reset.id, mutation: "comment", _paperclipWakeContext: context }, [reset.id]);
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: original.agentId,
      source: "on_demand", triggerDetail: "manual", reason: "issue_commented", status: "claimed", claimedAt: new Date(),
      requestedByActorType: "user", requestedByActorId: "operator", payload }).returning();
    const [queued] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: original.agentId,
      invocationSource: "on_demand", triggerDetail: "manual", status: "queued", runtimeMode: "legacy", responsibleUserId: "operator",
      wakeupRequestId: wake.id, sessionIdBefore: "saved-native-session-before-reset", contextSnapshot: context }).returning();
    await db.update(agentWakeupRequests).set({ runId: queued.id }).where(eq(agentWakeupRequests.id, wake.id));
    await db.update(issues).set({ executionRunId: queued.id, executionAgentNameKey: "Worker", executionLockedAt: new Date() }).where(eq(issues.id, f.issueId));
    const deps = callbacks(db), control = createHeartbeatRunControl(db, deps), execution = createAdapterExecutionControl();
    const queueDeps = createHeartbeatQueueTestDependencies(db);
    queueDeps.activeRunExecutions = deps.activeRunExecutions;
    queueDeps.getAgent.mockResolvedValue((await db.select().from(agents).where(eq(agents.id, original.agentId)))[0]);
    queueDeps.instanceSettings.getExperimental.mockResolvedValue({ enableAgentChat: true, enableNativeRunner: true } as Awaited<ReturnType<typeof queueDeps.instanceSettings.getExperimental>>);
    const queue = createHeartbeatQueue(db, queueDeps);
    vi.mocked(deps.enqueueWakeup).mockImplementation(queue.enqueueWakeup);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: original.agentId, status: "running", invocationSource: "assignment" });
    deps.activeRunExecutions.add(f.runId); adapterExecutionControls.set(f.runId, execution);
    return { f, original, reset, wake, queued, deps, control, execution, queueDeps, queue };
  }

  async function coalesceQueuedReset(t: Awaited<ReturnType<typeof queuedResetFixture>>) {
    const { f, original, reset, wake, queued } = t;
    const [followup] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "operator", body: "/new" }).returning();
    const incoming = { source: "issue.comment", issueId: f.issueId, wakeReason: "issue_commented",
      wakeCommentId: followup.id, wakeCommentIds: [followup.id] };
    await db.transaction(async tx => {
      const scope = createAdmissionTransactionScope(f.companyId, tx as unknown as typeof db);
      const actor = { companyId: f.companyId, wakeupRequestId: wake.id, requestedByActorType: "user", requestedByActorId: "operator" };
      expect(await createWakeAdmissionReader().matchesActiveWakeActor(scope, actor)).toBe(true);
      expect(await createWakeAdmissionReader().matchesActiveWakeActor(scope, { ...actor, requestedByActorId: "other-user" })).toBe(false);
      await createWakeAdmissionWriter().coalesceIntoActiveExecutionRun(scope, {
        companyId: f.companyId, agentId: original.agentId, activeExecutionRunId: queued.id, activeExecutionRunStatus: queued.status,
        mergedContextSnapshot: mergeCoalescedContextSnapshot((await run(queued.id)).contextSnapshot, incoming,
          { preserveExistingInteractionContinuation: true }),
        source: "on_demand", triggerDetail: "manual",
        payload: withQueuedCommentIdsInWakePayload({ issueId: f.issueId, mutation: "comment", _paperclipWakeContext: incoming }, [followup.id]),
        requestedByActorType: "user", requestedByActorId: "operator", idempotencyKey: null,
      });
    });
    const [originalWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    const [receipt] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.runId, queued.id), eq(agentWakeupRequests.status, "coalesced")));
    expect(originalWake.payload?.commentId).toBe(reset.id);
    expect((await run(queued.id)).contextSnapshot).toMatchObject({ wakeCommentId: followup.id,
      wakeCommentIds: [reset.id, followup.id] });
    return { followup, receipt };
  }

  async function ordinaryMixedQueuedFixture(kind: "active" | "deferred" | "deferred-different" | "system-deferred") {
    const t = await queuedResetFixture(true, kind !== "active"), { f, original, reset, wake, queued, queueDeps, queue, control } = t;
    await db.update(issues).set({ conversationAgentId: null, conversationUserId: null, conversationState: null,
      executionRunId: null, executionAgentNameKey: null, executionLockedAt: null }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ wakeupRequestId: null }).where(eq(heartbeatRuns.id, queued.id));
    await db.update(agentWakeupRequests).set({ runId: null }).where(eq(agentWakeupRequests.id, wake.id));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    const reader = createWakeAdmissionReader(), sameActor = vi.spyOn(reader, "matchesActiveWakeActor");
    queueDeps.wakeQueue.createAdmissionTransactionScope.mockImplementation(createAdmissionTransactionScope);
    queueDeps.wakeQueue.admitWakeBehindIssueExecution.mockImplementation(createAdmitWakeBehindIssueExecution({
      reader, writer: createWakeAdmissionWriter(), helpers: { filterZombieCoalesceTarget, mergeCoalescedContextSnapshot,
        shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake },
    }));
    queueDeps.liveRunExecutions.has.mockImplementation(id => t.deps.activeRunExecutions.has(id));
    const stopped = await run(f.runId);
    if (kind !== "active") {
      await db.update(heartbeatRuns).set({ status: "running", finishedAt: null, errorCode: null,
        nativePhase: "running", resultJson: null }).where(eq(heartbeatRuns.id, f.runId));
      await db.update(nativeRunFinalizations).set({ phase: "running" }).where(eq(nativeRunFinalizations.runId, f.runId));
      await db.update(issues).set({ executionRunId: f.runId, executionAgentNameKey: "worker", executionLockedAt: new Date() }).where(eq(issues.id, f.issueId));
    }
    const enqueue = async (comment: typeof reset) => queue.enqueueWakeup(original.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented", requestedByActorType: "user", requestedByActorId: comment.authorUserId!,
      payload: { issueId: f.issueId, commentId: comment.id, mutation: "comment", resumeIntent: true, followUpRequested: true },
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, commentId: comment.id, wakeCommentId: comment.id,
        wakeCommentIds: [comment.id], source: "issue.comment", wakeReason: "issue_commented", resumeIntent: true, followUpRequested: true },
    });
    if (kind === "system-deferred") expect(await queue.enqueueWakeup(original.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_updated", requestedByActorType: "system", requestedByActorId: "second-user",
      payload: { issueId: f.issueId, mutation: "update" },
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, source: "issue.updated", wakeReason: "issue_updated", forceFreshSession: true },
    })).toBeNull();
    const first = await enqueue(reset);
    const [followup] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "second-user", body: "Please also preserve the second user's input." }).returning();
    const second = await enqueue(followup);
    const ids = [reset.id, followup.id];
    let admitted = first;
    if (kind === "active") { expect(first?.status).toBe("queued"); expect(second?.id).toBe(first!.id); }
    else {
      expect(first).toBeNull(); expect(second).toBeNull();
      const [pending] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
        eq(agentWakeupRequests.agentId, original.agentId), eq(agentWakeupRequests.status, "deferred_issue_execution")));
      expect(pending.payload?._paperclipWakeContext).toMatchObject({ wakeCommentIds: ids });
      expect(pending.requestedByActorType).toBe(kind === "system-deferred" ? "system" : "user");
      expect(pending.requestedByActorId).toBe(kind === "system-deferred" ? "second-user" : "operator");
      await db.update(heartbeatRuns).set({ status: "cancelled", nativePhase: "terminal_failure", finishedAt: new Date(),
        errorCode: stopped.errorCode, resultJson: stopped.resultJson }).where(eq(heartbeatRuns.id, f.runId));
      await db.update(nativeRunFinalizations).set({ phase: "terminal_failure" }).where(eq(nativeRunFinalizations.runId, f.runId));
      const [currentLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      const stopping = await prepareSandboxStopAndRetain(db, currentLease);
      expect(stopping).not.toBeNull();
      expect(await settleStopOnlyCleanup(db, stopping!, { attemptId: String(stopping!.metadata!.pendingCleanupAttemptId),
        receipt: { providerLeaseId: f.providerLeaseId, state: "stopped" } })).not.toBeNull();
      await control.acknowledgeRemoteStop(f.runId, f.companyId);
      const [last] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: kind === "deferred-different" ? "third-user" : "operator", body: "Resume after Stop and preserve all three inputs in their original order." }).returning();
      expect(last.createdAt.getTime()).toBeGreaterThan((await run(f.runId)).finishedAt!.getTime());
      ids.push(last.id); admitted = await enqueue(last);
    }
    expect(admitted?.status).toBe("queued");
    const current = await run(admitted!.id);
    const [claimedWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, current.wakeupRequestId!));
    expect(current.contextSnapshot?.wakeCommentIds).toEqual(ids);
    expect(sameActor).not.toHaveBeenCalled();
    expect(queueDeps.wakeQueue.admitWakeBehindIssueExecution.mock.calls.every(([, input]) => input.durableReceipt === undefined)).toBe(true);
    expect(queueDeps.executeRun).not.toHaveBeenCalled();
    return { ...t, queued: current, wake: claimedWake, followup, expectedIds: ids, latestAuthor: kind === "deferred-different" ? "third-user" : kind === "active" ? "second-user" : "operator" };
  }

  async function exerciseQueuedReset(nativeDescriptor: boolean, coalesced = false, ordinary?: "active" | "deferred" | "deferred-different" | "system-deferred", earlierCandidates = false) {
    const mixed = ordinary ? await ordinaryMixedQueuedFixture(ordinary) : null;
    const t = mixed ?? await queuedResetFixture(nativeDescriptor);
    const { f, original, reset, wake, queued, deps, control, execution, queueDeps, queue } = t;
    const followup = coalesced ? (await coalesceQueuedReset(t)).followup : null;
    const expectedIds = mixed?.expectedIds ?? (followup ? [reset.id, followup.id] : [reset.id]);
    const responsible = queued.responsibleUserId;
    try {
      expect(await queue.claimQueuedRun(queued)).toBeNull();
      expect((await run(queued.id)).status).toBe("queued");
      await recordRequiredWorkspaceRestoreFailure(db, await run(f.runId), { workspaceRestoreFailure: "restore_failed" }, f.lease);
      const [preservation] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId),
        eq(issueRecoveryActions.sourceIssueId, f.issueId), eq(issueRecoveryActions.fingerprint, `native-workspace:${f.runId}`)));
      f.actionId = preservation.id; f.input.actionId = preservation.id;
      await recoverRetainedWorkspace(f.input);
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.failure?.code).toBe("agent_stop_unconfirmed");
      await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success", metadata: { ...f.lease.metadata,
        remoteExecutionTermination: remoteTerminationReceipt(f.lease, { providerLeaseId: f.providerLeaseId, state: "stopped" }) } }).where(eq(environmentLeases.id, f.lease.id));
      await control.acknowledgeRemoteStop(f.runId, f.companyId);
      expect((await run(f.runId)).resultJson?.executionCancellation).toMatchObject({ state: "acknowledged", proof: "provider_termination_receipt" });
      deps.activeRunExecutions.delete(f.runId); execution.finish(); adapterExecutionControls.delete(f.runId);
      await control.resumeRemoteStopComments(await run(f.runId));
      expect(readSystemRecovery((await action(f.actionId)).evidence)!.nextAttemptAt!).toBeLessThanOrEqual(Date.now());
      const earlier: Awaited<ReturnType<typeof seed>>[] = [];
      if (earlierCandidates) for (let index = 1; index <= 2; index++) {
        const candidate = await seed("native", false, "keep_running");
        const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        await db.update(issueRecoveryActions).set({ id }).where(and(eq(issueRecoveryActions.id, candidate.actionId), eq(issueRecoveryActions.companyId, candidate.companyId)));
        candidate.actionId = id; candidate.input.actionId = id;
        await db.update(environmentLeases).set({ status: "active", releasedAt: null, cleanupStatus: null, metadata: candidate.lease.metadata }).where(eq(environmentLeases.id, candidate.lease.id));
        await requestWorkspaceRecovery({ ...candidate.input, idempotencyKey: `earlier-${index}`, actorId: "board" });
        earlier.push(candidate);
      }
      const ownedCompanies = [f.companyId, ...earlier.map(candidate => candidate.companyId)];
      const seededRuns = earlierCandidates ? await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.companyId, ownedCompanies)) : [];
      if (earlierCandidates) {
        await adoptHistoricalWorkspaceRecoveries(db);
        expect((await retainedWorkspaceCandidates(db, undefined, true)).slice(0, 2).map(row => row.action.id)).toEqual(earlier.map(candidate => candidate.actionId));
      }
      let ownedRecoveryObserved = false;
      const onRecovered = vi.fn(async (current: Awaited<ReturnType<typeof run>>) => {
        if (current.id !== f.runId) return;
        if (nativeDescriptor) expect(await inspectWorkspaceSource(db, { companyId: f.companyId, issueId: f.issueId,
          runId: f.runId, actionId: f.actionId })).toMatchObject({ status: "verified", scope: "recorded_source_identity" });
        await Promise.all([control.resumeRemoteStopComments(current), control.resumeRemoteStopComments(current)]);
        ownedRecoveryObserved = true;
      });
      const sweepSizes: number[] = [];
      let firstSweepOwned: boolean | undefined;
      const repair = async () => {
        await vi.waitFor(async () => {
          const work = await reconcileRetainedWorkspaces(db, f.environmentRuntime, onRecovered) ?? [];
          sweepSizes.push(work.length);
          await Promise.all(work);
          firstSweepOwned ??= ownedRecoveryObserved;
          expect(ownedRecoveryObserved).toBe(true);
          expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
        }, { timeout: 10_000, interval: 10 });
        expect(sweepSizes.every(size => size <= 2)).toBe(true);
      };
      if (!nativeDescriptor) await repair();
      expect(await queue.startNextQueuedRunForAgent(original.agentId)).toEqual([]);
      expect(await queue.claimQueuedRun(await run(queued.id))).toBeNull();
      const [heldWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
      expect(await isPreDispatchExecutionWaitVerified(db, await run(queued.id))).toBe(true);
      const admissionEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, queued.id));
      expect(admissionEvents.map(event => event.eventType)).toEqual(["lifecycle"]);
      expect((await run(queued.id)).nextEventSeq).toBe(2);
      expect((await run(queued.id)).sessionIdBefore).toBe(queued.sessionIdBefore);
      expect((await run(queued.id)).responsibleUserId).toBe(responsible);
      const scheduleRecoveryRetry = vi.fn(async (_runId: string) => null);
      const recoveryDependencies = { enqueueWakeup: vi.fn(async () => null), scheduleRecoveryRetry, liveRunExecutions: { has: () => false } };
      const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      const recover = (database: typeof db) => recoveryService(database, recoveryDependencies).reconcileStrandedAssignedIssues({ issueCreatedAtGte: task.createdAt });
      if (nativeDescriptor) {
        const rollback = new Error("restore_counterfactual_skipped_wake");
        await expect(db.transaction(async tx => {
          await tx.update(agentWakeupRequests).set({ status: "skipped" }).where(eq(agentWakeupRequests.id, wake.id));
          await recover(tx as unknown as typeof db);
          expect(scheduleRecoveryRetry).toHaveBeenCalledWith(queued.id);
          throw rollback;
        })).rejects.toBe(rollback);
        scheduleRecoveryRetry.mockClear();
        await recover(db);
        expect(scheduleRecoveryRetry).not.toHaveBeenCalledWith(queued.id);
      }
      expect(queueDeps.executeRun).not.toHaveBeenCalled();
      if (nativeDescriptor) await repair();
      expect(onRecovered).toHaveBeenCalledWith(expect.objectContaining({ id: f.runId, companyId: f.companyId }));
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
      if (nativeDescriptor) expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
      if (earlierCandidates) {
        expect(sweepSizes[0]).toBe(2);
        expect(firstSweepOwned).toBe(false);
        expect(sweepSizes.length).toBeGreaterThan(1);
        expect((await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.companyId, ownedCompanies))).map(row => row.id).sort()).toEqual(seededRuns.map(row => row.id).sort());
        for (const candidate of [f, ...earlier]) expect(await readFile(path.join(candidate.remote, "saved.txt"), "utf8")).toBe("finished work\n");
      }
      await Promise.all([control.resumeRemoteStopComments(await run(f.runId)),
        control.resumeRemoteStopComments(await run(f.runId))]);
      const [afterWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
      // A post-Stop message is saved behind either source shape and delivered
      // once through ordinary admission; it is never dropped by the gate.
      expect(heldWake.status).toBe("deferred_issue_execution");
      expect(afterWake).toMatchObject({ status: "coalesced", runId: expect.any(String) });
      expect(afterWake.runId).not.toBe(queued.id);
      expect((await action(f.actionId)).evidence).toMatchObject({ automaticRecovery: { replay: "explicit_user_continuation" } });
      expect(await run(queued.id)).toMatchObject({ status: "cancelled", errorCode: "execution_reconciliation_required", startedAt: null });
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`, eq(heartbeatRuns.status, "queued")));
      expect(successors).toHaveLength(1);
      expect(successors[0].contextSnapshot?.wakeCommentIds).toEqual(expectedIds);
      if (mixed) expect(deps.enqueueWakeup).toHaveBeenCalledWith(original.agentId, expect.objectContaining({ requestedByActorType: "user", requestedByActorId: mixed.latestAuthor }), wake.id);
      await recover(db);
      expect(scheduleRecoveryRetry).not.toHaveBeenCalledWith(queued.id);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, queued.id))).toHaveLength(0);
      expect((await run(queued.id)).nextEventSeq).toBe(2);
      expect(queueDeps.executeRun).not.toHaveBeenCalled();
    } finally { deps.activeRunExecutions.delete(f.runId); execution.finish(); adapterExecutionControls.delete(f.runId); }
  }

  it.each([
    { nativeDescriptor: true, title: "preserves an already queued reset until real native copyback replays its saved wake" },
    { nativeDescriptor: false, title: "saves a queued reset behind a snapshot-only source and delivers it once after recovery" },
  ])("$title", async ({ nativeDescriptor }) => exerciseQueuedReset(nativeDescriptor), 30_000);

  it.each([
    { sentAfterStop: true, title: "saves and delivers once a redirect sent during Stop settlement when the stopped source has no native baseline" },
    { sentAfterStop: false, title: "does not let input written before the Stop restart a source without a native baseline" },
  ])("$title", async ({ sentAfterStop }) => {
    // A message sent after Stop is queued while the stopped run is still
    // persisting its checkpoint. Settlement then records a workspace hold, and
    // the dispatch gate withholds the unstarted redirect. The gate must save it,
    // not skip it: the task would otherwise stay in progress with no run or wake.
    const t = await queuedResetFixture(false);
    const { f, original, reset: redirect, wake, queued, deps, control, execution, queueDeps, queue } = t;
    await db.update(issueComments).set({ body: "Actually, stop the essay. Instead give me a 5-bullet summary." })
      .where(eq(issueComments.id, redirect.id));
    // Older queued input is not a new direction and must not undo the Stop:
    // the user requested Stop only after writing it.
    if (!sentAfterStop) {
      const stoppedAt = new Date(redirect.createdAt.getTime() + 1_000), stopped = await run(f.runId);
      await db.update(heartbeatRuns).set({ finishedAt: stoppedAt, resultJson: { ...stopped.resultJson,
        cancellation: { ...(stopped.resultJson?.cancellation as Record<string, unknown>), recordedAt: stoppedAt.toISOString() } } })
        .where(eq(heartbeatRuns.id, f.runId));
    }
    try {
      expect(await queue.claimQueuedRun(queued)).toBeNull();
      expect((await run(queued.id)).status).toBe("queued");
      await recordRequiredWorkspaceRestoreFailure(db, await run(f.runId), { workspaceRestoreFailure: "restore_failed" }, f.lease);
      const [hold] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId),
        eq(issueRecoveryActions.sourceIssueId, f.issueId), eq(issueRecoveryActions.fingerprint, `native-workspace:${f.runId}`)));
      f.actionId = hold.id; f.input.actionId = hold.id;
      await recoverRetainedWorkspace(f.input);
      await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success", metadata: { ...f.lease.metadata,
        remoteExecutionTermination: remoteTerminationReceipt(f.lease, { providerLeaseId: f.providerLeaseId, state: "stopped" }) } }).where(eq(environmentLeases.id, f.lease.id));
      await control.acknowledgeRemoteStop(f.runId, f.companyId);
      deps.activeRunExecutions.delete(f.runId); execution.finish(); adapterExecutionControls.delete(f.runId);
      await control.resumeRemoteStopComments(await run(f.runId));
      await vi.waitFor(async () => {
        await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, async current => {
          if (current.id === f.runId) await control.resumeRemoteStopComments(current);
        }) ?? []);
        expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
      }, { timeout: 10_000, interval: 10 });

      // The settled hold withholds the redirect that was queued before it existed.
      expect(await queue.claimQueuedRun(await run(queued.id))).toBeNull();
      expect(await run(queued.id)).toMatchObject({ status: "cancelled", errorCode: "execution_reconciliation_required", startedAt: null });
      const [saved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
      if (!sentAfterStop) {
        expect(saved.status).toBe("skipped");
        await control.resumeRemoteStopComments(await run(f.runId));
        await queue.resumeDeferredExecutionReceipts({ companyId: f.companyId });
        expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`, eq(heartbeatRuns.status, "queued")))).toHaveLength(0);
        expect(deps.enqueueWakeup).not.toHaveBeenCalled();
        expect(queueDeps.executeRun).not.toHaveBeenCalled();
        return;
      }
      expect(saved).toMatchObject({ status: "deferred_issue_execution", runId: null,
        payload: { executionWait: { reason: "execution_recovery", recoveryActionId: hold.id } } });
      expect(saved.payload?._paperclipWakeContext).toMatchObject({ wakeCommentIds: [redirect.id] });

      // Ordinary deferred-receipt delivery re-enters admission once.
      await Promise.all([control.resumeRemoteStopComments(await run(f.runId)), control.resumeRemoteStopComments(await run(f.runId))]);
      await queue.resumeDeferredExecutionReceipts({ companyId: f.companyId });
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`, eq(heartbeatRuns.status, "queued")));
      expect(successors).toHaveLength(1);
      expect(successors[0].id).not.toBe(queued.id);
      expect(successors[0].contextSnapshot?.wakeCommentIds).toEqual([redirect.id]);
      expect(deps.enqueueWakeup).toHaveBeenCalledWith(original.agentId,
        expect.objectContaining({ requestedByActorType: "user", requestedByActorId: "operator" }), wake.id);
      expect(queueDeps.executeRun).not.toHaveBeenCalled();
    } finally { deps.activeRunExecutions.delete(f.runId); execution.finish(); adapterExecutionControls.delete(f.runId); }
  }, 30_000);

  it.each([
    { retried: false, title: "continues a message written during Stop settlement once, without a second message, after recovery already resolved" },
    { retried: true, title: "continues a message carried by a workspace-busy retry once, without a second message, after recovery already resolved" },
    // S52: the user stopped a hung native run whose runner was unreachable.
    // Its transport later failed closed, so the stopped run settled as failed
    // (native_provider_terminal_failed) instead of cancelled.
    { retried: false, failedClosed: true, title: "continues a message sent after Stop when the stopped run later failed closed" },
  ])("$title", async ({ retried, failedClosed }) => {
    // S47: the user stops (or interrupts) a native run and sends a message.
    // The native source finishes only after its stop and workspace save
    // settle, so its finishedAt is later than the message. Recovery resolves
    // first, then the dispatch gate withholds the unstarted follow-up behind
    // the recovered hold ("Saved work recovered. Send a message to continue.").
    // The message the user already sent must be saved and continued by the
    // ordinary deferred-receipt worker, not dropped.
    const t = await queuedResetFixture(false);
    const { f, original, reset: message, wake, queued, deps, control, execution, queueDeps, queue } = t;
    queueDeps.resumeExecutionWaitComments.mockImplementation(control.resumeExecutionWaitComments);
    queueDeps.releaseIssueExecutionAndPromote.mockImplementation(control.releaseIssueExecutionAndPromote);
    // The Stop was requested before the message; settlement finished after it.
    // Pin the message after the recorded Stop: the fixture writes both within
    // the same millisecond on a fast machine, which made this ordering flaky.
    const stopRecordedAt = new Date(String(((await run(f.runId)).resultJson?.cancellation as { recordedAt?: string })?.recordedAt));
    message.createdAt = new Date(stopRecordedAt.getTime() + 100);
    await db.update(issueComments).set({ body: "Actually, give me a 5-bullet summary instead.", createdAt: message.createdAt })
      .where(eq(issueComments.id, message.id));
    await db.update(heartbeatRuns).set({ finishedAt: new Date(message.createdAt.getTime() + 1_000) })
      .where(eq(heartbeatRuns.id, f.runId));
    let pending = queued;
    let systemWakeId: string | null = null;
    let expectedIds = [message.id];
    if (retried) {
      // The first follow-up was claimed, met the stopped run's unsettled
      // workspace save, and was parked as a system-owned workspace-busy retry
      // carrying the message. While that retry waited, the user added a second
      // message, which coalesced into it; a further retry carried both.
      const busy = () => ({ status: "cancelled" as const, startedAt: new Date(), finishedAt: new Date(), errorCode: "workspace_busy",
        resultJson: { executionRecovery: { kind: "workspace_wait", providerWorkStarted: false },
          cancellation: { source: "control_plane", expected: true, initiator: { type: "system" }, reason: "Waiting for the shared execution workspace", recordedAt: new Date().toISOString() } } });
      await db.update(heartbeatRuns).set(busy()).where(eq(heartbeatRuns.id, queued.id));
      await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, wake.id));
      const retry = async (parentId: string, context: Record<string, unknown>, status: "queued" | "cancelled") => {
        const [systemWake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: original.agentId,
          source: "automation", triggerDetail: "system", reason: "workspace_busy_retry", status: status === "queued" ? "claimed" : "cancelled",
          claimedAt: new Date(), requestedByActorType: "system", payload: { issueId: f.issueId, retryOfRunId: parentId } }).returning();
        const [retryRun] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: original.agentId,
          invocationSource: "automation", triggerDetail: "system", status: "queued", runtimeMode: "legacy", responsibleUserId: "operator",
          wakeupRequestId: systemWake.id, retryOfRunId: parentId, scheduledRetryReason: "workspace_busy", scheduledRetryAttempt: 1,
          contextSnapshot: { ...context, wakeReason: "workspace_busy_retry", retryOfRunId: parentId, retryReason: "workspace_busy" } }).returning();
        await db.update(agentWakeupRequests).set({ runId: retryRun.id }).where(eq(agentWakeupRequests.id, systemWake.id));
        return { retryRun, systemWake };
      };
      const first = await retry(queued.id, queued.contextSnapshot ?? {}, "cancelled");
      const [second] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: "operator", body: "Also keep it under 100 words." }).returning();
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: original.agentId,
        source: "on_demand", triggerDetail: "manual", reason: "issue_commented", status: "coalesced", runId: first.retryRun.id,
        requestedByActorType: "user", requestedByActorId: "operator",
        payload: { issueId: f.issueId, commentId: second.id, mutation: "comment", coalescedIntoWakeupRequestId: first.systemWake.id } });
      await db.update(heartbeatRuns).set(busy()).where(eq(heartbeatRuns.id, first.retryRun.id));
      expectedIds = [message.id, second.id];
      const carried = { ...queued.contextSnapshot, wakeCommentId: second.id, wakeCommentIds: expectedIds };
      const last = await retry(first.retryRun.id, carried, "queued");
      pending = last.retryRun;
      await db.update(issues).set({ executionRunId: pending.id }).where(eq(issues.id, f.issueId));
      systemWakeId = last.systemWake.id;
    }
    try {
      expect(await queue.claimQueuedRun(pending)).toBeNull();
      await recordRequiredWorkspaceRestoreFailure(db, await run(f.runId), { workspaceRestoreFailure: "restore_failed" }, f.lease);
      const [hold] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId),
        eq(issueRecoveryActions.sourceIssueId, f.issueId), eq(issueRecoveryActions.fingerprint, `native-workspace:${f.runId}`)));
      f.actionId = hold.id; f.input.actionId = hold.id;
      await recoverRetainedWorkspace(f.input);
      await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success", metadata: { ...f.lease.metadata,
        remoteExecutionTermination: remoteTerminationReceipt(f.lease, { providerLeaseId: f.providerLeaseId, state: "stopped" }) } }).where(eq(environmentLeases.id, f.lease.id));
      await control.acknowledgeRemoteStop(f.runId, f.companyId);
      deps.activeRunExecutions.delete(f.runId); execution.finish(); adapterExecutionControls.delete(f.runId);
      // Recovery resolves and its completion hooks run before the follow-up is withheld.
      await control.resumeRemoteStopComments(await run(f.runId));
      await vi.waitFor(async () => {
        await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, async current => {
          if (current.id === f.runId) await control.resumeRemoteStopComments(current);
        }) ?? []);
        expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
      }, { timeout: 10_000, interval: 10 });
      if (failedClosed) {
        await db.update(heartbeatRuns).set({ status: "failed", errorCode: "native_provider_terminal_failed",
          error: "Notification transport failed closed: runner_process_termination_unconfirmed" })
          .where(eq(heartbeatRuns.id, f.runId));
      }
      expect(await queue.claimQueuedRun(await run(pending.id))).toBeNull();
      expect(await run(pending.id)).toMatchObject({ status: "cancelled", errorCode: "execution_reconciliation_required", startedAt: null });
      const [saved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
      expect(saved).toMatchObject({ status: "deferred_issue_execution", runId: null,
        payload: { executionWait: { reason: "execution_recovery", recoveryActionId: hold.id } } });
      expect(saved.payload?._paperclipWakeContext).toMatchObject({ wakeReason: "issue_commented", wakeCommentIds: expectedIds });
      if (systemWakeId) {
        const [systemWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, systemWakeId));
        expect(systemWake.status).toBe("skipped");
      }

      // Only the deferred-receipt worker runs (its 30-second wait has elapsed).
      await db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 31_000) }).where(eq(agentWakeupRequests.id, wake.id));
      await queue.resumeDeferredExecutionReceipts({ companyId: f.companyId, requestId: wake.id });
      await queue.resumeDeferredExecutionReceipts({ companyId: f.companyId, requestId: wake.id });
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`, eq(heartbeatRuns.status, "queued")));
      expect(successors).toHaveLength(1);
      expect(successors[0].contextSnapshot?.wakeCommentIds).toEqual(expectedIds);
      expect(deps.enqueueWakeup).toHaveBeenCalledWith(original.agentId,
        expect.objectContaining({ requestedByActorType: "user", requestedByActorId: "operator" }), wake.id);
      expect(queueDeps.executeRun).not.toHaveBeenCalled();
    } finally { deps.activeRunExecutions.delete(f.runId); execution.finish(); adapterExecutionControls.delete(f.runId); }
  }, 30_000);

  it("reaches its queued snapshot-only reset after earlier recovery candidates without starting agent work", async () => {
    const previous = db;
    replaceFixtureState({ db: createDb(connectionString) });
    try { await exerciseQueuedReset(false, false, undefined, true); }
    finally { await db.$client.end(); replaceFixtureState({ db: previous }); }
  }, 30_000);

  it("preserves coalesced queued user comments until real native copyback replays the original wake", async () => {
    await exerciseQueuedReset(true, true);
  }, 30_000);

  it("preserves each ordinary mixed-author comment across queued Stop and native copyback", async () => {
    await exerciseQueuedReset(true, false, "active");
  }, 30_000);

  it("preserves merged-deferred mixed-author comments across queued Stop and native copyback", async () => {
    await exerciseQueuedReset(true, false, "deferred");
  }, 30_000);

  it("preserves mixed-author comments merged into a system-owned deferred carrier across Stop and native copyback", async () => {
    await exerciseQueuedReset(true, false, "system-deferred");
  }, 30_000);

  it("preserves mixed-author deferred inputs when the resuming third user differs from the carrier", async () => {
    await exerciseQueuedReset(true, false, "deferred-different");
  }, 30_000);

  it.each(["missing_primary", "agent_namespace", "system_namespace", "foreign_link", "foreign_carrier_run", "foreign_receipt_user", "array_only"] as const)("rejects mixed-author queue authority forgery: %s", async fault => {
    const t = await ordinaryMixedQueuedFixture("system-deferred"), { f, wake, queued, deps, execution, queueDeps, queue, followup } = t;
    try {
      await recordRequiredWorkspaceRestoreFailure(db, await run(f.runId), { workspaceRestoreFailure: "restore_failed" }, f.lease);
      deps.activeRunExecutions.delete(f.runId); execution.finish(); adapterExecutionControls.delete(f.runId);
      const sourceIds = queued.contextSnapshot!.queuedCommentSourceWakeIds as string[];
      const [receipt] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
        eq(agentWakeupRequests.status, "coalesced"), eq(agentWakeupRequests.requestedByActorType, "user"),
        sql`${agentWakeupRequests.payload}->>'commentId' = ${followup.id}`));
      expect(receipt).toBeDefined();
      if (fault === "missing_primary") await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
      if (fault === "agent_namespace" || fault === "system_namespace") await db.update(agentWakeupRequests).set({ requestedByActorType: fault === "agent_namespace" ? "agent" : "system", requestedByActorId: "second-user" }).where(eq(agentWakeupRequests.id, receipt.id));
      if (fault === "foreign_link") await db.update(agentWakeupRequests).set({ payload: { ...receipt.payload, coalescedIntoWakeupRequestId: randomUUID() } }).where(eq(agentWakeupRequests.id, receipt.id));
      if (fault === "foreign_carrier_run") await db.update(agentWakeupRequests).set({ runId: f.runId }).where(eq(agentWakeupRequests.id, sourceIds[0]));
      if (fault === "foreign_receipt_user") await db.update(agentWakeupRequests).set({ requestedByActorId: "operator" }).where(eq(agentWakeupRequests.id, receipt.id));
      if (fault === "array_only") {
        const [injected] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "second-user", body: "An array is not a saved admission receipt." }).returning();
        await db.update(heartbeatRuns).set({ contextSnapshot: mergeCoalescedContextSnapshot(queued.contextSnapshot,
          { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: injected.id, wakeCommentIds: [injected.id] }, { preserveExistingInteractionContinuation: true }) }).where(eq(heartbeatRuns.id, queued.id));
        await db.update(agentWakeupRequests).set({ payload: withQueuedCommentIdsInWakePayload(receipt.payload!, [followup.id, injected.id]) }).where(eq(agentWakeupRequests.id, receipt.id));
      }
      expect(await queue.claimQueuedRun(await run(queued.id))).toBeNull();
      const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
      expect(after.status).toBe("skipped");
      expect(queueDeps.executeRun).not.toHaveBeenCalled(); expect(deps.enqueueWakeup).not.toHaveBeenCalled();
    } finally { deps.activeRunExecutions.delete(f.runId); execution.finish(); adapterExecutionControls.delete(f.runId); }
  }, 30_000);

  it("preserves ordinary no-issue deferred merge semantics", async () => {
    const f = await seed(), original = await run(f.runId), writer = createWakeAdmissionWriter();
    const [carrier] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: original.agentId,
      source: "automation", status: "deferred_issue_execution", payload: { text: "original" }, requestedByActorType: "system" }).returning();
    await db.transaction(tx => writer.mergeIntoExistingDeferredWake(createAdmissionTransactionScope(f.companyId, tx as unknown as typeof db), {
      companyId: f.companyId, existingDeferredWakeId: carrier.id, mergedPayload: { text: "merged" }, nextCoalescedCount: 1,
      coalescedReceipt: { agentId: original.agentId, source: "automation", triggerDetail: null, reason: null, payload: { text: "saved" }, requestedByActorType: "system", requestedByActorId: null, idempotencyKey: null, runId: null },
    }));
    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, carrier.id));
    expect(after.payload).toEqual({ text: "merged" });
    const [receipt] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.status, "coalesced")));
    expect(receipt.payload).toEqual({ text: "saved", coalescedIntoWakeupRequestId: carrier.id });
  });

  it("rolls back saved primary and carrier overwrite if incoming mixed-author receipt persistence fails", async () => {
    const f = await seed(), original = await run(f.runId), writer = createWakeAdmissionWriter();
    const [first] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "operator", body: "First saved input" }).returning();
    const [second] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "second-user", body: "Second saved input" }).returning();
    const [carrier] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: original.agentId,
      source: "automation", status: "deferred_issue_execution", payload: { issueId: f.issueId, commentId: first.id }, requestedByActorType: "user", requestedByActorId: "operator" }).returning();
    const merge = (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], id?: string) => writer.mergeIntoExistingDeferredWake(createAdmissionTransactionScope(f.companyId, tx as unknown as typeof db), {
      companyId: f.companyId, existingDeferredWakeId: carrier.id, mergedPayload: { issueId: f.issueId, commentId: second.id }, nextCoalescedCount: 1,
      coalescedReceipt: { ...(id ? { id } : {}), agentId: original.agentId, source: "automation", triggerDetail: null, reason: "issue_commented", payload: { issueId: f.issueId, commentId: second.id, coalescedIntoWakeupRequestId: "untrusted" }, requestedByActorType: "user", requestedByActorId: "second-user", idempotencyKey: null, runId: null },
    });
    await expect(db.transaction(tx => merge(tx, carrier.id))).rejects.toThrow();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))).toEqual([carrier]);
    await db.transaction(tx => merge(tx)); await db.transaction(tx => merge(tx));
    const proofs = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.status, "coalesced")));
    expect(proofs.filter(receipt => receipt.payload?.commentId === first.id)).toHaveLength(1);
    expect(proofs.every(receipt => receipt.payload?.coalescedIntoWakeupRequestId === carrier.id)).toBe(true);
    expect(proofs.find(receipt => receipt.payload?.commentId === first.id)?.requestedByActorId).toBe("operator");
  });

  it.each(["missing_receipt", "wrong_receipt_run", "wrong_receipt_agent", "wrong_receipt_company", "wrong_receipt_user", "wrong_receipt_issue", "terminal_receipt", "foreign_comment_user", "deleted_followup", "unrecorded_comment", "unrecorded_original"] as const)("keeps coalesced Stop recovery input closed without saved receipt authority: %s", async fault => {
    const t = await queuedResetFixture(), { f, wake, queued, deps, execution, queueDeps, queue } = t;
    try {
      const { followup, receipt } = await coalesceQueuedReset(t);
      await recordRequiredWorkspaceRestoreFailure(db, await run(f.runId), { workspaceRestoreFailure: "restore_failed" }, f.lease);
      deps.activeRunExecutions.delete(f.runId); execution.finish(); adapterExecutionControls.delete(f.runId);
      if (fault === "missing_receipt") await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
      if (fault === "wrong_receipt_run") await db.update(agentWakeupRequests).set({ runId: f.runId }).where(eq(agentWakeupRequests.id, receipt.id));
      if (fault === "wrong_receipt_agent") await db.update(agentWakeupRequests).set({ agentId: (await db.insert(agents).values({ companyId: f.companyId, name: "Other", role: "engineer" }).returning())[0].id }).where(eq(agentWakeupRequests.id, receipt.id));
      if (fault === "wrong_receipt_company") await db.update(agentWakeupRequests).set({ companyId: (await db.insert(companies).values({ name: "Other", issuePrefix: `OT${randomUUID().slice(0, 6)}` }).returning())[0].id }).where(eq(agentWakeupRequests.id, receipt.id));
      if (fault === "wrong_receipt_user") await db.update(agentWakeupRequests).set({ requestedByActorId: "other-user" }).where(eq(agentWakeupRequests.id, receipt.id));
      if (fault === "wrong_receipt_issue") await db.update(agentWakeupRequests).set({ payload: { ...receipt.payload, issueId: randomUUID() } }).where(eq(agentWakeupRequests.id, receipt.id));
      if (fault === "terminal_receipt") await db.update(agentWakeupRequests).set({ status: "cancelled" }).where(eq(agentWakeupRequests.id, receipt.id));
      if (fault === "foreign_comment_user") await db.update(issueComments).set({ authorUserId: "other-user" }).where(eq(issueComments.id, followup.id));
      if (fault === "deleted_followup") await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, followup.id));
      if (fault === "unrecorded_comment") {
        const [injected] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "operator", body: "/new" }).returning();
        await db.update(heartbeatRuns).set({ contextSnapshot: mergeCoalescedContextSnapshot((await run(queued.id)).contextSnapshot,
          { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: injected.id, wakeCommentIds: [injected.id] },
          { preserveExistingInteractionContinuation: true }) }).where(eq(heartbeatRuns.id, queued.id));
      }
      if (fault === "unrecorded_original") await db.update(agentWakeupRequests).set({ payload: { ...wake.payload, commentId: randomUUID() } }).where(eq(agentWakeupRequests.id, wake.id));
      expect(await queue.claimQueuedRun(await run(queued.id))).toBeNull();
      const [afterWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
      expect(afterWake.status).toBe("skipped");
      expect(queueDeps.executeRun).not.toHaveBeenCalled();
      expect(deps.enqueueWakeup).not.toHaveBeenCalled();
      expect((await run(queued.id)).status).toBe("cancelled");
    } finally { deps.activeRunExecutions.delete(f.runId); execution.finish(); adapterExecutionControls.delete(f.runId); }
  });

  it.each(["system_actor", "wrong_actor", "deleted_comment", "foreign_comment", "foreign_agent", "foreign_company", "foreign_run", "terminal_wake", "started", "provider_event", "provider_lease", "resolved_runtime"] as const)("keeps queued Stop recovery input closed without paired predispatch authority: %s", async fault => {
    const t = await queuedResetFixture(), { f, original, reset, wake, queued, deps, execution, queueDeps, queue } = t;
    try {
      await recordRequiredWorkspaceRestoreFailure(db, await run(f.runId), { workspaceRestoreFailure: "restore_failed" }, f.lease);
      deps.activeRunExecutions.delete(f.runId); execution.finish(); adapterExecutionControls.delete(f.runId);
      if (fault === "system_actor") await db.update(agentWakeupRequests).set({ requestedByActorType: "system" }).where(eq(agentWakeupRequests.id, wake.id));
      if (fault === "wrong_actor") await db.update(agentWakeupRequests).set({ requestedByActorId: "other-user" }).where(eq(agentWakeupRequests.id, wake.id));
      if (fault === "deleted_comment") await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, reset.id));
      if (fault === "foreign_comment") await db.update(issueComments).set({ issueId: (await db.insert(issues).values({ companyId: f.companyId, title: "Other" }).returning())[0].id }).where(eq(issueComments.id, reset.id));
      if (fault === "foreign_agent") await db.update(agentWakeupRequests).set({ agentId: (await db.insert(agents).values({ companyId: f.companyId, name: "Other", role: "engineer" }).returning())[0].id }).where(eq(agentWakeupRequests.id, wake.id));
      if (fault === "foreign_company") await db.update(agentWakeupRequests).set({ companyId: (await db.insert(companies).values({ name: "Other", issuePrefix: "OT" }).returning())[0].id }).where(eq(agentWakeupRequests.id, wake.id));
      if (fault === "foreign_run") await db.update(agentWakeupRequests).set({ runId: f.runId }).where(eq(agentWakeupRequests.id, wake.id));
      if (fault === "terminal_wake") await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date(), error: "Operator cancelled" }).where(eq(agentWakeupRequests.id, wake.id));
      if (fault === "started") await db.update(heartbeatRuns).set({ startedAt: new Date() }).where(eq(heartbeatRuns.id, queued.id));
      if (fault === "provider_event") await appendHeartbeatRunEvent(db, { companyId: f.companyId, agentId: original.agentId, runId: queued.id,
        eventType: "adapter.invoke", stream: "system", level: "info", message: "Controlled provider execution evidence" });
      if (fault === "provider_lease") await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: queued.id, environmentId: f.lease.environmentId, provider: "daytona", providerLeaseId: randomUUID() });
      if (fault === "resolved_runtime") await db.update(heartbeatRuns).set({ runtimeModeResolvedAt: new Date() }).where(eq(heartbeatRuns.id, queued.id));
      const [beforeWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
      expect(await queue.claimQueuedRun(await run(queued.id))).toBeNull();
      const [afterWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
      expect(afterWake.status).not.toBe("deferred_issue_execution");
      if (["foreign_agent", "foreign_company", "foreign_run", "terminal_wake"].includes(fault)) expect(afterWake).toEqual(beforeWake);
      else expect(afterWake.status).toBe("skipped");
      expect(queueDeps.executeRun).not.toHaveBeenCalled();
      expect(deps.enqueueWakeup).not.toHaveBeenCalled();
    } finally { deps.activeRunExecutions.delete(f.runId); execution.finish(); adapterExecutionControls.delete(f.runId); }
  });

  async function stoppedEvidenceFixture() {
    const f = await seed();
    const original = await run(f.runId);
    await db.update(heartbeatRuns).set({ status: "cancelled", nativePhase: "terminal_failure", errorCode: "cancelled", resultJson: {
      ...original.resultJson, cancelledByActorType: "user", cancelledByUserId: "operator",
      cancellation: requestedRunCancellation({ cancelledByActorType: "user", cancelledByUserId: "operator" }, "Stop"),
      executionCancellation: { state: "requested", requestedAt: new Date().toISOString() },
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: f.runId, companyId: f.companyId, issueId: f.issueId,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() },
    } }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ conversationAgentId: original.agentId, conversationUserId: "operator", conversationState: "active", status: "in_progress" }).where(eq(issues.id, f.issueId));
    const [reset] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "operator", body: "/new" }).returning();
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    await recordRequiredWorkspaceRestoreFailure(db, await run(f.runId), { workspaceRestoreFailure: "restore_failed" }, f.lease);
    const [preservation] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId),
      eq(issueRecoveryActions.sourceIssueId, f.issueId), eq(issueRecoveryActions.fingerprint, `native-workspace:${f.runId}`)));
    expect(preservation).toMatchObject({ status: "resolved", evidence: { automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked", runId: f.runId } } });
    f.actionId = preservation.id; f.input.actionId = preservation.id;
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: original.agentId,
      source: "on_demand", reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "operator",
      payload: withQueuedCommentIdsInWakePayload({ issueId: f.issueId, commentId: reset.id,
        _paperclipWakeContext: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: reset.id, wakeCommentIds: [reset.id] } }, [reset.id]) }).returning();
    const deps = callbacks(db), control = createHeartbeatRunControl(db, deps);
    const execution = createAdapterExecutionControl();
    deps.activeRunExecutions.add(f.runId); adapterExecutionControls.set(f.runId, execution);
    const cleanup = () => { deps.activeRunExecutions.delete(f.runId); execution.finish(); adapterExecutionControls.delete(f.runId); };
    return { f, original, reset, wake, deps, control, execution, cleanup };
  }

  async function heldStoppedEvidence() {
    const prepared = await stoppedEvidenceFixture();
    await recoverRetainedWorkspace(prepared.f.input);
    const held = readSystemRecovery((await action(prepared.f.actionId)).evidence)!;
    expect(held.state).toBe("awaiting_evidence");
    await prepared.control.acknowledgeRemoteStop(prepared.f.runId, prepared.f.companyId);
    prepared.cleanup();
    return { ...prepared, held };
  }

  it("advances saved workspace recovery on new Stop evidence after executor cleanup", async () => {
    const { f, original, reset, deps, control, execution } = await stoppedEvidenceFixture();
    try {
      await recoverRetainedWorkspace(f.input);
      const held = readSystemRecovery((await action(f.actionId)).evidence)!;
      expect(held).toMatchObject({ state: "awaiting_evidence", failure: { code: "agent_stop_unconfirmed", retryClass: "recheck_evidence" } });
      expect(held.nextAttemptAt!).toBeGreaterThan(Date.now() + 20_000);
      expect(await getExecutionBlocker(db, f.companyId, f.issueId, { conversationResetCommentId: reset.id })).not.toBeNull();
      await control.acknowledgeRemoteStop(f.runId, f.companyId);
      expect((await run(f.runId)).resultJson?.executionCancellation).toMatchObject({ state: "acknowledged", proof: "provider_termination_receipt" });
      await control.resumeRemoteStopComments(await run(f.runId));
      expect(readSystemRecovery((await action(f.actionId)).evidence)).toEqual(held);
      deps.activeRunExecutions.delete(f.runId); execution.finish(); adapterExecutionControls.delete(f.runId);
      const at = Date.now(); let events = 0;
      const stop = subscribeDeliveryWork(db, DELIVERY_QUEUES.workspaceRecovery, () => { events += 1; });
      try { await control.resumeRemoteStopComments(await run(f.runId)); } finally { stop(); }
      const advanced = readSystemRecovery((await action(f.actionId)).evidence)!;
      expect(advanced.nextAttemptAt!).toBeLessThanOrEqual(Date.now());
      expect(advanced).toMatchObject({ generationId: held.generationId, attempts: held.attempts, retriesUsed: held.retriesUsed,
        firstFailureAt: held.firstFailureAt, deadlineAt: held.deadlineAt, providerCooldownAt: held.providerCooldownAt });
      expect(events).toBeGreaterThan(0);
      await recoverRetainedWorkspace(f.input);
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
      expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
      const successorRunId = randomUUID();
      const admitted = await admitExplicitNativeContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: original.agentId,
        actorType: "user", actorId: "operator", reason: "issue_commented", commentId: reset.id, successorRunId });
      expect(admitted).toMatchObject({ previousRunId: f.runId, commentId: reset.id });
      expect((await action(f.actionId)).evidence).toMatchObject({ automaticRecovery: { replay: "explicit_user_continuation" } });
      expect(await getExecutionBlocker(db, f.companyId, f.issueId, { conversationResetCommentId: reset.id })).toBeNull();
      expect(Date.now() - at).toBeLessThan(30_000);
      expect(deps.enqueueWakeup).not.toHaveBeenCalled();
    } finally { deps.activeRunExecutions.delete(f.runId); execution.finish(); adapterExecutionControls.delete(f.runId); }
  });

  it.each(["active_adapter", "active_execution", "missing_native_ack", "wrong_native_run", "missing_physical_receipt", "wrong_allocation", "coordinator_owner", "coordinator_observed", "foreign_action_run", "expired_deadline", "exhausted", "retry_budget", "unrelated_failure"] as const)("does not advance Stop-evidence work without current authority: %s", async fault => {
    const t = await heldStoppedEvidence(), { f, deps, control, execution } = t;
    try {
      if (fault === "active_adapter") adapterExecutionControls.set(f.runId, execution);
      if (fault === "active_execution") deps.activeRunExecutions.add(f.runId);
      if (fault === "missing_native_ack") await db.update(heartbeatRuns).set({ resultJson: sql`jsonb_set(${heartbeatRuns.resultJson}, '{nativeCancellation,dispatchState}', '"pending"'::jsonb)` }).where(eq(heartbeatRuns.id, f.runId));
      if (fault === "wrong_native_run") await db.update(heartbeatRuns).set({ resultJson: sql`jsonb_set(${heartbeatRuns.resultJson}, '{nativeCancellation,runId}', ${JSON.stringify(randomUUID())}::jsonb)` }).where(eq(heartbeatRuns.id, f.runId));
      if (fault === "missing_physical_receipt") await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} - 'remoteExecutionTermination'` }).where(eq(environmentLeases.id, f.lease.id));
      if (fault === "wrong_allocation") await db.update(environmentLeases).set({ metadata: sql`jsonb_set(${environmentLeases.metadata}, '{remoteExecutionTermination,providerLeaseId}', ${JSON.stringify(randomUUID())}::jsonb)` }).where(eq(environmentLeases.id, f.lease.id));
      if (fault === "coordinator_owner") await db.update(nativeRunFinalizations).set({ leaseOwner: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (fault === "coordinator_observed") await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (fault === "foreign_action_run") await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{runId}', ${JSON.stringify(randomUUID())}::jsonb)` }).where(eq(issueRecoveryActions.id, f.actionId));
      if (fault === "expired_deadline") await updateSystemRecovery(db, f.input, t.held, { ...t.held, revision: t.held.revision + 1, deadlineAt: Date.now() - 1 });
      if (fault === "exhausted") await updateSystemRecovery(db, f.input, t.held, { ...t.held, revision: t.held.revision + 1, state: "exhausted", nextAttemptAt: null });
      if (fault === "retry_budget") await updateSystemRecovery(db, f.input, t.held, { ...t.held, revision: t.held.revision + 1, retriesUsed: 5 });
      if (fault === "unrelated_failure") await updateSystemRecovery(db, f.input, t.held, failSystemRecovery(t.held, new SystemRecoveryFailure("provider_unavailable", "retry_transient")));
      const before = (await action(f.actionId)).evidence;
      await control.resumeRemoteStopComments(await run(f.runId));
      expect((await action(f.actionId)).evidence).toEqual(before);
      if (fault !== "exhausted" && fault !== "retry_budget") expect(deps.enqueueWakeup).not.toHaveBeenCalled();
    } finally { t.cleanup(); }
  });

  it("consumes identical Stop-evidence only once across another actual failed attempt", async () => {
    const t = await heldStoppedEvidence(), { f, control, execution } = t;
    try {
      await control.resumeRemoteStopComments(await run(f.runId));
      expect((await action(f.actionId)).evidence.workspaceStopEvidence).toMatchObject({ consumed: true });
      adapterExecutionControls.set(f.runId, execution);
      await recoverRetainedWorkspace(f.input);
      t.cleanup();
      const before = (await action(f.actionId)).evidence;
      expect(readSystemRecovery(before)?.nextAttemptAt).toBeGreaterThan(Date.now() + 20_000);
      await control.resumeRemoteStopComments(await run(f.runId));
      await control.resumeRemoteStopComments(await run(f.runId));
      expect((await action(f.actionId)).evidence).toEqual(before);
    } finally { t.cleanup(); }
  });

  it("keeps the provider cooldown and retry window when advancing new Stop-evidence", async () => {
    const t = await heldStoppedEvidence(), { f, control } = t;
    try {
      const cooldown = Date.now() + 5_000;
      const state = failSystemRecovery(t.held, new SystemRecoveryFailure("agent_stop_unconfirmed", "recheck_evidence"), { retryAfterAt: cooldown });
      await updateSystemRecovery(db, f.input, t.held, state);
      await control.resumeRemoteStopComments(await run(f.runId));
      const after = readSystemRecovery((await action(f.actionId)).evidence)!;
      expect(after.nextAttemptAt).toBe(cooldown);
      expect(after).toMatchObject({ generationId: state.generationId, attempts: state.attempts, retriesUsed: state.retriesUsed, firstFailureAt: state.firstFailureAt, deadlineAt: state.deadlineAt, providerCooldownAt: cooldown });
      await control.resumeRemoteStopComments(await run(f.runId));
      expect(readSystemRecovery((await action(f.actionId)).evidence)).toEqual(after);
      await recoverRetainedWorkspace(f.input);
      expect(readSystemRecovery((await action(f.actionId)).evidence)).toEqual(after);
    } finally { t.cleanup(); }
  });

  it.each(["current", "stale_generation", "lost_receipt"] as const)("retains a post-cleanup Stop-evidence event before worker failure commits: %s", async variant => {
    const t = await stoppedEvidenceFixture(), { f, control } = t;
    const originalReader = recoverySources.inspectWorkspaceRecoverySource;
    let observed = false, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const reader = vi.spyOn(recoverySources, "inspectWorkspaceRecoverySource").mockImplementationOnce(async (...args) => {
      try { return await originalReader(...args); }
      catch (error) { observed = true; await barrier; throw error; }
    });
    const worker = recoverRetainedWorkspace(f.input);
    try {
      await expect.poll(() => observed, { timeout: 5_000 }).toBe(true);
      const running = readSystemRecovery((await action(f.actionId)).evidence)!;
      expect(running.state).toBe("running");
      await control.acknowledgeRemoteStop(f.runId, f.companyId); t.cleanup();
      await control.resumeRemoteStopComments(await run(f.runId));
      const pending = await action(f.actionId);
      expect(readSystemRecovery(pending.evidence)).toEqual(running);
      expect(pending.evidence.workspaceStopEvidence).toMatchObject({ sourceRunId: f.runId, generationId: running.generationId, consumed: false });
      if (variant === "stale_generation") await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{workspaceStopEvidence,generationId}', ${JSON.stringify(randomUUID())}::jsonb)` }).where(eq(issueRecoveryActions.id, f.actionId));
      if (variant === "lost_receipt") await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} - 'remoteExecutionTermination'` }).where(eq(environmentLeases.id, f.lease.id));
      release(); await worker;
      const after = await action(f.actionId), state = readSystemRecovery(after.evidence)!;
      expect(state.state).toBe("awaiting_evidence");
      expect(state).toMatchObject({ attempts: running.attempts, retriesUsed: running.retriesUsed, generationId: running.generationId });
      if (variant === "current") {
        expect(state.nextAttemptAt!).toBeLessThanOrEqual(Date.now());
        expect(after.evidence.workspaceStopEvidence).toMatchObject({ consumed: true });
        await recoverRetainedWorkspace(f.input);
        expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
        expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
      } else {
        expect(state.nextAttemptAt!).toBeGreaterThan(Date.now() + 20_000);
        expect(after.evidence.workspaceStopEvidence).toMatchObject({ consumed: false });
      }
    } finally { release(); await worker; reader.mockRestore(); t.cleanup(); }
  });

});
