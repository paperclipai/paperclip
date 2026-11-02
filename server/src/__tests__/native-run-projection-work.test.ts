import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "../services/heartbeat/run-lifecycle.js";
import { reconcileNativeFinalizations } from "../services/native-runtime/native-finalization-reconciler.js";
import { statusDecisionEffects } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, createDb, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { nativeRunProjectionWork } from "../services/native-runtime/native-run-projection-work.js";
import { projectCommittedRun } from "../services/native-runtime/native-run-projection.js";
import { notifyNativeFinalizationWork } from "../services/native-finalization-notifications.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";
import * as statusCommitter from "../services/native-runtime/status-decision-committer.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { NativeRunCoordinatorStore } from "../services/native-runtime/native-run-coordinator-store.js";
import { workspaceOperationService } from "../services/workspace-operations.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { emitAgentTaskRun } from "../services/agent-task-run-telemetry.js";
vi.mock("../services/agent-task-run-telemetry.js", () => ({ emitAgentTaskRun: vi.fn(async () => undefined) }));
vi.mock("../services/run-failure-report.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/run-failure-report.js")>(), reportRunFailure: vi.fn(async () => undefined),
}));

describe("committed native run projection lifecycle", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db, root: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let worker: ReturnType<ReturnType<typeof nativeRunProjectionWork>["register"]> | undefined;
  const companyId = randomUUID(), agentId = randomUUID();
  const priorLogs = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
  let admitted = true;
  const errors: unknown[] = [];
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "native-run-projection-"));
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = root;
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_RUN_PROJECTION_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("native-run-projection-");
    db = createDb(external ?? temporary!.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Result commits", issuePrefix: `RC${randomUUID().slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Result worker", adapterType: "paperclip_runner" });
  }, 30_000);
  beforeEach(() => {
    admitted = true; errors.length = 0; vi.mocked(emitAgentTaskRun).mockClear();
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
  async function start(project = projectCommittedRun) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted, canReconcile: () => admitted,
      onError: error => errors.push(error) });
    worker = nativeRunProjectionWork(db, project).register(coordinator, () => admitted);
    await worker.ready;
  }
  async function flush() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0);
      expect(coordinator!.nextWakeAt()).toBeNull();
    }, { timeout: 5000 });
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
  async function complete(binding: Awaited<ReturnType<typeof seed>>, producer: "control_plane" | "coordinator", writer: Db = db, terminalStatus: "succeeded" | "failed" | "cancelled" = "succeeded") {
    const port = producer === "control_plane" ? new PaperclipControlPlanePort(writer, binding)
      : new NativeRunCoordinatorStore(writer, { ...binding, normalizedSessionId: binding.sessionId,
        runnerSourceInstanceId: binding.sourceInstanceId,
        completionContractRevision: CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.contractRevision,
        completionContractCriterionIds: CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.criteria.map(item => item.criterionId) });
    await port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: { ...CONTROL_PLANE_CONFORMANCE_TERMINAL, runTerminalState: terminalStatus },
      callerResultId: `${binding.runId}:result` });
  }
  async function barrier(binding: Awaited<ReturnType<typeof seed>>) {
    await workspaceOperationService(db).createRecorder({ companyId, issueId: binding.issueId, heartbeatRunId: binding.runId })
      .recordOperation({ phase: "workspace_finalize", cwd: root, run: async () => ({ status: "succeeded", exitCode: 0 }) });
  }
  async function state(runId: string) {
    return db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)).then(rows => rows[0]);
  }
  async function read(runId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then(rows => rows[0]);
  }
  async function accepted(status: "succeeded" | "failed" | "cancelled" = "succeeded") {
    const binding = await seed(); await complete(binding, "control_plane", db, status); await barrier(binding); return binding;
  }
  it("reconstructs a committed decision with an unfinished run projection and stays quiet after repair", async () => {
    const binding = await accepted();
    await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded" });
    expect((await read(binding.runId)).status).toBe("running");
    await start(); await flush();
    expect((await read(binding.runId)).status).toBe("succeeded");
    expect(emitAgentTaskRun).toHaveBeenCalledTimes(1); await quiet();
    const settled = await read(binding.runId);
    await coordinator!.stop(); await start(); await flush(); await quiet();
    expect((await read(binding.runId)).executionStatusDeliveryId).toBe(settled.executionStatusDeliveryId);
    expect(emitAgentTaskRun).toHaveBeenCalledTimes(1);
  });
  it("ignores routine company-only finalization hints and still repairs a committed run", async () => {
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
    const binding = await accepted();
    await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded" });
    await flush();
    expect((await read(binding.runId)).status).toBe("succeeded");
    expect(emitAgentTaskRun).toHaveBeenCalledTimes(1);
    await quiet();
  });

  it("wakes from the real status decision transaction after startup has become quiet", async () => {
    await start(); await flush(); await quiet();
    const binding = await accepted();
    await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded" });
    await flush();
    expect((await read(binding.runId)).status).toBe("succeeded"); await quiet();
  });
  it.each(["commit", "rollback"])("honors the status writer's outer %s", async outcome => {
    await start(); await flush();
    const binding = await accepted();
    const transaction = db.transaction(async tx => {
      await finalizeNativeRun({ db: tx as unknown as Db, runId: binding.runId, workspaceFinalizeStatus: "succeeded" });
      await vi.advanceTimersByTimeAsync(5000);
      expect((await read(binding.runId)).status).toBe("running");
      if (outcome === "rollback") throw new Error("rollback fixture");
    });
    if (outcome === "rollback") await expect(transaction).rejects.toThrow("rollback fixture"); else await transaction;
    await flush();
    expect((await read(binding.runId)).status).toBe(outcome === "commit" ? "succeeded" : "running"); await quiet();
  });
  it("does not emit another terminal event when recovery projects before the live finalizer", async () => {
    const binding = await accepted();
    const commit = statusCommitter.commitNativeStatusDecision;
    const hook = vi.spyOn(statusCommitter, "commitNativeStatusDecision").mockImplementation(async input => {
      const outcome = await commit(input);
      await projectCommittedRun({ db, run: await read(binding.runId), coordinator: await state(binding.runId) });
      expect((await read(binding.runId)).status).toBe("succeeded");
      return outcome;
    });
    await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    expect(hook).toHaveBeenCalled();
    expect(emitAgentTaskRun).toHaveBeenCalledTimes(1);
  });
  it("uses fresh completion time when the caller's projection snapshot is stale", async () => {
    const binding = await accepted();
    await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded" });
    const stale = await read(binding.runId);
    const finishedAt = new Date("2020-01-01T00:00:00Z");
    await db.update(heartbeatRuns).set({ finishedAt }).where(eq(heartbeatRuns.id, binding.runId));
    await projectCommittedRun({ db, run: stale, coordinator: await state(binding.runId) });
    expect((await read(binding.runId)).finishedAt).toEqual(finishedAt);
  });
  it.each(["succeeded", "failed", "cancelled"] as const)("stays quiet with retained %s history", async status => {
    const binding = await accepted(status);
    await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const before = await read(binding.runId);
    expect(before.status).toBe(status);
    const calls = vi.mocked(emitAgentTaskRun).mock.calls.length;
    await start(); await flush(); await quiet();
    expect(await read(binding.runId)).toEqual(before);
    expect(emitAgentTaskRun).toHaveBeenCalledTimes(calls);
  });
  it("serializes competing recovery projections without duplicate terminal events", async () => {
    const binding = await accepted();
    await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded" });
    const input = { db, run: await read(binding.runId), coordinator: await state(binding.runId) };
    await Promise.all(Array.from({ length: 4 }, () => projectCommittedRun(input)));
    expect((await read(binding.runId)).status).toBe("succeeded");
    expect(emitAgentTaskRun).toHaveBeenCalledTimes(1);
  });
  it("repairs projection metadata and preserves unrelated diagnostics", async () => {
    const binding = await accepted();
    await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const before = await read(binding.runId);
    await db.update(heartbeatRuns).set({ nativePhase: "retryable_failure", error: "old failure", errorCode: "transport_error",
      resultJson: { ...before.resultJson, failureCode: "old", nextAttemptAt: "old", unrelatedReceipt: { key: "preserve" } },
    }).where(eq(heartbeatRuns.id, binding.runId));
    const calls = vi.mocked(emitAgentTaskRun).mock.calls.length;
    await start(); await flush();
    expect(await read(binding.runId)).toMatchObject({ status: "succeeded", nativePhase: "committed", error: null, errorCode: null,
      finishedAt: before.finishedAt, resultJson: { failureCode: null, nextAttemptAt: null,
        unrelatedReceipt: { key: "preserve" }, recoveredExecutionFailure: { error: "old failure", errorCode: "transport_error" } } });
    expect(emitAgentTaskRun).toHaveBeenCalledTimes(calls); await quiet();
  });
  it.each(["restore", "worktree"])("respects %s suppression through the public heartbeat registration", async mode => {
    const binding = await accepted();
    await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded" });
    const runtimeEnv = mode === "restore" ? { PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "true" }
      : { PAPERCLIP_IN_WORKTREE: "true", PAPERCLIP_INSTANCE_ID: "projection-suppression-test" };
    const settings = instanceSettingsService(db, { runtimeEnv });
    if (mode === "worktree") await settings.updateExperimental({ enableWorktreeRunExecution: false });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted, canReconcile: () => admitted,
      onError: error => errors.push(error) });
    worker = heartbeatService(db, { runtimeEnv }).registerNativeRunProjectionWork(coordinator, () => admitted);
    await worker.ready; await flush(); await quiet();
    expect((await read(binding.runId)).status).toBe("running");
    if (mode === "worktree") {
      try {
        await settings.updateExperimental({ enableWorktreeRunExecution: true });
        await flush(); expect((await read(binding.runId)).status).toBe("succeeded"); await quiet();
      } finally { await settings.updateExperimental({ enableWorktreeRunExecution: false }); }
    }
  });
  it("retains the first committed decision during drain and projects on resume", async () => {
    await start(); await flush(); admitted = false;
    const binding = await accepted();
    await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded" });
    await vi.advanceTimersByTimeAsync(120_000); await quiet();
    expect((await read(binding.runId)).status).toBe("running");
    admitted = true; await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect((await read(binding.runId)).status).toBe("succeeded"); await quiet();
  });
  it("retains a failed projection across drain and restart", async () => {
    let fail = true;
    const project: typeof projectCommittedRun = input => {
      if (fail) { fail = false; throw new Error("projection unavailable"); }
      return projectCommittedRun(input);
    };
    const binding = await accepted();
    await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded" });
    await start(project);
    expect(errors).toHaveLength(1); errors.length = 0;
    expect((await read(binding.runId)).status).toBe("running");
    expect(coordinator!.nextWakeAt()).not.toBeNull();
    admitted = false; await vi.advanceTimersByTimeAsync(120_000); await quiet();
    await coordinator!.stop(); admitted = true; await start(); await flush();
    expect((await read(binding.runId)).status).toBe("succeeded"); await quiet();
  });
  it("joins active projection on shutdown and reconstructs later work", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = vi.fn();
    const project: typeof projectCommittedRun = async input => { entered(); await gate; return projectCommittedRun(input); };
    await start(project); await flush();
    const first = await accepted();
    await finalizeNativeRun({ db, runId: first.runId, workspaceFinalizeStatus: "succeeded" });
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(entered).toHaveBeenCalledTimes(1); });
    const second = await accepted();
    await finalizeNativeRun({ db, runId: second.runId, workspaceFinalizeStatus: "succeeded" });
    let stopped = false; const stopping = coordinator!.stop().then(() => { stopped = true; });
    await delay(10); expect(stopped).toBe(false); release(); await stopping;
    expect((await read(first.runId)).status).toBe("succeeded");
    expect((await read(second.runId)).status).toBe("running");
    await start(); await flush(); expect((await read(second.runId)).status).toBe("succeeded"); await quiet();
  });
  it("rechecks committed authority after candidate discovery", async () => {
    const binding = await accepted();
    await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded" });
    const project: typeof projectCommittedRun = async input => {
      await db.update(nativeRunFinalizations).set({ phase: "retryable_failure" }).where(eq(nativeRunFinalizations.runId, binding.runId));
      return projectCommittedRun(input);
    };
    await start(project); await flush();
    expect((await read(binding.runId)).status).toBe("running"); expect(emitAgentTaskRun).not.toHaveBeenCalled(); await quiet();
  });
  it("waits for real pending-effect settlement before projection", async () => {
    const binding = await accepted();
    await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded" });
    const committed = await state(binding.runId);
    const [effect] = await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId, committed.decisionId!));
    expect(effect).toBeDefined();
    await db.update(statusDecisionEffects).set({ deliveryState: "pending", deliveredAt: null }).where(eq(statusDecisionEffects.id, effect.id));
    await start(); await flush(); await quiet(); expect((await read(binding.runId)).status).toBe("running");
    await statusCommitter.dispatchPendingNativeStatusEffects({ db, ...binding, decisionId: committed.decisionId!, onlyWhenDue: true });
    await flush(); expect((await read(binding.runId)).status).toBe("succeeded"); await quiet();
  });
  it("wakes from the real lifecycle status writer when an ownership hold is released", async () => {
    const binding = await accepted();
    await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded" });
    await db.update(heartbeatRuns).set({ nativePhase: "terminal_failure", errorCode: "native_execution_ownership_unverified" })
      .where(eq(heartbeatRuns.id, binding.runId));
    await start(); await flush(); await quiet();


    const lifecycle = createHeartbeatLifecycle(db, { emitTerminalAgentTaskRun: vi.fn() } as unknown as HeartbeatLifecycleDependencies);
    await lifecycle.setRunStatus(binding.runId, "running", { errorCode: null, nativePhase: "committed" });
    await flush(); expect((await read(binding.runId)).status).toBe("succeeded"); await quiet();
  });
  it("waits for delegated run projection before committed resource settlement", async () => {
    const binding = await accepted();
    await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded" });
    const settled = vi.fn(async () => undefined);
    await reconcileNativeFinalizations(db, [binding.runId], { skipNativeRunProjection: true, skipNativeResultCommit: true,
      skipNativeResponsePresentation: true, skipNativeReviewResponse: true, onWorkspaceSettled: settled });
    expect((await read(binding.runId)).status).toBe("running"); expect(settled).not.toHaveBeenCalled();
    await start(); await flush(); expect((await read(binding.runId)).status).toBe("succeeded"); await quiet();
    await reconcileNativeFinalizations(db, [binding.runId], { skipNativeRunProjection: true, skipNativeResultCommit: true,
      skipNativeResponsePresentation: true, skipNativeReviewResponse: true, onWorkspaceSettled: settled });
    expect(settled).toHaveBeenCalledTimes(1);
  });
});
