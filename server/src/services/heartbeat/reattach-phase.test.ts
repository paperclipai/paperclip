import type { Db } from "@paperclipai/db";
import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHeartbeatQueueTestDependencies as callbacks } from "../../__tests__/helpers/heartbeat-queue.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatQueue } from "./queue.js";
import {
  isReattachPhaseActive,
  markReattachAuthenticated,
  onReattachPhaseEnd,
  openReattachPhase,
  reattachPhaseRecheckAt,
  resetReattachPhaseForTests,
  settleReattachRun,
  trackReattachRuns,
  type ReattachPhaseSummary,
} from "./run-admission.js";
import {
  listLiveRunsOwnedByPreviousControllers,
  REATTACH_PHASE_DEFAULT_CAP_MS,
  reattachPhaseCapMs,
  settleFinishedReattachRuns,
  startReattachPhase,
} from "./reattach-phase.js";
import { isReattachPhaseActive as gateUsedBySweep } from "./run-admission.js";

afterEach(() => {
  resetReattachPhaseForTests();
  vi.useRealTimers();
});

function guardedDatabase() {
  const access = vi.fn(() => { throw new Error("Unexpected queue database access"); });
  return { db: new Proxy({}, { get: access }) as Db, access };
}

describe("reattach phase signal", () => {
  it("is false when no phase was opened, so a fresh process and every test start runs as before", () => {
    expect(isReattachPhaseActive()).toBe(false);
  });

  it("ends at once when there is nothing to reattach", () => {
    const ended: ReattachPhaseSummary[] = [];
    onReattachPhaseEnd(summary => ended.push(summary));
    openReattachPhase(180_000, 1_000);
    expect(isReattachPhaseActive(1_001)).toBe(true);
    trackReattachRuns([], 1_005);
    expect(isReattachPhaseActive(1_006)).toBe(false);
    expect(ended).toEqual([expect.objectContaining({ reason: "nothing_to_reattach", liveRuns: 0, durationMs: 5, gatedStarts: true })]);
  });

  it("stays true until every live run is reached or given up, and reports each run's latency", () => {
    const ended: ReattachPhaseSummary[] = [];
    onReattachPhaseEnd(summary => ended.push(summary));
    openReattachPhase(180_000, 0);
    trackReattachRuns(["run-a", "run-b", "run-c"], 50);
    settleReattachRun("run-a", "reached", 4_000);
    expect(isReattachPhaseActive(4_001)).toBe(true);
    settleReattachRun("run-unrelated", "reached", 4_500);
    settleReattachRun("run-b", "given_up", 6_000);
    settleReattachRun("run-a", "given_up", 6_500);
    expect(isReattachPhaseActive(6_600)).toBe(true);
    settleReattachRun("run-c", "reached", 9_000);
    expect(isReattachPhaseActive(9_001)).toBe(false);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ reason: "all_settled", liveRuns: 3, reached: 2, givenUp: 1, outstanding: 0, durationMs: 9_000 });
    expect(ended[0].runs).toEqual([
      { runId: "run-a", outcome: "reached", latencyMs: 4_000, authenticatedMs: null },
      { runId: "run-b", outcome: "given_up", latencyMs: 6_000, authenticatedMs: null },
      { runId: "run-c", outcome: "reached", latencyMs: 9_000, authenticatedMs: null },
    ]);
  });

  it("records authentication as a mark, not as reached, and counts runs reached after the 150 s failure threshold", () => {
    const ended: ReattachPhaseSummary[] = [];
    onReattachPhaseEnd(summary => ended.push(summary));
    openReattachPhase(300_000, 0);
    trackReattachRuns(["fast", "slow"], 0);
    markReattachAuthenticated("fast", 2_000);
    markReattachAuthenticated("slow", 3_000);
    expect(isReattachPhaseActive(3_001)).toBe(true);
    settleReattachRun("fast", "reached", 20_000);
    settleReattachRun("slow", "reached", 200_000);
    expect(ended[0]).toMatchObject({ authenticated: 2, reached: 2, reachedAfterThreshold: 1, maxReachLatencyMs: 200_000 });
    expect(ended[0].runs.map(run => run.authenticatedMs)).toEqual([2_000, 3_000]);
  });

  it("ends at the cap so one wedged Runner cannot hold run starts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ended: ReattachPhaseSummary[] = [];
    onReattachPhaseEnd(summary => ended.push(summary));
    openReattachPhase(180_000);
    trackReattachRuns(["wedged", "fine"]);
    settleReattachRun("fine", "reached", 2_000);
    expect(isReattachPhaseActive(179_999)).toBe(true);
    vi.advanceTimersByTime(180_000);
    expect(ended).toEqual([expect.objectContaining({ reason: "cap_reached", liveRuns: 2, reached: 1, outstanding: 1 })]);
    expect(isReattachPhaseActive()).toBe(false);
  });

  it("asks deferred work to come back within the phase, never later than its cap", () => {
    openReattachPhase(30_000, 0);
    trackReattachRuns(["run"], 0);
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
    openReattachPhase(180_000);
    expect(gateUsedBySweep()).toBe(true);
  });
});

describe("queued run starts during the reattach phase", () => {
  it("claimQueuedRun leaves a queued run queued and unstarted, in the admission gate's shape", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    deps.isRunAdmissionClosed = () => false;
    const queue = createHeartbeatQueue(database.db, deps);
    openReattachPhase(180_000);
    trackReattachRuns(["live-run"]);
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
    openReattachPhase(180_000);
    trackReattachRuns(["live-run"]);
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
    openReattachPhase(180_000);
    trackReattachRuns([live, finished]);
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
    await startReattachPhase(db, { capMs: 60_000, bootId: "boot-c", refreshMs: 50, onEnd: summary => ended.push(summary) });
    expect(isReattachPhaseActive()).toBe(true);
    settleReattachRun(only, "reached");
    expect(isReattachPhaseActive()).toBe(false);
    expect(ended.at(-1)).toMatchObject({ reason: "all_settled", liveRuns: 1, reached: 1, gatedStarts: true });
  });
});
