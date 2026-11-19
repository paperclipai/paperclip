import { setImmediate as immediate } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import { workSignalDebug } from "@paperclipai/db/work-signal-debug";
import { ISSUE_RECOVERY_BACKSTOP_MS, ISSUE_RECOVERY_FULL_BACKSTOP_MS, notifyIssueGraphRecovery }
  from "../services/issue-recovery-notifications.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";
import { seedRecoveryPopulation } from "./helpers/recovery-population.js";

vi.hoisted(() => { process.env.PAPERCLIP_DEBUG_WORK_SIGNALS = "stranded-assignments:1,assigned-work-invariant:1"; });

const MINUTE = 60_000;
const TEST_TIMEOUT_MS = 240_000;
const STEP_TIMEOUT_MS = 20_000;
const TOPICS = new Set(["stranded-assignments", "assigned-work-invariant"]);
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
type Recorded = { at: number; topic: string; name: string; fields: Record<string, unknown> };

/** Bounds one step with the real clock, captured before the timers are faked,
 * so a wait that cannot finish fails in seconds and names what it waited for. */
function bounded<T>(work: Promise<T>, waitingFor: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = realSetTimeout(() => reject(new Error(`Timed out after ${STEP_TIMEOUT_MS} ms waiting for ${waitingFor()}`)), STEP_TIMEOUT_MS);
  });
  return Promise.race([work, expired]).finally(() => realClearTimeout(timer));
}

/**
 * Staging shape: about 860 settled assigned tasks, most of them held by the
 * same few agents, and one agent whose native run stays live for the whole
 * window, publishing a run hint every 10 seconds. Nothing about the settled
 * tasks changes, so the recovery queues must not re-check them.
 */
