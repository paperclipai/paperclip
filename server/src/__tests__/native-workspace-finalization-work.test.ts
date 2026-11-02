import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, createDb, heartbeatRuns, issues, nativeRunFinalizations,
  nativeRunResults, issueRecoveryActions, workspaceOperations, type Db } from "@paperclipai/db";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { issueService } from "../services/issues.js";
import { nativeWorkspaceFinalizationWork } from "../services/native-runtime/native-workspace-finalization-work.js";
import { getRunExecutionTraceContext, measureRunPhase } from "../services/execution-preparation-timing.js";
import { withNativeWorkspaceFinalizationOwnership } from "../services/native-runtime/native-workspace-finalization-ownership.js";
import { resumeNativeWorkspaceAfterOwnerStop } from "../services/native-runtime/native-workspace-owner-recovery.js";
import * as platformProof from "../services/native-runtime/native-workspace-platform-proof.js";
import { reconcileNativeFinalizations } from "../services/native-runtime/native-finalization-reconciler.js";
import { NativeRunCoordinatorStore } from "../services/native-runtime/native-run-coordinator-store.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { notifyNativeFinalizationWork } from "../services/native-finalization-notifications.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

describe("workspace finalization scheduled lifecycle", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let worker: ReturnType<ReturnType<typeof nativeWorkspaceFinalizationWork>["register"]> | undefined;
  let root: string;
  const priorLogs = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
  const companyId = randomUUID(), agentId = randomUUID();
  let admitted = true;
  const errors: unknown[] = [];
  const settled = vi.fn(async () => {});
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "workspace-finalization-work-"));
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = join(root, "logs");
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_WORKSPACE_FINALIZATION_WORK_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("workspace-finalization-work-");
    db = createDb(external ?? temporary!.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Workspace finalization", issuePrefix: `WF${randomUUID().slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Workspace worker", adapterType: "paperclip_runner" });
  }, 30_000);
  beforeEach(() => {
    admitted = true; errors.length = 0; settled.mockClear();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    worker?.stop(); await coordinator?.stop(); worker = undefined; coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.companyId, companyId));
    expect(errors).toEqual([]);
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); await rm(root, { recursive: true, force: true });
    if (priorLogs === undefined) delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    else process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = priorLogs;
  });
  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted, canReconcile: () => admitted,
      onError: error => errors.push(error) });
    worker = nativeWorkspaceFinalizationWork(db, { onWorkspaceSettled: settled }).register(coordinator, () => admitted);
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
    await db.insert(issues).values({ id: issueId, companyId, title: "Preserve completed work", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "workspace-worker-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "workspace-worker-v1", objective: "Finish", criteria: [{ id: "objective", requirement: "Complete the task" }] },
      canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: "native", status: "running",
      nativeIssueId: issueId, nativeSessionId: runId, runnerInstanceId: sourceInstanceId,
      completionContractId: contractId, completionContractSha256: contractId, contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));

    await db.insert(workspaceOperations).values({ companyId, issueId, heartbeatRunId: runId,
      phase: "workspace_finalize", status: "failed", cwd: root });
    return { companyId, issueId, runId, agentId, sessionId: runId, completionContractId: contractId,
      completionContractSha256: contractId, sourceInstanceId, controlPlaneSourceInstanceId: "workspace-worker-test" };
  }
  async function complete(binding: Awaited<ReturnType<typeof seed>>, writer: Db = db,
    producer: "control_plane" | "coordinator" = "control_plane") {
    const port = producer === "control_plane" ? new PaperclipControlPlanePort(writer, binding)
      : new NativeRunCoordinatorStore(writer, { ...binding, normalizedSessionId: binding.sessionId,
        runnerSourceInstanceId: binding.sourceInstanceId,
        completionContractRevision: CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.contractRevision,
        completionContractCriterionIds: CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.criteria.map(item => item.criterionId) });
    await port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: `${binding.runId}:result` });
  }
  async function successful(runId: string) {
    return db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, runId),
      eq(workspaceOperations.phase, "workspace_finalize"), eq(workspaceOperations.status, "succeeded")));
  }
  it.each([true, false])("binds deferred workspace tracing only when the endpoint is enabled: %s", async enabled => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", enabled ? "http://collector.test" : "");
    try {
      const binding = await seed(); await complete(binding);
      let observed = false;
      const attempt = vi.fn(async () => {
        observed = getRunExecutionTraceContext(binding.runId) !== undefined;
        await measureRunPhase("workspace_sync.restore", async () => {});
        return { kind: "inactive" } as const;
      });
      const service = nativeWorkspaceFinalizationWork(db, { attempt, onWorkspaceSettled: settled });
      const entries = await service.load({ companyId, runId: binding.runId });
      expect(entries).toHaveLength(1);
      await expect(service.check(entries[0])).resolves.toBeNull();
      expect(attempt).toHaveBeenCalledOnce();
      expect(observed).toBe(enabled);
      expect(getRunExecutionTraceContext(binding.runId)).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });
  it.each(["restore", "worktree"])("honors %s suppression through the public heartbeat registration", async mode => {
    const binding = await seed(); await complete(binding);
    const runtimeEnv = mode === "restore" ? { PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "true" }
      : { PAPERCLIP_IN_WORKTREE: "true", PAPERCLIP_INSTANCE_ID: "workspace-suppression-test" };
    const settings = instanceSettingsService(db, { runtimeEnv });
    if (mode === "worktree") await settings.updateExperimental({ enableWorktreeRunExecution: false });
    const heartbeat = heartbeatService(db, { runtimeEnv });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted, canReconcile: () => admitted,
      onError: error => errors.push(error) });
    worker = heartbeat.registerNativeWorkspaceFinalizationWork(coordinator, () => admitted);
    await worker.ready; await flush(); await quiet();
    expect(await successful(binding.runId)).toHaveLength(0);
    if (mode === "worktree") {
      try {
        await settings.updateExperimental({ enableWorktreeRunExecution: true });
        await flush(); expect(await successful(binding.runId)).toHaveLength(1); await quiet();
      } finally { await settings.updateExperimental({ enableWorktreeRunExecution: false }); }
    }
  });
  it.each(["control_plane", "coordinator"] as const)("is quiet with no work and retained history, then wakes on the first %s accepted result", async producer => {
    await start(); await flush(); await quiet();
    const binding = await seed();
    await complete(binding, db, producer); await flush();
    expect(await successful(binding.runId)).toHaveLength(1);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, binding.runId))).toHaveLength(1);
    expect(settled).not.toHaveBeenCalled(); 
    await quiet();
    worker!.stop(); await coordinator!.stop(); await start(); await flush(); await quiet();
    expect(await successful(binding.runId)).toHaveLength(1);
  });
  it("ignores routine company-only finalization hints and still wakes on accepted work", async () => {
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
    const binding = await seed();
    await complete(binding); await flush();
    expect(await successful(binding.runId)).toHaveLength(1);
    await quiet();
  });

  it("lets result reconciliation use a successful barrier despite a later stale failure", async () => {
    const binding = await seed(); await complete(binding);
    await db.insert(workspaceOperations).values({ companyId, heartbeatRunId: binding.runId, issueId: binding.issueId,
      phase: "workspace_finalize", status: "succeeded", cwd: root });
    await db.insert(workspaceOperations).values({ companyId, heartbeatRunId: binding.runId, issueId: binding.issueId,
      phase: "workspace_finalize", status: "failed", cwd: root, createdAt: new Date(Date.now() + 1000) });
    await start(); await flush(); await quiet();
    await reconcileNativeFinalizations(db, [binding.runId], { skipNativeWorkspaceFinalization: true });
    const [result] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, binding.runId));
    expect(result.phase).toBe("committed");
    expect(await successful(binding.runId)).toHaveLength(1);
    expect(await db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId, binding.runId))).toHaveLength(3);
    await flush(); await quiet();
  });
  it.each([
    ["commit", "control_plane"], ["rollback", "control_plane"],
    ["commit", "coordinator"], ["rollback", "coordinator"],
  ] as const)("respects the outer transaction's %s for the real %s result producer", async (outcome, producer) => {
    await start(); await flush();
    const binding = await seed();
    const transaction = db.transaction(async tx => {
      await complete(binding, tx as unknown as Db, producer);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await successful(binding.runId)).toHaveLength(0);
      if (outcome === "rollback") throw new Error("rollback fixture");
    });
    if (outcome === "rollback") await expect(transaction).rejects.toThrow("rollback fixture"); else await transaction;
    await flush();
    expect(await successful(binding.runId)).toHaveLength(outcome === "commit" ? 1 : 0);
    await quiet();
  });
  it.each(["startup", "first result"])("retains work during %s drain and resumes without a poll", async phase => {
    admitted = false;
    const binding = await seed();
    if (phase === "startup") await complete(binding);
    await start();
    if (phase === "first result") await complete(binding);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await successful(binding.runId)).toHaveLength(0);
    await quiet();
    admitted = true; await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect(await successful(binding.runId)).toHaveLength(1); await quiet();
  });
  it("reconstructs a durable retry deadline and runs only when it is due", async () => {
    const binding = await seed(); await complete(binding);
    const due = new Date(Date.now() + 60_000);
    await db.update(nativeRunFinalizations).set({ phase: "retryable_failure", nextAttemptAt: due })
      .where(eq(nativeRunFinalizations.runId, binding.runId));
    await start();
    expect(coordinator!.nextWakeAt()).toBe(due.getTime());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await successful(binding.runId)).toHaveLength(0);
    worker!.stop(); await coordinator!.stop(); await start();
    expect(coordinator!.nextWakeAt()).toBe(due.getTime());
    await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect(await successful(binding.runId)).toHaveLength(1); await quiet();
  });
  it("waits quietly for the actual local owner to release", async () => {
    const binding = await seed(); await complete(binding);
    await withNativeWorkspaceFinalizationOwnership({ db, companyId, runId: binding.runId }, async () => {
      await start(); await flush(); await quiet();
      expect(await successful(binding.runId)).toHaveLength(0);
    });
    await flush(); expect(await successful(binding.runId)).toHaveLength(1); await quiet();
  });
  it("joins the actual copyback callback during shutdown", async () => {
    const binding = await seed(); await complete(binding);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const stat = fs.stat;
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      if (args[0] === root) { enter(); await held; }
      return stat(...args);
    });
    const starting = start();
    try {
      await entered;
      let stopped = false;
      const stopping = coordinator!.stop().then(() => { stopped = true; });
      await delay(20);
      expect(stopped).toBe(false);
      expect(await successful(binding.runId)).toHaveLength(0);
      release(); await starting; await stopping;
      expect(stopped).toBe(true); expect(await successful(binding.runId)).toHaveLength(1);
      await quiet();
    } finally { release(); await starting; }
  });
  it("retains an unverifiable owner without recurring SQL or physical writes", async () => {
    const binding = await seed(); await complete(binding);
    const owner = { token: randomUUID(), hostname: "another-controller", pid: 1234, processStartedAt: new Date().toISOString() };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: owner } }).where(eq(heartbeatRuns.id, binding.runId));
    await start(); await flush(); await quiet();
    expect(await successful(binding.runId)).toHaveLength(0);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, binding.runId)))[0].runnerProfileJson?.nativeWorkspaceFinalizationOwner).toEqual(owner);

    await db.transaction(async tx => { await notifyNativeFinalizationWork(tx, binding); });
    await flush(); await quiet();
    expect(await successful(binding.runId)).toHaveLength(0);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, binding.issueId));
    await resumeNativeWorkspaceAfterOwnerStop({ ...binding, db, actionId: action.id, ownerToken: owner.token,
      controllerAndCopybackStopped: true, stopEvidence: "The platform confirms this exact deployment and all copyback processes stopped.", actorId: "operator" });
    await flush(); expect(await successful(binding.runId)).toHaveLength(1); await quiet();
  });

  it("retries a concrete Cloud stop verification and disarms after verified copyback", async () => {
    const binding = await seed(); await complete(binding);
    const deployment = { provider: "railway" as const, projectId: "p", environmentId: "e", serviceId: "s", deploymentId: "old" };
    const owner = { token: randomUUID(), hostname: "another-controller", pid: 1234, processStartedAt: new Date().toISOString(), worker: deployment };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: owner } }).where(eq(heartbeatRuns.id, binding.runId));
    const probe = vi.spyOn(platformProof, "requestWorkspaceWorkerStopProof").mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValue({ status: "verified", proof: { v: 1, iss: "paperclip-cloud", aud: "paperclip-workspace-worker-stop/v1",
        sub: "stack", runId: binding.runId, ownerToken: owner.token, worker: deployment, stopped: true, iat: 1, exp: 61 } });
    await start();
    expect(probe).toHaveBeenCalledOnce();
    expect(coordinator!.nextWakeAt()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(probe).toHaveBeenCalledOnce(); expect(await successful(binding.runId)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15_000); await flush();
    expect(probe).toHaveBeenCalledTimes(2); expect(await successful(binding.runId)).toHaveLength(1); await quiet();
  });

  it("stays quiet after a task binding changes and wakes when the task is restored", async () => {
    const binding = await seed(); await complete(binding);
    const deployment = { provider: "railway" as const, projectId: "p", environmentId: "e", serviceId: "s", deploymentId: "old" };
    const owner = { token: randomUUID(), hostname: "another-controller", pid: 1234, processStartedAt: new Date().toISOString(), worker: deployment };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: owner } }).where(eq(heartbeatRuns.id, binding.runId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, binding.issueId));
    const probe = vi.spyOn(platformProof, "requestWorkspaceWorkerStopProof").mockResolvedValue({ status: "verified", proof: {
      v: 1, iss: "paperclip-cloud", aud: "paperclip-workspace-worker-stop/v1", sub: "stack", runId: binding.runId,
      ownerToken: owner.token, worker: deployment, stopped: true, iat: 1, exp: 61,
    } });
    await start(); await flush(); await quiet();
    expect(probe).toHaveBeenCalledOnce(); expect(await successful(binding.runId)).toHaveLength(0);
    await issueService(db).update(binding.issueId, { status: "in_progress" });
    await flush(); expect(await successful(binding.runId)).toHaveLength(1); await quiet();
  });
  it("records a failed validation once, honors its saved retry, and settles after repair", async () => {
    const binding = await seed();
    await db.update(workspaceOperations).set({ cwd: join(root, "absent") }).where(eq(workspaceOperations.heartbeatRunId, binding.runId));
    await complete(binding); await start();
    const [failed] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, binding.runId));
    expect(failed.phase).toBe("retryable_failure"); expect(failed.nextAttemptAt).not.toBeNull();
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(coordinator!.nextWakeAt()).toBe(failed.nextAttemptAt!.getTime());
    });
    expect(await successful(binding.runId)).toHaveLength(0);
    await db.update(workspaceOperations).set({ cwd: root }).where(eq(workspaceOperations.heartbeatRunId, binding.runId));
    await vi.advanceTimersByTimeAsync(Math.max(0, failed.nextAttemptAt!.getTime() - Date.now())); await flush();
    expect(await successful(binding.runId)).toHaveLength(1); await quiet();
  });
});
