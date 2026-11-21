import { setImmediate as immediate } from "node:timers/promises";
import { and, desc, eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { activityLog, agents, heartbeatRuns, issues, issueThreadInteractions } from "@paperclipai/db";
import { notifyNativeStatusReassessment } from "../services/native-status-reassessment-notifications.js";
import { notifyChatRunMilestones } from "../services/chat-run-milestone-notifications.js";
import { ASSIGNED_WORK_CONTINUED_ACTION } from "../services/recovery/assigned-work-sweep.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describeIssueRecovery("assigned-work re-checks of tasks whose continuation is refused", () => {
  const state = issueRecoveryFixture();
  const TASKS = 10;

  async function seed() {
    const f = await state.fixture();
    const db = state.db;
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: false } } })
      .where(eq(agents.id, f.agentId));
    const tasks = await db.insert(issues).values(Array.from({ length: TASKS }, (_, index) => ({
      companyId: f.companyId, title: `Refused task ${index}`, status: "in_progress", assigneeAgentId: f.agentId,
    }))).returning({ id: issues.id });
    await db.insert(heartbeatRuns).values(tasks.map(task => ({ companyId: f.companyId, agentId: f.agentId,
      status: "failed", errorCode: "adapter_failed", finishedAt: new Date(Date.now() - HOUR), contextSnapshot: { issueId: task.id } })));
    return { ...f, tasks };
  }

  async function advance(ms: number) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await vi.advanceTimersByTimeAsync(Math.min(500, until - Date.now()));
      await Promise.allSettled([...state.passes]); await immediate();
    }
  }

  async function countStatements(work: () => Promise<unknown>) {
    const statements: string[] = [], prior = state.db.$client.options.debug;
    state.db.$client.options.debug = (_connection, query) => { statements.push(query); };
    try { await work(); } finally { state.db.$client.options.debug = prior; }
    return statements;
  }

  const attempts = async (companyId: string, issueId?: string) => (await state.db.select().from(activityLog).where(and(
    eq(activityLog.companyId, companyId), eq(activityLog.action, ASSIGNED_WORK_CONTINUED_ACTION),
    issueId ? eq(activityLog.entityId, issueId) : undefined))).length;

  async function boot(f: Awaited<ReturnType<typeof seed>>) {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await state.start({});
    await advance(5 * MINUTE);
    expect(await attempts(f.companyId)).toBeGreaterThanOrEqual(TASKS);
    const report = await state.heartbeat.reportAssignedWorkInvariant(f.companyId);
    expect(report.violations).toEqual({ retry_offered: TASKS });
  }

  it("stays quiet behind unanswered questions and wakes on their resolution event", async () => {
    const f = await seed();
    await state.db.update(heartbeatRuns).set({ contextSnapshot:
      sql`${heartbeatRuns.contextSnapshot} || '{"explicitUserContinuation":{"previousRunId":"11111111-1111-4111-8111-111111111111"}}'::jsonb` })
      .where(eq(heartbeatRuns.companyId, f.companyId));
    for (const task of f.tasks) await state.db.insert(issueThreadInteractions).values({ companyId: f.companyId,
      issueId: task.id, kind: "ask_user_questions", status: "pending", continuationPolicy: "wake_assignee",
      payload: { version: 1, supersedeOnUserComment: false, questions: [{ id: "scope", prompt: "Choose the scope",
        selectionMode: "single", required: true, options: [{ id: "small", label: "Small" }, { id: "full", label: "Full" }] }] },
      createdAt: new Date(Date.now() - HOUR) });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await state.start({});
    await advance(20 * MINUTE);
    expect(await attempts(f.companyId)).toBe(0);
    await state.db.transaction(async tx => {
      await tx.update(issueThreadInteractions).set({ status: "answered", updatedAt: new Date() })
        .where(eq(issueThreadInteractions.issueId, f.tasks[0]!.id));
      await notifyChatRunMilestones(tx, { companyId: f.companyId, issueId: f.tasks[0]!.id });
    });
    await advance(2 * MINUTE);
    expect(await attempts(f.companyId, f.tasks[0]!.id)).toBeGreaterThan(0);
    expect(await attempts(f.companyId)).toBe(await attempts(f.companyId, f.tasks[0]!.id));
  }, 600_000);

  it("backs off while every check finds the same refused state", async () => {
    const f = await seed();
    await boot(f);
    await advance(HOUR);
    const before = await attempts(f.companyId);
    const idle = await countStatements(() => advance(5 * HOUR));
    expect(await attempts(f.companyId) - before).toBeLessThanOrEqual(3 * TASKS);
    expect(idle.length).toBeLessThan(TASKS * 500);
    const [latest] = await state.db.select().from(activityLog).where(and(eq(activityLog.entityId, f.tasks[0]!.id),
      eq(activityLog.action, ASSIGNED_WORK_CONTINUED_ACTION))).orderBy(desc(activityLog.createdAt)).limit(1);
    expect(latest?.details).toMatchObject({ outcome: "not_started", stateKey: expect.any(String),
      message: expect.stringContaining("still could not start") });
  }, 600_000);

  it("re-checks a backed-off task within two minutes when one of its runs finishes", async () => {
    const f = await seed();
    await boot(f);
    await advance(3 * HOUR);
    const target = f.tasks[0]!.id;
    const before = await attempts(f.companyId, target);
    await state.db.transaction(async tx => {
      const [run] = await tx.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "failed",
        errorCode: "adapter_failed", finishedAt: new Date(), contextSnapshot: { issueId: target } }).returning();
      await notifyNativeStatusReassessment(tx, { companyId: f.companyId, runId: run!.id });
    });
    await advance(2 * MINUTE);
    expect(await attempts(f.companyId, target)).toBeGreaterThan(before);
  }, 600_000);

  it("leaves review work alone and re-checks a refused task with reads only while it waits", async () => {
    const f = await seed();
    const db = state.db;
    const [paused] = await db.insert(agents).values({ companyId: f.companyId, name: "Paused reviewer", role: "engineer", status: "paused",
      adapterType: "process", adapterConfig: {} }).returning();
    await db.insert(issues).values(Array.from({ length: 60 }, (_, index) => ({ companyId: f.companyId, title: `Review ${index}`,
      status: "in_review", assigneeAgentId: f.agentId, executionState: { status: "pending" } })));
    const running = await db.insert(issues).values(Array.from({ length: 10 }, (_, index) => ({ companyId: f.companyId,
      title: `Running ${index}`, status: "in_progress", assigneeAgentId: f.agentId }))).returning({ id: issues.id });
    await db.insert(heartbeatRuns).values(running.map(task => ({ companyId: f.companyId, agentId: f.agentId, status: "running",
      startedAt: new Date(), contextSnapshot: { issueId: task.id } })));
    await db.insert(issues).values(Array.from({ length: 5 }, (_, index) => ({ companyId: f.companyId, title: `Paused ${index}`,
      status: "todo", assigneeAgentId: paused!.id, createdAt: new Date(Date.now() - HOUR) })));
    const report = await state.heartbeat.reportAssignedWorkInvariant(f.companyId);
    expect(report).toMatchObject({ openTasks: 25, violations: { retry_offered: TASKS },
      ok: { live_run: 10, "waiting:agent_paused": 5 } });
    const target = f.tasks[0]!.id;
    const claim = await countStatements(() => state.heartbeat.checkAssignedWorkInvariant({ companyId: f.companyId, issueId: target }));
    const recheck = await countStatements(() => state.heartbeat.checkAssignedWorkInvariant({ companyId: f.companyId, issueId: target }));
    expect(claim.some(query => /^insert into "activity_log"/i.test(query))).toBe(true);
    expect(recheck.filter(query => /^(insert|update|delete)/i.test(query.trim()))).toEqual([]);
    expect(recheck.length).toBeLessThan(claim.length);
  }, 600_000);
});
