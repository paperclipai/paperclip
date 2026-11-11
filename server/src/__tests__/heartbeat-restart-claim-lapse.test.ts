import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { authUsers, companyMemberships, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { releaseLapsedNativeRestartClaim } from "../services/native-runtime/native-execution-lease.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "./helpers/native-restart.js";
import { waitForCondition } from "./helpers/native-restart-fixture.js";

const preparationFault = vi.hoisted(() => ({
  current: null as null | { runId: string; phase: string; act: () => Promise<void> },
}));
vi.mock("../services/heartbeat/preparation-timing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat/preparation-timing.js")>();
  return {
    createHeartbeatPreparationTiming: (runId: string) => {
      const timing = actual.createHeartbeatPreparationTiming(runId);
      return (async (phase, work) => {
        const fault = preparationFault.current;
        if (fault?.runId === runId && fault.phase === phase) {
          preparationFault.current = null;
          await fault.act();
        }
        return timing(phase, work);
      }) as typeof timing;
    },
  };
});

describeEmbeddedPostgres("restart-claim preparation that outlives its claim lease", () => {
  const fixture = nativeRestartFixture();

  it.each(["live lease", "another owner", "newer generation", "other attempt", "run not running", "lapsed own claim"] as const)(
    "releases a restart claim only when it is this exact lapsed claim (%s)", async (variant) => {
      const f = await fixture.seedRun(`RELEASE-${variant.replace(/\W+/g, "-")}`);
      const leaseOwner = `native-recovery:${randomUUID()}`;
      await f.db.update(nativeRunFinalizations).set({ phase: "observed", leaseOwner, controllerGeneration: 3, attempt: 1,
        leaseExpiresAt: new Date(Date.now() + (variant === "live lease" ? 60_000 : -1_000)) })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      if (variant === "run not running") await f.db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.runId));
      const released = await releaseLapsedNativeRestartClaim({ db: f.db, companyId: fixture.current.companyId, runId: f.runId,
        leaseOwner: variant === "another owner" ? `native-recovery:${randomUUID()}` : leaseOwner,
        controllerGeneration: variant === "newer generation" ? 2 : 3, providerAttempt: variant === "other attempt" ? 2 : 1 });
      const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      if (variant === "lapsed own claim") {
        expect(released).toBe(true);
        expect(owner).toMatchObject({ leaseOwner: null, leaseExpiresAt: null, phase: "observed", controllerGeneration: 3 });
        return;
      }
      expect(released).toBe(false);
      expect(owner).toMatchObject({ leaseOwner, phase: "observed", controllerGeneration: 3, attempt: 1 });
    }, 60_000);

  it("hands the run straight back to restart recovery instead of leaving it running unowned", async () => {
    const f = await fixture.seedRun("LAPSED-RESTART-CLAIM");
    await instanceSettingsService(f.db).updateExperimental({ enableNativeRunner: true });
    const userId = randomUUID();
    await f.db.insert(authUsers).values({ id: userId, name: "Operator", email: `${userId}@example.invalid`,
      createdAt: new Date(), updatedAt: new Date() });
    await f.db.insert(companyMemberships).values({ companyId: fixture.current.companyId, principalType: "user",
      principalId: userId, membershipRole: "owner" });
    await f.db.update(heartbeatRuns).set({ responsibleUserId: userId, completionContractId: null,
      completionContractSha256: null }).where(eq(heartbeatRuns.id, f.runId));
    const transitions = async () => (await f.db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.runId, f.runId), eq(heartbeatRunEvents.eventType, "native.recovery.transition")))).length;

    preparationFault.current = { runId: f.runId, phase: "run_output", act: async () => {
      await f.db.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
        || jsonb_build_object('nativeWorkspaceSync', jsonb_build_object('schema', 'paperclip.native-workspace-sync/v3',
          'state', 'prepared', 'descriptorSha256', ${"d".repeat(64)}::text, 'baselineSha256', ${"b".repeat(64)}::text,
          'finalHostSha256', null, 'workspaceId', ${randomUUID()}::text, 'leaseId', ${randomUUID()}::text,
          'providerLeaseId', ${randomUUID()}::text, 'remoteCwd', '/work', 'resourceDisposition', 'destroy'))` })
        .where(eq(heartbeatRuns.id, f.runId));
      await f.db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      throw new Error("Object storage is unavailable");
    } };
    const heartbeat = heartbeatService(f.db, {
      nativeSessionBackendFactory: vi.fn(() => { throw new Error("A lapsed recovery must not open a provider session"); }),
    });
    let before = 0;
    try {
      const { claims } = await heartbeat.recoverNativeRunsAfterRestart(new Date(), [f.runId]);
      expect(claims).toEqual([expect.objectContaining({ runId: f.runId })]);
      before = await transitions();
      await waitForCondition("restart recovery reclaims or blocks the lapsed run", async () => {
        const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
        return await transitions() > before && (owner.controllerGeneration !== claims[0]!.controllerGeneration
          || owner.phase !== "observed" || owner.recoveryState === "blocked");
      }, 15_000);
    } finally {
      preparationFault.current = null;
      await heartbeat.drainActiveRunExecutions();
    }
    expect(await transitions()).toBeGreaterThan(before);
  }, 90_000);
});
