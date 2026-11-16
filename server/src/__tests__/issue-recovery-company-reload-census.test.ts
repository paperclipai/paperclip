import { setImmediate as immediate } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, costEvents, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { workSignalDebug } from "@paperclipai/db/work-signal-debug";
import { reconcileDatabaseWorkNotifications } from "@paperclipai/db/work-signals";
import { ISSUE_RECOVERY_BACKSTOP_MS, notifyIssueGraphRecovery } from "../services/issue-recovery-notifications.js";
import { createAgentLifecycle, createAgentLifecycleEffects } from "../services/agent-lifecycle.js";
import { budgetService } from "../services/budgets.js";
import { documentService } from "../services/documents.js";
import { issueService } from "../services/issues.js";
import { createHeartbeatAgentStatus } from "../services/heartbeat/agent-status.js";
import { notifyExecutionRunWork } from "../services/execution-control-notifications.js";
import { reconcileAbandonedExecutionControl } from "../services/execution-control-reconciliation.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

vi.hoisted(() => { process.env.PAPERCLIP_DEBUG_WORK_SIGNALS = "stranded-assignments:1,assigned-work-invariant:1"; });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TEST_TIMEOUT_MS = 120_000;
const STEP_TIMEOUT_MS = 20_000;
const FULL_PASS_MS = 15 * MINUTE;
const TOPICS = new Set(["stranded-assignments", "assigned-work-invariant"]);
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
type Recorded = { at: number; topic: string; name: string; fields: Record<string, unknown> };

function bounded<T>(work: Promise<T>, waitingFor: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = realSetTimeout(() => reject(new Error(`Timed out after ${STEP_TIMEOUT_MS} ms waiting for ${waitingFor()}`)), STEP_TIMEOUT_MS);
  });
  return Promise.race([work, expired]).finally(() => realClearTimeout(timer));
}

/** Company hints, notification reloads and server replacements during a long
 * run: a staging-shaped company (settled reviews on an agent with a live
 * native run, and on a second agent) driven through each writer that used to
 * make the task recovery queues re-check every task of the company. No
 * fixture agent can start a run: on-demand wakes are off, and the agent that
 * is paused and resumed has no live run. */
