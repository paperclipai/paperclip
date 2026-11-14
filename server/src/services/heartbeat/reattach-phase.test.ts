import type { Db } from "@paperclipai/db";
import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHeartbeatQueueTestDependencies as callbacks } from "../../__tests__/helpers/heartbeat-queue.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatQueue } from "./queue.js";
import {
  closeProcessRunAdmission,
  enableReattachPhase,
  isReattachPhaseActive,
  joinReattachPhase,
  markReattachAuthenticated,
  onReattachPhaseEnd,
  pendingReattachRunIds,
  reattachPhaseRecheckAt,
  refineReattachClaimable,
  resetProcessRunAdmissionForTests,
  resetReattachPhaseForTests,
  settleReattachRun,
  type ClaimableReattachRun,
  type ReattachPhaseSummary,
} from "./run-admission.js";
import {
  claimableReattachRun,
  handOverMoment,
  listLiveRunsOwnedByPreviousControllers,
  noteReattachRunsClaimed,
  REATTACH_PHASE_DEFAULT_CAP_MS,
  reattachPhaseCapMs,
  notifyReattachHandOver,
  registerReattachPhaseWork,
  settleFinishedReattachRuns,
  stopReattachWatch,
} from "./reattach-phase.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { isReattachPhaseActive as gateUsedBySweep } from "./run-admission.js";

const coordinators: ReturnType<typeof createDeliveryWorkCoordinator>[] = [];

async function startReattachPhase(db: Db, options: Parameters<typeof registerReattachPhaseWork>[2]) {
  const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => undefined });
  coordinators.push(coordinator);
  await registerReattachPhaseWork(coordinator, db, options)?.ready;
  return coordinator;
}

afterEach(async () => {
  await stopReattachWatch();
  for (const coordinator of coordinators.splice(0)) await coordinator.stop();
  resetReattachPhaseForTests();
  vi.useRealTimers();
});

function guardedDatabase() {
  const access = vi.fn(() => { throw new Error("Unexpected queue database access"); });
  return { db: new Proxy({}, { get: access }) as Db, access };
}

const handedOver = (runId: string, claimableAt: number): ClaimableReattachRun => ({ runId, reason: "handed_over", claimableAt });

