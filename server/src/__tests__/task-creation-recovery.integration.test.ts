import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, environmentLeases, environments, heartbeatRuns, issues, nativeRunFinalizations, plugins, sandboxCreationOperations, type Db } from "@paperclipai/db";
import type { PluginEnvironmentLease } from "@paperclipai/plugin-sdk";
import { setupRunControlDatabase, callbacks } from "../services/heartbeat/__tests__/run-control-fixtures.js";
import { createHeartbeatRecovery, type HeartbeatRecoveryDependencies } from "../services/heartbeat/recovery.js";
import { createHeartbeatRunControl } from "../services/heartbeat/run-control.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import { NativeExecutionContext } from "../services/native-runtime/native-execution-context.js";
import { requestNativeStartupCleanup, verifyNativeStartupCleanup } from "../services/native-runtime/native-startup-cleanup.js";
import { prepareNativeHeartbeatRun } from "../services/native-runtime/prepare-native-run.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import type { PluginWorkerHandle, PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { nextEnvironmentCleanupAt } from "../services/environment-cleanup-state.js";

vi.mock("../services/local-service-supervisor.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/local-service-supervisor.js")>(), terminateLocalService: vi.fn(),
}));

let db: Db;
const database = setupRunControlDatabase("task-creation-recovery-", value => { db = value; });

