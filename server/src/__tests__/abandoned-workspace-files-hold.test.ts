import { JsonRpcCallError } from "@paperclipai/plugin-sdk";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaceSnapshots,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  plugins,
  projects,
} from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { environmentService } from "../services/environments.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";
import { abandonUnverifiedRemoteWorkspaceEpoch } from "../services/remote-workspace-epoch-abandonment.ts";
import { nativeWorkspaceExportPendingForLease } from "../services/native-runtime/native-workspace-finalization-state.ts";
import { REUSABLE_SANDBOX_RESUME_FAILED_CODE } from "../services/reusable-sandbox-resume-error.ts";
import { retireReplacedReusableSandboxLease, reusableSandboxReplacementIsSafe } from "../services/reusable-sandbox-resume-replacement.ts";

vi.mock("../services/native-runtime/native-harness-backup-storage.js", () => ({
  verifyRecoverableNativeHarnessBackup: vi.fn(async () => true),
}));

const support = await getEmbeddedPostgresTestSupport();
const REFUSAL = "Daytona sandbox is still stopping at its start deadline";

describe.skipIf(!support.supported)("sandbox that holds files from an abandoned workspace epoch", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let connectionString: string;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("abandoned-workspace-files-hold");
    stopDb = started.cleanup;
    connectionString = started.connectionString;
  });
  beforeEach(() => { db = createDb(connectionString); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(activityLog);
    await db.delete(executionWorkspaceSnapshots);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(executionWorkspaces);
    await db.delete(plugins);
    await db.delete(projects);
    await db.delete(companies);
    await db.$client.end({ timeout: 1 });
  });
  afterAll(async () => { await stopDb?.(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID(), pluginId = randomUUID();
    const abandonedRunId = randomUUID(), runId = randomUUID(), projectId = randomUUID(), issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const providerLeaseId = randomUUID();
    const providerConfig = { provider: "fake-plugin", image: "fake:test", timeoutMs: 300_000, reuseLease: true };
    await db.insert(companies).values({ id: companyId, name: "Acme", status: "active", issuePrefix: `H${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "active",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Repair", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(environments).values({ id: environmentId, name: "Paperclip Sandbox", driver: "sandbox", status: "active",
      config: providerConfig });
    await db.insert(plugins).values({
      id: pluginId, pluginKey: "acme.hold-provider", packageName: "@acme/hold-provider",
      version: "1.0.0", apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1, updatedAt: new Date(),
      manifestJson: {
        id: "acme.hold-provider", apiVersion: 1, version: "1.0.0", displayName: "Hold Provider",
        description: "Test provider", author: "Paperclip", categories: ["automation"],
        capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "fake-plugin", kind: "sandbox_provider", displayName: "Fake Plugin",
          supportsReusableLeases: true,
          configSchema: { type: "object", properties: { image: { type: "string" }, timeoutMs: { type: "number" }, reuseLease: { type: "boolean" } } } }],
      },
    } as never);
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", status: "active" });
    await db.insert(executionWorkspaces).values({ id: executionWorkspaceId, companyId, projectId, mode: "isolated_workspace",
      strategyType: "project_primary", name: "Task workspace", status: "active", providerType: "cloud_sandbox",
      cwd: `/workspaces/${executionWorkspaceId}`, sourceIssueId: issueId });
    await db.insert(heartbeatRuns).values([
      { id: abandonedRunId, companyId, agentId, issueId, invocationSource: "assignment", status: "running" },
      { id: runId, companyId, agentId, issueId, invocationSource: "assignment", status: "running" },
    ]);
    const environment: Environment = { id: environmentId, name: "Paperclip Sandbox", description: null, driver: "sandbox",
      status: "active", config: providerConfig, envVars: {}, metadata: null, createdAt: new Date(), updatedAt: new Date() };
    const priming = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true,
      call: async (_pluginId: string, method: string) => {
        if (method !== "environmentAcquireLease") throw new Error(`Unexpected plugin method: ${method}`);
        return { providerLeaseId, metadata: { ...providerConfig, sandboxId: providerLeaseId, remoteCwd: "/home/daytona/paperclip-workspace" } };
      },
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager });
    const created = await priming.acquireRunLease({ companyId, environment, issueId, agentId, adapterType: "paperclip_runner",
      heartbeatRunId: abandonedRunId, persistedExecutionWorkspace: { id: executionWorkspaceId, mode: "isolated_workspace" } });
    await db.update(environmentLeases).set({ status: "retained" }).where(eq(environmentLeases.id, created.lease.id));
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, abandonedRunId));
    const snapshotId = randomUUID();
    await db.insert(executionWorkspaceSnapshots).values({ id: snapshotId, companyId, executionWorkspaceId,
      sourceOperationId: randomUUID(), sourceRunId: abandonedRunId, generation: 1, epoch: 1, status: "committed" });
    const location = { environmentId, leaseId: created.lease.id, providerLeaseId,
      remoteCwd: "/home/daytona/paperclip-workspace/.paperclip-workspaces/abandoned" };
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: {
      schema: "paperclip.remote-workspace.v1", epoch: 1, snapshotId, source: { kind: "empty" },
      writerRunId: abandonedRunId, dirty: true, location } } }).where(eq(executionWorkspaces.id, executionWorkspaceId));
    const lease = (await environmentService(db).getLeaseById(created.lease.id))!;
    return { companyId, agentId, issueId, environment, pluginId, abandonedRunId, runId, executionWorkspaceId,
      lease, providerLeaseId, snapshotId, location };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  async function abandon(seeded: Seeded) {
    await db.transaction(tx => abandonUnverifiedRemoteWorkspaceEpoch(tx, { companyId: seeded.companyId,
      workspaceId: seeded.executionWorkspaceId, runId: seeded.abandonedRunId, epoch: 1, snapshotId: seeded.snapshotId,
      location: seeded.location }));
    await reserveFor(seeded, seeded.runId);
  }

  async function reserveFor(seeded: Seeded, runId: string) {
    const workspace = await readWorkspace(seeded);
    await db.update(executionWorkspaces).set({ metadata: { ...workspace.metadata,
      remoteWorkspace: { ...(workspace.metadata!.remoteWorkspace as Record<string, unknown>), writerRunId: runId } } })
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
  }

  async function readWorkspace(seeded: Seeded) {
    return (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, seeded.executionWorkspaceId)))[0]!;
  }

  async function setReceipts(seeded: Seeded, patch: (receipt: Record<string, unknown>) => Record<string, unknown>) {
    const workspace = await readWorkspace(seeded);
    const receipts = workspace.metadata!.remoteWorkspaceAbandonedEpochs as Array<Record<string, unknown>>;
    await db.update(executionWorkspaces).set({ metadata: { ...workspace.metadata,
      remoteWorkspaceAbandonedEpochs: receipts.map(patch) } }).where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
  }

  function worker(seeded: Seeded) {
    const call = vi.fn(async (_pluginId: string, method: string) => {
      if (method === "environmentResumeLease") throw new JsonRpcCallError({ code: -32000, message: REFUSAL });
      if (method === "environmentAcquireLease") {
        return { providerLeaseId: "replacement-sandbox", metadata: { provider: "fake-plugin", image: "fake:test",
          timeoutMs: 300_000, reuseLease: true, remoteCwd: "/home/daytona/paperclip-workspace" } };
      }
      if (method === "environmentDestroyLease" || method === "environmentReleaseLease") return {};
      throw new Error(`Unexpected plugin method: ${method}`);
    });
    const manager = { isRunning: vi.fn((id: string) => id === seeded.pluginId), call,
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    return { call, runtime: environmentRuntimeService(db, { pluginWorkerManager: manager }) };
  }

  function acquire(seeded: Seeded, runtime: ReturnType<typeof environmentRuntimeService>) {
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 40_000));
    return runtime.acquireRunLease({ companyId: seeded.companyId, environment: seeded.environment, issueId: seeded.issueId,
      agentId: seeded.agentId, adapterType: "paperclip_runner", heartbeatRunId: seeded.runId,
      persistedExecutionWorkspace: { id: seeded.executionWorkspaceId, mode: "isolated_workspace" } });
  }

  async function leaseRow(seeded: Seeded) {
    return (await environmentService(db).getLeaseById(seeded.lease.id))!;
  }

  function destroyCalls(call: ReturnType<typeof worker>["call"]) {
    return call.mock.calls.filter(([, method]) => method === "environmentDestroyLease");
  }

  it("refuses to replace the sandbox after a failed resume and keeps it out of cleanup", async () => {
    const seeded = await seed();
    await abandon(seeded);
    const { call, runtime } = worker(seeded);

    await expect(acquire(seeded, runtime)).rejects.toMatchObject({ code: REUSABLE_SANDBOX_RESUME_FAILED_CODE });

    expect(await leaseRow(seeded)).toMatchObject({ status: "retained", providerLeaseId: seeded.providerLeaseId });
    expect(await nativeWorkspaceExportPendingForLease(db, seeded.lease)).toBe(true);
    await expect(runtime.destroyRunLease({ environment: seeded.environment, lease: await leaseRow(seeded),
      failureReason: "pending_cleanup_retry" })).resolves.toBeNull();
    expect(destroyCalls(call)).toEqual([]);
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.status, "pending_cleanup"))).toEqual([]);
  });

  it("parks a held lease as retained when it is retired anyway", async () => {
    const seeded = await seed();
    await abandon(seeded);
    expect(await retireReplacedReusableSandboxLease({ db, lease: seeded.lease as EnvironmentLease,
      companyId: seeded.companyId, heartbeatRunId: seeded.runId })).toBe(true);
    expect(await leaseRow(seeded)).toMatchObject({ status: "retained" });
  });

  it("treats a receipt written before release fields existed as unreleased", async () => {
    const seeded = await seed();
    await abandon(seeded);
    await setReceipts(seeded, ({ retainUntil: _retainUntil, released: _released, ...receipt }) => receipt);
    expect(await reusableSandboxReplacementIsSafe({ db, lease: seeded.lease as EnvironmentLease, companyId: seeded.companyId,
      heartbeatRunId: seeded.runId, executionWorkspaceId: seeded.executionWorkspaceId, adapterType: "paperclip_runner",
      cause: new Error(REFUSAL) })).toBe(false);
  });

  it("replaces and cleans the sandbox as before when the receipt names a different sandbox", async () => {
    const seeded = await seed();
    await abandon(seeded);
    await setReceipts(seeded, receipt => ({ ...receipt,
      location: { ...(receipt.location as Record<string, unknown>), providerLeaseId: "another-sandbox" } }));
    const { runtime } = worker(seeded);
    const acquired = await acquire(seeded, runtime);
    expect(acquired.lease.providerLeaseId).toBe("replacement-sandbox");
    expect(await leaseRow(seeded)).toMatchObject({ status: "pending_cleanup", failureReason: "resume_failed" });
    expect(await nativeWorkspaceExportPendingForLease(db, seeded.lease)).toBe(false);
  });

  it("replaces and cleans the sandbox as before when no epoch was abandoned", async () => {
    const seeded = await seed();
    const workspace = await readWorkspace(seeded);
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: {
      ...(workspace.metadata!.remoteWorkspace as Record<string, unknown>), epoch: 2, dirty: false, writerRunId: seeded.runId } } })
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    const { runtime } = worker(seeded);
    const acquired = await acquire(seeded, runtime);
    expect(acquired.lease.providerLeaseId).toBe("replacement-sandbox");
    expect(await leaseRow(seeded)).toMatchObject({ status: "pending_cleanup" });
  });

  it("replaces and cleans the sandbox once the receipt is released", async () => {
    const seeded = await seed();
    await abandon(seeded);
    await setReceipts(seeded, receipt => ({ ...receipt,
      released: { reason: "discarded", releasedAt: new Date().toISOString(), actorType: "user", actorId: "board-user" } }));
    const { runtime } = worker(seeded);
    const acquired = await acquire(seeded, runtime);
    expect(acquired.lease.providerLeaseId).toBe("replacement-sandbox");
    expect(await leaseRow(seeded)).toMatchObject({ status: "pending_cleanup" });
  });
});
