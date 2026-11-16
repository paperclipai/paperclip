import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, plugins, sandboxCreationOperations } from "@paperclipai/db";
import { resolvePluginTaskResume } from "../services/environment-task-runtime.js";
import type { PluginTaskResumeRefusal } from "../services/plugin-task-resume.js";
import { hasBoundRemoteStopReceipt, hasRemoteTerminationReceipt, remoteExecutionHasReleased, remoteExecutionHasStopped,
  remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { createPluginRunnerTaskOwner } from "../services/native-runtime/plugin-runner-task.js";
import { NativeExecutionContext } from "../services/native-runtime/native-execution-context.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const databaseSuite = support.supported ? describe : describe.skip;
/** A resume refusal keeps its original message and names the check that failed. */
const refused = (reason: PluginTaskResumeRefusal) => `Plugin Runner retained session is not authorized (reason: ${reason})`;

databaseSuite("environment task lease authority", () => {
  let db: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("environment-task-authority");
    stopDb = started.cleanup; db = createDb(started.connectionString);
  });
  afterAll(async () => { await stopDb?.(); });

  it.each(["dispatch", "writeback"])("fences stale owner %s through maintained physical task replacement", async mode => {
    const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID(), pluginId = randomUUID(), runId = randomUUID(), leaseId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Warm candidate", issuePrefix: `T${companyId.slice(0, 7).replace(/-/g, "").toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "paperclip_runner" });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "fixture-warm-replacement", version: "1", status: "ready",
      manifestJson: { capabilities: ["environment.drivers.register"], environmentDrivers: [{ driverKey: "tasks", supportsTasks: true }] } as never });
    await db.insert(environments).values({ id: environmentId, name: `Fixture ${environmentId}`, driver: "plugin",
      config: { pluginKey: pluginId, driverKey: "tasks", driverConfig: {} } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "manual", status: "running" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId,
      provider: "plugin:fixture:tasks", providerLeaseId: "stopped-task", status: "active", leasePolicy: "reuse_by_environment",
      metadata: { driver: "plugin", pluginId, pluginKey: pluginId, driverKey: "tasks", runnerTaskLease: true, runnerTaskReused: true } });
    const calls: string[] = [], stoppedTasks: string[] = [];
    let holdStatus = false, releaseStatus!: () => void, enterStatus!: () => void;
    const statusEntered = new Promise<void>(resolve => { enterStatus = resolve; });
    const statusReleased = new Promise<void>(resolve => { releaseStatus = resolve; });
    const workers = { getWorker: () => ({ supportedMethods: ["environmentTask", "environmentAcquireLease"] }),
      call: async (_plugin: string, method: string, params: any, _timeout?: number, _sink?: unknown, settled?: () => void) => {
        calls.push(method === "environmentTask" ? params.operation.kind : method);
        if (method === "environmentTask" && params.operation.kind === "stop") stoppedTasks.push(params.taskId);
        if (method === "environmentTask" && params.operation.kind === "status" && holdStatus) {
          holdStatus = false; enterStatus(); await statusReleased;
        }
        try {
          if (method === "environmentAcquireLease") return { providerLeaseId: "replacement-task" };
          if (params.operation.kind === "status") return { kind: "status", taskId: params.taskId, phase: "completed", executionStopped: true };
          if (params.operation.kind === "describe") return { kind: "description", taskId: params.taskId,
            runner: { version: "fixture", digest: `sha256:${"a".repeat(64)}` }, executionContextVersion: 1 };
          return { kind: "accepted", taskId: params.taskId };
        } finally { settled?.(); }
      },
    } as unknown as PluginWorkerManager;
    const context = new NativeExecutionContext({ binding: { companyId, agentId, runId } } as never, 1_000);
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workers });
    const task = (operation: unknown, options?: { expectedTaskId?: string }) => runtime.task({ companyId, leaseId,
      operation: operation as never, ...options });
    const identity = { runnerInstanceId: "runner", environmentLeaseId: leaseId, runId, normalizedSessionId: "session", turnId: "turn", itemId: "item" };
    const oldOwner = createPluginRunnerTaskOwner({ taskId: "stopped-task", task, projectIds: [], harness: "codex", adoptIdentity: identity });
    const oldRegistration = await oldOwner.registration({} as never, runId);
    holdStatus = mode === "writeback";
    const lateStatus = holdStatus ? task({ kind: "status" }, { expectedTaskId: "stopped-task" }) : Promise.resolve();
    if (holdStatus) await statusEntered;
    try {
      await expect(environmentRuntimeService(db, { pluginWorkerManager: workers }).task({ companyId, leaseId,
        operation: { kind: "describe" }, executionContext: context })).resolves.toMatchObject({ kind: "description", taskId: "replacement-task" });
      expect(calls).toEqual([...(mode === "writeback" ? ["status"] : []), "status", "complete", "environmentAcquireLease", "describe"]);
      expect(context.pending).toBe(false);
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
      expect(lease.providerLeaseId).toBe("replacement-task");
      expect(lease.metadata?.runnerTaskReused).toBe(false);
      expect(JSON.stringify(lease.metadata)).not.toContain(context.id);
      releaseStatus(); await lateStatus;
      const [afterLateStatus] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
      expect(afterLateStatus.metadata?.runnerTaskExecutionStopped).toBe(false);
      const failedCleanup = await oldRegistration.checkpoint("unsettled").then(() => undefined, error => error);
      expect(stoppedTasks).not.toContain("replacement-task");
      expect(failedCleanup).toBeInstanceOf(Error);
      const nextOwner = createPluginRunnerTaskOwner({ taskId: "replacement-task", task, projectIds: [], harness: "codex", adoptIdentity: identity });
      const nextRegistration = await nextOwner.registration({} as never, runId);
      try { await expect(nextRegistration.checkpoint("unsettled")).resolves.toBeUndefined(); }
      finally { await nextRegistration.release("detach"); }
      expect(stoppedTasks).toEqual(["replacement-task"]);
    } finally { releaseStatus(); await lateStatus.catch(() => undefined); context.finish(); await oldRegistration.release("detach"); }
  });

  it.each(["late", "post-result", "retiring"])("queues a replacement instead of attaching after %s startup cancellation", async mode => {
    const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID(), pluginId = randomUUID(), runId = randomUUID(), leaseId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Warm candidate", issuePrefix: `T${companyId.slice(0, 7).replace(/-/g, "").toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "paperclip_runner" });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "fixture-warm-replacement", version: "1", status: "ready",
      manifestJson: { capabilities: ["environment.drivers.register"], environmentDrivers: [{ driverKey: "tasks", supportsTasks: true }] } as never });
    await db.insert(environments).values({ id: environmentId, name: `Fixture ${environmentId}`, driver: "plugin",
      config: { pluginKey: pluginId, driverKey: "tasks", driverConfig: {} } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "manual", status: "running" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId,
      provider: "plugin:fixture:tasks", providerLeaseId: "stopped-task", status: "active", leasePolicy: "reuse_by_environment",
      metadata: { driver: "plugin", pluginId, pluginKey: pluginId, driverKey: "tasks", runnerTaskLease: true, runnerTaskReused: true } });
    const calls: string[] = [];
    let reply!: () => Promise<void>, acquiring!: () => void;
    const entered = new Promise<void>(resolve => { acquiring = resolve; });
    const workers = { getWorker: () => ({ supportedMethods: ["environmentTask", "environmentAcquireLease"] }),
      call: async (_plugin: string, method: string, params: any, _timeout?: number, _sink?: unknown, settled?: () => void, _contextId?: string, observe?: (result: any) => Promise<void>) => {
        calls.push(method === "environmentTask" ? params.operation.kind : method);
        try {
          if (method === "environmentAcquireLease") return await new Promise(resolve => {
            reply = async () => { const result = { providerLeaseId: "replacement-task", metadata: { binding: "fresh" } };
              await observe?.(result);
              if (mode === "retiring") await db.update(environmentLeases).set({ metadata: { driver: "plugin", pluginId, driverKey: "tasks", runnerTaskRetiring: true } }).where(eq(environmentLeases.id, leaseId));
              resolve(result); };
            acquiring();
          });
          if (params.operation.kind === "status") return { kind: "status", taskId: params.taskId, phase: "completed", executionStopped: true };
          if (params.operation.kind === "describe") return { kind: "description", taskId: params.taskId,
            runner: { version: "fixture", digest: `sha256:${"a".repeat(64)}` }, executionContextVersion: 1 };
          return { kind: "accepted", taskId: params.taskId };
        } finally { settled?.(); }
      },
    } as unknown as PluginWorkerManager;
    const context = new NativeExecutionContext({ binding: { companyId, agentId, runId } } as never, 1_000);
    if (mode === "post-result") {
      const wait = context.wait.bind(context);
      vi.spyOn(context, "wait").mockImplementation(operation => wait(async () => {
        const value = await operation(); context.abort(new Error("Cancelled after recording")); return value;
      }));
    }
    try {
      const request = environmentRuntimeService(db, { pluginWorkerManager: workers }).task({ companyId, leaseId,
        operation: { kind: "describe" }, executionContext: context });
      const rejected = expect(request).rejects.toThrow("operation unavailable");
      await entered;
      if (mode === "late") {
        context.abort(new Error("Startup cancelled"));
        await rejected;
        expect(context.pending).toBe(true);
      }
      await reply(); await rejected;
      expect(context.pending).toBe(false);
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
      expect(lease.providerLeaseId).toBe("stopped-task");
      const [creation] = await db.select().from(sandboxCreationOperations).where(eq(sandboxCreationOperations.runId, runId));
      expect(creation.state).toBe("cleanup_pending");
      expect(creation.metadata.runnerTaskCreationContextId).toBe(context.id);
      const [cleanup] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, creation.leaseId!));
      expect(cleanup).toMatchObject({ heartbeatRunId: runId, providerLeaseId: "replacement-task", status: "pending_cleanup" });
      expect(cleanup.metadata).toMatchObject({ runnerTaskLease: true, providerMetadata: { binding: "fresh" } });
      expect(calls).not.toContain("describe");
    } finally { context.finish(); }
  });

  it.each([
    { retained: false, replaced: true },
    { retained: true, replaced: false },
  ])("replaces a stopped physical task for a later same-run attempt unless it retains a session (retained=$retained)", async ({ retained, replaced }) => {
    const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID(), pluginId = randomUUID(), runId = randomUUID(), leaseId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retry candidate", issuePrefix: `T${companyId.slice(0, 7).replace(/-/g, "").toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "paperclip_runner" });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "fixture-stopped-replacement", version: "1", status: "ready",
      manifestJson: { capabilities: ["environment.drivers.register"], environmentDrivers: [{ driverKey: "tasks", supportsTasks: true }] } as never });
    await db.insert(environments).values({ id: environmentId, name: `Fixture ${environmentId}`, driver: "plugin",
      config: { pluginKey: pluginId, driverKey: "tasks", driverConfig: {} } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "manual", status: "running" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId,
      provider: "plugin:fixture:tasks", providerLeaseId: "tombstoned-task", status: "active", leasePolicy: "reuse_by_environment",
      metadata: { driver: "plugin", pluginId, pluginKey: pluginId, driverKey: "tasks", runnerTaskLease: true, runnerTaskReused: false,
        runnerTaskDispatched: false, runnerTaskExecutionStopped: true, runnerTaskSessionRetained: retained,
        runnerTaskSourceRecovery: { schema: "fixture" } } });
    const calls: string[] = [];
    const workers = { getWorker: () => ({ supportedMethods: ["environmentTask", "environmentAcquireLease"] }),
      call: async (_plugin: string, method: string, params: any, _timeout?: number, _sink?: unknown, settled?: () => void) => {
        calls.push(method === "environmentTask" ? `${params.operation.kind}:${params.taskId}` : method);
        try {
          if (method === "environmentAcquireLease") return { providerLeaseId: "replacement-task" };
          if (params.operation.kind === "status") return { kind: "status", taskId: params.taskId, phase: "cancelled",
            executionStopped: true, sessionStateAvailable: retained };
          if (params.operation.kind === "describe") return { kind: "description", taskId: params.taskId,
            runner: { version: "fixture", digest: `sha256:${"a".repeat(64)}` }, executionContextVersion: 1 };
          return { kind: "accepted", taskId: params.taskId };
        } finally { settled?.(); }
      },
    } as unknown as PluginWorkerManager;
    const context = new NativeExecutionContext({ binding: { companyId, agentId, runId } } as never, 1_000);
    try {
      await expect(environmentRuntimeService(db, { pluginWorkerManager: workers }).task({ companyId, leaseId,
        operation: { kind: "describe" }, executionContext: context })).resolves.toMatchObject({ kind: "description",
        taskId: replaced ? "replacement-task" : "tombstoned-task" });
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
      if (replaced) {
        expect(calls).toEqual(["status:tombstoned-task", "complete:tombstoned-task", "environmentAcquireLease", "describe:replacement-task"]);
        expect(lease.providerLeaseId).toBe("replacement-task");
        expect(lease.metadata).toMatchObject({ runnerTaskExecutionStopped: false, runnerTaskDispatched: false,
          runnerTaskSessionRetained: false, runnerTaskSourceRecovery: { schema: "fixture" } });
      } else {
        expect(calls).toEqual(["describe:tombstoned-task"]);
        expect(lease.providerLeaseId).toBe("tombstoned-task");
      }
    } finally { context.finish(); }
  });

  it("authorizes a new task lease only after scoped prior execution has stopped", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID(), pluginId = randomUUID();
    const oldRunId = randomUUID(), nextRunId = randomUUID(), oldLeaseId = randomUUID(), nextLeaseId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lease transition", issuePrefix: `T${companyId.slice(0, 7).replace(/-/g, "").toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", adapterType: "paperclip_runner" });
    await db.insert(environments).values({ id: environmentId, name: `Fixture ${environmentId}`, driver: "plugin", config: {} });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "fixture-continuation", version: "1.0.0", status: "ready", manifestJson: {
      capabilities: ["environment.drivers.register"], environmentDrivers: [{ driverKey: "tasks", supportsTasks: true }],
    } as never });
    await db.insert(heartbeatRuns).values([
      { id: oldRunId, companyId, agentId, invocationSource: "manual", status: "succeeded" },
      { id: nextRunId, companyId, agentId, invocationSource: "manual", status: "running" },
    ]);
    const pin = { driver: "plugin", pluginId, driverKey: "tasks", environmentId, runnerTaskLease: true,
      runnerTaskProjectAuthValidation: { configurationId: "fixture", provider: "openai", projectIds: [] } };
    const prior = { id: oldLeaseId, companyId, environmentId, heartbeatRunId: oldRunId, provider: "plugin:fixture:tasks", providerLeaseId: "old-task" };
    await db.insert(environmentLeases).values([
      { ...prior, status: "released", leasePolicy: "ephemeral", cleanupStatus: "success", releasedAt: new Date(),
        metadata: { ...pin, runnerTaskSessionRetained: true, runnerTaskIdentity: { runnerId: "runner", leaseId: oldLeaseId, runId: oldRunId, sessionId: "session", turnId: "prior-turn", itemId: "prior-item" }, remoteExecutionTermination: remoteTerminationReceipt(prior, { providerLeaseId: "old-task", state: "stopped" }) } },
      { id: nextLeaseId, companyId, environmentId, heartbeatRunId: nextRunId, provider: prior.provider, providerLeaseId: "new-task",
        status: "active", leasePolicy: "ephemeral", metadata: pin },
    ]);
    const priorIdentity = { runnerInstanceId: "runner", normalizedSessionId: "session", environmentLeaseId: oldLeaseId, runId: oldRunId };
    const authorize = () => resolvePluginTaskResume(db, { companyId, leaseId: nextLeaseId, priorIdentity });
    await expect(authorize()).resolves.toBe("old-task");
    for (const field of ["runnerInstanceId", "environmentLeaseId", "normalizedSessionId", "runId"]) {
      await expect(resolvePluginTaskResume(db, { companyId, leaseId: nextLeaseId,
        priorIdentity: { ...priorIdentity, [field]: randomUUID() } })).rejects.toThrow(refused("predecessor_candidate_missing"));
    }
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, oldRunId));
    await expect(authorize()).rejects.toThrow(refused("predecessor_run_active"));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, oldRunId));
    await expect(resolvePluginTaskResume(db, { companyId: randomUUID(), leaseId: nextLeaseId, priorIdentity })).rejects.toThrow(refused("next_lease_missing"));
    await db.update(environmentLeases).set({ metadata: { ...pin, pluginId: randomUUID() } }).where(eq(environmentLeases.id, nextLeaseId));
    await expect(authorize()).rejects.toThrow(refused("provider_mismatch"));
    await db.update(environmentLeases).set({ metadata: pin }).where(eq(environmentLeases.id, nextLeaseId));
    await db.update(environmentLeases).set({ providerLeaseId: "old-task" }).where(eq(environmentLeases.id, nextLeaseId));
    await expect(authorize()).rejects.toThrow(refused("same_provider_task"));
    await db.update(environmentLeases).set({ providerLeaseId: "new-task" }).where(eq(environmentLeases.id, nextLeaseId));
    const otherEnvironmentId = randomUUID();
    await db.insert(environments).values({ id: otherEnvironmentId, name: `Fixture ${otherEnvironmentId}`, driver: "plugin", config: {} });
    await db.update(environmentLeases).set({ environmentId: otherEnvironmentId }).where(eq(environmentLeases.id, nextLeaseId));
    await expect(authorize()).rejects.toThrow(refused("scope_mismatch"));
    await db.update(environmentLeases).set({ environmentId }).where(eq(environmentLeases.id, nextLeaseId));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, nextRunId));
    await expect(authorize()).rejects.toThrow(refused("next_run_not_running"));
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, nextRunId));
    await expect(authorize()).resolves.toBe("old-task");
    await db.update(environmentLeases).set({ cleanupStatus: "failed" }).where(eq(environmentLeases.id, oldLeaseId));
    await expect(authorize()).rejects.toThrow(refused("predecessor_not_stopped"));
    await db.update(environmentLeases).set({ cleanupStatus: "success" }).where(eq(environmentLeases.id, oldLeaseId));
    let sessionStateAvailable = false;
    const operations: string[] = [];
    const call = vi.fn(async (_id: string, _method: string, params: any) => ["read_state", "archive_state"].includes(params.operation.kind)
        ? { kind: "state", taskId: params.taskId, state: { schema: "paperclip.runner.durable.state.v1", lifecycle: "suspended",
            ...(params.operation.identity ?? params.operation.priorIdentity) } }
        : params.operation.kind === "status"
          ? (operations.push("status"), { kind: "status", taskId: params.taskId, phase: "completed", executionStopped: true, sessionStateAvailable })
        : { kind: "accepted", taskId: params.taskId });
    const workers = { getWorker: () => ({ supportedMethods: ["environmentTask"] }), call } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workers });
    const runner = { runnerId: "runner", leaseId: oldLeaseId, sessionId: "session", runId: nextRunId,
      turnId: "turn", itemId: "item", harness: "codex", protocolMin: 1, protocolMax: 3 };
    const checkpointIdentity = { ...priorIdentity, turnId: "prior-turn", itemId: "prior-item" };
    const [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, oldLeaseId));
    const portableTargetLeaseId = randomUUID();
    await db.update(environmentLeases).set({ metadata: { ...source.metadata, portableTaskSuccessor: {
      sourceLeaseId: oldLeaseId, targetLeaseId: portableTargetLeaseId,
      operation: { kind: "ensure_ownership", operationId: portableTargetLeaseId, sourceTaskId: "old-task",
        sourceGeneration: "source-generation", targetGeneration: "target-generation", policy: "ordinary", identity: checkpointIdentity },
    } } }).where(eq(environmentLeases.id, oldLeaseId));
    await expect(authorize()).rejects.toThrow(refused("predecessor_candidate_missing"));
    await expect(resolvePluginTaskResume(db, { companyId, leaseId: nextLeaseId, priorIdentity, inspectCheckpoint: true })).rejects.toThrow(refused("predecessor_candidate_missing"));
    await expect(runtime.task({ companyId, leaseId: nextLeaseId, operation: {
      kind: "read_state", identity: checkpointIdentity, resumeFrom: "old-task",
    } })).rejects.toThrow("not authorized");
    await expect(runtime.task({ companyId, leaseId: nextLeaseId, operation: {
      kind: "submit", preparedLaunchId: "fixture", projectIds: [], bootstrapTicket: "fixture", runner, resumeFrom: "old-task",
    } })).rejects.toThrow("not authorized");
    expect(call).not.toHaveBeenCalled();
    await db.update(environmentLeases).set({ metadata: { ...source.metadata, runnerTaskSessionRetained: false } }).where(eq(environmentLeases.id, oldLeaseId));
    await expect(authorize()).rejects.toThrow(refused("predecessor_candidate_missing"));
    await expect(resolvePluginTaskResume(db, { companyId, leaseId: nextLeaseId, priorIdentity, inspectCheckpoint: true })).resolves.toBe("old-task");
    const inspect = () => runtime.task({ companyId, leaseId: nextLeaseId, operation: {
      kind: "read_state", identity: checkpointIdentity, resumeFrom: "old-task",
    } });
    await expect(inspect()).rejects.toThrow(refused("checkpoint_status_unconfirmed"));
    await expect(authorize()).rejects.toThrow(refused("predecessor_candidate_missing"));
    // Discovery cannot launch, and cannot bypass the original termination receipt.
    await expect(runtime.task({ companyId, leaseId: nextLeaseId, operation: {
      kind: "submit", preparedLaunchId: "fixture", projectIds: [], bootstrapTicket: "fixture", runner, resumeFrom: "old-task",
    } })).rejects.toThrow("resume identity mismatch");
    await db.update(environmentLeases).set({ cleanupStatus: "failed" }).where(eq(environmentLeases.id, oldLeaseId));
    await expect(inspect()).rejects.toThrow(refused("predecessor_not_stopped"));
    expect(operations).toEqual(["status"]);
    await db.update(environmentLeases).set({ cleanupStatus: "success" }).where(eq(environmentLeases.id, oldLeaseId));
    sessionStateAvailable = true;
    await expect(inspect()).resolves.toMatchObject({ kind: "state" });
    expect(operations).toEqual(["status", "status"]);
    await expect(authorize()).resolves.toBe("old-task");
    for (const operation of [
      { kind: "read_state" as const, identity: checkpointIdentity, resumeFrom: "old-task" },
      { kind: "archive_state" as const, priorIdentity: checkpointIdentity, archiveKey: "a".repeat(24), resumeFrom: "old-task" },
    ]) {
      await expect(runtime.task({ companyId, leaseId: nextLeaseId, operation })).resolves.toMatchObject({ kind: "state" });
      await expect(runtime.task({ companyId, leaseId: nextLeaseId, operation: { ...operation, resumeFrom: "other-task" } })).rejects.toThrow("resume identity mismatch");
    }
    for (const key of ["turnId", "itemId"]) {
      await expect(runtime.task({ companyId, leaseId: nextLeaseId, operation: {
        kind: "read_state", identity: { ...checkpointIdentity, [key]: "foreign" }, resumeFrom: "old-task",
      } })).rejects.toThrow("resume identity mismatch");
    }
    await expect(runtime.task({ companyId, leaseId: nextLeaseId, operation: {
      kind: "read_state", identity: { ...checkpointIdentity, runId: nextRunId }, resumeFrom: "old-task",
    } })).rejects.toThrow("resume identity mismatch");
    await expect(runtime.task({ companyId, leaseId: nextLeaseId, operation: {
      kind: "submit", preparedLaunchId: "fixture", projectIds: [], bootstrapTicket: "fixture", runner, resumeFrom: "old-task",
    } })).resolves.toMatchObject({ kind: "accepted" });
    const [second] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, nextLeaseId));
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(),
      metadata: { ...second.metadata, runnerTaskSessionRetained: true,
        remoteExecutionTermination: remoteTerminationReceipt(second, { providerLeaseId: "new-task", state: "stopped" }) },
    }).where(eq(environmentLeases.id, nextLeaseId));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, nextRunId));
    const thirdRunId = randomUUID(), thirdLeaseId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: thirdRunId, companyId, agentId, invocationSource: "manual", status: "running" });
    await db.insert(environmentLeases).values({ id: thirdLeaseId, companyId, environmentId, heartbeatRunId: thirdRunId,
      status: "active", provider: prior.provider, providerLeaseId: "third-task", metadata: pin });
    await expect(resolvePluginTaskResume(db, { companyId, leaseId: thirdLeaseId,
      priorIdentity: { ...priorIdentity, runId: nextRunId } })).resolves.toBe("new-task");
    const submit = { kind: "submit", preparedLaunchId: "fixture", projectIds: [], bootstrapTicket: "fixture", runner: { ...runner, runId: thirdRunId }, resumeFrom: "new-task" } as const;
    await expect(runtime.task({ companyId, leaseId: thirdLeaseId, operation: { ...submit, projectIds: [] } })).resolves.toMatchObject({ kind: "accepted" });
    await expect(runtime.task({ companyId, leaseId: thirdLeaseId, operation: { ...submit, projectIds: [], runner } })).rejects.toThrow("identity mismatch");
    // Same-run recovery must choose the latest task in the saved lineage, not an earlier physical lease.
    const [third] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, thirdLeaseId));
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(),
      metadata: { ...third.metadata, runnerTaskSessionRetained: true,
        remoteExecutionTermination: remoteTerminationReceipt(third, { providerLeaseId: "third-task", state: "stopped" }) },
    }).where(eq(environmentLeases.id, thirdLeaseId));
    const retryLeaseId = randomUUID();
    await db.insert(environmentLeases).values({ id: retryLeaseId, companyId, environmentId, heartbeatRunId: thirdRunId,
      status: "active", provider: prior.provider, providerLeaseId: "retry-task", metadata: pin });
    const retryIdentity = { ...checkpointIdentity, runId: thirdRunId, turnId: "turn", itemId: "item" };
    await expect(resolvePluginTaskResume(db, { companyId, leaseId: retryLeaseId,
      priorIdentity: retryIdentity })).resolves.toBe("third-task");
    await expect(runtime.task({ companyId, leaseId: retryLeaseId, operation: {
      kind: "read_state", identity: retryIdentity, resumeFrom: "third-task",
    } })).resolves.toMatchObject({ kind: "state", state: { ...retryIdentity, lifecycle: "suspended" } });
    await expect(runtime.task({ companyId, leaseId: retryLeaseId, operation: { ...submit, projectIds: [], resumeFrom: "third-task" } })).resolves.toMatchObject({ kind: "accepted" });
    const [retry] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, retryLeaseId));
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(),
      metadata: { ...retry.metadata, runnerTaskSessionRetained: true,
        remoteExecutionTermination: remoteTerminationReceipt(retry, { providerLeaseId: "retry-task", state: "stopped" }) },
    }).where(eq(environmentLeases.id, retryLeaseId));
    const finalLeaseId = randomUUID();
    await db.insert(environmentLeases).values({ id: finalLeaseId, companyId, environmentId, heartbeatRunId: thirdRunId,
      status: "active", provider: prior.provider, providerLeaseId: "final-task", metadata: pin });
    await expect(resolvePluginTaskResume(db, { companyId, leaseId: finalLeaseId,
      priorIdentity: { ...priorIdentity, runId: thirdRunId } })).resolves.toBe("retry-task");

  });

  async function seedTaskPlugin(name: string) {
    const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID(), pluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name, issuePrefix: `T${companyId.slice(0, 7).replace(/-/g, "").toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "paperclip_runner" });
    await db.insert(environments).values({ id: environmentId, name: `Fixture ${environmentId}`, driver: "plugin",
      config: { pluginKey: pluginId, driverKey: "tasks", driverConfig: {} } });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: `fixture-${name}`, version: "1.0.0", status: "ready", manifestJson: {
      capabilities: ["environment.drivers.register"], environmentDrivers: [{ driverKey: "tasks", supportsTasks: true }],
    } as never });
    const pin = { driver: "plugin", pluginId, driverKey: "tasks", environmentId, runnerTaskLease: true,
      runnerTaskProjectAuthValidation: { configurationId: "fixture", provider: "openai", projectIds: [] } };
    return { companyId, agentId, environmentId, pin };
  }

  it("records a per-turn task's stop receipt when it settles, before its held lease release", async () => {
    const { companyId, agentId, environmentId, pin } = await seedTaskPlugin("per-turn-stop");
    const oldRunId = randomUUID(), nextRunId = randomUUID(), oldLeaseId = randomUUID(), nextLeaseId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: oldRunId, companyId, agentId, invocationSource: "manual", status: "running" },
      { id: nextRunId, companyId, agentId, invocationSource: "manual", status: "running" },
    ]);
    const prior = { id: oldLeaseId, companyId, environmentId, heartbeatRunId: oldRunId, provider: "plugin:fixture:tasks", providerLeaseId: "old-task" };
    const oldIdentity = { runnerId: "runner", leaseId: oldLeaseId, runId: oldRunId, sessionId: "session", turnId: "prior-turn", itemId: "prior-item" };
    await db.insert(environmentLeases).values([
      { ...prior, status: "active", leasePolicy: "ephemeral", metadata: { ...pin, runnerTaskDispatched: true,
        runnerTaskExecutionStopped: false, runnerTaskSessionRetained: false, runnerTaskIdentity: oldIdentity } },
      { id: nextLeaseId, companyId, environmentId, heartbeatRunId: nextRunId, provider: prior.provider, providerLeaseId: "new-task",
        status: "active", leasePolicy: "ephemeral", metadata: pin },
    ]);
    let executionStopped = false;
    const call = vi.fn(async (_id: string, method: string, params: any) => method !== "environmentTask" ? undefined
      : ["read_state", "archive_state"].includes(params.operation.kind)
      ? { kind: "state", taskId: params.taskId, state: { schema: "paperclip.runner.durable.state.v1", lifecycle: "suspended",
          ...(params.operation.identity ?? params.operation.priorIdentity) } }
      : params.operation.kind === "status"
        ? { kind: "status", taskId: params.taskId, phase: executionStopped ? "completed" : "running", executionStopped, sessionStateAvailable: executionStopped }
        : { kind: "accepted", taskId: params.taskId });
    const workers = { isRunning: () => true, getWorker: () => ({ supportedMethods: ["environmentTask", "environmentReleaseLease"] }), call } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workers });
    const readLease = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0]!;
    const priorIdentity = { runnerInstanceId: "runner", normalizedSessionId: "session", environmentLeaseId: oldLeaseId, runId: oldRunId };
    const checkpointIdentity = { ...priorIdentity, turnId: "prior-turn", itemId: "prior-item" };
    const runner = { runnerId: "runner", leaseId: oldLeaseId, sessionId: "session", runId: nextRunId,
      turnId: "turn", itemId: "item", harness: "codex", protocolMin: 1, protocolMax: 3 };
    const authorize = (inspectCheckpoint?: boolean) => resolvePluginTaskResume(db, { companyId, leaseId: nextLeaseId, priorIdentity, inspectCheckpoint });

    // Neither a running status nor a completion without a provider stop is stop proof.
    await runtime.task({ companyId, leaseId: oldLeaseId, operation: { kind: "status" } });
    await runtime.task({ companyId, leaseId: oldLeaseId, operation: { kind: "complete" } });
    expect((await readLease(oldLeaseId)).metadata).not.toHaveProperty("remoteExecutionTermination");
    expect(await remoteExecutionHasStopped(db, companyId, oldRunId)).toBe(false);

    // The turn checkpoint stops and completes the task; release of the lease is still held.
    executionStopped = true;
    await runtime.task({ companyId, leaseId: oldLeaseId, operation: { kind: "stop" } });
    await runtime.task({ companyId, leaseId: oldLeaseId, operation: { kind: "status" } });
    await runtime.task({ companyId, leaseId: oldLeaseId, operation: { kind: "complete" } });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, oldRunId));
    const settled = await readLease(oldLeaseId);
    expect(settled).toMatchObject({ status: "active", releasedAt: null, cleanupStatus: null, metadata: {
      runnerTaskExecutionStopped: true, runnerTaskSessionRetained: true, runnerTaskDispatched: false,
      remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId, runId: oldRunId, leaseId: oldLeaseId,
        provider: prior.provider, providerLeaseId: "old-task", state: "stopped" } } });
    expect(hasBoundRemoteStopReceipt(settled)).toBe(true);
    expect(hasRemoteTerminationReceipt(settled)).toBe(false);
    expect(await remoteExecutionHasStopped(db, companyId, oldRunId)).toBe(true);
    expect(await remoteExecutionHasReleased(db, companyId, oldRunId)).toBe(false);

    // The follow-up can inspect and launch from the checkpoint while the predecessor is unreleased.
    await expect(authorize(true)).resolves.toBe("old-task");
    await expect(authorize()).resolves.toBe("old-task");
    await expect(runtime.task({ companyId, leaseId: nextLeaseId, operation: {
      kind: "read_state", identity: checkpointIdentity, resumeFrom: "old-task",
    } })).resolves.toMatchObject({ kind: "state", state: { ...checkpointIdentity, lifecycle: "suspended" } });

    // A receipt for another physical task, a second unstopped predecessor lease, or a release
    // that started without settling still refuses authority.
    await db.update(environmentLeases).set({ metadata: { ...settled.metadata, remoteExecutionTermination:
      remoteTerminationReceipt({ ...prior, providerLeaseId: "other-task" }, { providerLeaseId: "other-task", state: "stopped" }) } })
      .where(eq(environmentLeases.id, oldLeaseId));
    await expect(authorize(true)).rejects.toThrow(refused("predecessor_not_stopped"));
    await expect(authorize()).rejects.toThrow(refused("predecessor_not_stopped"));
    await db.update(environmentLeases).set({ metadata: settled.metadata }).where(eq(environmentLeases.id, oldLeaseId));
    const siblingId = randomUUID();
    await db.insert(environmentLeases).values({ id: siblingId, companyId, environmentId, heartbeatRunId: oldRunId,
      provider: prior.provider, providerLeaseId: "sibling-task", status: "active", leasePolicy: "ephemeral", metadata: pin });
    await expect(authorize(true)).rejects.toThrow(refused("predecessor_not_stopped"));
    await expect(authorize()).rejects.toThrow(refused("predecessor_not_stopped"));
    await db.delete(environmentLeases).where(eq(environmentLeases.id, siblingId));
    await db.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed", releasedAt: new Date() })
      .where(eq(environmentLeases.id, oldLeaseId));
    await expect(authorize()).rejects.toThrow(refused("predecessor_not_stopped"));
    await db.update(environmentLeases).set({ status: "active", cleanupStatus: null, releasedAt: null }).where(eq(environmentLeases.id, oldLeaseId));
    await expect(authorize()).resolves.toBe("old-task");

    // Dispatching new execution invalidates a stop receipt on that lease.
    const next = await readLease(nextLeaseId);
    await db.update(environmentLeases).set({ metadata: { ...next.metadata, runnerTaskExecutionStopped: true,
      remoteExecutionTermination: remoteTerminationReceipt(next, { providerLeaseId: "new-task", state: "stopped" }) } })
      .where(eq(environmentLeases.id, nextLeaseId));
    expect(await remoteExecutionHasStopped(db, companyId, nextRunId)).toBe(true);
    await expect(runtime.task({ companyId, leaseId: nextLeaseId, operation: {
      kind: "submit", preparedLaunchId: "fixture", projectIds: [], bootstrapTicket: "fixture", runner, resumeFrom: "old-task",
    } })).resolves.toMatchObject({ kind: "accepted" });
    expect((await readLease(nextLeaseId)).metadata).not.toHaveProperty("remoteExecutionTermination");
    expect(await remoteExecutionHasStopped(db, companyId, nextRunId)).toBe(false);

    // Release still writes its own receipt over the settlement receipt.
    const releaseErrors: unknown[] = [];
    await runtime.releaseRunLeases(oldRunId, "released", (_id, error) => { releaseErrors.push(error); });
    expect(releaseErrors).toEqual([]);
    const released = await readLease(oldLeaseId);
    expect(released).toMatchObject({ status: "released", cleanupStatus: "success",
      metadata: { remoteExecutionTermination: { leaseId: oldLeaseId, providerLeaseId: "old-task", state: "stopped" } } });
    expect(hasRemoteTerminationReceipt(released)).toBe(true);
    expect(await remoteExecutionHasReleased(db, companyId, oldRunId)).toBe(true);
  });

  it("stops counting a settled task's stop receipt once its lease release starts", async () => {
    const { companyId, agentId, environmentId, pin } = await seedTaskPlugin("release-owns-receipt");
    const oldRunId = randomUUID(), nextRunId = randomUUID(), oldLeaseId = randomUUID(), nextLeaseId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: oldRunId, companyId, agentId, invocationSource: "manual", status: "succeeded" },
      { id: nextRunId, companyId, agentId, invocationSource: "manual", status: "running" },
    ]);
    const prior = { id: oldLeaseId, companyId, environmentId, heartbeatRunId: oldRunId, provider: "plugin:fixture:tasks", providerLeaseId: "old-task" };
    // The predecessor's task settled in its run: stopped, session retained, stop receipt recorded.
    const settledMetadata = { ...pin, runnerTaskDispatched: false, runnerTaskExecutionStopped: true, runnerTaskSessionRetained: true,
      runnerTaskIdentity: { runnerId: "runner", leaseId: oldLeaseId, runId: oldRunId, sessionId: "session", turnId: "turn", itemId: "item" },
      remoteExecutionTermination: remoteTerminationReceipt(prior, { providerLeaseId: "old-task", state: "stopped" }) };
    await db.insert(environmentLeases).values([
      { ...prior, status: "active", leasePolicy: "ephemeral", metadata: settledMetadata },
      { id: nextLeaseId, companyId, environmentId, heartbeatRunId: nextRunId, provider: prior.provider, providerLeaseId: "new-task",
        status: "active", leasePolicy: "ephemeral", metadata: pin },
    ]);
    let releaseEntered!: () => void, finishRelease!: () => void;
    const entered = new Promise<void>(resolve => { releaseEntered = resolve; });
    const held = new Promise<void>(resolve => { finishRelease = resolve; });
    const call = vi.fn(async (_id: string, method: string) => {
      if (method !== "environmentReleaseLease") throw new Error(`unexpected ${method}`);
      releaseEntered();
      await held;
    });
    const workers = { isRunning: () => true, getWorker: () => ({ supportedMethods: ["environmentTask", "environmentReleaseLease"] }), call } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workers });
    const priorIdentity = { runnerInstanceId: "runner", normalizedSessionId: "session", environmentLeaseId: oldLeaseId, runId: oldRunId };
    const authorize = (inspectCheckpoint?: boolean) => resolvePluginTaskResume(db, { companyId, leaseId: nextLeaseId, priorIdentity, inspectCheckpoint });
    await expect(authorize()).resolves.toBe("old-task");

    // Each marker that release, destroy, or startup and creation cleanup write first takes the receipt over.
    for (const marker of [{ pluginLeaseCleanupMethod: "release" }, { pluginLeaseCleanupMethod: "destroy" }, { runnerTaskRetiring: true }]) {
      await db.update(environmentLeases).set({ metadata: { ...settledMetadata, ...marker } }).where(eq(environmentLeases.id, oldLeaseId));
      expect(await remoteExecutionHasStopped(db, companyId, oldRunId)).toBe(false);
      await expect(authorize()).rejects.toThrow(refused("predecessor_not_stopped"));
    }
    await db.update(environmentLeases).set({ metadata: settledMetadata }).where(eq(environmentLeases.id, oldLeaseId));

    // Hold the real release inside the provider call: the lease is still active with its settlement receipt.
    const releaseErrors: unknown[] = [];
    const releasing = runtime.releaseRunLeases(oldRunId, "released", (_id, error) => { releaseErrors.push(error); });
    await entered;
    const inFlight = (await db.select().from(environmentLeases).where(eq(environmentLeases.id, oldLeaseId)))[0]!;
    expect(inFlight).toMatchObject({ status: "active", releasedAt: null,
      metadata: { pluginLeaseCleanupMethod: "release", runnerTaskRetiring: true } });
    expect(hasBoundRemoteStopReceipt(inFlight)).toBe(true);
    expect(await remoteExecutionHasStopped(db, companyId, oldRunId)).toBe(false);
    await expect(authorize(true)).rejects.toThrow(refused("predecessor_not_stopped"));
    await expect(authorize()).rejects.toThrow(refused("predecessor_not_stopped"));

    // Release settles with its own receipt, which authorizes the follow-up.
    finishRelease();
    await releasing;
    expect(releaseErrors).toEqual([]);
    const released = (await db.select().from(environmentLeases).where(eq(environmentLeases.id, oldLeaseId)))[0]!;
    expect(released).toMatchObject({ status: "released", cleanupStatus: "success" });
    expect(hasRemoteTerminationReceipt(released)).toBe(true);
    expect(await remoteExecutionHasStopped(db, companyId, oldRunId)).toBe(true);
    await expect(authorize(true)).resolves.toBe("old-task");
    await expect(authorize()).resolves.toBe("old-task");
  });

  it("still records stop receipts for every warm owner and retires retained owners", async () => {
    const { companyId, agentId, environmentId, pin } = await seedTaskPlugin("warm-stop");
    const priorRunId = randomUUID(), currentRunId = randomUUID(), priorLeaseId = randomUUID(), currentLeaseId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: priorRunId, companyId, agentId, invocationSource: "manual", status: "succeeded" },
      { id: currentRunId, companyId, agentId, invocationSource: "manual", status: "running" },
    ]);
    const shared = { companyId, environmentId, provider: "plugin:fixture:tasks", providerLeaseId: "warm-task", leasePolicy: "reuse_by_environment" as const };
    await db.insert(environmentLeases).values([
      { ...shared, id: priorLeaseId, heartbeatRunId: priorRunId, status: "retained", metadata: pin },
      { ...shared, id: currentLeaseId, heartbeatRunId: currentRunId, status: "active", metadata: { ...pin, runnerTaskDispatched: true } },
    ]);
    const call = vi.fn(async (_id: string, _method: string, params: any) => params.operation.kind === "status"
      ? { kind: "status", taskId: params.taskId, phase: "completed", executionStopped: true, sessionStateAvailable: false }
      : { kind: "accepted", taskId: params.taskId });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: { getWorker: () => ({ supportedMethods: ["environmentTask"] }), call } as unknown as PluginWorkerManager });
    await runtime.task({ companyId, leaseId: currentLeaseId, operation: { kind: "status" } });
    await runtime.task({ companyId, leaseId: currentLeaseId, operation: { kind: "complete" } });
    const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.providerLeaseId, "warm-task"));
    const priorLease = leases.find(lease => lease.id === priorLeaseId)!, currentLease = leases.find(lease => lease.id === currentLeaseId)!;
    expect(priorLease).toMatchObject({ status: "released", cleanupStatus: "success",
      metadata: { remoteExecutionTermination: { leaseId: priorLeaseId, runId: priorRunId, state: "stopped" } } });
    expect(currentLease).toMatchObject({ status: "active",
      metadata: { remoteExecutionTermination: { leaseId: currentLeaseId, runId: currentRunId, state: "stopped" } } });
    expect(hasRemoteTerminationReceipt(priorLease)).toBe(true);
    expect(await remoteExecutionHasStopped(db, companyId, priorRunId)).toBe(true);
    expect(await remoteExecutionHasStopped(db, companyId, currentRunId)).toBe(true);
    expect(await remoteExecutionHasReleased(db, companyId, currentRunId)).toBe(false);
  });

});
