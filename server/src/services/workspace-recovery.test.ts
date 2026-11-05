import { createAdmissionTransactionScope, createWakeAdmissionReader, createWakeAdmissionWriter } from "../modules/wake-queue/adapters/postgres.js";
import { createAdmitWakeBehindIssueExecution } from "../modules/wake-queue/application/use-cases.js";
import { filterZombieCoalesceTarget } from "./heartbeat.js";
import { mergeCoalescedContextSnapshot } from "./heartbeat/run-preparation.js";
import { recoveryService } from "./recovery/index.js";
import { inspectWorkspaceSource } from "./workspace-source-inspection.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { isPreDispatchExecutionWaitVerified } from "./pre-dispatch-execution-wait.js";
import { heartbeatRunEvents } from "@paperclipai/db";
import { createHeartbeatQueue, shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake } from "./heartbeat/queue.js";
import { createHeartbeatQueueTestDependencies } from "../__tests__/helpers/heartbeat-queue.js";
import { recordRequiredWorkspaceRestoreFailure, terminalizeLegacyExecution } from "./legacy-execution-recovery.js";
import { admitExplicitNativeContinuation } from "./explicit-native-continuation.js";
import { withQueuedCommentIdsInWakePayload } from "./issue-queued-comment-queue.js";
import * as recoverySources from "./workspace-recovery-source.js";
import { requestedRunCancellation } from "./run-cancellation.js";
import { createHeartbeatRunControl } from "./heartbeat/run-control.js";
import { callbacks } from "./heartbeat/__tests__/run-control-fixtures.js";
import { adapterExecutionControls, createAdapterExecutionControl } from "./adapter-execution-control.js";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "./delivery-work-notifications.js";
import { prepareHeartbeatWorkspace } from "./heartbeat/workspace-preparation.js";
import { createHeartbeatWorkspaceResolver, resolveExecutionWorkspaceReuseRequestForIssue } from "./heartbeat/workspaces.js";
import { environmentService } from "./environments.js";
import * as agentStarts from "./agent-start-lock.js";
import { taskRepositoryRelativePath } from "./execution-workspace-repositories.js";
import { classifyEnvironmentCapabilities, environmentRuntimeService } from "./environment-runtime.js";
import { environmentRunOrchestrator } from "./environment-run-orchestrator.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { workspaceOperationService } from "./workspace-operations.js";
import { instanceSettingsService } from "./instance-settings.js";
import { projectTaskInterruption, taskInterruptionPresentation } from "./task-interruption-presentation.js";
import * as nativeWorkspaceSync from "./native-runtime/native-workspace-sync.js";
import { GitShallowMetadataError } from "@paperclipai/adapter-utils/git-workspace-sync";
import { readSystemRecovery } from "./system-recovery-state.js";
import { adoptSystemRecovery, updateSystemRecovery } from "./system-recovery.js";
import { getStorageService } from "../storage/index.js";
import * as storageBackend from "../storage/index.js";
import { migrateRemoteWorkspace } from "./remote-workspace-migration.js";
import { attachPreservedWorkspaceSnapshots, verifiedWorkspaceSnapshotReceipt } from "./workspace-recovery-snapshot.js";
import { adoptHistoricalWorkspaceRecoveries, historicalRecoveryCounts } from "./workspace-recovery-backfill.js";
import { createSystemRecovery, failSystemRecovery, reserveSystemRecoveryAttempt, SystemRecoveryFailure } from "./system-recovery-state.js";
import { requestTaskRetry } from "./task-retry.js";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { materializeIsolatedTaskDirectory } from "./isolated-task-directory.js";
import { execFile } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companyObservability, executionWorkspaceRepositories, issueWorkProducts, authUsers, companyMemberships, agents, approvals, budgetPolicies, costEvents, completionContracts, issueApprovals, issueTreeHolds, issueTreeHoldMembers, companies, createDb, applyPendingMigrations, environmentLeases, environments, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, agentWakeupRequests, workspaceOperations } from "@paperclipai/db";
import { resumePreservedResultFinalization } from "./preserved-result-finalization.js";
import { finalizeNativeRun } from "./native-runtime/native-run-finalizer.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";
import type { NativeExecutionInput, NativeSession, NativeSessionBackend, PrpEvent } from "../vendor/paperclip-runner/index.js";
import { issueThreadInteractions } from "@paperclipai/db";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { EnvironmentLease } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { nativeWorkspaceSyncStateRoot, prepareNativeWorkspaceSync, resumeNativeWorkspaceSync } from "./native-runtime/native-workspace-sync.js";
import { nativeWorkspaceExportPendingForResource } from "./native-runtime/native-workspace-finalization-state.js";
import { nativeWorkspaceFinalizationLockKey } from "./native-runtime/native-workspace-finalization-ownership.js";
import { hasRemoteTerminationReceipt, remoteTerminationReceipt } from "./remote-execution-termination.js";
import { prepareStoppedSandboxForRecovery, prepareSandboxStopAndRetain, settleStopOnlyCleanup, readStopOnlyCleanup } from "./sandbox-stop-and-retain.js";
import { recoverRetainedWorkspace, requestWorkspaceRecovery, scheduleRecoveredWorkspaceCleanup, reconcileRetainedWorkspaces, retainedWorkspaceCandidates } from "./workspace-recovery.js";
import * as activity from "./activity-log.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerWorkspaceRecoveryWork } from "./workspace-recovery-work.js";
import { heartbeatService } from "./heartbeat.js";
import * as heartbeatServices from "./heartbeat.js";
import { hasVerifiedWorkspaceRepair, readWorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { claimNativeSessionResumptions } from "./native-runtime/native-finalization-reconciler.js";
import { executionWorkspaces } from "@paperclipai/db";
import { executionWorkspaceSnapshots } from "@paperclipai/db";
import { createSavedWorkspaceLoader, prepareRemoteWorkspace, readRemoteWorkspaceAuthority, reserveRemoteWorkspace, saveRemoteWorkspace } from "./remote-workspaces.js";
import { createReusableLeaseHandoff } from "./environment-lease-handoff.js";
import { preserveRemoteWorkspacePreparationFailure } from "./native-runtime/native-workspace-finalization-state.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import { createHeartbeatRunOutput } from "./heartbeat/run-output.js";
import { objectLogFixture } from "./heartbeat/__tests__/object-log-fixture.js";
import { issueRoutes } from "../routes/issues.js";
import { plugins } from "@paperclipai/db";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { errorHandler } from "../middleware/index.js";
import * as workerProof from "./native-runtime/native-workspace-platform-proof.js";
const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

describe("automatic retained workspace recovery", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let connectionString: string;
  let db: ReturnType<typeof createDb>;
  let root: string;
  const fixtureCompanyIds = new Set<string>();
  const priorHome = process.env.PAPERCLIP_HOME, priorInstance = process.env.PAPERCLIP_INSTANCE_ID;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "workspace-recovery-"));
    process.env.PAPERCLIP_HOME = path.join(root, "home"); process.env.PAPERCLIP_INSTANCE_ID = "recovery";
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_WORKSPACE_RECOVERY_TEST_DATABASE_URL");
    if (external) {
      await applyPendingMigrations(external);
      temporary = { connectionString: external, cleanup: async () => {} };
    } else temporary = await startEmbeddedPostgresTestDatabase("workspace-recovery-");
    connectionString = temporary.connectionString;
    db = createDb(connectionString);
    if (external) await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  }, 30_000);
  afterAll(async () => {
    await db?.$client.end(); await temporary?.cleanup();
    const makeWritable = async (directory: string): Promise<void> => {
      const entry = await lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return;
      await chmod(directory, 0o700);
      for (const child of await readdir(directory, { withFileTypes: true })) {
        if (child.isDirectory()) await makeWritable(path.join(directory, child.name));
      }
    };
    await makeWritable(root); await rm(root, { recursive: true, force: true });
    if (priorHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = priorHome;
    if (priorInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = priorInstance;
  });
  afterEach(async () => {
    // Discovery is intentionally global and bounded. An unresolved source from
    // an earlier test must not consume the current fixture's recovery page.
    // Keep all history within each test until its assertions have completed.
    const companyIds = [...fixtureCompanyIds]; fixtureCompanyIds.clear();
    if (!companyIds.length) return;
    // Stop global queue sweeps from revisiting deferred input after this
    // fixture's recovery actions and lease bindings are removed below.
    await db.update(agents).set({ status: "paused" }).where(inArray(agents.companyId, companyIds));
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(and(
      inArray(agentWakeupRequests.companyId, companyIds),
      inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"])));
    await heartbeatService(db).drainActiveRunExecutions();
    // Admission tests leave synthetic queue blockers. Retire them only after
    // assertions so they cannot trip the next test's instance-wide drain fence.
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
      inArray(heartbeatRuns.companyId, companyIds), inArray(heartbeatRuns.status, ["queued", "running"])));
    const leases = await db.select({ id: environmentLeases.id }).from(environmentLeases)
      .where(inArray(environmentLeases.companyId, companyIds));
    for (const lease of leases) targets.delete(lease.id);
    await db.delete(environmentLeases).where(inArray(environmentLeases.companyId, companyIds));
    // Historical adoption can reconstruct an action from either the lease or
    // the run descriptor, so retire both fixture inputs before deleting it.
    await db.update(heartbeatRuns).set({ resultJson: sql`${heartbeatRuns.resultJson} - 'workspaceRestoreRecovery' - 'workspaceRestoreFailure'` })
      .where(inArray(heartbeatRuns.companyId, companyIds));
    await db.delete(issueRecoveryActions).where(inArray(issueRecoveryActions.companyId, companyIds));
  });
  async function seed(mode = "native", nativeDescriptor = true, resourceDisposition: "destroy" | "keep_running" = "destroy", reusable = false, ephemeral = false) {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), actionId: string = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Workspace recovery", defaultResponsibleUserId: "board", issuePrefix: `R${companyId.slice(0, 6)}` });
    fixtureCompanyIds.add(companyId);
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, assigneeAgentId: agentId, status: "blocked", title: "Recover existing work" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, issueId, nativeIssueId: mode === "native" ? issueId : null,
      agentId, runtimeMode: mode, status: "failed", finishedAt: new Date(), errorCode: "execution_interrupted", contextSnapshot: { issueId } });
    if (mode === "legacy") await db.update(heartbeatRuns).set({ runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } } }).where(eq(heartbeatRuns.id, runId));
    if (mode === "native") await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "terminal_failure" });
    const [environment] = await db.insert(environments).values({ name: runId, driver: "sandbox" }).returning();
    const providerLeaseId: string = randomUUID(), remote = path.join(root, runId, "remote"), host = path.join(root, runId, "host");
    await mkdir(host, { recursive: true }); await writeFile(path.join(host, "existing.txt"), "base\n");
    const leaseValues = { companyId, issueId, heartbeatRunId: runId,
      environmentId: environment.id, provider: "daytona", providerLeaseId,
      metadata: { remoteCwd: remote, driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, ...(reusable ? { agentId } : {}) } };
    const acquired = reusable ? await environmentService(db).acquireLease({ ...leaseValues, leasePolicy: "reuse_by_environment" }) : null;
    const [lease] = acquired ? await db.select().from(environmentLeases).where(eq(environmentLeases.id, acquired.id))
      : await db.insert(environmentLeases).values({ ...leaseValues, leasePolicy: ephemeral ? "ephemeral" : "retain_on_failure", status: "released",
        cleanupStatus: "success", releasedAt: new Date() }).returning();
    const target: AdapterSandboxExecutionTarget = { kind: "remote", transport: "sandbox", providerKey: "test", leaseId: lease.id,
      remoteCwd: remote, timeoutMs: 30_000, sandboxLeaseAcquisition: { outcome: "created", providerLeaseId },
      runner: { execute: input => new Promise((resolve, reject) => {
        const startedAt = new Date().toISOString();
        const child = execFile(input.command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env }, timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
          (error, stdout, stderr) => resolve({ exitCode: error ? typeof error.code === "number" ? error.code : 1 : 0,
            signal: error?.signal ?? null, timedOut: error?.killed ?? false, stdout, stderr, pid: child.pid ?? null, startedAt }));
        child.stdin?.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
        child.stdin?.end(input.stdin ?? "");
      }) } };
    targets.set(lease.id, target);
    if (nativeDescriptor) {
      const prepared = await prepareNativeWorkspaceSync({ db, companyId, workspaceId: issueId, workspaceLocalDir: host,
        runId, lease: lease as EnvironmentLease, target, resourceDisposition });
      expect(prepared).not.toBeNull();
    } else {
      // Provider boundary only: real temporary files, no native baseline. The
      // production provider's syncOut contract validates its archive itself.
      target.runner!.syncIn = async () => ({ filesTransferred: 0, bytesTransferred: 0, operations: [] });
      target.runner!.syncOut = async operations => {
        for (const operation of operations) for (const file of operation.files)
          await cp(file.sourcePath, file.targetPath, { recursive: true, dereference: false });
        return { filesTransferred: 2, bytesTransferred: 0, operations: [] };
      };
      await mkdir(remote, { recursive: true });
      await writeFile(path.join(remote, "existing.txt"), "base\n");
    }
    await writeFile(path.join(remote, "saved.txt"), "finished work\n");
    await writeFile(path.join(host, "newer.txt"), "newer local work\n");
    const recovery = { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [lease.id] };
    await db.update(heartbeatRuns).set({ resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: recovery,
      conversationContinuation: "continue_conversation_v1" } }).where(eq(heartbeatRuns.id, runId));
    await db.update(environmentLeases).set({ metadata: { ...lease.metadata,
      remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId, state: "stopped" }) } }).where(eq(environmentLeases.id, lease.id));
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      ownerType: "board", cause: mode === "native" ? "native_continuation_requires_reconciliation" : "legacy_execution_requires_reconciliation",
      fingerprint: runId, nextAction: "Manual repair required", evidence: { runId, workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: recovery } });
    const runtime = { resumeRunLease: vi.fn(async (_input: { lease: EnvironmentLease }) => ({ providerLeaseId, metadata: { remoteCwd: remote } })),
      retryPendingSandboxTeardown: vi.fn(async (_input: { lease: EnvironmentLease }) => ({ providerLeaseId, state: "stopped" })) };
    const environmentRuntime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox",
      acquireRunLease: vi.fn(), releaseRunLease: vi.fn(), ...runtime,
      resolveCapabilities: async () => classifyEnvironmentCapabilities({ verifiedMethods: [], declared: null, narrowing: null }),
    }] });
    const input = { db, companyId, issueId, runId, actionId, environmentRuntime };
    return { ...input, input, runtime, host, remote, lease, providerLeaseId };
  }
  const action = async (id: string) => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!;
  const run = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;

  async function failedWarmSource(exportOnly = false, hops = 0) {
    const f = hops ? await warmHandoffSource(hops) : await seed("native", true, "keep_running");
    if (hops) await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(environmentLeases).set({ leasePolicy: "reuse_by_environment" }).where(eq(environmentLeases.id, f.lease.id));
    const retry = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
      actorSource: "local_implicit", idempotencyKey: randomUUID(), observedRunId: f.runId });
    const failed = failSystemRecovery(reserveSystemRecoveryAttempt(createSystemRecovery(f.runId, retry.requestId!))!,
      new SystemRecoveryFailure("source_binding_invalid", "service_required"), { now: Date.now() - 86_400_000 });
    await db.update(issueRecoveryActions).set({ evidence: { ...(await action(f.actionId)).evidence, systemRecovery: failed,
      workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: f.runId, status: "blocked", stage: "verifying_stop",
        attempt: 1, attemptLimit: 6, requestIds: [retry.requestId!] } } }).where(eq(issueRecoveryActions.id, f.actionId));
    if (exportOnly) {
      const contractId = randomUUID(), resultId = randomUUID();
      await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.issueId,
        revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
        completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {},
        canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
      await db.update(heartbeatRuns).set({ completionContractId: contractId, resultJson: {} }).where(eq(heartbeatRuns.id, f.runId));
      await db.insert(nativeRunResults).values({ id: resultId, companyId: f.companyId, issueId: f.issueId, runId: f.runId,
        completionContractId: contractId, schemaStatus: "accepted", serverFingerprint: resultId, canonicalSha256: resultId,
        resultJson: { terminal: { runTerminalState: "succeeded" } } });
      await db.update(nativeRunFinalizations).set({ resultId }).where(eq(nativeRunFinalizations.runId, f.runId));
      const evidence = { ...(await action(f.actionId)).evidence };
      delete evidence.workspaceRestoreFailure; delete evidence.workspaceRestoreRecovery;
      await db.update(issueRecoveryActions).set({ cause: "native_workspace_sync_out_retry_exhausted", evidence }).where(eq(issueRecoveryActions.id, f.actionId));
    }
    return { ...f, retry, failed };
  }

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
      expect(await action(f.actionId)).toEqual(before);
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

  function boardRecoveryApp(actor: { userId: string; source: "local_implicit" | "session"; companyIds?: string[] } = { userId: "local-board", source: "local_implicit" },
    heartbeat?: ReturnType<typeof heartbeatService>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", ...actor }; next(); });
    const factory = heartbeat ? vi.spyOn(heartbeatServices, "heartbeatService").mockReturnValue(heartbeat) : undefined;
    try { app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1])); }
    finally { factory?.mockRestore(); }
    app.use(errorHandler);
    return app;
  }

  type RecoverySourceLayout = "retained" | "published" | "raw";

  async function acceptedRemoteExport(sourceLayout: RecoverySourceLayout = "retained") {
    const f = await seed("native", false);
    const source = await run(f.runId);
    let workspaceId: string = randomUUID(), remoteCwd = await realpath(f.remote);
    let preparedReference: Awaited<ReturnType<typeof prepareRemoteWorkspace>>["reference"] | undefined;
    if (sourceLayout === "published") {
      // Fresh modern sources retain the actual publisher's path and authority.
      // The explicit raw fixture remains available for refusal coverage.
      targets.get(f.lease.id)!.remoteCwd = remoteCwd;
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      await db.update(issues).set({ status: "in_progress", executionRunId: f.runId, executionLockedAt: new Date() })
        .where(eq(issues.id, f.issueId));
      await db.update(heartbeatRuns).set({ status: "running", finishedAt: null, error: null, errorCode: null })
        .where(eq(heartbeatRuns.id, f.runId));
      const leaseMetadata = { ...f.lease.metadata };
      delete leaseMetadata.remoteExecutionTermination;
      const [activeLease] = await db.update(environmentLeases).set({ status: "active", releasedAt: null,
        cleanupStatus: null, metadata: leaseMetadata }).where(eq(environmentLeases.id, f.lease.id)).returning();
      const reserved = await reserveRemoteWorkspace({ db, companyId: f.companyId, issueId: f.issueId,
        runId: f.runId, agentId: source.agentId, environmentId: activeLease.environmentId!,
        projectId: null, projectWorkspaceId: null, existingWorkspaceId: null, source: { kind: "empty" } });
      const prepared = await prepareRemoteWorkspace({ db, workspace: reserved, runId: f.runId,
        lease: activeLease as EnvironmentLease, target: targets.get(f.lease.id)! });
      workspaceId = prepared.workspace.id; remoteCwd = prepared.remoteRoot; preparedReference = prepared.reference;
      for (const name of ["existing.txt", "saved.txt"]) await cp(path.join(f.remote, name), path.join(remoteCwd, name));
      await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(),
        metadata: { ...prepared.lease.metadata,
          remoteExecutionTermination: remoteTerminationReceipt(prepared.lease, { providerLeaseId: f.providerLeaseId, state: "stopped" }) },
      }).where(eq(environmentLeases.id, f.lease.id));
      await db.update(heartbeatRuns).set({ status: source.status, finishedAt: source.finishedAt,
        error: source.error, errorCode: source.errorCode }).where(eq(heartbeatRuns.id, f.runId));
      await db.update(issues).set({ status: issue.status, executionRunId: issue.executionRunId,
        executionLockedAt: issue.executionLockedAt }).where(eq(issues.id, f.issueId));
    } else if (sourceLayout === "retained") {
      const publishedRoot = path.join(path.dirname(f.remote), ".paperclip-workspaces", workspaceId);
      await mkdir(path.dirname(publishedRoot), { recursive: true });
      await rename(f.remote, publishedRoot);
      f.remote = publishedRoot;
      remoteCwd = await realpath(f.remote);
    }
    const git = (args: string[], cwd = remoteCwd) => new Promise<string>((resolve, reject) =>
      execFile("git", args, { cwd }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
    await git(["init"]);
    await git(["add", "."]);
    await git(["-c", "user.name=Recovery fixture", "-c", "user.email=recovery@example.invalid", "commit", "-m", "Completed work"]);
    const commit = await git(["rev-parse", "HEAD"]);
    targets.get(f.lease.id)!.remoteCwd = remoteCwd;
    f.runtime.resumeRunLease.mockImplementation(async () => ({ providerLeaseId: f.providerLeaseId, metadata: { remoteCwd } }));
    const authority = { schema: "paperclip.remote-workspace.v1", epoch: 1, snapshotId: null,
      source: { kind: "empty" }, writerRunId: f.runId, dirty: true,
      location: { environmentId: f.lease.environmentId!, leaseId: f.lease.id, providerLeaseId: f.providerLeaseId, remoteCwd } };
    if (sourceLayout !== "published") await db.insert(executionWorkspaces).values({ id: workspaceId, companyId: f.companyId, sourceIssueId: f.issueId,
      name: "Completed remote work", cwd: remoteCwd, providerType: "cloud_sandbox", mode: "isolated_workspace",
      strategyType: "project_primary", status: "active", metadata: { remoteWorkspace: authority } });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, f.issueId));
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    await db.update(environmentLeases).set({ executionWorkspaceId: workspaceId, leasePolicy: "reuse_by_environment",
      metadata: { ...lease.metadata, remoteCwd, agentId: source.agentId } }).where(eq(environmentLeases.id, lease.id));
    const contractId = randomUUID(), resultId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.issueId,
      revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "low",
      completionAuthority: "agent_claim_policy", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.contractRevision,
        objective: "Complete the work", criteria: [{ id: "objective", requirement: "Complete the task" }] },
      canonicalSha256: "contract", createdByActorType: "system", createdByActorId: "test" });
    await db.update(heartbeatRuns).set({ completionContractId: contractId, resultJson: {}, runnerProfileJson: {
      adapterDispatch: { adapterType: "paperclip_runner" },
      remoteWorkspace: preparedReference ?? { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId: lease.id,
        providerLeaseId: f.providerLeaseId, remoteCwd, epoch: 1, state: "prepared", snapshotId: null },
    } }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(nativeRunResults).values({ id: resultId, companyId: f.companyId, issueId: f.issueId, runId: f.runId,
      completionContractId: contractId, schemaStatus: "accepted", serverFingerprint: "result", canonicalSha256: "result",
      resultJson: { terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, result: CONTROL_PLANE_CONFORMANCE_RESULT } });
    await db.update(nativeRunFinalizations).set({ resultId, failureCode: "native_workspace_sync_out_retry_exhausted" })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    await db.update(issueRecoveryActions).set({ cause: "native_workspace_sync_out_retry_exhausted", evidence: { runId: f.runId } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    await adoptSystemRecovery(db, f);
    return { ...f, ...(sourceLayout === "published" ? { remote: remoteCwd } : {}), source, workspaceId, resultId, git, commit };
  }

  async function interruptedRemotePreparation(interruption: "shutdown" | "lease" = "shutdown", sourceLayout: RecoverySourceLayout = "retained") {
    const f = await acceptedRemoteExport(sourceLayout);
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    await db.delete(nativeRunResults).where(eq(nativeRunResults.runId, f.runId));
    const recovery = { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.lease.id] };
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null, completionContractId: null,
      status: "interrupted", executionStage: "preparing",
      errorCode: interruption === "lease" ? "lease_released_before_terminal" : "server_shutdown_interrupted",
      controllerBootId: randomUUID(),
      error: interruption === "lease" ? "Environment lease released before preparation settled" : "Interrupted by graceful server shutdown (SIGTERM)",
      resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: recovery,
        ...(interruption === "lease" ? { cancellation: { source: "unknown", expected: false,
          initiator: { type: "system" }, reason: "Environment lease released before preparation settled",
          recordedAt: new Date().toISOString() } } : {}) },
    }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ statusVersion: 2 }).where(eq(issues.id, f.issueId));
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${f.runId}`, status: "resolved", outcome: "blocked",
      evidence: { runId: f.runId, workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: recovery,
        automaticRecovery: { policy: "preserve_without_replay_v1", runId: f.runId, replay: "blocked", actionOutcome: "unknown" },
        nativeBootstrapFailureBlock: { runId: f.runId, previousStatus: "in_progress", statusVersion: 2 } },
    }).where(eq(issueRecoveryActions.id, f.actionId));
    await adoptSystemRecovery(db, f);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.source.agentId, status: "running" });
    return f;
  }

  async function failedRemotePreparation(sourceLayout: RecoverySourceLayout = "retained", startedMarker = false, warning = false) {
    const f = await interruptedRemotePreparation("shutdown", sourceLayout);
    const source = await run(f.runId);
    const error = "Repository access is no longer available; refresh the repository catalog";
    await terminalizeLegacyExecution({ db, run: source, status: "failed", reconcileIfNeeded: false,
      patch: { errorCode: "setup_failed", error, executionStage: "preparing",
        startedAt: new Date(Date.now() - 1000), contextSnapshot: { ...source.contextSnapshot, source: "native_status_decision" },
        resultJson: { ...source.resultJson, stopReason: "adapter_failed",
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } } });
    if (warning) await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: source.agentId,
      eventType: "agent_observability.unavailable", stream: "system", level: "warn",
      payload: { reason: "unsupported_harness", revision: randomUUID() } });
    if (startedMarker) await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: source.agentId,
      eventType: "lifecycle", stream: "system", level: "info", message: "run started" });
    await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: source.agentId,
      eventType: "error", stream: "system", level: "error", message: error });
    await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: source.agentId,
      eventType: "lifecycle", stream: "system", level: "info", message: "task.run.measured",
      payload: { phase: "task.run.measured", outcome: "failed", durationMs: 1000, durableSettlement: true } });
    return f;
  }

  it.each(["new message", "saved message", "Retry"] as const)(
    "continues recovered preparation with an inherited session through %s", async entry => {
    const f = await failedRemotePreparation();
    await db.update(heartbeatRuns).set({ sessionIdBefore: randomUUID() }).where(eq(heartbeatRuns.id, f.runId));
    const source = await run(f.runId), app = boardRecoveryApp(), heartbeat = heartbeatService(db);
    if (entry !== "saved message") await recoverRetainedWorkspace(f.input);
    let requestId: string | undefined, commentId: string | undefined;
    if (entry === "Retry") {
      const receipt = (await request(app).post(`/api/issues/${f.issueId}/retry`)
        .send({ observedRunId: f.runId, idempotencyKey: randomUUID() }).expect(202)).body;
      requestId = receipt.requestId;
      await heartbeat.resumeTaskRetry(f.companyId, requestId!);
    } else {
      const body = { body: "Continue from the saved work", reopen: true, clientRequestId: randomUUID() };
      const comment = (await request(app).post(`/api/issues/${f.issueId}/comments`).send(body).expect(201)).body;
      commentId = comment.id;
      expect((await request(app).post(`/api/issues/${f.issueId}/comments`).send(body).expect(201)).body.id).toBe(commentId);
      await expect.poll(async () => (await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, f.companyId),
        sql`${agentWakeupRequests.payload}->>'commentId' = ${commentId}`))).length).toBe(1);
      if (entry === "saved message") {
        expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
          eq(heartbeatRuns.status, "queued")))).toHaveLength(0);
        await recoverRetainedWorkspace(f.input);
      }
      await heartbeat.resumeRemoteStopComments(await run(f.runId));
    }
    const successors = () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      eq(heartbeatRuns.status, "queued")));
    await expect.poll(async () => (await successors()).length).toBe(1);
    const [successor] = await successors();
    expect(successor.contextSnapshot).toMatchObject({ forceFreshSession: true, previousRunId: f.runId,
      ...(commentId ? { wakeCommentIds: [commentId] } : { taskRetryRequestId: requestId }) });
    await Promise.all([heartbeat.resumeRemoteStopComments(await run(f.runId)),
      requestId ? heartbeat.resumeTaskRetry(f.companyId, requestId) : heartbeat.resumeExecutionWaitComments()]);
    expect(await successors()).toHaveLength(1);
    const queue = (await request(app).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body;
    expect(queue.executionWait ?? null).toBeNull();
    if (commentId) expect(queue).toMatchObject({ state: "queued", entries: [{ comment: { id: commentId } }] });
    else expect(queue.entries).toEqual([]);
    expect((await request(app).get(`/api/issues/${f.issueId}`).expect(200)).body.interruption)
      .toMatchObject({ state: "working", canRetry: false });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    const original = await run(f.runId);
    expect(original).toMatchObject({ status: "failed", error: source.error, sessionIdBefore: source.sessionIdBefore });
    expect(await hasVerifiedWorkspaceRepair(db, original)).toBe(true);
    const remote = original.runnerProfileJson!.remoteWorkspace as { snapshotId: string };
    const saved = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId: f.workspaceId,
      snapshotId: remote.snapshotId });
    try { expect(await readFile(path.join(saved.root, "saved.txt"), "utf8")).toBe("finished work\n"); }
    finally { await saved.cleanup(); }
  }, 30_000);

  it("admits one HTTP Retry after a failed native preparation has verified saved work", async () => {
    const f = await failedRemotePreparation();
    await recoverRetainedWorkspace(f.input);
    const source = await run(f.runId);
    expect(source).toMatchObject({ runtimeMode: "legacy", runtimeModeResolvedAt: null, executionStage: "preparing",
      status: "failed", errorCode: "setup_failed", nativeIssueId: null, nativeSessionId: null,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    expect(await hasVerifiedWorkspaceRepair(db, source)).toBe(true);
    const app = boardRecoveryApp(), heartbeat = heartbeatService(db);
    const intent = { observedRunId: f.runId, idempotencyKey: randomUUID() };
    const receipt = (await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body;
    await Promise.all([heartbeat.resumeTaskRetry(f.companyId, receipt.requestId),
      heartbeat.resumeTaskRetry(f.companyId, receipt.requestId)]);
    expect((await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body.requestId).toBe(receipt.requestId);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${receipt.requestId}`));
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ status: "queued", contextSnapshot: {
      previousRunId: f.runId, taskRetryRequestId: receipt.requestId } });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId)))[0])
      .toMatchObject({ status: "coalesced", runId: successors[0].id });
    expect(await readFreshWorkspaceReadiness(db, successors[0])).toMatchObject({ mode: "resume_preserved_workspace" });
    const remote = source.runnerProfileJson!.remoteWorkspace as { snapshotId: string };
    const saved = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId: f.workspaceId,
      snapshotId: remote.snapshotId });
    try { expect(await readFile(path.join(saved.root, "saved.txt"), "utf8")).toBe("finished work\n"); }
    finally { await saved.cleanup(); }
    expect((await run(f.runId)).error).toBe(source.error);
  }, 30_000);

  async function recoveredPreparationRetryChain(mode: "certified" | "inherited_session" | "historical_warning" | "empty_object_log" = "inherited_session") {
    const f = await failedRemotePreparation("retained", mode !== "certified", mode === "historical_warning");
    await recoverRetainedWorkspace(f.input);
    if (mode !== "certified") await db.update(heartbeatRuns).set({ errorCode: "adapter_failed",
      sessionIdBefore: randomUUID() }).where(eq(heartbeatRuns.id, f.runId));
    const source = await run(f.runId);
    const [completed] = mode !== "certified" ? await db.insert(heartbeatRuns).values({
      companyId: f.companyId, issueId: f.issueId, agentId: source.agentId, status: "succeeded",
      createdAt: new Date(source.createdAt.getTime() - 1000), finishedAt: source.createdAt,
      sessionIdAfter: source.sessionIdBefore, resultJson: { summary: "Earlier turn completed" },
    }).returning() : [];
    if (completed) await db.update(heartbeatRuns).set({ retryOfRunId: completed.id }).where(eq(heartbeatRuns.id, source.id));
    if (mode === "empty_object_log") await recordPreparationObjectLog(source);
    const [failed] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, issueId: f.issueId,
      agentId: source.agentId, runtimeMode: "legacy", status: "failed", retryOfRunId: source.id,
      sessionIdBefore: source.sessionIdBefore,
      startedAt: new Date(), finishedAt: new Date(), executionStage: "preparing", errorCode: "setup_failed",
      error: "The workspace still has an unfinished writer or save operation.",
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      contextSnapshot: { issueId: f.issueId, source: "issue.continuation_recovery" },
      resultJson: { stopReason: "adapter_failed", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    }).returning();
    return { ...f, source, failed, completed };
  }

  async function recordPreparationObjectLog(source: typeof heartbeatRuns.$inferSelect, outputText?: string) {
    const store = objectLogFixture();
    const output = createHeartbeatRunOutput(db, { run: source, runId: source.id, issueId: source.issueId,
      runLogStore: store, identityRedactor: { chunk: (_stream, value) => value, redact: value => value },
      secretKeys: new Set(), appendRunEvent: vi.fn(), getCurrentUserRedactionOptions: async () => ({ enabled: false }) });
    const handlers = await output.begin(source);
    if (outputText) await handlers.onLog("stdout", outputText);
    const summary = await store.finalize(output.handle!);
    await output.flushOutputProgress({ force: true });
    await db.update(heartbeatRuns).set({ logBytes: summary.bytes, logSha256: summary.sha256,
      logCompressed: summary.compressed, stdoutExcerpt: output.stdoutExcerpt, stderrExcerpt: output.stderrExcerpt,
    }).where(eq(heartbeatRuns.id, source.id));
    return { store, summary };
  }

  it.each(["certified", "inherited_session", "historical_warning", "empty_object_log"] as const)("admits one HTTP Retry through a failed automatic successor after its preparation ancestor is recovered: %s", async mode => {
    const f = await recoveredPreparationRetryChain(mode);
    const app = boardRecoveryApp(), heartbeat = heartbeatService(db);
    const intent = { observedRunId: f.failed.id, idempotencyKey: randomUUID() };
    const receipt = (await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body;
    await Promise.all([heartbeat.resumeTaskRetry(f.companyId, receipt.requestId),
      heartbeat.resumeTaskRetry(f.companyId, receipt.requestId)]);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${receipt.requestId}`));
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ status: "queued", contextSnapshot: {
      forceFreshSession: true, previousRunId: f.failed.id, taskRetryRequestId: receipt.requestId } });
    expect(await readFreshWorkspaceReadiness(db, successors[0])).toMatchObject({ mode: "resume_preserved_workspace" });
    expect(await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: f.source.agentId, runId: successors[0].id, context: successors[0].contextSnapshot!,
      summary: null, exposeLowTrustRaw: false })).toMatchObject({ interruptedRunId: f.failed.id });
    const remote = (await run(f.source.id)).runnerProfileJson!.remoteWorkspace as { snapshotId: string };
    const saved = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId: f.workspaceId,
      snapshotId: remote.snapshotId });
    try { expect(await readFile(path.join(saved.root, "saved.txt"), "utf8")).toBe("finished work\n"); }
    finally { await saved.cleanup(); }
    expect((await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body.requestId).toBe(receipt.requestId);
    expect((await run(f.runId)).error).toBe(f.source.error);
    if (f.completed) expect(await run(f.completed.id)).toEqual(f.completed);
  }, 30_000);

  it.each(["unknown_size", "unknown_digest", "wrong_digest", "nonempty_size", "foreign_reference", "other_store",
    "stdout", "stderr", "output_sequence", "output_time", "output_bytes", "output_stream", "compressed", "recorded_output"] as const)(
    "keeps a logged preparation ancestor held without complete empty-output proof: %s", async gate => {
      const f = await recoveredPreparationRetryChain("empty_object_log");
      if (gate === "recorded_output") await recordPreparationObjectLog(await run(f.source.id), "Provider work was recorded.\n");
      const patch: Partial<typeof heartbeatRuns.$inferInsert> = gate === "unknown_size" ? { logBytes: null }
        : gate === "unknown_digest" ? { logSha256: null }
        : gate === "wrong_digest" ? { logSha256: "0".repeat(64) }
        : gate === "nonempty_size" ? { logBytes: 1 }
        : gate === "foreign_reference" ? { logRef: `${f.companyId}/${f.source.agentId}/${randomUUID()}` }
        : gate === "other_store" ? { logStore: "s3_archive" }
        : gate === "stdout" ? { stdoutExcerpt: "Recorded provider output" }
        : gate === "stderr" ? { stderrExcerpt: "Recorded diagnostic output" }
        : gate === "output_sequence" ? { lastOutputSeq: 1 }
        : gate === "output_time" ? { lastOutputAt: new Date() }
        : gate === "output_bytes" ? { lastOutputBytes: 1 }
        : gate === "output_stream" ? { lastOutputStream: "stdout" }
        : gate === "compressed" ? { logCompressed: true } : {};
      if (Object.keys(patch).length) await db.update(heartbeatRuns).set(patch).where(eq(heartbeatRuns.id, f.source.id));
      const receipt = (await request(boardRecoveryApp()).post(`/api/issues/${f.issueId}/retry`)
        .send({ observedRunId: f.failed.id, idempotencyKey: randomUUID() }).expect(202)).body;
      await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${receipt.requestId}`))).toHaveLength(0);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId)))[0])
        .toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect((await action(f.actionId)).evidence.explicitUserContinuation).toBeUndefined();
    }, 30_000);

  it.each(["foreign_company", "foreign_task", "foreign_agent", "conflicting_binding", "missing_edge", "cycle", "forged_context",
    "live_predecessor", "live_controller", "unknown_stop", "failed_cleanup", "pending_cleanup", "failed_save",
    "unsafe_workspace", "operator_stop", "wrong_actor", "wrong_generation", "wrong_recovery_source", "sibling_hold", "completed_ancestor",
    "provider_event", "native_input", "session_checkpoint", "controller_recovery", "native_result", "process", "runtime_selected",
    "unknown_result", "provider_usage", "invalid_accounting", "foreign_lease_issue", "foreign_started_event", "invalid_started_event",
    "warning_reason", "provider_warning", "extra_after_warning", "unknown_failure_code", "missing_failure_code", "operator_stop_mislabeled"] as const)(
    "keeps ancestor Retry held when current proof changes: %s", async gate => {
      const f = await recoveredPreparationRetryChain(["warning_reason", "provider_warning", "extra_after_warning"].includes(gate)
        ? "historical_warning" : "inherited_session");
      const heartbeat = heartbeatService(db), app = boardRecoveryApp();
      const original = readSystemRecovery((await action(f.actionId)).evidence)!;
      const receipt = (await request(app).post(`/api/issues/${f.issueId}/retry`)
        .send({ observedRunId: f.failed.id, idempotencyKey: randomUUID() }).expect(202)).body;
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId));
      expect(readSystemRecovery((await action(f.actionId)).evidence)).toMatchObject({
        generationId: original.generationId, attempts: original.attempts, intentId: receipt.requestId });
      if (["foreign_company", "foreign_task", "foreign_agent", "conflicting_binding"].includes(gate)) {
        const companyId = gate === "foreign_company" ? randomUUID() : f.companyId;
        if (companyId !== f.companyId) {
          await db.insert(companies).values({ id: companyId, name: "Other company", issuePrefix: `X${companyId.slice(0, 6)}` });
          fixtureCompanyIds.add(companyId);
        }
        const agentId = gate === "foreign_company" || gate === "foreign_agent" ? randomUUID() : f.source.agentId;
        if (agentId !== f.source.agentId) await db.insert(agents).values({ id: agentId, companyId,
          name: "Other owner", adapterType: "paperclip_runner" });
        const issueId = gate === "foreign_company" || gate === "foreign_task" || gate === "conflicting_binding" ? randomUUID() : f.issueId;
        if (issueId !== f.issueId) await db.insert(issues).values({ id: issueId, companyId, title: "Other work" });
        const [bridge] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId,
          nativeIssueId: gate === "conflicting_binding" ? f.issueId : issueId, status: "failed", finishedAt: new Date(), retryOfRunId: f.source.id,
          createdAt: f.source.createdAt, contextSnapshot: { issueId: f.issueId } }).returning();
        await db.update(heartbeatRuns).set({ retryOfRunId: bridge.id }).where(eq(heartbeatRuns.id, f.failed.id));
      }
      if (gate === "missing_edge" || gate === "forged_context") await db.update(heartbeatRuns).set({ retryOfRunId: null,
        ...(gate === "forged_context" ? { contextSnapshot: { ...f.failed.contextSnapshot,
          previousRunId: f.source.id, retryOfRunId: f.source.id } } : {}) }).where(eq(heartbeatRuns.id, f.failed.id));
      if (gate === "cycle") await db.update(heartbeatRuns).set({ retryOfRunId: f.source.id }).where(eq(heartbeatRuns.id, f.source.id));
      if (gate === "live_predecessor") await db.update(heartbeatRuns).set({ status: "running", finishedAt: null })
        .where(eq(heartbeatRuns.id, f.source.id));
      if (gate === "live_controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) })
        .where(eq(heartbeatRuns.id, f.source.id));
      if (gate === "provider_event" || gate === "extra_after_warning") await appendHeartbeatRunEvent(db, {
        companyId: f.companyId, runId: f.source.id, agentId: f.source.agentId, stream: "system", level: "info",
        eventType: gate === "provider_event" ? "session.started" : "lifecycle", message: "Unexpected later event" });
      if (["native_input", "session_checkpoint", "controller_recovery"].includes(gate)) {
        const key = gate === "native_input" ? "nativeExecutionInput" : gate === "session_checkpoint" ? "sessionCheckpoint" : "nativeControllerRecovery";
        await db.update(heartbeatRuns).set({ runnerProfileJson: { ...f.source.runnerProfileJson, [key]: { sessionId: randomUUID() } } })
          .where(eq(heartbeatRuns.id, f.source.id));
      }
      if (gate === "native_result") {
        const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.companyId, f.companyId));
        await db.update(heartbeatRuns).set({ nativeIssueId: f.issueId, completionContractId: contract.id })
          .where(eq(heartbeatRuns.id, f.source.id));
        await db.insert(nativeRunResults).values({ companyId: f.companyId, issueId: f.issueId, runId: f.source.id,
          completionContractId: contract.id, schemaStatus: "accepted", canonicalSha256: "unexpected", serverFingerprint: "unexpected",
          resultJson: { terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, result: CONTROL_PLANE_CONFORMANCE_RESULT } });
      }
      if (gate === "process") await db.update(heartbeatRuns).set({ processPid: 999999999 }).where(eq(heartbeatRuns.id, f.source.id));
      if (gate === "runtime_selected") await db.update(heartbeatRuns).set({ runtimeModeResolvedAt: new Date() }).where(eq(heartbeatRuns.id, f.source.id));
      if (gate === "unknown_result") await db.update(heartbeatRuns).set({ resultJson: { ...f.source.resultJson, unknownOutcome: true } })
        .where(eq(heartbeatRuns.id, f.source.id));
      if (gate === "provider_usage" || gate === "invalid_accounting") await db.update(heartbeatRuns).set({ usageJson: gate === "provider_usage"
        ? { inputTokens: 1 } : { ledgerScope: { issueId: randomUUID(), projectId: null, billingCode: null } } }).where(eq(heartbeatRuns.id, f.source.id));
      if (["foreign_started_event", "invalid_started_event", "warning_reason", "provider_warning"].includes(gate))
        await db.update(heartbeatRunEvents).set(gate === "foreign_started_event" || gate === "provider_warning"
          ? { sourceEventId: randomUUID() } : { payload: gate === "warning_reason" ? { reason: "unknown", revision: randomUUID() } : { unknown: true } })
          .where(and(eq(heartbeatRunEvents.runId, f.source.id), eq(heartbeatRunEvents.seq, 1)));
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      if (gate === "foreign_lease_issue") {
        const [other] = await db.insert(issues).values({ companyId: f.companyId, title: "Other allocation owner" }).returning();
        await db.update(environmentLeases).set({ issueId: other.id }).where(eq(environmentLeases.id, lease.id));
      }
      if (gate === "unknown_stop") await db.update(environmentLeases).set({ metadata: { ...lease.metadata,
        remoteExecutionTermination: null } }).where(eq(environmentLeases.id, lease.id));
      if (gate === "failed_cleanup") await db.update(environmentLeases).set({ cleanupStatus: "failed" }).where(eq(environmentLeases.id, lease.id));
      if (gate === "pending_cleanup") await db.update(environmentLeases).set({ metadata: { ...lease.metadata,
        pendingCleanupInFlight: true } }).where(eq(environmentLeases.id, lease.id));
      if (gate === "failed_save") await db.update(workspaceOperations).set({ status: "failed" }).where(and(
        eq(workspaceOperations.companyId, f.companyId), eq(workspaceOperations.heartbeatRunId, f.source.id),
        eq(workspaceOperations.phase, "workspace_recovery")));
      if (gate === "unsafe_workspace") {
        const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
        await db.update(executionWorkspaces).set({ metadata: { ...workspace.metadata,
          remoteWorkspace: { ...(workspace.metadata!.remoteWorkspace as object), dirty: true, writerRunId: f.source.id } } })
          .where(eq(executionWorkspaces.id, f.workspaceId));
      }
      if (gate === "operator_stop") await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "operator_interrupted" })
        .where(eq(heartbeatRuns.id, f.source.id));
      if (["unknown_failure_code", "missing_failure_code", "operator_stop_mislabeled"].includes(gate)) await db.update(heartbeatRuns)
        .set({ errorCode: gate === "missing_failure_code" ? null : gate === "operator_stop_mislabeled" ? "operator_interrupted" : "unknown_failure" })
        .where(eq(heartbeatRuns.id, f.source.id));
      if (gate === "wrong_actor") await db.update(agentWakeupRequests).set({ requestedByActorId: "other-user" })
        .where(eq(agentWakeupRequests.id, wake.id));
      if (gate === "wrong_generation") await db.update(agentWakeupRequests).set({ payload: { ...wake.payload,
        taskRetry: { ...(wake.payload!.taskRetry as object), generationId: randomUUID() } } }).where(eq(agentWakeupRequests.id, wake.id));
      if (gate === "wrong_recovery_source") {
        const record = await action(f.actionId);
        const systemRecovery = { ...readSystemRecovery(record.evidence)!, sourceRunId: randomUUID(),
          intentId: null, state: "exhausted" as const };
        await db.update(issueRecoveryActions).set({ evidence: { ...record.evidence, systemRecovery } })
          .where(eq(issueRecoveryActions.id, record.id));
        const next = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
          actorSource: "local_implicit", observedRunId: f.failed.id, idempotencyKey: randomUUID() });
        expect(next.requestId).toBe(receipt.requestId);
        expect(readSystemRecovery((await action(f.actionId)).evidence)).toEqual(systemRecovery);
      }
      if (gate === "sibling_hold" || gate === "completed_ancestor") {
        const [other] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.source.agentId,
          issueId: f.issueId, status: gate === "completed_ancestor" ? "succeeded" : "failed", finishedAt: new Date(),
          createdAt: new Date(f.source.createdAt.getTime() - 1000), runnerProfileJson: f.source.runnerProfileJson }).returning();
        const originalAction = await action(f.actionId);
        const systemRecovery = { ...createSystemRecovery(other.id), state: "exhausted" as const };
        const [hold] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
          kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: other.id,
          status: "resolved", outcome: "blocked", nextAction: "Existing hold", evidence: { ...originalAction.evidence,
            runId: other.id, systemRecovery } }).returning();
        if (gate === "completed_ancestor") await db.update(heartbeatRuns).set({ retryOfRunId: other.id }).where(eq(heartbeatRuns.id, f.source.id));
        const next = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
          actorSource: "local_implicit", observedRunId: f.failed.id, idempotencyKey: randomUUID() });
        expect(next.requestId).toBe(receipt.requestId);
        expect(readSystemRecovery((await action(hold.id)).evidence)).toEqual(systemRecovery);
      }
      await Promise.all([heartbeat.resumeTaskRetry(f.companyId, receipt.requestId), heartbeat.resumeTaskRetry(f.companyId, receipt.requestId)]);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${receipt.requestId}`))).toHaveLength(0);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId)))[0])
        .toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect((await action(f.actionId)).evidence.explicitUserContinuation).toBeUndefined();
    }, 30_000);

  it("resumes the same failed-preparation HTTP Retry from the real preservation worker", async () => {
    const f = await failedRemotePreparation();
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    await db.update(environmentLeases).set({ status: "active", releasedAt: null, cleanupStatus: null,
      metadata: { ...lease.metadata, remoteExecutionTermination: null } }).where(eq(environmentLeases.id, lease.id));
    let releaseStop!: () => void;
    const stopped = new Promise<void>(resolve => { releaseStop = resolve; });
    f.runtime.retryPendingSandboxTeardown.mockImplementation(async () => {
      await stopped;
      return { providerLeaseId: f.providerLeaseId, state: "stopped" };
    });
    const errors = vi.fn(), heartbeat = heartbeatService(db, { environmentRuntime: f.environmentRuntime });
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: errors });
    const worker = registerWorkspaceRecoveryWork(db, coordinator, f.environmentRuntime, heartbeat.resumeRemoteStopComments);
    const successors = () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${requestId}`));
    let requestId: string;
    try {
      await worker.ready;
      const app = boardRecoveryApp(), intent = { observedRunId: f.runId, idempotencyKey: randomUUID() };
      const receipt = (await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body;
      requestId = receipt.requestId;
      expect((await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body.requestId).toBe(requestId);
      await expect.poll(() => f.runtime.retryPendingSandboxTeardown.mock.calls.length, { timeout: 20_000 }).toBe(1);
      expect(await successors()).toHaveLength(0);
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0].metadata?.remoteExecutionTermination).toBeFalsy();
      releaseStop();
      await expect.poll(async () => (await successors()).length, { timeout: 20_000 }).toBe(1);
      const [successor] = await successors();
      expect(successor.contextSnapshot).toMatchObject({ previousRunId: f.runId, taskRetryRequestId: requestId });
      expect(await readFreshWorkspaceReadiness(db, successor)).toMatchObject({ mode: "resume_preserved_workspace" });
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
      const remote = (await run(f.runId)).runnerProfileJson!.remoteWorkspace as { snapshotId: string };
      const saved = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId: f.workspaceId, snapshotId: remote.snapshotId });
      try { expect(await readFile(path.join(saved.root, "saved.txt"), "utf8")).toBe("finished work\n"); }
      finally { await saved.cleanup(); }
      await Promise.all([heartbeat.resumeTaskRetry(f.companyId, requestId), heartbeat.resumeRemoteStopComments(await run(f.runId))]);
      expect(await successors()).toHaveLength(1);
      expect(f.runtime.resumeRunLease).toHaveBeenCalledOnce();
      expect((await run(f.runId))).toMatchObject({ status: "failed", errorCode: "setup_failed" });
      expect(errors).not.toHaveBeenCalled();
    } finally { releaseStop(); await coordinator.stop(); await worker.stop(); }
  }, 40_000);

  it.each(["delayed_provider_event", "native_input", "session_checkpoint", "session_after", "controller_recovery", "process", "coordinator",
    "runtime_selected", "live_controller", "missing_error", "missing_measurement", "foreign_error", "unknown_result",
    "wrong_snapshot", "wrong_generation", "active_writer", "missing_stop", "foreign_stop", "additional_unstopped_lease",
    "operator_stop", "newer_input", "reassigned", "wrong_actor", "actor_permission_revoked",
    "provider_usage", "unknown_usage", "invalid_ledger_scope", "foreign_ledger_scope",
    "array_usage", "false_usage", "zero_usage", "empty_usage_string", "empty_usage_object",
    "active_lease", "pending_cleanup", "cleanup_failed", "cleanup_unknown", "cleanup_inflight", "unreleased", "foreign_lease_issue", "local_provider_claim"] as const)(
    "holds a failed-preparation HTTP Retry when current proof changes: %s", async gate => {
      const f = await failedRemotePreparation();
      await db.update(heartbeatRuns).set({ sessionIdBefore: randomUUID() }).where(eq(heartbeatRuns.id, f.runId));
      await recoverRetainedWorkspace(f.input);
      const source = await run(f.runId), heartbeat = heartbeatService(db);
      const actorId = gate === "actor_permission_revoked" ? randomUUID() : "local-board";
      if (gate === "actor_permission_revoked") {
        await db.insert(authUsers).values({ id: actorId, name: "Retry owner", email: `${actorId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
        await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: actorId, membershipRole: "owner" });
      }
      const app = boardRecoveryApp({ userId: actorId, source: gate === "actor_permission_revoked" ? "session" : "local_implicit", companyIds: [f.companyId] });
      const receipt = (await request(app).post(`/api/issues/${f.issueId}/retry`)
        .send({ observedRunId: f.runId, idempotencyKey: randomUUID() }).expect(202)).body;
      if (gate === "delayed_provider_event") await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId,
        agentId: source.agentId, eventType: "session.started", stream: "system", payload: { sessionId: randomUUID() },
        nativeSource: { sourceInstanceId: randomUUID(), sourceEventId: randomUUID(), sourceSeq: 1, protocolSchemaVersion: 1,
          canonicalPayload: { type: "session.started", sessionId: randomUUID() } } });
      if (["native_input", "session_checkpoint", "controller_recovery"].includes(gate)) {
        const key = gate === "native_input" ? "nativeExecutionInput" : gate === "session_checkpoint" ? "sessionCheckpoint" : "nativeControllerRecovery";
        await db.update(heartbeatRuns).set({ runnerProfileJson: { ...source.runnerProfileJson, [key]: { sessionId: randomUUID() } } })
          .where(eq(heartbeatRuns.id, f.runId));
      }
      if (gate === "process") await db.update(heartbeatRuns).set({ processPid: 1386 }).where(eq(heartbeatRuns.id, f.runId));
      if (gate === "session_after") await db.update(heartbeatRuns).set({ sessionIdAfter: randomUUID() }).where(eq(heartbeatRuns.id, f.runId));
      if (gate === "coordinator") {
        await db.update(heartbeatRuns).set({ nativeIssueId: f.issueId }).where(eq(heartbeatRuns.id, f.runId));
        await db.insert(nativeRunFinalizations).values({ companyId: f.companyId,
          issueId: f.issueId, runId: f.runId, phase: "observed", attempt: 1 });
      }
      if (gate === "runtime_selected") await db.update(heartbeatRuns).set({ runtimeModeResolvedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      if (gate === "live_controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) })
        .where(eq(heartbeatRuns.id, f.runId));
      if (gate === "missing_error" || gate === "missing_measurement") await db.delete(heartbeatRunEvents).where(and(
        eq(heartbeatRunEvents.runId, f.runId), eq(heartbeatRunEvents.seq, gate === "missing_error" ? 1 : 2)));
      if (gate === "foreign_error") {
        const [foreign] = await db.insert(agents).values({ companyId: f.companyId, name: "Other owner", adapterType: "paperclip_runner" }).returning();
        await db.update(heartbeatRunEvents).set({ agentId: foreign.id })
          .where(and(eq(heartbeatRunEvents.runId, f.runId), eq(heartbeatRunEvents.seq, 1)));
      }
      if (["array_usage", "false_usage", "zero_usage", "empty_usage_string", "empty_usage_object"].includes(gate)) {
        const invalid = gate === "array_usage" ? [] : gate === "false_usage" ? false : gate === "zero_usage" ? 0
          : gate === "empty_usage_string" ? "" : {};
        await db.update(heartbeatRuns).set({ usageJson: sql`${JSON.stringify(invalid)}::jsonb` }).where(eq(heartbeatRuns.id, f.runId));
      }
      if (["provider_usage", "unknown_usage", "invalid_ledger_scope", "foreign_ledger_scope"].includes(gate)) {
        const ledgerScope = { issueId: gate === "foreign_ledger_scope" ? randomUUID() : f.issueId, projectId: null, billingCode: null };
        await db.update(heartbeatRuns).set({ usageJson: gate === "provider_usage" ? { ledgerScope, inputTokens: 0 }
          : gate === "unknown_usage" ? { ledgerScope, unknown: true }
            : { ledgerScope: gate === "invalid_ledger_scope" ? { ...ledgerScope, providerWorkStarted: false } : ledgerScope } })
          .where(eq(heartbeatRuns.id, f.runId));
      }
      if (gate === "unknown_result") await db.update(heartbeatRuns).set({ resultJson: { ...source.resultJson,
        output: "Unknown provider work must not be replayed" } }).where(eq(heartbeatRuns.id, f.runId));
      if (gate === "wrong_snapshot") await db.update(heartbeatRuns).set({ runnerProfileJson: { ...source.runnerProfileJson,
        remoteWorkspace: { ...(source.runnerProfileJson!.remoteWorkspace as Record<string, unknown>), snapshotId: randomUUID() } } })
        .where(eq(heartbeatRuns.id, f.runId));
      if (gate === "wrong_generation") await db.update(workspaceOperations).set({ metadata: sql`jsonb_set(${workspaceOperations.metadata}, '{generation}', '999')` })
        .where(and(eq(workspaceOperations.heartbeatRunId, f.runId), eq(workspaceOperations.phase, "workspace_recovery")));
      if (gate === "active_writer") await db.update(executionWorkspaces).set({ metadata: sql`jsonb_set(${executionWorkspaces.metadata}, '{remoteWorkspace,writerRunId}', ${JSON.stringify(randomUUID())}::jsonb)` })
        .where(eq(executionWorkspaces.id, f.workspaceId));
      if (gate === "missing_stop" || gate === "foreign_stop") {
        const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
        await db.update(environmentLeases).set({ metadata: { ...lease.metadata, remoteExecutionTermination: gate === "missing_stop"
          ? null : { ...(lease.metadata!.remoteExecutionTermination as Record<string, unknown>), runId: randomUUID() } } })
          .where(eq(environmentLeases.id, lease.id));
      }
      if (["active_lease", "pending_cleanup", "cleanup_failed", "cleanup_unknown", "cleanup_inflight", "unreleased", "local_provider_claim"].includes(gate)) {
        await db.update(environmentLeases).set({
          ...(gate === "active_lease" ? { status: "active" } : gate === "pending_cleanup" ? { status: "pending_cleanup" } : {}),
          ...(gate === "cleanup_failed" ? { cleanupStatus: "failed" } : gate === "cleanup_unknown" ? { cleanupStatus: null } : {}),
          ...(gate === "unreleased" ? { releasedAt: null } : {}),
          ...(gate === "cleanup_inflight" ? { metadata: sql`jsonb_set(${environmentLeases.metadata}, '{pendingCleanupInFlight}', 'true')` } : {}),
          ...(gate === "local_provider_claim" ? { provider: "local", providerLeaseId: null,
            metadata: sql`${environmentLeases.metadata} - 'remoteExecutionTermination'` } : {}),
        }).where(eq(environmentLeases.id, f.lease.id));
      }
      if (gate === "foreign_lease_issue") {
        const [foreign] = await db.insert(issues).values({ companyId: f.companyId, title: "Other task", status: "blocked", assigneeAgentId: source.agentId }).returning();
        await db.update(environmentLeases).set({ issueId: foreign.id }).where(eq(environmentLeases.id, f.lease.id));
      }
      if (gate === "additional_unstopped_lease") await db.insert(environmentLeases).values({ companyId: f.companyId,
        issueId: f.issueId, heartbeatRunId: f.runId, environmentId: f.lease.environmentId,
        provider: "daytona", providerLeaseId: randomUUID(), status: "active" });
      if (gate === "operator_stop") await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "operator_interrupted",
        resultJson: { ...source.resultJson, cancellation: requestedRunCancellation({ cancelledByActorType: "user", cancelledByUserId: "local-board" }, "Stop requested") } })
        .where(eq(heartbeatRuns.id, f.runId));
      if (gate === "newer_input") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId,
        issueId: f.issueId, contextSnapshot: { issueId: f.issueId, source: "issue.comment.reopen" }, status: "running" });
      if (gate === "reassigned") await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "board" }).where(eq(issues.id, f.issueId));
      if (gate === "wrong_actor") await db.update(agentWakeupRequests).set({ requestedByActorId: "another-user" })
        .where(eq(agentWakeupRequests.id, receipt.requestId));
      if (gate === "actor_permission_revoked") await db.update(companyMemberships).set({ status: "suspended" })
        .where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, actorId)));
      await Promise.all([heartbeat.resumeTaskRetry(f.companyId, receipt.requestId), heartbeat.resumeTaskRetry(f.companyId, receipt.requestId)]);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${receipt.requestId}`))).toHaveLength(0);
      expect((await run(f.runId)).error).toBe(source.error);
    }, 30_000);

  it.each(["settled", "active", "provider_handle"] as const)("keeps unsupported mixed local and remote source leases held: %s", async state => {
    const f = await failedRemotePreparation();
    await recoverRetainedWorkspace(f.input);
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId, issueId: f.issueId,
      provider: "local", providerLeaseId: state === "provider_handle" ? randomUUID() : null,
      status: state === "active" ? "active" : "released", releasedAt: new Date(), cleanupStatus: "success" });
    const receipt = (await request(boardRecoveryApp()).post(`/api/issues/${f.issueId}/retry`)
      .send({ observedRunId: f.runId, idempotencyKey: randomUUID() }).expect(202)).body;
    await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId);
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${receipt.requestId}`))).toHaveLength(0);
  }, 30_000);

  it.each(["plain", "unsupported_warning", "warning_presentation", "provider_warning", "measurement"] as const)(
    "keeps the existing-directory readiness settlement contract: %s", async mode => {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), sourceRunId = randomUUID(),
      successorRunId = randomUUID(), requestId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Preparation settlement", issuePrefix: `S${companyId.slice(0, 6)}` });
    fixtureCompanyIds.add(companyId);
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue existing directory", status: "blocked", assigneeAgentId: agentId });
    const cwd = await materializeIsolatedTaskDirectory({ companyId, issueId });
    await writeFile(path.join(cwd, "saved.txt"), "existing task work\n");
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, sourceIssueId: issueId,
      mode: "isolated_workspace", strategyType: "project_primary", providerType: "local_fs", name: "Task directory", cwd }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id, executionWorkspacePreference: "reuse_existing" }).where(eq(issues.id, issueId));
    const error = "The selected existing task directory has no Git checkout.";
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, issueId, runtimeMode: "legacy",
      status: "failed", finishedAt: new Date(), errorCode: "workspace_validation_failed", error, executionStage: "preparing",
      contextSnapshot: { issueId }, runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      usageJson: { ledgerScope: { issueId, projectId: null, billingCode: null } },
      resultJson: { stopReason: "adapter_failed", executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        workspaceValidation: { reason: "git_worktree_base_not_git_checkout", issueId,
          resolvedWorkspaceSource: "task_session", requestedExecutionWorkspaceMode: "isolated_workspace",
          issueExecutionWorkspacePreference: "reuse_existing", issueExecutionWorkspaceId: workspace.id,
          issueProjectId: null, issueProjectWorkspaceId: null, resolvedWorkspaceCwd: cwd } } });
    if (mode.includes("warning")) await appendHeartbeatRunEvent(db, { companyId, agentId, runId: sourceRunId,
      eventType: "agent_observability.unavailable", level: "warn", stream: "system",
      message: mode === "warning_presentation" ? "Changed presentation" : "Company observability was not applied: this harness is not supported.",
      payload: { reason: "unsupported_harness", revision: randomUUID() },
      ...(mode === "provider_warning" ? { nativeSource: { sourceInstanceId: randomUUID(), sourceEventId: randomUUID(), sourceSeq: 1,
        protocolSchemaVersion: 1, canonicalPayload: { type: "agent_observability.unavailable" } } } : {}) });
    await appendHeartbeatRunEvent(db, { companyId, agentId, runId: sourceRunId, eventType: "error", level: "error", stream: "system", message: error });
    await appendHeartbeatRunEvent(db, { companyId, agentId, runId: sourceRunId, eventType: "lifecycle", level: "info", stream: "system",
      message: "task.run.measured", payload: { phase: "task.run.measured", outcome: "failed", durationMs: 1, durableSettlement: mode !== "measurement" } });
    const [successor] = await db.insert(heartbeatRuns).values({ id: successorRunId, companyId, agentId, issueId, status: "queued",
      contextSnapshot: { issueId, previousRunId: sourceRunId, taskRetryRequestId: requestId } }).returning();
    await db.insert(agentWakeupRequests).values({ id: requestId, companyId, agentId, source: "on_demand", triggerDetail: "manual", reason: "task_retry",
      status: "coalesced", runId: successor.id, requestedByActorType: "user", requestedByActorId: "local-board",
      idempotencyKey: `task-retry:${randomUUID()}`, payload: { issueId, taskRetry: { schema: "paperclip.task-retry.v1",
        generationId: requestId, sourceRunId, actorId: "local-board", actorSource: "session", strategy: "evaluate" } } });
    const reuse = mode === "plain" || mode === "unsupported_warning";
    expect(await readFreshWorkspaceReadiness(db, successor)).toMatchObject(reuse
      ? { mode: "reuse_current_workspace", retryIntentId: requestId, sourceRunId, workspaceId: workspace.id, cwd }
      : { mode: "fresh_isolated_workspace", retryIntentId: requestId, sourceRunId, retainedSourceIds: [] });
    expect(await readFile(path.join(cwd, "saved.txt"), "utf8")).toBe("existing task work\n");
  });

  it.each(["complete", "catalog", "catalog_warning", "catalog_unknown_warning", "catalog_provider_warning", "invalid_published_root"] as const)(
    "dispatches the recovered failed-preparation Retry once through the native provider boundary (%s)", async mode => {
    const unavailableCatalog = mode !== "complete" && mode !== "invalid_published_root", withWarning = mode.includes("warning");
    const localStorage = getStorageService();
    const databaseUrl = process.env.DATABASE_URL, masterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    const experimental = await instanceSettingsService(db).getExperimental();
    let storage: { mockRestore(): void } | undefined;
    const starts = vi.spyOn(agentStarts, "withAgentStartLock");
    const retryResumes: Promise<void>[] = [];
    let resumeSpy: { mockRestore(): void } | undefined;
    let ownedHeartbeat: ReturnType<typeof heartbeatService> | undefined;
    let releaseStart: (() => void) | undefined;
    let heldStart: Promise<void> | undefined;
    let explicitResume: Promise<void> | undefined;
    let recoveryCoordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
    let recoveryWorker: ReturnType<typeof registerWorkspaceRecoveryWork> | undefined;
    try {
      storage = vi.spyOn(storageBackend, "getStorageService").mockReturnValue({ ...localStorage, provider: "s3" });
      process.env.DATABASE_URL = connectionString; process.env.PAPERCLIP_SECRETS_MASTER_KEY = "63".repeat(32);
      await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true, enableIsolatedWorkspaces: true });
      const f = await failedRemotePreparation(mode === "invalid_published_root" ? "raw" : "published");
      if (mode === "complete") await db.update(heartbeatRuns).set({ sessionIdBefore: randomUUID() }).where(eq(heartbeatRuns.id, f.runId));
      await recoverRetainedWorkspace(f.input);
      const source = await run(f.runId), nextDirectory = path.join(root, randomUUID(), "next");
      await mkdir(nextDirectory, { recursive: true });
      const nextRemote = await realpath(nextDirectory);
      await db.insert(authUsers).values({ id: "local-board", name: "Local operator", email: "local-board@example.invalid",
        createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: "local-board", membershipRole: "owner" });
      await db.update(agents).set({ defaultEnvironmentId: f.lease.environmentId,
        adapterConfig: withWarning ? { provider: "acpx", acpxAgent: "pi", model: "openrouter/deepseek/deepseek-v4.1-flash-1017" }
          : { provider: "codex", model: "gpt-6.1-sol" } }).where(eq(agents.id, source.agentId));
      if (withWarning) await db.insert(companyObservability).values({ companyId: f.companyId, revision: randomUUID(), enabled: true,
        destination: { provider: "otlp", endpointBaseUrl: "https://collector.example.invalid/otel" },
        capture: { userPrompts: false, assistantResponses: false, toolDetails: false, toolContent: false } });
      await db.update(environments).set({ config: { provider: "fake", image: "fake:test" } }).where(eq(environments.id, f.lease.environmentId!));
      const environment = environmentService(db), oldTarget = targets.get(f.lease.id)!;
      oldTarget.runner!.syncIn = async operations => {
        for (const operation of operations) for (const file of operation.files) {
          await mkdir(path.dirname(file.targetPath), { recursive: true });
          await cp(file.sourcePath, file.targetPath, { recursive: true, dereference: false });
        }
        return { filesTransferred: operations.reduce((count, operation) => count + operation.files.length, 0), bytesTransferred: 0, operations: [] };
      };
      const executeCommand = oldTarget.runner!.execute;
      const runtime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox",
        acquireRunLease: async input => {
          const lease = await environment.acquireLease({ companyId: input.companyId, environmentId: input.environment.id,
            issueId: input.issueId, heartbeatRunId: input.heartbeatRunId, executionWorkspaceId: input.executionWorkspaceId,
            provider: "fake", providerLeaseId: randomUUID(), leasePolicy: "retain_on_failure",
            metadata: { driver: "sandbox", remoteCwd: nextRemote, agentId: input.agentId } });
          targets.set(lease.id, { ...oldTarget, leaseId: lease.id, remoteCwd: nextRemote,
            runner: { ...oldTarget.runner!, execute: executeCommand },
            sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: lease.providerLeaseId! } });
          return lease;
        },
        releaseRunLease: async input => environment.releaseLease(input.lease.id, input.status, { cleanupStatus: "success",
          remoteExecutionTermination: remoteTerminationReceipt(input.lease, { providerLeaseId: input.lease.providerLeaseId, state: "stopped" }) }),
        resumeRunLease: async ({ lease }) => ({ providerLeaseId: lease.providerLeaseId!, metadata: { remoteCwd: lease.metadata?.remoteCwd } }),
        retryPendingSandboxTeardown: async ({ lease }) => ({ providerLeaseId: lease.providerLeaseId, state: "stopped" }),
        realizeWorkspace: async () => ({ cwd: nextRemote, metadata: { remoteCwd: nextRemote } }),
        execute: async input => executeCommand({ command: input.command, args: input.args, cwd: input.cwd,
          env: input.env, stdin: input.stdin, timeoutMs: input.timeoutMs }),
        resolveCapabilities: async () => classifyEnvironmentCapabilities({ verifiedMethods: [], declared: null, narrowing: null }),
      }] });
      const workProductId = randomUUID(), evidenceRef = `work_product:${workProductId}`;
      await db.insert(issueWorkProducts).values({ id: workProductId, companyId: f.companyId, issueId: f.issueId,
        type: "artifact", provider: "paperclip", title: "Continued saved work", status: "ready_for_review", reviewState: "approved" });
      const inputs: NativeExecutionInput[] = [], startTurn = vi.fn();
      const backendFactory = (execution: NativeExecutionInput): NativeSessionBackend => {
        inputs.push(execution);
        const identity = { companyId: f.companyId, agentId: source.agentId, issueId: f.issueId,
          runId: execution.binding.runId, sessionId: execution.session.normalizedSessionId! };
        const turnId = `turn-${identity.runId}`, result = structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT);
        result.completionClaim.contractRevision = execution.completionContract.contract.revision;
        result.completionClaim.criteria = execution.completionContract.contract.criteria.map(criterion => ({
          ...result.completionClaim.criteria[0]!, criterionId: criterion.id, evidenceRefs: [evidenceRef] }));
        result.evidence = [{ kind: "work_product", ref: evidenceRef }]; result.verification[0]!.artifactRef = evidenceRef;
        let started!: () => void;
        const turnStarted = new Promise<void>(resolve => { started = resolve; });
        const session: NativeSession = {
          identity: () => identity,
          async capabilities() { return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true }; },
          async *events() {
            await turnStarted;
            const current = await run(identity.runId);
            yield { schema: "paperclip.prp.event.v1", sourceEventId: `${identity.runId}:terminal`, sourceSeq: 1,
              sourceInstanceId: current.runnerInstanceId!, sourceKind: "runner", runId: identity.runId,
              normalizedSessionId: identity.sessionId, turnId, eventType: "turn.completed", schemaVersion: 1,
              priority: 0, emittedAt: new Date().toISOString(), payload: {} } satisfies PrpEvent;
          },
          async startTurn(input) {
            expect(execution.provider).toMatchObject({ kind: "codex", model: "gpt-6.1-sol" });
            expect(await readFile(path.join(execution.workspace.cwd!, "saved.txt"), "utf8")).toBe("finished work\n");
            await writeFile(path.join(execution.workspace.cwd!, "continued.txt"), "continued from preserved work\n");
            startTurn(input); started(); return { turnId };
          },
          async result() { await turnStarted; return { result, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, turnId }; },
          async snapshot() { return { backendKind: "mock", sessionId: "recovered-preparation", identity,
            providerSessionId: "recovered-preparation", activeTurnId: null, pendingRuntimeRequests: [], lineage: [], cursor: "1" }; },
          async close() {},
        };
        return { async descriptor() { return { kind: "mock", name: "recovered-preparation", version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }; },
        async openSession() { return session; } };
      };
      const heartbeat = heartbeatService(db, { environmentRuntime: runtime, nativeSessionBackendFactory: backendFactory });
      ownedHeartbeat = heartbeat;
      const resumeTaskRetry = heartbeat.resumeTaskRetry;
      resumeSpy = vi.spyOn(heartbeat, "resumeTaskRetry").mockImplementation((...args) => {
        const pending = resumeTaskRetry(...args);
        retryResumes.push(pending);
        return pending;
      });
      const app = boardRecoveryApp(undefined, heartbeat);
      const gate = new Promise<void>(resolve => { releaseStart = resolve; });
      heldStart = agentStarts.withAgentStartLock(source.agentId, () => gate);
      const receipt = (await request(app).post(`/api/issues/${f.issueId}/retry`)
        .send({ observedRunId: f.runId, idempotencyKey: randomUUID() }).expect(202)).body;
      await expect.poll(() => starts.mock.calls.filter(([agentId]) => agentId === source.agentId).length, { timeout: 10_000 }).toBe(2);
      explicitResume = heartbeat.resumeTaskRetry(f.companyId, receipt.requestId);
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${receipt.requestId}`));
      expect(successors).toHaveLength(1);
      if (unavailableCatalog) {
        const repoUrl = "https://github.com/example/revoked.git";
        await db.insert(executionWorkspaceRepositories).values({ companyId: f.companyId, executionWorkspaceId: f.workspaceId,
          requestedByIssueId: f.issueId, repositoryIdentity: repoUrl, repoUrl, catalogRepositoryId: "revoked-before-dispatch",
          relativePath: taskRepositoryRelativePath(repoUrl), requestKey: randomUUID(), state: "ready", pinnedCommit: f.commit });
      }
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "running")));
      releaseStart!(); await Promise.all([heldStart, explicitResume]);
      await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
      const completed = await run(successors[0].id);
      if (mode === "invalid_published_root") {
        expect(completed).toMatchObject({ status: "failed", runtimeMode: "legacy", errorCode: "setup_failed",
          error: "remote_workspace_published_path_invalid" });
        expect(inputs).toHaveLength(0); expect(startTurn).not.toHaveBeenCalled();
        expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, completed.id))).toHaveLength(0);
        expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
        expect((await run(f.runId)).error).toBe(source.error);
        return;
      }
      if (unavailableCatalog) {
        expect(completed).toMatchObject({ status: "failed", errorCode: "setup_failed",
          error: "Repository access is no longer available; refresh the repository catalog" });
        expect(inputs).toHaveLength(0); expect(startTurn).not.toHaveBeenCalled();
        const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
        expect(await readFile(path.join(workspace.cwd!, "saved.txt"), "utf8")).toBe("finished work\n");
        expect((await run(f.runId)).error).toBe(source.error);
        expect(completed).toMatchObject({ runtimeMode: "legacy", runtimeModeResolvedAt: null, executionStage: "preparing",
          nativeIssueId: null, nativeSessionId: null, usageJson: { ledgerScope: expect.any(Object) },
          resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
        expect(completed.usageJson).toEqual({ ledgerScope: { issueId: f.issueId, projectId: null, billingCode: null } });
        if (withWarning) {
          const [warning] = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, completed.id), eq(heartbeatRunEvents.seq, 1)));
          expect(warning).toMatchObject({ eventType: "agent_observability.unavailable", stream: "system", level: "warn",
            payload: { reason: "unsupported_harness", revision: expect.any(String) }, sourceEventId: null, sourceInstanceId: null });
          if (mode === "catalog_unknown_warning") await db.update(heartbeatRunEvents).set({ payload: { ...warning.payload, reason: "unknown" } }).where(eq(heartbeatRunEvents.id, warning.id));
          if (mode === "catalog_provider_warning") await db.update(heartbeatRunEvents).set({ sourceEventId: randomUUID() }).where(eq(heartbeatRunEvents.id, warning.id));
        }
        await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
        const errors = vi.fn();
        recoveryCoordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: errors });
        recoveryWorker = registerWorkspaceRecoveryWork(db, recoveryCoordinator, runtime, heartbeat.resumeRemoteStopComments);
        await recoveryWorker.ready;
        const retryIntent = { observedRunId: completed.id, idempotencyKey: randomUUID() };
        const retry = (await request(app).post(`/api/issues/${f.issueId}/retry`).send(retryIntent).expect(202)).body;
        const resumed = () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
          sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${retry.requestId}`));
        await expect.poll(async () => await hasVerifiedWorkspaceRepair(db, await run(completed.id)), { timeout: 20_000 }).toBe(true);
        if (mode === "catalog_unknown_warning" || mode === "catalog_provider_warning") {
          await heartbeat.resumeTaskRetry(f.companyId, retry.requestId);
          expect(await resumed()).toHaveLength(0); expect(startTurn).not.toHaveBeenCalled();
          return;
        }
        await expect.poll(async () => (await resumed()).length, { timeout: 20_000 }).toBe(1);
        const [continuation] = await resumed();
        expect(continuation).toMatchObject({ status: "queued", contextSnapshot: { previousRunId: completed.id,
          taskRetryRequestId: retry.requestId } });
        expect(await readFreshWorkspaceReadiness(db, continuation)).toMatchObject({ mode: "resume_preserved_workspace" });
        expect((await request(app).post(`/api/issues/${f.issueId}/retry`).send(retryIntent).expect(202)).body.requestId).toBe(retry.requestId);
        expect(await resumed()).toHaveLength(1); expect(startTurn).not.toHaveBeenCalled();
        expect(errors).not.toHaveBeenCalled();
        return;
      }
      expect({ status: completed.status, error: completed.error, runtimeMode: completed.runtimeMode })
        .toEqual({ status: "succeeded", error: null, runtimeMode: "native" });
      expect(inputs).toHaveLength(1); expect(startTurn).toHaveBeenCalledOnce();
      expect(path.basename(path.dirname(inputs[0].workspace.cwd!))).toBe(".paperclip-workspaces");
      expect(completed.runnerProfileJson?.nativeExecutionInput).toMatchObject({ provider: { kind: "codex", model: "gpt-6.1-sol" } });
      expect(await readFile(path.join(inputs[0].workspace.cwd!, "continued.txt"), "utf8")).toBe("continued from preserved work\n");
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, completed.id)))
        .toEqual([expect.objectContaining({ schemaStatus: "accepted" })]);
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("done");
      expect((await request(app).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body.entries).toEqual([]);
      expect((await request(app).get(`/api/issues/${f.issueId}`).expect(200)).body.interruption)
        .toMatchObject({ state: "resolved", canRetry: false });
      await heartbeat.resumeTaskRetry(f.companyId, receipt.requestId); expect(startTurn).toHaveBeenCalledOnce();
      expect((await run(f.runId)).error).toBe(source.error);
    } finally {
      try {
        releaseStart?.(); await Promise.allSettled([heldStart, explicitResume, ...retryResumes]);
        await recoveryCoordinator?.stop(); await recoveryWorker?.stop();
        await ownedHeartbeat?.drainActiveRunExecutions();
      } finally {
        resumeSpy?.mockRestore(); starts.mockRestore();
        storage?.mockRestore();
        if (databaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = databaseUrl;
        if (masterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY; else process.env.PAPERCLIP_SECRETS_MASTER_KEY = masterKey;
        await instanceSettingsService(db).updateExperimental(experimental);
      }
    }
  }, 40_000);

  it.each(["shutdown", "lease"] as const)("admits HTTP Retry once after an interrupted Runner preparation recovers its remote workspace (%s)", async interruption => {
    const f = await interruptedRemotePreparation(interruption);
    await recoverRetainedWorkspace(f.input);
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
    const intent = { observedRunId: f.runId, idempotencyKey: randomUUID() };
    const app = boardRecoveryApp();
    const receipt = (await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body;
    const heartbeat = heartbeatService(db);
    await Promise.all([heartbeat.resumeTaskRetry(f.companyId, receipt.requestId),
      heartbeat.resumeTaskRetry(f.companyId, receipt.requestId)]);
    expect((await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body.requestId).toBe(receipt.requestId);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      eq(heartbeatRuns.status, "queued")));
    expect(successors).toHaveLength(1);
    expect(successors[0].contextSnapshot).toMatchObject({ previousRunId: f.runId });
    expect(await readFreshWorkspaceReadiness(db, successors[0])).toMatchObject({ mode: "resume_preserved_workspace" });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect((await run(f.runId)).status).toBe("interrupted");
    const remote = (await run(f.runId)).runnerProfileJson!.remoteWorkspace as { snapshotId: string };
    const saved = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId: f.workspaceId,
      snapshotId: remote.snapshotId });
    try { expect(await readFile(path.join(saved.root, "saved.txt"), "utf8")).toBe("finished work\n"); }
    finally { await saved.cleanup(); }
  }, 30_000);

  it.each([false, true].flatMap(alreadyRecovered => (["shutdown", "lease"] as const).map(interruption => ({ alreadyRecovered, interruption }))))(
    "automatically retries interrupted preparation after preservation ($interruption, startup=$alreadyRecovered)", async ({ alreadyRecovered, interruption }) => {
    const f = await interruptedRemotePreparation(interruption);
    if (alreadyRecovered) await recoverRetainedWorkspace(f.input);
    const restarted = createDb(connectionString);
    try {
      const heartbeat = heartbeatService(restarted);
      await Promise.all(await reconcileRetainedWorkspaces(restarted, f.environmentRuntime,
        heartbeat.resumeRemoteStopComments, true) ?? []);
      await Promise.all([heartbeat.resumeRemoteStopComments(await run(f.runId)),
        heartbeat.resumeRemoteStopComments(await run(f.runId))]);
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        eq(heartbeatRuns.retryOfRunId, f.runId)));
      expect(successors).toHaveLength(1);
      expect(successors[0]).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("in_progress");
      expect((await run(f.runId)).status).toBe("interrupted");
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
    } finally { await restarted.$client.end(); }
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
      await heartbeatService(db).resumeTaskRetry(f.companyId, retry.requestId!);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, retry.requestId!)))[0])
        .toMatchObject({ status: "deferred_issue_execution", payload: { executionWait: { reason: "remote_cleanup" } } });
      await environmentService(db).releaseLease(settledLease.id, "released", { cleanupStatus: "success",
        remoteExecutionTermination: remoteTerminationReceipt(settledLease, { providerLeaseId: settledLease.providerLeaseId, state: "destroyed" }) });
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

  async function warmHandoffSource(hops = 1, beforeStop?: (lease: typeof environmentLeases.$inferSelect) => Promise<void>) {
    const prior = await seed("native", true, "keep_running", true), source = await run(prior.runId);
    let previousTarget = targets.get(prior.lease.id)!, previousLeaseId = prior.lease.id;
    let previousRunId: string = prior.runId;
    let lease = prior.lease, current = source;
    const leaseIds = [previousLeaseId];
    for (let hop = 0; hop < hops; hop++) {
      expect(await resumeNativeWorkspaceSync({ db, runId: previousRunId, target: previousTarget })).toBe(true);
      await db.update(heartbeatRuns).set({ status: "succeeded", errorCode: null, resultJson: null }).where(eq(heartbeatRuns.id, previousRunId));
      await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, previousRunId));
      await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, prior.actionId));
      await environmentService(db).releaseLease(previousLeaseId, "released", { cleanupStatus: "success" });
      const [released] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, previousLeaseId));
      [current] = await db.insert(heartbeatRuns).values({ companyId: prior.companyId, agentId: source.agentId,
        issueId: prior.issueId, nativeIssueId: prior.issueId, runtimeMode: "native", status: "cancelled", finishedAt: new Date(),
        contextSnapshot: { issueId: prior.issueId } }).returning();
      await db.insert(nativeRunFinalizations).values({ companyId: prior.companyId, issueId: prior.issueId, runId: current.id, phase: "terminal_failure" });
      const acquired = await environmentService(db).acquireLease({ companyId: prior.companyId, environmentId: prior.lease.environmentId!,
        issueId: prior.issueId, heartbeatRunId: current.id, provider: "daytona", providerLeaseId: prior.providerLeaseId,
        leasePolicy: "reuse_by_environment", replacesReusableLeaseId: previousLeaseId,
        metadata: { ...released.metadata, sandboxLeaseAcquisition: { outcome: "resumed" } } });
      [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, acquired.id));
      const target = { ...previousTarget, leaseId: lease.id, sandboxLeaseAcquisition: { outcome: "resumed" as const, providerLeaseId: prior.providerLeaseId } };
      targets.set(lease.id, target);
      expect(await prepareNativeWorkspaceSync({ db, companyId: prior.companyId, workspaceId: prior.issueId,
        workspaceLocalDir: prior.host, runId: current.id, lease: lease as EnvironmentLease, target, resourceDisposition: "keep_running" })).not.toBeNull();
      leaseIds.push(lease.id); previousRunId = current.id; previousLeaseId = lease.id; previousTarget = target;
    }
    [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
    await beforeStop?.(lease);
    await writeFile(path.join(prior.remote, "after-warm-stop.txt"), "stopped turn work\n");
    await recordRequiredWorkspaceRestoreFailure(db, await run(current.id), { workspaceRestoreFailure: "restore_failed" }, lease);
    const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, prior.companyId),
      eq(issueRecoveryActions.fingerprint, `native-workspace:${current.id}`)));
    const [retained] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
    const stopping = readStopOnlyCleanup(retained) ? retained : await prepareSandboxStopAndRetain(db, retained);
    expect(stopping).not.toBeNull();
    expect(await settleStopOnlyCleanup(db, stopping!, { attemptId: String(stopping!.metadata!.pendingCleanupAttemptId),
      receipt: { providerLeaseId: prior.providerLeaseId, state: "stopped" } })).not.toBeNull();
    return { ...prior, priorRunId: prior.runId, priorLeaseId: prior.lease.id, leaseIds, runId: current.id, lease, actionId: action.id,
      input: { ...prior.input, runId: current.id, actionId: action.id } };
  }

  describe("verified warm allocation handoffs", () => {
    let original: { db: typeof db; root: string; connectionString: string; home: string | undefined };
    let isolated: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
    let isolatedDb: typeof db | undefined;
    let isolatedRoot: string | undefined;
    beforeAll(async () => {
      original = { db, root, connectionString, home: process.env.PAPERCLIP_HOME };
      const external = resolveExternalTestDatabaseUrl("PAPERCLIP_WORKSPACE_RECOVERY_HANDOFF_TEST_DATABASE_URL");
      if (external) {
        await applyPendingMigrations(external);
        isolated = { connectionString: external, cleanup: async () => {} };
      } else isolated = await startEmbeddedPostgresTestDatabase("workspace-warm-handoff-");
      isolatedDb = createDb(isolated.connectionString);
      if (external) await isolatedDb.execute(sql`TRUNCATE TABLE companies CASCADE`);
      isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "workspace-warm-handoff-files-"));
      db = isolatedDb; root = isolatedRoot; connectionString = isolated.connectionString;
      process.env.PAPERCLIP_HOME = path.join(root, "home");
    }, 30_000);
    afterAll(async () => {
      await isolatedDb?.$client.end(); await isolated?.cleanup();
      if (isolatedRoot) await rm(isolatedRoot, { recursive: true, force: true });
      if (original) {
        db = original.db; root = original.root; connectionString = original.connectionString;
        if (original.home === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = original.home;
      }
    });
  it.each([{ hops: 1, snapshot: false }, { hops: 2, snapshot: false }, { hops: 2, snapshot: true }])(
    "settles adopted warm source history: $hops handoffs, snapshot=$snapshot", async ({ hops, snapshot }) => {
      const f = await failedWarmSource(false, hops);
      if (snapshot) {
        const runner = targets.get(f.lease.id)!.runner!;
        runner.syncIn = async () => ({ filesTransferred: 0, bytesTransferred: 0, operations: [] });
        runner.syncOut = async operations => {
          for (const operation of operations) for (const file of operation.files)
            await cp(file.sourcePath, file.targetPath, { recursive: true, dereference: false });
          return { filesTransferred: 2, bytesTransferred: 0, operations: [] };
        };
        await rm(path.join(nativeWorkspaceSyncStateRoot(), f.runId), { recursive: true });
      }
      await recoverRetainedWorkspace(f.input);
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      expect(lease).toMatchObject({ status: "released", cleanupStatus: "success",
        leasePolicy: snapshot ? "retain_on_failure" : "reuse_by_environment" });
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(!snapshot);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.retry.requestId!)))[0])
        .toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(f.runtime.resumeRunLease).toHaveBeenCalledOnce();
      if (snapshot) {
        const state = readSystemRecovery((await action(f.actionId)).evidence)!;
        expect(await verifiedWorkspaceSnapshotReceipt(db, { companyId: f.companyId, issueId: f.issueId,
          runId: f.runId, actionId: f.actionId, operationIds: state.preservationOperationIds })).not.toBeNull();
        expect(lease.metadata?.nativeSourceRetention).toMatchObject({ settlement: "snapshot_retained" });
      } else expect(await readFile(path.join(f.host, "after-warm-stop.txt"), "utf8")).toBe("stopped turn work\n");
    }, 30_000);

  it("keeps adopted warm history held when a predecessor changes after export", async () => {
    const f = await failedWarmSource(false, 1);
    const history = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, f.companyId),
      eq(environmentLeases.providerLeaseId, f.providerLeaseId)));
    const predecessor = history.find(lease => lease.id !== f.lease.id)!;
    const stop = f.runtime.retryPendingSandboxTeardown.getMockImplementation()!;
    f.runtime.retryPendingSandboxTeardown.mockImplementationOnce(async input => {
      const receipt = await stop(input);
      await db.update(environmentLeases).set({ status: "active" }).where(eq(environmentLeases.id, predecessor.id));
      return receipt;
    });
    await recoverRetainedWorkspace(f.input);
    const state = readSystemRecovery((await action(f.actionId)).evidence)!;
    expect(state.state).not.toBe("complete");
    expect(state.failure?.code).toBe("allocation_ownership_ambiguous");
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0].leasePolicy).toBe("retain_on_failure");
    expect(await readFile(path.join(f.host, "after-warm-stop.txt"), "utf8")).toBe("stopped turn work\n");
  }, 30_000);

  it.each([1, 2])("recovers a stopped native source after %s verified warm predecessor handoffs", async hops => {
    const f = await warmHandoffSource(hops);
    expect((await run(f.priorRunId)).runnerProfileJson?.nativeWorkspaceSync).toMatchObject({ state: "finalized", leaseId: f.priorLeaseId });
    const [previous] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.priorLeaseId));
    expect(previous).toMatchObject({ status: "expired", cleanupStatus: "success", providerLeaseId: f.providerLeaseId });
    await recoverRetainedWorkspace(f.input);
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
    expect(await readFile(path.join(f.host, "after-warm-stop.txt"), "utf8")).toBe("stopped turn work\n");
    const source = await run(f.runId), freshProviderLeaseId = randomUUID();
    const [fresh] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, runtimeMode: "native", status: "succeeded", finishedAt: new Date() }).returning();
    const remoteCwd = path.join(root, fresh.id, "remote");
    const freshLease = await environmentService(db).acquireLease({ companyId: f.companyId, environmentId: f.lease.environmentId!,
      issueId: f.issueId, heartbeatRunId: fresh.id, provider: "daytona", providerLeaseId: freshProviderLeaseId,
      metadata: { ...f.lease.metadata, remoteCwd } });
    const freshTarget = { ...targets.get(f.lease.id)!, leaseId: freshLease.id, remoteCwd,
      sandboxLeaseAcquisition: { outcome: "created" as const, providerLeaseId: freshProviderLeaseId } };
    expect(await prepareNativeWorkspaceSync({ db, companyId: f.companyId, workspaceId: f.issueId,
      workspaceLocalDir: f.host, runId: fresh.id, lease: freshLease, target: freshTarget, resourceDisposition: "keep_running" })).not.toBeNull();
    expect(await resumeNativeWorkspaceSync({ db, runId: fresh.id, target: freshTarget })).toBe(true);
    expect(await inspectWorkspaceSource(db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId, actionId: f.actionId }))
      .toMatchObject({ status: "verified" });
  }, 30_000);

  it.each(["active", "active_run", "active_control", "foreign_company", "environment", "workspace", "task", "agent", "unfinalized", "owner", "missing_proof", "conflicting_proof", "dangling_proof", "extra_history"])(
    "keeps ambiguous warm source history fenced: %s", async fault => {
      const f = await warmHandoffSource();
      const [previous] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.priorLeaseId));
      if (fault === "active") await db.update(environmentLeases).set({ status: "active" }).where(eq(environmentLeases.id, previous.id));
      if (fault === "active_run") await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.priorRunId));
      if (fault === "active_control") adapterExecutionControls.set(f.priorRunId, createAdapterExecutionControl());
      if (fault === "foreign_company") {
        const [foreign] = await db.insert(companies).values({ name: "Foreign owner", issuePrefix: `F${randomUUID().slice(0, 6)}` }).returning();
        await db.update(environmentLeases).set({ companyId: foreign.id }).where(eq(environmentLeases.id, previous.id));
      }
      if (fault === "environment") {
        const [other] = await db.insert(environments).values({ name: randomUUID(), driver: "sandbox" }).returning();
        await db.update(environmentLeases).set({ environmentId: other.id }).where(eq(environmentLeases.id, previous.id));
      }
      if (fault === "workspace") {
        const [other] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, mode: "isolated_workspace", strategyType: "test", name: "Other workspace" }).returning();
        await db.update(environmentLeases).set({ executionWorkspaceId: other.id }).where(eq(environmentLeases.id, previous.id));
      }
      if (fault === "task") {
        const [other] = await db.insert(issues).values({ companyId: f.companyId, title: "Other task" }).returning();
        await db.update(environmentLeases).set({ issueId: other.id }).where(eq(environmentLeases.id, previous.id));
      }
      if (fault === "agent") {
        const [other] = await db.insert(agents).values({ companyId: f.companyId, name: "Other agent", adapterType: "paperclip_runner" }).returning();
        await db.update(heartbeatRuns).set({ agentId: other.id }).where(eq(heartbeatRuns.id, f.priorRunId));
      }
      if (fault === "unfinalized") {
        const prior = await run(f.priorRunId), reference = prior.runnerProfileJson!.nativeWorkspaceSync as Record<string, unknown>;
        await db.update(heartbeatRuns).set({ runnerProfileJson: { ...prior.runnerProfileJson, nativeWorkspaceSync: { ...reference, state: "prepared", finalHostSha256: null } } }).where(eq(heartbeatRuns.id, prior.id));
      }
      if (fault === "owner") await db.update(nativeRunFinalizations).set({ leaseOwner: randomUUID() }).where(eq(nativeRunFinalizations.runId, f.priorRunId));
      if (fault === "missing_proof") {
        const metadata = { ...previous.metadata }; delete metadata.reusableLeaseSuccessor;
        await db.update(environmentLeases).set({ metadata }).where(eq(environmentLeases.id, previous.id));
      }
      if (fault === "conflicting_proof") await db.update(environmentLeases).set({ metadata: { ...previous.metadata,
        reusableLeaseSuccessor: { ...(previous.metadata!.reusableLeaseSuccessor as Record<string, unknown>), successorRunId: randomUUID() } } }).where(eq(environmentLeases.id, previous.id));
      if (fault === "dangling_proof") await db.update(environmentLeases).set({ metadata: { ...previous.metadata, reusableLeasePredecessor: {} } }).where(eq(environmentLeases.id, previous.id));
      if (fault === "extra_history") await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: previous.environmentId,
        heartbeatRunId: f.priorRunId, issueId: f.issueId, provider: "daytona", providerLeaseId: f.providerLeaseId,
        status: "expired", leasePolicy: "reuse_by_environment", cleanupStatus: "success", metadata: previous.metadata });
      try {
        expect(await inspectWorkspaceSource(db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId, actionId: f.actionId }))
          .toMatchObject({ status: "blocked", failureCode: "allocation_ownership_ambiguous" });
        await expect(readFile(path.join(f.host, "after-warm-stop.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally { adapterExecutionControls.get(f.priorRunId)?.finish(); adapterExecutionControls.delete(f.priorRunId); }
    }, 30_000);

  it("keeps server handoff receipts across metadata updates and same-run reacquisition", async () => {
    const f = await warmHandoffSource(1, async lease => {
      const proof = lease.metadata!.reusableLeasePredecessor;
      expect(proof).toMatchObject({ schema: "paperclip.reusable-lease-handoff.v1", successorLeaseId: lease.id });
      const forged = { schema: "forged-provider-metadata" };
      const updated = await environmentService(db).updateLeaseMetadata(lease.id, { ...lease.metadata,
        reusableLeasePredecessor: forged, reusableLeaseSuccessor: forged, marker: "updated" });
      expect(updated!.metadata?.reusableLeasePredecessor).toEqual(proof);
      expect(updated!.metadata?.reusableLeaseSuccessor).toBeUndefined();
      await environmentService(db).releaseLease(lease.id, "released", { cleanupStatus: "success" });
      const reacquired = await environmentService(db).acquireLease({ companyId: lease.companyId, environmentId: lease.environmentId!,
        issueId: lease.issueId, heartbeatRunId: lease.heartbeatRunId, provider: lease.provider, providerLeaseId: lease.providerLeaseId,
        leasePolicy: "reuse_by_environment", reusesReusableLeaseId: lease.id,
        metadata: { ...updated!.metadata, reusableLeasePredecessor: forged, reusableLeaseSuccessor: forged } });
      expect(reacquired.id).toBe(lease.id);
      expect(reacquired.metadata?.reusableLeasePredecessor).toEqual(proof);
      expect(reacquired.metadata?.reusableLeaseSuccessor).toBeUndefined();
    });
    await recoverRetainedWorkspace(f.input);
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
  }, 30_000);

  it("does not manufacture handoff authority from injected fresh or orphan lease metadata", async () => {
    const f = await warmHandoffSource(), source = await run(f.runId);
    const forged = { schema: "paperclip.reusable-lease-handoff.v1", successorLeaseId: f.lease.id };
    const values = { companyId: f.companyId, environmentId: f.lease.environmentId!, issueId: f.issueId,
      heartbeatRunId: source.id, provider: "daytona", providerLeaseId: randomUUID(),
      metadata: { agentId: source.agentId, reusableLeasePredecessor: forged, reusableLeaseSuccessor: forged } };
    const fresh = await environmentService(db).acquireLease(values);
    const orphan = await environmentService(db).insertPendingCleanupLease({ ...values, providerLeaseId: randomUUID(), failureReason: "test" });
    for (const lease of [fresh, orphan]) {
      expect(lease.metadata?.reusableLeasePredecessor).toBeUndefined();
      expect(lease.metadata?.reusableLeaseSuccessor).toBeUndefined();
    }
  }, 30_000);

  it("rolls back both handoff links and keeps provider mismatches or retained sources fenced", async () => {
    const f = await warmHandoffSource(), source = await run(f.runId), service = environmentService(db);
    const values = { companyId: f.companyId, environmentId: f.lease.environmentId!, issueId: f.issueId,
      heartbeatRunId: f.priorRunId, provider: "daytona", providerLeaseId: randomUUID(),
      leasePolicy: "reuse_by_environment" as const, metadata: { agentId: source.agentId } };
    const prior = await service.acquireLease(values);
    await service.releaseLease(prior.id, "released", { cleanupStatus: "success" });
    const [before] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, prior.id));
    const rollback = new Error("rollback_handoff");
    await expect(db.transaction(async tx => {
      const acquired = await environmentService(tx as unknown as typeof db).acquireLease({ ...values, heartbeatRunId: f.runId, replacesReusableLeaseId: prior.id });
      expect(acquired.metadata?.reusableLeasePredecessor).toMatchObject({ previousLeaseId: prior.id, successorLeaseId: acquired.id });
      throw rollback;
    })).rejects.toBe(rollback);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, prior.id)))[0]).toEqual(before);
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.providerLeaseId, values.providerLeaseId))).toHaveLength(1);
    await expect(service.acquireLease({ ...values, heartbeatRunId: f.runId, provider: "foreign-provider", replacesReusableLeaseId: prior.id })).rejects.toThrow("ownership changed");
    await expect(service.acquireLease({ ...values, providerLeaseId: f.providerLeaseId, replacesReusableLeaseId: f.lease.id })).rejects.toThrow("ownership changed");
    const [later] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, issueId: f.issueId,
      nativeIssueId: f.issueId, runtimeMode: "native", status: "succeeded", finishedAt: new Date() }).returning();
    await service.acquireLease({ ...values, heartbeatRunId: later.id, providerLeaseId: f.providerLeaseId });
    expect(await inspectWorkspaceSource(db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId, actionId: f.actionId }))
      .toMatchObject({ status: "blocked", failureCode: "allocation_ownership_ambiguous" });
  }, 30_000);

  });

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

  it("reconstructs a resolved files-only preservation obligation at startup without replay", async () => {
    const f = await seed("legacy");
    await adoptSystemRecovery(db, f);
    const before = await action(f.actionId);
    const automaticRecovery = { policy: "preserve_without_replay_v1", runId: f.runId, replay: "blocked" };
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "blocked",
      evidence: { ...before.evidence, automaticRecovery } }).where(eq(issueRecoveryActions.id, f.actionId));
    const errors = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: errors });
    const worker = registerWorkspaceRecoveryWork(db, coordinator, f.environmentRuntime, async () => {});
    try {
      await worker.ready;
      await expect.poll(async () => readSystemRecovery((await action(f.actionId)).evidence)?.state,
        { timeout: 20_000 }).toBe("complete");
      expect((await action(f.actionId)).evidence.automaticRecovery).toEqual(automaticRecovery);
      expect(f.runtime.resumeRunLease.mock.calls.filter(([input]) => input.lease.id === f.lease.id)).toHaveLength(1);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
      expect(errors).not.toHaveBeenCalled();
    } finally { await coordinator.stop(); await worker.stop(); }
  }, 30_000);

  it("fills a free export slot across the candidate cursor while another export is held and joins both at shutdown", async () => {
    const orderedSeed = async (position: number) => {
      const fixture = await seed();
      const id = `00000002-000${position}-4000-8000-${randomUUID().slice(-12)}` as const;
      await db.update(issueRecoveryActions).set({ id }).where(eq(issueRecoveryActions.id, fixture.actionId));
      fixture.actionId = id; fixture.input.actionId = id;
      return fixture;
    };
    const held = await orderedSeed(2);
    const fixtures = [held];
    const runtimeFor = (runId: string) => fixtures.find(fixture => fixture.runId === runId)!.environmentRuntime;
    const runtime = { ...held.environmentRuntime,
      resumeWorkspaceRecoveryLease: (input: Parameters<typeof held.environmentRuntime.resumeWorkspaceRecoveryLease>[0]) =>
        runtimeFor(input.source.runId).resumeWorkspaceRecoveryLease(input),
      retryPendingSandboxTeardown: (input: Parameters<typeof held.environmentRuntime.retryPendingSandboxTeardown>[0]) =>
        runtimeFor(input.lease.heartbeatRunId!).retryPendingSandboxTeardown(input),
    };
    let active = 0, maximum = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const countExport = (fixture: typeof held, pause = false) => {
      const resume = fixture.runtime.resumeRunLease.getMockImplementation()!;
      fixture.runtime.resumeRunLease.mockImplementation(async input => {
        active += 1; maximum = Math.max(maximum, active);
        try { if (pause) await gate; return await resume(input); } finally { active -= 1; }
      });
    };
    countExport(held, true);
    const errors = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: errors });
    const worker = registerWorkspaceRecoveryWork(db, coordinator, runtime, async () => {});
    try {
      await expect.poll(() => held.runtime.resumeRunLease.mock.calls.length, { timeout: 20_000 }).toBe(1);
      // Start the middle candidate only after the highest candidate occupies
      // one slot. The next producer then sorts before that saved cursor.
      const fast = await orderedSeed(1); fixtures.push(fast); countExport(fast);
      await requestTaskRetry({ db, companyId: fast.companyId, issueId: fast.issueId, actorId: "board",
        observedRunId: fast.runId, idempotencyKey: randomUUID() });
      await expect.poll(async () => readSystemRecovery((await action(fast.actionId)).evidence)?.state,
        { timeout: 20_000 }).toBe("complete");
      const third = await orderedSeed(0); fixtures.push(third); countExport(third);
      await requestTaskRetry({ db, companyId: third.companyId, issueId: third.issueId, actorId: "board",
        observedRunId: third.runId, idempotencyKey: randomUUID() });
      await expect.poll(async () => readSystemRecovery((await action(third.actionId)).evidence)?.state,
        { timeout: 20_000 }).toBe("complete");
      expect(readSystemRecovery((await action(held.actionId)).evidence)?.state).toBe("running");
      expect(maximum).toBeLessThanOrEqual(2);
      expect(await readFile(path.join(third.host, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, third.companyId))).toHaveLength(1);
      let stopped = false;
      const stopping = Promise.all([coordinator.stop(), worker.stop()]).then(() => { stopped = true; });
      await Promise.resolve(); expect(stopped).toBe(false);
      release(); await stopping;
      expect(readSystemRecovery((await action(held.actionId)).evidence)?.state).toBe("complete");
      expect(errors).not.toHaveBeenCalled();
    } finally { release(); await coordinator.stop(); await worker.stop(); }
  }, 60_000);

  it("rotates past due sources whose physical locks belong to other workers", async () => {
    const blocked = [await seed(), await seed()], available = await seed();
    for (const [index, fixture] of [...blocked, available].entries()) {
      await adoptSystemRecovery(db, fixture);
      const id = `00000001-000${index}-4000-8000-${randomUUID().slice(-12)}` as const;
      await db.update(issueRecoveryActions).set({ id }).where(eq(issueRecoveryActions.id, fixture.actionId));
      fixture.actionId = id; fixture.input.actionId = id;
    }
    let unlock!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const held = blocked.map(fixture => {
      let ready!: () => void;
      const acquired = new Promise<void>(resolve => { ready = resolve; });
      const lock = db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${nativeWorkspaceFinalizationLockKey(fixture.companyId, fixture.runId)}, 0))`);
        ready(); await gate;
      });
      return { acquired, lock };
    });
    try {
      await Promise.all(held.map(item => item.acquired));
      await Promise.all(await reconcileRetainedWorkspaces(db, available.environmentRuntime, async () => {}, true) ?? []);
      expect(blocked.every(fixture => fixture.runtime.resumeRunLease.mock.calls.length === 0)).toBe(true);
      await Promise.all(await reconcileRetainedWorkspaces(db, available.environmentRuntime, async () => {}, true) ?? []);
      expect(readSystemRecovery((await action(available.actionId)).evidence)?.state).toBe("complete");
      expect(await readFile(path.join(available.host, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(blocked.every(fixture => fixture.runtime.resumeRunLease.mock.calls.length === 0)).toBe(true);
    } finally { unlock(); await Promise.all(held.map(item => item.lock)); }
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

  it("adopts only the exact historical infrastructure notice, preserving prose and user-action notices", async () => {
    const f = await seed("legacy", false);
    const metadata = { version: 1 as const, sourceRunId: f.runId,
      sections: [{ rows: [{ type: "key_value" as const, label: "Recovery action", value: f.actionId }] }] };
    const base = { companyId: f.companyId, issueId: f.issueId, body: "Original technical history",
      authorType: "system" as const, presentation: { kind: "system_notice" as const, tone: "danger" as const,
        title: "Recovery needs attention", detailsDefaultOpen: false }, metadata };
    const comments = await db.insert(issueComments).values([
      base,
      { ...base, authorType: "user", authorUserId: "board" },
      { ...base, metadata: { ...metadata, sourceRunId: randomUUID() } },
      { ...base, metadata: { ...metadata, recoveryResponsibility: "user" as const } },
    ]).returning();
    await adoptSystemRecovery(db, f);
    await adoptSystemRecovery(db, f);
    const rows = await db.select().from(issueComments).where(eq(issueComments.companyId, f.companyId));
    expect(rows.find(row => row.id === comments[0].id)?.metadata?.recoveryResponsibility).toBe("system");
    for (const original of comments.slice(1)) {
      expect(rows.find(row => row.id === original.id)?.metadata).toEqual(original.metadata);
    }
    expect(rows.every(row => row.body === base.body)).toBe(true);
  });

  async function makeRetryDue(actionId: string) {
    const current = await action(actionId);
    const state = readSystemRecovery(current.evidence)!;
    await db.update(issueRecoveryActions).set({ evidence: { ...current.evidence,
      systemRecovery: { ...state, nextAttemptAt: 0 } } }).where(eq(issueRecoveryActions.id, actionId));
  }

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
        : { code: "provider_unavailable", retryClass: "retry_transient" } });
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
    // Older queued input is not a new direction and must not undo the Stop.
    if (!sentAfterStop) await db.update(heartbeatRuns).set({ finishedAt: new Date(redirect.createdAt.getTime() + 1_000) })
      .where(eq(heartbeatRuns.id, f.runId));
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

  it("reaches its queued snapshot-only reset after earlier recovery candidates without starting agent work", async () => {
    const previous = db;
    db = createDb(connectionString);
    try { await exerciseQueuedReset(false, false, undefined, true); }
    finally { await db.$client.end(); db = previous; }
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
