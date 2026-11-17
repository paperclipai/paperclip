import { and, eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

describeIssueRecovery("issue recovery production producers and dependencies", () => {
  const state = issueRecoveryFixture();
  const { start, compete, fixture, completingProvider, quiet, finish, completed } = state;
  it.each(["startup", "committed"])("restores blocker-only and completed-action debt with no assignment candidates (%s)", async mode => {
    const f = await fixture();
    if (mode === "committed") { await start(); await quiet(); }
    const blocker = await issueService(state.db).create(f.companyId, { title: "Orphan blocker", status: "blocked", createdByAgentId: f.agentId });
    const dependent = await issueService(state.db).create(f.companyId, { title: "Blocked dependent", status: "blocked", blockedByIssueIds: [blocker.id] });
    const completedSource = await issueService(state.db).create(f.companyId, { title: "Completed source", status: "done" });
    const action = await issueRecoveryActionService(state.db).upsertSourceScoped({ companyId: f.companyId, sourceIssueId: completedSource.id,
      kind: "stranded_assigned_issue", ownerType: "agent", ownerAgentId: f.agentId, cause: "stranded_assigned_issue",
      fingerprint: "source-terminal", nextAction: "Restore work", wakePolicy: { type: "wake_owner" }, evidence: {} });
    if (mode === "startup") await start();
    await vi.waitFor(async () => {
      expect((await state.db.select().from(issues).where(eq(issues.id, blocker.id)))[0].assigneeAgentId).toBe(f.agentId);
      expect((await state.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0].status).toBe("resolved");
    }, { timeout: 40_000 });
    await finish(blocker.id); await finish(dependent.id); await quiet();
  });
  it("reacts to blocker resolution once and dispatches the durable dependency wake", async () => {
    const f = await fixture();
    const blocker = await issueService(state.db).create(f.companyId, { title: "Blocker", status: "todo" });
    const dependent = await issueService(state.db).create(f.companyId, { title: "Dependent", status: "blocked", assigneeAgentId: f.agentId,
      blockedByIssueIds: [blocker.id] });
    const failures = await completingProvider(f);
    await start(); await quiet();
    await compete();
    await issueService(state.db).update(blocker.id, { status: "done" });
    const run = await completed(dependent.id);
    expect(run.contextSnapshot?.wakeReason).toBe("issue_blockers_resolved");
    expect(failures).toEqual([]);
    await finish(dependent.id); await quiet();
    expect(await state.db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' = 'issue_blockers_resolved'`))).toHaveLength(1);
    expect(await state.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
  }, 90_000);
  it("settles competing recovery inserts after both owners read an empty source", async () => {
    const f = await fixture();
    const issue = await issueService(state.db).create(f.companyId, { title: "Concurrent recovery", status: "todo" });
    const transaction = state.db.transaction.bind(state.db);
    let arrivals = 0, release: () => void = () => {};
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const conflicts: unknown[] = [];
    vi.spyOn(state.db, "transaction").mockImplementation(async (callback, config) => {
      if (++arrivals <= 2) {
        if (arrivals === 2) release();
        await barrier;
      }
      try { return await transaction(callback, config); }
      catch (error) { conflicts.push(error); throw error; }
    });
    const input = { companyId: f.companyId, sourceIssueId: issue.id, kind: "stranded_assigned_issue" as const,
      ownerType: "agent" as const, ownerAgentId: f.agentId, cause: "stranded_assigned_issue",
      fingerprint: "concurrent-source", nextAction: "Restore work", evidence: {} };
    const results = await Promise.allSettled([
      issueRecoveryActionService(state.db).upsertSourceScoped(input),
      issueRecoveryActionService(state.db).upsertSourceScoped(input),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ cause: { code: "23505", constraint_name: "issue_recovery_actions_active_source_uq" } });
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const actions = await state.db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, f.companyId), eq(issueRecoveryActions.sourceIssueId, issue.id)));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: "active", attemptCount: 2, fingerprint: input.fingerprint });
    for (const result of results) if (result.status === "fulfilled") expect(result.value.id).toBe(actions[0].id);
  });
  it("settles saved disposition debt on its original real-clock timers before measuring idle", async () => {
    const f = await fixture();
    const blocker = await issueService(state.db).create(f.companyId, { title: "Saved debt blocker", status: "todo" });
    const issue = await issueService(state.db).create(f.companyId, { title: "Saved disposition debt", status: "blocked",
      assigneeAgentId: f.agentId, blockedByIssueIds: [blocker.id] });
    await start(); await compete();
    await issueService(state.db).update(blocker.id, { status: "done" });
    await completed(issue.id);
    let retryId: string | undefined;
    await vi.waitFor(async () => {
      const [retry] = await state.db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.status, "scheduled_retry"),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`));
      expect(retry).toBeDefined(); retryId = retry!.id;
    }, { timeout: 40_000 });
    await finish(issue.id); await quiet();
    expect((await state.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryId!)))[0].status).toBe("cancelled");
  }, 120_000);

});
