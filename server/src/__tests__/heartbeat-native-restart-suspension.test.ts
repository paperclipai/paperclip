import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, authUsers, budgetReservations, issueRecoveryActions, companyMemberships, completionContracts, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, workspaceOperations } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { subscribeDatabaseWork } from "@paperclipai/db/work-signals";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { resolveLocalRuntimeApiUrl } from "../runtime-api.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { classifyNativeRunnerRecoveryEvidence, currentNativeControllerIdentity } from "../services/native-runtime/native-restart-recovery.js";
import type { NativeSessionBackend } from "@paperclipai/paperclip-runner";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { CONTROL_PLANE_CONFORMANCE_OPEN, CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "./helpers/native-restart.js";
import { currentControllerBootId, currentProcessSpaceHash } from "../services/controller-process-identity.js";
import { createOwnershipReportState, runOwnershipReconciliationPass, settleOwnableKind, type OwnershipReport } from "../services/recovery/ownership-invariant-report.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerOwnershipReconciliationWork } from "../services/native-runtime/native-finalization-reconciler.js";
import { OWNABLE_KINDS } from "../services/recovery/ownership-registry.js";
import { proveOwnerGone } from "../services/owner-proof.js";


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
      const [owner] = await f.db.select({ attempt: nativeRunFinalizations.attempt }).from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, f.runId));
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
    bootId: string; pid: number; processStartedAt: Date | null; hostHash?: string | null;
  }) {
    await f.db.update(nativeRunFinalizations).set({ controllerBootId: controller.bootId,
      controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt,
      controllerHostHash: controller.hostHash ?? null })
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

  // H1 bug A: a budget pause cancelled the run 0.36 s after its result was
  // accepted, then a hard kill took the controller. The dead controller's
  // result lease held finalization, and with it the agent's pause, for the
  // lease's 20 minutes.
  it("finalizes an accepted result whose run a pause cancelled before a hard kill took its controller", async () => {
    const f = await seedAcceptedResult("ACCEPTED-CANCELLED-THEN-SIGKILL", (runner) => `${runner}:${randomUUID()}`);
    await killedController(f, deadController(currentProcessSpaceHash()));
    await f.db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), errorCode: "cancelled" })
      .where(eq(heartbeatRuns.id, f.runId));
    const { owner } = await restart(f);
    // The agent's pause waits only while an accepted result stays leased
    // (agentExecutionsHaveStopped); finalization has now released it.
    expect(owner.leaseOwner).toBeNull();
    expect(owner.phase).not.toBe("workspace_finalizing");
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

  // Phase 2: the accepted-result lease settles on the shared ownership path
  // (proveOwnerGone + registry settle), never by lease age.
  const deadController = (hostHash: string | null) => ({ bootId: randomUUID(), pid: 2_000_000_001,
    processStartedAt: new Date(Date.now() - 60_000), hostHash });
  const legacyProofs = async (f: Awaited<ReturnType<typeof seedAcceptedResult>>) => f.db.select({ id: activityLog.id })
    .from(activityLog).where(and(eq(activityLog.action, "legacy_host_unknown_dead_pid_proof"), eq(activityLog.runId, f.runId)));

  it("finalizes a result leased to a dead controller stamped with this PID space, without the legacy fallback", async () => {
    const f = await seedAcceptedResult("ACCEPTED-STAMPED-DEAD", (runner) => `${runner}:${randomUUID()}`);
    await killedController(f, deadController(currentProcessSpaceHash()));
    const { run, owner } = await restart(f);
    expect({ status: run.status, phase: owner.phase }).toEqual({ status: "succeeded", phase: "committed" });
    expect(await legacyProofs(f)).toHaveLength(0);
  }, 90_000);

  it("records each use of the one-release fallback for a controller saved before its PID space", async () => {
    const f = await seedAcceptedResult("ACCEPTED-LEGACY-DEAD", (runner) => `${runner}:${randomUUID()}`);
    await killedController(f, deadController(null));
    const { run } = await restart(f);
    expect(run.status).toBe("succeeded");
    expect(await legacyProofs(f)).toHaveLength(1);
  }, 90_000);

  it("keeps a result leased to a dead PID recorded in another PID space: another host is never proof", async () => {
    const f = await seedAcceptedResult("ACCEPTED-FOREIGN-SPACE", (runner) => `${runner}:${randomUUID()}`);
    await killedController(f, deadController("another-pid-space"));
    const { run, owner } = await restart(f);
    expect({ status: run.status, phase: owner.phase, leaseExpiresAt: owner.leaseExpiresAt })
      .toEqual({ status: "running", phase: "workspace_finalizing", leaseExpiresAt: f.leaseExpiresAt });
  }, 60_000);

  it("keeps an unrecorded-host lease on an ephemeral server and asks the board to confirm the stop", async () => {
    const f = await seedAcceptedResult("ACCEPTED-LEGACY-EPHEMERAL", (runner) => `${runner}:${randomUUID()}`);
    await killedController(f, deadController(null));
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
    try {
      const report = await runOwnershipReconciliationPass(f.db, { state: createOwnershipReportState() });
      expect(report.kinds.find(kind => kind.kind === "native_accepted_result_lease"))
        .toMatchObject({ settled: 0, reasons: { process_space_unrecorded: 1 } });
    } finally { vi.unstubAllEnvs(); }
    const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(owner.leaseExpiresAt).toEqual(f.leaseExpiresAt);
    const actions = await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(actions.map(action => [action.cause, action.ownerType, action.status]))
      .toEqual([["native_controller_host_unverified", "board", "active"]]);
  }, 60_000);

  it("finalizes the result once the board attests the unrecorded controller stopped", async () => {
    const f = await seedAcceptedResult("ACCEPTED-OPERATOR-ATTESTED", (runner) => `${runner}:${randomUUID()}`);
    await killedController(f, deadController("operator_attested"));
    const { run } = await restart(f);
    expect(run.status).toBe("succeeded");
  }, 90_000);

  it("settles a dead controller's result lease in the reconciler pass when restart recovery missed it", async () => {
    // Crash point: the controller died after the result was accepted and the
    // lease written, and this boot's restart sweep did not see it (it started
    // before the row, or failed). The next reconciler pass settles it.
    const f = await seedAcceptedResult("ACCEPTED-RECONCILER-PASS", (runner) => `${runner}:${randomUUID()}`);
    await killedController(f, deadController(currentProcessSpaceHash()));
    const readOnly = await runOwnershipReconciliationPass(f.db, { state: createOwnershipReportState(), record: false });
    expect(readOnly.kinds.find(kind => kind.kind === "native_accepted_result_lease"))
      .toMatchObject({ settled: 0, verdicts: { gone: 1 } });
    const [held] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(held.leaseExpiresAt).toEqual(f.leaseExpiresAt);
    const state = createOwnershipReportState();
    const first = await runOwnershipReconciliationPass(f.db, { state });
    expect(first.kinds.find(kind => kind.kind === "native_accepted_result_lease")).toMatchObject({ settled: 1 });
    const [released] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(released.leaseExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
    // Settled records are no longer in progress, so rule I2 never fires.
    const second = await runOwnershipReconciliationPass(f.db, { state });
    expect(second.violations.filter(violation => violation.kind === "native_accepted_result_lease")).toEqual([]);
  }, 60_000);

  it("keeps a live earlier-boot controller's result lease in the reconciler pass", async () => {
    const f = await seedAcceptedResult("ACCEPTED-RECONCILER-LIVE", (runner) => `${runner}:${randomUUID()}`);
    const self = await currentNativeControllerIdentity();
    await killedController(f, { bootId: randomUUID(), pid: process.pid, processStartedAt: self.processStartedAt,
      hostHash: currentProcessSpaceHash() });
    const report = await runOwnershipReconciliationPass(f.db, { state: createOwnershipReportState() });
    expect(report.kinds.find(kind => kind.kind === "native_accepted_result_lease"))
      .toMatchObject({ settled: 0, verdicts: { alive: 1 } });
    const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(owner.leaseExpiresAt).toEqual(f.leaseExpiresAt);
  }, 60_000);

  it("drops an expired executor lease from the kind and asks the board nothing for it", async () => {
    const f = await seedAcceptedResult("ACCEPTED-EXPIRED-LEGACY", (runner) => `${runner}:${randomUUID()}`);
    await killedController(f, deadController(null));
    await f.db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
    try {
      const kind = OWNABLE_KINDS.find(candidate => candidate.id === "native_accepted_result_lease")!;
      expect(await kind.listForRuns!(f.db, [f.runId])).toEqual([]);
      await runOwnershipReconciliationPass(f.db, { state: createOwnershipReportState() });
    } finally { vi.unstubAllEnvs(); }
    expect(await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
  }, 60_000);

  it("lists a requested run's lease directly, so a run-scoped settle never misses it", async () => {
    const f = await seedAcceptedResult("ACCEPTED-RUN-SCOPED", (runner) => `${runner}:${randomUUID()}`);
    await killedController(f, deadController(currentProcessSpaceHash()));
    const kind = OWNABLE_KINDS.find(candidate => candidate.id === "native_accepted_result_lease")!;
    expect((await kind.listForRuns!(f.db, [f.runId, randomUUID()])).map(record => record.runId)).toEqual([f.runId]);
    const settled = await settleOwnableKind(f.db, "native_accepted_result_lease", { runIds: [f.runId] });
    expect(settled.map(record => record.runId)).toEqual([f.runId]);
  }, 60_000);

  it("settles a result lease whose live controller dies after the worker went quiet, with no signal", async () => {
    // The set stays unchanged across passes, so only the settle watch keeps a
    // re-check due. The controller then dies without writing anything.
    const f = await seedAcceptedResult("ACCEPTED-DIES-AFTER-QUIET", (runner) => `${runner}:${randomUUID()}`);
    const self = await currentNativeControllerIdentity();
    const liveBoot = randomUUID();
    await killedController(f, { bootId: liveBoot, pid: process.pid, processStartedAt: self.processStartedAt,
      hostHash: currentProcessSpaceHash() });
    const reports: OwnershipReport[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: f.db, canRun: () => true, onError: () => undefined });
    const worker = registerOwnershipReconciliationWork(f.db, coordinator, () => true, { onReport: report => reports.push(report) });
    try {
      await worker.ready;
      await expect.poll(() => reports.length, { timeout: 70_000, interval: 250 }).toBeGreaterThanOrEqual(2);
      const lease = (report: OwnershipReport) => report.kinds.find(kind => kind.kind === "native_accepted_result_lease")!;
      expect(lease(reports[1]!)).toMatchObject({ settled: 0, verdicts: { alive: expect.any(Number) } });
      expect(reports[1]!.settleWatch).toBeGreaterThan(0);
      // Gone quiet would mean no deadline; the watch keeps one due.
      expect(coordinator.nextWakeAt()).not.toBeNull();
      await killedController(f, deadController(currentProcessSpaceHash()));
      await expect.poll(async () => {
        const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
        return owner.leaseExpiresAt!.getTime() <= Date.now();
      }, { timeout: 70_000, interval: 500 }).toBe(true);
    } finally {
      await coordinator.stop();
    }
  }, 180_000);

  it("keeps an idle issue's grace deadline while only the settle watch is due", async () => {
    // Rule I7: an in-progress issue with no next action becomes checkable when
    // its grace window ends. While a live result-lease owner keeps the worker
    // on light re-checks, that deadline must still trigger a full pass.
    const f = await seedAcceptedResult("ACCEPTED-WATCH-WITH-GRACE", (runner) => `${runner}:${randomUUID()}`);
    const self = await currentNativeControllerIdentity();
    await killedController(f, { bootId: randomUUID(), pid: process.pid, processStartedAt: self.processStartedAt,
      hostHash: currentProcessSpaceHash() });
    // Grace (5 min) ends about 50 s from now: after the worker turns watch-only.
    await f.db.insert(issues).values({ id: randomUUID(), companyId: fixture.current.companyId, title: "Idle in progress",
      status: "in_progress", assigneeAgentId: fixture.current.agentId, updatedAt: new Date(Date.now() - 5 * 60_000 + 50_000) });
    const reports: OwnershipReport[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: f.db, canRun: () => true, onError: () => undefined });
    const worker = registerOwnershipReconciliationWork(f.db, coordinator, () => true, { onReport: report => reports.push(report) });
    try {
      await worker.ready;
      await expect.poll(() => reports.length, { timeout: 70_000, interval: 250 }).toBeGreaterThanOrEqual(2);
      expect(reports[1]!.settleWatch).toBeGreaterThan(0);
      // The third pass is due by the grace deadline, so it is a full pass.
      await expect.poll(() => reports.length, { timeout: 70_000, interval: 250 }).toBeGreaterThanOrEqual(3);
    } finally {
      await coordinator.stop();
    }
  }, 180_000);

  // Phase 2: the token-only finalizer and cleanup leases record their holder
  // process (`lease_holder`, bound to the token) and settle on the shared
  // ownership path when it is proven gone, never by lease age.
  type Holder = { bootId: string; pid: number; hostHash: string; processStartedAt: string | null };
  const deadHolder = (hostHash = currentProcessSpaceHash()): Holder => ({ bootId: randomUUID(), pid: 2_000_000_001,
    hostHash, processStartedAt: new Date(Date.now() - 60_000).toISOString() });
  async function heldBy(f: Awaited<ReturnType<typeof seedAcceptedResult>>, holder: Holder, token?: string) {
    const [row] = await f.db.select({ leaseOwner: nativeRunFinalizations.leaseOwner }).from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, f.runId));
    await f.db.update(nativeRunFinalizations).set({ leaseHolder: { token: token ?? row.leaseOwner, ...holder } })
      .where(eq(nativeRunFinalizations.runId, f.runId));
  }
  const tokenKindId = (prefix: string) => prefix === "native-finalizer" ? "native_finalizer_lease" : "native_cleanup_lease";
  /** This run's record of the kind and its proof (the fixture database is shared across cases). */
  async function proofOf(f: Awaited<ReturnType<typeof seedAcceptedResult>>, prefix: string) {
    const kind = OWNABLE_KINDS.find(candidate => candidate.id === tokenKindId(prefix))!;
    const records = await kind.listForRuns!(f.db, [f.runId]);
    if (!records.length) return null;
    const owner = records[0]!.owner;
    if (owner.kind === "process") return { owner: owner.kind, ...await proveOwnerGone(owner.stamp) };
    if (owner.kind === "fence") return { owner: owner.kind, ...await proveOwnerGone(owner.stamp, owner.fence) };
    return { owner: owner.kind };
  }
  async function leaseOf(f: Awaited<ReturnType<typeof seedAcceptedResult>>) {
    const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    return owner;
  }

  it("finalizes promptly when a hard kill left the finalizer lease to its dead holder, and stamps the next holder", async () => {
    // Crash point: the finalizer claimed the accepted result (lease written)
    // and the server was killed before it committed. The 5-minute lease must
    // not hold the run `running`; the next boot proves the holder gone.
    const f = await seedAcceptedResult("FINALIZER-THEN-SIGKILL", () => `native-finalizer:${randomUUID()}`);
    await heldBy(f, deadHolder());
    // A claim wakes the ownership worker, which may have gone quiet, so it
    // watches the new holder.
    const ownershipWakes: string[] = [];
    const stop = subscribeDatabaseWork(f.db, DELIVERY_QUEUES.ownershipInvariantReport, (event, hints) => {
      if (event === "settled") ownershipWakes.push(...(hints ?? []));
    });
    const { run, owner } = await restart(f).finally(stop);
    expect(ownershipWakes.some(hint => hint.includes(f.runId))).toBe(true);
    expect({ status: run.status, phase: owner.phase }).toEqual({ status: "succeeded", phase: "committed" });
    // This boot's own finalizer claim recorded itself as the holder of its token,
    // without rewriting the executor's controller identity.
    expect(owner.leaseHolder).toMatchObject({ token: expect.stringMatching(/^native-finalizer:/),
      bootId: currentControllerBootId(), pid: process.pid, hostHash: currentProcessSpaceHash() });
    expect(owner.controllerPid).toBe((await currentNativeControllerIdentity()).pid);
  }, 90_000);

  it.each(["native-finalizer", "native-cleanup"])("settles a dead %s holder in the reconciler pass, never in a read-only pass", async (prefix) => {
    const f = await seedAcceptedResult(`TOKEN-PASS-${prefix}`, () => `${prefix}:${randomUUID()}`);
    await heldBy(f, deadHolder());
    expect(await proofOf(f, prefix)).toEqual({ owner: "process", verdict: "gone", reason: "pid_dead" });
    await runOwnershipReconciliationPass(f.db, { state: createOwnershipReportState(), record: false });
    expect((await leaseOf(f)).leaseExpiresAt).toEqual(f.leaseExpiresAt);
    const pass = await runOwnershipReconciliationPass(f.db, { state: createOwnershipReportState() });
    expect(pass.kinds.find(kind => kind.kind === tokenKindId(prefix))!.settled).toBeGreaterThanOrEqual(1);
    const released = await leaseOf(f);
    expect(released.leaseExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
    // Ownership only: the accepted result and its workspace work are untouched.
    expect({ phase: released.phase, resultId: released.resultId }).toEqual({ phase: "workspace_finalizing",
      resultId: expect.any(String) });
    // An expired lease is free for the next claim and no longer in progress.
    expect(await proofOf(f, prefix)).toBeNull();
  }, 60_000);

  it.each([
    { label: "live earlier-boot holder", proof: { verdict: "alive", reason: "pid_alive" }, holder: async (): Promise<Holder> => ({ bootId: randomUUID(),
      pid: process.pid, hostHash: currentProcessSpaceHash(),
      processStartedAt: (await currentNativeControllerIdentity()).processStartedAt.toISOString() }) },
    { label: "current boot", proof: { verdict: "alive", reason: "current_process" }, holder: async (): Promise<Holder> => ({ bootId: currentControllerBootId(),
      pid: process.pid, hostHash: currentProcessSpaceHash(), processStartedAt: null }) },
    { label: "dead PID in another PID space", proof: { verdict: "unprovable", reason: "different_process_space" }, holder: async () => deadHolder("another-pid-space") },
  ])("keeps a finalizer lease held by a $label", async ({ holder, proof }) => {
    const f = await seedAcceptedResult(`FINALIZER-KEPT-${randomUUID()}`, () => `native-finalizer:${randomUUID()}`);
    await heldBy(f, await holder());
    expect(await proofOf(f, "native-finalizer")).toEqual({ owner: "process", ...proof });
    await runOwnershipReconciliationPass(f.db, { state: createOwnershipReportState() });
    await restart(f);
    expect((await leaseOf(f)).leaseExpiresAt).toEqual(f.leaseExpiresAt);
  }, 60_000);

  it("never lets a later lease inherit an earlier holder, and keeps holderless leases of the previous release", async () => {
    // A holder written for another token names nobody; a row saved by the
    // previous release has none. Both stay token fences until expiry, also on
    // an ephemeral server.
    const f = await seedAcceptedResult("FINALIZER-STALE-HOLDER", () => `native-finalizer:${randomUUID()}`);
    await heldBy(f, deadHolder(), `native-finalizer:${randomUUID()}`);
    const legacy = await seedAcceptedResult("FINALIZER-PREVIOUS-RELEASE", () => `native-finalizer:${randomUUID()}`);
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
    try {
      for (const row of [f, legacy]) {
        expect(await proofOf(row, "native-finalizer")).toEqual({ owner: "fence", verdict: "alive", reason: "fence_held" });
      }
      await runOwnershipReconciliationPass(f.db, { state: createOwnershipReportState() });
    } finally { vi.unstubAllEnvs(); }
    await restart(f);
    expect((await leaseOf(f)).leaseExpiresAt).toEqual(f.leaseExpiresAt);
    expect((await leaseOf(legacy)).leaseExpiresAt).toEqual(legacy.leaseExpiresAt);
  }, 90_000);

  it("settles only the exact lease it proved: a takeover after the proof is kept", async () => {
    const f = await seedAcceptedResult("FINALIZER-TAKEN-OVER", () => `native-finalizer:${randomUUID()}`);
    await heldBy(f, deadHolder());
    const kind = OWNABLE_KINDS.find(candidate => candidate.id === "native_finalizer_lease")!;
    const [record] = await kind.listForRuns!(f.db, [f.runId]);
    const successor = `native-finalizer:${randomUUID()}`;
    await f.db.update(nativeRunFinalizations).set({ leaseOwner: successor,
      leaseHolder: { token: successor, ...deadHolder() } }).where(eq(nativeRunFinalizations.runId, f.runId));
    const outcome = await kind.settle!(f.db, record!, { now: new Date(), proof: { verdict: "gone", reason: "pid_dead" } });
    expect(outcome).toEqual({ settled: false, reason: "owner_changed_since_proof" });
    expect((await leaseOf(f)).leaseExpiresAt).toEqual(f.leaseExpiresAt);
  }, 60_000);
});
