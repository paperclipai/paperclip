import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { classifyEnvironmentCapabilities, environmentRuntimeService } from "../environment-runtime.js";
import { environmentService } from "../environments.js";
import { createHeartbeatRecovery, type HeartbeatRecoveryDependencies } from "./recovery.js";
import type { HotRestartIntent } from "../hot-restart.js";
import type { NativeRestartRecoveryClaim, NativeRestartRecoveryDisposition } from "../native-runtime/index.js";
import { NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE } from "../native-runtime/native-runner-ownership.js";
import { allowLegacyShutdownWorkspaceCleanup, beginLegacyShutdownWorkspaceSettlement, finishLegacyShutdownWorkspaceSettlement, legacyShutdownWorkspaceResourceProtected, sweepLegacyShutdownWorkspaceSettlements } from "../legacy-shutdown-workspace-settlement.js";
import { adapterExecutionControls, createAdapterExecutionControl } from "../adapter-execution-control.js";

type Run = typeof heartbeatRuns.$inferSelect;

const native = vi.hoisted(() => ({
  closeIdle: vi.fn(async () => ({ closed: 0, failed: 0 })),
  detach: vi.fn(async () => 0),
  finalizations: vi.fn(async (_db: Db, _ids?: string[], _options?: unknown) => undefined),
  cleanups: vi.fn(async () => undefined),
  drainMaintenance: vi.fn<() => Promise<void>>(async () => undefined),
  claims: vi.fn<() => Promise<NativeRestartRecoveryDisposition[]>>(async () => []),
}));
const hotRestart = vi.hoisted(() => ({
  read: vi.fn<() => Promise<HotRestartIntent | null>>(async () => null),
}));
vi.mock("../hot-restart.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../hot-restart.js")>(),
  readHotRestartIntent: hotRestart.read,
}));
vi.mock("../native-runtime/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../native-runtime/index.js")>(),
  closeIdleWarmNativeSessionsForRestart: native.closeIdle,
  detachNativeSessionsForRestart: native.detach,
  reconcileNativeFinalizations: native.finalizations,
  reconcileRetainedNativeSessionCleanups: native.cleanups,
  claimNativeRestartRecoveries: native.claims,
}));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>(),
  drainRetainedRunnerdMaintenanceOperations: native.drainMaintenance,
}));

function callbacks(db: Db) {
  return {
    enterShutdown: vi.fn(),
    getRun: vi.fn<HeartbeatRecoveryDependencies["getRun"]>(async () => null),
    getAgent: vi.fn<HeartbeatRecoveryDependencies["getAgent"]>(async () => null),
    appendRunEvent: vi.fn<HeartbeatRecoveryDependencies["appendRunEvent"]>(async () => undefined),
    setRunStatusIfRunning: vi.fn<HeartbeatRecoveryDependencies["setRunStatusIfRunning"]>(async () => ({ updated: false, run: null })),
    setRunStatusFromLive: vi.fn<HeartbeatRecoveryDependencies["setRunStatusFromLive"]>(async () => ({ updated: false, run: null })),
    setRunStatus: vi.fn<HeartbeatRecoveryDependencies["setRunStatus"]>(async () => null),
    setWakeupStatus: vi.fn(async () => undefined),
    releaseIssueExecutionAndPromote: vi.fn(async () => undefined),
    finalizeAgentStatus: vi.fn(async () => undefined),
    environmentRuntime: environmentRuntimeService(db),
    environmentsSvc: environmentService(db),
    instructionCopies: {
      recoverStopped: vi.fn(async () => 0),
      recoverCaptured: vi.fn(async () => 0),
    },
    runtimeEnv: {},
    activeRunExecutions: new Set<string>(),
    activeRunExecutionPromises: new Set<Promise<void>>(),
    scheduleBoundedRetryForRun: vi.fn<HeartbeatRecoveryDependencies["scheduleBoundedRetryForRun"]>(async () => ({ outcome: "retry_exhausted", retryReason: "transient_failure", attempt: 1, maxAttempts: 0 })),
    scheduleInteractionContinuationInfrastructureRetryIfEligible: vi.fn<HeartbeatRecoveryDependencies["scheduleInteractionContinuationInfrastructureRetryIfEligible"]>(async () => null),
    timerClaimWasFirstHeartbeat: vi.fn(() => undefined),
    executeRun: vi.fn<HeartbeatRecoveryDependencies["executeRun"]>(async () => undefined),
    scheduleNativeSessionResumeDispatch: vi.fn(),
    cancelHeartbeatNativeRun: vi.fn(async () => undefined),
    terminateHeartbeatRunProcess: vi.fn(async () => undefined),
    mergeRunStopMetadataForAgent: vi.fn<HeartbeatRecoveryDependencies["mergeRunStopMetadataForAgent"]>((_agent, _outcome, options) => options?.resultJson ?? null),
    classifyAndPersistRunLiveness: vi.fn<HeartbeatRecoveryDependencies["classifyAndPersistRunLiveness"]>(async run => run),
    releaseEnvironmentLeasesForRun: vi.fn<HeartbeatRecoveryDependencies["releaseEnvironmentLeasesForRun"]>(async () => undefined),
    acknowledgeRemoteStop: vi.fn(async () => undefined),
    resumeRemoteStopComments: vi.fn(async () => undefined),
    dispatchPendingNativeStatusWakeups: vi.fn(async () => undefined),
    cancelRunInternal: vi.fn(async () => undefined),
    startNextQueuedRunForAgent: vi.fn(async () => undefined),
  } satisfies HeartbeatRecoveryDependencies;
}

