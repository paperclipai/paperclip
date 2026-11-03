import { setImmediate as immediate } from "node:timers/promises";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, heartbeatRuns, issueRecoveryActions, issueRelations, issues, issueWatchdogs } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { registerIssueRecoveryWork } from "../services/recovery/work.js";
import { notifyIssueRecovery } from "../services/issue-recovery-notifications.js";
import { taskWatchdogService } from "../services/task-watchdogs.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

describeIssueRecovery("issue recovery production producers and deadlines", () => {
  const state = issueRecoveryFixture();
  const { start, compete, fixture, completingProvider, settled, quiet, finish, completed } = state;
  it("keeps empty, configured idle, and terminal history quiet", async () => {
    await fixture(); await start(); await quiet();
  });
  it("creates a blocking child through the ordinary root service transaction", async () => {
    const f = await fixture();
    const parent = await issueService(state.db).create(f.companyId, { title: "Parent", status: "todo" });
    const child = await issueService(state.db).createChild(parent.id, { title: "Blocking child", status: "todo", blockParentUntilDone: true });
    expect(child.parentBlockerAdded).toBe(true);
    expect(await state.db.select().from(issueRelations).where(and(eq(issueRelations.companyId, f.companyId),
      eq(issueRelations.issueId, child.issue.id), eq(issueRelations.relatedIssueId, parent.id)))).toHaveLength(1);
  });
  it("bounds subsidiary scans for100 assignment candidates and coalesces repeated company writes", async () => {
    const f = await fixture(), foreign = await fixture();
    await state.db.update(agents).set({ lifecycleState: "preparing" }).where(eq(agents.id, f.agentId));
    await state.db.insert(issues).values(Array.from({ length: 100 }, (_, index) => ({ companyId: f.companyId,
      title: `Waiting setup ${index}`, status: "todo", assigneeAgentId: f.agentId })));
    const [source] = await state.db.insert(issues).values({ companyId: f.companyId, title: "Done source", status: "done" }).returning();
    const action = await issueRecoveryActionService(state.db).upsertSourceScoped({ companyId: f.companyId, sourceIssueId: source.id,
      kind: "stranded_assigned_issue", ownerType: "agent", ownerAgentId: f.agentId, cause: "stranded_assigned_issue",
      fingerprint: "query-budget", nextAction: "Restore work", wakePolicy: { type: "wake_owner" }, evidence: {} });
    const scans = { blockers: 0, actions: 0, loads: 0 };
    const originalSelect = state.db.select.bind(state.db);
    vi.spyOn(state.db, "select").mockImplementation(((fields?: Record<string, unknown>) => {
      const query = originalSelect(fields as never); const from = query.from.bind(query);
      query.from = ((table: unknown) => {
        if (table === issues && fields?.id === issues.id && fields.companyId === issues.companyId && Object.keys(fields).length === 2) scans.loads++;
        if (table === issueRelations && fields?.createdByAgentId === issues.createdByAgentId) scans.blockers++;
        if (table === issueRecoveryActions && fields?.action === issueRecoveryActions) scans.actions++;
        return from(table as never);
      }) as typeof query.from;
      return query;
    }) as typeof state.db.select);
    await start(); await settled();
    expect(scans.actions).toBe(1); expect(scans.blockers).toBe(0); expect(scans.loads).toBeLessThanOrEqual(8);
    expect((await originalSelect().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0].status).toBe("resolved");
    const [foreignSource] = await state.db.insert(issues).values({ companyId: foreign.companyId, title: "Foreign done", status: "done" }).returning();
    const [foreignAction] = await state.db.insert(issueRecoveryActions).values({ companyId: foreign.companyId, sourceIssueId: foreignSource.id,
      kind: "stranded_assigned_issue", ownerType: "board", cause: "stranded_assigned_issue", fingerprint: "foreign-query-budget", nextAction: "Inspect" }).returning();
    const before = { ...scans };
    for (let index = 0; index < 100; index++) await state.db.transaction(tx => notifyIssueRecovery(tx, { companyId: f.companyId }));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(scans.loads).toBe(before.loads);
    await settled();
    expect(scans.actions).toBe(before.actions); expect(scans.blockers).toBe(before.blockers);
    expect(scans.loads).toBeLessThanOrEqual(before.loads + 4);
    expect((await originalSelect().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, foreignAction.id)))[0].status).toBe("active");
    expect(await originalSelect().from(heartbeatRuns)).toHaveLength(0); await quiet();
  });
  it("limits an ordinary comment to its issue among one thousand open assignments", async () => {
    const f = await fixture();
    const rows = await state.db.insert(issues).values(Array.from({ length: 1000 }, (_, index) => ({
      companyId: f.companyId, title: `Open work ${index}`, status: "todo", assigneeAgentId: f.agentId,
    }))).returning({ id: issues.id });
    const checked: string[] = [];
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    state.coordinator = createDeliveryWorkCoordinator({ owner: state.db, canRun: () => true, onError: error => state.errors.push(error) });
    const register = state.coordinator.register.bind(state.coordinator);
    state.coordinator.register = (queue, task) => register(queue, { ...task, run: signal => {
      const pass = task.run(signal); state.passes.add(pass);
      void pass.then(() => state.passes.delete(pass), () => state.passes.delete(pass));
      return pass;
    } });
    // Observe the actual paged reconstruction boundary without executing one
    // thousand adapters. The producer, transaction, coordinator and SQL are real;
    // the other acceptance cases exercise the resulting recovery decisions.
    state.worker = registerIssueRecoveryWork(state.db, state.coordinator, {
      stranded: async scope => { checked.push(scope.issueId); },
      orphanBlockers: async () => {}, recoveryActions: async () => {},
      dependencies: async () => ({ enqueueFailed: 0 }), locks: async () => {},
      watchdogs: async () => ({ incomplete: 0 }), schedulingSuppressed: async () => false,
    }, () => true);
    await state.worker.ready;
    async function settleWork() {
      for (let step = 0; step < 120; step++) {
        await vi.advanceTimersByTimeAsync(1000);
        await Promise.allSettled([...state.passes]); await immediate();
        if (state.coordinator.nextWakeAt() === null && idleWorkSnapshot().active === 0) return;
      }
      throw new Error("Recovery did not settle its committed work within two virtual minutes");
    }
    await settleWork();
    expect(new Set(checked).size).toBe(1000);
    checked.length = 0;
    await issueService(state.db).addComment(rows[0].id, "New evidence on this task", { userId: "recovery-user" });
    await settleWork();
    expect(checked).toEqual([rows[0].id]);
    // Company eligibility changes still reconstruct all assignments. Narrowing
    // comment hints must not hide unrelated work after an operator resumes it.
    checked.length = 0;
    await state.db.transaction(tx => notifyIssueRecovery(tx, { companyId: f.companyId }));
    await settleWork();
    expect(new Set(checked).size).toBe(1000);
    await quiet();
  });
  it("uses ordinary watchdog configuration and subtree closure to dispatch a reusable review", async () => {
    const f = await fixture();
    const source = await issueService(state.db).create(f.companyId, { title: "Finished subtree", status: "done" });
    const failures = await completingProvider(f, () => taskWatchdogService(state.db).disableForIssue(f.companyId, source.id));
    await start(); await quiet();
    await compete();
    const watchdog = await taskWatchdogService(state.db).upsertForIssue(f.companyId, source.id, { agentId: f.agentId });
    let reviewId: string | undefined;
    await vi.waitFor(async () => {
      const [row] = await state.db.select().from(issueWatchdogs).where(eq(issueWatchdogs.id, watchdog.watchdog.id));
      expect(row.watchdogIssueId).toBeTruthy(); reviewId = row.watchdogIssueId!;
    }, { timeout: 15_000 });
    await completed(reviewId!);
    expect(failures).toEqual([]);
    expect(await state.db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' = 'task_watchdog_stopped_subtree'`))).toHaveLength(1);
    await finish(reviewId!);
    await taskWatchdogService(state.db).disableForIssue(f.companyId, source.id);
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); await quiet();
  }, 90_000);
  it("bounds ordinary writes to their company and reconstructs foreign stale debt after restart", async () => {
    const selected = await fixture(); await start(); await quiet();
    const foreign = await fixture();
    const [run] = await state.db.insert(heartbeatRuns).values({ companyId: foreign.companyId, agentId: foreign.agentId,
      status: "failed", finishedAt: new Date() }).returning();
    const [stale] = await state.db.insert(issues).values({ companyId: foreign.companyId, title: "Foreign stale lock", status: "done",
      checkoutRunId: run.id }).returning();
    await issueService(state.db).create(selected.companyId, { title: "Selected change", status: "done" }); await quiet();
    expect((await state.db.select().from(issues).where(eq(issues.id, stale.id)))[0].checkoutRunId).toBe(run.id);
    await state.worker.stop(); await state.dispatch.stop(); await state.cancellation.stop(); await state.coordinator.stop();
    state.heartbeat = heartbeatService(state.db); await start(); await quiet();
    expect((await state.db.select().from(issues).where(eq(issues.id, stale.id)))[0].checkoutRunId).toBeNull();
  });
  it("retains a fresh subtree's exact first-run grace then disarms on disable", async () => {
    const f = await fixture();
    const source = await issueService(state.db).create(f.companyId, { title: "Fresh unassigned subtree", status: "todo" });
    await start(); await quiet();
    await taskWatchdogService(state.db).upsertForIssue(f.companyId, source.id, { agentId: f.agentId });
    await vi.waitFor(() => expect(state.coordinator.nextWakeAt()).toBe(source.createdAt.getTime() + 15_000), { timeout: 5_000 });
    expect(await state.db.select().from(issues).where(eq(issues.originKind, "task_watchdog"))).toHaveLength(0);
    await taskWatchdogService(state.db).disableForIssue(f.companyId, source.id);
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); await quiet();
  });
  it("waits for a live foreign controller's exact stored lease before clearing a terminal lock", async () => {
    const f = await fixture();
    const source = await issueService(state.db).create(f.companyId, { title: "Remote owner", status: "done" });
    const lease = new Date(Date.now() + 5_000);
    const [run] = await state.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running",
      runtimeMode: "legacy", controllerBootId: randomUUID(), controllerLeaseExpiresAt: lease,
      contextSnapshot: { issueId: source.id }, processPid: 2_000_000_000, startedAt: new Date() }).returning();
    await state.db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, source.id));
    await start();
    await vi.waitFor(() => expect(state.coordinator.nextWakeAt()).toBe(lease.getTime()), { timeout: 3_000 });
    expect((await state.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].status).toBe("running");
    await vi.waitFor(async () => expect((await state.db.select().from(issues).where(eq(issues.id, source.id)))[0].executionRunId).toBeNull(), { timeout: 12_000 });
    expect((await state.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].status).toBe("succeeded");
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); await quiet();
  }, 90_000);
});