async function fixture(version = true, inspector = true) {
  const { company, agent } = await database.fixture();
  const companyId = company.id, agentId = agent.id, runId = randomUUID(), issueId = randomUUID();
  const pluginId = randomUUID(), environmentId = randomUUID(), leaseId = randomUUID(), taskId = randomUUID(), leaseOwner = randomUUID();
  await db.update(agents).set({ adapterType: "paperclip_runner" }).where(eq(agents.id, agentId));
  await db.insert(issues).values({ id: issueId, companyId, title: "Recover task creation", status: "in_progress", assigneeAgentId: agentId });
  const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
    runtimeMode: "native", invocationSource: "manual", status: "running", contextSnapshot: { issueId } }).returning();
  await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
  await prepareNativeHeartbeatRun({ db, run, issue: { id: issueId, title: "Recover task creation", description: null }, environmentLeaseId: leaseId });
  await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", attempt: 1,
    controllerGeneration: 1, leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) });
  await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "task-recovery-fixture", version: "1", status: "ready",
    manifestJson: { capabilities: ["environment.drivers.register"], environmentDrivers: [{ driverKey: "tasks", supportsTasks: true,
      ...(version ? { creationOperationVersion: 1 } : {}) }] } as never });
  await db.insert(environments).values({ id: environmentId, companyId, name: environmentId, driver: "plugin",
    config: { pluginKey: pluginId, driverKey: "tasks", driverConfig: {} } });
  const binding = { agentId, runId: "predecessor", computerId: "saved-computer", opaque: "saved-binding" };
  await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId, issueId,
    provider: "plugin:fixture:tasks", providerLeaseId: taskId, status: "active", leasePolicy: "reuse_by_environment",
    metadata: { driver: "plugin", pluginId, pluginKey: pluginId, driverKey: "tasks", agentId,
      runnerTaskLease: true, runnerTaskReused: true, providerMetadata: binding } });
  const context = new NativeExecutionContext({ binding: { companyId, agentId, runId } } as never, 30_000);
  const stopped = new Set([taskId]), calls: string[] = [];
  let acquireSuccess = false, mismatched = false, inspectUnknown = false;
  let acquiredId = "", observed: ((lease: PluginEnvironmentLease) => Promise<void>) | undefined;
  const recoveredBinding = () => ({ ...binding, runId });
  const acquire = vi.fn(async (_method: string, params: any, _timeout: unknown, _sink: unknown, settled?: () => void,
    _context?: string, observe?: (lease: PluginEnvironmentLease) => Promise<void>) => {
    acquiredId = params.creationOperationId; observed = observe;
    if (!acquireSuccess) throw new Error("Acquire reply was lost");
    const result = { providerLeaseId: acquiredId, metadata: recoveredBinding() };
    await observe?.(result); settled?.(); return result;
  });
  const originalWorker = { supportedMethods: ["environmentTask", "environmentAcquireLease", "environmentReleaseLease", ...(inspector ? ["environmentInspectLease"] : [])], call: acquire } as unknown as PluginWorkerHandle;
  const replacementAcquire = vi.fn(async () => ({ providerLeaseId: randomUUID() }));
  const oldWorker = { supportedMethods: ["environmentTask", "environmentAcquireLease"], call: replacementAcquire } as unknown as PluginWorkerHandle;
  let currentWorker = originalWorker;
  const workers = { getWorker: () => currentWorker, isRunning: () => true, drainStartup: vi.fn(async () => {}), retireStartup: vi.fn(async () => {}),
    call: vi.fn(async (_plugin: string, method: string, params: any, ...rest: any[]) => {
      calls.push(method === "environmentTask" ? params.operation.kind : method);
      if (method === "environmentAcquireLease") return currentWorker.call(method, params, ...rest as []);
      if (method === "environmentInspectLease") {
        expect(params).toMatchObject({ companyId, environmentId, creationOperation: { id: acquiredId, runId },
          leaseMetadata: { creationOperationVersion: 1, runnerTaskCreationContextId: context.id, agentId, runId, providerMetadata: binding } });
        return { providerLeaseId: acquiredId, state: "unknown", ...(!inspectUnknown ? {
          creationLease: { providerLeaseId: mismatched ? "foreign-task" : acquiredId, metadata: recoveredBinding() },
        } : {}) };
      }
      if (method === "environmentReleaseLease") return undefined;
      if (params.operation.kind === "stop") stopped.add(params.taskId);
      if (params.operation.kind === "status") return { kind: "status", taskId: params.taskId,
        phase: stopped.has(params.taskId) ? "cancelled" : "running", executionStopped: stopped.has(params.taskId) };
      if (params.operation.kind === "describe") return { kind: "description", taskId: params.taskId,
        runner: { version: "fixture", digest: `sha256:${"a".repeat(64)}` } };
      return { kind: "accepted", taskId: params.taskId };
    }),
  } as unknown as PluginWorkerManager;
  const runtime = environmentRuntimeService(db, { pluginWorkerManager: workers });
  const reload = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
  const owner = async () => (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0]!;
  const creation = async () => (await db.select().from(sandboxCreationOperations).where(eq(sandboxCreationOperations.runId, runId)))[0]!;
  const start = () => runtime.task({ companyId, leaseId, operation: { kind: "describe" }, executionContext: context });
  const request = async () => {
    await requestNativeStartupCleanup(db, { companyId, agentId, runId, leaseId, leaseOwner,
      contextId: context.id, deadlineAtMs: context.deadlineAtMs, requiresPreparationStop: false });
    const lease = (await environmentService(db).getLeaseById(leaseId))!;
    await environmentService(db).releaseLease(leaseId, "released", { cleanupStatus: "success",
      remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: taskId, state: "stopped" }) });
  };
  const deps = callbacks(db);
  deps.verifyStartupCleanup = run => verifyNativeStartupCleanup(db, run, async () => {});
  const control = createHeartbeatRunControl(db, deps);
  const recovery = createHeartbeatRecovery(db, { ...deps, environmentRuntime: runtime, environmentsSvc: environmentService(db),
    runtimeEnv: {}, activeRunExecutionPromises: new Set<Promise<void>>(), acknowledgeRemoteStop: async () => {},
    resumeRemoteStopComments: async () => {} } as unknown as HeartbeatRecoveryDependencies);
  return { companyId, runId, context, calls, acquired: () => acquiredId, binding, creation, start, request, runtime, recovery, control,
    reload, owner, originalWorker, replacementAcquire, acquire, workers,
    succeed: () => { acquireSuccess = true; }, replaceWorker: () => { currentWorker = oldWorker; },
    mismatch: () => { mismatched = true; }, unknown: () => { inspectUnknown = true; },
    lateReply: () => observed!({ providerLeaseId: acquiredId, metadata: recoveredBinding() }) };
}

