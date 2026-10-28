import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, agentWakeupRequests, applyPendingMigrations, companies, createDb, environmentLeases, environments, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, plugins } from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { environmentRuntimeService } from "../environment-runtime.js";
import * as leases from "../environments.js";
import * as providers from "../sandbox-provider-runtime.js";
import { createSystemRecovery, failSystemRecovery, reserveSystemRecoveryAttempt, SystemRecoveryFailure } from "../system-recovery-state.js";
import { recoverRetainedWorkspace } from "../workspace-recovery.js";
import { nativeWorkspaceExportPendingForLease, nativeWorkspaceExportPendingForResource } from "./native-workspace-finalization-state.js";

describe("native workspace export warm reuse fence", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_WORKSPACE_RECOVERY_TEST_DATABASE_URL");
    if (external) { await applyPendingMigrations(external); temporary = { connectionString: external, cleanup: async () => {} }; }
    else temporary = await startEmbeddedPostgresTestDatabase("native-warm-reuse-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seed(plugin: boolean) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), pluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Native warm fence", issuePrefix: `W${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Keep the source", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native", status: "running" });
    const provider = plugin ? "native-fence-plugin" : "fake";
    if (plugin) await db.insert(plugins).values({ id: pluginId, pluginKey: `native-fence.${pluginId}`,
      packageName: "native-fence-provider", version: "1.0.0", apiVersion: 1, categories: ["automation"], status: "ready",
      manifestJson: { id: `native-fence.${pluginId}`, apiVersion: 1, version: "1.0.0", displayName: "Native fence provider",
        description: "Controlled lifecycle boundary", author: "Paperclip", categories: ["automation"],
        capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: provider, kind: "sandbox_provider", displayName: "Native fence", supportsReusableLeases: true,
          configSchema: { type: "object", properties: { image: { type: "string" }, reuseLease: { type: "boolean" } } } }] } });
    const [environment] = await db.insert(environments).values({ name: runId, driver: "sandbox", status: "active",
      config: { provider, image: "fake:test", reuseLease: true } }).returning();
    const providerLeaseId: string = randomUUID();
    const call = vi.fn(async (_id: string, method: string) => {
      if (["environmentAcquireLease", "environmentResumeLease"].includes(method)) return { providerLeaseId, metadata: { remoteCwd: "/work" } };
      if (["environmentReleaseLease", "environmentStopLease"].includes(method)) return { providerLeaseId, state: "stopped" };
      if (method === "environmentDestroyLease") return { providerLeaseId, state: "destroyed" };
      throw new Error(method);
    });
    const worker = { isRunning: () => true, call, getWorker: () => ({ supportedMethods: ["environmentResumeLease",
      "environmentReleaseLease", "environmentStopLease", "environmentDestroyLease"] }) } as unknown as PluginWorkerManager;
    if (!plugin) {
      const original = providers.getSandboxProvider;
      vi.spyOn(providers, "getSandboxProvider").mockImplementation(key => {
        const value = original(key);
        return value && key === "fake" ? Object.assign(Object.create(value), { supportsReusableLeases: true }) : value;
      });
    }
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: worker });
    const input = { companyId, agentId, issueId, environment: environment as unknown as Environment,
      heartbeatRunId: runId, persistedExecutionWorkspace: null };
    const acquired = await runtime.acquireRunLease(input);
    await runtime.releaseRunLeases(runId, "released", undefined, "keep_running");
    const reference = { schema: "paperclip.native-workspace-sync/v3", state: "prepared", leaseId: acquired.lease.id,
      providerLeaseId: acquired.lease.providerLeaseId, workspaceId: issueId, remoteCwd: "/work", resourceDisposition: "keep_running",
      descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null };
    await db.update(heartbeatRuns).set({ status: "failed", runnerProfileJson: { nativeWorkspaceSync: reference } }).where(eq(heartbeatRuns.id, runId));
    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native", status: "queued" });
    call.mockClear();
    return { runtime, input, runId, nextRunId, reference, lease: acquired.lease, call };
  }

  it.each([false, true])("refuses another run before a provider RPC for plugin=%s", async plugin => {
    const f = await seed(plugin);
    const acquire = vi.spyOn(providers, "acquireSandboxProviderLease");
    await expect(f.runtime.acquireRunLease({ ...f.input, heartbeatRunId: f.nextRunId })).rejects.toThrow("Native workspace export is pending");
    expect(f.call).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0])
      .toMatchObject({ heartbeatRunId: f.runId, leasePolicy: "reuse_by_environment" });
  });

  it("checks the allocation even when the candidate snapshot contains only a rebound row", async () => {
    const f = await seed(true);
    const service = leases.environmentService(db);
    const [rebound] = await db.insert(environmentLeases).values({ companyId: f.input.companyId, environmentId: f.input.environment.id,
      issueId: f.input.issueId, heartbeatRunId: f.nextRunId, provider: f.lease.provider, providerLeaseId: f.lease.providerLeaseId,
      leasePolicy: "reuse_by_environment", status: "retained", metadata: f.lease.metadata }).returning();
    const list = service.listLeases;
    service.listLeases = async (...args) => (await list(...args)).filter(lease => lease.id === rebound.id);
    vi.spyOn(leases, "environmentService").mockReturnValue(service);
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => true, call: f.call,
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }) } as unknown as PluginWorkerManager });
    await expect(runtime.acquireRunLease({ ...f.input, heartbeatRunId: f.nextRunId })).rejects.toThrow("Native workspace export is pending");
    expect(f.call).not.toHaveBeenCalled();
  });

  it("rechecks a prepared export after selecting a stale candidate and before resuming it", async () => {
    const f = await seed(true);
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: { ...f.reference,
      state: "finalized", finalHostSha256: "c".repeat(64) } } }).where(eq(heartbeatRuns.id, f.runId));
    const service = leases.environmentService(db), list = service.listLeases;
    service.listLeases = async (...args) => {
      const snapshot = await list(...args);
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: f.reference } }).where(eq(heartbeatRuns.id, f.runId));
      return snapshot;
    };
    vi.spyOn(leases, "environmentService").mockReturnValue(service);
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => true, call: f.call,
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }) } as unknown as PluginWorkerManager });
    await expect(runtime.acquireRunLease({ ...f.input, heartbeatRunId: f.nextRunId })).rejects.toThrow("Native workspace export is pending");
    expect(f.call).not.toHaveBeenCalled();
  });

  it("preserves exact same-run reattachment without allocating a replacement", async () => {
    const f = await seed(true);
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.runId));
    const resumed = await f.runtime.acquireRunLease(f.input);
    expect(resumed.lease.id).toBe(f.lease.id);
    expect(f.call.mock.calls.map(call => call[1])).toEqual(["environmentResumeLease"]);
  });

  it("checks a long allocation history in one read and allows finalized workspace reuse", async () => {
    const f = await seed(true);
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: { ...f.reference,
      state: "finalized", finalHostSha256: "c".repeat(64) } } }).where(eq(heartbeatRuns.id, f.runId));
    const history = Array.from({ length: 64 }, () => randomUUID());
    await db.insert(heartbeatRuns).values(history.map(id => ({ id, companyId: f.input.companyId, agentId: f.input.agentId,
      issueId: f.input.issueId, nativeIssueId: f.input.issueId, runtimeMode: "native", status: "succeeded",
      runnerProfileJson: { nativeWorkspaceSync: { ...f.reference, state: "finalized", finalHostSha256: "c".repeat(64) } } })));
    await db.insert(environmentLeases).values(history.map(heartbeatRunId => ({ companyId: f.input.companyId,
      environmentId: f.input.environment.id, heartbeatRunId, provider: f.lease.provider,
      providerLeaseId: f.lease.providerLeaseId, leasePolicy: "reuse_by_environment", status: "released" })));
    const reads = vi.spyOn(db, "select");
    expect(await nativeWorkspaceExportPendingForResource(db, f.lease, f.nextRunId)).toBe(false);
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockRestore();
    const resumed = await f.runtime.acquireRunLease({ ...f.input, heartbeatRunId: f.nextRunId });
    expect(resumed.lease.id).not.toBe(f.lease.id);
    expect(resumed.lease).toMatchObject({ heartbeatRunId: f.nextRunId, providerLeaseId: f.lease.providerLeaseId });
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0])
      .toMatchObject({ heartbeatRunId: f.runId, status: "expired" });
    expect(f.call.mock.calls.map(call => call[1])).toEqual(["environmentResumeLease"]);
  });

  it.each(["grok_bot", "muse"])("does not fence an exactly bound workspace-less %s run", async kind => {
    const f = await seed(true);
    const binding = { runId: f.runId, companyId: f.input.companyId, agentId: f.input.agentId, issueId: f.input.issueId };
    const profile = { nativeWorkspaceSync: f.reference, nativeExecutionInput: {
      schema: kind === "muse" ? "paperclip.native-execution-input.v8" : "paperclip.native-execution-input.v6",
      binding, workspace: { access: "none", cwd: null }, provider: { kind, bridgeRevision: "muse-v1" } } };
    await db.update(heartbeatRuns).set({ driverKind: kind === "muse" ? "muse_external" : "grok_bot_mcp",
      runnerProfileJson: profile }).where(eq(heartbeatRuns.id, f.runId));
    expect(await nativeWorkspaceExportPendingForLease(db, f.lease)).toBe(false);
    expect(await nativeWorkspaceExportPendingForResource(db, f.lease, f.nextRunId)).toBe(false);
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...profile, nativeExecutionInput: {
      ...profile.nativeExecutionInput, binding: { ...binding, runId: randomUUID() } } } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await nativeWorkspaceExportPendingForResource(db, f.lease, f.nextRunId)).toBe(true);
  });

  it("does not take over a source while an ordinary provider resume is awaiting its database handoff", async () => {
    const f = await seed(true), requestId = randomUUID(), actionId = randomUUID();
    await db.update(heartbeatRuns).set({ runnerProfileJson: {} }).where(eq(heartbeatRuns.id, f.runId));
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    f.call.mockImplementation(async (_id: string, method: string) => {
      if (method !== "environmentResumeLease") throw new Error(method);
      entered(); await pending;
      return { providerLeaseId: f.lease.providerLeaseId!, metadata: { remoteCwd: "/work" } };
    });
    const ordinary = f.runtime.acquireRunLease({ ...f.input, heartbeatRunId: f.nextRunId });
    try {
      await started;
      const failure = failSystemRecovery(reserveSystemRecoveryAttempt(createSystemRecovery(f.runId, requestId))!,
        new SystemRecoveryFailure("source_binding_invalid", "service_required"));
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: f.reference },
        resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: {
          schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.lease.id] } } }).where(eq(heartbeatRuns.id, f.runId));
      await db.insert(nativeRunFinalizations).values({ companyId: f.input.companyId, issueId: f.input.issueId,
        runId: f.runId, phase: "terminal_failure" });
      await db.insert(issueRecoveryActions).values({ id: actionId, companyId: f.input.companyId, sourceIssueId: f.input.issueId,
        kind: "active_run_watchdog", ownerType: "system", cause: "native_workspace_sync_out_retry_exhausted", fingerprint: f.runId,
        nextAction: "Preserve the source", evidence: { runId: f.runId, systemRecovery: failure, workspaceRecovery: {
          schema: "paperclip.workspace-recovery.v1", runId: f.runId, status: "blocked", stage: "verifying_stop",
          attempt: 1, requestIds: [requestId] } } });
      await db.insert(agentWakeupRequests).values({ id: requestId, companyId: f.input.companyId, agentId: f.input.agentId,
        source: "on_demand", reason: "task_retry", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
        payload: { issueId: f.input.issueId, taskRetry: { schema: "paperclip.task-retry.v1", generationId: requestId,
          sourceRunId: f.runId, actorId: "board", actorSource: "local_implicit", strategy: "evaluate" } } });
      await recoverRetainedWorkspace({ db, companyId: f.input.companyId, issueId: f.input.issueId,
        runId: f.runId, actionId, environmentRuntime: f.runtime });
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId));
      expect(action.evidence.systemRecovery).toEqual(failure);
      expect(action.evidence.nativeSourceRetention).toBeUndefined();
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0].leasePolicy).toBe("reuse_by_environment");
      expect(f.call.mock.calls.map(call => call[1])).toEqual(["environmentResumeLease"]);
    } finally { release(); await ordinary; }
  });
});
