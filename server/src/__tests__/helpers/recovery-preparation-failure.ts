import type { heartbeatService } from "../../services/heartbeat.js";
import type { DeadlineReconciliationSnapshot } from "../../services/deadline-reconciliation.js";
import { readIdleRetrySchedule } from "../../services/heartbeat/idle-retry-schedule.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, environments, heartbeatRuns, plugins, type Db } from "@paperclipai/db";
import { expect, vi } from "vitest";
import { environmentRuntimeService } from "../../services/environment-runtime.js";
import type { PluginWorkerManager } from "../../services/plugin-worker-manager.js";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

export async function preparationFailureFixture(db: Db, agentId: string) {
  const pluginId = randomUUID(), environmentId = randomUUID(), key = `recovery-preparation-${pluginId}`;
  const call = vi.fn();
  const manager = { isRunning: () => false, call } as unknown as PluginWorkerManager;
  const runtime = environmentRuntimeService(db, { pluginWorkerManager: manager, pluginWorkerReadyTimeoutMs: 0 });
  await db.insert(plugins).values({ id: pluginId, pluginKey: key, packageName: `@fixture/${key}`, version: "1.0.0",
    apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1,
    manifestJson: { id: key, apiVersion: 1, version: "1.0.0", displayName: "Controlled unavailable preparation worker",
      description: "Pre-dispatch worker refusal fixture", author: "Paperclip", categories: ["automation"],
      capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
      environmentDrivers: [{ driverKey: key, kind: "sandbox_provider", displayName: "Controlled unavailable worker",
        configSchema: { type: "object" } }] } });
  await db.insert(environments).values({ id: environmentId, name: key, driver: "sandbox", status: "active",
    config: { provider: key, image: "fixture:unavailable", reuseLease: false } });
  await db.update(agents).set({ defaultEnvironmentId: environmentId }).where(eq(agents.id, agentId));
  const preparing = barrier(), releasePreparation = barrier(), cleaning = barrier(), releaseCleanup = barrier();
  const acquire = runtime.acquireRunLease.bind(runtime), release = runtime.releaseRunLeases.bind(runtime);
  let first = true, firstCleanup = true, activeRunId: string | undefined;
  const phases = { preparing: false, cleaning: false };
  const acquireSpy = vi.spyOn(runtime, "acquireRunLease").mockImplementation(async input => {
    if (first && input.agentId === agentId && input.heartbeatRunId) { first = false; activeRunId = input.heartbeatRunId; phases.preparing = true; preparing.resolve(); await releasePreparation.promise; }
    return acquire(input);
  });
  const releaseSpy = vi.spyOn(runtime, "releaseRunLeases").mockImplementation(async (...args) => {
    if (firstCleanup && activeRunId && args[0] === activeRunId) { firstCleanup = false; phases.cleaning = true; cleaning.resolve(); await releaseCleanup.promise; }
    return release(...args);
  });
  return { runtime, pluginId, environmentId, call, phases, preparing, releasePreparation, cleaning, releaseCleanup,
    async useLocalEnvironment() { await db.update(agents).set({ defaultEnvironmentId: null }).where(eq(agents.id, agentId)); },
    unblock() { releasePreparation.resolve(); releaseCleanup.resolve(); },
    async dispose() {
      releasePreparation.resolve(); releaseCleanup.resolve(); acquireSpy.mockRestore(); releaseSpy.mockRestore();
      await db.update(agents).set({ defaultEnvironmentId: null }).where(eq(agents.id, agentId));
      await db.delete(environments).where(eq(environments.id, environmentId));
      await db.delete(plugins).where(eq(plugins.id, pluginId));
    },
  };
}

export async function drivePreparationFailure(input: {
  db: Db; heartbeat: ReturnType<typeof heartbeatService>; control: Awaited<ReturnType<typeof preparationFailureFixture>>;
  entered: unknown; persisted: unknown; companyId: string; agentId: string; issueId: string;
  run: (id: string) => Promise<typeof heartbeatRuns.$inferSelect>; owner: () => DeadlineReconciliationSnapshot;
}) {
  const { db, heartbeat, control, entered, persisted, companyId, agentId, issueId, run, owner } = input;
    let wakeError: unknown;
    const waking = heartbeat.wakeup(agentId, { source: "on_demand", reason: "manual", requestedByActorType: "system",
      contextSnapshot: { issueId: issueId, taskId: issueId } });
    void waking.catch(error => { wakeError = error; });
    await vi.waitFor(() => { if (wakeError) throw wakeError; expect(control.phases.preparing).toBe(true); }, { timeout: 15_000 });
    const [claimed] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running")));
    expect(claimed).toMatchObject({ runtimeMode: "legacy", executionStage: "preparing", processPid: null,
      processGroupId: null, processStartedAt: null, legacyProcessSettlement: null });
    expect(claimed.controllerBootId).toEqual(expect.any(String)); expect(claimed.controllerLeaseExpiresAt).toBeInstanceOf(Date);
    expect(entered).not.toHaveBeenCalled(); expect(persisted).not.toHaveBeenCalled();
    expect(heartbeat.getTaskDrainStatus().activeRuns).toBeGreaterThan(0);
    control.releasePreparation.resolve();
    await vi.waitFor(() => { if (wakeError) throw wakeError; expect(control.phases.cleaning).toBe(true); }, { timeout: 15_000 });
    const failed = await run(claimed.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: "plugin_worker_unavailable", executionStage: "preparing",
      processPid: null, processGroupId: null, processStartedAt: null, legacyProcessSettlement: null });
    expect(control.call).not.toHaveBeenCalled(); expect(entered).not.toHaveBeenCalled(); expect(persisted).not.toHaveBeenCalled();
    expect(failed.controllerLeaseExpiresAt).toBeInstanceOf(Date);
    expect((await readIdleRetrySchedule(db, Date.now(), owner)).blocked).toBe(true);
    control.releaseCleanup.resolve();
    await heartbeat.drainActiveRunExecutions();
    const admitted = await waking; expect(admitted?.id).toBe(claimed.id);
    return run(claimed.id);
}
