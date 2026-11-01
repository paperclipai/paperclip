import { notifyNativeFinalizationWork } from "../services/native-finalization-notifications.js";
import { recordNativeWorkspaceFinalizationFailure } from "../services/native-runtime/native-workspace-finalizer.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "../services/heartbeat/run-lifecycle.js";
import * as workspaceRuntime from "../services/workspace-runtime.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, createDb, environmentLeases, environments, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "@paperclipai/db/response-capture";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { heartbeatService } from "../services/heartbeat.js";
import { environmentRuntimeService, type EnvironmentDriver } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import { nativeEnvironmentSettlementDisposition, nativeEnvironmentSettlementWork } from "../services/native-runtime/native-environment-settlement-work.js";
import { notifyNativeEnvironmentSettlement } from "../services/native-environment-settlement-notifications.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { NativeRunCoordinatorStore } from "../services/native-runtime/native-run-coordinator-store.js";
import { workspaceOperationService } from "../services/workspace-operations.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
vi.mock("../services/agent-task-run-telemetry.js", () => ({ emitAgentTaskRun: vi.fn(async () => undefined) }));
vi.mock("../services/run-failure-report.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/run-failure-report.js")>(), reportRunFailure: vi.fn(async () => undefined),
}));

describe("saved native resource policy", () => {
  it.each([
    ["keep_running", true, false, "keep_running"],
    ["stop_and_retain", true, false, "stop_and_retain"],
    ["destroy", true, false, "destroy"],
    ["keep_running", false, false, "stop_and_retain"],
    ["destroy", false, false, "stop_and_retain"],
    ["keep_running", true, true, "stop_and_retain"],
    ["destroy", true, true, "destroy"],
    ["invalid", true, false, "stop_and_retain"],
    [null, true, false, "stop_and_retain"],
  ] as const)("settles %s with committed=%s and pending export=%s as %s", (saved, succeeded, pending, expected) => {
    expect(nativeEnvironmentSettlementDisposition({ runnerProfileJson: { nativeResourceDisposition: saved },
      resultJson: pending ? { workspaceExportRetry: { pending: true } } : null }, succeeded)).toBe(expected);
  });
});

