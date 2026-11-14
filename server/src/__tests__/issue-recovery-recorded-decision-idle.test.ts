import { setImmediate as immediate } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { notifyNativeStatusReassessment } from "../services/native-status-reassessment-notifications.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

describeIssueRecovery("stranded recovery of runs with a recorded decision", () => {
  const state = issueRecoveryFixture();
  const TASKS = 10;

  async function seed() {
    const f = await state.fixture();
    const db = state.db;
    await db.update(agents).set({ status: "error" }).where(eq(agents.id, f.agentId));
    const tasks = await db.insert(issues).values(Array.from({ length: TASKS }, (_, index) => ({
      companyId: f.companyId, title: `Waiting task ${index}`, status: "in_progress", assigneeAgentId: f.agentId,
    }))).returning({ id: issues.id });
    await db.insert(heartbeatRuns).values(tasks.map(task => ({ companyId: f.companyId, agentId: f.agentId,
      status: "failed", errorCode: "adapter_failed", finishedAt: new Date(Date.now() - 60 * 60_000),
      contextSnapshot: { issueId: task.id } })));
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

  async function startAndRecordDecisions(f: Awaited<ReturnType<typeof seed>>) {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await state.start({});
    await advance(6 * 60_000);
    const decided = await state.db.select({ issueId: issueRecoveryActions.sourceIssueId }).from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, f.companyId), eq(issueRecoveryActions.status, "resolved"),
      sql`${issueRecoveryActions.evidence} ? 'executionReconciliation'`));
    expect(new Set(decided.map(row => row.issueId))).toEqual(new Set(f.tasks.map(task => task.id)));
  }

  it("stays quiet for half an hour once each failed run has its decision", async () => {
    const f = await seed();
    await startAndRecordDecisions(f);
    const runsBefore = await state.db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, updatedAt: heartbeatRuns.updatedAt })
      .from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    const idle = await countStatements(() => advance(30 * 60_000));
    expect(idle).toHaveLength(0);
    const runsAfter = await state.db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, updatedAt: heartbeatRuns.updatedAt })
      .from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect(runsAfter.sort(byId)).toEqual(runsBefore.sort(byId));
    const statuses = await state.db.select({ status: issues.status }).from(issues).where(eq(issues.companyId, f.companyId));
    expect(statuses.every(row => row.status === "in_progress")).toBe(true);
  }, 300_000);

  it("still recovers promptly when another run of a waiting task fails", async () => {
    const f = await seed();
    await startAndRecordDecisions(f);
    await advance(10 * 60_000);
    const target = f.tasks[0].id;
    const [failed] = await state.db.transaction(async tx => {
      const rows = await tx.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "failed",
        errorCode: "adapter_failed", finishedAt: new Date(), contextSnapshot: { issueId: target } }).returning();
      await notifyNativeStatusReassessment(tx, { companyId: f.companyId, runId: rows[0].id });
      return rows;
    });
    const actionFor = async () => (await state.db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, f.companyId), eq(issueRecoveryActions.sourceIssueId, target),
      eq(issueRecoveryActions.fingerprint, `legacy-execution:${failed.id}`))))[0];
    await advance(5_000);
    expect(await actionFor()).toMatchObject({ kind: "active_run_watchdog", evidence: expect.objectContaining({ runId: failed.id }) });
    await advance(6 * 60_000);
    expect(await actionFor()).toMatchObject({ status: "resolved",
      evidence: expect.objectContaining({ executionReconciliation: expect.objectContaining({ runId: failed.id }) }) });
    const after = await countStatements(() => advance(30 * 60_000));
    expect(after.filter(query => query.startsWith("update \"heartbeat_runs\""))).toEqual([]);
    expect(after.length).toBeLessThan(TASKS * 500);
  }, 300_000);
});
