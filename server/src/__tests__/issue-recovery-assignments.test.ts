import { eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { notifyExecutionRunWork } from "../services/execution-control-notifications.js";
import { notifyNativeStatusReassessment } from "../services/native-status-reassessment-notifications.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

describeIssueRecovery("issue recovery production producers and assignments", () => {
  const state = issueRecoveryFixture();
  const { start, fixture, settled, quiet, finish, completed } = state;
  it("dispatches an ordinary new assignment after commit and returns to quiet after completion", async () => {
    const f = await fixture(); await start(); await quiet();
    const issue = await issueService(state.db).create(f.companyId, { title: "Recover assignment", status: "todo", assigneeAgentId: f.agentId });
    await completed(issue.id);
    await finish(issue.id); await quiet();
  }, 90_000);
  it("fences nested assignment writes until outer commit and ignores rollback", async () => {
    const f = await fixture();
    const providerFailures = await state.completingProvider(f);
    await start(); await quiet();
    let committedId = "";
    await state.db.transaction(async outer => {
      await outer.transaction(async nested => {
        const issue = await issueService(state.db).create(f.companyId, { title: "Nested commit", status: "todo", assigneeAgentId: f.agentId }, nested);
        committedId = issue.id;
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await state.db.select().from(heartbeatRuns)).toHaveLength(0);
    });
    await completed(committedId); await finish(committedId); await settled();
    await expect(state.db.transaction(async outer => {
      await outer.transaction(async nested => {
        await issueService(state.db).create(f.companyId, { title: "Nested rollback", status: "todo", assigneeAgentId: f.agentId }, nested);
      });
      throw new Error("rollback control");
    })).rejects.toThrow("rollback control");
    await quiet();
    expect(await state.db.select().from(issues).where(eq(issues.title, "Nested rollback"))).toHaveLength(0);
    expect(providerFailures).toEqual([]);
    expect(await state.db.select().from(heartbeatRuns)).toHaveLength(1);
  }, 90_000);
  it("retains the first committed assignment during drain and executes on resume", async () => {
    const f = await fixture(); await start(); await quiet(); state.draining = true;
    const issue = await issueService(state.db).create(f.companyId, { title: "Drained assignment", status: "todo", assigneeAgentId: f.agentId });
    await new Promise(resolve => setTimeout(resolve, 100));
    const reads = vi.spyOn(state.db, "select");
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try { await vi.advanceTimersByTimeAsync(90_000); expect(reads).not.toHaveBeenCalled(); }
    finally { vi.useRealTimers(); reads.mockRestore(); }
    expect(await state.db.select().from(heartbeatRuns)).toHaveLength(0);
    state.draining = false; state.worker.wake(); state.dispatch.wake();
    await completed(issue.id); await finish(issue.id); await quiet();
  }, 90_000);

  async function scopedStart() {
    const f = await fixture(); await start({}); await settled({ backstopPending: true });
    const task = async (status: "todo" | "in_progress" | "done") => (await state.db.insert(issues).values({ companyId: f.companyId,
      title: `Task ${status}`, status, assigneeAgentId: f.agentId }).returning())[0];
    const run = async (issueId: string, values: Partial<typeof heartbeatRuns.$inferInsert>) => (await state.db.insert(heartbeatRuns)
      .values({ companyId: f.companyId, agentId: f.agentId, contextSnapshot: { issueId }, ...values }).returning())[0];
    return { f, task, run };
  }
  async function recovered(issueId: string, sourceRunId: string) {
    await vi.waitFor(async () => {
      const runs = await state.db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`);
      const actions = await state.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
      expect(runs.filter(row => row.id !== sourceRunId).length + actions.length).toBeGreaterThan(0);
    }, { timeout: 15_000 });
  }
  it("restarts a task whose run failed from that run's own hint", async () => {
    const { f, task, run } = await scopedStart();
    const issue = await task("in_progress");
    const failed = await run(issue.id, { status: "failed", errorCode: "adapter_failed", finishedAt: new Date() });
    await state.db.transaction(tx => notifyExecutionRunWork(tx, { companyId: f.companyId, runId: failed.id, agentId: f.agentId }));
    await recovered(issue.id, failed.id); await finish(issue.id);
  }, 90_000);
  it("starts the agent's queued task when its run ends and frees the agent", async () => {
    const { f, task, run } = await scopedStart();
    const previous = await task("done");
    const ended = await run(previous.id, { status: "succeeded", finishedAt: new Date() });
    const next = await task("todo");
    await run(next.id, { status: "queued", invocationSource: "assignment", triggerDetail: "system" });
    await state.db.transaction(tx => notifyExecutionRunWork(tx, { companyId: f.companyId, runId: ended.id, agentId: f.agentId }));
    await completed(next.id); await finish(next.id);
  }, 90_000);
  it("restarts a task whose run the system cancelled", async () => {
    const { f, task, run } = await scopedStart();
    const issue = await task("in_progress");
    const cancelled = await run(issue.id, { status: "cancelled", finishedAt: new Date() });
    await state.db.transaction(tx => notifyNativeStatusReassessment(tx, { companyId: f.companyId, runId: cancelled.id }));
    await recovered(issue.id, cancelled.id); await finish(issue.id);
  }, 90_000);
  it("restarts a task whose run vanished without a final event once its lease lapses", async () => {
    const f = await fixture();
    const [issue] = await state.db.insert(issues).values({ companyId: f.companyId, title: "Lost run", status: "in_progress",
      assigneeAgentId: f.agentId }).returning();
    const [lost] = await state.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running",
      runtimeMode: "legacy", controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() + 5_000),
      contextSnapshot: { issueId: issue.id }, processPid: 2_000_000_000, startedAt: new Date() }).returning();
    await state.db.update(issues).set({ executionRunId: lost.id, checkoutRunId: lost.id }).where(eq(issues.id, issue.id));
    await start({});
    await recovered(issue.id, lost.id);
    expect((await state.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, lost.id)))[0].status).not.toBe("running");
    await finish(issue.id);
  }, 90_000);
});
