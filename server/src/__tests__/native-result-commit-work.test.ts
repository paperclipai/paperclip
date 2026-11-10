import { cancelNativeSession } from "../services/native-runtime/native-session-executor.js";
import { dispatchPendingNativeStatusEffects } from "../services/native-runtime/status-decision-committer.js";
import { reconcileNativeFinalizations } from "../services/native-runtime/native-finalization-reconciler.js";
import { notifyNativeResultCommit } from "../services/native-result-commit-notifications.js";
import { notifyNativeFinalizationWork } from "../services/native-finalization-notifications.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, createDb, heartbeatRuns, issues, nativeRunFinalizations,
  statusDecisionEffects, statusDecisions, workspaceOperations, type Db } from "@paperclipai/db";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { nativeResultCommitWork } from "../services/native-runtime/native-result-commit-work.js";
import { finalizeNativeRun, NativeFinalizationDeferredError } from "../services/native-runtime/native-run-finalizer.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { NativeRunCoordinatorStore } from "../services/native-runtime/native-run-coordinator-store.js";
import { workspaceOperationService } from "../services/workspace-operations.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

describe("accepted result commit lifecycle", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db, root: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let worker: ReturnType<ReturnType<typeof nativeResultCommitWork>["register"]> | undefined;
  const companyId = randomUUID(), agentId = randomUUID();
  const priorLogs = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
  let admitted = true;
  const errors: unknown[] = [];
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "native-result-commit-"));
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = root;
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_RESULT_COMMIT_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("native-result-commit-");
    db = createDb(external ?? temporary!.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Result commits", issuePrefix: `RC${randomUUID().slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Result worker", adapterType: "paperclip_runner" });
  }, 30_000);
  beforeEach(() => {
    admitted = true; errors.length = 0;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined; worker = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.companyId, companyId));
    expect(errors).toEqual([]);
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); await rm(root, { recursive: true, force: true });
    if (priorLogs === undefined) delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    else process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = priorLogs;
  });
  async function start(finalize = finalizeNativeRun) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted, canReconcile: () => admitted,
      onError: error => errors.push(error) });
    worker = nativeResultCommitWork(db, finalize).register(coordinator, () => admitted);
    await worker.ready;
  }
  async function flush() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0);
      expect(coordinator!.nextWakeAt()).toBeNull();
    }, { timeout: 15_000 });
  }
  async function quiet() {
    const previous = db.$client.options.debug;
    const queries: string[] = [];
    db.$client.options.debug = (_id, query) => { queries.push(query); };
    try { await vi.advanceTimersByTimeAsync(120_000); await delay(10); expect(queries).toEqual([]); }
    finally { db.$client.options.debug = previous; }
  }
  async function seed() {
    const runId = randomUUID(), issueId = randomUUID(), contractId = randomUUID(), sourceInstanceId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Commit accepted work", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "result-worker-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "result-worker-v1", objective: "Finish", criteria: [{ id: "objective", requirement: "Complete the task" }] },
      canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: "native", status: "running",
      nativeIssueId: issueId, nativeSessionId: runId, runnerInstanceId: sourceInstanceId,
      completionContractId: contractId, completionContractSha256: contractId, contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    return { companyId, issueId, runId, agentId, sessionId: runId, completionContractId: contractId,
      completionContractSha256: contractId, sourceInstanceId, controlPlaneSourceInstanceId: "result-worker-test" };
  }
  async function complete(binding: Awaited<ReturnType<typeof seed>>, producer: "control_plane" | "coordinator", writer: Db = db) {
    const port = producer === "control_plane" ? new PaperclipControlPlanePort(writer, binding)
      : new NativeRunCoordinatorStore(writer, { ...binding, normalizedSessionId: binding.sessionId,
        runnerSourceInstanceId: binding.sourceInstanceId,
        completionContractRevision: CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.contractRevision,
        completionContractCriterionIds: CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.criteria.map(item => item.criterionId) });
    await port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: `${binding.runId}:result` });
  }
  async function barrier(binding: Awaited<ReturnType<typeof seed>>) {
    await workspaceOperationService(db).createRecorder({ companyId, issueId: binding.issueId, heartbeatRunId: binding.runId })
      .recordOperation({ phase: "workspace_finalize", cwd: root, run: async () => ({ status: "succeeded", exitCode: 0 }) });
  }
  async function state(runId: string) {
    return db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)).then(rows => rows[0]);
  }
  it.each(["restore", "worktree"])("respects %s suppression and reactivation through heartbeat", async mode => {
    const binding = await seed(); await complete(binding, "control_plane"); await barrier(binding);
    const runtimeEnv = mode === "restore" ? { PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "true" }
      : { PAPERCLIP_IN_WORKTREE: "true", PAPERCLIP_INSTANCE_ID: "result-suppression-test" };
    const settings = instanceSettingsService(db, { runtimeEnv });
    if (mode === "worktree") await settings.updateExperimental({ enableWorktreeRunExecution: false });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted, canReconcile: () => admitted,
      onError: error => errors.push(error) });
    worker = heartbeatService(db, { runtimeEnv }).registerNativeResultCommitWork(coordinator, () => admitted);
    await worker.ready; await flush(); await quiet();
    expect((await state(binding.runId)).phase).not.toBe("committed");
    if (mode === "worktree") {
      try {
        await settings.updateExperimental({ enableWorktreeRunExecution: true });
        await flush(); expect((await state(binding.runId)).phase).toBe("committed"); await quiet();
      } finally { await settings.updateExperimental({ enableWorktreeRunExecution: false }); }
    }
  });
  it.each(["control_plane", "coordinator"] as const)("wakes on the first %s accepted result and becomes quiet with committed history", async producer => {
    await start(); await flush(); await quiet();
    const binding = await seed(); await barrier(binding); await flush();
    await complete(binding, producer); await flush();
    expect((await state(binding.runId)).phase).toBe("committed");
    const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, binding.runId));
    expect(decisions).toHaveLength(1);
    await quiet(); await coordinator!.stop(); await start(); await flush(); await quiet();
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.runId, binding.runId))).toHaveLength(1);
  });
  it("ignores routine company-only finalization hints and still commits accepted work", async () => {
    await start(); await flush(); await quiet();
    const previous = db.$client.options.debug;
    const queries: string[] = [];
    db.$client.options.debug = (_id, query) => {
      if (/from\s+"native_run_finalizations"/i.test(query)) queries.push(query);
    };
    try {
      for (let index = 0; index < 3; index += 1) {
        await db.transaction(async tx => { await notifyNativeFinalizationWork(tx, { companyId }); });
        await flush();
      }
      expect(queries).toEqual([]);
    } finally { db.$client.options.debug = previous; }
    const binding = await seed(); await barrier(binding); await flush();
    await complete(binding, "control_plane"); await flush();
    expect((await state(binding.runId)).phase).toBe("committed");
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.runId, binding.runId))).toHaveLength(1);
    await quiet();
  });

  it("wakes when the real workspace recorder commits a later successful barrier", async () => {
    await start(); await flush();
    const binding = await seed(); await complete(binding, "control_plane"); await flush(); await quiet();
    expect((await state(binding.runId)).phase).not.toBe("committed");
    await barrier(binding); await flush();
    expect((await state(binding.runId)).phase).toBe("committed"); await quiet();
  });
  it.each([
    ["commit", "control_plane"], ["rollback", "control_plane"],
    ["commit", "coordinator"], ["rollback", "coordinator"],
  ] as const)("honors outer %s for %s results", async (outcome, producer) => {
    await start(); await flush();
    const binding = await seed(); await barrier(binding); await flush();
    const transaction = db.transaction(async tx => {
      await complete(binding, producer, tx as unknown as Db);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await state(binding.runId)).toBeUndefined();
      if (outcome === "rollback") throw new Error("rollback fixture");
    });
    if (outcome === "rollback") await expect(transaction).rejects.toThrow("rollback fixture"); else await transaction;
    await flush();
    expect((await state(binding.runId))?.phase).toBe(outcome === "commit" ? "committed" : undefined);
    await quiet();
  });
  it("reconstructs unfinished work at startup using any successful scoped barrier", async () => {
    const binding = await seed(); await complete(binding, "control_plane"); await barrier(binding);
    await db.insert(workspaceOperations).values({ companyId, issueId: binding.issueId, heartbeatRunId: binding.runId,
      phase: "workspace_finalize", status: "failed", createdAt: new Date(Date.now() + 1000) });
    await start(); await flush();
    expect((await state(binding.runId)).phase).toBe("committed"); await quiet();
  });
  it("atomically rejects a future retry without consuming an attempt", async () => {
    const binding = await seed(); await complete(binding, "control_plane"); await barrier(binding);
    const retryAt = new Date(Date.now() + 60_000);
    await db.update(nativeRunFinalizations).set({ nextAttemptAt: retryAt }).where(eq(nativeRunFinalizations.runId, binding.runId));
    await expect(finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded", onlyWhenDue: true }))
      .rejects.toBeInstanceOf(NativeFinalizationDeferredError);
    expect((await state(binding.runId)).attempt).toBe(0);
    await start();
    expect(coordinator!.nextWakeAt()).toBe(retryAt.getTime());
    await vi.advanceTimersByTimeAsync(59_000);
    expect((await state(binding.runId)).attempt).toBe(0);
    await vi.advanceTimersByTimeAsync(1000); await flush();
    expect((await state(binding.runId)).phase).toBe("committed"); await quiet();
  });
  it("preserves a first result committed during drain until resume", async () => {
    await start(); await flush(); admitted = false;
    const binding = await seed(); await barrier(binding); await complete(binding, "coordinator");
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await state(binding.runId)).phase).not.toBe("committed");
    await quiet(); admitted = true; await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect((await state(binding.runId)).phase).toBe("committed"); await quiet();
  });

  it("disarms a saved retry as soon as durable cancellation commits", async () => {
    const binding = await seed(); await complete(binding, "control_plane"); await barrier(binding);
    const retryAt = new Date(Date.now() + 600_000);
    await db.update(nativeRunFinalizations).set({ phase: "retryable_failure", nextAttemptAt: retryAt })
      .where(eq(nativeRunFinalizations.runId, binding.runId));
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, binding.runId));
    await start(); expect(coordinator!.nextWakeAt()).toBe(retryAt.getTime());
    await cancelNativeSession(binding.runId, "Stop", { db, scope: "run" });
    expect((await state(binding.runId)).phase).toBe("terminal_failure");
    await flush(); await quiet();
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.runId, binding.runId))).toHaveLength(0);
  });

  it("honors an existing finalizer lease without charging a failed attempt", async () => {
    const binding = await seed(); await complete(binding, "control_plane"); await barrier(binding);
    const leaseExpiresAt = new Date(Date.now() + 60_000);
    await db.update(nativeRunFinalizations).set({ leaseOwner: "other-controller", leaseExpiresAt })
      .where(eq(nativeRunFinalizations.runId, binding.runId));
    await expect(finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded", onlyWhenDue: true }))
      .rejects.toBeInstanceOf(NativeFinalizationDeferredError);
    expect((await state(binding.runId)).attempt).toBe(0);
    await start(); expect(coordinator!.nextWakeAt()).toBe(leaseExpiresAt.getTime());
    await vi.advanceTimersByTimeAsync(59_000); expect((await state(binding.runId)).attempt).toBe(0);
    await vi.advanceTimersByTimeAsync(1000); await flush();
    expect((await state(binding.runId)).phase).toBe("committed"); await quiet();
  });
  it("reconstructs a saved retry after restart without advancing its deadline", async () => {
    const binding = await seed(); await complete(binding, "coordinator"); await barrier(binding);
    const retryAt = new Date(Date.now() + 60_000);
    const store = new NativeRunCoordinatorStore(db, { ...binding, normalizedSessionId: binding.sessionId,
      runnerSourceInstanceId: binding.sourceInstanceId,
      completionContractRevision: CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.contractRevision,
      completionContractCriterionIds: CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.criteria.map(item => item.criterionId) });
    await store.claimFinalization({ leaseOwner: "retry-owner" });
    await store.markFinalizationRetry({ leaseOwner: "retry-owner", failureCode: "transient_storage_failure", retryAfterMs: 60_000 });
    const saved = (await state(binding.runId)).nextAttemptAt!.getTime();
    expect(saved).toBeGreaterThanOrEqual(retryAt.getTime());
    await start(); expect(coordinator!.nextWakeAt()).toBe(saved); await coordinator!.stop();
    await start(); expect(coordinator!.nextWakeAt()).toBe(saved);
    await vi.advanceTimersByTimeAsync(saved - Date.now()); await flush();
    expect((await state(binding.runId)).phase).toBe("committed"); await quiet();
  });
  it("joins an active finalizer on shutdown and reconstructs work arriving during it", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = vi.fn();
    const finalize: typeof finalizeNativeRun = async input => { entered(); await gate; return finalizeNativeRun(input); };
    await start(finalize); await flush();
    const first = await seed(); await complete(first, "control_plane"); await barrier(first);
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(entered).toHaveBeenCalledTimes(1); });
    const second = await seed(); await complete(second, "coordinator"); await barrier(second);
    let stopped = false;
    const stopping = coordinator!.stop().then(() => { stopped = true; });
    await delay(10); expect(stopped).toBe(false); expect(entered).toHaveBeenCalledTimes(1);
    release(); await stopping;
    expect((await state(first.runId)).phase).toBe("committed");
    expect((await state(second.runId)).phase).not.toBe("committed");
    await start(); await flush();
    expect((await state(second.runId)).phase).toBe("committed"); await quiet();
  });

  it("does not consume an attempt if a retry moves after candidate discovery", async () => {
    let rescheduled = false;
    let retryAt = 0;
    const finalize: typeof finalizeNativeRun = async input => {
      if (!rescheduled) {
        rescheduled = true; retryAt = Date.now() + 60_000;
        await db.transaction(async tx => {
          await notifyNativeResultCommit(tx, { companyId, runId: input.runId });
          await tx.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(retryAt) })
            .where(eq(nativeRunFinalizations.runId, input.runId));
        });
      }
      return finalizeNativeRun(input);
    };
    const binding = await seed(); await complete(binding, "coordinator"); await barrier(binding);
    await start(finalize);
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(coordinator!.nextWakeAt()).toBe(retryAt); });
    expect((await state(binding.runId)).attempt).toBe(0);
    await vi.advanceTimersByTimeAsync(retryAt - Date.now()); await flush();
    expect((await state(binding.runId)).phase).toBe("committed"); await quiet();
  });
  it("retries a real atomic status-commit failure at its saved deadline", async () => {
    let fail = true;
    const finalize: typeof finalizeNativeRun = input => {
      const failpoint = fail ? "status_projection" as const : undefined; fail = false;
      return finalizeNativeRun({ ...input, failpoint });
    };
    const binding = await seed(); await complete(binding, "control_plane"); await barrier(binding);
    await start(finalize);
    const failed = await state(binding.runId);
    expect(failed.phase).toBe("retryable_failure");
    expect(failed.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.runId, binding.runId))).toHaveLength(0);
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(coordinator!.nextWakeAt()).toBe(failed.nextAttemptAt!.getTime()); });
    await vi.advanceTimersByTimeAsync(failed.nextAttemptAt!.getTime() - Date.now()); await flush();
    expect((await state(binding.runId)).phase).toBe("committed");
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.runId, binding.runId))).toHaveLength(1); await quiet();
  });
  it("waits quietly for pending effects and wakes from their real settlement", async () => {
    const binding = await seed(); await complete(binding, "control_plane"); await barrier(binding);
    await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const committed = await state(binding.runId);
    const [effect] = await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId, committed.decisionId!));
    expect(effect).toBeDefined();
    await db.update(statusDecisionEffects).set({ deliveryState: "pending", deliveredAt: null }).where(eq(statusDecisionEffects.id, effect.id));
    await db.update(nativeRunFinalizations).set({ phase: "retryable_failure" }).where(eq(nativeRunFinalizations.runId, binding.runId));
    await start(); await flush(); await quiet();
    expect((await state(binding.runId)).phase).toBe("retryable_failure");
    await dispatchPendingNativeStatusEffects({ db, ...binding, decisionId: committed.decisionId!, onlyWhenDue: true });
    await flush(); expect((await state(binding.runId)).phase).toBe("committed"); await quiet();
  });
  it("delegates only uncommitted results and keeps committed projection repair available", async () => {
    const binding = await seed(); await complete(binding, "control_plane"); await barrier(binding);
    await reconcileNativeFinalizations(db, [binding.runId], { skipNativeResultCommit: true, skipNativeWorkspaceFinalization: true });
    expect((await state(binding.runId)).phase).toBe("workspace_finalizing");
    await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded" });
    expect((await state(binding.runId)).phase).toBe("committed");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, binding.runId)))[0].status).toBe("running");
    await start(); await flush(); await quiet();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, binding.runId)))[0].status).toBe("running");
    await reconcileNativeFinalizations(db, [binding.runId], { skipNativeResultCommit: true, skipNativeWorkspaceFinalization: true });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, binding.runId)))[0].status).toBe("succeeded");
    await flush(); await quiet();
  });
});
