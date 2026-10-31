import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, plugins } from "@paperclipai/db";
import { resolvePluginTaskResume } from "../services/environment-task-runtime.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const databaseSuite = support.supported ? describe : describe.skip;

databaseSuite("environment task lease authority", () => {
  let db: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("environment-task-authority");
    stopDb = started.stop; db = createDb(started.connectionString);
  });
  afterAll(async () => { await stopDb?.(); });

  it("authorizes a new task lease only after scoped prior execution has stopped", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID(), pluginId = randomUUID();
    const oldRunId = randomUUID(), nextRunId = randomUUID(), oldLeaseId = randomUUID(), nextLeaseId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lease transition", issuePrefix: `T${companyId.slice(0, 7).replace(/-/g, "").toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", adapterType: "paperclip_runner" });
    await db.insert(environments).values({ id: environmentId, companyId, name: `Fixture ${environmentId}`, driver: "plugin", config: {} });
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
        priorIdentity: { ...priorIdentity, [field]: randomUUID() } })).rejects.toThrow("not authorized");
    }
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, oldRunId));
    await expect(authorize()).rejects.toThrow("not authorized");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, oldRunId));
    await expect(resolvePluginTaskResume(db, { companyId: randomUUID(), leaseId: nextLeaseId, priorIdentity })).rejects.toThrow("not authorized");
    await db.update(environmentLeases).set({ metadata: { ...pin, pluginId: randomUUID() } }).where(eq(environmentLeases.id, nextLeaseId));
    await expect(authorize()).rejects.toThrow("not authorized");
    await db.update(environmentLeases).set({ metadata: pin }).where(eq(environmentLeases.id, nextLeaseId));
    await db.update(environmentLeases).set({ cleanupStatus: "failed" }).where(eq(environmentLeases.id, oldLeaseId));
    await expect(authorize()).rejects.toThrow("not authorized");
    await db.update(environmentLeases).set({ cleanupStatus: "success" }).where(eq(environmentLeases.id, oldLeaseId));
    let sessionStateAvailable = false;
    const operations: string[] = [];
    const workers = { getWorker: () => ({ supportedMethods: ["environmentTask"] }),
      call: async (_id: string, _method: string, params: any) => ["read_state", "archive_state"].includes(params.operation.kind)
        ? { kind: "state", taskId: params.taskId, state: { schema: "paperclip.runner.durable.state.v1", lifecycle: "suspended",
            ...(params.operation.identity ?? params.operation.priorIdentity) } }
        : params.operation.kind === "status"
          ? (operations.push("status"), { kind: "status", taskId: params.taskId, phase: "completed", executionStopped: true, sessionStateAvailable })
        : { kind: "accepted", taskId: params.taskId },
    } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workers });
    const runner = { runnerId: "runner", leaseId: oldLeaseId, sessionId: "session", runId: nextRunId,
      turnId: "turn", itemId: "item", harness: "codex", protocolMin: 1, protocolMax: 3 };
    const checkpointIdentity = { ...priorIdentity, turnId: "prior-turn", itemId: "prior-item" };
    const [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, oldLeaseId));
    await db.update(environmentLeases).set({ metadata: { ...source.metadata, runnerTaskSessionRetained: false } }).where(eq(environmentLeases.id, oldLeaseId));
    await expect(authorize()).rejects.toThrow("not authorized");
    await expect(resolvePluginTaskResume(db, { companyId, leaseId: nextLeaseId, priorIdentity, inspectCheckpoint: true })).resolves.toBe("old-task");
    const inspect = () => runtime.task({ companyId, leaseId: nextLeaseId, operation: {
      kind: "read_state", identity: checkpointIdentity, resumeFrom: "old-task",
    } });
    await expect(inspect()).rejects.toThrow("not authorized");
    await expect(authorize()).rejects.toThrow("not authorized");
    // Discovery cannot launch, and cannot bypass the original termination receipt.
    await expect(runtime.task({ companyId, leaseId: nextLeaseId, operation: {
      kind: "submit", preparedLaunchId: "fixture", projectIds: [], bootstrapTicket: "fixture", runner, resumeFrom: "old-task",
    } })).rejects.toThrow("resume identity mismatch");
    await db.update(environmentLeases).set({ cleanupStatus: "failed" }).where(eq(environmentLeases.id, oldLeaseId));
    await expect(inspect()).rejects.toThrow("not authorized");
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

});
