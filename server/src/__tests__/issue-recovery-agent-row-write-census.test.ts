import { setImmediate as immediate } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import { workSignalDebug } from "@paperclipai/db/work-signal-debug";
import { ISSUE_RECOVERY_BACKSTOP_MS, ISSUE_RECOVERY_FULL_BACKSTOP_MS, notifyIssueGraphRecovery }
  from "../services/issue-recovery-notifications.js";
import { agentService } from "../services/agents.js";
import { createAgentLifecycle, createAgentLifecycleEffects } from "../services/agent-lifecycle.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

vi.hoisted(() => { process.env.PAPERCLIP_DEBUG_WORK_SIGNALS = "stranded-assignments:1,assigned-work-invariant:1"; });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TOPICS = new Set(["stranded-assignments", "assigned-work-invariant"]);
type Recorded = { at: number; topic: string; name: string; fields: Record<string, unknown> };

describeIssueRecovery("agent row writes during a long run (census)", () => {
  const state = issueRecoveryFixture({ meter: true });

  async function advance(ms: number, onTick?: () => Promise<unknown>) {
    const until = Date.now() + ms;
    let nextTick = Date.now();
    while (Date.now() < until) {
      if (onTick && Date.now() >= nextTick) { await onTick(); nextTick = Date.now() + 10_000; }
      await vi.advanceTimersByTimeAsync(Math.min(1000, until - Date.now()));
      await Promise.allSettled([...state.passes]); await immediate();
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
      runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: true } }, role: "engineer" };
    const old = new Date(Date.now() - 2 * HOUR);
    const [big, second, held] = await state.db.insert(agents).values([
      { ...config, companyId: f.companyId, name: "Big worker", status: "idle", createdAt: old, updatedAt: old, lastHeartbeatAt: old },
      { ...config, companyId: f.companyId, name: "Second worker", status: "idle", createdAt: old, updatedAt: old, lastHeartbeatAt: old },
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
    const bigTasks = await reviews(big!.id, 700);
    const secondTasks = await reviews(second!.id, 80);
    const [bigLive, secondLive, waiting] = await state.db.insert(issues).values([
      { companyId: f.companyId, title: "Big live task", status: "in_progress", assigneeAgentId: big!.id },
      { companyId: f.companyId, title: "Second live task", status: "in_progress", assigneeAgentId: second!.id },
      { companyId: f.companyId, title: "Waits for its agent", status: "todo", assigneeAgentId: held!.id, createdAt: old, updatedAt: old },
    ]).returning({ id: issues.id });
    return { ...f, bigId: big!.id, secondId: second!.id, heldId: held!.id, bigTasks, secondTasks,
      bigLiveTask: bigLive!.id, secondLiveTask: secondLive!.id, waitingTask: waiting!.id };
  }

  async function boot() {
    const f = await seed();
    const events = record();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await state.start({});
    const startRun = async (agentId: string, issueId: string) => {
      const [run] = await state.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId, status: "running", runtimeMode: "native",
        startedAt: new Date(), contextSnapshot: { issueId }, nativeIssueId: issueId })
        .returning({ id: heartbeatRuns.id });
      await state.db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, issueId));
      await state.db.update(agents).set({ status: "running", updatedAt: new Date() }).where(eq(agents.id, agentId));
      return run!.id;
    };
    const bigRun = await startRun(f.bigId, f.bigLiveTask);
    await startRun(f.secondId, f.secondLiveTask);
    const tick = () => state.db.transaction(async tx => {
      await tx.update(heartbeatRuns).set({ updatedAt: new Date() }).where(eq(heartbeatRuns.id, bigRun));
      await notifyIssueGraphRecovery(tx, { companyId: f.companyId, runId: bigRun });
    });
    await advance(12 * MINUTE, tick);
    events.length = 0;
    return { ...f, events, bigRun, tick };
  }

  const checksOf = (events: Recorded[], issueId: string) =>
    events.filter(event => event.topic === "stranded-assignments" && event.name === "check" && event.fields.issueId === issueId);

  it("does not re-check either running agent's settled tasks when their rows are written during the runs", async () => {
    const f = await boot();
    const svc = agentService(state.db);
    const before = state.meter.read();
    const writes: Array<[string, () => Promise<unknown>]> = [
      ["big agent runtime configuration", () => svc.update(f.bigId,
        { runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: true }, revision: 1 } })],
      ["second agent adapter configuration", () => svc.update(f.secondId,
        { adapterConfig: { command: process.execPath, args: ["-e", "1"], cwd: process.cwd() } })],
      ["big agent execution start", () => state.db.update(agents).set({ status: "running", updatedAt: new Date() })
        .where(eq(agents.id, f.bigId))],
      ["big agent permissions", () => svc.updatePermissions(f.bigId, { canCreateAgents: false })],
      ["big agent adapter configuration", () => svc.update(f.bigId,
        { adapterConfig: { command: process.execPath, args: ["-e", "2"], cwd: process.cwd() } })],
    ];
    for (const [, write] of writes) {
      await write();
      await advance(7 * MINUTE, f.tick);
    }
    const after = state.meter.read();
    const settled = new Set([...f.bigTasks, ...f.secondTasks]);
    const settledChecks = f.events.filter(event => event.name === "check" && settled.has(String(event.fields.issueId))).length;
    const result = { writes: writes.map(([label]) => label), minutes: writes.length * 7, settledChecks, byWake: byWake(f.events),
      statements: after.statements - before.statements };
    console.info(`agent-row census: ${JSON.stringify(result)}`);
    expect(settledChecks).toBe(0);
    expect(result.byWake["stranded-assignments"]?.company ?? 0).toBe(0);
    expect(result.byWake["stranded-assignments"]?.reload ?? 0).toBe(0);
  }, 1_800_000);

  it("still checks a running agent's task within the backstop bound when it becomes stranded after a configuration write", async () => {
    const f = await boot();
    await agentService(state.db).update(f.bigId, { runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: true }, revision: 2 } });
    await advance(MINUTE, f.tick);
    f.events.length = 0;
    const target = f.bigTasks[17]!;
    const changedAt = Date.now();
    await state.db.update(issues).set({ status: "todo", updatedAt: new Date() }).where(eq(issues.id, target));
    await advance(ISSUE_RECOVERY_BACKSTOP_MS + 2 * MINUTE, f.tick);
    const [checked] = checksOf(f.events, target);
    expect(checked).toBeDefined();
    expect(checked!.at - changedAt).toBeLessThanOrEqual(ISSUE_RECOVERY_BACKSTOP_MS + 2 * MINUTE);
  }, 1_800_000);

  it("still checks an idle agent's tasks within the backstop bound after its configuration is written", async () => {
    const f = await boot();
    await state.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.agentId, f.secondId));
    await state.db.update(agents).set({ status: "idle", lastHeartbeatAt: new Date(), updatedAt: new Date() })
      .where(eq(agents.id, f.secondId));
    await advance(11 * MINUTE, f.tick);
    f.events.length = 0;
    const changedAt = Date.now();
    await agentService(state.db).update(f.secondId, { adapterConfig: { command: process.execPath, args: ["-e", "3"], cwd: process.cwd() } });
    await advance(ISSUE_RECOVERY_BACKSTOP_MS + 2 * MINUTE, f.tick);
    const [checked] = checksOf(f.events, f.secondTasks[5]!);
    expect(checked).toBeDefined();
    expect(checked!.at - changedAt).toBeLessThanOrEqual(ISSUE_RECOVERY_BACKSTOP_MS + 2 * MINUTE);
  }, 1_800_000);

  it("still checks a held agent's waiting task promptly when its hold is released", async () => {
    const f = await boot();
    const changedAt = Date.now();
    await state.db.transaction(async tx => {
      await createAgentLifecycleEffects().beforeStatusChange(tx as never, f.companyId, f.heldId, "paused", "idle");
      await tx.update(agents).set({ status: "idle", lifecycleHolds: [], pauseReason: null, pausedAt: null, updatedAt: new Date() })
        .where(eq(agents.id, f.heldId));
    });
    await advance(2 * MINUTE, f.tick);
    const [checked] = checksOf(f.events, f.waitingTask);
    expect(checked).toBeDefined();
    expect(checked!.at - changedAt).toBeLessThanOrEqual(MINUTE);
  }, 1_800_000);

  it("still checks a running agent's tasks promptly when the agent is paused or terminated", async () => {
    const f = await boot();
    const lifecycle = createAgentLifecycle(state.db);
    let changedAt = Date.now();
    await lifecycle.pauseAgent(f.secondId);
    await advance(2 * MINUTE, f.tick);
    let [checked] = checksOf(f.events, f.secondTasks[3]!);
    expect(checked).toBeDefined();
    expect(checked!.at - changedAt).toBeLessThanOrEqual(MINUTE);
    f.events.length = 0;
    changedAt = Date.now();
    await lifecycle.terminateAgent(f.bigId);
    await advance(2 * MINUTE, f.tick);
    [checked] = checksOf(f.events, f.bigTasks[9]!);
    expect(checked).toBeDefined();
    expect(checked!.at - changedAt).toBeLessThanOrEqual(MINUTE);
  }, 1_800_000);

  it("still re-checks every settled task in the hourly full pass after configuration writes", async () => {
    const f = await boot();
    await agentService(state.db).update(f.bigId, { runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: true }, revision: 3 } });
    await advance(ISSUE_RECOVERY_FULL_BACKSTOP_MS + 5 * MINUTE, f.tick);
    const checked = new Set(f.events.filter(event => event.topic === "stranded-assignments" && event.name === "check")
      .map(event => String(event.fields.issueId)));
    expect([...f.bigTasks, ...f.secondTasks].filter(id => !checked.has(id))).toEqual([]);
  }, 1_800_000);
});
