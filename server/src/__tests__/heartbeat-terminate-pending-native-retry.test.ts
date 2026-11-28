import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  plugins,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { configureAgentLifecycle, createAgentLifecycle } from "../services/agent-lifecycle.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "../services/native-local-process-stop.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("terminating an agent whose failed run has a scheduled bootstrap retry", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const workers: Array<{ stop(): Promise<void> }> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminate-pending-retry-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.stop();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(issueStatus: "in_progress" | "cancelled") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const environmentId = randomUUID(), leaseId = randomUUID(), pluginId = randomUUID();
    const providerLeaseId = `sandbox-${randomUUID()}`;
    const pluginKey = `paperclip.pending-retry-${pluginId.slice(0, 8)}`;
    await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: "@paperclipai/plugin-fake-sandbox", version: "1.0.0",
      apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1, updatedAt: new Date(),
      manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Fake sandbox", description: "Test provider",
        author: "Paperclip", categories: ["automation"], capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "fake-plugin", kind: "sandbox_provider", displayName: "Fake Plugin",
          configSchema: { type: "object" } }] } } as never);
    await db.insert(companies).values({ id: companyId, name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "OpenCoder", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "opencode" }, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Short task", status: issueStatus,
      priority: "medium", assigneeAgentId: agentId });
    const config = { provider: "fake-plugin", image: "fake:test", timeoutMs: 1234, reuseLease: false };
    await db.insert(environments).values({ id: environmentId, name: `Fake sandbox ${environmentId}`, driver: "sandbox",
      status: "active", config });
    const failedAt = new Date(Date.now() - 5_000);
    const retryAt = new Date(Date.now() + 17 * 60_000);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment", status: "failed",
      runtimeMode: "native", runtimeModeResolvedAt: failedAt, issueId, nativeIssueId: issueId, startedAt: failedAt,
      finishedAt: failedAt, errorCode: "native_runner_process_exited", error: "The runner process exited",
      contextSnapshot: { issueId }, nextEventSeq: 3, nativePhase: "retryable_failure",
      resultJson: { executionRecovery: { kind: "bootstrap", recoverable: true, recoveryMode: "bootstrap_retry",
        nextAttemptAt: retryAt.toISOString() } },
      runnerProfileJson: { nativeWorkspaceSync: {
        schema: "paperclip.native-workspace-sync/v3", state: "prepared", descriptorSha256: "a".repeat(64),
        baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: randomUUID(), leaseId, providerLeaseId,
        remoteCwd: "/workspace", resourceDisposition: "destroy" } } });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "retryable_failure", attempt: 1,
      controllerGeneration: 1, failureCode: "native_runner_process_exited", recoveryState: "scheduled", nextAttemptAt: retryAt });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId, issueId,
      status: "active", leasePolicy: "ephemeral", provider: "fake-plugin", providerLeaseId,
      metadata: { ...config, agentId, driver: "sandbox", pluginId, pluginKey, sandboxProviderPlugin: true,
        remoteCwd: "/workspace", sandboxState: "started" } });
    for (const [index, eventType] of [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED].entries()) {
      await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: index + 1, eventType,
        stream: "system", level: "info", message: eventType });
    }
    const call = vi.fn(async (_pluginId: string, method: string, params: { providerLeaseId?: string }) => {
      if (method === "environmentStopLease") return { providerLeaseId: params.providerLeaseId, state: "stopped" };
      if (method === "environmentDestroyLease" || method === "environmentReleaseLease") {
        return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
      }
      throw new Error(`Unexpected provider method ${method}`);
    });
    const manager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentReleaseLease", "environmentDestroyLease", "environmentStopLease"] })),
      call,
    } as unknown as PluginWorkerManager;
    return { companyId, agentId, issueId, runId, leaseId, providerLeaseId, manager, call };
  }

  it.each([
    ["in_progress", "in_progress"],
    ["cancelled", "cancelled"],
  ] as const)("cancels the pending retry and releases its sandbox at once (task %s)", async (issueStatus, finalStatus) => {
    const fixture = await seed(issueStatus);
    const lifecycle = createAgentLifecycle(db);
    const worker = configureAgentLifecycle(db, createLifecycleDriver(db, fixture.manager));
    workers.push(worker);
    const startedAt = Date.now();
    await lifecycle.pauseAgent(fixture.agentId);
    await worker.process(fixture.agentId);
    await lifecycle.terminateAgent(fixture.agentId);
    await worker.process(fixture.agentId);
    const agent = (await db.select().from(agents).where(eq(agents.id, fixture.agentId)))[0]!;
    expect(agent.lifecycleState).toBe("terminated");
    expect(Date.now() - startedAt).toBeLessThan(15_000);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(run!.status).toBe("cancelled");
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(coordinator).toMatchObject({ phase: "terminal_failure", nextAttemptAt: null, leaseOwner: null });

    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, fixture.leaseId));
    expect(lease!.status).not.toBe("active");
    expect(lease!.releasedAt).not.toBeNull();
    expect(fixture.call).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/^environment(Stop|Destroy|Release)Lease$/),
      expect.objectContaining({ providerLeaseId: fixture.providerLeaseId }), expect.any(Number));

    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, fixture.companyId),
      eq(heartbeatRuns.retryOfRunId, fixture.runId)))).toHaveLength(0);
    const [task] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(task!.status).toBe(finalStatus);
    expect(run!.resultJson).toMatchObject({ pauseStop: { holds: ["manual"] },
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [fixture.leaseId] } });
  }, 60_000);
});
