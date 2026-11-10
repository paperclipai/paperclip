import { confirmNativeControllerStopped, requestNativeControllerStopConfirmation } from "../services/native-runtime/native-controller-host-recovery.js";
import { reconcileAbandonedExecutionControl } from "../services/execution-control-reconciliation.js";
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
import { activityLog, agents, createDb, agentWakeupRequests, authUsers, budgetReservations, companyMemberships, completionContracts, environmentLeases, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, workspaceOperations } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { subscribeDatabaseWork } from "@paperclipai/db/work-signals";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { resolveLocalRuntimeApiUrl } from "../runtime-api.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { claimNativeRestartRecoveries, classifyNativeRunnerRecoveryEvidence, currentNativeControllerIdentity } from "../services/native-runtime/native-restart-recovery.js";
import type { NativeSessionBackend } from "@paperclipai/paperclip-runner";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { CONTROL_PLANE_CONFORMANCE_OPEN, CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "./helpers/native-restart.js";
import { currentControllerBootId, currentProcessSpaceHash } from "../services/controller-process-identity.js";
import { createOwnershipReportState, runOwnershipReconciliationPass, settleOwnableKind, type OwnershipReport } from "../services/recovery/ownership-invariant-report.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { reconcileNativeFinalizations, registerOwnershipReconciliationWork } from "../services/native-runtime/native-finalization-reconciler.js";
import { OWNABLE_KINDS } from "../services/recovery/ownership-registry.js";
import { currentProcessProbe, proveOwnerGone } from "../services/owner-proof.js";


describeEmbeddedPostgres("heartbeat native recovery interrupted by graceful shutdown", () => {
  const fixture = nativeRestartFixture();

  async function freshExecutionAgent() {
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [template] = await db.select().from(agents).where(eq(agents.id, fixture.current.agentId));
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId: template.companyId,
      name: "Isolated useful recovery execution", role: template.role, status: "active",
      adapterType: template.adapterType, adapterConfig: template.adapterConfig,
      runtimeConfig: template.runtimeConfig, permissions: template.permissions });
    return { db, agentId };
  }

  async function seedRecoverableRun(label: string, isolatedAgent = false) {
    const isolated = isolatedAgent ? await freshExecutionAgent() : undefined;
    const f = await fixture.seedRun(label, isolated?.db, { agentId: isolated?.agentId });
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
      await next.recoverNativeRunsAfterRestart(new Date(), [f.runId]);
      await reconcileNativeFinalizations(f.db, [f.runId]);
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
      ...(Object.hasOwn(controller, "hostHash") ? { controllerHostHash: controller.hostHash ?? null } : {}) })
      .where(eq(nativeRunFinalizations.runId, f.runId));
  }
  function acceptedRunKinds(f: Awaited<ReturnType<typeof seedAcceptedResult>>) {
    const kind = OWNABLE_KINDS.find(candidate => candidate.id === "native_accepted_result_lease");
    if (!kind?.listForRuns) throw new Error("Native accepted-result run listing required");
    const listForRuns = kind.listForRuns;
    return [{ ...kind, listInProgress: async (db: typeof f.db) => ({
      records: await listForRuns(db, [f.runId]), truncated: false,
    }) }];
  }

  async function restart(f: Awaited<ReturnType<typeof seedAcceptedResult>>) {
    const providerDispatch = vi.fn(() => { throw new Error("an accepted result must not open another provider turn"); });
    const next = heartbeatService(f.db, { nativeSessionBackendFactory: providerDispatch });
    try {
      await next.recoverNativeRunsAfterRestart(new Date(), [f.runId]);
      await reconcileNativeFinalizations(f.db, [f.runId]);
    } finally { await next.drainActiveRunExecutions(); }
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

  it("keeps an unexpired accepted-result executor lease without process-space proof", async () => {
    const f = await seedAcceptedResult("ACCEPTED-UNPROVEN-PROCESS-SPACE", runner => `${runner}:${randomUUID()}`);
    await killedController(f, { bootId: randomUUID(), pid: 2_000_000_001,
      processStartedAt: new Date(Date.now() - 60_000) });
    await f.db.update(nativeRunFinalizations).set({ controllerHostHash: null })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    const [before] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(before.controllerHostHash).toBeNull();
    const now = new Date();
    expect(before.leaseExpiresAt?.getTime()).toBeGreaterThan(now.getTime());
    expect(before).toMatchObject({ phase: "workspace_finalizing", resultId: expect.any(String) });
    const isProcessAlive = vi.fn(() => false);
    const readProcessStartedAt = vi.fn(async () => null);
    const released = await settleOwnableKind(f.db, "native_accepted_result_lease", {
      now, runIds: [f.runId], probe: { ...currentProcessProbe(), deployment: null, controllerInstance: undefined, pidExists: isProcessAlive, readStartedAt: readProcessStartedAt },
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
    const [before] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const isProcessAlive = vi.fn(() => false), readProcessStartedAt = vi.fn(async () => null);
      expect(await settleOwnableKind(f.db, "native_accepted_result_lease", { now: new Date(), runIds: [f.runId], probe: { ...currentProcessProbe(), processSpace: mode === "unknown-current" ? "unknown" : actual.hostHash, deployment: null, controllerInstance: undefined, pidExists: isProcessAlive, readStartedAt: readProcessStartedAt } })).toEqual([]);
      expect(isProcessAlive).not.toHaveBeenCalled();
      expect(readProcessStartedAt).not.toHaveBeenCalled();
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
        .toMatchObject({ leaseOwner: before.leaseOwner, leaseExpiresAt: before.leaseExpiresAt, controllerHostHash: before.controllerHostHash });
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
    expect(await settleOwnableKind(f.db, "native_accepted_result_lease", { now, runIds: [f.runId], probe: { ...currentProcessProbe(), deployment: null, controllerInstance: undefined, pidExists: isProcessAlive, readStartedAt: readProcessStartedAt } }))
      .toEqual([{ kind: "native_accepted_result_lease", recordId: f.runId, runId: f.runId,
        reason: mode === "dead" ? "pid_dead" : "pid_reused" }]);
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
    expect(await settleOwnableKind(f.db, "native_accepted_result_lease", { now: new Date(), runIds: [f.runId], probe: { ...currentProcessProbe(), deployment: null, controllerInstance: undefined, pidExists: isProcessAlive, readStartedAt: readProcessStartedAt } })).toEqual([]);
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
    expect(await settleOwnableKind(f.db, "native_accepted_result_lease", { now: new Date(), runIds: [f.runId],
      probe: { ...currentProcessProbe(), deployment: null, controllerInstance: undefined,
        pidExists: () => true, readStartedAt: readProcessStartedAt } })).toEqual([]);
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
    expect(await settleOwnableKind(f.db, "native_accepted_result_lease", { now: new Date(), runIds: [f.runId], probe: { ...currentProcessProbe(), deployment: null, controllerInstance: undefined, pidExists: isProcessAlive, readStartedAt: readProcessStartedAt },
      skipRunIds: { has: runId => exclusion === "live-owner" && runId === f.runId } })).toEqual([]);
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
    expect(await settleOwnableKind(f.db, "native_accepted_result_lease", { now: new Date(), runIds: [f.runId], probe: { ...currentProcessProbe(), deployment: null, controllerInstance: undefined, pidExists: isProcessAlive, readStartedAt: readProcessStartedAt } })).toEqual([]);
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
    async function seedClaim(label: string, expires: "live" | "expired", hash: string | null, isolatedAgent = false) {
      const f = await seedRecoverableRun(label, isolatedAgent);
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
      const unknown = mode === "unknown-current" ? vi.spyOn(controllerProcess, "currentProcessSpaceHash")
        .mockReturnValue("unknown") : null;
      const probe = observeOwnerPid();
      const onClaim = vi.fn();
      try {
        const dispositions = await claimNativeRestartRecoveries({ db: f.db, restartKind: "hard", runIds: [f.runId], onClaim });
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

    it("keeps a real controller-only attestation from authorizing an in-flight claim", async () => {
      const f = await seedClaim("CLAIM-CONTROLLER-ONLY", "expired", "foreign-process-space");
      const [before] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      await requestNativeControllerStopConfirmation(f.db, before);
      const [action] = await f.db.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.sourceIssueId, f.issueId), eq(issueRecoveryActions.status, "active")));
      expect(action.cause).toBe("native_controller_host_unverified");
      await expect(confirmNativeControllerStopped({ db: f.db, companyId: fixture.current.companyId,
        issueId: f.issueId, runId: f.runId, actionId: action.id, actorId: "board-user",
        stopEvidence: "The original controller stopped; provider effects have not been contained." }))
        .resolves.toEqual({ runId: f.runId, status: "queued" });
      const probe = observeOwnerPid(), onClaim = vi.fn();
      try {
        expect(await claimNativeRestartRecoveries({ db: f.db, restartKind: "hard", runIds: [f.runId], onClaim }))
          .toEqual([{ kind: "awaiting_evidence", runId: f.runId, reason: "controller_process_space_unverified" }]);
        expect(probe.observed).toEqual([]);
        expect(onClaim).not.toHaveBeenCalled();
        const [after] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
        expect(after).toMatchObject({ leaseOwner: before.leaseOwner, leaseExpiresAt: before.leaseExpiresAt,
          controllerGeneration: before.controllerGeneration, attempt: before.attempt, resultId: null,
          controllerHostHash: "operator_attested" });
        expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
          .toMatchObject({ status: "running", resultJson: null });
        expect(await f.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId))).toEqual([]);
      } finally { probe.restore(); }
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

    async function namespaceHold(label: string, live = false, isolatedAgent = false) {
      const f = await seedClaim(label, live ? "live" : "expired", "foreign-process-space", isolatedAgent);
      const [source] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      if (!source.responsibleUserId) throw new Error("A genuine responsible operator is required");
      await f.db.update(issues).set({ responsibleUserId: source.responsibleUserId }).where(eq(issues.id, f.issueId));
      await claimNativeRestartRecoveries({ db: f.db, restartKind: "hard", runIds: [f.runId] });
      const [action] = await f.db.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, fixture.current.companyId), eq(issueRecoveryActions.sourceIssueId, f.issueId),
        eq(issueRecoveryActions.status, "active")));
      const authority = action?.evidence.controllerAuthority;
      if (!authority || typeof authority !== "object" || Array.isArray(authority)
        || !("digest" in authority) || typeof authority.digest !== "string") throw new Error("Expected exact server-owned controller authority");
      return { ...f, action, digest: authority.digest, userId: source.responsibleUserId };
    }
    function boardRoutes(f: Pick<Awaited<ReturnType<typeof namespaceHold>>, "db" | "userId">, actor?: Express.Request["actor"]) {
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
        .send({ ...body, sourceIssueStatus: "todo", executionReconciliation: providerOnly });
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

    async function completeContainedRetry(f: Awaited<ReturnType<typeof namespaceHold>>) {
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
        const [currentTask] = await f.db.select().from(issues).where(eq(issues.id, f.issueId));
        const response = await request(app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
          .send({ ...confirmation(f), sourceIssueStatus: currentTask.status });
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
        expect(old).toMatchObject(before.status === "running"
          ? { status: "coalesced", runId: f.runId }
          : { status: "skipped", runId: null, error: "controller_containment_requires_new_retry" });
        expect(opened).toEqual([]);
        expect(await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, f.issueId))).toHaveLength(1);
        const retried = await request(app).post(`/api/issues/${f.issueId}/retry`).send({ observedRunId: f.runId, idempotencyKey: randomUUID() });
        expect(retried.status, JSON.stringify(retried.body)).toBe(202);
        expect(retried.body.requestId).not.toBe(oldClick.requestId);
        await waitForCondition("normal explicit Retry terminal successor and wakes to settle", async () => {
          const [wake] = await f.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, retried.body.requestId));
          if (!wake?.runId || wake.runId === f.runId) return false;
          const [successor] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId));
          return !!successor?.finishedAt
            && ["succeeded", "interrupted", "failed", "cancelled", "timed_out"].includes(successor.status)
            && services.every(service => service.getTaskDrainStatus().quiescent);
        });
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
    }

    it("records original-host containment then completes one useful successor only after a new ordinary Retry", async () => {
      await completeContainedRetry(await namespaceHold("CLAIM-CONTAINMENT-ORDINARY-RETRY", false, true));
    }, 90_000);

    /** Historical INITIAL fixture, not a failed execution manufactured by the
     * tested owners. Preparation produced the normal contract/profile; these
     * are the complete persisted abandoned-source facts at journey start:
     * failed+finished, setup_failed, no result/usage added, cleared issue and
     * checkout pointers, same assignee/responsible operator, observed resultless
     * expired foreign claim with its original token/generation/PID/birth. */
    async function seedHistoricalFailedForeignSource(label: string, isolatedAgent = false) {
      const f = await seedClaim(label, "expired", "foreign-process-space", isolatedAgent);
      const [source] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      if (!source.responsibleUserId) throw new Error("A genuine responsible operator is required");
      await f.db.transaction(async tx => {
        await tx.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), errorCode: "setup_failed",
          error: "Historical pre-executor failure with retained foreign ownership", controllerLeaseExpiresAt: null })
          .where(eq(heartbeatRuns.id, f.runId));
        await tx.update(issues).set({ executionRunId: null, checkoutRunId: null, responsibleUserId: source.responsibleUserId })
          .where(eq(issues.id, f.issueId));
      });
      const [initialRun] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const [initialOwner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      const [initialTask] = await f.db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(initialRun).toMatchObject({ status: "failed", errorCode: "setup_failed", usageJson: source.usageJson });
      expect(initialRun.finishedAt).not.toBeNull();
      expect(initialOwner).toMatchObject({ phase: "observed", resultId: null, controllerHostHash: "foreign-process-space" });
      expect(initialOwner.leaseOwner).not.toBeNull();
      expect(initialOwner.leaseExpiresAt!.getTime()).toBeLessThan(Date.now());
      expect(initialTask).toMatchObject({ executionRunId: null, checkoutRunId: null, assigneeAgentId: initialRun.agentId });
      expect(await f.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId))).toEqual([]);
      return { ...f, userId: source.responsibleUserId, initialRun, initialOwner, initialTask };
    }

    async function inspectHistoricalFailedSource(f: Awaited<ReturnType<typeof seedHistoricalFailedForeignSource>>) {
      // Actual normal startup/mutation finalization duty. No status, token,
      // lease, provider result or usage is rewritten by this fixture now.
      const inspected = await reconcileAbandonedExecutionControl(f.db);
      expect(inspected.releasedOwners).toBe(0);
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(f.initialOwner);
      const [action] = await f.db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
        eq(issueRecoveryActions.status, "active")));
      const authority = action?.evidence.controllerAuthority;
      if (!authority || typeof authority !== "object" || Array.isArray(authority)
        || !("digest" in authority) || typeof authority.digest !== "string")
        throw new Error("Normal historical failed-owner inspection must publish exact containment authority");
      return { ...f, action, digest: authority.digest };
    }

    it("contains a historical already-failed foreign source with cleared pointer then completes a new ordinary Retry", async () => {
      const initial = await seedHistoricalFailedForeignSource("CLAIM-HISTORICAL-FAILED-CLEARED-RETRY", true);
      // The journey begins after the declared INITIAL state above exists.
      await completeContainedRetry(await inspectHistoricalFailedSource(initial));
    }, 90_000);

    it("rejects cleared-pointer containment when a newer canonical Native coordinator binds the issue", async () => {
      const f = await inspectHistoricalFailedSource(await seedHistoricalFailedForeignSource("CLAIM-CONTAINMENT-NEWER-COORDINATOR"));
      const [before] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      const newerId = randomUUID();
      await f.db.insert(heartbeatRuns).values({ id: newerId, companyId: fixture.current.companyId,
        agentId: fixture.current.agentId, status: "queued", runtimeMode: "native", contextSnapshot: { issueId: f.issueId }, nativeIssueId: f.issueId });
      await f.db.insert(nativeRunFinalizations).values({ runId: newerId, companyId: fixture.current.companyId,
        issueId: f.issueId, phase: "observed", attempt: 0 });
      const [currentTask] = await f.db.select().from(issues).where(eq(issues.id, f.issueId));
      const response = await request(boardRoutes(f)).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
        .send({ ...confirmation(f), sourceIssueStatus: currentTask.status });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(before);
      expect((await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id)))[0].status).toBe("active");
      expect(await f.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId))).toEqual([]);
    }, 90_000);

    it("automatically completes one useful successor after a first-admission preparation failure without containment", async () => {
      const isolated = await freshExecutionAgent();
      const userId = randomUUID();
      await isolated.db.insert(authUsers).values({ id: userId, name: "Operator", email: `${userId}@example.invalid`,
        createdAt: new Date(), updatedAt: new Date() });
      await isolated.db.insert(companyMemberships).values({ companyId: fixture.current.companyId,
        principalType: "user", principalId: userId, membershipRole: "owner" });
      await instanceSettingsService(isolated.db).updateExperimental({ enableNativeRunner: true });
      const [task] = await isolated.db.insert(issues).values({ companyId: fixture.current.companyId,
        title: "Recover a genuine first preparation failure", status: "in_progress", workMode: "standard",
        assigneeAgentId: isolated.agentId, responsibleUserId: userId }).returning();
      const opened: string[] = [];
      const backend = vi.fn(retryBackend(isolated.db, opened));
      let failedPreparationRunId: string | null = null;
      const service = heartbeatService(isolated.db, { nativeSessionBackendFactory: backend,
        beforeNativeRuntimeSelection: async runId => {
          // A single dependency failure belongs to the original admission. The
          // normal automatic successor must use the real controlled SDK backend.
          if (failedPreparationRunId !== null) return;
          failedPreparationRunId = runId;
          expect(await isolated.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId))).toEqual([]);
          throw new Error("Controlled first-admission preparation failure before native selection and provider dispatch");
        } });
      try {
        const admitted = await service.wakeup(isolated.agentId, { source: "on_demand", triggerDetail: "manual",
          reason: "issue_assigned", requestedByActorType: "user", requestedByActorId: userId, manualUserWake: true,
          payload: { issueId: task.id }, contextSnapshot: { issueId: task.id, actorId: userId, responsibleUserId: userId } });
        expect(admitted).not.toBeNull();
        await waitForCondition("normal automatic preparation-recovery terminal successor and wakes to settle", async () => {
          const successors = await isolated.db.select().from(heartbeatRuns).where(and(
            eq(heartbeatRuns.companyId, fixture.current.companyId), eq(heartbeatRuns.agentId, isolated.agentId),
            eq(heartbeatRuns.retryOfRunId, admitted!.id)));
          return successors.length === 1 && !!successors[0].finishedAt
            && ["succeeded", "interrupted", "failed", "cancelled", "timed_out"].includes(successors[0].status)
            && service.getTaskDrainStatus().quiescent;
        });
        expect(failedPreparationRunId).toBe(admitted!.id);
        const [source] = await isolated.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, admitted!.id));
        expect(source).toMatchObject({ status: "failed", responsibleUserId: userId, processPid: null });
        expect(source.resultJson?.executionRecovery).toMatchObject({ kind: "bootstrap", providerWorkStarted: false });
        expect(await isolated.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, source.id))).toEqual([]);
        const successors = await isolated.db.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, fixture.current.companyId), eq(heartbeatRuns.agentId, isolated.agentId),
          eq(heartbeatRuns.retryOfRunId, source.id)));
        expect(successors).toHaveLength(1);
        const successor = successors[0];
        expect(successor).toMatchObject({ status: "succeeded", retryOfRunId: source.id,
          responsibleUserId: userId, nativeIssueId: task.id });
        expect(successor.id).not.toBe(source.id);
        expect(opened).toEqual([successor.id]);
        expect(backend.mock.calls.map(([execution]) => execution.binding.runId)).not.toContain(source.id);
        expect(successor.resultJson?.nativeResult).toMatchObject({ summary: "The explicitly retried task produced this useful completion." });
        const wakes = await isolated.db.select().from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, fixture.current.companyId), eq(agentWakeupRequests.runId, successor.id),
          eq(agentWakeupRequests.reason, "issue_continuation_needed")));
        expect(wakes).toHaveLength(1);
        expect((await isolated.db.select().from(issues).where(eq(issues.id, task.id)))[0].status).toBe("done");
        expect(await isolated.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, source.id))).toEqual([]);
        expect(await isolated.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, successor.id))).toHaveLength(1);
        const actions = await isolated.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, task.id));
        expect(actions.every(action => action.evidence.reason !== "controller_process_space_unverified"
          && action.evidence.controllerAuthority === undefined)).toBe(true);
      } finally { await service.drainActiveRunExecutions(); }
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

    it.each([false, true] as const)("keeps a correlated Stop from automatically releasing foreign ownership (ephemeral: %s)", async ephemeral => {
      const previous = process.env.PAPERCLIP_EPHEMERAL_SERVER;
      if (ephemeral) process.env.PAPERCLIP_EPHEMERAL_SERVER = "true";
      else delete process.env.PAPERCLIP_EPHEMERAL_SERVER;
      try {
        const f = await namespaceHold(`CLAIM-CONTAINMENT-STOP-${ephemeral}`);
        const [before] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
        const requestId = randomUUID();
        await claimCancellationRequest(f.db, f.runId, fixture.current.companyId, requestId, f.userId);
        const cancellation = cancelHeartbeatNativeRun({ db: f.db, runId: f.runId, reason: "Operator requested Stop",
          runtimeMode: "native", cancellationRequestId: requestId });
        if (ephemeral) {
          // The actual frontend waits its existing20s for the real owner's ACK;
          // this isolated foreign-owner fixture has no local delivery handle.
          await expect(cancellation).rejects.toThrow("native_cancellation_pending_recovery");
        } else {
          const acknowledgement = await cancellation;
          expect(acknowledgement).toMatchObject({ dispatched: false });
          expect(acknowledgement.auditId).toEqual(expect.any(String));
        }
        const [pending] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
        expect(pending.status).toBe("running");
        expect(pending.resultJson?.startupCancellation).toMatchObject({ cancellationRequestId: requestId,
          requestedBy: { type: "board", userId: f.userId } });
        const intent = pending.resultJson?.nativeCancellation;
        expect(intent).toMatchObject({ dispatchState: ephemeral ? "pending" : "acknowledged", dispatched: false });
        if (!intent || typeof intent !== "object" || Array.isArray(intent) || !("intentAuditId" in intent))
          throw new Error("The normal cancellation owner must persist an audited intent");
        expect(intent.intentAuditId).toEqual(expect.any(String));
        if (!ephemeral) {
          if (!("acknowledgementAuditId" in intent)) throw new Error("The local no-op acknowledgement must have its own audit");
          expect(intent.acknowledgementAuditId).toEqual(expect.any(String));
          expect(intent.acknowledgementAuditId).not.toBe(intent.intentAuditId);
        }
        if (ephemeral) {
          const response = await request(boardRoutes(f)).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(confirmation(f));
          expect(response.status, JSON.stringify(response.body)).toBe(409);
        }
        expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(before);
        expect((await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id)))[0].status).toBe("active");
      } finally {
        if (previous === undefined) delete process.env.PAPERCLIP_EPHEMERAL_SERVER;
        else process.env.PAPERCLIP_EPHEMERAL_SERVER = previous;
      }
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
      const unreadable = vi.spyOn(controllerProcess, "currentProcessSpaceHash").mockReturnValue("unknown");
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

  it("keeps an accepted Native result without a recorded PID space out of the generic single-host fallback", async () => {
    const f = await seedAcceptedResult("ACCEPTED-LEGACY-DEAD", (runner) => `${runner}:${randomUUID()}`);
    await killedController(f, deadController(null));
    const { run, owner } = await restart(f);
    expect({ status: run.status, phase: owner.phase, leaseExpiresAt: owner.leaseExpiresAt })
      .toEqual({ status: "running", phase: "workspace_finalizing", leaseExpiresAt: f.leaseExpiresAt });
    expect(await legacyProofs(f)).toHaveLength(0);
    expect(await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))
      .toEqual([expect.objectContaining({ cause: "native_controller_host_unverified", status: "active" })]);
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
      const report = await runOwnershipReconciliationPass(f.db, { kinds: acceptedRunKinds(f), state: createOwnershipReportState() });
      expect(report.kinds.find(kind => kind.kind === "native_accepted_result_lease"))
        .toMatchObject({ settled: 0, reasons: { process_space_unrecorded: 1 } });
    } finally { vi.unstubAllEnvs(); }
    const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(owner.leaseExpiresAt).toEqual(f.leaseExpiresAt);
    const actions = await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(actions.map(action => [action.cause, action.ownerType, action.status]))
      .toEqual([["native_controller_host_unverified", "board", "active"]]);
  }, 60_000);

  it("finalizes the accepted result after the board confirms its actual unrecorded-controller action", async () => {
    const f = await seedAcceptedResult("ACCEPTED-OPERATOR-ATTESTED", (runner) => `${runner}:${randomUUID()}`);
    await killedController(f, deadController(null));
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
    try {
      const [before] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      const report = await runOwnershipReconciliationPass(f.db, { kinds: acceptedRunKinds(f), state: createOwnershipReportState() });
      expect(report.kinds.find(kind => kind.kind === "native_accepted_result_lease"))
        .toMatchObject({ settled: 0, reasons: { process_space_unrecorded: 1 } });
      const [action] = await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      expect(action).toMatchObject({ cause: "native_controller_host_unverified", status: "active" });
      await expect(confirmNativeControllerStopped({ db: f.db, companyId: fixture.current.companyId,
        issueId: f.issueId, runId: f.runId, actionId: action.id, actorId: "board-user",
        stopEvidence: "The original server container is stopped; the accepted provider result is retained." }))
        .resolves.toEqual({ runId: f.runId, status: "queued" });
      const [attested] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(attested).toMatchObject({ phase: before.phase, resultId: before.resultId, leaseOwner: before.leaseOwner,
        leaseExpiresAt: before.leaseExpiresAt, controllerGeneration: before.controllerGeneration,
        attempt: before.attempt, controllerHostHash: "operator_attested" });
      expect(await f.db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
        eq(issueRecoveryActions.status, "active")))).toEqual([]);
      const { run, owner } = await restart(f);
      expect({ status: run.status, phase: owner.phase, resultId: owner.resultId })
        .toEqual({ status: "succeeded", phase: "committed", resultId: before.resultId });
      const second = await restart(f);
      expect(second.owner.resultId).toBe(before.resultId);
      expect(await f.db.select({ id: nativeRunResults.id }).from(nativeRunResults)
        .where(eq(nativeRunResults.runId, f.runId))).toHaveLength(1);
      expect(await f.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.nativeIssueId, f.issueId))).toHaveLength(1);
      expect((await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0])
        .toMatchObject({ status: "resolved", outcome: "restored" });
    } finally { vi.unstubAllEnvs(); }
  }, 90_000);

  it("settles a dead controller's result lease in the reconciler pass when restart recovery missed it", async () => {
    // Crash point: the controller died after the result was accepted and the
    // lease written, and this boot's restart sweep did not see it (it started
    // before the row, or failed). The next reconciler pass settles it.
    const f = await seedAcceptedResult("ACCEPTED-RECONCILER-PASS", (runner) => `${runner}:${randomUUID()}`);
    await killedController(f, deadController(currentProcessSpaceHash()));
    const readOnly = await runOwnershipReconciliationPass(f.db, { kinds: acceptedRunKinds(f), state: createOwnershipReportState(), record: false });
    expect(readOnly.kinds.find(kind => kind.kind === "native_accepted_result_lease"))
      .toMatchObject({ settled: 0, verdicts: { gone: 1 } });
    const [held] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(held.leaseExpiresAt).toEqual(f.leaseExpiresAt);
    const state = createOwnershipReportState();
    const first = await runOwnershipReconciliationPass(f.db, { kinds: acceptedRunKinds(f), state });
    expect(first.kinds.find(kind => kind.kind === "native_accepted_result_lease")).toMatchObject({ settled: 1 });
    const [released] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(released.leaseExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
    // Settled records are no longer in progress, so rule I2 never fires.
    const second = await runOwnershipReconciliationPass(f.db, { kinds: acceptedRunKinds(f), state });
    expect(second.violations.filter(violation => violation.kind === "native_accepted_result_lease")).toEqual([]);
  }, 60_000);

  it("keeps a live earlier-boot controller's result lease in the reconciler pass", async () => {
    const f = await seedAcceptedResult("ACCEPTED-RECONCILER-LIVE", (runner) => `${runner}:${randomUUID()}`);
    const self = await currentNativeControllerIdentity();
    await killedController(f, { bootId: randomUUID(), pid: process.pid, processStartedAt: self.processStartedAt,
      hostHash: currentProcessSpaceHash() });
    const report = await runOwnershipReconciliationPass(f.db, { kinds: acceptedRunKinds(f), state: createOwnershipReportState() });
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
      await runOwnershipReconciliationPass(f.db, { kinds: acceptedRunKinds(f), state: createOwnershipReportState() });
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
