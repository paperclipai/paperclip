import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { heartbeatRuns, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
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
    const f = await fixture(); await start(); await quiet();
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

});