function guardedDatabase() {
  const access = vi.fn(() => { throw new Error("Unexpected recovery database access"); });
  return { db: new Proxy({}, { get: access }) as Db, access };
}

beforeEach(() => {
  vi.clearAllMocks();
  hotRestart.read.mockResolvedValue(null);
  native.closeIdle.mockResolvedValue({ closed: 0, failed: 0 });
  native.finalizations.mockResolvedValue(undefined);
  native.cleanups.mockResolvedValue(undefined);
  native.drainMaintenance.mockResolvedValue(undefined);
  native.claims.mockResolvedValue([]);
});

describe("heartbeat recovery module callbacks", () => {
  it("constructs without database access, shutdown, or background work", () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    createHeartbeatRecovery(database.db, deps);
    expect(database.access).not.toHaveBeenCalled();
    for (const callback of Object.values(deps)) if (typeof callback === "function") expect(callback).not.toHaveBeenCalled();
    for (const callback of Object.values(native)) expect(callback).not.toHaveBeenCalled();
  });

  it.each(["not_requested", "read_error"] as const)("enters shutdown before checkpointing for %s", async (mode) => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    if (mode === "read_error") hotRestart.read.mockRejectedValueOnce(new Error("unreadable intent"));
    const recovery = createHeartbeatRecovery(database.db, deps);
    expect(await recovery.prepareHotRestartShutdown("SIGTERM")).toEqual({ mode, skipDrain: false, activeRunIds: [] });
    expect(native.closeIdle).toHaveBeenCalledAfter(deps.enterShutdown);
    expect(hotRestart.read).toHaveBeenCalledAfter(native.closeIdle);
    expect(database.access).not.toHaveBeenCalled();
  });

  it("does not adopt or query runs without a restart intent", async () => {
    const database = guardedDatabase();
    expect(await createHeartbeatRecovery(database.db, callbacks(database.db)).reconcileHotRestartAdoption()).toEqual({
      mode: "not_requested", adoptedRunIds: [], finalizedWhileDownRunIds: [], lostRunIds: [], skippedRunIds: [],
    });
    expect(database.access).not.toHaveBeenCalled();
  });

  it("does not broaden an empty selective shutdown drain to every run", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    expect(await createHeartbeatRecovery(database.db, deps).drainRunningRunsForShutdown("SIGINT", new Date(), [])).toEqual({
      interrupted: 0, interruptedRunIds: [], retryRunIds: [], restartSuspendedRunIds: [],
    });
    expect(database.access).not.toHaveBeenCalled();
    expect(deps.cancelHeartbeatNativeRun).not.toHaveBeenCalled();
    expect(deps.terminateHeartbeatRunProcess).not.toHaveBeenCalled();
  });

  it.each(["running", "failed"] as const)("keeps a %s ownership hold when a status race wins", async (status) => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    const run = { id: "run", runtimeMode: "native", status } as Run;
    const winner = { ...run, status: "cancelled" };
    deps.setRunStatusFromLive.mockResolvedValue({ updated: false, run: winner });
    expect(await createHeartbeatRecovery(database.db, deps).markNativeOwnershipUnverified(run, { reason: "live_process_identifier" })).toBe(winner);
    expect(deps.setRunStatusFromLive).toHaveBeenCalledWith("run", status, [status], expect.objectContaining({ errorCode: NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE }));
    expect(deps.appendRunEvent).not.toHaveBeenCalled();
    expect(database.access).not.toHaveBeenCalled();
  });

  it("persists an authentication ownership hold before its event without terminating or retrying", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    const run = { id: "run", runtimeMode: "native", status: "running" } as Run;
    const blocked = { ...run, nativePhase: "terminal_failure", errorCode: NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE };
    deps.setRunStatusFromLive.mockResolvedValue({ updated: true, run: blocked });
    expect(await createHeartbeatRecovery(database.db, deps).markNativeOwnershipUnverified(run, { reason: "adopted_runner_authentication_timeout" })).toBe(blocked);
    expect(deps.setRunStatusFromLive).toHaveBeenCalledWith("run", "running", ["running"], expect.objectContaining({ nativePhase: "terminal_failure" }));
    expect(deps.appendRunEvent).toHaveBeenCalledAfter(deps.setRunStatusFromLive);
    expect(deps.cancelHeartbeatNativeRun).not.toHaveBeenCalled();
    expect(deps.terminateHeartbeatRunProcess).not.toHaveBeenCalled();
    expect(deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
    expect(database.access).not.toHaveBeenCalled();
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping recovery module database tests: ${support.reason}`);

describePostgres("heartbeat recovery module ownership", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-module-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await database?.cleanup(); });

  async function seedRun() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovery", issuePrefix: `T${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Recovery", role: "engineer", adapterType: "process" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Recover this run", status: "in_progress", assigneeAgentId: agentId });
    return (await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, invocationSource: "automation", status: "running", runtimeMode: "legacy" }).returning())[0];
  }

  it.each(["restored", "restore_failed"])("keeps the sandbox available until adapter workspace settlement: %s", async outcome => {
    const run = await seedRun();
    const deps = callbacks(db);
    deps.setRunStatusIfRunning.mockImplementation(async (id, status, patch) => {
      const [updated] = await db.update(heartbeatRuns).set({ ...patch, status }).where(eq(heartbeatRuns.id, id)).returning();
      return { updated: true, run: updated };
    });
    deps.getRun.mockImplementation(async id => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0] ?? null);
    const control = createAdapterExecutionControl();
    adapterExecutionControls.set(run.id, control);
    const drain = createHeartbeatRecovery(db, deps).drainRunningRunsForShutdown("SIGTERM", new Date(), [run.id]);
    try {
      await vi.waitFor(() => expect(control.controller.signal.aborted).toBe(true));
      expect(deps.releaseEnvironmentLeasesForRun).not.toHaveBeenCalled();
      expect(deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
      expect((await deps.getRun(run.id))?.status).toBe("interrupted");
      const resultJson = outcome === "restore_failed" ? { workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [randomUUID()] } }
        : { workspaceRestored: true };
      await db.update(heartbeatRuns).set({ resultJson }).where(eq(heartbeatRuns.id, run.id));
      control.finish();
      await drain;
      expect(deps.releaseEnvironmentLeasesForRun).toHaveBeenCalledOnce();
      expect(deps.classifyAndPersistRunLiveness).toHaveBeenCalledWith(expect.objectContaining({
        resultJson: expect.objectContaining(resultJson) }), expect.anything());
    } finally {
      control.finish();
      adapterExecutionControls.delete(run.id);
      await drain;
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    }
  });

  it("starts all owned shutdown cancellations within one settlement window", async () => {
    const runs = await Promise.all([seedRun(), seedRun()]);
    const controls = runs.map(run => {
      const control = createAdapterExecutionControl(); adapterExecutionControls.set(run.id, control); return control;
    });
    const deps = callbacks(db);
    deps.setRunStatusIfRunning.mockImplementation(async (id, status, patch) => {
      const [updated] = await db.update(heartbeatRuns).set({ ...patch, status }).where(eq(heartbeatRuns.id, id)).returning();
      return { updated: true, run: updated };
    });
    const drain = createHeartbeatRecovery(db, deps).drainRunningRunsForShutdown("SIGTERM", new Date(), runs.map(run => run.id));
    try {
      await vi.waitFor(() => expect(controls.every(control => control.controller.signal.aborted)).toBe(true));
      expect(deps.releaseEnvironmentLeasesForRun).not.toHaveBeenCalled();
    } finally {
      controls.forEach(control => control.finish());
      await drain;
      for (const run of runs) { adapterExecutionControls.delete(run.id); await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)); }
    }
  });

  it.each(["ephemeral", "reuse_by_environment"] as const)("protects a %s export from another server and pins it after controller loss", async leasePolicy => {
    const run = await seedRun();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: run.issueId } }).where(eq(heartbeatRuns.id, run.id));
    const [lease] = await db.insert(environmentLeases).values({ companyId: run.companyId, heartbeatRunId: run.id,
      issueId: run.issueId, status: "active", provider: "daytona", providerLeaseId: randomUUID(), leasePolicy,
      metadata: { driver: "sandbox", sandboxProviderPlugin: true, pluginId: "fixture-plugin", remoteCwd: "/home/daytona/workspace" } }).returning();
    try {
      const deadline = new Date(Date.now() + 30_000);
      await beginLegacyShutdownWorkspaceSettlement(db, run, deadline);
      await db.update(heartbeatRuns).set({ status: "interrupted", errorCode: "server_shutdown_interrupted", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
      const foreignDeps = callbacks(db);
      const foreign = createHeartbeatRecovery(db, foreignDeps);
      expect(await foreign.sweepOrphanedActiveLeases({ backoffMs: 0 })).toMatchObject({ recovered: 0 });
      expect(await environmentRuntimeService(db).releaseRunLeases(run.id)).toEqual([]);
      await db.update(environmentLeases).set({ status: "pending_cleanup" }).where(eq(environmentLeases.id, lease.id));
      expect(await foreign.sweepPendingCleanupLeases({ backoffMs: 0 })).toMatchObject({ destroyed: 0 });
      await db.update(environmentLeases).set({ status: "active" }).where(eq(environmentLeases.id, lease.id));
      let source = (await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0];
      expect(source.status).toBe("active");
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, run.issueId!))).toHaveLength(0);
      // No local adapter map or timeout handler survives a container SIGKILL.
      expect(await allowLegacyShutdownWorkspaceCleanup(db, source, new Date(deadline.getTime() + 1))).toBe(true);
      source = (await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0];
      expect(source).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure",
        metadata: { legacyShutdownWorkspaceSettlement: { state: "expired" }, sandboxStopAndRetain: { leaseId: lease.id } } });
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].resultJson)
        .toMatchObject({ workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: { leaseIds: [lease.id] } });
      expect(await foreign.sweepOrphanedActiveLeases({ backoffMs: 0 })).toMatchObject({ recovered: 0 });
    } finally {
      await db.delete(environmentLeases).where(eq(environmentLeases.id, lease.id));
      await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, run.issueId!));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    }
  });

  async function seedShutdownSource() {
    const run = await seedRun();
    const [lease] = await db.insert(environmentLeases).values({ companyId: run.companyId, heartbeatRunId: run.id,
      issueId: run.issueId, status: "active", provider: "daytona", providerLeaseId: randomUUID(), leasePolicy: "ephemeral",
      metadata: { driver: "sandbox", sandboxProviderPlugin: true, pluginId: "fixture-plugin", remoteCwd: "/home/daytona/workspace" } }).returning();
    await beginLegacyShutdownWorkspaceSettlement(db, run, new Date(Date.now() + 30_000));
    return { run, lease };
  }
  async function deleteShutdownSource(f: Awaited<ReturnType<typeof seedShutdownSource>>) {
    await db.delete(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.run.issueId!));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    adapterExecutionControls.delete(f.run.id);
  }

  it("does not turn a stale pending snapshot into a repair hold after settlement", async () => {
    const f = await seedShutdownSource();
    try {
      const old = (await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0];
      await db.update(heartbeatRuns).set({ status: "interrupted", contextSnapshot: { issueId: f.run.issueId }, resultJson: { workspaceRestored: true } }).where(eq(heartbeatRuns.id, f.run.id));
      await finishLegacyShutdownWorkspaceSettlement(db, f.run);
      const single = createDb(database.connectionString, { maxConnections: 1 });
      try { expect(await allowLegacyShutdownWorkspaceCleanup(single, old, new Date(Date.now() + 60_000))).toBe(true); }
      finally { await single.$client.end({ timeout: 1 }); }
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0])
        .toMatchObject({ status: "active", leasePolicy: "ephemeral", metadata: { legacyShutdownWorkspaceSettlement: { state: "settled" } } });
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.run.issueId!))).toHaveLength(0);
    } finally { await deleteShutdownSource(f); }
  });

  it("allows the aborted owner to stop and retain its command while excluding outside cleanup", async () => {
    const f = await seedShutdownSource();
    const control = createAdapterExecutionControl(); control.controller.abort();
    adapterExecutionControls.set(f.run.id, control);
    const stop = vi.fn(async () => ({ providerLeaseId: f.lease.providerLeaseId, state: "stopped" }));
    const release = vi.fn(async () => null);
    const runtime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox", resolveCapabilities: async () => classifyEnvironmentCapabilities({}),
      acquireRunLease: async () => { throw new Error("Unexpected acquire"); }, releaseRunLease: release,
      retryPendingSandboxTeardown: stop }] });
    try {
      await runtime.releaseRunLeases(f.run.id, "released", undefined, "stop_and_retain", false);
      expect(stop).not.toHaveBeenCalled();
      await runtime.releaseRunLeases(f.run.id, "released", undefined, "stop_and_retain", true);
      expect(stop).toHaveBeenCalledOnce(); expect(release).not.toHaveBeenCalled();
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0])
        .toMatchObject({ status: "released", cleanupStatus: "success", metadata: { remoteExecutionTermination: { state: "stopped" },
          sandboxStopAndRetainReceipt: { leaseId: f.lease.id } } });
    } finally { control.finish(); await deleteShutdownSource(f); }
  });

  it.each(["ephemeral", "reuse_by_environment"] as const)("recovers a stopped %s source after its shutdown controller disappears", async leasePolicy => {
    const f = await seedShutdownSource();
    await db.update(environmentLeases).set({ leasePolicy }).where(eq(environmentLeases.id, f.lease.id));
    const control = createAdapterExecutionControl(); control.controller.abort(); adapterExecutionControls.set(f.run.id, control);
    const stop = vi.fn(async () => ({ providerLeaseId: f.lease.providerLeaseId, state: "stopped" }));
    const runtime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox", resolveCapabilities: async () => classifyEnvironmentCapabilities({}),
      acquireRunLease: async () => { throw new Error("Unexpected acquire"); }, releaseRunLease: vi.fn(), retryPendingSandboxTeardown: stop }] });
    try {
      await runtime.releaseRunLeases(f.run.id, "released", undefined, "stop_and_retain", true);
      adapterExecutionControls.delete(f.run.id); // SIGKILL before export/finally settled.
      await db.update(heartbeatRuns).set({ status: "interrupted", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
      const [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      expect(source.status).toBe("released");
      // An old reuse receipt must not bypass the current allocation's fence.
      expect(await legacyShutdownWorkspaceResourceProtected(db, { provider: source.provider, providerLeaseId: source.providerLeaseId })).toBe(true);
      await sweepLegacyShutdownWorkspaceSettlements(db, new Date(Date.now() + 60_000));
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0])
        .toMatchObject({ status: "released", leasePolicy: "retain_on_failure", metadata: {
          legacyShutdownWorkspaceSettlement: { state: "expired" }, workspaceRestoreRecovery: { runId: f.run.id } } });
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].resultJson)
        .toMatchObject({ workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: { leaseIds: [f.lease.id] } });
      expect(await legacyShutdownWorkspaceResourceProtected(db, source)).toBe(true);
      expect(stop).toHaveBeenCalledOnce();
    } finally { control.finish(); await deleteShutdownSource(f); }
  });

  it("retries lease release when ordinary completion wins the shutdown status race", async () => {
    const f = await seedShutdownSource(); const control = createAdapterExecutionControl();
    adapterExecutionControls.set(f.run.id, control);
    const deps = callbacks(db);
    deps.setRunStatusIfRunning.mockImplementation(async () => {
      await db.update(heartbeatRuns).set({ status: "succeeded", resultJson: { workspaceRestored: true } }).where(eq(heartbeatRuns.id, f.run.id));
      // The adapter's first release was deferred by the fence; its finally ended.
      control.finish(); return { updated: false, run: null };
    });
    deps.getRun.mockImplementation(async id => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0] ?? null);
    deps.releaseEnvironmentLeasesForRun.mockImplementation(async input => {
      expect(input.status).toBe("succeeded");
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0].metadata)
        .toMatchObject({ legacyShutdownWorkspaceSettlement: { state: "settled" } });
      await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date() }).where(eq(environmentLeases.id, f.lease.id));
    });
    try {
      await createHeartbeatRecovery(db, deps).drainRunningRunsForShutdown("SIGTERM", new Date(), [f.run.id]);
      expect(deps.releaseEnvironmentLeasesForRun).toHaveBeenCalledOnce();
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0].status).toBe("released");
      expect(deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
    } finally { control.finish(); await deleteShutdownSource(f); }
  });

  it("pins an unjoined sandbox restore for repair before bounded shutdown cleanup", async () => {
    const run = await seedRun();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: run.issueId } }).where(eq(heartbeatRuns.id, run.id));
    const [lease] = await db.insert(environmentLeases).values({ companyId: run.companyId, heartbeatRunId: run.id,
      issueId: run.issueId, status: "active", provider: "daytona", providerLeaseId: randomUUID(), leasePolicy: "ephemeral",
      metadata: { driver: "sandbox", sandboxProviderPlugin: true, pluginId: "fixture-plugin", remoteCwd: "/home/daytona/workspace" } }).returning();
    const deps = callbacks(db);
    deps.setRunStatusIfRunning.mockImplementation(async (id, status, patch) => {
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0].metadata)
        .toMatchObject({ legacyShutdownWorkspaceSettlement: { state: "pending", runId: run.id } });
      const [updated] = await db.update(heartbeatRuns).set({ ...patch, status }).where(eq(heartbeatRuns.id, id)).returning();
      return { updated: true, run: updated };
    });
    deps.getRun.mockImplementation(async id => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0] ?? null);
    deps.releaseEnvironmentLeasesForRun.mockImplementation(async () => {
      expect((await deps.getRun(run.id))?.resultJson).toMatchObject({ workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [lease.id] } });
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0]).toMatchObject({
        status: "pending_cleanup", leasePolicy: "retain_on_failure", metadata: { sandboxStopAndRetain: { leaseId: lease.id } } });
    });
    const control = createAdapterExecutionControl();
    adapterExecutionControls.set(run.id, control);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const drain = createHeartbeatRecovery(db, deps).drainRunningRunsForShutdown("SIGTERM", new Date(), [run.id]);
    try {
      await vi.waitFor(() => expect(control.controller.signal.aborted).toBe(true));
      await vi.advanceTimersByTimeAsync(30_000);
      await drain;
      expect(deps.releaseEnvironmentLeasesForRun).toHaveBeenCalledOnce();
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, run.issueId!)))
        .toEqual([expect.objectContaining({ evidence: expect.objectContaining({ workspaceRestoreFailure: "restore_failed" }) })]);
    } finally {
      vi.useRealTimers();
      control.finish();
      adapterExecutionControls.delete(run.id);
      await drain;
      await db.delete(environmentLeases).where(eq(environmentLeases.id, lease.id));
      await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, run.issueId!));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    }
  });

  it("uses the shared live-execution set after construction across two factories", async () => {
    const run = await seedRun();
    const deps = callbacks(db);
    const first = createHeartbeatRecovery(db, deps);
    const second = createHeartbeatRecovery(db, deps);
    deps.activeRunExecutions.add(run.id);
    expect(await first.reapOrphanedRuns()).toEqual({ reaped: 0, runIds: [] });
    expect(await second.reapOrphanedRuns()).toEqual({ reaped: 0, runIds: [] });
    expect(deps.setRunStatusFromLive).not.toHaveBeenCalled();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].status).toBe("running");
    await Promise.all([...deps.activeRunExecutionPromises]);
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
  });

  it("settles persisted native results before claiming restart authority and tracks the exact execution", async () => {
    const deps = callbacks(db);
    const claim: NativeRestartRecoveryClaim = { kind: "bootstrap_incomplete", runId: randomUUID(), leaseOwner: "claimed-owner", controllerGeneration: 3, providerAttempt: 2, restartKind: "hard", recoveryRequestId: null };
    native.claims.mockResolvedValue([claim]);
    let finish!: () => void;
    const execution = new Promise<void>(resolve => { finish = resolve; });
    deps.executeRun.mockReturnValue(execution);
    const result = await createHeartbeatRecovery(db, deps).recoverNativeRunsAfterRestart();
    expect(result.claims).toEqual([claim]);
    expect(native.claims).toHaveBeenCalledAfter(native.finalizations);
    expect(deps.executeRun).toHaveBeenCalledWith(claim.runId, { nativeLeaseOwner: claim.leaseOwner, nativeRestartRecovery: claim });
    expect(deps.activeRunExecutionPromises.size).toBeGreaterThan(0);
    finish();
    await Promise.all([...deps.activeRunExecutionPromises]);
    await vi.waitFor(() => expect(deps.activeRunExecutionPromises.size).toBe(0));
  });

  it("does not claim or execute recovery when persisted finalization fails", async () => {
    const deps = callbacks(db);
    native.finalizations.mockRejectedValueOnce(new Error("result settlement failed"));
    await expect(createHeartbeatRecovery(db, deps).recoverNativeRunsAfterRestart()).rejects.toThrow("result settlement failed");
    expect(native.claims).not.toHaveBeenCalled();
    expect(deps.executeRun).not.toHaveBeenCalled();
    expect(native.cleanups).not.toHaveBeenCalled();
  });

  it("keeps blocked and ambiguous ownership out of execution", async () => {
    const deps = callbacks(db);
    const dispositions: NativeRestartRecoveryDisposition[] = [
      { kind: "blocked", runId: randomUUID(), reason: "conflicting_owner" },
      { kind: "awaiting_evidence", runId: randomUUID(), reason: "missing_stop_evidence" },
    ];
    native.claims.mockResolvedValue(dispositions);
    const result = await createHeartbeatRecovery(db, deps).recoverNativeRunsAfterRestart();
    expect(result.blockedRunIds).toEqual([dispositions[0].runId]);
    expect(result.awaitingEvidenceRunIds).toEqual([dispositions[1].runId]);
    expect(result.claims).toEqual([]);
    expect(deps.executeRun).not.toHaveBeenCalled();
    await Promise.all([...deps.activeRunExecutionPromises]);
  });

  it("rearms the persisted native retry deadline through the service callback", async () => {
    const run = await seedRun();
    const nextAttemptAt = new Date(Date.now() + 60_000);
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: run.issueId, status: "failed" }).where(eq(heartbeatRuns.id, run.id));
    await db.insert(nativeRunFinalizations).values({ runId: run.id, companyId: run.companyId, issueId: run.issueId!, phase: "retryable_failure", nextAttemptAt });
    const deps = callbacks(db);
    const result = await createHeartbeatRecovery(db, deps).recoverNativeRunsAfterRestart();
    expect(result.scheduledRetryRunIds).toEqual([run.id]);
    expect(deps.scheduleNativeSessionResumeDispatch).toHaveBeenCalledWith(run.id, nextAttemptAt);
    expect(deps.executeRun).not.toHaveBeenCalled();
    await Promise.all([...deps.activeRunExecutionPromises]);
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
  });

  it("retains shutdown ownership until background native cleanup physically settles", async () => {
    const deps = callbacks(db);
    let settle!: () => void;
    native.drainMaintenance.mockReturnValueOnce(new Promise<void>(resolve => { settle = resolve; }));
    await createHeartbeatRecovery(db, deps).recoverNativeRunsAfterRestart();
    await vi.waitFor(() => expect(native.drainMaintenance).toHaveBeenCalled());
    expect(deps.activeRunExecutionPromises.size).toBe(1);
    settle();
    await Promise.all([...deps.activeRunExecutionPromises]);
    await vi.waitFor(() => expect(deps.activeRunExecutionPromises.size).toBe(0));
  });
});
