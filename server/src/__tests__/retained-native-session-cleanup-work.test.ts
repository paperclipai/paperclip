import { heartbeatService } from "../services/heartbeat.js";
import * as nativeExecutor from "../services/native-runtime/native-session-executor.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";
import { notifyNativeFinalizationWork } from "../services/native-finalization-notifications.js";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { PROCESS_IDENTITY_RECORDED, releaseSettledNativeRunProcess } from "../services/native-local-process-stop.js";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, completionContracts, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations,
  nativeRunResults, statusDecisions, workAssessments, type Db } from "@paperclipai/db";
import { settleAbsentSandbox, settleStopOnlyCleanup } from "../services/sandbox-stop-and-retain.js";
import { settleNativeWorkspaceExportResume } from "../services/native-runtime/native-workspace-export-resume.js";
import type { SandboxAbsenceProof } from "../services/sandbox-absence-proof.js";
import { environmentService } from "../services/environments.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { notifyRetainedNativeSessionCleanup, releaseRetainedNativeSessionCleanup } from "../services/retained-native-session-cleanup-notifications.js";
import { retainedNativeSessionCleanupWork } from "../services/native-runtime/retained-native-session-cleanup-work.js";
import { reconcileRetainedNativeSessionCleanups, runRetainedNativeSessionCleanup, type NativeCleanupOutcome } from "../services/native-runtime/retained-native-session-cleanup.js";
import { reconcileRetainedNativeSessionCleanup } from "../services/native-runtime/native-session-executor.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("retained native cleanup scheduled lifecycle", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let worker: ReturnType<ReturnType<typeof retainedNativeSessionCleanupWork>["register"]> | undefined;
  const companyId = randomUUID(), agentId = randomUUID();
  const closeError = "provider_transport_failed: runner did not durably suspend before checkpoint";
  let admitted = true;
  const errors: unknown[] = [];
  async function settle(input: { runId: string; companyId: string }): Promise<NativeCleanupOutcome> {
    await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null,
      recoveryHistory: [{ kind: "native_cleanup_maintenance", phase: "settled" }] })
      .where(eq(nativeRunFinalizations.runId, input.runId));
    return { runId: input.runId, status: "settled" };
  }
  const cleanup = vi.fn(settle);
  beforeAll(async () => {
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_RETAINED_CLEANUP_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("paperclip-retained-cleanup-");
    db = createDb(external ?? temporary!.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Retained cleanup lifecycle", issuePrefix: `RC${randomUUID().slice(0, 8)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Cleanup agent", adapterType: "codex_local" });
  }, 30_000);
  beforeEach(() => {
    admitted = true; errors.length = 0; cleanup.mockReset().mockImplementation(settle);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    worker?.stop(); await coordinator?.stop(); worker = undefined; coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.companyId, companyId));
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted, canReconcile: () => true,
      onError: error => errors.push(error) });
    worker = retainedNativeSessionCleanupWork(db, cleanup).register(coordinator, () => admitted);
    await worker.ready;
  }
  async function flush() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0);
      expect(coordinator!.nextWakeAt()).toBeNull();
    }, { timeout: 15_000 });
  }
  async function quiet(ms = 120_000) {
    const previous = db.$client.options.debug;
    const queries: string[] = [];
    db.$client.options.debug = (_id, query) => { queries.push(query); };
    try { await vi.advanceTimersByTimeAsync(ms); await delay(10); expect(queries).toEqual([]); }
    finally { db.$client.options.debug = previous; }
  }
  async function commitCandidate() {
    const runId = randomUUID();
    return db.transaction(async tx => {
      await notifyNativeFinalizationWork(tx, { companyId, runId });
      return candidate({ runId }, tx as unknown as Db);
    });
  }
  async function candidate(
    options: {
      runId?: string;
      owner?: { companyId: string; agentId: string };
      run?: Partial<typeof heartbeatRuns.$inferInsert>;
      coordinator?: Partial<typeof nativeRunFinalizations.$inferInsert>;
      schemaStatus?: string;
      issueId?: string;
      revision?: number;
    } = {},
    writer: Db = db,
  ) {
    const owner = options.owner ?? { companyId, agentId };
    const runId = options.runId ?? randomUUID();
    const issueId = options.issueId ?? randomUUID();
    const contractId = randomUUID();
    if (!options.issueId) await writer
      .insert(issues)
      .values({
        id: issueId,
        companyId: owner.companyId,
        title: "Retained session",
        assigneeAgentId: owner.agentId,
      });
    await writer.insert(completionContracts).values({
      id: contractId,
      companyId: owner.companyId,
      issueId,
      revision: options.revision ?? 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v3",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {},
      canonicalSha256: runId,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await writer.insert(heartbeatRuns).values({
      id: runId,
      companyId: owner.companyId,
      agentId: owner.agentId,
      runtimeMode: "native",
      status: "succeeded",
      nativeIssueId: issueId,
      nativeSessionId: runId,
      nativePhase: "terminal_failure",
      completionContractId: contractId,
      completionContractSha256: runId,
      finishedAt: new Date(),
      errorCode: "adapter_failed",
      error: closeError,
      ...options.run,
    });
    const [result] = await writer
      .insert(nativeRunResults)
      .values({
        companyId: owner.companyId,
        issueId,
        runId,
        completionContractId: contractId,
        serverFingerprint: runId,
        canonicalSha256: runId,
        schemaStatus: options.schemaStatus ?? "accepted",
        resultJson: {},
      })
      .returning();
    const [assessment] = await writer
      .insert(workAssessments)
      .values({
        companyId: owner.companyId,
        issueId,
        runId,
        contractId,
        resultId: result!.id,
        triggerKind: "native_result",
        triggerActorCompanyId: owner.companyId,
        priorIssueStatus: "in_progress",
        priorStatusVersion: 0,
        policyVersion: "phase6-v3",
        assessmentJson: {},
        inputDigest: runId,
      })
      .returning();
    const [decision] = await writer
      .insert(statusDecisions)
      .values({
        companyId: owner.companyId,
        issueId,
        runId,
        assessmentId: assessment!.id,
        decisionVersion: options.revision ?? 1,
        policyVersion: "phase6-v3",
        fromStatus: "in_progress",
        toStatus: "in_review",
        reasonCode: "prior_status_terminal_preserved",
        decisionJson: {},
        decisionDigest: runId,
      })
      .returning();
    await writer.insert(nativeRunFinalizations).values({
      companyId: owner.companyId,
      issueId,
      runId,
      phase: "committed",
      resultId: result!.id,
      assessmentId: assessment!.id,
      decisionId: decision!.id,
      ...options.coordinator,
    });
    return runId;
  }


  it("becomes SQL-quiet with no work, then processes the first committed candidate", async () => {
    await start(); await flush(); await quiet();
    const runId = await commitCandidate();
    await flush();
    expect(cleanup).toHaveBeenCalledExactlyOnceWith({ companyId, runId });
    await quiet();
  });

  it("leaves retained unprovable history quiet through the real physical cleanup boundary", async () => {
    await candidate();
    cleanup.mockImplementation(input => reconcileRetainedNativeSessionCleanup(db, input));
    await start(); await flush();
    expect(cleanup).toHaveBeenCalledTimes(1);
    await quiet();
  });

  it("keeps dormant retained cleanup quiet on unscoped finalization hints and resumes from local release", async () => {
    const runId = await candidate();
    cleanup.mockResolvedValue({ runId, status: "deferred", waitFor: "session_release" });
    await start();
    await flush();
    await quiet();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(await retainedNativeSessionCleanupWork(db, cleanup).load({ companyId, runId })).toHaveLength(1);
    const debug = db.$client.options.debug;
    const queries: string[] = [];
    db.$client.options.debug = (_connection, query) => {
      if (query.startsWith("select") && query.includes("native_run_finalizations")) queries.push(query);
    };
    try {
      for (let i = 0; i < 3; i++) {
        await db.transaction(tx => notifyNativeFinalizationWork(tx, { companyId }));
        await flush();
      }
      expect(queries).toEqual([]);
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally { db.$client.options.debug = debug; }
    cleanup.mockImplementation(settle);
    releaseRetainedNativeSessionCleanup(db, { companyId, runId });
    await flush();
    expect(cleanup).toHaveBeenCalledTimes(2);
    await quiet();
  });

  it.each(["session_release", "environment_release", "maintenance_settlement"] as const)(
    "waits quietly for %s and then reactivates only the affected run", async waitFor => {
      const runId = await candidate();
      cleanup.mockResolvedValueOnce({ runId, status: "deferred", waitFor });
      await start(); await flush(); await quiet();
      releaseRetainedNativeSessionCleanup(db, { companyId, runId });
      await flush();
      expect(cleanup).toHaveBeenCalledTimes(2);
      await quiet();
    },
  );

  it.each(["single", "run"] as const)("reactivates after the real %s lease release commits, but not rollback", async method => {
    const runId = await candidate();
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId,
      status: "active", provider: "local" }).returning();
    cleanup.mockImplementation(async input => {
      const [current] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease!.id));
      return current!.status === "active"
        ? { runId: input.runId, status: "deferred", waitFor: "environment_release" }
        : settle(input);
    });
    const release = async (writer: Db) => {
      const service = environmentService(writer);
      if (method === "single") await service.releaseLease(lease!.id);
      else await service.releaseLeasesForRun(runId);
    };
    await start(); await flush(); await quiet();
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(db.transaction(async tx => {
      await release(tx as unknown as Db);
      await vi.advanceTimersByTimeAsync(1000);
      expect(cleanup).toHaveBeenCalledTimes(1);
      throw new Error("rollback lease release");
    })).rejects.toThrow("rollback lease release");
    await flush(); await quiet();
    const afterRollback = cleanup.mock.calls.length;
    await db.transaction(async tx => {
      await release(tx as unknown as Db);
      await vi.advanceTimersByTimeAsync(1000);
      expect(cleanup).toHaveBeenCalledTimes(afterRollback);
    });
    await flush();
    expect(cleanup).toHaveBeenCalledTimes(afterRollback + 1);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0]!.recoveryHistory)
      .toEqual([{ kind: "native_cleanup_maintenance", phase: "settled" }]);
    await quiet();
  });

  it("keeps pending cleanup quiet through metadata updates and stale release attempts", async () => {
    const runId = await candidate(), attemptId = randomUUID();
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId,
      status: "pending_cleanup", provider: "local", metadata: { pendingCleanupAttemptId: attemptId } }).returning();
    cleanup.mockResolvedValueOnce({ runId, status: "deferred", waitFor: "environment_release" });
    await start(); await flush();
    const service = environmentService(db);
    await service.updateLeaseMetadata(lease!.id, { pendingCleanupAttemptId: attemptId, pendingCleanupInFlight: true });
    await service.releaseLease(lease!.id, "pending_cleanup", { expectedPendingCleanupAttemptId: attemptId, cleanupStatus: "failed" });
    expect(await service.releaseLease(lease!.id, "released", { expectedPendingCleanupAttemptId: randomUUID(), cleanupStatus: "success" })).toBeNull();
    await flush(); await quiet();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(await service.releaseLease(lease!.id, "released", { expectedPendingCleanupAttemptId: attemptId, cleanupStatus: "success" })).not.toBeNull();
    await flush();
    expect(cleanup).toHaveBeenCalledTimes(2);
    await quiet();
  });

  it.each(["stop-only", "export-resume", "absent"] as const)("reactivates after real %s settlement with outer transaction ownership", async method => {
    const ownerToken = randomUUID();
    const runId = await candidate({ run: { runnerProfileJson: { nativeWorkspaceFinalizationOwner: { token: ownerToken } } } });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const leaseId = randomUUID(), providerLeaseId = randomUUID(), attemptId = randomUUID(), pluginId = randomUUID();
    const binding = { companyId, runId, leaseId, provider: "daytona" as const, providerLeaseId };
    const marker = { ...binding, requestId: attemptId, pluginId,
      schema: method === "export-resume" ? "paperclip.workspace-export-resume.v2" : "paperclip.sandbox-stop-and-retain.v1",
      resultId: randomUUID() };
    const [lease] = await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: runId,
      issueId: run!.nativeIssueId, provider: "daytona", providerLeaseId, status: "pending_cleanup", cleanupStatus: "failed",
      metadata: { pluginId, pendingCleanupAttemptId: attemptId,
        [method === "export-resume" ? "nativeWorkspaceExportResume" : "sandboxStopAndRetain"]: marker } }).returning();
    const proof: SandboxAbsenceProof = { ...binding, issueId: run!.nativeIssueId!, ownerToken, v: 1,
      iss: "paperclip-cloud", aud: "paperclip-sandbox-absence/v1", sub: "fixture", absent: true,
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 };
    cleanup.mockImplementation(async input => {
      const [current] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
      return current!.status === "pending_cleanup"
        ? { runId: input.runId, status: "deferred", waitFor: "environment_release" }
        : settle(input);
    });
    const release = async (writer: Db) => {
      const options = { attemptId, receipt: { providerLeaseId, state: "stopped" } };
      if (method === "absent") expect(await settleAbsentSandbox(writer, lease!, { proof, receipt: "verified-upstream" })).toBe(true);
      else if (method === "export-resume") expect(await settleNativeWorkspaceExportResume(writer, lease!, options)).not.toBeNull();
      else expect(await settleStopOnlyCleanup(writer, lease!, options)).not.toBeNull();
    };
    await start(); await flush(); await quiet();
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(db.transaction(async tx => {
      await release(tx as unknown as Db);
      await vi.advanceTimersByTimeAsync(1000);
      expect(cleanup).toHaveBeenCalledTimes(1);
      throw new Error("rollback settlement");
    })).rejects.toThrow("rollback settlement");
    await flush(); await quiet();
    const afterRollback = cleanup.mock.calls.length;
    await db.transaction(async tx => {
      await release(tx as unknown as Db);
      await vi.advanceTimersByTimeAsync(1000);
      expect(cleanup).toHaveBeenCalledTimes(afterRollback);
    });
    await flush();
    expect(cleanup).toHaveBeenCalledTimes(afterRollback + 1);
    await quiet();
  });

  it("reactivates immediately after verified process release commits without waiting for its probe", async () => {
    const pid = 2_000_000_000, startedAt = new Date();
    const runId = await candidate({ run: { status: "failed", processPid: pid, processGroupId: pid,
      processStartedAt: startedAt, runnerProfileJson: { sessionCheckpoint: {} } } });
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 0,
      eventType: PROCESS_IDENTITY_RECORDED, payload: { targetKind: "local", hostname: os.hostname(),
        processPid: pid, processGroupId: pid, processStartedAt: startedAt.toISOString() } });
    await db.update(heartbeatRuns).set({ nextEventSeq: 1 }).where(eq(heartbeatRuns.id, runId));
    const originalKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((id, signal) => {
      if ((id === pid || id === -pid) && signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return originalKill(id, signal);
    });
    cleanup.mockImplementation(async input => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
      return run!.processPid !== null
        ? { runId: input.runId, status: "deferred", waitFor: "process_exit" }
        : settle(input);
    });
    await start();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(coordinator!.nextWakeAt()).not.toBeNull();
    await expect(db.transaction(async tx => {
      expect(await releaseSettledNativeRunProcess(tx as unknown as Db, runId)).toBe("released");
      await vi.advanceTimersByTimeAsync(1000);
      expect(cleanup).toHaveBeenCalledTimes(1);
      throw new Error("rollback process release");
    })).rejects.toThrow("rollback process release");
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(idleWorkSnapshot().active).toBe(0);
    });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!.processPid).toBe(pid);
    const afterRollback = cleanup.mock.calls.length;
    await db.transaction(async tx => {
      expect(await releaseSettledNativeRunProcess(tx as unknown as Db, runId)).toBe("released");
      await vi.advanceTimersByTimeAsync(1000);
      expect(cleanup).toHaveBeenCalledTimes(afterRollback);
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(afterRollback + 1));
    await flush(); await quiet();
  });

  it("reactivates when the real finalizer projects an already committed result to a terminal run", async () => {
    const runId = await candidate({ run: { status: "running", finishedAt: null } });
    await db.update(nativeRunResults).set({ resultJson: { terminal: { runTerminalState: "succeeded" } } })
      .where(eq(nativeRunResults.runId, runId));
    await start(); await flush(); await quiet();
    expect(cleanup).not.toHaveBeenCalled();
    const finalize = (writer: Db) => finalizeNativeRun({ db: writer, runId, workspaceFinalizeStatus: "succeeded",
      projectRunStatus: true, skipNativeResponsePresentation: true, skipNativeReviewResponse: true });
    await expect(db.transaction(async tx => {
      await finalize(tx as unknown as Db);
      await vi.advanceTimersByTimeAsync(1000);
      expect(cleanup).not.toHaveBeenCalled();
      throw new Error("rollback final projection");
    })).rejects.toThrow("rollback final projection");
    await flush(); await quiet();
    expect(cleanup).not.toHaveBeenCalled();
    await finalize(db); await flush();
    expect(cleanup).toHaveBeenCalledExactlyOnceWith({ companyId, runId });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run!.status).toBe("succeeded");
    expect(run!.error).toBeNull();
    expect(run!.resultJson?.recoveredExecutionFailure).toMatchObject({ errorCode: "adapter_failed", error: closeError });
    await quiet();
  });

  it("reconstructs a lease deadline across restart and does no SQL before it", async () => {
    const leaseExpiresAt = new Date(Date.now() + 60_000);
    const runId = await candidate({ coordinator: { leaseOwner: "other-owner", leaseExpiresAt } });
    await start();
    expect(cleanup).not.toHaveBeenCalled();
    expect(coordinator!.nextWakeAt()).toBe(leaseExpiresAt.getTime());
    await quiet(10_000);
    worker!.stop(); await coordinator!.stop();
    await start();
    expect(coordinator!.nextWakeAt()).toBe(leaseExpiresAt.getTime());
    await quiet(10_000);
    await vi.advanceTimersByTimeAsync(40_000); await flush();
    expect(cleanup).toHaveBeenCalledExactlyOnceWith({ companyId, runId });
    await quiet();
  });

  it("retains only the concrete process-exit probe and disarms it after settlement", async () => {
    const runId = await candidate();
    cleanup.mockResolvedValueOnce({ runId, status: "deferred", waitFor: "process_exit" });
    await start();
    expect(cleanup).toHaveBeenCalledTimes(1);
    await quiet(20_000);
    await vi.advanceTimersByTimeAsync(10_000); await flush();
    expect(cleanup).toHaveBeenCalledTimes(2);
    await quiet();
  });

  it("does not run before outer commit and clears rolled-back intent", async () => {
    await start(); await flush();
    const entered = deferred(), release = deferred();
    const transaction = db.transaction(async outer => {
      await outer.transaction(async tx => {
        await notifyRetainedNativeSessionCleanup(tx, { companyId });
        await candidate({}, tx as unknown as Db);
      });
      entered.resolve(); await release.promise;
      throw new Error("rollback fixture");
    });
    const rolledBack = expect(transaction).rejects.toThrow("rollback fixture");
    await entered.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cleanup).not.toHaveBeenCalled();
    release.resolve(); await rolledBack; await flush(); await quiet();
    const runId = await commitCandidate(); await flush();
    expect(cleanup).toHaveBeenCalledExactlyOnceWith({ companyId, runId });
    await quiet();
  });

  it("retains the first write during drain without passive SQL until resume", async () => {
    await start(); await flush(); admitted = false;
    const runId = await commitCandidate();
    await vi.advanceTimersByTimeAsync(1000); await delay(10);
    expect(cleanup).not.toHaveBeenCalled();
    await quiet();
    admitted = true; await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect(cleanup).toHaveBeenCalledExactlyOnceWith({ companyId, runId });
    await quiet();
  });

  it("retains an operational failure across drain and retries after resume", async () => {
    await candidate(); cleanup.mockRejectedValueOnce(new Error("connection lost"));
    await start(); expect(errors).toHaveLength(1); errors.length = 0;
    admitted = false; await quiet();
    expect(cleanup).toHaveBeenCalledTimes(1);
    admitted = true; await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect(cleanup).toHaveBeenCalledTimes(2);
    await quiet();
  });

  it("keeps a committed wake arriving during cleanup and never overlaps worker dispatch", async () => {
    await candidate();
    const entered = deferred(), release = deferred();
    let active = 0, maximum = 0;
    cleanup.mockImplementation(async input => {
      maximum = Math.max(maximum, ++active);
      try { entered.resolve(); await release.promise; return await settle(input); }
      finally { active--; }
    });
    const starting = start(); await entered.promise;
    await commitCandidate(); release.resolve(); await starting; await flush();
    expect(cleanup).toHaveBeenCalledTimes(2); expect(maximum).toBe(1);
    await quiet();
  });

  it("joins the original manual startup operation instead of performing cleanup twice", async () => {
    await candidate();
    const entered = deferred(), release = deferred();
    cleanup.mockImplementation(async input => { entered.resolve(); await release.promise; return settle(input); });
    const manual = reconcileRetainedNativeSessionCleanups(db, { cleanup });
    await entered.promise;
    const work = retainedNativeSessionCleanupWork(db, cleanup);
    const [entry] = await work.load();
    const joined = work.check(entry);
    try { expect(cleanup).toHaveBeenCalledTimes(1); }
    finally { release.resolve(); }
    await expect(joined).resolves.toBeNull(); await manual;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("serializes different cleanup inspections sharing a database lane", async () => {
    const first = await candidate(), second = await candidate();
    const entered = deferred(), release = deferred();
    cleanup.mockImplementationOnce(async input => { entered.resolve(); await release.promise; return settle(input); });
    const active = runRetainedNativeSessionCleanup(db, { companyId, runId: first }, cleanup);
    await entered.promise;
    const queued = runRetainedNativeSessionCleanup(db, { companyId, runId: second }, cleanup);
    try { await delay(10); expect(cleanup).toHaveBeenCalledTimes(1); }
    finally { release.resolve(); }
    await Promise.all([active, queued]);
    expect(cleanup.mock.calls.map(([input]) => input.runId)).toEqual([first, second]);
  });

  it("joins scheduled physical cleanup through the assembled heartbeat shutdown owner", async () => {
    const runId = await candidate();
    const entered = deferred(), release = deferred();
    const physical = vi.spyOn(nativeExecutor, "reconcileRetainedNativeSessionCleanup").mockImplementation(async (_db, input) => {
      entered.resolve(); await release.promise; return settle(input);
    });
    const heartbeat = heartbeatService(db);
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    worker = heartbeat.registerRetainedNativeSessionCleanupWork(coordinator, () => true);
    await entered.promise;
    let drained = false;
    const draining = heartbeat.drainActiveRunExecutions().then(() => { drained = true; });
    try {
      await delay(10);
      expect(drained).toBe(false);
      expect(physical).toHaveBeenCalledExactlyOnceWith(db, { companyId, runId });
    } finally { release.resolve(); }
    await worker.ready; await draining; await flush();
    expect(drained).toBe(true); await quiet();
  });

  it("waits on the original in-flight cleanup when shutdown begins", async () => {
    await candidate();
    const entered = deferred(), release = deferred();
    cleanup.mockImplementation(async input => { entered.resolve(); await release.promise; return settle(input); });
    const starting = start(); await entered.promise;
    let stopped = false;
    worker!.stop(); const stopping = coordinator!.stop().then(() => { stopped = true; });
    try { await delay(10); expect(stopped).toBe(false); }
    finally { release.resolve(); }
    await Promise.all([starting, stopping]);
    expect(stopped).toBe(true); expect(cleanup).toHaveBeenCalledTimes(1);
    releaseRetainedNativeSessionCleanup(db, { companyId });
    await quiet();
  });

  it("replaces an old lease alarm when a committed change releases it early", async () => {
    const runId = await candidate({ coordinator: { leaseOwner: "old-owner", leaseExpiresAt: new Date(Date.now() + 60_000) } });
    await start(); expect(cleanup).not.toHaveBeenCalled();
    await db.transaction(async tx => {
      await notifyNativeFinalizationWork(tx, { companyId, runId });
      await tx.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, runId));
    });
    await flush(); expect(cleanup).toHaveBeenCalledExactlyOnceWith({ companyId, runId });
    await quiet();
  });

  it("cancels a saved alarm when a committed owner marks the candidate operator-required", async () => {
    const runId = await candidate({ coordinator: { leaseOwner: "old-owner", leaseExpiresAt: new Date(Date.now() + 60_000) } });
    await start();
    await db.transaction(async tx => {
      await notifyNativeFinalizationWork(tx, { companyId, runId });
      await tx.update(nativeRunFinalizations).set({ recoveryHistory: [{ kind: "native_cleanup_source_archive", phase: "operator_required" }] })
        .where(eq(nativeRunFinalizations.runId, runId));
    });
    await flush(); expect(cleanup).not.toHaveBeenCalled(); await quiet();
  });

  it("retains startup discovery during drain and reconstructs only after admission resumes", async () => {
    const runId = await candidate(); admitted = false;
    await start(); await quiet(); expect(cleanup).not.toHaveBeenCalled();
    admitted = true; await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect(cleanup).toHaveBeenCalledExactlyOnceWith({ companyId, runId }); await quiet();
  });

  it("drains a backlog across discovery pages and becomes quiet with the completed history retained", async () => {
    const runIds: string[] = [];
    for (let index = 0; index < 103; index++) runIds.push(await candidate());
    await start(); await flush();
    expect(cleanup.mock.calls.map(([input]) => input.runId).sort()).toEqual(runIds.sort());
    expect(await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.companyId, companyId))).toHaveLength(103);
    await quiet();
  });

  it("retries failed startup discovery without treating an unavailable database as empty", async () => {
    const runId = await candidate();
    vi.spyOn(db, "select").mockImplementationOnce(() => { throw new Error("discovery connection lost"); });
    await start(); expect(errors).toHaveLength(1); errors.length = 0;
    expect(cleanup).not.toHaveBeenCalled();
    await quiet(20_000); await vi.advanceTimersByTimeAsync(10_000); await flush();
    expect(cleanup).toHaveBeenCalledExactlyOnceWith({ companyId, runId }); await quiet();
  });
});
