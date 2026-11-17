import { JsonRpcCallError } from "@paperclipai/plugin-sdk";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
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
import { retireReplacedReusableSandboxLease } from "../services/reusable-sandbox-resume-replacement.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { nextEnvironmentCleanupAt } from "../services/environment-cleanup-state.ts";
import { releasableRetainedOrphanCondition, settleRetainedOrphanSandbox } from "../services/environment-retained-orphan-settlement.ts";
import {
  ABANDONED_WORKSPACE_FILES_PARKED_KEY, ABANDONED_WORKSPACE_FILES_PARKED_REASON, ABANDONED_WORKSPACE_FILES_RETENTION_DAYS,
  expireAbandonedWorkspaceFileHolds, nextAbandonedWorkspaceFileHoldExpiryAt, releaseAbandonedWorkspaceFiles,
} from "../services/remote-workspace-abandoned-files-hold.ts";

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
    const call = vi.fn(async (_pluginId: string, method: string, _params?: unknown) => {
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

  async function sweep(runtime: ReturnType<typeof environmentRuntimeService>) {
    return await heartbeatService(db, { environmentRuntime: runtime as never }).sweepPendingCleanupLeases({ backoffMs: 0 });
  }

  async function newRun(seeded: Seeded) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: seeded.companyId, agentId: seeded.agentId,
      issueId: seeded.issueId, invocationSource: "assignment", status: "running" });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, seeded.runId));
    await reserveFor(seeded, runId);
    return runId;
  }

  it("gives the next run a new sandbox at once and parks the held one, which cleanup and later runs leave alone", async () => {
    const seeded = await seed();
    await abandon(seeded);
    const { call, runtime } = worker(seeded);

    const acquired = await acquire(seeded, runtime);

    expect(acquired.lease.providerLeaseId).toBe("replacement-sandbox");
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "replacement", reason: "resume_failed" });
    const parked = await leaseRow(seeded);
    expect(parked).toMatchObject({ status: "retained", failureReason: ABANDONED_WORKSPACE_FILES_PARKED_REASON });
    expect(parked.metadata).toHaveProperty(ABANDONED_WORKSPACE_FILES_PARKED_KEY);
    expect(await nativeWorkspaceExportPendingForLease(db, seeded.lease)).toBe(true);

    await sweep(runtime);
    await expect(runtime.destroyRunLease({ environment: seeded.environment, lease: parked,
      failureReason: "pending_cleanup_retry" })).resolves.toBeNull();
    await expect(runtime.retryPendingSandboxTeardown({ environment: seeded.environment, lease: parked })).rejects.toThrow();
    expect(destroyCalls(call)).toEqual([]);
    expect(await leaseRow(seeded)).toMatchObject({ status: "retained" });

    await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.providerLeaseId, "replacement-sandbox"));
    const nextRunId = await newRun(seeded);
    const later = worker(seeded);
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 40_000));
    later.call.mockImplementation(async (_pluginId: string, method: string) => {
      if (method === "environmentResumeLease") return { providerLeaseId: "replacement-sandbox", metadata: { provider: "fake-plugin",
        image: "fake:test", timeoutMs: 300_000, reuseLease: true, remoteCwd: "/home/daytona/paperclip-workspace" } };
      throw new Error(`Unexpected plugin method: ${method}`);
    });
    const next = await later.runtime.acquireRunLease({ companyId: seeded.companyId, environment: seeded.environment,
      issueId: seeded.issueId, agentId: seeded.agentId, adapterType: "paperclip_runner", heartbeatRunId: nextRunId,
      persistedExecutionWorkspace: { id: seeded.executionWorkspaceId, mode: "isolated_workspace" } });
    expect(next.lease.providerLeaseId).toBe("replacement-sandbox");
    const resumed = later.call.mock.calls.filter(([, method]) => method === "environmentResumeLease");
    expect(resumed.map(([, , params]) => (params as { providerLeaseId: string }).providerLeaseId)).toEqual(["replacement-sandbox"]);
    expect(await leaseRow(seeded)).toMatchObject({ status: "retained" });
  });

  it("pulls a held lease already queued for cleanup back to retained, and leaves it on the provider", async () => {
    const seeded = await seed();
    await abandon(seeded);
    await db.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed", failureReason: "resume_failed" })
      .where(eq(environmentLeases.id, seeded.lease.id));
    const { call, runtime } = worker(seeded);
    await sweep(runtime);
    expect(destroyCalls(call)).toEqual([]);
    expect(await leaseRow(seeded)).toMatchObject({ status: "retained", failureReason: ABANDONED_WORKSPACE_FILES_PARKED_REASON });
  });

  it("treats a receipt written before release fields existed as unreleased", async () => {
    const seeded = await seed();
    await abandon(seeded);
    await setReceipts(seeded, ({ retainUntil: _retainUntil, released: _released, ...receipt }) => receipt);
    expect(await nativeWorkspaceExportPendingForLease(db, seeded.lease)).toBe(true);
    expect(await retireReplacedReusableSandboxLease({ db, lease: seeded.lease as EnvironmentLease,
      companyId: seeded.companyId, heartbeatRunId: seeded.runId })).toBe(true);
    expect(await leaseRow(seeded)).toMatchObject({ status: "retained" });
  });

  it("records a retention expiry on the receipt", async () => {
    const seeded = await seed();
    await abandon(seeded);
    const [receipt] = (await readWorkspace(seeded)).metadata!.remoteWorkspaceAbandonedEpochs as Array<Record<string, unknown>>;
    expect(Date.parse(receipt!.retainUntil as string) - Date.parse(receipt!.abandonedAt as string))
      .toBe(ABANDONED_WORKSPACE_FILES_RETENTION_DAYS * 86_400_000);
  });

  it.each([
    { reason: "recovered" as const, actorType: "system" as const, actorId: "workspace-recovery" },
    { reason: "discarded" as const, actorType: "user" as const, actorId: "board-user" },
  ])("hands the parked lease to normal cleanup once the files are $reason", async ({ reason, actorType, actorId }) => {
    const seeded = await seed();
    await abandon(seeded);
    const { call, runtime } = worker(seeded);
    await acquire(seeded, runtime);
    expect(await releaseAbandonedWorkspaceFiles(db, { companyId: seeded.companyId, workspaceId: seeded.executionWorkspaceId,
      epoch: 1, reason, actorType, actorId })).toBe(true);
    expect(await leaseRow(seeded)).toMatchObject({ status: "pending_cleanup" });
    vi.restoreAllMocks();
    await sweep(runtime);
    expect(destroyCalls(call).map(([, , params]) => (params as { providerLeaseId: string }).providerLeaseId))
      .toEqual([seeded.providerLeaseId]);
    expect(await leaseRow(seeded)).toMatchObject({ status: "expired" });
  });

  async function entries(action: string) {
    return await db.select().from(activityLog).where(eq(activityLog.action, action));
  }

  it("removes the files only after the retention period, and says removed only after the provider confirms it", async () => {
    const seeded = await seed();
    await abandon(seeded);
    const { call, runtime } = worker(seeded);
    await acquire(seeded, runtime);
    vi.restoreAllMocks();

    expect(await expireAbandonedWorkspaceFileHolds(db, new Date(Date.now() + 86_400_000))).toEqual({ expired: 0 });
    await sweep(runtime);
    expect(destroyCalls(call)).toEqual([]);
    expect(await entries("workspace.abandoned_files_released")).toEqual([]);

    expect(await expireAbandonedWorkspaceFileHolds(db, new Date(Date.now() + 8 * 86_400_000))).toEqual({ expired: 1 });
    const [released] = await entries("workspace.abandoned_files_released");
    expect(released).toMatchObject({ entityType: "issue", entityId: seeded.issueId, actorType: "system", actorId: "workspace-retention" });
    expect(released!.details).toMatchObject({ reason: "retention_expired",
      summary: "Unsaved files from an interrupted run were kept for 8 days, and their retention period has ended. They are scheduled for removal." });
    expect(await entries("workspace.abandoned_files_removed")).toEqual([]);

    await sweep(runtime);
    expect(destroyCalls(call)).toHaveLength(1);
    expect(await leaseRow(seeded)).toMatchObject({ status: "expired" });
    const [removed] = await entries("workspace.abandoned_files_removed");
    expect(removed).toMatchObject({ entityType: "issue", entityId: seeded.issueId, actorType: "system" });
    expect(removed!.details).toMatchObject({
      summary: "Unsaved files from an interrupted run were kept for 8 days and have now been removed." });
  });

  it("does not report removal when the provider delete fails", async () => {
    const seeded = await seed();
    await abandon(seeded);
    const { call, runtime } = worker(seeded);
    await acquire(seeded, runtime);
    vi.restoreAllMocks();
    await setReceipts(seeded, receipt => ({ ...receipt, retainUntil: new Date(Date.now() - 1_000).toISOString() }));
    call.mockImplementation(async (_pluginId: string, method: string) => {
      throw new Error(`provider refused ${method}`);
    });
    await sweep(runtime);
    expect(await entries("workspace.abandoned_files_released")).toHaveLength(1);
    expect(await entries("workspace.abandoned_files_removed")).toEqual([]);
    expect(await leaseRow(seeded)).toMatchObject({ status: "pending_cleanup" });
  });

  it("records the end of retention without scheduling removal when another receipt still holds the sandbox", async () => {
    const seeded = await seed();
    await abandon(seeded);
    const { call, runtime } = worker(seeded);
    await acquire(seeded, runtime);
    vi.restoreAllMocks();
    const workspace = await readWorkspace(seeded);
    const [first] = workspace.metadata!.remoteWorkspaceAbandonedEpochs as Array<Record<string, unknown>>;
    await db.update(executionWorkspaces).set({ metadata: { ...workspace.metadata, remoteWorkspaceAbandonedEpochs: [
      { ...first, retainUntil: new Date(Date.now() - 1_000).toISOString() },
      { ...first, epoch: 7, location: { ...(first!.location as Record<string, unknown>), remoteCwd: "/other-root" },
        retainUntil: new Date(Date.now() + 86_400_000).toISOString() },
    ] } }).where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    await sweep(runtime);
    const [ended] = await entries("workspace.abandoned_files_released");
    expect(ended).toMatchObject({ entityType: "issue", entityId: seeded.issueId, actorType: "system", actorId: "workspace-retention" });
    expect(ended!.details).toMatchObject({ reason: "retention_expired", leasesHandedToCleanup: 0,
      summary: expect.not.stringContaining("scheduled for removal") });
    expect((ended!.details as { summary: string }).summary).toContain("retention period has ended");
    expect(destroyCalls(call)).toEqual([]);
    expect(await leaseRow(seeded)).toMatchObject({ status: "retained" });
  });

  it("records the end of retention when it expires before the lease was ever parked", async () => {
    const seeded = await seed();
    await abandon(seeded);
    const { runtime } = worker(seeded);
    await setReceipts(seeded, receipt => ({ ...receipt, retainUntil: new Date(Date.now() - 1_000).toISOString() }));
    await sweep(runtime);
    const [ended] = await entries("workspace.abandoned_files_released");
    expect(ended).toMatchObject({ entityType: "issue", entityId: seeded.issueId, actorId: "workspace-retention" });
    expect(ended!.details).toMatchObject({ reason: "retention_expired", leasesHandedToCleanup: 0 });
    expect((ended!.details as { summary: string }).summary).not.toContain("scheduled for removal");
    expect(await entries("workspace.abandoned_files_removed")).toEqual([]);
  });

  it("releases a receipt whose run was deleted and records it without the run reference", async () => {
    const seeded = await seed();
    await abandon(seeded);
    await setReceipts(seeded, receipt => ({ ...receipt, runId: randomUUID(), retainUntil: new Date(Date.now() - 1_000).toISOString() }));
    expect(await expireAbandonedWorkspaceFileHolds(db)).toEqual({ expired: 1 });
    const [ended] = await entries("workspace.abandoned_files_released");
    expect(ended).toMatchObject({ entityType: "issue", entityId: seeded.issueId, runId: null });
    expect(await nativeWorkspaceExportPendingForLease(db, seeded.lease)).toBe(false);
  });

  it("releases a receipt whose task was deleted without writing a task entry", async () => {
    const seeded = await seed();
    await abandon(seeded);
    await setReceipts(seeded, receipt => ({ ...receipt, runId: randomUUID(), retainUntil: new Date(Date.now() - 1_000).toISOString() }));
    await db.update(executionWorkspaces).set({ sourceIssueId: null }).where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    expect(await expireAbandonedWorkspaceFileHolds(db)).toEqual({ expired: 1 });
    expect(await entries("workspace.abandoned_files_released")).toEqual([]);
    expect(await nativeWorkspaceExportPendingForLease(db, seeded.lease)).toBe(false);
  });

  it("keeps expiring later receipts when one fails, and retries the failed one after a backoff", async () => {
    const seeded = await seed();
    await abandon(seeded);
    await abandonOnOtherSandbox(seeded, "/later-root");
    await setReceipts(seeded, receipt => ({ ...receipt, retainUntil: new Date(Date.now() - 1_000).toISOString() }));
    await db.execute(sql`create function reject_abandoned_epoch_one() returns trigger language plpgsql as $$
      begin if new.details->>'abandonedEpoch' = '1' then raise exception 'test activity failure'; end if; return new; end $$`);
    await db.execute(sql`create trigger reject_abandoned_epoch_one before insert on activity_log
      for each row execute function reject_abandoned_epoch_one()`);
    try {
      const before = Date.now();
      expect(await expireAbandonedWorkspaceFileHolds(db)).toEqual({ expired: 1 });
      const receipts = (await readWorkspace(seeded)).metadata!.remoteWorkspaceAbandonedEpochs as Array<Record<string, unknown>>;
      const failed = receipts.find(receipt => receipt.epoch === 1)!;
      expect(failed.released).toBeUndefined();
      expect(failed.expiryAttempts).toBe(1);
      expect(receipts.find(receipt => receipt.epoch !== 1)!.released).toMatchObject({ reason: "retention_expired" });
      expect(await nativeWorkspaceExportPendingForLease(db, seeded.lease)).toBe(true);
      expect(await nextAbandonedWorkspaceFileHoldExpiryAt(db)).toBeGreaterThanOrEqual(before + 5 * 60_000);
    } finally {
      await db.execute(sql`drop trigger reject_abandoned_epoch_one on activity_log`);
      await db.execute(sql`drop function reject_abandoned_epoch_one()`);
    }
    expect(await expireAbandonedWorkspaceFileHolds(db, new Date(Date.now() + 10 * 60_000))).toEqual({ expired: 1 });
  });

  it("wakes the cleanup worker at the receipt's retention end, also after a restart, and then goes quiet", async () => {
    const seeded = await seed();
    await abandon(seeded);
    const { call, runtime } = worker(seeded);
    await acquire(seeded, runtime);
    vi.restoreAllMocks();
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success" })
      .where(eq(environmentLeases.providerLeaseId, "replacement-sandbox"));
    const [receipt] = (await readWorkspace(seeded)).metadata!.remoteWorkspaceAbandonedEpochs as Array<Record<string, unknown>>;
    const retainUntil = Date.parse(receipt!.retainUntil as string);

    expect(await nextEnvironmentCleanupAt(db)).toBe(retainUntil);
    const restarted = createDb(connectionString);
    try {
      expect(await nextEnvironmentCleanupAt(restarted)).toBe(retainUntil);
    } finally {
      await restarted.$client.end({ timeout: 1 });
    }

    await setReceipts(seeded, value => ({ ...value, retainUntil: new Date(Date.now() - 1_000).toISOString() }));
    await sweep(runtime);
    expect(destroyCalls(call)).toHaveLength(1);
    expect(await entries("workspace.abandoned_files_removed")).toHaveLength(1);
    expect(await nextEnvironmentCleanupAt(db)).toBeNull();
  });

  async function stoppedWarmOrphan(seeded: Seeded) {
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(environmentLeases).set({ status: "failed", cleanupStatus: "success", leasePolicy: "reuse_by_environment",
      metadata: { ...seeded.lease.metadata, remoteExecutionTermination: { state: "stopped", leaseId: seeded.lease.id,
        runId: seeded.abandonedRunId } } }).where(eq(environmentLeases.id, seeded.lease.id));
    const listed = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(releasableRetainedOrphanCondition());
    const settled = await settleRetainedOrphanSandbox(db, { recordId: seeded.lease.id, runId: seeded.abandonedRunId } as never,
      { now: new Date(), proof: { reason: "owner_gone" } as never });
    return { listed: listed.map(row => row.id), settled };
  }

  it("keeps a held sandbox when the retained orphan settlement reviews it", async () => {
    const seeded = await seed();
    await abandon(seeded);
    const { listed, settled } = await stoppedWarmOrphan(seeded);
    expect(listed).toEqual([]);
    expect(settled).toEqual({ settled: false, reason: "workspace_preservation_pending" });
    expect(await leaseRow(seeded)).toMatchObject({ status: "failed" });
  });

  it("lists the sandbox for the retained orphan settlement again once the receipt is released", async () => {
    const seeded = await seed();
    await abandon(seeded);
    await setReceipts(seeded, receipt => ({ ...receipt,
      released: { reason: "discarded", releasedAt: new Date().toISOString(), actorType: "user", actorId: "board-user" } }));
    const { listed, settled } = await stoppedWarmOrphan(seeded);
    expect(listed).toEqual([seeded.lease.id]);
    expect(settled.reason).not.toBe("workspace_preservation_pending");
    expect(await nativeWorkspaceExportPendingForLease(db, seeded.lease)).toBe(false);
  });

  async function abandonOnOtherSandbox(seeded: Seeded, remoteCwd: string) {
    const workspace = await readWorkspace(seeded);
    const authority = workspace.metadata!.remoteWorkspace as Record<string, unknown> & { epoch: number };
    const location = { environmentId: seeded.environment.id, leaseId: randomUUID(), providerLeaseId: "sandbox-b", remoteCwd };
    await db.update(executionWorkspaces).set({ metadata: { ...workspace.metadata, remoteWorkspace: { ...authority,
      writerRunId: seeded.runId, dirty: true, location } } }).where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    await db.transaction(tx => abandonUnverifiedRemoteWorkspaceEpoch(tx, { companyId: seeded.companyId,
      workspaceId: seeded.executionWorkspaceId, runId: seeded.runId, epoch: authority.epoch,
      snapshotId: authority.snapshotId as string, location }));
  }

  it("keeps holding the first sandbox after many later abandonments on another sandbox", async () => {
    const seeded = await seed();
    await abandon(seeded);
    for (let index = 0; index < 21; index++) await abandonOnOtherSandbox(seeded, `/root-${index}`);
    for (let index = 0; index < 5; index++) await abandonOnOtherSandbox(seeded, "/root-0");
    const receipts = (await readWorkspace(seeded)).metadata!.remoteWorkspaceAbandonedEpochs as Array<Record<string, unknown>>;
    expect(receipts).toHaveLength(22);
    expect(receipts.filter(receipt => (receipt.location as { remoteCwd: string }).remoteCwd === "/root-0")).toHaveLength(1);
    expect(await nativeWorkspaceExportPendingForLease(db, seeded.lease)).toBe(true);

    expect(await releaseAbandonedWorkspaceFiles(db, { companyId: seeded.companyId, workspaceId: seeded.executionWorkspaceId,
      epoch: 1, reason: "discarded", actorType: "user", actorId: "board-user" })).toBe(true);
    expect(await nativeWorkspaceExportPendingForLease(db, seeded.lease)).toBe(false);
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
});
