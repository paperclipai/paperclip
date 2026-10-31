import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginEnvironmentTaskOperation } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases,
  environments, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults,
} from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";
import { prepareNativeHeartbeatRun } from "../services/native-runtime/prepare-native-run.js";
import {
  acknowledgeNativeStartupCleanup, NATIVE_STARTUP_CLEANUP_PENDING, readNativeStartupCleanup,
  requestNativeStartupCleanup, verifyNativeStartupCleanup,
} from "../services/native-runtime/native-startup-cleanup.js";
import { isNativeRunnerOwnershipHeld } from "../services/native-runtime/native-runner-ownership.js";
import { cancelNativeSession } from "../services/native-runtime/native-session-executor.js";
import * as nativeSessionExecutor from "../services/native-runtime/native-session-executor.js";
import { NativeExecutionContext } from "../services/native-runtime/native-execution-context.js";
import type { NativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import { callbacks } from "../services/heartbeat/__tests__/run-control-fixtures.js";
import { createHeartbeatRunControl } from "../services/heartbeat/run-control.js";
import { executionControlSchedule } from "../services/execution-control-work.js";
import { claimNativeRestartRecoveries } from "../services/native-runtime/native-restart-recovery.js";
import { reconcileAbandonedExecutionControl } from "../services/execution-control-reconciliation.js";
import { createPluginWorkerManager } from "../services/plugin-worker-manager.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;

describePostgres("durable cleanup after a native startup timeout", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let home: ReturnType<typeof createIsolatedTestHome>;
  const originalHome = process.env.PAPERCLIP_HOME;
  const companyId = randomUUID(), agentId = randomUUID();

  beforeAll(async () => {
    home = createIsolatedTestHome();
    process.env.PAPERCLIP_HOME = home.home;
    temporary = await startRecoveryPostgres("native-startup-cleanup-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Startup cleanup", issuePrefix: "NSC" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Runner", role: "engineer", status: "running",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex" }, runtimeConfig: {}, permissions: {} });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await temporary?.cleanup();
    home?.cleanup();
    if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalHome;
  });

  async function fixture(requiresPreparationStop = false) {
    const runId = randomUUID(), issueId = randomUUID(), leaseId = randomUUID(), taskId = randomUUID();
    const contextId = randomUUID(), leaseOwner = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, identifier: `NSC-${issueId}`, title: "Timed out startup",
      status: "in_progress", priority: "medium", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running",
      runtimeMode: "native", nativeIssueId: issueId, invocationSource: "manual", contextSnapshot: { issueId } }).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    await prepareNativeHeartbeatRun({ db, run, issue: { id: issueId, title: "Timed out startup", description: null }, environmentLeaseId: leaseId });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", attempt: 1,
      controllerGeneration: 1, controllerBootId: randomUUID(), controllerPid: process.pid,
      controllerProcessStartedAt: new Date(), leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) });
    const [environment] = await db.insert(environments).values({ name: `Cleanup ${runId}`, driver: "plugin", status: "active", config: {} }).returning();
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId: environment.id, heartbeatRunId: runId,
      issueId, status: "active", provider: "plugin", providerLeaseId: taskId, leasePolicy: "reuse_by_environment",
      metadata: { runnerTaskLease: true, runnerTaskReused: true } });
    const request = { companyId, agentId, runId, contextId, leaseOwner, deadlineAtMs: Date.now() - 1, requiresPreparationStop };
    const reload = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then(rows => rows[0]!);
    const owner = () => db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)).then(rows => rows[0]!);
    const lease = () => db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)).then(rows => rows[0]!);
    const stopReceipt = async (override: Record<string, unknown> = {}, preparationStopped = false) => {
      const current = await lease();
      const receipt = remoteTerminationReceipt(current, { providerLeaseId: taskId, state: "stopped" });
      await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success",
        metadata: { ...current.metadata, ...(preparationStopped ? { runnerTaskPreparationStopped: true } : {}), remoteExecutionTermination: { ...receipt, ...override } } }).where(eq(environmentLeases.id, leaseId));
    };
    const acceptedResult = async () => {
      const current = await reload(), resultId = randomUUID();
      await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId,
        completionContractId: current.completionContractId!, serverFingerprint: resultId, schemaStatus: "accepted",
        resultJson: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Completed work" }, canonicalSha256: "a".repeat(64) });
      await db.update(nativeRunFinalizations).set({ resultId, phase: "workspace_finalizing" }).where(eq(nativeRunFinalizations.runId, runId));
      return resultId;
    };
    return { request, reload, owner, lease, stopReceipt, acceptedResult };
  }

  it("returns the deadline queue to quiet and wakes again for the next startup failure", async () => {
    const schedule = executionControlSchedule(db);
    expect(await schedule.finalization()).toBeNull();
    for (let failure = 0; failure < 2; failure += 1) {
      const f = await fixture(true);
      await requestNativeStartupCleanup(db, f.request);
      expect(await schedule.finalization()).not.toBeNull();
      const deps = callbacks(db);
      deps.verifyStartupCleanup = run => verifyNativeStartupCleanup(db, run, () => f.stopReceipt({}, true));
      const control = createHeartbeatRunControl(db, deps);
      await reconcileAbandonedExecutionControl(db, new Date(Date.now() + 1_000), { startupCleanup: async scope => {
        if (scope.runId !== f.request.runId) return;
        await control.cancelRunInternal(scope.runId, "Startup cleanup retry");
        await acknowledgeNativeStartupCleanup(db, scope);
      } });
      expect((await f.reload()).status).toBe("cancelled");
      expect(await f.owner()).toMatchObject({ leaseOwner: null, controlDeadlineAt: null });
      expect(await schedule.finalization()).toBeNull();
    }
  });

  it("discovers a crash after warm prepare dispatch but before a cleanup intent was recorded", async () => {
    const f = await fixture(true), lease = await f.lease();
    await db.update(environmentLeases).set({ metadata: { ...lease.metadata, runnerTaskStartup: {
      contextId: f.request.contextId, deadlineAtMs: f.request.deadlineAtMs, runId: f.request.runId,
    } } }).where(eq(environmentLeases.id, lease.id));
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(nativeRunFinalizations.runId, f.request.runId));
    expect(readNativeStartupCleanup(await f.reload())).toBeNull();
    const onClaim = vi.fn();
    const result = await claimNativeRestartRecoveries({ db, restartKind: "hard", runIds: [f.request.runId],
      controller: { bootId: randomUUID(), pid: process.pid, processStartedAt: new Date() }, onClaim });
    expect(result).toEqual([{ kind: "blocked", runId: f.request.runId, reason: NATIVE_STARTUP_CLEANUP_PENDING }]);
    expect(onClaim).not.toHaveBeenCalled();
    expect(readNativeStartupCleanup(await f.reload())).toMatchObject({ contextId: f.request.contextId,
      state: "pending", requiresPreparationStop: true });
    expect(isNativeRunnerOwnershipHeld(await f.reload())).toBe(false);
  });

  it.each(["wrong_run", "future_deadline", "live_owner", "checkpointed", "missing_marker"])(
    "does not infer a timed-out startup from %s", async variant => {
      const f = await fixture(true), lease = await f.lease();
      if (variant !== "missing_marker") await db.update(environmentLeases).set({ metadata: { ...lease.metadata,
        runnerTaskStartup: { contextId: f.request.contextId, runId: variant === "wrong_run" ? randomUUID() : f.request.runId,
          deadlineAtMs: variant === "future_deadline" ? Date.now() + 60_000 : f.request.deadlineAtMs },
      } }).where(eq(environmentLeases.id, lease.id));
      await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() + (variant === "live_owner" ? 60_000 : -1_000)) })
        .where(eq(nativeRunFinalizations.runId, f.request.runId));
      if (variant === "checkpointed") await db.update(heartbeatRuns).set({ sessionIdAfter: "current-run-checkpoint" })
        .where(eq(heartbeatRuns.id, f.request.runId));
      await claimNativeRestartRecoveries({ db, restartKind: "hard", runIds: [f.request.runId],
        controller: { bootId: randomUUID(), pid: process.pid, processStartedAt: new Date() } });
      expect(readNativeStartupCleanup(await f.reload())).toBeNull();
    });

  it("persists an audited cancellation intent that a new database handle can recover without a generic hold", async () => {
    const f = await fixture();
    expect(await requestNativeStartupCleanup(db, f.request)).toBe(true);
    const run = await f.reload(), marker = readNativeStartupCleanup(run)!;
    expect(marker).toMatchObject({ state: "pending", contextId: f.request.contextId, leaseOwner: f.request.leaseOwner,
      controllerGeneration: 1, attempt: 1, taskId: (await f.lease()).providerLeaseId });
    expect(run).toMatchObject({ status: "running", errorCode: NATIVE_STARTUP_CLEANUP_PENDING });
    expect(run.resultJson?.startupCancellation).toMatchObject({ requestedAt: expect.any(String) });
    expect(isNativeRunnerOwnershipHeld(run)).toBe(false);
    expect(await db.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.id, marker.auditId),
      eq(activityLog.companyId, companyId), eq(activityLog.action, "native.startup_cleanup_requested")))).toHaveLength(1);
    const restarted = createDb(temporary.connectionString), release = vi.fn(f.stopReceipt);
    await verifyNativeStartupCleanup(restarted, await f.reload(), release);
    await verifyNativeStartupCleanup(restarted, await f.reload(), release);
    expect(release).toHaveBeenCalledOnce();
    expect(readNativeStartupCleanup(await f.reload())?.state).toBe("complete");
    await acknowledgeNativeStartupCleanup(restarted, { companyId, runId: run.id });
    expect((await f.owner()).controlDeadlineAt).not.toBeNull();
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run.id));
    await acknowledgeNativeStartupCleanup(restarted, { companyId, runId: run.id });
    expect(await f.owner()).toMatchObject({ leaseOwner: null, leaseExpiresAt: null, controlDeadlineAt: null, recoveryState: null });
  });

  it("keeps cleanup bound to the explicit current lease when a released alias belongs to the same run", async () => {
    const f = await fixture(true), current = await f.lease();
    const aliasId = randomUUID();
    await db.insert(environmentLeases).values({ ...current, id: aliasId, providerLeaseId: randomUUID(),
      status: "released", releasedAt: new Date(), cleanupStatus: "success" });
    expect(await requestNativeStartupCleanup(db, { ...f.request, leaseId: current.id })).toBe(true);
    expect(readNativeStartupCleanup(await f.reload())).toMatchObject({ leaseId: current.id, taskId: current.providerLeaseId });
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, aliasId)))[0]?.metadata?.runnerTaskStartupCleanup).toBeUndefined();
  });

  it("recovers an exact Stop receipt committed before Core records completion", async () => {
    const f = await fixture();
    await requestNativeStartupCleanup(db, f.request);
    await f.stopReceipt();
    const release = vi.fn(async () => { throw new Error("Already retired task must not be released twice"); });
    await verifyNativeStartupCleanup(createDb(temporary.connectionString), await f.reload(), release);
    expect(release).not.toHaveBeenCalled();
    expect(readNativeStartupCleanup(await f.reload())?.state).toBe("complete");
  });

  it("keeps accelerated preparation pending when only the provider has stopped", async () => {
    const f = await fixture(true);
    await requestNativeStartupCleanup(db, f.request);
    await expect(verifyNativeStartupCleanup(db, await f.reload(), () => f.stopReceipt())).rejects.toThrow(/pending|preparation/i);
    expect(readNativeStartupCleanup(await f.reload())?.state).toBe("pending");
    expect((await f.owner()).leaseOwner).toBe(f.request.leaseOwner);
  });

  it("automatically finishes pending cleanup after a late real worker reply and exact preparation Stop proof", async () => {
    const f = await fixture(true), lease = await f.lease();
    const entrypointPath = path.join(home.home, `cleanup-worker-${f.request.runId}.cjs`);
    await writeFile(entrypointPath, `
const rl=require("node:readline").createInterface({input:process.stdin,crlfDelay:Infinity});
const held=[];let stopped=false;
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,result})+"\\n");
rl.on("line",line=>{const m=JSON.parse(line);
 if(m.method==="initialize")send(m.id,{ok:true,supportedMethods:["environmentTask","configChanged"]});
 else if(m.method==="environmentTask"){
  const kind=m.params.operation.kind;
  if(kind==="prepare")held.push(m.id);
  else if(kind==="status")send(m.id,{kind:"status",taskId:m.params.taskId,phase:stopped?"cancelled":"running",executionStopped:stopped,preparationStopped:stopped&&held.length===0});
  else {if(kind==="stop")stopped=true;send(m.id,{kind:"accepted",taskId:m.params.taskId});}
 }else if(m.method==="configChanged"){for(const id of held.splice(0))send(id,{});send(m.id,{});}
 else if(m.method==="shutdown"){send(m.id,{});setImmediate(()=>process.exit(0));}
});
`, { mode: 0o600 });
    const manifest: PaperclipPluginManifestV1 = { id: "test.startup-cleanup", apiVersion: 1, version: "1.0.0",
      displayName: "Cleanup fixture", description: "Cleanup fixture", author: "Paperclip", categories: ["automation"],
      capabilities: [], entrypoints: { worker: "worker.cjs" } };
    const manager = createPluginWorkerManager();
    await manager.startWorker(manifest.id, { entrypointPath, manifest, config: {},
      instanceInfo: { instanceId: "cleanup", hostVersion: "1.0.0" }, apiVersion: 1, hostHandlers: {} });
    const context = new NativeExecutionContext({ binding: { companyId, agentId, runId: f.request.runId } } as NativeExecutionInput, 100);
    const params = { companyId, agentId, runId: f.request.runId, environmentId: lease.environmentId, issueId: lease.issueId,
      driverKey: "tasks", taskId: lease.providerLeaseId!, config: {}, projectIds: [], lease: { providerLeaseId: lease.providerLeaseId! } };
    const operation = { kind: "prepare", projectIds: [], requirements: { schema: "paperclip.runner.launch-requirements.v1",
      identity: { runnerInstanceId: "fixture", environmentLeaseId: lease.id, runId: f.request.runId,
        normalizedSessionId: "session", turnId: "turn", itemId: "item" }, provider: "codex", model: null,
      instructions: "Synthetic", runtimeContext: null, settings: {}, approvalPolicy: "never", readOnly: false,
      preparedConversation: false, includeCollaborationModeInstructions: false } } as PluginEnvironmentTaskOperation;
    const release = async () => {
      await manager.call(manifest.id, "environmentTask", { ...params, operation: { kind: "stop" } });
      const status = await manager.call(manifest.id, "environmentTask", { ...params, operation: { kind: "status" } });
      if (status.kind === "status" && status.executionStopped && status.preparationStopped) {
        await manager.call(manifest.id, "environmentTask", { ...params, operation: { kind: "complete" } });
        await f.stopReceipt({}, true);
      }
    };
    try {
      await expect(manager.call(manifest.id, "environmentTask", { ...params, operation }, 10, undefined, context.trackWorker())).rejects.toThrow("timed out");
      if (!context.signal.aborted) await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      expect(context.pending).toBe(true);
      expect(await requestNativeStartupCleanup(db, { ...f.request, contextId: context.id, deadlineAtMs: context.deadlineAtMs })).toBe(true);
      expect(isNativeRunnerOwnershipHeld(await f.reload())).toBe(false);
      await expect(cancelNativeSession(f.request.runId, "Startup timeout", { db, scope: "run" })).resolves.toMatchObject({ auditId: expect.any(String) });
      await expect(verifyNativeStartupCleanup(db, await f.reload(), release)).rejects.toThrow("pending");
      expect((await f.reload()).status).toBe("running");
      await manager.call(manifest.id, "configChanged", { companyId, config: { release: true } });
      expect(context.pending).toBe(false);
      await verifyNativeStartupCleanup(createDb(temporary.connectionString), await f.reload(), release);
      expect(readNativeStartupCleanup(await f.reload())?.state).toBe("complete");
      expect((await f.lease()).metadata?.runnerTaskPreparationStopped).toBe(true);
    } finally { context.finish(); await manager.stopAll(); }
  });

  it("terminalizes through assembled run control only after verified cleanup succeeds", async () => {
    const f = await fixture(true);
    await requestNativeStartupCleanup(db, f.request);
    let drained = false;
    const deps = callbacks(db);
    deps.verifyStartupCleanup = run => verifyNativeStartupCleanup(db, run, () => f.stopReceipt({}, drained));
    const control = createHeartbeatRunControl(db, deps);
    await expect(control.cancelRunInternal(f.request.runId, "Startup timeout")).rejects.toThrow("pending");
    expect(await f.reload()).toMatchObject({ status: "running", errorCode: NATIVE_STARTUP_CLEANUP_PENDING });
    expect((await f.owner()).leaseOwner).toBe(f.request.leaseOwner);
    drained = true;
    const result = await control.cancelRunInternal(f.request.runId, "Startup timeout");
    expect(result).toMatchObject({ status: "cancelled" });
    expect(readNativeStartupCleanup(await f.reload())?.state).toBe("complete");
    expect(await f.owner()).toMatchObject({ leaseOwner: null, leaseExpiresAt: null, controlDeadlineAt: null });
  });

  it("joins cleanup recorded while an operator Stop waits for native startup", async () => {
    const f = await fixture(true);
    let entered!: () => void, resume!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const settled = new Promise<void>(resolve => { resume = resolve; });
    const cancel = nativeSessionExecutor.cancelNativeSession;
    const spy = vi.spyOn(nativeSessionExecutor, "cancelNativeSession").mockImplementation(async (...args) => {
      const result = await cancel(...args);
      if (args[0] === f.request.runId) { entered(); await settled; }
      return result;
    });
    let drained = false;
    const deps = callbacks(db);
    deps.verifyStartupCleanup = vi.fn(run => verifyNativeStartupCleanup(db, run, () => f.stopReceipt({}, drained)));
    const control = createHeartbeatRunControl(db, deps);
    try {
      const stopping = control.cancelRunInternal(f.request.runId, "Operator Stop");
      const outcome = stopping.then(value => ({ value }), error => ({ error }));
      await waiting;
      expect(await requestNativeStartupCleanup(db, f.request)).toBe(true);
      resume();
      expect(await outcome).toMatchObject({ error: expect.objectContaining({ message: "Task cleanup is still pending" }) });
      expect(deps.verifyStartupCleanup).toHaveBeenCalledOnce();
      expect((await f.reload()).status).toBe("running");
      expect((await f.owner()).leaseOwner).toBe(f.request.leaseOwner);
      drained = true;
      expect(await control.cancelRunInternal(f.request.runId, "Operator Stop")).toMatchObject({ status: "cancelled" });
      expect(readNativeStartupCleanup(await f.reload())?.state).toBe("complete");
      expect((await f.owner()).leaseOwner).toBeNull();
    } finally { resume(); spy.mockRestore(); }
  });

  it("rejects a cancellation commit when cleanup arrives after its final read", async () => {
    const f = await fixture(true);
    const deps = callbacks(db), commit = deps.setRunStatusFromLive.getMockImplementation()!;
    deps.setRunStatusFromLive.mockImplementationOnce(async (...args) => {
      expect(await requestNativeStartupCleanup(db, f.request)).toBe(true);
      return commit(...args);
    });
    deps.verifyStartupCleanup = vi.fn(run => verifyNativeStartupCleanup(db, run, () => f.stopReceipt({}, true)));
    const control = createHeartbeatRunControl(db, deps);
    expect(await control.cancelRunInternal(f.request.runId, "Operator Stop")).toMatchObject({ status: "running" });
    expect(readNativeStartupCleanup(await f.reload())?.state).toBe("pending");
    expect((await f.owner()).leaseOwner).toBe(f.request.leaseOwner);
    expect(deps.startNextQueuedRunForAgent).not.toHaveBeenCalled();
    expect(await control.cancelRunInternal(f.request.runId, "Operator Stop")).toMatchObject({ status: "cancelled" });
    expect(readNativeStartupCleanup(await f.reload())?.state).toBe("complete");
    expect((await f.owner()).leaseOwner).toBeNull();
  });

  it("restarts the real cancellation flow after remote Stop committed before Core acknowledgement", async () => {
    const f = await fixture(true);
    await requestNativeStartupCleanup(db, f.request);
    await f.stopReceipt({}, true);
    const restarted = createDb(temporary.connectionString), release = vi.fn(async () => { throw new Error("Stop receipt already persisted"); });
    const deps = callbacks(restarted);
    deps.verifyStartupCleanup = run => verifyNativeStartupCleanup(restarted, run, release);
    const control = createHeartbeatRunControl(restarted, deps);
    const reconcile = vi.fn(async (scope: { companyId: string; runId: string }) => {
      if (scope.runId !== f.request.runId) return;
      expect(scope.companyId).toBe(companyId);
      await control.cancelRunInternal(scope.runId, "Startup timeout recovered after restart");
      await acknowledgeNativeStartupCleanup(restarted, scope);
    });
    await reconcileAbandonedExecutionControl(restarted, new Date(Date.now() + 1_000), { startupCleanup: reconcile });
    expect(reconcile.mock.calls.some(([scope]) => scope.runId === f.request.runId)).toBe(true);
    expect(release).not.toHaveBeenCalled();
    expect((await f.reload()).status).toBe("cancelled");
    expect(readNativeStartupCleanup(await f.reload())?.state).toBe("complete");
    expect(await f.owner()).toMatchObject({ leaseOwner: null, leaseExpiresAt: null, controlDeadlineAt: null });
  });

  it.each(["providerLeaseId", "runId", "leaseId"])("rejects a Stop receipt for another %s", async field => {
    const f = await fixture();
    await requestNativeStartupCleanup(db, f.request);
    await expect(verifyNativeStartupCleanup(db, await f.reload(), () => f.stopReceipt({ [field]: randomUUID() }))).rejects.toThrow("pending");
    expect(readNativeStartupCleanup(await f.reload())?.state).toBe("pending");
  });

  it("does not issue a Stop against a newer controller generation", async () => {
    const f = await fixture();
    await requestNativeStartupCleanup(db, f.request);
    await db.update(nativeRunFinalizations).set({ controllerGeneration: 2 }).where(eq(nativeRunFinalizations.runId, f.request.runId));
    const release = vi.fn(f.stopReceipt);
    await expect(verifyNativeStartupCleanup(db, await f.reload(), release)).rejects.toThrow("ownership changed");
    expect(release).not.toHaveBeenCalled();
    expect(readNativeStartupCleanup(await f.reload())?.state).toBe("pending");
  });

  it("rejects a stale generation that changes while Stop is in flight", async () => {
    const f = await fixture();
    await requestNativeStartupCleanup(db, f.request);
    await expect(verifyNativeStartupCleanup(db, await f.reload(), async () => {
      await f.stopReceipt();
      await db.update(nativeRunFinalizations).set({ controllerGeneration: 2 }).where(eq(nativeRunFinalizations.runId, f.request.runId));
    })).rejects.toThrow("ownership changed");
    expect(readNativeStartupCleanup(await f.reload())?.state).toBe("pending");
  });

  it("preserves a final result that wins while verified cleanup is in flight", async () => {
    const f = await fixture();
    await requestNativeStartupCleanup(db, f.request);
    let resultId: string;
    await expect(verifyNativeStartupCleanup(db, await f.reload(), async () => {
      await f.stopReceipt();
      resultId = await f.acceptedResult();
    })).rejects.toThrow("ownership changed");
    expect(await f.owner()).toMatchObject({ resultId: resultId!, phase: "workspace_finalizing" });
    expect(readNativeStartupCleanup(await f.reload())?.state).toBe("pending");
  });

  it.each(["native_adopted_runner_authentication_timeout", "native_execution_ownership_unverified"])("preserves the existing %s hold", async errorCode => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ errorCode, nativePhase: "terminal_failure" }).where(eq(heartbeatRuns.id, f.request.runId));
    expect(await requestNativeStartupCleanup(db, f.request)).toBe(false);
    const current = await f.reload();
    expect(current).toMatchObject({ status: "running", errorCode, nativePhase: "terminal_failure" });
    expect(readNativeStartupCleanup(current)).toBeNull();
  });

  it("does not replace a final result with a timeout intent", async () => {
    const f = await fixture();
    const resultId = await f.acceptedResult();
    expect(await requestNativeStartupCleanup(db, f.request)).toBe(false);
    expect((await f.owner()).resultId).toBe(resultId);
    expect(readNativeStartupCleanup(await f.reload())).toBeNull();
  });
});