describeIssueRecovery("company hints and notification reloads (census)", () => {
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
    return events;
  }

  function byWake(events: Recorded[]) {
    const counts: Record<string, Record<string, number>> = {};
    for (const event of events) if (event.name === "check") {
      const topic = counts[event.topic] ??= {};
      topic[String(event.fields.wake)] = (topic[String(event.fields.wake)] ?? 0) + 1;
    }
    return counts;
  }

  async function seed() {
    const f = await state.fixture();
    const config = { adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", "0"], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: false } }, role: "engineer" };
    const old = new Date(Date.now() - 2 * HOUR);
    const idle = { ...config, companyId: f.companyId, status: "idle", createdAt: old, updatedAt: old, lastHeartbeatAt: old };
    const [big, second, spare] = await state.db.insert(agents).values([
      { ...idle, name: "Big worker" }, { ...idle, name: "Second worker" }, { ...idle, name: "Spare worker" },
    ]).returning({ id: agents.id });
    const finishedAt = new Date(Date.now() - HOUR);
    const reviews = async (agentId: string, count: number) => {
      const rows = await state.db.insert(issues).values(Array.from({ length: count }, (_, index) => ({ companyId: f.companyId,
        title: `Review ${index}`, status: "in_review", assigneeAgentId: agentId, createdAt: old, updatedAt: old })))
        .returning({ id: issues.id });
      await state.db.insert(heartbeatRuns).values(rows.map(row => ({ companyId: f.companyId, agentId, status: "succeeded",
        runtimeMode: "native", startedAt: finishedAt, finishedAt, updatedAt: finishedAt, contextSnapshot: { issueId: row.id } })));
      return rows.map(row => row.id);
    };
    const bigTasks = await reviews(big!.id, 140);
    const secondTasks = await reviews(second!.id, 20);
    const spareTasks = await reviews(spare!.id, 5);
    const [bigLive, spec] = await state.db.insert(issues).values([
      { companyId: f.companyId, title: "Big live task", status: "in_progress", assigneeAgentId: big!.id },
      { companyId: f.companyId, title: "Spec", status: "backlog", createdAt: old, updatedAt: old },
    ]).returning({ id: issues.id });
    await documentService(state.db).upsertIssueDocument({ issueId: spec!.id, key: "spec", format: "markdown", body: "Draft" });
    await state.db.update(issues).set({ updatedAt: old }).where(eq(issues.id, spec!.id));
    const [project] = await state.db.insert(projects).values({ companyId: f.companyId, name: "Metered project", status: "in_progress" })
      .returning({ id: projects.id });
    await state.db.insert(costEvents).values({ companyId: f.companyId, agentId: second!.id, projectId: project!.id, provider: "test",
      model: "test", costCents: 5, occurredAt: new Date() });
    return { ...f, bigId: big!.id, secondId: second!.id, spareId: spare!.id, bigTasks, secondTasks, spareTasks,
      bigLiveTask: bigLive!.id, specIssue: spec!.id, projectId: project!.id };
  }

  async function boot(options: { fullBackstopMs?: number } = {}) {
    const f = await bounded(seed(), () => "the fixture to be seeded");
    const events = record();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const bootedAt = Date.now();
    await bounded(state.start(options), () => "the recovery workers to start");
    const bigRun = await bounded((async () => {
      const [run] = await state.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.bigId, status: "running",
        runtimeMode: "native", startedAt: new Date(), contextSnapshot: { issueId: f.bigLiveTask }, nativeIssueId: f.bigLiveTask })
        .returning({ id: heartbeatRuns.id });
      await state.db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, f.bigLiveTask));
      await state.db.update(agents).set({ status: "running", updatedAt: new Date() }).where(eq(agents.id, f.bigId));
      return run!.id;
    })(), () => "the big agent's live run to be recorded");
    const tick = () => state.db.transaction(async tx => {
      await tx.update(heartbeatRuns).set({ updatedAt: new Date() }).where(eq(heartbeatRuns.id, bigRun));
      await notifyIssueGraphRecovery(tx, { companyId: f.companyId, runId: bigRun });
    });
    await advance(ISSUE_RECOVERY_BACKSTOP_MS + MINUTE, tick);
    events.length = 0;
    /** A replacement server boots with no memory, then its notification connection opens. */
    const replaceServer = async () => {
      await bounded(state.restart(options), () => "the replacement server's recovery workers to start");
      reconcileDatabaseWorkNotifications(state.db);
    };
    return { ...f, events, bigRun, tick, bootedAt, replaceServer };
  }

  /** The lifecycle's resume, through its status-change effect (the lifecycle
   * worker that settles a resume is not part of this fixture). */
  const resume = (companyId: string, agentId: string) => state.db.transaction(async tx => {
    await createAgentLifecycleEffects().beforeStatusChange(tx as never, companyId, agentId, "paused", "idle");
    await tx.update(agents).set({ status: "idle", pauseReason: null, pausedAt: null, updatedAt: new Date() }).where(eq(agents.id, agentId));
  });

  const writers = (f: Awaited<ReturnType<typeof boot>>): Array<[string, () => Promise<unknown>]> => [
    ["server replacement and notification connection open", f.replaceServer],
    ["issue creation", () => issueService(state.db).create(f.companyId, { title: "New request", status: "backlog" } as never)],
    ["document lock", () => documentService(state.db).lockIssueDocument({ issueId: f.specIssue, key: "spec", lockedByUserId: "recovery-user" })],
    ["project budget hard stop", () => budgetService(state.db).upsertPolicy(f.companyId,
      { scopeType: "project", scopeId: f.projectId, amount: 1, hardStopEnabled: true }, "recovery-user")],
    ["spare agent pause", () => createAgentLifecycle(state.db).pauseAgent(f.spareId)],
    ["spare agent resume", () => resume(f.companyId, f.spareId)],
    ["second server replacement and notification connection open", f.replaceServer],
  ];

  const checksOf = (events: Recorded[], issueId: string, after: number) => events.filter(event => event.topic === "stranded-assignments"
    && event.name === "check" && event.fields.issueId === issueId && event.at >= after);

  /** An agent left "running" with a large settled backlog: one abandoned
   * run past its execution-control deadline, or (stranded) no run at all. */
  async function settlingAgent(f: Awaited<ReturnType<typeof boot>>, name: string, abandoned: boolean) {
    const old = new Date(Date.now() - 2 * HOUR);
    const [agent] = await state.db.insert(agents).values({ companyId: f.companyId, name, role: "engineer", status: "running",
      adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", "0"], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: false } },
      createdAt: old, updatedAt: old, lastHeartbeatAt: old }).returning({ id: agents.id });
    const tasks = await state.db.insert(issues).values(Array.from({ length: 140 }, (_, index) => ({ companyId: f.companyId,
      title: `Settled ${index}`, status: "in_review", assigneeAgentId: agent!.id, createdAt: old, updatedAt: old }))).returning({ id: issues.id });
    let runTask: string | null = null;
    if (abandoned) {
      const [task] = await state.db.insert(issues).values({ companyId: f.companyId, title: "Abandoned run's task", status: "in_progress",
        assigneeAgentId: agent!.id, createdAt: old, updatedAt: old }).returning({ id: issues.id });
      runTask = task!.id;
      const [run] = await state.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent!.id, status: "running",
        startedAt: old, updatedAt: old, contextSnapshot: { issueId: runTask }, executionControlDeadlineAt: new Date(Date.now() - MINUTE) })
        .returning({ id: heartbeatRuns.id });
      await state.db.update(issues).set({ executionRunId: run!.id, updatedAt: old }).where(eq(issues.id, runTask));
    }
    return { agentId: agent!.id, tasks: tasks.map(row => row.id), runTask };
  }

  it("does not re-check an agent's settled backlog when an abandoned or stranded run settles the agent", async () => {
    const f = await boot();
    const abandoned = await bounded(settlingAgent(f, "Abandoned worker", true), () => "the abandoned agent to be seeded");
    const stranded = await bounded(settlingAgent(f, "Stranded worker", false), () => "the stranded agent to be seeded");
    await advance(MINUTE, f.tick);
    f.events.length = 0;
    const before = state.meter.read();
    await bounded(reconcileAbandonedExecutionControl(state.db, new Date()), () => "the abandoned run to be reconciled");
    await advance(ISSUE_RECOVERY_BACKSTOP_MS + 2 * MINUTE, f.tick);
    await bounded(createHeartbeatAgentStatus(state.db).reconcileStrandedAgentStatuses(() => new Set(),
      { companyId: f.companyId, agentId: stranded.agentId }), () => "the stranded agent status to be reconciled");
    await advance(ISSUE_RECOVERY_BACKSTOP_MS + 2 * MINUTE, f.tick);
    const [abandonedAgent, strandedAgent] = await Promise.all([abandoned.agentId, stranded.agentId].map(id =>
      state.db.select({ status: agents.status }).from(agents).where(eq(agents.id, id)).then(rows => rows[0]?.status)));
    const backlog = new Set([...abandoned.tasks, ...stranded.tasks]);
    const checks = f.events.filter(event => event.name === "check");
    const result = { backlog: backlog.size, abandonedAgent, strandedAgent,
      backlogChecks: checks.filter(event => backlog.has(String(event.fields.issueId))).length,
      runTaskChecks: checks.filter(event => event.fields.issueId === abandoned.runTask).length,
      byWake: byWake(f.events), statements: state.meter.read().statements - before.statements };
    console.info(`agent-settle census: ${JSON.stringify(result)}`);
    expect(abandonedAgent).not.toBe("running");
    expect(strandedAgent).not.toBe("running");
    expect(result.backlogChecks).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("still checks an abandoned run's task promptly when the run is reconciled", async () => {
    const f = await boot();
    const abandoned = await bounded(settlingAgent(f, "Abandoned worker", true), () => "the abandoned agent to be seeded");
    await advance(MINUTE, f.tick);
    const reconciledAt = Date.now();
    await bounded(reconcileAbandonedExecutionControl(state.db, new Date()), () => "the abandoned run to be reconciled");
    await advance(2 * MINUTE, f.tick);
    const [checked] = checksOf(f.events, abandoned.runTask!, reconciledAt);
    expect(checked, "the abandoned run's task was not checked after reconciliation").toBeDefined();
    expect(checked!.at - reconciledAt).toBeLessThanOrEqual(MINUTE);
  }, TEST_TIMEOUT_MS);

  it("does not re-check settled tasks for company hints, reloads or server replacements", async () => {
    const f = await boot();
    const before = state.meter.read();
    const steps = writers(f);
    const minutesPerStep = 4;
    const settled = new Set([...f.bigTasks, ...f.secondTasks]);
    const settledByStep: Record<string, number> = {};
    for (const [label, write] of steps) {
      const from = f.events.length;
      await bounded(write(), () => `the ${label} write to commit`);
      await advance(minutesPerStep * MINUTE, f.tick);
      settledByStep[label] = f.events.slice(from).filter(event => event.name === "check" && settled.has(String(event.fields.issueId))).length;
    }
    const after = state.meter.read();
    const checks = f.events.filter(event => event.name === "check");
    const result = { minutes: steps.length * minutesPerStep,
      settledChecks: checks.filter(event => settled.has(String(event.fields.issueId))).length,
      pausedAgentChecks: checks.filter(event => f.spareTasks.includes(String(event.fields.issueId))).length,
      settledByStep, byWake: byWake(f.events), statements: after.statements - before.statements };
    console.info(`company-reload census: ${JSON.stringify(result)}`);
    // Only the paused and resumed agent's own tasks are re-checked.
    expect(result.settledChecks).toBe(0);
    for (const topic of TOPICS) {
      expect(result.byWake[topic]?.reload ?? 0).toBe(0);
      expect(result.byWake[topic]?.every_task ?? 0).toBe(0);
    }
  }, TEST_TIMEOUT_MS);

  /** A run of the second agent (20 settled reviews plus its live task),
   * through the writes and hints of a run start and a run finish: the run row,
   * the agent row as execution start writes it, the execution-run hint, and
   * finalizeAgentStatus. No process runs. */
  async function runCycle(f: Awaited<ReturnType<typeof boot>>, issueId: string, outcome: "succeeded" | "failed") {
    const run = await bounded(state.db.transaction(async tx => {
      const [row] = await tx.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.secondId, status: "running",
        runtimeMode: "native", startedAt: new Date(), contextSnapshot: { issueId }, nativeIssueId: issueId }).returning({ id: heartbeatRuns.id });
      await notifyExecutionRunWork(tx, { companyId: f.companyId, agentId: f.secondId, runId: row!.id });
      await tx.update(agents).set({ status: "running", updatedAt: new Date() }).where(eq(agents.id, f.secondId));
      return row!.id;
    }), () => "the run start to commit");
    await advance(2 * MINUTE, f.tick);
    await bounded(state.db.transaction(async tx => {
      await notifyExecutionRunWork(tx, { companyId: f.companyId, runId: run, issueId });
      await tx.update(heartbeatRuns).set({ status: outcome, finishedAt: new Date(), updatedAt: new Date() }).where(eq(heartbeatRuns.id, run));
    }), () => "the run finish to commit");
    await bounded(createHeartbeatAgentStatus(state.db).finalizeAgentStatus(f.secondId, outcome), () => "the agent status to settle");
    await advance(2 * MINUTE, f.tick);
    return run;
  }

  it("does not re-check an agent's settled backlog when its runs start and finish", async () => {
    const f = await boot();
    const before = state.meter.read();
    const [work] = await bounded(state.db.insert(issues).values({ companyId: f.companyId, title: "Second agent work", status: "in_progress",
      assigneeAgentId: f.secondId }).returning({ id: issues.id }), () => "the run's task to be created");
    for (let cycle = 0; cycle < 2; cycle++) await runCycle(f, work!.id, "succeeded");
    const settled = new Set([...f.bigTasks, ...f.secondTasks]);
    const checks = f.events.filter(event => event.name === "check");
    const result = { cycles: 2, settledChecks: checks.filter(event => settled.has(String(event.fields.issueId))).length,
      runTaskChecks: checks.filter(event => event.fields.issueId === work!.id).length, byWake: byWake(f.events),
      statements: state.meter.read().statements - before.statements };
    console.info(`run-cycle census: ${JSON.stringify(result)}`);
    expect(result.settledChecks).toBe(0);
    expect(result.runTaskChecks).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  it("still checks a task promptly when its run fails", async () => {
    const f = await boot();
    const [work] = await bounded(state.db.insert(issues).values({ companyId: f.companyId, title: "Second agent work", status: "in_progress",
      assigneeAgentId: f.secondId }).returning({ id: issues.id }), () => "the run's task to be created");
    const startedAt = Date.now();
    await runCycle(f, work!.id, "failed");
    const finishedAt = startedAt + 2 * MINUTE;
    const [checked] = checksOf(f.events, work!.id, finishedAt);
    expect(checked, "the failed run's task was not checked after the run ended").toBeDefined();
    expect(checked!.at - finishedAt).toBeLessThanOrEqual(MINUTE);
  }, TEST_TIMEOUT_MS);

  it("still checks a task stranded right before each writer within its bound", async () => {
    const f = await boot();
    const steps = writers(f);
    // The lock and the budget stop re-check only their own task or changed
    // rows; a task stranded by a write that sends no hint waits at most for
    // the changed-rows backstop, as before.
    const bounds: Record<string, number> = { "document lock": ISSUE_RECOVERY_BACKSTOP_MS + 2 * MINUTE };
    const targets = [f.bigTasks[1], f.bigTasks[2], f.bigTasks[3], f.bigTasks[4], f.spareTasks[1], f.spareTasks[2], f.bigTasks[5]];
    const late: string[] = [];
    for (const [index, [label, write]] of steps.entries()) {
      const target = targets[index]!;
      const bound = bounds[label] ?? MINUTE;
      const changedAt = Date.now();
      await bounded(state.db.update(issues).set({ status: "todo", updatedAt: new Date() }).where(eq(issues.id, target)).then(() => undefined),
        () => `the task write before ${label} to commit`);
      await bounded(write(), () => `the ${label} write to commit`);
      await advance(bound, f.tick);
      const [checked] = checksOf(f.events, target, changedAt);
      if (!checked || checked.at - changedAt > bound) late.push(`${label}: ${checked ? checked.at - changedAt : "never"} ms`);
    }
    expect(late).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("checks every task a replaced server loaded but never reached in its first full pass", async () => {
    const f = await bounded(seed(), () => "the fixture to be seeded");
    const events = record();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    // The first passes load every task (no saved full pass yet, two pages) but
    // check one batch of 25 each, so the load completes long before the checks.
    await bounded(state.start({}), () => "the first server's recovery workers to start");
    await bounded(vi.advanceTimersByTimeAsync(1_500), () => "the second page of the first full pass to load");
    await bounded(Promise.allSettled([...state.passes]), () => "the first server's passes to settle");
    const reached = new Set(events.filter(event => event.topic === "stranded-assignments" && event.name === "check")
      .map(event => String(event.fields.issueId)));
    const unreached = [...f.bigTasks, ...f.secondTasks].filter(id => !reached.has(id));
    expect(unreached.length, "the first pass should stop before checking every task").toBeGreaterThan(0);
    const replacedAt = Date.now();
    await bounded(state.restart({}), () => "the replacement server's recovery workers to start");
    reconcileDatabaseWorkNotifications(state.db);
    await advance(2 * MINUTE);
    const checkedAfter = new Set(events.filter(event => event.topic === "stranded-assignments" && event.name === "check"
      && event.at >= replacedAt).map(event => String(event.fields.issueId)));
    expect(unreached.filter(id => !checkedAfter.has(id))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("keeps the full pass on schedule across server replacements", async () => {
    const f = await boot({ fullBackstopMs: FULL_PASS_MS });
    // A change no changed-rows clause sees: only a full pass can find it.
    const target = f.bigTasks[30]!;
    await bounded(state.db.update(issues).set({ status: "todo" }).where(eq(issues.id, target)).then(() => undefined),
      () => "the task write that keeps its old update time to commit");
    const changedAt = Date.now();
    await advance(MINUTE, f.tick);
    await f.replaceServer();
    await advance(3 * MINUTE, f.tick);
    await f.replaceServer();
    const replacedAt = Date.now();
    const deadline = f.bootedAt + FULL_PASS_MS + ISSUE_RECOVERY_BACKSTOP_MS + MINUTE;
    await advance(deadline - Date.now(), f.tick);
    const checks = checksOf(f.events, target, changedAt);
    // Neither replacement checked it (no full pass at boot); the next full pass did.
    expect(checks.filter(event => event.at < replacedAt + MINUTE)).toEqual([]);
    expect(checks[0], `task ${target} was not checked by the next full pass`).toBeDefined();
    expect(checks[0]!.at).toBeLessThanOrEqual(deadline);
  }, TEST_TIMEOUT_MS);
});
