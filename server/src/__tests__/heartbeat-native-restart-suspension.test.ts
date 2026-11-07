import { nativeControllerAuthorityDigest } from "../services/native-runtime/native-runner-ownership.js";
import { cancelHeartbeatNativeRun } from "../services/heartbeat/run-control.js";
import { claimCancellationRequest } from "../services/native-runtime/native-cancellation-request.js";
import express from "express";
import request from "supertest";
import * as heartbeatModule from "../services/heartbeat.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { waitForCondition } from "./helpers/native-restart-fixture.js";
import { requestTaskRetry } from "../services/task-retry.js";
import type { HeartbeatServiceOptions } from "../services/heartbeat.js";
import type { NativeRunIdentity, NativeSession, PrpEvent } from "@paperclipai/paperclip-runner";
import { randomUUID } from "node:crypto";
import * as controllerProcess from "../services/controller-process-identity.js";
import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, authUsers, budgetReservations, companyMemberships, completionContracts, environmentLeases, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, workspaceOperations } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { resolveLocalRuntimeApiUrl } from "../runtime-api.js";
import { releaseDeadControllerResultLeases } from "../services/native-runtime/native-dead-controller-result-lease.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { claimNativeRestartRecoveries, classifyNativeRunnerRecoveryEvidence, currentNativeControllerIdentity } from "../services/native-runtime/native-restart-recovery.js";
import type { NativeSessionBackend } from "@paperclipai/paperclip-runner";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { CONTROL_PLANE_CONFORMANCE_OPEN, CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "./helpers/native-restart.js";


describeEmbeddedPostgres("heartbeat native recovery interrupted by graceful shutdown", () => {
  const fixture = nativeRestartFixture();

  async function seedRecoverableRun(label: string) {
    const f = await fixture.seedRun(label);
    await instanceSettingsService(f.db).updateExperimental({ enableNativeRunner: true });
    const userId = randomUUID();
    await f.db.insert(authUsers).values({ id: userId, name: "Operator", email: `${userId}@example.invalid`,
      createdAt: new Date(), updatedAt: new Date() });
    await f.db.insert(companyMemberships).values({ companyId: fixture.current.companyId, principalType: "user",
      principalId: userId, membershipRole: "owner" });
    await f.db.update(heartbeatRuns).set({ responsibleUserId: userId, completionContractId: null,
      completionContractSha256: null }).where(eq(heartbeatRuns.id, f.runId));
    return f;
  }

  it.each(["before_budget_reservation", "before_dispatch_gate"] as const)(
    "leaves a recovery execution suspended %s for the next controller",
    async (point) => {
      const f = await seedRecoverableRun(`SUSPENDED-${point}`);
      if (point === "before_dispatch_gate") await f.db.update(heartbeatRuns)
        .set({ scheduledRetryReason: "native_provider_overloaded" }).where(eq(heartbeatRuns.id, f.runId));
      const dying = vi.fn(() => { throw new Error("A suspended recovery must not open a provider session"); });
      let drained: unknown;
      const drain = async () => {
        if (drained) return;
        drained = await heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date(), [f.runId]);
      };
      const heartbeat = heartbeatService(f.db, {
        nativeSessionBackendFactory: dying,
        ...(point === "before_budget_reservation"
          ? { beforeNativeRuntimeSelection: drain }
          : { afterResolvedInteractionContinuationDispatchCheck: drain }),
      });
      try {
        const { claims } = await heartbeat.recoverNativeRunsAfterRestart(new Date(), [f.runId]);
        expect(claims).toEqual([expect.objectContaining({ runId: f.runId })]);
      } finally { await heartbeat.drainActiveRunExecutions(); }
      expect(drained).toMatchObject({ restartSuspendedRunIds: [f.runId] });
      expect(dying).not.toHaveBeenCalled();

      const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      const [task] = await f.db.select().from(issues).where(eq(issues.id, f.issueId));
      expect({ status: run.status, errorCode: run.errorCode, finishedAt: run.finishedAt }).toEqual({
        status: "running", errorCode: null, finishedAt: null });
      expect(owner).toMatchObject({ phase: "observed", resultId: null, recoveryState: "awaiting_runner_reattach" });
      expect(task.executionRunId).toBe(f.runId);
      expect(await f.db.select().from(workspaceOperations).where(and(
        eq(workspaceOperations.heartbeatRunId, f.runId), eq(workspaceOperations.status, "failed")))).toEqual([]);
      expect(await f.db.select().from(budgetReservations).where(and(eq(budgetReservations.runId, f.runId),
        eq(budgetReservations.state, "released")))).toEqual([]);
      await f.db.update(nativeRunFinalizations).set({ controllerPid: 2_000_000_001 })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      const resumed = vi.fn(() => { throw new Error("next boot reached provider dispatch"); });
      const next = heartbeatService(f.db, { nativeSessionBackendFactory: resumed });
      try {
        const { claims } = await next.recoverNativeRunsAfterRestart(new Date(), [f.runId]);
        expect(claims).toEqual([expect.objectContaining({ runId: f.runId })]);
      } finally { await next.drainActiveRunExecutions(); }
      expect(resumed).toHaveBeenCalledOnce();
      expect(await f.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.nativeIssueId, f.issueId))).toHaveLength(1);
    },
    90_000,
  );

  it.each([
    // Attempt 0: no execution claimed the run yet, so its first start is counted.
    { drainedAttempt: 0, charges: true, ownershipWait: false },
    { drainedAttempt: 1, charges: false, ownershipWait: false },
    // The third attempt may continue after a drain; it does not start a fourth.
    { drainedAttempt: 3, charges: false, ownershipWait: false },
    // Scans that wait for the old controller to exit keep the drain record.
    { drainedAttempt: 3, charges: false, ownershipWait: true },
  ])("charges a resume after a clean drain only for the first execution (attempt $drainedAttempt, ownership wait $ownershipWait)", async ({ drainedAttempt, charges, ownershipWait }) => {
    // RC-22: each graceful restart cost one of the three recovery attempts, so
    // infrastructure restarts the run did not cause exhausted its budget.
    const f = await seedRecoverableRun(`DRAIN-BUDGET-${drainedAttempt}${ownershipWait ? "-WAIT" : ""}`);
    let drained: unknown;
    const heartbeat = heartbeatService(f.db, {
      nativeSessionBackendFactory: vi.fn(() => { throw new Error("A suspended recovery must not open a provider session"); }),
      beforeNativeRuntimeSelection: async () => {
        if (!drained) drained = await heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date(), [f.runId]);
      },
    });
    try {
      // A crash leaves no drain record, so its resume still charges an attempt.
      const { claims } = await heartbeat.recoverNativeRunsAfterRestart(new Date(), [f.runId]);
      expect(claims).toEqual([expect.objectContaining({ runId: f.runId, chargesProviderAttempt: true })]);
    } finally { await heartbeat.drainActiveRunExecutions(); }
    expect(drained).toMatchObject({ restartSuspendedRunIds: [f.runId] });

    await f.db.update(nativeRunFinalizations).set({ attempt: drainedAttempt })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    if (ownershipWait) {
      // The drained controller (this test process) is still alive, so the new
      // server's scans wait for ownership evidence instead of claiming.
      const waiting = heartbeatService(f.db, { nativeSessionBackendFactory: vi.fn(() => { throw new Error("no claim while the owner lives"); }) });
      for (let scan = 0; scan < 2; scan += 1) {
        try { expect((await waiting.recoverNativeRunsAfterRestart(new Date(), [f.runId])).claims).toEqual([]); }
        finally { await waiting.drainActiveRunExecutions(); }
      }
      const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(owner.recoveryState).toBe("awaiting_evidence");
      expect((owner.recoveryHistory as Array<{ disposition?: string }>).slice(-2).map(entry => entry.disposition))
        .toEqual(["restart_suspended", "awaiting_evidence"]);
    }
    await f.db.update(nativeRunFinalizations).set({ controllerPid: 2_000_000_001 })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    // Let the executor take its execution lease, then record the attempt it
    // saved when it reaches the provider session.
    const savedAttempts: number[] = [];
    const reachedProvider = async () => {
      const [owner] = await f.db.select({ attempt: nativeRunFinalizations.attempt,
        controllerHostHash: nativeRunFinalizations.controllerHostHash }).from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, f.runId));
      const actualProcess = await controllerProcess.currentControllerProcess();
      expect(actualProcess.hostHash).not.toBe("unknown");
      expect(owner.controllerHostHash).toBe(actualProcess.hostHash);
      savedAttempts.push(owner.attempt);
      throw new Error("stop at provider dispatch");
    };
    const backend = vi.fn((): NativeSessionBackend => ({
      async descriptor() {
        return { kind: "mock", name: "drained-budget", version: "1", capabilities: {
          resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } };
      },
      openSession: reachedProvider,
      recoverSession: reachedProvider,
    }));
    const next = heartbeatService(f.db, { nativeSessionBackendFactory: backend });
    try {
      const { claims } = await next.recoverNativeRunsAfterRestart(new Date(), [f.runId]);
      expect(claims).toEqual([expect.objectContaining({ runId: f.runId, chargesProviderAttempt: charges })]);
    } finally { await next.drainActiveRunExecutions(); }
    expect(backend).toHaveBeenCalledOnce();
    expect(savedAttempts).toEqual([charges ? drainedAttempt + 1 : drainedAttempt]);
  }, 90_000);

  it.each([false, true])("still refuses a fourth attempt after a crash (remote bootstrap %s)", (remote) => {
    const evidence = remote
      ? { remoteSandbox: true, remoteBootstrapProvenIncomplete: true, runnerPidAlive: false, runnerGroupAlive: false,
        processStartMatches: false, hasCheckpoint: false, hasProviderEvidence: false, providerAttempt: 3 }
      : { runnerPidAlive: false, runnerGroupAlive: false, processStartMatches: false,
        hasCheckpoint: true, checkpointIdentityMatches: true, hasProviderEvidence: true, providerAttempt: 3 };
    expect(classifyNativeRunnerRecoveryEvidence(evidence).reason).toBe("execution_recovery_budget_exhausted");
    expect(classifyNativeRunnerRecoveryEvidence({ ...evidence, resumeChargesAttempt: false }).reason)
      .not.toBe("execution_recovery_budget_exhausted");
  });

  it("hands a recovery to the next controller when shutdown closed the listener before backend setup", async () => {
    const f = await seedRecoverableRun("LISTENER-CLOSED");
    const listener = fixture.current.server!;
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP runtime API listener");
    let listenerClosed: Promise<void> | undefined;
    // Graceful shutdown closes HTTP admission before it drains heartbeat runs.
    // Backend setup then asks for the callback origin, as runnerd setup does.
    const dying = vi.fn(() => ({
      descriptor: async () => { resolveLocalRuntimeApiUrl(); throw new Error("unreachable"); },
      openSession: async () => { resolveLocalRuntimeApiUrl(); throw new Error("unreachable"); },
    }));
    const heartbeat = heartbeatService(f.db, {
      nativeSessionBackendFactory: dying as never,
      beforeNativeRuntimeSelection: async () => {
        listener.closeIdleConnections();
        listenerClosed = new Promise<void>(resolve => listener.close(() => resolve()));
      },
    });
    let drained: unknown;
    try {
      try {
        const { claims } = await heartbeat.recoverNativeRunsAfterRestart(new Date(), [f.runId]);
        expect(claims).toEqual([expect.objectContaining({ runId: f.runId })]);
      } finally { await heartbeat.drainActiveRunExecutions(); }
      expect(dying).toHaveBeenCalled();
      drained = await heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date(), [f.runId]);
      await heartbeat.drainActiveRunExecutions();
    } finally {
      await listenerClosed;
      await new Promise<void>(resolve => listener.listen(address.port, "127.0.0.1", resolve));
    }
    expect(drained).toMatchObject({ restartSuspendedRunIds: [f.runId] });
    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect({ status: run.status, errorCode: run.errorCode, finishedAt: run.finishedAt }).toEqual({
      status: "running", errorCode: null, finishedAt: null });
    expect(owner).toMatchObject({ phase: "observed", resultId: null, recoveryState: "awaiting_runner_reattach" });

    await f.db.update(nativeRunFinalizations).set({ controllerPid: 2_000_000_001 })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    const resumed = vi.fn(() => { throw new Error("next boot reached provider dispatch"); });
    const next = heartbeatService(f.db, { nativeSessionBackendFactory: resumed });
    try {
      const { claims } = await next.recoverNativeRunsAfterRestart(new Date(), [f.runId]);
      expect(claims).toEqual([expect.objectContaining({ runId: f.runId })]);
    } finally { await next.drainActiveRunExecutions(); }
    expect(resumed).toHaveBeenCalledOnce();
  }, 90_000);

  it("still settles a recovery whose claim merely expired without a shutdown suspension", async () => {
    const f = await seedRecoverableRun("EXPIRED-NOT-SUSPENDED");
    const dying = vi.fn(() => { throw new Error("An expired claim must not open a provider session"); });
    const heartbeat = heartbeatService(f.db, {
      nativeSessionBackendFactory: dying,
      beforeNativeRuntimeSelection: async () => {
        await f.db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) })
          .where(eq(nativeRunFinalizations.runId, f.runId));
      },
    });
    try {
      const { claims } = await heartbeat.recoverNativeRunsAfterRestart(new Date(), [f.runId]);
      expect(claims).toEqual([expect.objectContaining({ runId: f.runId })]);
    } finally { await heartbeat.drainActiveRunExecutions(); }
    expect(dying).not.toHaveBeenCalled();
    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.status).toBe("failed");
  }, 60_000);


  async function shutdownDispositions(db: Awaited<ReturnType<typeof seedRecoverableRun>>["db"], runId: string) {
    const events = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, runId),
      eq(heartbeatRunEvents.eventType, "native.recovery.transition")));
    return events.map((event) => (event.payload as Record<string, unknown> | null)?.runnerDisposition);
  }

  /** A run whose provider turn ended and whose result this boot's controller accepted. */
  async function seedAcceptedResult(label: string, leaseOwner: (runnerInstanceId: string) => string) {
    const f = await seedRecoverableRun(label);
    const [contract] = await f.db.select().from(completionContracts).where(eq(completionContracts.issueId, f.issueId));
    await f.db.update(heartbeatRuns).set({ completionContractId: contract.id,
      completionContractSha256: contract.canonicalSha256 }).where(eq(heartbeatRuns.id, f.runId));
    const controller = await currentNativeControllerIdentity();
    const leaseExpiresAt = new Date(Date.now() + 20 * 60_000);
    await f.db.update(nativeRunFinalizations).set({
      leaseOwner: leaseOwner(f.native.runnerInstanceId),
      leaseExpiresAt,
      controllerBootId: controller.bootId,
      // Local-positive accepted-result fixtures model the actual executor claim.
      controllerHostHash: (await controllerProcess.currentControllerProcess()).hostHash,
      controllerPid: controller.pid,
      controllerProcessStartedAt: controller.processStartedAt,
      controllerGeneration: 1,
    }).where(eq(nativeRunFinalizations.runId, f.runId));
    const [prepared] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const identity = { companyId: fixture.current.companyId, issueId: f.issueId, runId: f.runId,
      agentId: fixture.current.agentId, sessionId: prepared.nativeSessionId! };
    const port = new PaperclipControlPlanePort(f.db, {
      ...identity,
      completionContractId: prepared.completionContractId!,
      completionContractSha256: prepared.completionContractSha256!,
      sourceInstanceId: prepared.runnerInstanceId!,
      controlPlaneSourceInstanceId: `${label}-control`,
    });
    await port.openRun({ ...CONTROL_PLANE_CONFORMANCE_OPEN, identity, sourceInstanceId: prepared.runnerInstanceId! });
    const { revision, criterionIds } = f.native.completionContract;
    await port.completeRun({
      result: { ...CONTROL_PLANE_CONFORMANCE_RESULT, completionClaim: {
        ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: revision,
        criteria: criterionIds.map((criterionId) => ({ criterionId, status: "satisfied" as const, evidenceRefs: ["event:2"] })),
      } },
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: `${label}-result`,
    });
    // The detached controller had begun local workspace finalization.
    await f.db.insert(workspaceOperations).values({ companyId: fixture.current.companyId, issueId: f.issueId,
      heartbeatRunId: f.runId, phase: "workspace_finalize", status: "running", cwd: fixture.current.runtimeRoot });
    const [accepted] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(accepted).toMatchObject({ phase: "workspace_finalizing", resultId: expect.any(String) });
    return { ...f, leaseExpiresAt };
  }

  it("finalizes an accepted terminal result whose controller was suspended by a graceful shutdown", async () => {
    // RC-30: SIGTERM lands after run.result.accepted/run.terminal but before the
    // controller finalizes. The run must not stay `running` behind the old
    // controller's execution lease once the next boot starts recovery.
    const f = await seedAcceptedResult("ACCEPTED-THEN-SIGTERM", (runner) => `${runner}:${randomUUID()}`);
    const dying = heartbeatService(f.db);
    const drained = await dying.drainRunningRunsForShutdown("SIGTERM", new Date(), [f.runId]);
    expect(drained).toMatchObject({ restartSuspendedRunIds: [f.runId] });
    const [released] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    // Finalization, not a runner reattach, is what remains.
    expect(released.recoveryState).toBeNull();
    expect(await shutdownDispositions(f.db, f.runId)).toEqual(["awaiting_result_finalization"]);

    const providerDispatch = vi.fn(() => { throw new Error("an accepted result must not open another provider turn"); });
    const next = heartbeatService(f.db, { nativeSessionBackendFactory: providerDispatch });
    try {
      await next.recoverNativeRunsAfterRestart(new Date());
    } finally { await next.drainActiveRunExecutions(); }
    expect(providerDispatch).not.toHaveBeenCalled();

    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const [task] = await f.db.select().from(issues).where(eq(issues.id, f.issueId));
    expect({ status: run.status, phase: owner.phase }).toEqual({ status: "succeeded", phase: "committed" });
    expect(task.status).toBe("done");
    expect(await f.db.select({ id: nativeRunResults.id }).from(nativeRunResults)
      .where(eq(nativeRunResults.runId, f.runId))).toHaveLength(1);
    expect(await f.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.nativeIssueId, f.issueId))).toHaveLength(1);
  }, 90_000);

  it("keeps a finalizer lease already settling the accepted result through a graceful shutdown", async () => {
    // The shutdown drain waits for in-process finalizers; releasing their
    // lease would let the next controller finalize the same result concurrently.
    const f = await seedAcceptedResult("FINALIZER-THEN-SIGTERM", () => `native-finalizer:${randomUUID()}`);
    const dying = heartbeatService(f.db);
    await dying.drainRunningRunsForShutdown("SIGTERM", new Date(), [f.runId]);
    const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(owner).toMatchObject({ phase: "workspace_finalizing", leaseExpiresAt: f.leaseExpiresAt, recoveryState: null });
    expect(await shutdownDispositions(f.db, f.runId)).toEqual(["finalizer_in_progress"]);
    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.status).toBe("running");
  }, 60_000);

  /** RC-41: a hard kill leaves the accepted result leased to a controller that no longer exists. */
  async function killedController(f: Awaited<ReturnType<typeof seedAcceptedResult>>, controller: {
    bootId: string; pid: number; processStartedAt: Date | null;
  }) {
    await f.db.update(nativeRunFinalizations).set({ controllerBootId: controller.bootId,
      controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt })
      .where(eq(nativeRunFinalizations.runId, f.runId));
  }
  async function restart(f: Awaited<ReturnType<typeof seedAcceptedResult>>) {
    const providerDispatch = vi.fn(() => { throw new Error("an accepted result must not open another provider turn"); });
    const next = heartbeatService(f.db, { nativeSessionBackendFactory: providerDispatch });
    try { await next.recoverNativeRunsAfterRestart(new Date()); }
    finally { await next.drainActiveRunExecutions(); }
    expect(providerDispatch).not.toHaveBeenCalled();
    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    return { run, owner };
  }

  it.each([
    { holder: "runner execution", leaseOwner: (runner: string) => `${runner}:${randomUUID()}` },
    { holder: "restart-claimed execution", leaseOwner: () => `${randomUUID()}:2:${randomUUID()}` },
    // An executor that adopted a finalization-resume claim keeps that token.
    { holder: "resumed execution", leaseOwner: (runner: string) => `${runner}:resume:${randomUUID()}` },
  ])("finalizes an accepted result promptly when a hard kill left its $holder lease to a dead controller", async ({ holder, leaseOwner }) => {
    // RC-41: K1 lands after run.result is committed but before finalization.
    // The dead boot's 20-minute lease must not hold the run `running`.
    const f = await seedAcceptedResult(`ACCEPTED-THEN-SIGKILL-${holder}`, leaseOwner);
    await killedController(f, { bootId: randomUUID(), pid: 2_000_000_001, processStartedAt: new Date(Date.now() - 60_000) });
    const { run, owner } = await restart(f);
    const [task] = await f.db.select().from(issues).where(eq(issues.id, f.issueId));
    expect({ status: run.status, phase: owner.phase }).toEqual({ status: "succeeded", phase: "committed" });
    expect(task.status).toBe("done");
    expect(await f.db.select({ id: nativeRunResults.id }).from(nativeRunResults)
      .where(eq(nativeRunResults.runId, f.runId))).toHaveLength(1);
    expect(await f.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.nativeIssueId, f.issueId))).toHaveLength(1);
  }, 90_000);

  it("releases a dead controller's lease whose expiry Postgres stored with microsecond precision", async () => {
    // The controller writes its lease with SQL time arithmetic, so the stored
    // expiry carries microseconds that a JavaScript Date cannot round-trip.
    const f = await seedAcceptedResult("ACCEPTED-THEN-SIGKILL-MICROS", (runner) => `${runner}:${randomUUID()}`);
    await killedController(f, { bootId: randomUUID(), pid: 2_000_000_001, processStartedAt: new Date(Date.now() - 60_000) });
    await f.db.update(nativeRunFinalizations).set({
      leaseExpiresAt: sql`date_trunc('second', now()) + interval '20 minutes 0.123456 seconds'`,
    }).where(eq(nativeRunFinalizations.runId, f.runId));
    const { run, owner } = await restart(f);
    expect({ status: run.status, phase: owner.phase }).toEqual({ status: "succeeded", phase: "committed" });
  }, 90_000);

  it("keeps an unexpired accepted-result executor lease without process-space proof", async () => {
    const f = await seedAcceptedResult("ACCEPTED-UNPROVEN-PROCESS-SPACE", runner => `${runner}:${randomUUID()}`);
    await killedController(f, { bootId: randomUUID(), pid: 2_000_000_001,
      processStartedAt: new Date(Date.now() - 60_000) });
    // Migration leaves legacy rows NULL; do not silently turn495's original
    // missing-proof negative into a local-positive fixture after adding stamps.
    await f.db.update(nativeRunFinalizations).set({ controllerHostHash: null })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    const [before] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(before.controllerHostHash).toBeNull();
    const now = new Date();
    expect(before.leaseExpiresAt?.getTime()).toBeGreaterThan(now.getTime());
    expect(before).toMatchObject({ phase: "workspace_finalizing", resultId: expect.any(String) });
    const isProcessAlive = vi.fn(() => false);
    const readProcessStartedAt = vi.fn(async () => null);
    const released = await releaseDeadControllerResultLeases(f.db, {
      now, runIds: [f.runId], isProcessAlive, readProcessStartedAt,
    });
    expect(released).toEqual([]);
    expect(isProcessAlive).not.toHaveBeenCalled();
    expect(readProcessStartedAt).not.toHaveBeenCalled();
    const [after] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(after).toMatchObject({ leaseOwner: before.leaseOwner, leaseExpiresAt: before.leaseExpiresAt,
      controllerBootId: before.controllerBootId, controllerPid: before.controllerPid,
      phase: before.phase, resultId: before.resultId });
    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.status).toBe("running");
    expect(await f.db.select({ id: nativeRunResults.id }).from(nativeRunResults)
      .where(eq(nativeRunResults.runId, f.runId))).toHaveLength(1);
  }, 60_000);

  it.each(["foreign", "unknown-current"] as const)("retains an accepted-result lease without probing an owner in %s process space", async mode => {
    const f = await seedAcceptedResult(`ACCEPTED-SPACE-${mode}`, runner => `${runner}:${randomUUID()}`);
    await killedController(f, { bootId: randomUUID(), pid: 2_000_000_001, processStartedAt: new Date(Date.now() - 60_000) });
    const actual = await controllerProcess.currentControllerProcess();
    if (mode === "foreign") await f.db.update(nativeRunFinalizations).set({ controllerHostHash: `foreign:${actual.hostHash}` })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    const unknown = mode === "unknown-current" ? vi.spyOn(controllerProcess, "currentControllerProcess")
      .mockResolvedValue({ ...actual, hostHash: "unknown" }) : null;
    const [before] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const isProcessAlive = vi.fn(() => false), readProcessStartedAt = vi.fn(async () => null);
    try {
      expect(await releaseDeadControllerResultLeases(f.db, { now: new Date(), runIds: [f.runId], isProcessAlive, readProcessStartedAt })).toEqual([]);
      expect(isProcessAlive).not.toHaveBeenCalled();
      expect(readProcessStartedAt).not.toHaveBeenCalled();
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
        .toMatchObject({ leaseOwner: before.leaseOwner, leaseExpiresAt: before.leaseExpiresAt, controllerHostHash: before.controllerHostHash });
    } finally { unknown?.mockRestore(); }
  }, 60_000);

  it.each(["dead", "recycled"] as const)("releases only the exact same-space %s owner and finalizes its accepted result once", async mode => {
    const f = await seedAcceptedResult(`ACCEPTED-LOCAL-${mode}`, runner => `${runner}:${randomUUID()}`);
    const birth = new Date(Date.now() - 60_000);
    await killedController(f, { bootId: randomUUID(), pid: 2_000_000_001, processStartedAt: birth });
    const [before] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(before.controllerHostHash).toBe((await controllerProcess.currentControllerProcess()).hostHash);
    const now = new Date();
    const isProcessAlive = vi.fn(() => mode === "recycled");
    const readProcessStartedAt = vi.fn(async () => new Date(birth.getTime() + 2_000));
    expect(await releaseDeadControllerResultLeases(f.db, { now, runIds: [f.runId], isProcessAlive, readProcessStartedAt }))
      .toEqual([{ runId: f.runId, reason: mode === "dead" ? "controller_process_dead" : "controller_pid_recycled" }]);
    expect(isProcessAlive).toHaveBeenCalledExactlyOnceWith(2_000_000_001);
    const [released] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(released).toMatchObject({ leaseOwner: before.leaseOwner, leaseExpiresAt: now, resultId: before.resultId });
    for (let attempt = 0; attempt < 2; attempt++) {
      const { run, owner } = await restart(f);
      expect({ status: run.status, phase: owner.phase }).toEqual({ status: "succeeded", phase: "committed" });
    }
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("done");
    expect(await f.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId))).toHaveLength(1);
    expect(await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, f.issueId))).toHaveLength(1);
  }, 90_000);

  it.each(["same-birth", "unreadable-birth", "missing-recorded-birth", "ambiguous-birth"] as const)(
    "retains a same-space live owner with %s evidence", async mode => {
    const f = await seedAcceptedResult(`ACCEPTED-HOLD-${mode}`, runner => `${runner}:${randomUUID()}`);
    const birth = new Date(Date.now() - 60_000);
    await killedController(f, { bootId: randomUUID(), pid: 2_000_000_001,
      processStartedAt: mode === "missing-recorded-birth" ? null : birth });
    const isProcessAlive = vi.fn(() => true);
    const readProcessStartedAt = vi.fn(async () => mode === "unreadable-birth" ? null
      : new Date(birth.getTime() + (mode === "ambiguous-birth" ? 500 : 0)));
    expect(await releaseDeadControllerResultLeases(f.db, { now: new Date(), runIds: [f.runId], isProcessAlive, readProcessStartedAt })).toEqual([]);
    expect(isProcessAlive).toHaveBeenCalledExactlyOnceWith(2_000_000_001);
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].leaseExpiresAt)
      .toEqual(f.leaseExpiresAt);
  }, 60_000);

  it.each(["lease-token", "boot", "namespace"] as const)("loses dead-owner compare-and-set when %s changes after observation", async changed => {
    const f = await seedAcceptedResult(`ACCEPTED-CAS-${changed}`, runner => `${runner}:${randomUUID()}`);
    const birth = new Date(Date.now() - 60_000);
    await killedController(f, { bootId: randomUUID(), pid: 2_000_000_001, processStartedAt: birth });
    const replacement = randomUUID();
    const readProcessStartedAt = vi.fn(async () => {
      await f.db.update(nativeRunFinalizations).set(changed === "lease-token" ? { leaseOwner: `new-owner:${replacement}` }
        : changed === "boot" ? { controllerBootId: replacement } : { controllerHostHash: `new-space:${replacement}` })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      return new Date(birth.getTime() + 2_000);
    });
    expect(await releaseDeadControllerResultLeases(f.db, { now: new Date(), runIds: [f.runId],
      isProcessAlive: () => true, readProcessStartedAt })).toEqual([]);
    expect(readProcessStartedAt).toHaveBeenCalledExactlyOnceWith(2_000_000_001);
    const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(owner.leaseExpiresAt).toEqual(f.leaseExpiresAt);
    expect(changed === "lease-token" ? owner.leaseOwner : changed === "boot" ? owner.controllerBootId : owner.controllerHostHash)
      .toBe(changed === "lease-token" ? `new-owner:${replacement}` : changed === "boot" ? replacement : `new-space:${replacement}`);
  }, 60_000);

  it.each(["current-boot", "live-owner", "finalizer", "cleanup", "remote-sync", "remote-workspace"] as const)(
    "never probes or releases excluded accepted-result authority: %s", async exclusion => {
    const prefix = exclusion === "finalizer" ? "native-finalizer" : exclusion === "cleanup" ? "native-cleanup" : "executor";
    const f = await seedAcceptedResult(`ACCEPTED-EXCLUDE-${exclusion}`, () => `${prefix}:${randomUUID()}`);
    const self = await currentNativeControllerIdentity();
    await killedController(f, { bootId: exclusion === "current-boot" ? self.bootId : randomUUID(),
      pid: 2_000_000_001, processStartedAt: new Date(Date.now() - 60_000) });
    if (exclusion.startsWith("remote-")) await f.db.update(heartbeatRuns).set({ runnerProfileJson: {
      ...f.preparedProfile, [exclusion === "remote-sync" ? "nativeWorkspaceSync" : "remoteWorkspace"]: {},
    } }).where(eq(heartbeatRuns.id, f.runId));
    const isProcessAlive = vi.fn(() => false), readProcessStartedAt = vi.fn(async () => null);
    expect(await releaseDeadControllerResultLeases(f.db, { now: new Date(), runIds: [f.runId], isProcessAlive, readProcessStartedAt,
      liveRunExecutions: { has: runId => exclusion === "live-owner" && runId === f.runId } })).toEqual([]);
    expect(isProcessAlive).not.toHaveBeenCalled(); expect(readProcessStartedAt).not.toHaveBeenCalled();
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].leaseExpiresAt)
      .toEqual(f.leaseExpiresAt);
  }, 60_000);

  it("finalizes a legacy NULL-proof accepted result by ordinary expiry without provider replay", async () => {
    const f = await seedAcceptedResult("ACCEPTED-LEGACY-EXPIRED", runner => `${runner}:${randomUUID()}`);
    await killedController(f, { bootId: randomUUID(), pid: 2_000_000_001, processStartedAt: null });
    await f.db.update(nativeRunFinalizations).set({ controllerHostHash: null, leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    const isProcessAlive = vi.fn(() => false), readProcessStartedAt = vi.fn(async () => null);
    expect(await releaseDeadControllerResultLeases(f.db, { now: new Date(), runIds: [f.runId], isProcessAlive, readProcessStartedAt })).toEqual([]);
    expect(isProcessAlive).not.toHaveBeenCalled(); expect(readProcessStartedAt).not.toHaveBeenCalled();
    const { run, owner } = await restart(f);
    expect({ status: run.status, phase: owner.phase }).toEqual({ status: "succeeded", phase: "committed" });
    expect(await f.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId))).toHaveLength(1);
  }, 90_000);

  it("keeps the accepted result leased while its earlier-boot controller process is still alive", async () => {
    // Another live server (or an orphaned controller of an earlier boot) can
    // still be finalizing. Age and boot ID alone never prove that it stopped.
    const f = await seedAcceptedResult("ACCEPTED-LIVE-FOREIGN", () => `native-finalizer:${randomUUID()}`);
    const self = await currentNativeControllerIdentity();
    await killedController(f, { bootId: randomUUID(), pid: process.pid, processStartedAt: self.processStartedAt });
    const { run, owner } = await restart(f);
    expect({ status: run.status, phase: owner.phase, leaseExpiresAt: owner.leaseExpiresAt })
      .toEqual({ status: "running", phase: "workspace_finalizing", leaseExpiresAt: f.leaseExpiresAt });
  }, 60_000);

  it.each(["native-finalizer", "native-cleanup"])("keeps a %s lease whose controller identity names an earlier executor", async (prefix) => {
    // These claims do not rewrite the controller identity, so the dead earlier
    // executor proves nothing about the process that holds the lease now.
    const f = await seedAcceptedResult(`ACCEPTED-${prefix}-OF-LIVE-CLAIMANT`, () => `${prefix}:${randomUUID()}`);
    await killedController(f, { bootId: randomUUID(), pid: 2_000_000_001, processStartedAt: new Date(Date.now() - 60_000) });
    const { run, owner } = await restart(f);
    expect({ status: run.status, phase: owner.phase, leaseExpiresAt: owner.leaseExpiresAt })
      .toEqual({ status: "running", phase: "workspace_finalizing", leaseExpiresAt: f.leaseExpiresAt });
  }, 60_000);

  it("keeps a finalizer lease that belongs to the current boot", async () => {
    const f = await seedAcceptedResult("ACCEPTED-CURRENT-BOOT", () => `native-finalizer:${randomUUID()}`);
    const { run, owner } = await restart(f);
    expect({ status: run.status, phase: owner.phase, leaseExpiresAt: owner.leaseExpiresAt })
      .toEqual({ status: "running", phase: "workspace_finalizing", leaseExpiresAt: f.leaseExpiresAt });
  }, 60_000);

  describe("restart claim process-space authority", () => {
    const priorPid = 2_000_000_001;
    async function seedClaim(label: string, expires: "live" | "expired", hash: string | null) {
      const f = await seedRecoverableRun(label);
      await f.db.update(nativeRunFinalizations).set({
        leaseOwner: `old-controller:${randomUUID()}`, leaseExpiresAt: new Date(Date.now() + (expires === "live" ? 1_200_000 : -1_000)),
        controllerBootId: randomUUID(), controllerHostHash: hash, controllerPid: priorPid,
        controllerProcessStartedAt: new Date(Date.now() - 60_000), controllerGeneration: 1,
      }).where(eq(nativeRunFinalizations.runId, f.runId));
      return f;
    }
    function observeOwnerPid(alive = false) {
      const original = process.kill.bind(process);
      const observed: number[] = [];
      const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === priorPid && signal === 0) {
          observed.push(pid);
          if (alive) return true;
          throw Object.assign(new Error("controlled recorded owner absent in this PID space"), { code: "ESRCH" });
        }
        return original(pid, signal);
      });
      return { observed, restore: () => spy.mockRestore() };
    }
    it.each([
      { mode: "null", expires: "live" }, { mode: "foreign", expires: "live" },
      { mode: "unknown-current", expires: "live" }, { mode: "foreign", expires: "expired" },
    ] as const)("holds $mode $expires local restart claim without an owner PID probe", async ({ mode, expires }) => {
      const actual = await controllerProcess.currentControllerProcess();
      expect(actual.hostHash).not.toBe("unknown");
      const f = await seedClaim(`CLAIM-SPACE-${mode}-${expires}`, expires,
        mode === "null" ? null : mode === "foreign" ? `foreign:${actual.hostHash}` : actual.hostHash);
      const [before] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(before.resultId).toBeNull();
      const unknown = mode === "unknown-current" ? vi.spyOn(controllerProcess, "currentControllerProcess")
        .mockResolvedValue({ ...actual, hostHash: "unknown" }) : null;
      const probe = observeOwnerPid();
      const onClaim = vi.fn();
      try {
        const dispositions = await claimNativeRestartRecoveries({ db: f.db, restartKind: "hard", runIds: [f.runId], onClaim });
        // This assertion is the original-code causal RED: a local probe cannot
        // establish anything about the recorded foreign or unproved PID space.
        expect(probe.observed).toEqual([]);
        expect(dispositions).toEqual([{ kind: "awaiting_evidence", runId: f.runId, reason: "controller_process_space_unverified" }]);
        expect(onClaim).not.toHaveBeenCalled();
        const [after] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
        expect(after).toMatchObject({ leaseOwner: before.leaseOwner, leaseExpiresAt: before.leaseExpiresAt,
          controllerBootId: before.controllerBootId, controllerPid: before.controllerPid, controllerHostHash: before.controllerHostHash,
          controllerGeneration: before.controllerGeneration, attempt: before.attempt, phase: before.phase, resultId: null });
        expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("running");
        expect(await f.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId))).toEqual([]);
      } finally { probe.restore(); unknown?.mockRestore(); }
    }, 60_000);

    it.each(["live", "expired"] as const)("claims a same-space dead owner with a %s lease and stamps the pending claim", async expires => {
      const actual = await controllerProcess.currentControllerProcess();
      expect(actual.hostHash).not.toBe("unknown");
      const f = await seedClaim(`CLAIM-LOCAL-${expires}`, expires, actual.hostHash);
      const probe = observeOwnerPid();
      const onClaim = vi.fn();
      try {
        const dispositions = await claimNativeRestartRecoveries({ db: f.db, restartKind: "hard", runIds: [f.runId], onClaim });
        expect(probe.observed).toEqual([priorPid]);
        expect(onClaim).toHaveBeenCalledOnce();
        expect(dispositions).toHaveLength(1);
        expect(dispositions[0]).toMatchObject({ runId: f.runId, leaseOwner: expect.any(String) });
        const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
        expect(owner.controllerHostHash).toBe(actual.hostHash);
        expect(owner.controllerPid).toBe(process.pid);
        expect(owner.controllerBootId).toBe((await currentNativeControllerIdentity()).bootId);
        expect(owner.resultId).toBeNull();
        expect(await f.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId))).toEqual([]);
      } finally { probe.restore(); }
    }, 60_000);

    it("keeps this boot's actual PID fenced even when its old stamp is NULL", async () => {
      const f = await seedClaim("CLAIM-CURRENT-NULL", "live", null);
      const current = await currentNativeControllerIdentity();
      await f.db.update(nativeRunFinalizations).set({ controllerBootId: current.bootId,
        controllerPid: current.pid, controllerProcessStartedAt: current.processStartedAt })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      const onClaim = vi.fn();
      expect(await claimNativeRestartRecoveries({ db: f.db, restartKind: "hard", runIds: [f.runId], onClaim }))
        .toEqual([{ kind: "awaiting_evidence", runId: f.runId, reason: "controller_still_alive" }]);
      expect(onClaim).not.toHaveBeenCalled();
    }, 60_000);

    it("does not let a same-space expired lease replace a live owner", async () => {
      const actual = await controllerProcess.currentControllerProcess();
      expect(actual.hostHash).not.toBe("unknown");
      const f = await seedClaim("CLAIM-EXPIRED-LIVE", "expired", actual.hostHash);
      // A real current PID and birth keep the original evaluator's live-owner
      // contract; no expiry-only takeover is introduced by the new fence.
      const current = await currentNativeControllerIdentity();
      await f.db.update(nativeRunFinalizations).set({ controllerPid: current.pid,
        controllerProcessStartedAt: current.processStartedAt }).where(eq(nativeRunFinalizations.runId, f.runId));
      const onClaim = vi.fn();
      const dispositions = await claimNativeRestartRecoveries({ db: f.db, restartKind: "hard", runIds: [f.runId], onClaim });
      expect(dispositions).toEqual([{ kind: "awaiting_evidence", runId: f.runId, reason: "controller_still_alive" }]);
      expect(onClaim).not.toHaveBeenCalled();
    }, 60_000);

    async function namespaceHold(label: string, live = false) {
      const f = await seedClaim(label, live ? "live" : "expired", "foreign-process-space");
      const [source] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      if (!source.responsibleUserId) throw new Error("A genuine responsible operator is required");
      await f.db.update(issues).set({ responsibleUserId: source.responsibleUserId }).where(eq(issues.id, f.issueId));
      await claimNativeRestartRecoveries({ db: f.db, restartKind: "hard", runIds: [f.runId] });
      const [action] = await f.db.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, fixture.current.companyId), eq(issueRecoveryActions.sourceIssueId, f.issueId),
        eq(issueRecoveryActions.status, "active")));
      const authority = action?.evidence.controllerAuthority;
      if (!authority || typeof authority !== "object" || Array.isArray(authority)
        || typeof authority.digest !== "string") throw new Error("Expected exact server-owned controller authority");
      return { ...f, action, digest: authority.digest, userId: source.responsibleUserId };
    }
    function boardRoutes(f: Awaited<ReturnType<typeof namespaceHold>>, actor?: Express.Request["actor"]) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = actor ?? { type: "board", userId: f.userId, source: "session", companyIds: [fixture.current.companyId],
          memberships: [{ companyId: fixture.current.companyId, membershipRole: "owner", status: "active" }] };
        next();
      });
      app.use("/api", issueRoutes(f.db, createStorageService(createLocalDiskStorageProvider(fixture.current.runtimeRoot))));
      app.use(errorHandler);
      return app;
    }
    const containmentEvidence = "Deployment operator verified the original host controller, provider and tools are stopped; external action outcomes were reviewed.";
    function confirmation(f: Awaited<ReturnType<typeof namespaceHold>>) {
      return { actionId: f.action.id, outcome: "restored", sourceIssueStatus: "in_progress",
        executionReconciliation: { runId: f.runId, controllerStopped: true, providerStopped: true,
          controllerAuthorityDigest: f.digest, actionOutcome: "mixed", outcomeEvidence: containmentEvidence } };
    }

    it("keeps repeated namespace attention idempotent without spending a recovery budget", async () => {
      const f = await namespaceHold("CLAIM-ATTENTION-IDEMPOTENT");
      const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      for (let scan = 0; scan < 3; scan++) await claimNativeRestartRecoveries({ db: f.db, restartKind: "hard", runIds: [f.runId] });
      const rows = await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: f.action.id, attemptCount: 0, maxAttempts: null, wakePolicy: null, monitorPolicy: null,
        updatedAt: f.action.updatedAt, lastAttemptAt: f.action.lastAttemptAt });
      expect(JSON.stringify(rows)).not.toContain(owner.leaseOwner!);
      expect(rows[0].fingerprint).toBe(`native-controller-space:${f.runId}:${f.digest}`);
    }, 60_000);

    it("supersedes exact namespace attention after a microsecond renewal without overwriting its history", async () => {
      const f = await namespaceHold("CLAIM-ATTENTION-RENEWAL");
      const [before] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      await f.db.update(nativeRunFinalizations).set({ leaseExpiresAt: sql`${nativeRunFinalizations.leaseExpiresAt} + interval '1 microsecond'` })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      const [renewed] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(renewed.leaseOwner).toBe(before.leaseOwner);
      expect(renewed.leaseExpiresAt).toEqual(before.leaseExpiresAt); // JS drops the changed microsecond.
      await claimNativeRestartRecoveries({ db: f.db, restartKind: "hard", runIds: [f.runId] });
      const rows = await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      expect(rows).toHaveLength(2);
      expect(rows.find(row => row.id === f.action.id)).toMatchObject({ status: "cancelled", evidence: f.action.evidence });
      const current = rows.find(row => row.status === "active");
      expect(current).toMatchObject({ attemptCount: 0, maxAttempts: null, wakePolicy: null, monitorPolicy: null });
      expect(current?.fingerprint).not.toBe(f.action.fingerprint);
    }, 60_000);

    it("does not overwrite an unrelated active recovery identity with namespace attention", async () => {
      const f = await seedClaim("CLAIM-OTHER-ATTENTION", "expired", "foreign-process-space");
      const [prior] = await f.db.insert(issueRecoveryActions).values({ companyId: fixture.current.companyId,
        sourceIssueId: f.issueId, kind: "active_run_watchdog", ownerType: "board", cause: "uncertain_external_action",
        fingerprint: `other:${f.runId}`, evidence: { runId: f.runId, originalEvidence: "keep this exact incident" },
        nextAction: "Review this independent external action first.", attemptCount: 2, maxAttempts: 3 }).returning();
      await claimNativeRestartRecoveries({ db: f.db, restartKind: "hard", runIds: [f.runId] });
      expect(await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([prior]);
    }, 60_000);

    it("rejects a stale dialog after a same-token microsecond-only lease renewal", async () => {
      const f = await namespaceHold("CLAIM-CONTAINMENT-MICROSECOND-CAS");
      await f.db.update(nativeRunFinalizations).set({ leaseExpiresAt: sql`${nativeRunFinalizations.leaseExpiresAt} + interval '1 microsecond'` })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      const response = await request(boardRoutes(f)).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(confirmation(f));
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.details?.code).toBe("native_controller_containment_stale");
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("running");
      expect((await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id)))[0].status).toBe("active");
    }, 60_000);

    it.each(["token", "boot", "generation", "namespace", "assignee", "renewed-live-lease"] as const)
    ("rejects controller containment after the %s fence changes", async changed => {
      const f = await namespaceHold(`CLAIM-CONTAINMENT-${changed}`);
      if (changed === "assignee") await f.db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
      else await f.db.update(nativeRunFinalizations).set(changed === "token" ? { leaseOwner: randomUUID() }
        : changed === "boot" ? { controllerBootId: randomUUID() }
        : changed === "generation" ? { controllerGeneration: sql`${nativeRunFinalizations.controllerGeneration} + 1` }
        : changed === "namespace" ? { controllerHostHash: "replaced-space" } : { leaseExpiresAt: new Date(Date.now() + 60_000) })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      const response = await request(boardRoutes(f)).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(confirmation(f));
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("running");
    }, 60_000);

    it("rejects the old provider-only confirmation for the new controller hold", async () => {
      const f = await namespaceHold("CLAIM-CONTAINMENT-EXPLICIT-CONTROLLER");
      const body = confirmation(f);
      const { controllerStopped: _stopped, controllerAuthorityDigest: _digest, ...providerOnly } = body.executionReconciliation;
      const response = await request(boardRoutes(f)).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
        .send({ ...body, executionReconciliation: providerOnly });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].leaseOwner).not.toBeNull();
    }, 60_000);

    it("rejects unknown action outcomes instead of turning containment into replay permission", async () => {
      const f = await namespaceHold("CLAIM-CONTAINMENT-UNKNOWN-OUTCOME");
      const body = confirmation(f);
      const response = await request(boardRoutes(f)).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
        .send({ ...body, executionReconciliation: { ...body.executionReconciliation, actionOutcome: "unknown" } });
      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("running");
    }, 60_000);

    it.each(["native-finalizer", "native-cleanup"] as const)("never uses an executor's PID to claim %s authority", async holder => {
      const actual = await controllerProcess.currentControllerProcess();
      const f = await seedClaim(`CLAIM-NONEXECUTOR-${holder}`, "expired", actual.hostHash);
      await f.db.update(nativeRunFinalizations).set({ leaseOwner: `${holder}:${randomUUID()}` })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      const probe = observeOwnerPid();
      try {
        expect(await claimNativeRestartRecoveries({ db: f.db, restartKind: "hard", runIds: [f.runId] }))
          .toEqual([{ kind: "awaiting_evidence", runId: f.runId, reason: "native_finalization_or_cleanup_owner" }]);
        expect(probe.observed).toEqual([]);
        expect(await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
      } finally { probe.restore(); }
    }, 60_000);

    it("keeps remote-marked no-checkpoint ownership out of the local containment form", async () => {
      const f = await seedClaim("CLAIM-REMOTE-NO-CHECKPOINT", "expired", "foreign-process-space");
      // The claim route treats any retained remote-workspace field as remote;
      // an incomplete descriptor must never grant a local containment bypass.
      await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...f.preparedProfile, remoteWorkspace: { state: "prepared" } } })
        .where(eq(heartbeatRuns.id, f.runId));
      const probe = observeOwnerPid();
      try {
        expect(await claimNativeRestartRecoveries({ db: f.db, restartKind: "hard", runIds: [f.runId] }))
          .toEqual([{ kind: "awaiting_evidence", runId: f.runId, reason: "remote_controller_process_space_unverified" }]);
        expect(probe.observed).toEqual([]);
        const [action] = await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
        expect(action.evidence.controllerAuthority).toBeUndefined();
        expect(action.nextAction).toContain("ordinary Stop");
      } finally { probe.restore(); }
    }, 60_000);

    // A controlled provider uses the normal SDK event/result contract. It does
    // not write an accepted result, task status, usage, or finalization directly.
    function retryBackend(db: Awaited<ReturnType<typeof seedRecoverableRun>>["db"], opened: string[]) {
      const factory: NonNullable<HeartbeatServiceOptions["nativeSessionBackendFactory"]> = execution => {
        const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
        let identity: NativeRunIdentity;
        let sourceInstanceId = "";
        const turnId = randomUUID();
        let begin: () => void = () => {};
        const started = new Promise<void>(resolve => { begin = resolve; });
        const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT, summary: "The explicitly retried task produced this useful completion.",
          completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim,
            contractRevision: execution.completionContract.contract.revision,
            criteria: execution.completionContract.contract.criteria.map(criterion => ({ criterionId: criterion.id,
              status: "satisfied" as const, evidenceRefs: ["event:2"] })) } };
        const session: NativeSession = {
          identity: () => identity, capabilities: async () => capabilities,
          startTurn: async () => { begin(); return { turnId }; },
          async *events() {
            await started;
            const event = (sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent => ({
              schema: "paperclip.prp.event.v1", sourceKind: "runner", sourceInstanceId,
              sourceEventId: `${sourceInstanceId}:${sourceSeq}`, sourceSeq, runId: identity.runId,
              normalizedSessionId: identity.sessionId, turnId, schemaVersion: 1, priority: 0,
              emittedAt: new Date().toISOString(), eventType, payload });
            yield event(1, "turn.started", {});
            yield event(2, "item.completed", { kind: "agentMessage", channel: "final", text: result.summary });
            yield event(3, "turn.completed", { status: "completed" });
          },
          result: async () => ({ result, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, turnId }),
          snapshot: async () => ({ backendKind: "mock", sessionId: "contained-retry-session", identity,
            providerSessionId: "contained-retry-provider", cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }),
          close: async () => {},
        };
        return { descriptor: async () => {
          const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, execution.binding.runId));
          if (!run.runnerInstanceId) throw new Error("A real admitted runner identity is required");
          sourceInstanceId = run.runnerInstanceId;
          return { kind: "mock", name: "contained-retry", version: "1", capabilities,
            runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } };
        }, openSession: async input => { identity = input.identity; opened.push(identity.runId); return session; },
          recoverSession: async snapshot => { identity = snapshot.identity; opened.push(identity.runId); return { recovered: true, session }; } };
      };
      return factory;
    }

    it("records original-host containment then completes one useful successor only after a new ordinary Retry", async () => {
      const f = await namespaceHold("CLAIM-CONTAINMENT-ORDINARY-RETRY");
      const [before] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const oldClick = await requestTaskRetry({ db: f.db, companyId: fixture.current.companyId, issueId: f.issueId,
        actorId: f.userId, actorSource: "session", observedRunId: f.runId, idempotencyKey: randomUUID() });
      expect(oldClick.accepted).toBe(true);
      const opened: string[] = [];
      const services: ReturnType<typeof heartbeatService>[] = [];
      const actualFactory = heartbeatModule.heartbeatService;
      const factory = vi.spyOn(heartbeatModule, "heartbeatService").mockImplementation((db, options) => {
        const service = actualFactory(db, { ...options, nativeSessionBackendFactory: retryBackend(db, opened) });
        services.push(service); return service;
      });
      try {
        const app = boardRoutes(f);
        const response = await request(app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(confirmation(f));
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const [source] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
        expect(source).toMatchObject({ status: "failed", usageJson: before.usageJson, costAccountingPending: before.costAccountingPending });
        const [coordinator] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
        expect(coordinator).toMatchObject({ phase: "terminal_failure", resultId: null, leaseOwner: null,
          failureDetail: { releasedOwner: { actionOutcome: "mixed", outcomeEvidence: containmentEvidence } } });
        const [action] = await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id));
        expect(action.evidence.continuationDelivery).toBe("not_requested");
        expect(action.evidence.executionReconciliation).toMatchObject({ controllerAuthorityDigest: f.digest });
        expect(action.evidence.executionReconciliation).toMatchObject({ controllerStopped: true, providerStopped: true,
          actionOutcome: "mixed", outcomeEvidence: containmentEvidence });
        const [old] = await f.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, oldClick.requestId!));
        // A Retry while the source is running already coalesced into that
        // accepted run. It is not an unadmitted receipt and must stay history.
        expect(old).toMatchObject({ status: "coalesced", runId: f.runId });
        expect(opened).toEqual([]);
        expect(await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, f.issueId))).toHaveLength(1);
        const retried = await request(app).post(`/api/issues/${f.issueId}/retry`).send({ observedRunId: f.runId, idempotencyKey: randomUUID() });
        expect(retried.status, JSON.stringify(retried.body)).toBe(202);
        expect(retried.body.requestId).not.toBe(oldClick.requestId);
        await waitForCondition("normal explicit Retry execution and wakes to settle", () => services.every(service => service.getTaskDrainStatus().quiescent));
        const [wake] = await f.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, retried.body.requestId));
        expect(wake.runId).not.toBeNull();
        expect(wake.runId).not.toBe(f.runId);
        expect(opened).toEqual([wake.runId]);
        const [successor] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
        expect(successor.status).toBe("succeeded");
        expect(successor.contextSnapshot?.executionContinuation).toMatchObject({ recoveryOutcomes: expect.arrayContaining([
          { recoveryActionId: f.action.id, decision: expect.objectContaining({ actionOutcome: "mixed", outcomeEvidence: containmentEvidence }) },
        ]) });
        expect(successor.resultJson?.nativeResult).toMatchObject({ summary: "The explicitly retried task produced this useful completion." });
        const [task] = await f.db.select().from(issues).where(eq(issues.id, f.issueId));
        expect(task.status).toBe("done");
        expect(await f.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId))).toEqual([]);
        expect(await f.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, successor.id))).toHaveLength(1);
      } finally {
        factory.mockRestore();
        for (const service of services) await service.drainActiveRunExecutions();
      }
    }, 90_000);

    it("requires new Retry only for exact unadmitted receipts and keeps other accepted work", async () => {
      const f = await namespaceHold("CLAIM-CONTAINMENT-UNADMITTED");
      // Existing failed-owner fixtures model the supported failure outside the
      // executor: status failed with the result-less observed claim still held.
      // No provider outcome, accepted result or cost is supplied by this setup.
      await f.db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), errorCode: "native_session_resume_failed" })
        .where(eq(heartbeatRuns.id, f.runId));
      const old = await requestTaskRetry({ db: f.db, companyId: fixture.current.companyId, issueId: f.issueId,
        actorId: f.userId, actorSource: "session", observedRunId: f.runId, idempotencyKey: randomUUID() });
      const [before] = await f.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, old.requestId!));
      expect(before).toMatchObject({ status: "deferred_issue_execution", runId: null });
      const other = await namespaceHold("CLAIM-OTHER-ACCEPTED-WORK");
      const accepted = await requestTaskRetry({ db: other.db, companyId: fixture.current.companyId, issueId: other.issueId,
        actorId: other.userId, actorSource: "session", observedRunId: other.runId, idempotencyKey: randomUUID() });
      const [unrelatedBefore] = await f.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, accepted.requestId!));
      const response = await request(boardRoutes(f)).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(confirmation(f));
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect((await f.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, old.requestId!)))[0])
        .toMatchObject({ status: "skipped", runId: null, error: "controller_containment_requires_new_retry", payload: before.payload });
      expect((await f.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, accepted.requestId!)))[0]).toEqual(unrelatedBefore);
      const next = await requestTaskRetry({ db: f.db, companyId: fixture.current.companyId, issueId: f.issueId,
        actorId: f.userId, actorSource: "session", observedRunId: f.runId, idempotencyKey: randomUUID() });
      expect(next.accepted).toBe(true);
      expect(next.requestId).not.toBe(old.requestId);
    }, 60_000);

    it.each(["environment", "workspace"] as const)("retains containment authority while %s cleanup is unsettled", async kind => {
      const f = await namespaceHold(`CLAIM-CONTAINMENT-CLEANUP-${kind}`);
      if (kind === "environment") await f.db.insert(environmentLeases).values({ companyId: fixture.current.companyId,
        issueId: f.issueId, heartbeatRunId: f.runId, provider: "local", status: "active" });
      else await f.db.insert(workspaceOperations).values({ companyId: fixture.current.companyId, issueId: f.issueId,
        heartbeatRunId: f.runId, phase: "workspace_finalize", status: "running", cwd: fixture.current.runtimeRoot });
      const response = await request(boardRoutes(f)).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(confirmation(f));
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("running");
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].leaseOwner).not.toBeNull();
    }, 60_000);

    it("preserves a result actually accepted after the namespace attention was published", async () => {
      const f = await namespaceHold("CLAIM-CONTAINMENT-ACCEPTED-RESULT", true);
      const [contract] = await f.db.select().from(completionContracts).where(eq(completionContracts.issueId, f.issueId));
      await f.db.update(heartbeatRuns).set({ completionContractId: contract.id, completionContractSha256: contract.canonicalSha256 })
        .where(eq(heartbeatRuns.id, f.runId));
      const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const identity = { companyId: fixture.current.companyId, issueId: f.issueId, runId: f.runId,
        agentId: fixture.current.agentId, sessionId: run.nativeSessionId! };
      const port = new PaperclipControlPlanePort(f.db, { ...identity, completionContractId: contract.id,
        completionContractSha256: contract.canonicalSha256, sourceInstanceId: run.runnerInstanceId!,
        controlPlaneSourceInstanceId: `accepted-after-attention:${f.runId}` });
      await port.openRun({ ...CONTROL_PLANE_CONFORMANCE_OPEN, identity, sourceInstanceId: run.runnerInstanceId! });
      await port.completeRun({ result: { ...CONTROL_PLANE_CONFORMANCE_RESULT, completionClaim: {
        ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: f.native.completionContract.revision,
        criteria: f.native.completionContract.criterionIds.map(criterionId => ({ criterionId, status: "satisfied" as const, evidenceRefs: ["event:2"] })),
      } }, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, callerResultId: `accepted-after-attention:${f.runId}` });
      const [accepted] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(accepted.resultId).not.toBeNull();
      const response = await request(boardRoutes(f)).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(confirmation(f));
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].resultId).toBe(accepted.resultId);
      expect(await f.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId))).toHaveLength(1);
    }, 60_000);

    it("retains the real durable Stop until its actual owner acknowledges it", async () => {
      const f = await namespaceHold("CLAIM-CONTAINMENT-STOP-PENDING");
      const requestId = randomUUID();
      await claimCancellationRequest(f.db, f.runId, fixture.current.companyId, requestId, f.userId);
      await expect(cancelHeartbeatNativeRun({ db: f.db, runId: f.runId, reason: "Operator requested Stop",
        runtimeMode: "native", cancellationRequestId: requestId })).rejects.toThrow("native_cancellation_pending_recovery");
      const [pending] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(pending.resultJson?.nativeCancellation).toMatchObject({ dispatchState: "pending" });
      const response = await request(boardRoutes(f)).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(confirmation(f));
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].leaseOwner).not.toBeNull();
    }, 60_000);

    it("keeps the authority digest stable across PostgreSQL session time zones", async () => {
      const f = await namespaceHold("CLAIM-CONTAINMENT-TIMEZONE");
      await f.db.transaction(async tx => {
        await tx.execute(sql`set local time zone 'Pacific/Honolulu'`);
        const [row] = await tx.select({ owner: nativeRunFinalizations,
          expiryEpoch: sql<string>`extract(epoch from ${nativeRunFinalizations.leaseExpiresAt})::numeric::text` })
          .from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
        expect(nativeControllerAuthorityDigest(row.owner, row.expiryEpoch)).toBe(f.digest);
      });
    }, 60_000);

    it("keeps plugin-runner leases without a checkpoint in their normal Stop recovery", async () => {
      const f = await seedClaim("CLAIM-PLUGIN-NO-CHECKPOINT", "expired", "foreign-process-space");
      await f.db.insert(environmentLeases).values({ companyId: fixture.current.companyId, issueId: f.issueId,
        heartbeatRunId: f.runId, provider: "plugin", status: "active", metadata: { runnerTaskLease: true } });
      const probe = observeOwnerPid();
      try {
        expect(await claimNativeRestartRecoveries({ db: f.db, restartKind: "hard", runIds: [f.runId] }))
          .toEqual([{ kind: "awaiting_evidence", runId: f.runId, reason: "remote_controller_process_space_unverified" }]);
        expect(probe.observed).toEqual([]);
        const [action] = await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
        expect(action.evidence.controllerAuthority).toBeUndefined();
        expect(action.nextAction).toContain("ordinary Stop");
      } finally { probe.restore(); }
    }, 60_000);

    it("retires exact namespace attention when real current identity becomes readable and normal recovery claims", async () => {
      const actual = await controllerProcess.currentControllerProcess();
      expect(actual.hostHash).not.toBe("unknown");
      const f = await seedClaim("CLAIM-SPACE-READABLE-AGAIN", "expired", actual.hostHash);
      // Degrade evidence for the first scan; never fabricate a stronger hash.
      const unreadable = vi.spyOn(controllerProcess, "currentControllerProcess").mockResolvedValue({ ...actual, hostHash: "unknown" });
      try {
        expect(await claimNativeRestartRecoveries({ db: f.db, restartKind: "hard", runIds: [f.runId] }))
          .toEqual([{ kind: "awaiting_evidence", runId: f.runId, reason: "controller_process_space_unverified" }]);
      } finally { unreadable.mockRestore(); }
      const [attention] = await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      const probe = observeOwnerPid();
      const onClaim = vi.fn();
      try {
        await claimNativeRestartRecoveries({ db: f.db, restartKind: "hard", runIds: [f.runId], onClaim });
        expect(onClaim).toHaveBeenCalledOnce();
        expect(probe.observed).toEqual([priorPid]);
        const [settled] = await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, attention.id));
        expect(settled).toMatchObject({ status: "resolved", outcome: "restored", evidence: attention.evidence });
        expect(settled.evidence.executionReconciliation).toBeUndefined();
      } finally { probe.restore(); }
    }, 60_000);
  });
});
