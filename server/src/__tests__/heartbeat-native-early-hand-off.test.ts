import { and, eq, inArray } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations } from "@paperclipai/db";
import { afterEach, expect, it, vi } from "vitest";
import { heartbeatService } from "../services/heartbeat.js";
import { currentControllerBootId } from "../services/controller-process-identity.js";
import { claimNativeRestartRecoveries, evaluateNativeControllerTakeover } from "../services/native-runtime/native-restart-recovery.js";
import { isRunHandedOffForShutdown } from "../services/heartbeat/shutdown-handoff.js";
import { REMOTE_CONTROLLER_LEASE_MS } from "../services/native-runtime/native-runner-recovery-contract.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "./helpers/native-restart.js";
import { registerReattachPhaseWork, stopReattachWatch } from "../services/heartbeat/reattach-phase.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { isReattachPhaseActive, pendingReattachRunIds, resetReattachPhaseForTests, settleReattachRun, type ReattachPhaseSummary } from "../services/heartbeat/run-admission.js";

describeEmbeddedPostgres("an outgoing server hands live remote runs over at shutdown start", () => {
  const fixture = nativeRestartFixture();
  const timings: Record<number, number> = {};

  async function seedLiveRemoteRuns(label: string, count: number) {
    const seeded = [];
    for (let index = 0; index < count; index += 1) seeded.push(await fixture.seedRun(`${label}-${index}`));
    const db = seeded[0]!.db;
    const runIds = seeded.map(run => run.runId);
    await db.update(nativeRunFinalizations).set({
      leaseOwner: "native-execution:outgoing", leaseExpiresAt: new Date(Date.now() + REMOTE_CONTROLLER_LEASE_MS),
      controllerBootId: currentControllerBootId(), controllerPid: 2_147_000_000, controllerHostHash: "outgoing-container",
      controllerProcessStartedAt: new Date(Date.now() - 600_000),
    }).where(inArray(nativeRunFinalizations.runId, runIds));
    return { db, runIds };
  }

  async function incomingTakeoverReasons(db: Awaited<ReturnType<typeof seedLiveRemoteRuns>>["db"], runIds: string[]) {
    const owners = await db.select().from(nativeRunFinalizations).where(inArray(nativeRunFinalizations.runId, runIds));
    const now = new Date();
    return Promise.all(owners.map(async owner => (await evaluateNativeControllerTakeover({ owner, now, remoteLeaseFenced: true })).reason));
  }

  it.each([1, 20, 40])("releases the remote controller lease of %i live runs at once, so the incoming server may claim them", async (count) => {
    const { db, runIds } = await seedLiveRemoteRuns(`HANDOFF${count}`, count);
    expect(new Set(await incomingTakeoverReasons(db, runIds))).toEqual(new Set(["remote_controller_lease_live"]));
    const outgoing = heartbeatService(db);
    const startedAt = performance.now();
    const handedOff = await outgoing.handOffNativeRunsForShutdown("SIGTERM");
    timings[count] = Math.round(performance.now() - startedAt);
    console.info(`[reattach-first] early hand-off of ${count} live runs: ${timings[count]} ms`);
    expect(handedOff.sort()).toEqual([...runIds].sort());
    expect(new Set(await incomingTakeoverReasons(db, runIds))).toEqual(new Set(["remote_controller_lease_released_or_expired"]));
    const owners = await db.select({ recoveryState: nativeRunFinalizations.recoveryState }).from(nativeRunFinalizations)
      .where(inArray(nativeRunFinalizations.runId, runIds));
    expect(owners.every(owner => owner.recoveryState === "awaiting_runner_reattach")).toBe(true);

    const drained = await outgoing.drainRunningRunsForShutdown("SIGTERM", new Date(), runIds);
    expect(drained.restartSuspendedRunIds.sort()).toEqual([...runIds].sort());
    const suspensions = await db.select({ runId: heartbeatRunEvents.runId }).from(heartbeatRunEvents).where(and(
      inArray(heartbeatRunEvents.runId, runIds), eq(heartbeatRunEvents.eventType, "native.recovery.transition")));
    expect(suspensions).toHaveLength(count);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(inArray(heartbeatRuns.id, runIds));
  }, 300_000);

  it("never lets the outgoing server claim back a run it handed off, while the incoming server may take it over", async () => {
    const { db, runIds } = await seedLiveRemoteRuns("RECLAIM", 1);
    try {
      const outgoing = heartbeatService(db);
      expect(await outgoing.handOffNativeRunsForShutdown("SIGTERM")).toEqual(runIds);
      await db.update(nativeRunFinalizations).set({ controllerPid: process.pid }).where(inArray(nativeRunFinalizations.runId, runIds));
      const outgoingPass = await claimNativeRestartRecoveries({ db, handedOffForShutdown: isRunHandedOffForShutdown, handedOffByThisController: isRunHandedOffForShutdown,
        runIds, restartKind: "graceful" });
      expect(outgoingPass).toEqual([expect.objectContaining({ kind: "blocked", runId: runIds[0], reason: "handed_off_to_next_controller" })]);
      const [owner] = await db.select({ leaseOwner: nativeRunFinalizations.leaseOwner }).from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, runIds[0]!));
      expect(owner?.leaseOwner).toBe("native-execution:outgoing");
      const incomingPass = await claimNativeRestartRecoveries({ db, controller: fixture.current.successor, runIds, restartKind: "graceful" });
      expect(incomingPass).toEqual([expect.not.objectContaining({ reason: "handed_off_to_next_controller" })]);
      expect(await incomingTakeoverReasons(db, runIds)).toEqual(["remote_controller_lease_released_or_expired"]);
    } finally {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(inArray(heartbeatRuns.id, runIds));
    }
  }, 120_000);

  it("leaves a run another server already took over alone", async () => {
    const { db, runIds } = await seedLiveRemoteRuns("TAKEN", 1);
    await db.update(nativeRunFinalizations).set({ controllerBootId: "incoming-boot" })
      .where(inArray(nativeRunFinalizations.runId, runIds));
    expect(await heartbeatService(db).handOffNativeRunsForShutdown("SIGTERM")).not.toContain(runIds[0]);
    expect(await incomingTakeoverReasons(db, runIds)).toEqual(["remote_controller_lease_live"]);
  });

  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;

  afterEach(async () => {
    await stopReattachWatch();
    await coordinator?.stop();
    coordinator = undefined;
    resetReattachPhaseForTests();
  });

  it("holds the incoming server's queued starts only from the hand-over, not while the outgoing server still drives its runs", async () => {
    const { db, runIds } = await seedLiveRemoteRuns("PHASE", 3);
    const ended: ReattachPhaseSummary[] = [];
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => undefined });
    await registerReattachPhaseWork(coordinator, db, { capMs: 60_000, bootId: "incoming-boot", recheckMs: 20,
      onEnd: summary => ended.push(summary) })?.ready;
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(isReattachPhaseActive()).toBe(false);
    const handedOffAt = Date.now();
    expect((await heartbeatService(db).handOffNativeRunsForShutdown("SIGTERM")).sort()).toEqual([...runIds].sort());
    await vi.waitFor(() => expect(pendingReattachRunIds().sort()).toEqual([...runIds].sort()), { timeout: 5_000, interval: 10 });
    expect(isReattachPhaseActive()).toBe(true);
    for (const runId of runIds) settleReattachRun(runId, "reached");
    expect(isReattachPhaseActive()).toBe(false);
    const phase = ended.find(summary => summary.reason === "all_settled")!;
    expect(phase).toMatchObject({ startReason: "handed_over", liveRuns: 3, reached: 3, gatedStarts: true });
    expect(phase.durationMs).toBeLessThan(Date.now() - handedOffAt + 50);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(inArray(heartbeatRuns.id, runIds));
  }, 60_000);
});
