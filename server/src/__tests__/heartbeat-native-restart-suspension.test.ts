import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { authUsers, budgetReservations, companyMemberships, completionContracts, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, workspaceOperations } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { currentNativeControllerIdentity } from "../services/native-runtime/native-restart-recovery.js";
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
    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.status).toBe("running");
  }, 60_000);
});