it.each(["pending", "needs_reconciliation", "late_first", "inspection_first"])("recovers an opted-in lost task reply through verified cleanup: %s", async mode => {
  const f = await fixture();
  try {
    await expect(f.start()).rejects.toThrow();
    expect(await f.creation()).toMatchObject({ metadata: { creationOperationVersion: 1, providerMetadata: f.binding } });
    expect((await f.creation()).nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    await f.request();
    await expect(f.control.cancelRunInternal(f.runId, "Startup cleanup retry")).rejects.toThrow("cleanup is still pending");
    if (mode === "needs_reconciliation") await db.update(sandboxCreationOperations).set({ state: "needs_reconciliation",
      createdAt: new Date(Date.now() - 31 * 60_000), nextAttemptAt: new Date(0) })
      .where(eq(sandboxCreationOperations.id, (await f.creation()).id));
    if (mode === "late_first") await f.lateReply();
    const restartedRuntime = environmentRuntimeService(db, { pluginWorkerManager: f.workers });
    await restartedRuntime.flushDeferredOrphanCleanups();
    if (mode === "inspection_first") await f.lateReply();
    const creation = await f.creation();
    expect(creation.state).toBe("cleanup_pending");
    expect(await db.select().from(environmentLeases).where(and(eq(environmentLeases.heartbeatRunId, f.runId),
      eq(environmentLeases.providerLeaseId, f.acquired())))).toHaveLength(1);
    expect((await f.reload()).status).toBe("running");
    expect((await f.recovery.sweepPendingCleanupLeases({ explicitRetry: { companyId: f.companyId, runId: f.runId, actorId: "operator" } })).destroyed).toBe(1);
    expect(f.calls).toContain("stop"); expect(f.calls).toContain("status"); expect(f.calls).toContain("complete");
    expect(await f.control.cancelRunInternal(f.runId, "Startup cleanup retry")).toMatchObject({ status: "cancelled" });
    expect((await f.owner()).leaseOwner).toBeNull();
    expect((await f.creation()).state).toBe("resolved");
    expect(await nextEnvironmentCleanupAt(db)).toBeNull();
  } finally { f.context.finish(); }
});

it.each(["legacy", "manifest_only"])("does not infer a deterministic identity for %s task creation", async mode => {
  const f = await fixture(mode !== "legacy", false);
  try {
    await expect(f.start()).rejects.toThrow();
    const operation = await f.creation();
    expect(operation.metadata.creationOperationVersion).toBeUndefined();
    await db.update(sandboxCreationOperations).set({ nextAttemptAt: new Date(0) }).where(eq(sandboxCreationOperations.id, operation.id));
    await f.request(); await f.runtime.flushDeferredOrphanCleanups();
    expect((await f.creation()).state).toBe("needs_reconciliation");
    expect(f.calls).not.toContain("environmentInspectLease");
    await expect(f.control.cancelRunInternal(f.runId, "Startup cleanup retry")).rejects.toThrow("cleanup is still pending");
    expect((await f.owner()).leaseOwner).not.toBeNull();
  } finally { f.context.finish(); }
});

it.each(["mismatched", "unknown"])("retains ownership when inspection is %s", async mode => {
  const f = await fixture();
  try {
    await expect(f.start()).rejects.toThrow(); await f.request();
    if (mode === "mismatched") f.mismatch(); else f.unknown();
    await f.runtime.flushDeferredOrphanCleanups();
    expect((await f.creation()).state).toBe("pending");
    expect((await f.creation()).nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    await expect(f.control.cancelRunInternal(f.runId, "Startup cleanup retry")).rejects.toThrow("cleanup is still pending");
    expect((await f.owner()).leaseOwner).not.toBeNull();
  } finally { f.context.finish(); }
});

it("pins the opted-in acquisition worker across the journal commit", async () => {
  const f = await fixture(); f.succeed();
  const transaction = db.transaction.bind(db);
  const spy = vi.spyOn(db, "transaction").mockImplementation(((work: any) => transaction(async tx => {
    const result = await work(tx);
    if (result?.metadata?.runnerTaskCreationContextId === f.context.id) f.replaceWorker();
    return result;
  })) as typeof db.transaction);
  try {
    const result = await f.start();
    expect(f.acquire).toHaveBeenCalledTimes(1);
    expect(f.replacementAcquire).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "description", taskId: f.acquired() });
    expect((await f.creation()).state).toBe("attached");
  } finally { spy.mockRestore(); f.context.finish(); }
});
