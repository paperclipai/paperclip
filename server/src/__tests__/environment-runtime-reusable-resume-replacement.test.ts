import { JsonRpcCallError, environmentResumeErrorData } from "@paperclipai/plugin-sdk";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaceSnapshots,
  executionWorkspaces,
  heartbeatRuns,
  plugins,
  projects,
} from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { environmentService } from "../services/environments.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

// Durable harness-backup verification has its own tests. Here it is a boundary:
// a lease-bound stamp verifies, a missing stamp (an older release's lease) does not.
vi.mock("../services/native-runtime/native-harness-backup-storage.js", () => ({
  verifyRecoverableNativeHarnessBackup: vi.fn(async (input: { stamp: unknown; providerLeaseId: string }) =>
    Boolean(input.stamp && (input.stamp as { authorizedProviderLeaseId?: unknown }).authorizedProviderLeaseId === input.providerLeaseId)),
}));

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ENVIRONMENT_RUNTIME_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// The staging failure: Daytona kept the idle sandbox in a state transition past
// its five-minute start deadline, and the worker reported it with no status.
const STAGING_REFUSAL = "Daytona sandbox 0f6c1e52-3d1a-4b7e-9c2a-5e8f7a1b2c3d is still stopping at its start deadline";

describeEmbeddedPostgres("reusable sandbox resume failure replacement", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let connectionString: string;

  beforeAll(async () => {
    if (externalTestDatabaseUrl) connectionString = externalTestDatabaseUrl;
    else {
      const started = await startEmbeddedPostgresTestDatabase("environment-runtime-resume-replacement");
      stopDb = started.cleanup;
      connectionString = started.connectionString;
    }
  });
  beforeEach(() => { db = createDb(connectionString); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(executionWorkspaceSnapshots);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(executionWorkspaces);
    await db.delete(plugins);
    await db.delete(projects);
    await db.delete(companies);
    await db.$client.end({ timeout: 1 });
  });
  afterAll(async () => { await stopDb?.(); });

  type Shape = {
    leaseStatus?: "retained" | "released";
    previousRunStatus?: "succeeded" | "running";
    dirty?: boolean;
    snapshot?: "committed" | "pending" | null;
    backupStamp?: boolean;
  };

  async function seed(shape: Shape = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const pluginId = randomUUID();
    const previousRunId = randomUUID();
    const runId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const providerLeaseId = "0f6c1e52-3d1a-4b7e-9c2a-5e8f7a1b2c3d";
    // The staging environment's provider settings, including its 300s start deadline.
    const providerConfig = { provider: "fake-plugin", image: "fake:test", timeoutMs: 300_000, reuseLease: true };
    await db.insert(companies).values({ id: companyId, name: "Acme", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "active",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: "Paperclip Sandbox", driver: "sandbox", status: "active",
      config: providerConfig });
    await db.insert(plugins).values({
      id: pluginId, pluginKey: "acme.reusable-sandbox-provider", packageName: "@acme/reusable-sandbox-provider",
      version: "1.0.0", apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1, updatedAt: new Date(),
      manifestJson: {
        id: "acme.reusable-sandbox-provider", apiVersion: 1, version: "1.0.0", displayName: "Reusable Sandbox Provider",
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
      cwd: `/workspaces/${executionWorkspaceId}` });
    await db.insert(heartbeatRuns).values([
      { id: previousRunId, companyId, agentId, invocationSource: "assignment", status: "running" },
      { id: runId, companyId, agentId, invocationSource: "assignment", status: "running" },
    ]);
    const environment: Environment = { id: environmentId, name: "Paperclip Sandbox", description: null, driver: "sandbox",
      status: "active", config: providerConfig, envVars: {}, metadata: null, createdAt: new Date(), updatedAt: new Date() };
    // The previous run creates the sandbox through the real acquisition path,
    // so the preserved lease carries exactly the identity production records.
    const priming = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true,
      call: async (_pluginId: string, method: string) => {
        if (method !== "environmentAcquireLease") throw new Error(`Unexpected plugin method: ${method}`);
        return { providerLeaseId, metadata: { ...providerConfig, sandboxId: providerLeaseId, remoteCwd: "/home/daytona/paperclip-workspace" } };
      },
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager });
    const created = await priming.acquireRunLease({ companyId, environment, issueId: null, agentId, adapterType: "paperclip_runner",
      heartbeatRunId: previousRunId, persistedExecutionWorkspace: { id: executionWorkspaceId, mode: "isolated_workspace" } });
    // The run then ended after a clean final save and left its lease-bound
    // harness backup stamp. A lease saved by an older release has no
    // acquisition outcome and may predate the backup stamp.
    const { sandboxLeaseAcquisition: _outcome, ...metadata } = created.lease.metadata ?? {};
    const lease = (await environmentService(db).updateLeaseMetadata(created.lease.id, {
      ...(shape.leaseStatus === "released" ? metadata : created.lease.metadata),
      remoteWorkspaceId: executionWorkspaceId,
      ...(shape.backupStamp === false ? {} : { nativeHarnessBackup: {
        schema: "paperclip.native-harness-backup-stamp.v2", sourceProviderLeaseId: providerLeaseId,
        authorizedProviderLeaseId: providerLeaseId,
      } }),
    }))!;
    await db.update(environmentLeases).set({ status: shape.leaseStatus ?? "retained" }).where(eq(environmentLeases.id, lease.id));
    await db.update(heartbeatRuns).set({ status: shape.previousRunStatus ?? "succeeded" }).where(eq(heartbeatRuns.id, previousRunId));
    const snapshotId = randomUUID();
    if (shape.snapshot !== null) {
      await db.insert(executionWorkspaceSnapshots).values({ id: snapshotId, companyId, executionWorkspaceId,
        sourceOperationId: randomUUID(), sourceRunId: previousRunId, generation: 1, epoch: 1, status: shape.snapshot ?? "committed" });
    }
    // This run already holds the workspace writer slot (reserved before the
    // environment is acquired); the saved version is the previous run's save.
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: {
      schema: "paperclip.remote-workspace.v1", epoch: 2, snapshotId: shape.snapshot === null ? null : snapshotId,
      source: { kind: "empty" }, writerRunId: runId, dirty: shape.dirty ?? false,
      location: { environmentId, leaseId: lease.id, providerLeaseId, remoteCwd: "/home/daytona/paperclip-workspace/.paperclip-workspaces/w" },
    } } }).where(eq(executionWorkspaces.id, executionWorkspaceId));
    return { companyId, agentId, environment, pluginId, runId, executionWorkspaceId, lease, providerLeaseId };
  }

  function worker(seeded: Awaited<ReturnType<typeof seed>>, resume: (attempt: number, timeoutMs: number) => Promise<unknown>,
    options: { acquireFails?: boolean } = {}) {
    let attempts = 0;
    const call = vi.fn(async (_pluginId: string, method: string, _params: unknown, timeoutMs?: number) => {
      if (method === "environmentResumeLease") return await resume(++attempts, timeoutMs ?? 0);
      if (method === "environmentAcquireLease") {
        if (options.acquireFails) throw new JsonRpcCallError({ code: -32000, message: "create refused" });
        return { providerLeaseId: "replacement-sandbox", metadata: { provider: "fake-plugin", image: "fake:test",
          timeoutMs: 300_000, reuseLease: true, remoteCwd: "/home/daytona/paperclip-workspace" } };
      }
      throw new Error(`Unexpected plugin method: ${method}`);
    });
    const manager = { isRunning: vi.fn((id: string) => id === seeded.pluginId), call,
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    return { call, runtime: environmentRuntimeService(db, { pluginWorkerManager: manager }) };
  }

  function acquire(seeded: Awaited<ReturnType<typeof seed>>, runtime: ReturnType<typeof environmentRuntimeService>,
    runId = seeded.runId) {
    return runtime.acquireRunLease({ companyId: seeded.companyId, environment: seeded.environment, issueId: null,
      agentId: seeded.agentId, adapterType: "paperclip_runner", heartbeatRunId: runId,
      persistedExecutionWorkspace: { id: seeded.executionWorkspaceId, mode: "isolated_workspace" } });
  }

  // Each refused resume consumes 40s of the run's clock, so the in-run retry
  // budget is exercised without real waiting.
  function stepClock() {
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    return () => { clock += 40_000; };
  }

  it("replaces a clean, saved sandbox that keeps refusing to resume, within a bounded budget (staging shape)", async () => {
    const seeded = await seed();
    const step = stepClock();
    const { call, runtime } = worker(seeded, async () => {
      step();
      throw new JsonRpcCallError({ code: -32000, message: STAGING_REFUSAL });
    });

    const acquired = await acquire(seeded, runtime);

    expect(acquired.lease.providerLeaseId).toBe("replacement-sandbox");
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "replacement", reason: "resume_failed" });
    const resumes = call.mock.calls.filter(([, method]) => method === "environmentResumeLease");
    // Retried inside the run, then stopped well short of the five-minute deadline.
    expect(resumes.length).toBeGreaterThan(1);
    for (const [, , , timeoutMs] of resumes) expect(timeoutMs).toBeLessThanOrEqual(90_000);
    // The old sandbox is handed to the cleanup sweep; no synchronous destroy
    // delays the first turn.
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentDestroyLease", expect.anything(), expect.anything());
    await expect(environmentService(db).getLeaseById(seeded.lease.id)).resolves.toMatchObject({
      status: "pending_cleanup", cleanupStatus: "failed", failureReason: "resume_failed",
    });
  });

  it("keeps the preserved lease when the replacement cannot be created, so the next attempt replaces it", async () => {
    const seeded = await seed();
    const refuse = async () => { throw new JsonRpcCallError({ code: -32000, message: STAGING_REFUSAL }); };
    const step = stepClock();
    const failing = worker(seeded, async () => { step(); return await refuse(); }, { acquireFails: true });
    await expect(acquire(seeded, failing.runtime)).rejects.toThrow();
    await expect(environmentService(db).getLeaseById(seeded.lease.id)).resolves.toMatchObject({
      status: "retained", providerLeaseId: seeded.providerLeaseId,
    });

    // The bounded retry runs as a new run that reserves the same clean workspace.
    const retryRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: retryRunId, companyId: seeded.companyId, agentId: seeded.agentId,
      invocationSource: "assignment", status: "running" });
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, seeded.runId));
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    await db.update(executionWorkspaces).set({ metadata: { ...workspace!.metadata,
      remoteWorkspace: { ...(workspace!.metadata!.remoteWorkspace as Record<string, unknown>), writerRunId: retryRunId } } })
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    const retry = worker(seeded, async () => { step(); return await refuse(); });
    const acquired = await acquire(seeded, retry.runtime, retryRunId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "replacement", reason: "resume_failed" });
    // The replacement carries the verified harness backup, so the session restores
    // without waiting for the old sandbox to be deleted.
    expect(acquired.lease.metadata?.nativeHarnessBackup).toMatchObject({ authorizedProviderLeaseId: seeded.providerLeaseId });
    await expect(environmentService(db).getLeaseById(seeded.lease.id)).resolves.toMatchObject({ status: "pending_cleanup" });
  });

  it("replaces a released lease saved by an older release in the same way", async () => {
    const seeded = await seed({ leaseStatus: "released" });
    const step = stepClock();
    const { runtime } = worker(seeded, async () => {
      step();
      throw new JsonRpcCallError({ code: -32000, message: "Sandbox state change in progress",
        data: environmentResumeErrorData(Object.assign(new Error("private"), { statusCode: 409 })) });
    });
    const acquired = await acquire(seeded, runtime);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "replacement", reason: "resume_failed" });
  });

  // Staging: a run could not retire its predecessor's warm
  // Runner on this sandbox, did no provider work, and asked for a fresh one.
  async function markReplaceBeforeReuse(seeded: Awaited<ReturnType<typeof seed>>) {
    await environmentService(db).updateLeaseMetadata(seeded.lease.id, { ...seeded.lease.metadata,
      replaceBeforeReuse: { schema: "paperclip.replace-before-reuse.v1", runId: randomUUID(), predecessorRunId: randomUUID(),
        recordedAt: new Date().toISOString() } });
  }

  it("replaces a resumable sandbox whose previous Runner could not be retired, without resuming it", async () => {
    const seeded = await seed();
    await markReplaceBeforeReuse(seeded);
    const { call, runtime } = worker(seeded, async () => ({ providerLeaseId: seeded.providerLeaseId,
      metadata: { remoteCwd: "/home/daytona/paperclip-workspace" } }));
    const acquired = await acquire(seeded, runtime);
    expect(acquired.lease.providerLeaseId).toBe("replacement-sandbox");
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "replacement", reason: "resume_failed",
      cause: "native_predecessor_retirement_unproven" });
    // The new sandbox restores the saved session from the verified backup.
    expect(acquired.lease.metadata?.nativeHarnessBackup).toMatchObject({ authorizedProviderLeaseId: seeded.providerLeaseId });
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentResumeLease", expect.anything(), expect.anything());
    // The old sandbox, with the Runner on it, is kept for the cleanup sweep.
    await expect(environmentService(db).getLeaseById(seeded.lease.id)).resolves.toMatchObject({ status: "pending_cleanup" });
  });

  it.each([
    ["unsaved work on the sandbox", { dirty: true }],
    ["no verified harness backup", { backupStamp: false }],
  ] as Array<[string, Shape]>)("resumes a sandbox marked for replacement as before when it holds %s", async (_label, shape) => {
    const seeded = await seed(shape);
    await markReplaceBeforeReuse(seeded);
    const { runtime } = worker(seeded, async () => ({ providerLeaseId: seeded.providerLeaseId,
      metadata: { remoteCwd: "/home/daytona/paperclip-workspace" } }));
    const acquired = await acquire(seeded, runtime);
    expect(acquired.lease.providerLeaseId).toBe(seeded.providerLeaseId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
  });

  it("retries a sandbox state change inside the run and resumes the same sandbox", async () => {
    const seeded = await seed();
    const { call, runtime } = worker(seeded, async (attempt) => {
      if (attempt === 1) throw new JsonRpcCallError({ code: -32000, message: "Sandbox state change in progress" });
      return { providerLeaseId: seeded.providerLeaseId, metadata: { remoteCwd: "/home/daytona/paperclip-workspace" } };
    });
    const acquired = await acquire(seeded, runtime);
    expect(acquired.lease.providerLeaseId).toBe(seeded.providerLeaseId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
    expect(call.mock.calls.filter(([, method]) => method === "environmentResumeLease")).toHaveLength(2);
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentAcquireLease", expect.anything(), expect.anything());
  });

  it.each([
    ["unsaved work on the sandbox", { dirty: true }, undefined],
    ["no saved workspace version", { snapshot: null }, undefined],
    ["a saved version that never committed", { snapshot: "pending" }, undefined],
    ["a live owner", { previousRunStatus: "running" }, undefined],
    ["no verified harness backup (older lease)", { backupStamp: false }, undefined],
    ["a provider access refusal", {}, 403],
  ] as Array<[string, Shape, number | undefined]>)("keeps the sandbox and fails strictly with %s", async (_label, shape, status) => {
    const seeded = await seed(shape);
    const step = stepClock();
    const { call, runtime } = worker(seeded, async () => {
      step();
      throw new JsonRpcCallError({ code: -32000, message: STAGING_REFUSAL,
        ...(status ? { data: environmentResumeErrorData(Object.assign(new Error("private"), { statusCode: status })) } : {}) });
    });
    await expect(acquire(seeded, runtime)).rejects.toThrow(
      /could not be resumed \(cause=sandbox_state_transition( status=403)?\); the lease was preserved and no replacement was created\.$/,
    );
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentAcquireLease", expect.anything(), expect.anything());
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentDestroyLease", expect.anything(), expect.anything());
    await expect(environmentService(db).getLeaseById(seeded.lease.id)).resolves.toMatchObject({
      status: shape.leaseStatus ?? "retained", providerLeaseId: seeded.providerLeaseId,
    });
  });

  function rpcTimeoutClock() {
    let clock = Date.now();
    const startedAt = clock;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    return {
      elapsed: () => clock - startedAt,
      timeOut: (timeoutMs: number) => {
        clock += timeoutMs;
        return new JsonRpcCallError({ code: -32003,
          message: `RPC call "environmentResumeLease" timed out after ${timeoutMs}ms` });
      },
    };
  }

  it("keeps waiting for an idle sandbox whose resume timed out and resumes it in the same run (staging shape)", async () => {
    const seeded = await seed({ leaseStatus: "released", dirty: true });
    const clock = rpcTimeoutClock();
    const { call, runtime } = worker(seeded, async (attempt, timeoutMs) => {
      if (attempt === 1) throw clock.timeOut(timeoutMs);
      return { providerLeaseId: seeded.providerLeaseId, metadata: { remoteCwd: "/home/daytona/paperclip-workspace" } };
    });

    const acquired = await acquire(seeded, runtime);

    expect(acquired.lease.providerLeaseId).toBe(seeded.providerLeaseId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
    const resumes = call.mock.calls.filter(([, method]) => method === "environmentResumeLease");
    expect(resumes).toHaveLength(2);
    for (const [, , , timeoutMs] of resumes) expect(timeoutMs).toBeLessThanOrEqual(90_000);
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentAcquireLease", expect.anything(), expect.anything());
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentDestroyLease", expect.anything(), expect.anything());
  });

  it("waits out the in-flight resume when a retry finds the stopped sandbox still settling", async () => {
    const seeded = await seed({ leaseStatus: "released", dirty: true });
    const clock = rpcTimeoutClock();
    const { call, runtime } = worker(seeded, async (attempt, timeoutMs) => {
      if (attempt === 1) throw clock.timeOut(timeoutMs);
      if (attempt === 2) throw new JsonRpcCallError({ code: -32000,
        message: "The stopped Daytona sandbox is still settling cancelled work. Retry shortly." });
      return { providerLeaseId: seeded.providerLeaseId, metadata: { remoteCwd: "/home/daytona/paperclip-workspace" } };
    });

    const acquired = await acquire(seeded, runtime);

    expect(acquired.lease.providerLeaseId).toBe(seeded.providerLeaseId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
    expect(call.mock.calls.filter(([, method]) => method === "environmentResumeLease")).toHaveLength(3);
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentAcquireLease", expect.anything(), expect.anything());
  });

  it("stops waiting at the provider start deadline and keeps the sandbox when every resume times out", async () => {
    const seeded = await seed({ leaseStatus: "released", dirty: true });
    const clock = rpcTimeoutClock();
    const { call, runtime } = worker(seeded, async (_attempt, timeoutMs) => { throw clock.timeOut(timeoutMs); });

    await expect(acquire(seeded, runtime)).rejects.toThrow(
      /could not be resumed \(cause=transport_timeout\); the lease was preserved and no replacement was created\.$/,
    );

    expect(call.mock.calls.filter(([, method]) => method === "environmentResumeLease").length).toBeGreaterThan(1);
    expect(clock.elapsed()).toBeLessThanOrEqual(330_000);
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentAcquireLease", expect.anything(), expect.anything());
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentDestroyLease", expect.anything(), expect.anything());
    await expect(environmentService(db).getLeaseById(seeded.lease.id)).resolves.toMatchObject({
      status: "released", providerLeaseId: seeded.providerLeaseId,
    });
  });

  it("continues on a new sandbox and keeps the old one when an idle sandbox never starts and has no harness backup (staging shape)", async () => {
    const seeded = await seed({ leaseStatus: "released", backupStamp: false });
    const clock = rpcTimeoutClock();
    const { call, runtime } = worker(seeded, async (_attempt, timeoutMs) => { throw clock.timeOut(timeoutMs); });

    const acquired = await acquire(seeded, runtime);

    expect(acquired.lease.providerLeaseId).toBe("replacement-sandbox");
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "replacement", reason: "resume_failed" });
    expect(acquired.lease.metadata?.nativeHarnessBackup).toBeUndefined();
    expect(call.mock.calls.filter(([, method]) => method === "environmentResumeLease").length).toBeGreaterThan(1);
    expect(clock.elapsed()).toBeLessThanOrEqual(330_000);
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentDestroyLease", expect.anything(), expect.anything());
    const kept = await environmentService(db).getLeaseById(seeded.lease.id);
    expect(kept).toMatchObject({ status: "released", providerLeaseId: seeded.providerLeaseId, cleanupStatus: null });
    expect(kept?.metadata?.reusableSandboxKeptAfterReplacement).toMatchObject({
      runId: seeded.runId, replacementLeaseId: acquired.lease.id,
    });

    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: seeded.companyId, agentId: seeded.agentId,
      invocationSource: "assignment", status: "running" });
    await environmentService(db).releaseLease(acquired.lease.id, "released");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, seeded.runId));
    const next = worker(seeded, async () => ({ providerLeaseId: "replacement-sandbox",
      metadata: { remoteCwd: "/home/daytona/paperclip-workspace" } }));
    const resumed = await acquire(seeded, next.runtime, nextRunId);
    expect(resumed.lease.providerLeaseId).toBe("replacement-sandbox");
    const nextResumes = next.call.mock.calls.filter(([, method]) => method === "environmentResumeLease");
    expect(nextResumes).toHaveLength(1);
    expect(nextResumes[0]![2]).toMatchObject({ providerLeaseId: "replacement-sandbox" });
    await expect(environmentService(db).getLeaseById(seeded.lease.id)).resolves.toMatchObject({
      status: "released", providerLeaseId: seeded.providerLeaseId,
    });
  });

  it("never destroys a sandbox kept after replacement through the run or workspace teardown paths", async () => {
    const seeded = await seed({ leaseStatus: "released", backupStamp: false });
    const clock = rpcTimeoutClock();
    const { call, runtime } = worker(seeded, async (_attempt, timeoutMs) => { throw clock.timeOut(timeoutMs); });
    const acquired = await acquire(seeded, runtime);
    await environmentService(db).releaseLease(acquired.lease.id, "released");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, seeded.runId));
    const kept = (await environmentService(db).getLeaseById(seeded.lease.id))!;

    await expect(runtime.destroyRunLease({ environment: seeded.environment, lease: kept })).resolves.toBeNull();
    const destroyed = await runtime.destroyReusableSandboxLeases({ companyId: seeded.companyId,
      executionWorkspaceId: seeded.executionWorkspaceId });

    expect(destroyed.map(record => record.lease.id)).toEqual([acquired.lease.id]);
    expect(call.mock.calls.filter(([, method, params]) => method === "environmentDestroyLease"
      && (params as { providerLeaseId?: string }).providerLeaseId === seeded.providerLeaseId)).toHaveLength(0);
    await expect(environmentService(db).getLeaseById(seeded.lease.id)).resolves.toMatchObject({
      status: "released", providerLeaseId: seeded.providerLeaseId,
    });
  });

  it("destroys a sandbox kept after replacement when an operator approves the environment delete", async () => {
    const seeded = await seed({ leaseStatus: "released", backupStamp: false });
    const clock = rpcTimeoutClock();
    const { runtime } = worker(seeded, async (_attempt, timeoutMs) => { throw clock.timeOut(timeoutMs); });
    const acquired = await acquire(seeded, runtime);
    await environmentService(db).releaseLease(acquired.lease.id, "released");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, seeded.runId));

    const teardown = worker(seeded, async () => { throw new Error("no resume during delete"); });
    teardown.call.mockImplementation(async (_pluginId: string, method: string, params: unknown) => {
      if (method === "environmentDestroyLease") return { providerLeaseId: (params as { providerLeaseId: string }).providerLeaseId };
      throw new Error(`Unexpected plugin method: ${method}`);
    });
    const result = await teardown.runtime.destroyReusableSandboxLeasesForEnvironment({
      environmentId: seeded.environment.id, consentedBy: "operator" });

    expect(result).toMatchObject({ destroyed: 2, failed: 0 });
    expect(teardown.call.mock.calls.filter(([, method, params]) => method === "environmentDestroyLease"
      && (params as { providerLeaseId?: string }).providerLeaseId === seeded.providerLeaseId)).toHaveLength(1);
    const deleted = await environmentService(db).getLeaseById(seeded.lease.id);
    expect(deleted?.status).not.toBe("pending_cleanup");
    expect(deleted?.metadata?.reusableSandboxKeptAfterReplacement).toBeUndefined();
  });

  it("keeps an idle sandbox with no harness backup when some resume calls failed for another reason", async () => {
    const seeded = await seed({ leaseStatus: "released", backupStamp: false });
    const clock = rpcTimeoutClock();
    const { call, runtime } = worker(seeded, async (attempt, timeoutMs) => {
      if (attempt === 1) throw clock.timeOut(timeoutMs);
      throw Object.assign(clock.timeOut(timeoutMs), { message: "connection reset by peer (ECONNRESET)" });
    });

    await expect(acquire(seeded, runtime)).rejects.toThrow(/the lease was preserved and no replacement was created\.$/);
    expect(call.mock.calls.filter(([, method]) => method === "environmentResumeLease").length).toBeGreaterThan(1);
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentAcquireLease", expect.anything(), expect.anything());
    const kept = await environmentService(db).getLeaseById(seeded.lease.id);
    expect(kept?.metadata?.reusableSandboxKeptAfterReplacement).toBeUndefined();
  });

  it.each([
    ["unsaved work on the sandbox", { dirty: true }],
    ["no saved workspace version", { snapshot: null }],
  ] as Array<[string, Shape]>)("keeps an idle sandbox with no harness backup that never starts and fails strictly with %s", async (_label, shape) => {
    const seeded = await seed({ leaseStatus: "released", backupStamp: false, ...shape });
    const clock = rpcTimeoutClock();
    const { call, runtime } = worker(seeded, async (_attempt, timeoutMs) => { throw clock.timeOut(timeoutMs); });

    await expect(acquire(seeded, runtime)).rejects.toThrow(
      /could not be resumed \(cause=transport_timeout\); the lease was preserved and no replacement was created\.$/,
    );
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentAcquireLease", expect.anything(), expect.anything());
    const kept = await environmentService(db).getLeaseById(seeded.lease.id);
    expect(kept).toMatchObject({ status: "released", providerLeaseId: seeded.providerLeaseId });
    expect(kept?.metadata?.reusableSandboxKeptAfterReplacement).toBeUndefined();
  });

  it("does not extend the wait for a sandbox that a live run still holds", async () => {
    const seeded = await seed({ previousRunStatus: "running", dirty: true });
    const clock = rpcTimeoutClock();
    const { call, runtime } = worker(seeded, async (_attempt, timeoutMs) => { throw clock.timeOut(timeoutMs); });

    await expect(acquire(seeded, runtime)).rejects.toThrow(/could not be resumed \(cause=transport_timeout\)/);

    expect(call.mock.calls.filter(([, method]) => method === "environmentResumeLease")).toHaveLength(1);
    expect(clock.elapsed()).toBeLessThanOrEqual(90_000);
  });
});
