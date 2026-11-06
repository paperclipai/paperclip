import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { authUsers, budgetReservations, companyMemberships, heartbeatRuns, issues, nativeRunFinalizations, workspaceOperations } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "./helpers/native-restart.js";


// RC-14: startup recovery claims a native run and starts its execution. A
// graceful SIGTERM then suspends that claim for the next controller before
// the execution reaches provider dispatch. The dying execution has lost its
// authority, so it must leave the run for the next boot instead of failing it.
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
    // Production binds the completion contract during runtime selection; the
    // shared fixture pre-binds one, which a first selection would not persist.
    await f.db.update(heartbeatRuns).set({ responsibleUserId: userId, completionContractId: null,
      completionContractSha256: null }).where(eq(heartbeatRuns.id, f.runId));
    return f;
  }

  it.each(["before_budget_reservation", "before_dispatch_gate"] as const)(
    "leaves a recovery execution suspended %s for the next controller",
    async (point) => {
      const f = await seedRecoverableRun(`SUSPENDED-${point}`);
      // An overload replacement enforces continuation ownership, which exposes
      // the seam between budget admission and the final dispatch gate.
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

      // The next boot adopts the same run and reaches provider dispatch once.
      // The drained server exits; its controller PID is gone at the next boot.
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
});