describe("reattach phase signal", () => {
  it("is false when no phase was opened, so a fresh process and every test start runs as before", () => {
    expect(isReattachPhaseActive()).toBe(false);
  });

  it("is never true while nothing is claimable, even with the tracker enabled", () => {
    enableReattachPhase(180_000, 1_000);
    expect(isReattachPhaseActive(1_001)).toBe(false);
    expect(joinReattachPhase([], {}, 1_005)).toEqual([]);
    expect(isReattachPhaseActive(1_006)).toBe(false);
  });

  it("is never true when the tracker is disabled (cap 0, warm standby, scheduler off)", () => {
    expect(joinReattachPhase([handedOver("run", 0)], {}, 0)).toEqual([]);
    expect(isReattachPhaseActive(1)).toBe(false);
  });

  it("stays true until every claimable run is reached or given up, and reports latency from when each became claimable", () => {
    const ended: ReattachPhaseSummary[] = [];
    onReattachPhaseEnd(summary => ended.push(summary));
    enableReattachPhase(180_000, 0);
    joinReattachPhase([handedOver("run-a", 50), handedOver("run-b", 50), handedOver("run-c", 50)], {}, 60);
    settleReattachRun("run-a", "reached", 4_000);
    expect(isReattachPhaseActive(4_001)).toBe(true);
    settleReattachRun("run-unrelated", "reached", 4_500);
    settleReattachRun("run-b", "given_up", 6_000);
    settleReattachRun("run-a", "given_up", 6_500);
    expect(isReattachPhaseActive(6_600)).toBe(true);
    settleReattachRun("run-c", "reached", 9_000);
    expect(isReattachPhaseActive(9_001)).toBe(false);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ reason: "all_settled", startReason: "handed_over", liveRuns: 3, reached: 2, givenUp: 1,
      outstanding: 0, durationMs: 8_950 });
    expect(ended[0].runs).toEqual([
      { runId: "run-a", outcome: "reached", latencyMs: 3_950, authenticatedMs: null },
      { runId: "run-b", outcome: "given_up", latencyMs: 5_950, authenticatedMs: null },
      { runId: "run-c", outcome: "reached", latencyMs: 8_950, authenticatedMs: null },
    ]);
  });

  it("records authentication as a mark, not as reached, and counts runs reached after the 150 s failure threshold", () => {
    const ended: ReattachPhaseSummary[] = [];
    onReattachPhaseEnd(summary => ended.push(summary));
    enableReattachPhase(300_000, 0);
    joinReattachPhase([handedOver("fast", 0), handedOver("slow", 0)], {}, 0);
    markReattachAuthenticated("fast", 2_000);
    markReattachAuthenticated("slow", 3_000);
    expect(isReattachPhaseActive(3_001)).toBe(true);
    settleReattachRun("fast", "reached", 20_000);
    settleReattachRun("slow", "reached", 200_000);
    expect(ended[0]).toMatchObject({ authenticated: 2, reached: 2, reachedAfterThreshold: 1, maxReachLatencyMs: 200_000 });
    expect(ended[0].runs.map(run => run.authenticatedMs)).toEqual([2_000, 3_000]);
  });

  it("moves the cap earlier when a claimed run turns out to have been handed over before its claim", () => {
    enableReattachPhase(1_000, 0);
    joinReattachPhase([{ runId: "claimed", reason: "owner_gone", claimableAt: 10_000 }], { announce: false }, 10_000);
    expect(isReattachPhaseActive(10_900)).toBe(true);
    refineReattachClaimable([handedOver("claimed", 9_200)], 10_100);
    expect(isReattachPhaseActive(10_150)).toBe(true);
    expect(isReattachPhaseActive(10_250)).toBe(false);
  });

  it("ends at the cap, counted from when the runs became claimable, so one wedged Runner cannot hold run starts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ended: ReattachPhaseSummary[] = [];
    onReattachPhaseEnd(summary => ended.push(summary));
    enableReattachPhase(180_000);
    vi.advanceTimersByTime(500_000);
    expect(isReattachPhaseActive()).toBe(false);
    joinReattachPhase([handedOver("wedged", 500_000), handedOver("fine", 500_000)]);
    settleReattachRun("fine", "reached", 502_000);
    expect(isReattachPhaseActive(679_999)).toBe(true);
    vi.advanceTimersByTime(180_000);
    expect(ended).toEqual([expect.objectContaining({ reason: "cap_reached", liveRuns: 2, reached: 1, outstanding: 1, durationMs: 180_000 })]);
    expect(isReattachPhaseActive()).toBe(false);
  });

  it("counts a lease that lapsed before this server started from the server's start, not from the lapse", () => {
    const ended: ReattachPhaseSummary[] = [];
    onReattachPhaseEnd(summary => ended.push(summary));
    enableReattachPhase(180_000, 600_000);
    joinReattachPhase([{ runId: "orphan", reason: "lease_expired", claimableAt: 10_000 }], {}, 600_100);
    expect(isReattachPhaseActive(600_200)).toBe(true);
    settleReattachRun("orphan", "reached", 605_000);
    expect(ended[0]).toMatchObject({ startReason: "lease_expired", maxReachLatencyMs: 5_000 });
  });

  it("re-arms for a later batch with its own cap, and never takes back a run it already reached or gave up", () => {
    const ended: ReattachPhaseSummary[] = [];
    onReattachPhaseEnd(summary => ended.push(summary));
    enableReattachPhase(30_000, 0);
    joinReattachPhase([handedOver("first", 1_000)], {}, 1_000);
    expect(isReattachPhaseActive(30_999)).toBe(true);
    expect(isReattachPhaseActive(31_000)).toBe(false);
    expect(joinReattachPhase([handedOver("first", 40_000)], {}, 40_000)).toEqual([]);
    expect(isReattachPhaseActive(40_001)).toBe(false);
    expect(joinReattachPhase([handedOver("second", 40_000)], {}, 40_000)).toEqual(["second"]);
    expect(isReattachPhaseActive(69_999)).toBe(true);
    settleReattachRun("second", "reached", 41_000);
    expect(ended.map(summary => [summary.reason, summary.runs.map(run => run.runId)])).toEqual([
      ["cap_reached", ["first"]], ["all_settled", ["second"]],
    ]);
  });

  it("extends the cap for runs that join a phase in progress (a hand-over in two steps)", () => {
    enableReattachPhase(30_000, 0);
    joinReattachPhase([handedOver("early", 0)], {}, 0);
    joinReattachPhase([handedOver("late", 20_000)], {}, 20_000);
    settleReattachRun("early", "reached", 21_000);
    expect(isReattachPhaseActive(45_000)).toBe(true);
    expect(isReattachPhaseActive(50_000)).toBe(false);
  });

  it("asks deferred work to come back within the phase, never later than its cap", () => {
    enableReattachPhase(30_000, 0);
    joinReattachPhase([handedOver("run", 0)], {}, 0);
    expect(reattachPhaseRecheckAt(1_000).getTime()).toBe(11_000);
    expect(reattachPhaseRecheckAt(25_000).getTime()).toBe(30_000);
  });

  it("reads its cap from the environment within bounds", () => {
    expect(reattachPhaseCapMs({})).toBe(REATTACH_PHASE_DEFAULT_CAP_MS);
    expect(reattachPhaseCapMs({ PAPERCLIP_REATTACH_PHASE_CAP_MS: "240000" })).toBe(240_000);
    expect(reattachPhaseCapMs({ PAPERCLIP_REATTACH_PHASE_CAP_MS: "10" })).toBe(5_000);
    expect(reattachPhaseCapMs({ PAPERCLIP_REATTACH_PHASE_CAP_MS: "99999999" })).toBe(600_000);
    expect(reattachPhaseCapMs({ PAPERCLIP_REATTACH_PHASE_CAP_MS: "0" })).toBe(0);
    expect(reattachPhaseCapMs({ PAPERCLIP_REATTACH_PHASE_CAP_MS: "soon" })).toBe(REATTACH_PHASE_DEFAULT_CAP_MS);
  });

  it("is the same gate the assigned-work sweep and reconciled continuation delivery read", () => {
    enableReattachPhase(180_000);
    joinReattachPhase([handedOver("run", Date.now())]);
    expect(gateUsedBySweep()).toBe(true);
  });

  it("reads a run as claimable only once its lease was released or has expired, and says why", () => {
    const now = 100_000;
    expect(claimableReattachRun({ runId: "live", leaseExpiresAt: new Date(now + 1), recoveryState: null }, now)).toBeNull();
    expect(claimableReattachRun({ runId: "live", leaseExpiresAt: new Date(now + 1), recoveryState: "awaiting_runner_reattach" }, now)).toBeNull();
    expect(claimableReattachRun({ runId: "h", leaseExpiresAt: new Date(now - 5), recoveryState: "awaiting_runner_reattach" }, now))
      .toEqual({ runId: "h", reason: "handed_over", claimableAt: now - 5 });
    expect(claimableReattachRun({ runId: "e", leaseExpiresAt: new Date(now - 7), recoveryState: null }, now))
      .toEqual({ runId: "e", reason: "lease_expired", claimableAt: now - 7 });
    expect(claimableReattachRun({ runId: "g", leaseExpiresAt: null, recoveryState: null }, now))
      .toEqual({ runId: "g", reason: "owner_gone", claimableAt: now });
  });

  it("finds the previous owner's hand-over behind this server's own recovery entries", () => {
    const history = [
      { at: "2026-11-13T10:00:00.000Z", disposition: "reattach_remote_runner", controllerBootId: "older" },
      { at: "2026-11-13T10:05:00.000Z", disposition: "restart_suspended" },
      { at: "2026-11-13T10:05:00.020Z", disposition: "reattach_remote_runner", controllerBootId: "mine" },
    ];
    expect(handOverMoment(history, "mine")).toBe(Date.parse("2026-11-13T10:05:00.000Z"));
    expect(handOverMoment([history[0], history[2]], "mine")).toBeNull();
    expect(handOverMoment([], "mine")).toBeNull();
  });

  it("ignores claims while the tracker is not running", () => {
    noteReattachRunsClaimed(["run"]);
    expect(isReattachPhaseActive()).toBe(false);
  });
});

