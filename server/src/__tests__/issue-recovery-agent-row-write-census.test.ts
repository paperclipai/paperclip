import { setImmediate as immediate } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import { workSignalDebug } from "@paperclipai/db/work-signal-debug";
import { ISSUE_RECOVERY_BACKSTOP_MS, notifyIssueGraphRecovery } from "../services/issue-recovery-notifications.js";
import { agentService } from "../services/agents.js";
import { createAgentLifecycle, createAgentLifecycleEffects } from "../services/agent-lifecycle.js";
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

describeIssueRecovery("agent row writes during a long run (census)", () => {
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
    const [big, second, spare, other, held] = await state.db.insert(agents).values([
      { ...idle, name: "Big worker" },
      { ...idle, name: "Second worker" },
      { ...idle, name: "Spare worker" },
      { ...idle, name: "Other worker" },
      { ...config, companyId: f.companyId, name: "Held worker", status: "paused", lifecycleHolds: ["manual"], pauseReason: "manual",
        createdAt: old, updatedAt: old },
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
    const otherTasks = await reviews(other!.id, 5);
    const [waiting] = await reviews(held!.id, 1);
    const [bigLive, secondLive] = await state.db.insert(issues).values([
      { companyId: f.companyId, title: "Big live task", status: "in_progress", assigneeAgentId: big!.id },
      { companyId: f.companyId, title: "Second live task", status: "in_progress", assigneeAgentId: second!.id },
    ]).returning({ id: issues.id });
    return { ...f, bigId: big!.id, secondId: second!.id, spareId: spare!.id, otherId: other!.id, heldId: held!.id,
      bigTasks, secondTasks, spareTasks, otherTasks, waitingTask: waiting!, bigLiveTask: bigLive!.id, secondLiveTask: secondLive!.id };
  }

  async function boot(options: { fullBackstopMs?: number } = {}) {
    const f = await bounded(seed(), () => "the fixture to be seeded");
    const events = record();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await bounded(state.start(options), () => "the recovery workers to start");
    const startRun = async (agentId: string, issueId: string) => {
      const [run] = await state.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId, status: "running", runtimeMode: "native",
        startedAt: new Date(), contextSnapshot: { issueId }, nativeIssueId: issueId })
        .returning({ id: heartbeatRuns.id });
      await state.db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, issueId));
      await state.db.update(agents).set({ status: "running", updatedAt: new Date() }).where(eq(agents.id, agentId));
      return run!.id;
    };
    const bigRun = await bounded(startRun(f.bigId, f.bigLiveTask), () => "the big agent's live run to be recorded");
    await bounded(startRun(f.secondId, f.secondLiveTask), () => "the second agent's live run to be recorded");
    const tick = () => state.db.transaction(async tx => {
      await tx.update(heartbeatRuns).set({ updatedAt: new Date() }).where(eq(heartbeatRuns.id, bigRun));
      await notifyIssueGraphRecovery(tx, { companyId: f.companyId, runId: bigRun });
    });
    await advance(ISSUE_RECOVERY_BACKSTOP_MS + MINUTE, tick);
    events.length = 0;
    return { ...f, events, bigRun, tick };
  }

  const checksOf = (events: Recorded[], issueId: string) =>
    events.filter(event => event.topic === "stranded-assignments" && event.name === "check" && event.fields.issueId === issueId);

  async function expectCheckedWithin(f: Awaited<ReturnType<typeof boot>>, issueId: string, changedAt: number, boundMs: number) {
    await advance(boundMs, f.tick);
    const [checked] = checksOf(f.events, issueId).filter(event => event.at >= changedAt);
    expect(checked, `task ${issueId} was not checked within ${boundMs / MINUTE} simulated minutes`).toBeDefined();
    expect(checked!.at - changedAt).toBeLessThanOrEqual(boundMs);
  }

  it("does not re-check either running agent's settled tasks when their rows are written during the runs", async () => {
    const f = await boot();
    const svc = agentService(state.db);
    const before = state.meter.read();
    const writes: Array<[string, () => Promise<unknown>]> = [
      ["big agent runtime configuration", () => svc.update(f.bigId,
        { runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: false }, revision: 1 } })],
      ["second agent adapter configuration", () => svc.update(f.secondId,
        { adapterConfig: { command: process.execPath, args: ["-e", "1"], cwd: process.cwd() } })],
      ["big agent execution start", () => state.db.update(agents).set({ status: "running", updatedAt: new Date() })
        .where(eq(agents.id, f.bigId))],
      ["big agent permissions", () => svc.updatePermissions(f.bigId, { canCreateAgents: false })],
      ["big agent adapter configuration", () => svc.update(f.bigId,
        { adapterConfig: { command: process.execPath, args: ["-e", "2"], cwd: process.cwd() } })],
    ];
    const minutesPerWrite = 6;
    for (const [label, write] of writes) {
      await bounded(write(), () => `the ${label} write to commit`);
      await advance(minutesPerWrite * MINUTE, f.tick);
    }
    const after = state.meter.read();
    const settled = new Set([...f.bigTasks, ...f.secondTasks]);
    const settledChecks = f.events.filter(event => event.name === "check" && settled.has(String(event.fields.issueId))).length;
    const result = { writes: writes.map(([label]) => label), minutes: writes.length * minutesPerWrite, settledChecks,
      byWake: byWake(f.events), statements: after.statements - before.statements };
    console.info(`agent-row census: ${JSON.stringify(result)}`);
    expect(settledChecks).toBe(0);
    expect(result.byWake["stranded-assignments"]?.company ?? 0).toBe(0);
    expect(result.byWake["stranded-assignments"]?.reload ?? 0).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("still checks a running agent's task within the backstop bound when it becomes stranded after a configuration write", async () => {
    const f = await boot();
    await bounded(agentService(state.db).update(f.bigId, { runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: false }, revision: 2 } }),
      () => "the big agent configuration write to commit");
    await advance(MINUTE, f.tick);
    f.events.length = 0;
    const target = f.bigTasks[17]!;
    const changedAt = Date.now();
    await bounded(state.db.update(issues).set({ status: "todo", updatedAt: new Date() }).where(eq(issues.id, target)).then(() => undefined),
      () => "the task write without a hint to commit");
    await expectCheckedWithin(f, target, changedAt, ISSUE_RECOVERY_BACKSTOP_MS + 2 * MINUTE);
  }, TEST_TIMEOUT_MS);

  it("still checks an idle agent's tasks within the backstop bound after its configuration is written", async () => {
    const f = await boot();
    const changedAt = Date.now();
    await bounded(agentService(state.db).update(f.spareId, { adapterConfig: { command: process.execPath, args: ["-e", "3"], cwd: process.cwd() } }),
      () => "the idle agent configuration write to commit");
    await expectCheckedWithin(f, f.spareTasks[2]!, changedAt, ISSUE_RECOVERY_BACKSTOP_MS + 2 * MINUTE);
  }, TEST_TIMEOUT_MS);

  it("still checks a held agent's waiting task promptly when its hold is released", async () => {
    const f = await boot();
    const changedAt = Date.now();
    await bounded(state.db.transaction(async tx => {
      await createAgentLifecycleEffects().beforeStatusChange(tx as never, f.companyId, f.heldId, "paused", "idle");
      await tx.update(agents).set({ status: "idle", lifecycleHolds: [], pauseReason: null, pausedAt: null, updatedAt: new Date() })
        .where(eq(agents.id, f.heldId));
    }), () => "the hold release to commit");
    await expectCheckedWithin(f, f.waitingTask, changedAt, MINUTE);
  }, TEST_TIMEOUT_MS);

  it("still checks an agent's tasks promptly when the agent is paused or terminated", async () => {
    const f = await boot();
    const lifecycle = createAgentLifecycle(state.db);
    let changedAt = Date.now();
    await bounded(lifecycle.pauseAgent(f.spareId), () => "the pause to commit");
    await expectCheckedWithin(f, f.spareTasks[3]!, changedAt, MINUTE);
    changedAt = Date.now();
    await bounded(lifecycle.terminateAgent(f.otherId), () => "the termination to commit");
    await expectCheckedWithin(f, f.otherTasks[1]!, changedAt, MINUTE);
  }, TEST_TIMEOUT_MS);

  it("still re-checks every settled task in the next full pass after configuration writes", async () => {
    const f = await boot({ fullBackstopMs: FULL_PASS_MS });
    await bounded(agentService(state.db).update(f.bigId, { runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: false }, revision: 3 } }),
      () => "the big agent configuration write to commit");
    await advance(FULL_PASS_MS, f.tick);
    const checked = new Set(f.events.filter(event => event.topic === "stranded-assignments" && event.name === "check")
      .map(event => String(event.fields.issueId)));
    expect([...f.bigTasks, ...f.secondTasks].filter(id => !checked.has(id))).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