describe("native environment release scheduling", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db, root: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let worker: ReturnType<ReturnType<typeof nativeEnvironmentSettlementWork>["register"]> | undefined;
  let release: ReturnType<typeof vi.fn<EnvironmentDriver["releaseRunLease"]>>;
  let failing = false, admitted = true;
  let stopOnly: ReturnType<typeof vi.fn>;
  const companyId = randomUUID(), agentId = randomUUID();
  let environmentId: string;
  const priorLogs = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
  const errors: unknown[] = [];
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "native-environment-"));
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = root;
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_ENVIRONMENT_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("native-environment-");
    db = createDb(external ?? temporary!.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Environment settlement", issuePrefix: `NE${randomUUID().slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Release owner", adapterType: "paperclip_runner" });
    environmentId = (await db.select({ id: environments.id }).from(environments).where(eq(environments.driver, "local")))[0].id;
  }, 30_000);
  beforeEach(() => {
    admitted = true; failing = false; errors.length = 0;
    stopOnly = vi.fn(async () => ({ state: "stopped" }));
    release = vi.fn(async input => {
      if (failing) throw new Error("fixture release unavailable");
      return environmentService(db).releaseLease(input.lease.id, input.status ?? "released", { cleanupStatus: "success" });
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined; worker = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.companyId, companyId));
    expect(errors).toEqual([]);
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); await rm(root, { recursive: true, force: true });
    if (priorLogs === undefined) delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    else process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = priorLogs;
  });
  async function start(runtimeEnv?: NodeJS.ProcessEnv) {
    const runtime = environmentRuntimeService(db, { drivers: ["local", "sandbox"].map(driver => ({ driver, releaseRunLease: release, retryPendingSandboxTeardown: stopOnly }) as EnvironmentDriver) });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted, canReconcile: () => admitted,
      onError: error => errors.push(error) });
    worker = heartbeatService(db, { environmentRuntime: runtime, runtimeEnv }).registerNativeEnvironmentSettlementWork(coordinator, () => admitted);
    await worker.ready;
  }
  async function flush() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0);
      expect(coordinator!.nextWakeAt()).toBeNull();
    }, { timeout: 5000 });
  }
  async function quiet() {
    await flush();
    const previous = db.$client.options.debug;
    const queries: string[] = [], calls = release.mock.calls.length;
    db.$client.options.debug = (_id, query) => { queries.push(query); };
    try { await vi.advanceTimersByTimeAsync(120_000); await delay(10); expect(queries).toEqual([]); expect(release).toHaveBeenCalledTimes(calls); }
    finally { db.$client.options.debug = previous; }
  }
  async function seed() {
    const runId = randomUUID(), issueId = randomUUID(), contractId = randomUUID(), sourceInstanceId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Commit accepted work", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "result-worker-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "result-worker-v1", objective: "Finish", criteria: [{ id: "objective", requirement: "Complete the task" }] },
      canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: "native", status: "running",
      nativeIssueId: issueId, nativeSessionId: runId, runnerInstanceId: sourceInstanceId,
      completionContractId: contractId, completionContractSha256: contractId, contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    return { companyId, issueId, runId, agentId, sessionId: runId, completionContractId: contractId,
      completionContractSha256: contractId, sourceInstanceId, controlPlaneSourceInstanceId: "result-worker-test" };
  }
  async function complete(binding: Awaited<ReturnType<typeof seed>>, producer: "control_plane" | "coordinator", writer: Db = db, terminalStatus: "succeeded" | "failed" | "cancelled" = "succeeded") {
    const port = producer === "control_plane" ? new PaperclipControlPlanePort(writer, binding)
      : new NativeRunCoordinatorStore(writer, { ...binding, normalizedSessionId: binding.sessionId,
        runnerSourceInstanceId: binding.sourceInstanceId,
        completionContractRevision: CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.contractRevision,
        completionContractCriterionIds: CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.criteria.map(item => item.criterionId) });
    await port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: { ...CONTROL_PLANE_CONFORMANCE_TERMINAL, runTerminalState: terminalStatus },
      callerResultId: `${binding.runId}:result` });
  }
  async function barrier(binding: Awaited<ReturnType<typeof seed>>) {
    await workspaceOperationService(db).createRecorder({ companyId, issueId: binding.issueId, heartbeatRunId: binding.runId })
      .recordOperation({ phase: "workspace_finalize", cwd: root, run: async () => ({ status: "succeeded", exitCode: 0 }) });
  }
  async function state(runId: string) {
    return db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)).then(rows => rows[0]);
  }
  async function read(runId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then(rows => rows[0]);
  }
  async function accepted(status: "succeeded" | "failed" | "cancelled" = "succeeded") {
    const binding = await seed(); await complete(binding, "control_plane", db, status); await barrier(binding); return binding;
  }
  async function committed() {
    const binding = await accepted();
    const result = await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    expect(result.phase, JSON.stringify(await state(binding.runId))).toBe("committed");
    return binding;
  }
  async function lease(binding: Awaited<ReturnType<typeof seed>>, writer: Db = db) {
    return environmentService(writer).acquireLease({ companyId, environmentId, heartbeatRunId: binding.runId,
      issueId: binding.issueId, leasePolicy: "ephemeral", provider: "local", providerLeaseId: randomUUID() });
  }
  it("discovers and rechecks cleanup without loading unrelated saved run payloads", async () => {
    const payload = "unrelated saved run data ".repeat(24_000);
    const fixtures = [];
    for (const disposition of ["destroy", "keep_running", "stop_and_retain", "invalid"] as const) {
      const binding = await committed();
      const run = await read(binding.runId);
      await db.update(heartbeatRuns).set({
        runnerProfileJson: { ...run.runnerProfileJson, savedInputs: payload, nativeWorkspaceSync: {
          schema: disposition === "invalid" ? "unknown" : "paperclip.native-workspace-sync/v3", state: "finalized",
          descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: "c".repeat(64),
          workspaceId: randomUUID(), leaseId: randomUUID(), providerLeaseId: "saved", remoteCwd: "/workspace",
          resourceDisposition: disposition === "invalid" ? "destroy" : disposition,
        } },
        resultJson: { ...run.resultJson, savedOutput: payload, workspaceExportRetry: { pending: true } },
      }).where(eq(heartbeatRuns.id, binding.runId));
      const acquired = await lease(binding);
      await environmentService(db).releaseLease(acquired.id, "retained", { cleanupStatus: "failed" });
      fixtures.push(binding);
    }
    const events: Record<string, unknown>[] = [];
    const now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(db, { nativeRunFinalizations, heartbeatRuns, environmentLeases }, capture);
    const settle = vi.fn(async () => {});
    const work = nativeEnvironmentSettlementWork(db, settle);
    try {
      const entries = await work.load({ companyId });


      expect(entries.map(entry => entry.id)).toEqual([fixtures[0].runId]);
      expect(await work.check(entries[0])).toMatchObject({ id: fixtures[0].runId });
      expect(settle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runId: fixtures[0].runId, succeeded: true }));
      capture.flush();
      const reads = events.filter(event => event.table === "native_run_finalizations" && event.operation === "select");
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.reduce((calls, event) => calls + Number(event.calls), 0)).toBeGreaterThanOrEqual(3);
      expect(reads.reduce((bytes, event) => bytes + Number(event.responseValueBytes), 0)).toBeLessThan(16_384);
    } finally { capture.flush(); }
    const stored = await read(fixtures[0].runId);
    expect(stored.runnerProfileJson?.savedInputs).toBe(payload);
    expect(stored.resultJson?.savedOutput).toBe(payload);
  });

  it("ignores routine company-only finalization hints and still releases a real native lease", async () => {
    await start(); await quiet();
    const previous = db.$client.options.debug, queries: string[] = [];
    db.$client.options.debug = (_id, query) => queries.push(query);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await db.transaction(tx => notifyNativeFinalizationWork(tx, { companyId }));
        await flush();
      }
      expect(queries.filter(query => query.startsWith("select") && query.includes('"environment_leases"'))).toEqual([]);
    } finally { db.$client.options.debug = previous; }
    const f = await committed(); await lease(f); await flush();
    expect(release).toHaveBeenCalledTimes(1); await quiet();
  });

  it("stays quiet with no release debt and wakes on a lease committed after finalization", async () => {
    const binding = await committed(); await start(); await quiet();
    const acquired = await lease(binding); await flush();
    expect(release).toHaveBeenCalledTimes(1);
    expect((await environmentService(db).getLeaseById(acquired.id))?.status).toBe("released");
    await quiet();
  });
  it("drains a backlog without globally rediscovering it after each lease release", async () => {
    const bindings = [];
    for (let index = 0; index < 6; index += 1) {
      const binding = await committed(); await lease(binding); bindings.push(binding);
    }
    const previous = db.$client.options.debug;
    const discovery: { query: string; parameters: readonly unknown[] }[] = [];
    db.$client.options.debug = (_id, query, parameters) => {
      if (query.includes('from "native_run_finalizations" inner join "heartbeat_runs"')) {
        discovery.push({ query, parameters });
      }
    };
    try {
      await start(); await flush();
      expect(release).toHaveBeenCalledTimes(bindings.length);


      expect(discovery.filter(read => !bindings.some(binding => read.parameters.includes(binding.runId))))
        .toHaveLength(1);
      await quiet();
    } finally { db.$client.options.debug = previous; }
  });

  it("keeps a metadata wake scoped and defers it until the outer transaction commits", async () => {
    const binding = await committed(), acquired = await lease(binding);
    await environmentService(db).releaseLease(acquired.id, "pending_cleanup", { cleanupStatus: "failed" });
    const metadata = { nativeWorkspaceExportResume: {}, pendingCleanupRetryAfterMs: Date.now() + 600_000 };
    await environmentService(db).updateLeaseMetadata(acquired.id, metadata);
    await start();
    const previous = db.$client.options.debug;
    const reads: (readonly unknown[])[] = [];
    db.$client.options.debug = (_id, query, parameters) => {
      if (query.includes('from "native_run_finalizations" inner join "heartbeat_runs"')) reads.push(parameters);
    };
    let finish!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    let write: Promise<unknown> | undefined;
    try {
      write = db.transaction(async tx => {
        await environmentService(tx as unknown as Db).updateLeaseMetadata(acquired.id, metadata);
        entered(); await held;
      });
      await reached; await vi.advanceTimersByTimeAsync(2000);
      expect(reads).toEqual([]);
      finish(); await write;
      await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(reads.length).toBeGreaterThan(0); });
      expect(reads.every(parameters => parameters.includes(binding.runId))).toBe(true);
      expect(release).not.toHaveBeenCalled();
      reads.length = 0;
      await expect(db.transaction(async tx => {
        await environmentService(tx as unknown as Db).updateLeaseMetadata(acquired.id, metadata);
        throw new Error("rolled back metadata");
      })).rejects.toThrow("rolled back metadata");
      await vi.advanceTimersByTimeAsync(2000); expect(reads).toEqual([]);
    } finally { finish(); await write; db.$client.options.debug = previous; }
  });

  it("uses the real finalizer commit to release an existing active lease", async () => {
    const binding = await accepted(); const acquired = await lease(binding);
    await start(); await quiet(); expect(release).not.toHaveBeenCalled();
    await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    await flush(); expect(release).toHaveBeenCalledTimes(1);
    expect((await environmentService(db).getLeaseById(acquired.id))?.cleanupStatus).toBe("success"); await quiet();
  });
  it("reconstructs an unfinished release on restart and ignores released history", async () => {
    const binding = await committed(), acquired = await lease(binding);
    await start(); await flush(); expect(release).toHaveBeenCalledTimes(1);
    await coordinator!.stop(); coordinator = undefined;
    await start(); await quiet(); expect(release).toHaveBeenCalledTimes(1);
    expect((await environmentService(db).getLeaseById(acquired.id))?.status).toBe("released");
  });
  it("does not release a nested acquisition until the outer commit, or after rollback", async () => {
    const binding = await committed(); await start(); await quiet();
    let finish!: () => void, ready!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const hold = new Promise<void>(resolve => { finish = resolve; });
    const writing = db.transaction(async tx => { const acquired = await lease(binding, tx as unknown as Db); ready(); await hold; return acquired; });
    await entered; await vi.advanceTimersByTimeAsync(2000); expect(release).not.toHaveBeenCalled();
    finish(); await writing; await flush(); expect(release).toHaveBeenCalledTimes(1);
    await expect(db.transaction(async tx => { await lease(binding, tx as unknown as Db); throw new Error("rollback"); })).rejects.toThrow("rollback");
    await quiet(); expect(release).toHaveBeenCalledTimes(1);
  });
  it("retains a concrete failure deadline even though the release API logs and swallows errors", async () => {
    const binding = await committed(), acquired = await lease(binding); failing = true;
    await start(); expect(release).toHaveBeenCalledTimes(1); expect(coordinator!.nextWakeAt()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10_000); expect(release).toHaveBeenCalledTimes(1);
    failing = false; await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect(release).toHaveBeenCalledTimes(2);
    expect((await environmentService(db).getLeaseById(acquired.id))?.status).toBe("released"); await quiet();
  });
  it("retains a first wake while drained without SQL, then releases on resume", async () => {
    const binding = await committed(); await start(); await quiet(); admitted = false;
    const acquired = await lease(binding); await vi.advanceTimersByTimeAsync(1000);
    const reads: string[] = [], previous = db.$client.options.debug;
    db.$client.options.debug = (_id, query) => { reads.push(query); };
    await vi.advanceTimersByTimeAsync(120_000); await delay(10);
    db.$client.options.debug = previous;
    expect(reads).toEqual([]); expect(release).not.toHaveBeenCalled();
    admitted = true; await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect((await environmentService(db).getLeaseById(acquired.id))?.status).toBe("released"); await quiet();
  });
  it("does not confuse a running or unverified native owner with settled work", async () => {
    const binding = await committed(); const acquired = await lease(binding);
    await db.update(heartbeatRuns).set({ status: "running", nativePhase: "terminal_failure", errorCode: "native_execution_ownership_unverified" }).where(eq(heartbeatRuns.id, binding.runId));
    await start(); await quiet(); expect(release).not.toHaveBeenCalled();
    expect((await environmentService(db).getLeaseById(acquired.id))?.status).toBe("active");
  });
  it("ignores retained success and ordinary pending cleanup owned by the cleanup worker", async () => {
    const binding = await committed(); const retained = await lease(binding), cleanup = await lease(binding);
    await environmentService(db).releaseLease(retained.id, "retained", { cleanupStatus: "success" });
    await environmentService(db).releaseLease(cleanup.id, "pending_cleanup", { cleanupStatus: "failed" });
    await start(); await quiet(); expect(release).not.toHaveBeenCalled();
  });
  it("honors the saved pending-cleanup deadline and the exact company scope", async () => {
    const binding = await committed(), acquired = await lease(binding);
    await environmentService(db).updateLeaseMetadata(acquired.id, { nativeWorkspaceExportResume: {}, pendingCleanupRetryAfterMs: Date.now() + 600_000 });
    await environmentService(db).releaseLease(acquired.id, "pending_cleanup", { cleanupStatus: "failed" });
    const work = nativeEnvironmentSettlementWork(db, async () => undefined);
    expect(await work.load({ companyId: randomUUID(), runId: binding.runId })).toEqual([]);
    const [pending] = await work.load({ companyId, runId: binding.runId });
    expect(pending.dueAt).toBeGreaterThanOrEqual(Date.now() + 599_000);
    await start(); expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000); expect(release).not.toHaveBeenCalled();
    await environmentService(db).releaseLease(acquired.id, "released", { cleanupStatus: "success" }); await quiet();
  });
  it("wakes from the real lifecycle writer when an execution hold is resolved", async () => {
    const binding = await committed(); const acquired = await lease(binding);
    await db.update(heartbeatRuns).set({ status: "running", nativePhase: "terminal_failure", errorCode: "native_execution_ownership_unverified" }).where(eq(heartbeatRuns.id, binding.runId));
    await start(); await quiet();
    const lifecycle = createHeartbeatLifecycle(db, { emitTerminalAgentTaskRun: vi.fn() } as unknown as HeartbeatLifecycleDependencies);
    await lifecycle.setRunStatus(binding.runId, "succeeded", { nativePhase: "committed", errorCode: null });
    await flush(); expect((await environmentService(db).getLeaseById(acquired.id))?.status).toBe("released"); await quiet();
  });
  it.each(["restore", "worktree"])("preserves %s suppression and reactivates through settings", async mode => {
    const binding = await committed(), acquired = await lease(binding);
    const runtimeEnv = mode === "restore" ? { PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "true" }
      : { PAPERCLIP_IN_WORKTREE: "true", PAPERCLIP_INSTANCE_ID: "environment-suppression-test" };
    const settings = instanceSettingsService(db, { runtimeEnv });
    if (mode === "worktree") await settings.updateExperimental({ enableWorktreeRunExecution: false });
    await start(runtimeEnv); await quiet(); expect(release).not.toHaveBeenCalled();
    expect((await environmentService(db).getLeaseById(acquired.id))?.status).toBe("active");
    if (mode === "worktree") {
      try {
        await settings.updateExperimental({ enableWorktreeRunExecution: true });
        await flush(); expect((await environmentService(db).getLeaseById(acquired.id))?.status).toBe("released"); await quiet();
      } finally { await settings.updateExperimental({ enableWorktreeRunExecution: false }); }
    }
  });
  it.each(["workspace", "runtime"])("preserves %s keep-running retention without stopping the completed Runner", async source => {
    const binding = await committed();
    await db.update(heartbeatRuns).set({ runnerProfileJson: source === "runtime" ? { nativeResourceDisposition: "keep_running" } : { nativeWorkspaceSync: {
      schema: "paperclip.native-workspace-sync/v3", state: "finalized", descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64),
      finalHostSha256: "c".repeat(64), workspaceId: randomUUID(), leaseId: randomUUID(), providerLeaseId: "kept", remoteCwd: "/workspace",
      resourceDisposition: "keep_running",
    } } }).where(eq(heartbeatRuns.id, binding.runId));
    const acquired = await environmentService(db).acquireLease({ companyId, environmentId, heartbeatRunId: binding.runId,
      issueId: binding.issueId, leasePolicy: "reuse_by_environment", provider: "local", providerLeaseId: "kept" });
    await start(); await flush(); expect(release).not.toHaveBeenCalled();
    expect((await environmentService(db).getLeaseById(acquired.id))?.status).toBe("retained"); await quiet();
  });
  it.each(["failed", "cancelled"] as const)("stops a %s run despite its selected warm policy", async status => {
    const binding = await committed();
    await db.update(heartbeatRuns).set({ status, runnerProfileJson: { nativeResourceDisposition: "keep_running" } })
      .where(eq(heartbeatRuns.id, binding.runId));
    const acquired = await environmentService(db).acquireLease({ companyId, environmentId, heartbeatRunId: binding.runId,
      issueId: binding.issueId, leasePolicy: "reuse_by_environment", provider: "local", providerLeaseId: randomUUID() });
    await start(); await flush();
    expect(release).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ resourceDisposition: "stop_and_retain" }));
    expect((await environmentService(db).getLeaseById(acquired.id))?.status).toBe("released");
    expect((await read(binding.runId)).status).toBe(status);
    await quiet();
  });
  it.each([true, false])("delegates only periodic environment settlement, keeping manual behavior and other callbacks: %s", async delegated => {
    const binding = await committed(), acquired = await lease(binding);
    const runtimeRelease = vi.spyOn(workspaceRuntime, "releaseRuntimeServicesForRun");
    const runtime = environmentRuntimeService(db, { drivers: ["local", "sandbox"].map(driver => ({ driver, releaseRunLease: release, retryPendingSandboxTeardown: stopOnly }) as EnvironmentDriver) });
    await heartbeatService(db, { environmentRuntime: runtime }).reapOrphanedRuns({ staleThresholdMs: 300_000,
      skipScheduledRetryCancellation: true, skipCapturedInstructionCommit: true, skipInstructionDirectoryCleanup: true,
      skipStoppedInstructionCollection: true, skipCancelledWorkspacePreservation: true, skipObsoletePolicyReviews: true,
      skipAutomaticCompletionReviews: true, skipUnsafeWorkspaceExports: true, skipNativePendingEffects: true,
      skipNativeResponsePresentation: true, skipNativeReviewResponse: true, skipNativeStatusReassessment: true,
      skipRetainedNativeSessionCleanup: true, skipNativeWorkspaceFinalization: true, skipNativeResultCommit: true,
      skipNativeRunProjection: true, skipNativeRecoveryNotices: true, skipExternalConversationSettlement: true,
      skipExternalAgentSettlement: true, skipNativeEnvironmentSettlement: delegated,
    });
    expect(release.mock.calls.filter(([input]) => input.lease.heartbeatRunId === binding.runId)).toHaveLength(delegated ? 0 : 1);
    expect(runtimeRelease).toHaveBeenCalledWith(binding.runId);
    expect((await environmentService(db).getLeaseById(acquired.id))?.status).toBe(delegated ? "active" : "released");
  });

  it("wakes from a durable exhausted workspace-export failure and uses failed-run retention", async () => {
    const binding = await seed(); await complete(binding, "control_plane"); const acquired = await lease(binding);
    await start(); await quiet();
    const failure = await recordNativeWorkspaceFinalizationFailure(db, binding.runId, { stderrExcerpt: "workspace_sync_out_unrecoverable" });
    expect(failure.phase).toBe("terminal_failure");
    await flush(); expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ resourceDisposition: "stop_and_retain", status: "failed" }));
    expect((await environmentService(db).getLeaseById(acquired.id))?.status).toBe("failed"); await quiet();
  });
  it("retains a lease committed during a release and does not overlap physical attempts", async () => {
    const binding = await committed(); await lease(binding);
    let finish!: () => void, started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const hold = new Promise<void>(resolve => { finish = resolve; });
    release.mockImplementationOnce(async input => {
      started(); await hold;
      return environmentService(db).releaseLease(input.lease.id, "released", { cleanupStatus: "success" });
    });
    const starting = start(); await began;
    const later = await lease(binding); await vi.advanceTimersByTimeAsync(2000);
    expect(release).toHaveBeenCalledTimes(1); finish(); await starting;
    await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect(release).toHaveBeenCalledTimes(2);
    expect((await environmentService(db).getLeaseById(later.id))?.status).toBe("released"); await quiet();
  });

  it("does not let an active lease pull a second lease's cleanup deadline forward", async () => {
    const binding = await committed(); const active = await lease(binding), deferred = await lease(binding);
    await environmentService(db).updateLeaseMetadata(deferred.id, {
      nativeWorkspaceExportResume: {}, pendingCleanupRetryAfterMs: Date.now() + 600_000,
    });
    await environmentService(db).releaseLease(deferred.id, "pending_cleanup", { cleanupStatus: "failed" });
    await start();
    expect((await environmentService(db).getLeaseById(active.id))?.status).toBe("released");
    expect(stopOnly).not.toHaveBeenCalled();
    expect((await environmentService(db).getLeaseById(deferred.id))?.metadata?.pendingCleanupInFlight).not.toBe(true);
    await environmentService(db).releaseLease(deferred.id, "released", { cleanupStatus: "success" }); await quiet();
  });
  it("preserves a failed release's retry floor across unrelated lease notifications", async () => {
    const binding = await committed(); await lease(binding); failing = true;
    await start(); expect(release).toHaveBeenCalledTimes(1);
    const other = await seed(), otherLease = await lease(other);
    for (let i = 0; i < 3; i++) {
      await environmentService(db).updateLeaseMetadata(otherLease.id, { change: i });
      await vi.advanceTimersByTimeAsync(2000); await delay(10);
    }
    expect(release).toHaveBeenCalledTimes(1);
    failing = false; await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect(release).toHaveBeenCalledTimes(2); await quiet();
  });

  it("permits the first attempt for a freshly prepared stop without bypassing an old retry", async () => {
    const binding = await committed(), sandboxId = randomUUID();
    await db.insert(environments).values({ id: sandboxId, name: `Fresh stop ${sandboxId}`, driver: "sandbox" });
    const acquired = await environmentService(db).acquireLease({ companyId, environmentId: sandboxId,
      heartbeatRunId: binding.runId, issueId: binding.issueId, leasePolicy: "ephemeral", provider: "e2b", providerLeaseId: "fresh-stop" });
    await start(); expect(stopOnly).toHaveBeenCalledTimes(1);


    await environmentService(db).releaseLease(acquired.id, "released", { cleanupStatus: "success" }); await quiet();
  });

});