describe("queued run starts during the reattach phase", () => {
  it("claimQueuedRun leaves a queued run queued and unstarted, in the admission gate's shape", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    deps.isRunAdmissionClosed = () => false;
    const queue = createHeartbeatQueue(database.db, deps);
    enableReattachPhase(180_000);
    joinReattachPhase([handedOver("live-run", Date.now())]);
    const queued = { id: "run-1", status: "queued" } as Parameters<typeof queue.claimQueuedRun>[0];
    expect(await queue.claimQueuedRun(queued)).toBeNull();
    await queue.startNextQueuedRunForAgent("agent");
    await queue.resumeQueuedRuns();
    expect(database.access).not.toHaveBeenCalled();
    expect(deps.getAgent).not.toHaveBeenCalled();
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it("does not hold a run that is already running (the reattach itself)", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    const queue = createHeartbeatQueue(database.db, deps);
    enableReattachPhase(180_000);
    joinReattachPhase([handedOver("live-run", Date.now())]);
    const running = { id: "live-run", status: "running" } as Parameters<typeof queue.claimQueuedRun>[0];
    expect(await queue.claimQueuedRun(running)).toBe(running);
  });
});

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_QUEUE_TEST_DATABASE_URL");
const support = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping reattach phase database tests: ${support.reason}`);
describe.skipIf(!support.supported)("reattach phase discovery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-reattach-phase");
    db = createDb(external ?? database!.connectionString, { maxConnections: 4 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  async function seed(prefix: string) {
    const [company] = await db.insert(companies).values({ name: `Reattach ${prefix}`, issuePrefix: prefix }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Runner agent", status: "running",
      adapterType: "paperclip_runner", adapterConfig: {} }).returning();
    const run = async (status: "running" | "queued" | "succeeded", finalization?: Partial<typeof nativeRunFinalizations.$inferInsert>) => {
      const [issue] = await db.insert(issues).values({ companyId: company.id, title: `Task ${status}`, status: "in_progress",
        assigneeAgentId: agent.id }).returning();
      const [row] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status,
        runtimeMode: "native", nativeIssueId: issue.id, invocationSource: "assignment", contextSnapshot: { issueId: issue.id } }).returning();
      if (finalization) await db.insert(nativeRunFinalizations).values({ runId: row.id, companyId: company.id, issueId: issue.id,
        phase: "observed", ...finalization });
      return row.id;
    };
    return { run };
  }

  it("lists only live runs another controller owns, and nothing on a fresh or own-only instance", async () => {
    const { run } = await seed("RPA");
    const previous = await run("running", { leaseOwner: "native:old", controllerBootId: "old-boot" });
    const legacy = await run("running", { leaseOwner: "native:legacy", controllerBootId: null });
    await run("running", { leaseOwner: "native:mine", controllerBootId: "this-boot" });
    await run("running", { leaseOwner: "native-finalizer:x", controllerBootId: "old-boot" });
    await run("running", { leaseOwner: null, controllerBootId: "old-boot" });
    await run("running", { leaseOwner: "native:old", controllerBootId: "old-boot", phase: "committed" });
    await run("succeeded", { leaseOwner: "native:old", controllerBootId: "old-boot" });
    await run("queued");
    expect((await listLiveRunsOwnedByPreviousControllers(db, "this-boot")).sort()).toEqual([previous, legacy].sort());
  });

  it("settles runs that finished by any path as given up and keeps live ones pending", async () => {
    const { run } = await seed("RPB");
    const live = await run("running", { leaseOwner: "native:old", controllerBootId: "old-boot-b" });
    const finished = await run("running", { leaseOwner: "native:old", controllerBootId: "old-boot-b" });
    enableReattachPhase(180_000);
    joinReattachPhase([handedOver(live, Date.now()), handedOver(finished, Date.now())]);
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, finished));
    expect(await settleFinishedReattachRuns(db)).toBe(1);
    expect(isReattachPhaseActive()).toBe(true);
    settleReattachRun(live, "reached");
    expect(isReattachPhaseActive()).toBe(false);
  });

  it("starts and ends the phase from the database, calling back once it ends", async () => {
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.status, "running"));
    const ended: ReattachPhaseSummary[] = [];
    await startReattachPhase(db, { capMs: 60_000, bootId: "boot-c", onEnd: summary => ended.push(summary) });
    expect(isReattachPhaseActive()).toBe(false);
    expect(ended).toEqual([expect.objectContaining({ reason: "nothing_to_reattach", gatedStarts: false })]);
    const { run } = await seed("RPC");
    const only = await run("running", { leaseOwner: "native:old", controllerBootId: "old-boot-c" });
    await startReattachPhase(db, { capMs: 60_000, bootId: "boot-c", recheckMs: 50, onEnd: summary => ended.push(summary) });
    expect(isReattachPhaseActive()).toBe(true);
    settleReattachRun(only, "reached");
    expect(isReattachPhaseActive()).toBe(false);
    expect(ended.at(-1)).toMatchObject({ reason: "all_settled", liveRuns: 1, reached: 1, gatedStarts: true });
  });

  describe("timing across a release swap", () => {
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const liveLease = () => ({ leaseOwner: "native-execution:outgoing", controllerBootId: "outgoing-boot",
      leaseExpiresAt: new Date(Date.now() + 60_000) });

    async function retireEarlierRuns() {
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.status, "running"));
    }

    async function handOver(runIds: string[], at = new Date(), options: { awaitJoin?: boolean } = {}) {
      for (const runId of runIds) {
        await db.transaction(async tx => {
          await notifyReattachHandOver(tx, runId);
          await tx.update(nativeRunFinalizations).set({ leaseExpiresAt: at, recoveryState: "awaiting_runner_reattach",
            recoveryHistory: [{ at: at.toISOString(), restartKind: "graceful", disposition: "restart_suspended", reason: "SIGTERM" }] })
            .where(eq(nativeRunFinalizations.runId, runId));
        });
      }
      if (options.awaitJoin === false) return;
      await vi.waitFor(() => expect(runIds.filter(runId => !pendingReattachRunIds().includes(runId))).toEqual([]),
        { timeout: 2_000, interval: 10 });
    }

    async function queuedClaimPassesGate() {
      const database = guardedDatabase();
      const deps = callbacks(database.db);
      deps.isRunAdmissionClosed = () => false;
      const queue = createHeartbeatQueue(database.db, deps);
      const queued = { id: "queued-run", status: "queued" } as Parameters<typeof queue.claimQueuedRun>[0];
      const claimed = await queue.claimQueuedRun(queued).catch((error: Error) => error);
      return database.access.mock.calls.length > 0 || claimed instanceof Error;
    }

    it("does not hold queued starts while the previous owner is alive and not handing over", async () => {
      await retireEarlierRuns();
      const { run } = await seed("RPD");
      await run("running", liveLease());
      await run("running", liveLease());
      const ended: ReattachPhaseSummary[] = [];
      await startReattachPhase(db, { capMs: 200, bootId: "incoming-boot", recheckMs: 20, onEnd: summary => ended.push(summary) });
      expect(isReattachPhaseActive()).toBe(false);
      expect(await queuedClaimPassesGate()).toBe(true);
      await sleep(350);
      expect(isReattachPhaseActive()).toBe(false);
      expect(ended.filter(summary => summary.reason === "cap_reached")).toEqual([]);
    });

    it("closes the gate when the previous owner hands its runs over, and counts reach latency from the hand-over", async () => {
      await retireEarlierRuns();
      const { run } = await seed("RPE");
      const first = await run("running", liveLease());
      const second = await run("running", liveLease());
      const ended: ReattachPhaseSummary[] = [];
      await startReattachPhase(db, { capMs: 60_000, bootId: "incoming-boot", recheckMs: 20, onEnd: summary => ended.push(summary) });
      await sleep(400);
      expect(isReattachPhaseActive()).toBe(false);
      await handOver([first, second]);
      await vi.waitFor(() => expect(isReattachPhaseActive()).toBe(true), { timeout: 2_000, interval: 10 });
      expect(await queuedClaimPassesGate()).toBe(false);
      settleReattachRun(first, "reached");
      expect(isReattachPhaseActive()).toBe(true);
      settleReattachRun(second, "reached");
      expect(isReattachPhaseActive()).toBe(false);
      const phases = ended.filter(summary => summary.reason !== "nothing_to_reattach");
      expect(phases).toEqual([expect.objectContaining({ reason: "all_settled", liveRuns: 2, reached: 2, gatedStarts: true })]);
      expect(phases[0].maxReachLatencyMs).toBeLessThan(350);
      expect(phases[0].durationMs).toBeLessThan(350);
    });

    it("runs the cap from the hand-over, so a wedged run ends the phase without the overlap eating it", async () => {
      await retireEarlierRuns();
      const { run } = await seed("RPF");
      const wedged = await run("running", liveLease());
      const fine = await run("running", liveLease());
      const ended: ReattachPhaseSummary[] = [];
      await startReattachPhase(db, { capMs: 300, bootId: "incoming-boot", recheckMs: 20, onEnd: summary => ended.push(summary) });
      await sleep(450);
      expect(ended.filter(summary => summary.reason === "cap_reached")).toEqual([]);
      await handOver([wedged, fine]);
      await vi.waitFor(() => expect(isReattachPhaseActive()).toBe(true), { timeout: 2_000, interval: 10 });
      settleReattachRun(fine, "reached");
      await vi.waitFor(() => expect(ended.some(summary => summary.reason === "cap_reached")).toBe(true), { timeout: 2_000, interval: 10 });
      const capped = ended.find(summary => summary.reason === "cap_reached")!;
      expect(capped).toMatchObject({ liveRuns: 2, reached: 1, outstanding: 1, gatedStarts: true });
      expect(capped.durationMs).toBeGreaterThanOrEqual(250);
      expect(capped.durationMs).toBeLessThan(450);
      expect(isReattachPhaseActive()).toBe(false);
    });

    it("begins at a killed owner's lease deadline, without any hand-over or notification", async () => {
      await retireEarlierRuns();
      const { run } = await seed("RPG");
      const leaseEndsAt = Date.now() + 400;
      const orphan = await run("running", { ...liveLease(), leaseExpiresAt: new Date(leaseEndsAt) });
      const ended: ReattachPhaseSummary[] = [];
      const coordinator = await startReattachPhase(db, { capMs: 60_000, bootId: "incoming-boot", recheckMs: 20, onEnd: summary => ended.push(summary) });
      expect(coordinator.nextWakeAt()).toBe(leaseEndsAt);
      await sleep(100);
      expect(isReattachPhaseActive()).toBe(false);
      await vi.waitFor(() => expect(isReattachPhaseActive()).toBe(true), { timeout: 2_000, interval: 10 });
      expect(Date.now()).toBeGreaterThanOrEqual(leaseEndsAt);
      settleReattachRun(orphan, "reached");
      expect(ended.filter(summary => summary.reason !== "nothing_to_reattach"))
        .toEqual([expect.objectContaining({ reason: "all_settled", startReason: "lease_expired", liveRuns: 1, reached: 1 })]);
    });

    it("re-arms for a later batch, including runs the previous owner started after discovery", async () => {
      await retireEarlierRuns();
      const { run } = await seed("RPH");
      const early = await run("running", liveLease());
      const ended: ReattachPhaseSummary[] = [];
      let resumes = 0;
      await startReattachPhase(db, { capMs: 60_000, bootId: "incoming-boot", recheckMs: 20,
        onEnd: summary => { ended.push(summary); if (summary.gatedStarts) resumes += 1; } });
      const late = await run("running", liveLease());
      await handOver([early]);
      await vi.waitFor(() => expect(isReattachPhaseActive()).toBe(true), { timeout: 2_000, interval: 10 });
      settleReattachRun(early, "reached");
      expect(isReattachPhaseActive()).toBe(false);
      expect(resumes).toBe(1);
      await sleep(100);
      expect(isReattachPhaseActive()).toBe(false);
      await handOver([late]);
      await vi.waitFor(() => expect(isReattachPhaseActive()).toBe(true), { timeout: 2_000, interval: 10 });
      settleReattachRun(late, "reached");
      expect(isReattachPhaseActive()).toBe(false);
      expect(resumes).toBe(2);
      expect(ended.filter(summary => summary.reason === "all_settled").map(summary => summary.runs.map(entry => entry.runId)))
        .toEqual([[early], [late]]);
    });

    it("closes the gate at once when this server claims a run between two lease reads, dated from the hand-over", async () => {
      await retireEarlierRuns();
      const { run } = await seed("RPJ");
      const claimed = await run("running", liveLease());
      const ended: ReattachPhaseSummary[] = [];
      await startReattachPhase(db, { capMs: 60_000, bootId: "incoming-boot", recheckMs: 60_000, onEnd: summary => ended.push(summary) });
      expect(isReattachPhaseActive()).toBe(false);
      await sleep(60);
      const handedOverAt = new Date(Date.now() - 30);
      await db.update(nativeRunFinalizations).set({ controllerBootId: "incoming-boot", leaseExpiresAt: new Date(Date.now() + 60_000),
        recoveryHistory: [
          { at: handedOverAt.toISOString(), restartKind: "graceful", disposition: "restart_suspended", reason: "SIGTERM" },
          { at: new Date().toISOString(), restartKind: "hard", disposition: "reattach_remote_runner", controllerBootId: "incoming-boot" },
        ] }).where(eq(nativeRunFinalizations.runId, claimed));
      noteReattachRunsClaimed([claimed]);
      expect(isReattachPhaseActive()).toBe(true);
      await sleep(100);
      settleReattachRun(claimed, "reached");
      const phase = ended.find(summary => summary.reason === "all_settled")!;
      expect(phase).toMatchObject({ startReason: "handed_over", liveRuns: 1, reached: 1 });
      expect(phase.maxReachLatencyMs).toBeGreaterThanOrEqual(125);
    });

    it("retries a failed first listing instead of going quiet, and still finds the previous owner's runs", async () => {
      await retireEarlierRuns();
      const { run } = await seed("RPM");
      const lease = liveLease();
      const live = await run("running", lease);
      const select = vi.spyOn(db, "select");
      select.mockImplementationOnce(() => { throw new Error("transient database error"); });
      const coordinator = await startReattachPhase(db, { capMs: 60_000, bootId: "incoming-boot", recheckMs: 20 });
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBe(lease.leaseExpiresAt.getTime()), { timeout: 2_000, interval: 10 });
      await handOver([live]);
      expect(isReattachPhaseActive()).toBe(true);
      select.mockRestore();
      settleReattachRun(live, "reached");
    });

    it("keeps a hand-over notification whose listing failed until a listing succeeds", async () => {
      await retireEarlierRuns();
      const { run } = await seed("RPN");
      const ended: ReattachPhaseSummary[] = [];
      await startReattachPhase(db, { capMs: 60_000, bootId: "incoming-boot", recheckMs: 20, onEnd: summary => ended.push(summary) });
      expect(ended).toEqual([expect.objectContaining({ reason: "nothing_to_reattach" })]);
      const live = await run("running", liveLease());
      const select = vi.spyOn(db, "select");
      select.mockImplementationOnce(() => { throw new Error("transient database error"); });
      await handOver([live]);
      expect(isReattachPhaseActive()).toBe(true);
      select.mockRestore();
      settleReattachRun(live, "reached");
    });

    it("starts the claim of handed-over runs within a second of the hand-over notification", async () => {
      await retireEarlierRuns();
      const { run } = await seed("RPO");
      const first = await run("running", liveLease());
      const second = await run("running", liveLease());
      const claimed: Array<{ runIds: string[]; at: number }> = [];
      await startReattachPhase(db, { capMs: 60_000, bootId: "incoming-boot", recheckMs: 20,
        claim: async runIds => { claimed.push({ runIds, at: Date.now() }); } });
      await sleep(100);
      expect(claimed).toEqual([]);
      const handedOverAt = Date.now();
      await handOver([first, second]);
      expect(claimed.flatMap(entry => entry.runIds).sort()).toEqual([first, second].sort());
      expect(Math.max(...claimed.map(entry => entry.at)) - handedOverAt).toBeLessThan(1_000);
      settleReattachRun(first, "reached");
      settleReattachRun(second, "reached");
    });

    it("keeps an in-flight claim inside the worker's lifetime and starts none once shutdown closed admission", async () => {
      await retireEarlierRuns();
      const { run } = await seed("RPP");
      const first = await run("running", liveLease());
      const second = await run("running", liveLease());
      let finishClaim!: () => void;
      const claims: string[][] = [];
      const coordinator = await startReattachPhase(db, { capMs: 60_000, bootId: "incoming-boot", recheckMs: 20,
        claim: runIds => { claims.push(runIds); return new Promise<void>(resolve => { finishClaim = resolve; }); } });
      await handOver([first]);
      expect(claims).toEqual([[first]]);
      let stopped = false;
      const stopping = coordinator.stop().then(() => { stopped = true; });
      await sleep(100);
      expect(stopped).toBe(false);
      finishClaim();
      await stopping;
      expect(stopped).toBe(true);
      closeProcessRunAdmission();
      try {
        await startReattachPhase(db, { capMs: 60_000, bootId: "incoming-boot", recheckMs: 20,
          claim: async runIds => { claims.push(runIds); } });
        await handOver([second]);
        expect(claims).toEqual([[first]]);
      } finally {
        resetProcessRunAdmissionForTests();
        settleReattachRun(first, "reached");
        settleReattachRun(second, "reached");
      }
    });

    it("does no database work and keeps no deadline on an instance with nothing to reattach", async () => {
      await retireEarlierRuns();
      const select = vi.spyOn(db, "select");
      const coordinator = await startReattachPhase(db, { capMs: 60_000, bootId: "incoming-boot", recheckMs: 20 });
      const startupQueries = select.mock.calls.length;
      expect(coordinator.nextWakeAt()).toBeNull();
      await sleep(200);
      expect(select.mock.calls.length).toBe(startupQueries);
      select.mockRestore();
    });

    it("waits for the hand-over notification or the lease deadline instead of polling while the previous owner drives its runs", async () => {
      await retireEarlierRuns();
      const { run } = await seed("RPK");
      const lease = liveLease();
      const live = await run("running", lease);
      const select = vi.spyOn(db, "select");
      const coordinator = await startReattachPhase(db, { capMs: 60_000, bootId: "incoming-boot", recheckMs: 20 });
      const startupQueries = select.mock.calls.length;
      expect(coordinator.nextWakeAt()).toBe(lease.leaseExpiresAt.getTime());
      await sleep(200);
      expect(select.mock.calls.length).toBe(startupQueries);
      select.mockRestore();
      await handOver([live]);
      await vi.waitFor(() => expect(isReattachPhaseActive()).toBe(true), { timeout: 2_000, interval: 10 });
      settleReattachRun(live, "reached");
      expect(isReattachPhaseActive()).toBe(false);
    });

    it("stops with the delivery coordinator at shutdown and ignores a later hand-over", async () => {
      await retireEarlierRuns();
      const { run } = await seed("RPL");
      const live = await run("running", liveLease());
      const coordinator = await startReattachPhase(db, { capMs: 60_000, bootId: "incoming-boot", recheckMs: 20 });
      await coordinator.stop();
      expect(coordinator.nextWakeAt()).toBeNull();
      await handOver([live], new Date(), { awaitJoin: false });
      await sleep(200);
      expect(isReattachPhaseActive()).toBe(false);
      expect(pendingReattachRunIds()).toEqual([]);
    });

    it("is never true on an instance whose live runs are all its own", async () => {
      await retireEarlierRuns();
      const { run } = await seed("RPI");
      await run("running", { leaseOwner: "native-execution:mine", controllerBootId: "incoming-boot", leaseExpiresAt: new Date(Date.now() - 1) });
      const ended: ReattachPhaseSummary[] = [];
      await startReattachPhase(db, { capMs: 60_000, bootId: "incoming-boot", recheckMs: 20, onEnd: summary => ended.push(summary) });
      expect(isReattachPhaseActive()).toBe(false);
      await sleep(100);
      expect(isReattachPhaseActive()).toBe(false);
      expect(ended).toEqual([expect.objectContaining({ reason: "nothing_to_reattach", gatedStarts: false })]);
    });
  });
});