describeIssueRecovery("stranded-task checks beside one long live run (census)", () => {
  const state = issueRecoveryFixture({ meter: true });

  async function advance(ms: number, onTick?: () => Promise<unknown>) {
    const until = Date.now() + ms;
    let nextTick = Date.now();
    while (Date.now() < until) {
      const at = new Date(Date.now()).toISOString();
      if (onTick && Date.now() >= nextTick) {
        await bounded(onTick(), () => `the run event at simulated ${at} to commit`);
        nextTick = Date.now() + 10_000;
      }
      await bounded(vi.advanceTimersByTimeAsync(Math.min(1000, until - Date.now())), () => `simulated time to advance past ${at}`);
      await bounded(Promise.allSettled([...state.passes]), () => `${state.passes.size} delivery passes started by simulated ${at} to settle`);
      await immediate();
    }
  }

  function record() {
    const events: Recorded[] = [];
    vi.spyOn(workSignalDebug, "event").mockImplementation((topic, name, fields = {}) => {
      if (TOPICS.has(topic)) events.push({ at: Date.now(), topic, name, fields });
    });
    vi.spyOn(workSignalDebug, "signal").mockImplementation(topic => { events.push({ at: Date.now(), topic, name: "signal", fields: {} }); });
    return events;
  }

  const checksOf = (events: Recorded[], topic: string) => events.filter(event => event.topic === topic && event.name === "check");
  function summarize(events: Recorded[]) {
    const byWake = (topic: string) => {
      const counts: Record<string, number> = {};
      for (const event of checksOf(events, topic)) counts[String(event.fields.wake)] = (counts[String(event.fields.wake)] ?? 0) + 1;
      return counts;
    };
    return { stranded: checksOf(events, "stranded-assignments").length, assignedWork: checksOf(events, "assigned-work-invariant").length,
      strandedByWake: byWake("stranded-assignments"), assignedWorkByWake: byWake("assigned-work-invariant") };
  }

  async function seed() {
    const f = await state.fixture();
    // 12 agents leave 3 workers, so each holds about 266 of the settled reviews.
    // No agent takes on-demand wakes: a check that repairs a task would start a
    // real run while setTimeout is faked, and that run can wait forever. The
    // census counts queue checks, not runs.
    const population = await seedRecoveryPopulation(state.db, f.companyId,
      { agents: 12, inReview: 800, inProgress: 30, todo: 30, wakeOnDemand: false });
    // Settled long before the window, as on staging. Rows stamped now count as
    // changed for the first backstop after the warm-up, which would re-check
    // every seeded task once.
    const settledAt = new Date(Date.now() - 2 * 60 * MINUTE);
    await state.db.update(issues).set({ createdAt: settledAt, updatedAt: settledAt }).where(eq(issues.companyId, f.companyId));
    await state.db.update(heartbeatRuns).set({ updatedAt: settledAt }).where(eq(heartbeatRuns.companyId, f.companyId));
    await state.db.update(agents).set({ createdAt: settledAt, updatedAt: settledAt }).where(eq(agents.companyId, f.companyId));
    const liveAgentId = population.agentIds[7]!;
    // A settled review until its run starts. An in-progress task with no run
    // is real assigned work, so recovery would start a real run for it while
    // setTimeout is faked, and that run can wait forever.
    const [liveTask] = await state.db.insert(issues).values({ companyId: f.companyId, title: "Live native task", status: "in_review",
      assigneeAgentId: liveAgentId }).returning({ id: issues.id });
    // A paused agent with one waiting task, both settled long before the window.
    // It takes no on-demand wakes, so resuming it never starts a real run.
    const [held] = await state.db.insert(agents).values({ companyId: f.companyId, name: "Held worker", role: "engineer", status: "paused",
      lifecycleHolds: ["manual"], adapterType: "process", reportsTo: population.agentIds[1], createdAt: settledAt, updatedAt: settledAt,
      adapterConfig: { command: process.execPath, args: ["-e", "0"], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: false } } }).returning({ id: agents.id });
    const [waiting] = await state.db.insert(issues).values({ companyId: f.companyId, title: "Waits for its agent", status: "todo",
      assigneeAgentId: held!.id, createdAt: settledAt, updatedAt: settledAt }).returning({ id: issues.id });
    return { ...f, population, liveAgentId, liveTaskId: liveTask!.id, heldAgentId: held!.id, waitingTaskId: waiting!.id };
  }

  async function boot() {
    const f = await bounded(seed(), () => "the fixture to be seeded");
    const events = record();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await bounded(state.start({}), () => "the recovery workers to start");
    await advance(10 * MINUTE);
    events.length = 0;
    return { ...f, events };
  }

  /** What execution start writes (heartbeat.ts): the run, the task's checkout,
   * then the agent's status flip to running without a heartbeat time. */
  async function startLiveRun(f: Awaited<ReturnType<typeof boot>>) {
    const [run] = await state.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.liveAgentId, status: "running",
      runtimeMode: "native", startedAt: new Date(), contextSnapshot: { issueId: f.liveTaskId }, nativeIssueId: f.liveTaskId })
      .returning({ id: heartbeatRuns.id });
    await state.db.update(issues).set({ status: "in_progress", executionRunId: run!.id }).where(eq(issues.id, f.liveTaskId));
    await state.db.update(agents).set({ status: "running", updatedAt: new Date() }).where(eq(agents.id, f.liveAgentId));
    const runId = run!.id;
    return {
      runId,
      /** A run event: the run row moves and its writers publish a run hint. */
      tick: () => state.db.transaction(async tx => {
        await tx.update(heartbeatRuns).set({ updatedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
        await notifyIssueGraphRecovery(tx, { companyId: f.companyId, runId });
      }),
    };
  }

  it("does not re-check the live agent's settled tasks while its run stays live", async () => {
    const f = await boot();
    const live = await bounded(startLiveRun(f), () => "the live run to start");
    let ticks = 0;
    const before = state.meter.read();
    await advance(30 * MINUTE, () => { ticks += 1; return live.tick(); });
    const after = state.meter.read();
    // Each run event publishes one signal to each of the 7 recovery queues; anything above that is the sweep's own.
    const signals = f.events.filter(event => event.name === "signal").length;
    const result = { ...summarize(f.events), statements: after.statements - before.statements, ticks, signals,
      signalsBeyondRunEvents: signals - ticks * 7 };
    console.info(`live-run census (30 min): ${JSON.stringify(result)}`);
    const settled = new Set([...f.population.inReview, ...f.population.inProgress, ...f.population.todo, f.waitingTaskId]);
    const settledChecks = f.events.filter(event => event.name === "check" && settled.has(String(event.fields.issueId)));
    // Before the fix: 534 settled checks and 540 backstop checks. After: 0 and 6 (the live task itself).
    expect(settledChecks.length).toBe(0);
    expect(result.strandedByWake.backstop ?? 0).toBeLessThanOrEqual(10);
    // The live task's own run hints: about one check per run event.
    expect(result.strandedByWake.hint ?? 0).toBeLessThanOrEqual(ticks + 10);
    expect(result.assignedWork).toBeLessThanOrEqual(10);
    expect(result.signalsBeyondRunEvents).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("still checks a task of the live agent within the backstop bound when its own rows change without a hint", async () => {
    const f = await boot();
    const live = await bounded(startLiveRun(f), () => "the live run to start");
    await advance(6 * MINUTE, live.tick);
    f.events.length = 0;
    const target = f.population.inReview.find((_, index) => index % 3 === 0)!;
    const [current] = await state.db.select({ assignee: issues.assigneeAgentId }).from(issues).where(eq(issues.id, target));
    expect(current!.assignee).toBe(f.liveAgentId);
    const changedAt = Date.now();
    // A direct write that sends no hint (for example an edit by an older server).
    await bounded(state.db.update(issues).set({ status: "todo", updatedAt: new Date() }).where(eq(issues.id, target)),
      () => "the direct task write");
    await advance(ISSUE_RECOVERY_BACKSTOP_MS + 2 * MINUTE, live.tick);
    const checked = f.events.find(event => event.topic === "stranded-assignments" && event.name === "check" && event.fields.issueId === target);
    expect(checked).toBeDefined();
    expect(checked!.at - changedAt).toBeLessThanOrEqual(ISSUE_RECOVERY_BACKSTOP_MS + 2 * MINUTE);
  }, TEST_TIMEOUT_MS);

  it("still checks a resumed agent's task within the backstop bound when the resume sends no hint", async () => {
    const f = await boot();
    const live = await bounded(startLiveRun(f), () => "the live run to start");
    await advance(6 * MINUTE, live.tick);
    f.events.length = 0;
    const waiting = f.waitingTaskId;
    const changedAt = Date.now();
    await bounded(state.db.update(agents).set({ status: "idle", lifecycleHolds: [], updatedAt: new Date() })
      .where(eq(agents.id, f.heldAgentId)), () => "the agent resume write");
    await advance(ISSUE_RECOVERY_BACKSTOP_MS + 2 * MINUTE, live.tick);
    const checked = f.events.find(event => event.topic === "stranded-assignments" && event.name === "check" && event.fields.issueId === waiting);
    expect(checked).toBeDefined();
    expect(checked!.at - changedAt).toBeLessThanOrEqual(ISSUE_RECOVERY_BACKSTOP_MS + 2 * MINUTE);
  }, TEST_TIMEOUT_MS);

  it("still re-checks every settled task in the hourly full pass", async () => {
    const f = await boot();
    const live = await bounded(startLiveRun(f), () => "the live run to start");
    await advance(ISSUE_RECOVERY_FULL_BACKSTOP_MS + 5 * MINUTE, live.tick);
    const checked = new Set(checksOf(f.events, "stranded-assignments").map(event => String(event.fields.issueId)));
    const missing = f.population.inReview.filter(id => !checked.has(id));
    expect(missing).toEqual([]);
    const runs = await state.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, f.companyId), sql`${heartbeatRuns.status} = 'running'`));
    expect(runs.map(run => run.id)).toContain(live.runId);
  }, TEST_TIMEOUT_MS);
});
