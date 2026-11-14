import { setImmediate as immediate } from "node:timers/promises";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, budgetPolicies, heartbeatRuns, issueRecoveryActions, issueRelations, issues, issueWatchdogs } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { registerIssueRecoveryWork } from "../services/recovery/work.js";
import { recoveryService } from "../services/recovery/service.js";
import { ISSUE_RECOVERY_BACKSTOP_MS, ISSUE_RECOVERY_MAX_ISSUE_IDS, notifyIssueRecovery, resolveIssueGraph }
  from "../services/issue-recovery-notifications.js";
import { notifyNativeStatusReassessment } from "../services/native-status-reassessment-notifications.js";
import { notifyExecutionRunWork } from "../services/execution-control-notifications.js";
import { notifyRunDispatch } from "../services/run-dispatch-notifications.js";
import { promoteDeferredWorkIntents } from "../services/work-intent-outbox.js";
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
    expect(scans.actions).toBe(1); expect(scans.blockers).toBe(0); expect(scans.loads).toBeLessThanOrEqual(11);
    expect((await originalSelect().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0].status).toBe("resolved");
    const [foreignSource] = await state.db.insert(issues).values({ companyId: foreign.companyId, title: "Foreign done", status: "done" }).returning();
    const [foreignAction] = await state.db.insert(issueRecoveryActions).values({ companyId: foreign.companyId, sourceIssueId: foreignSource.id,
      kind: "stranded_assigned_issue", ownerType: "board", cause: "stranded_assigned_issue", fingerprint: "foreign-query-budget", nextAction: "Inspect" }).returning();
    await state.db.transaction(tx => notifyIssueRecovery(tx, { companyId: f.companyId })); await settled();
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
  async function recordedRecovery(owner: Partial<Parameters<typeof registerIssueRecoveryWork>[2]>,
    options?: Parameters<typeof registerIssueRecoveryWork>[4]) {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    state.coordinator = createDeliveryWorkCoordinator({ owner: state.db, canRun: () => true, onError: error => state.errors.push(error) });
    const register = state.coordinator.register.bind(state.coordinator);
    state.coordinator.register = (queue, task) => register(queue, { ...task, run: signal => {
      const pass = task.run(signal); state.passes.add(pass);
      void pass.then(() => state.passes.delete(pass), () => state.passes.delete(pass));
      return pass;
    } });
    state.worker = registerIssueRecoveryWork(state.db, state.coordinator, {
      stranded: async () => {}, orphanBlockers: async () => {}, recoveryActions: async () => {},
      dependencies: async () => ({ enqueueFailed: 0 }), locks: async () => {},
      watchdogs: async () => ({ incomplete: 0 }), schedulingSuppressed: async () => false, ...owner,
    }, () => true, options);
    await state.worker.ready;
  }
  async function settleWork(options: { backstopPending?: boolean } = {}) {
    for (let step = 0; step < 120; step++) {
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.allSettled([...state.passes]); await immediate();
      const next = state.coordinator.nextWakeAt();
      const settledNow = next === null || (options.backstopPending === true && next > Date.now() + 60_000);
      if (settledNow && idleWorkSnapshot().active === 0) return;
    }
    throw new Error("Recovery did not settle its committed work within two virtual minutes");
  }
  async function runGraph(companyId: string, agentId: string) {
    const [other] = await state.db.insert(agents).values({ companyId, name: "Other agent", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: {} }).returning({ id: agents.id });
    const [parent] = await state.db.insert(issues).values({ companyId, title: "Parent", status: "in_progress", assigneeAgentId: agentId })
      .returning({ id: issues.id });
    const [task] = await state.db.insert(issues).values({ companyId, title: "Run task", status: "in_progress", assigneeAgentId: agentId,
      parentId: parent.id }).returning({ id: issues.id });
    const [dependent] = await state.db.insert(issues).values({ companyId, title: "Waits on the run task", status: "todo",
      assigneeAgentId: other.id }).returning({ id: issues.id });
    const [sibling] = await state.db.insert(issues).values({ companyId, title: "Next task of the agent", status: "todo",
      assigneeAgentId: agentId }).returning({ id: issues.id });
    await state.db.insert(issueRelations).values({ companyId, issueId: task.id, relatedIssueId: dependent.id, type: "blocks" });
    const [run] = await state.db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", finishedAt: new Date(),
      contextSnapshot: { issueId: task.id } }).returning({ id: heartbeatRuns.id });
    const backlog = async (count: number) => (await state.db.insert(issues).values(Array.from({ length: count }, (_, index) => ({
      companyId, title: `Backlog ${index}`, status: "todo", assigneeAgentId: other.id,
    }))).returning({ id: issues.id })).map(row => row.id);
    return { runId: run.id, taskId: task.id, siblingId: sibling.id, backlog, affected: [parent.id, task.id, dependent.id].sort() };
  }
  it("limits an ordinary comment to its issue among one thousand open assignments", async () => {
    const f = await fixture();
    const rows = await state.db.insert(issues).values(Array.from({ length: 1000 }, (_, index) => ({
      companyId: f.companyId, title: `Open work ${index}`, status: "todo", assigneeAgentId: f.agentId,
    }))).returning({ id: issues.id });
    const checked: string[] = [];
    await recordedRecovery({ stranded: async scope => { checked.push(scope.issueId); } });
    await settleWork();
    expect(new Set(checked).size).toBe(1000);
    checked.length = 0;
    await issueService(state.db).addComment(rows[0].id, "New evidence on this task", { userId: "recovery-user" });
    await settleWork({ backstopPending: true });
    expect(checked).toEqual([rows[0].id]);
    checked.length = 0;
    await state.db.transaction(tx => notifyIssueRecovery(tx, { companyId: f.companyId }));
    await settleWork({ backstopPending: true });
    expect(new Set(checked).size).toBe(1000);
    await vi.advanceTimersByTimeAsync(ISSUE_RECOVERY_BACKSTOP_MS);
    await settleWork();
    await quiet();
  });
  it("re-checks only the tasks a run lifecycle event can affect, whatever the backlog", async () => {
    const f = await fixture();
    const graph = await runGraph(f.companyId, f.agentId);
    await graph.backlog(1000);
    const checked: string[] = [];
    const assigned: string[] = [];
    await recordedRecovery({
      stranded: async scope => { checked.push(scope.issueId); },
      assignedWork: {
        listSuspects: (scope, cursor, limit) => recoveryService(state.db, { enqueueWakeup: async () => null })
          .assignedWork.listSuspects(scope, cursor, limit),
        checkIssue: async scope => { assigned.push(scope.issueId); },
      },
    }, { backstopMs: 60 * 60_000 });
    await settleWork({ backstopPending: true });
    expect(new Set(checked).size).toBe(1004);
    expect(checked).toContain(graph.siblingId);
    async function lifecycleEvent(producer: (tx: object) => Promise<unknown>, standalone?: () => Promise<unknown>) {
      checked.length = 0; assigned.length = 0;
      const statements: string[] = [], prior = state.db.$client.options.debug;
      state.db.$client.options.debug = (_connection, query) => { statements.push(query); };
      try {
        if (standalone) await standalone(); else await state.db.transaction(tx => producer(tx));
        await settleWork({ backstopPending: true });
      } finally { state.db.$client.options.debug = prior; }
      expect([...new Set(checked)].sort()).toEqual(graph.affected);
      expect(assigned.every(id => graph.affected.includes(id))).toBe(true);
      await vi.advanceTimersByTimeAsync(31_000);
      return statements.length;
    }
    const finished = () => (tx: object) => notifyNativeStatusReassessment(tx, { companyId: f.companyId, runId: graph.runId });
    const first = await lifecycleEvent(finished());
    await lifecycleEvent(tx => notifyExecutionRunWork(tx, { companyId: f.companyId, runId: graph.runId, agentId: f.agentId }));
    await lifecycleEvent(tx => notifyRunDispatch(tx, { companyId: f.companyId, issueId: graph.taskId }));
    await lifecycleEvent(tx => promoteDeferredWorkIntents(tx, { companyId: f.companyId, trigger: "lock_released", issueId: graph.taskId }));
    await lifecycleEvent(tx => promoteDeferredWorkIntents(tx, { companyId: f.companyId, trigger: "accounting_settled", runId: graph.runId }));
    const recoveryActions = issueRecoveryActionService(state.db);
    await lifecycleEvent(async () => {}, () => recoveryActions.upsertSourceScoped({ companyId: f.companyId, sourceIssueId: graph.taskId,
      kind: "stranded_assigned_issue", ownerType: "board", cause: "stranded_assigned_issue", fingerprint: "run-failed",
      nextAction: "Choose the next step", evidence: {} }));
    await lifecycleEvent(async () => {}, () => recoveryActions.resolveActiveForIssue({ companyId: f.companyId, sourceIssueId: graph.taskId,
      status: "resolved", outcome: "restored", resolutionNote: "Recovered" }));
    await graph.backlog(4000);
    expect(await lifecycleEvent(finished())).toBe(first);
  });
  it("resolves a run's task graph through index lookups, not the backlog", async () => {
    const f = await fixture();
    const graph = await runGraph(f.companyId, f.agentId);
    await graph.backlog(2000);
    await state.db.execute(sql`analyze issues`);
    await state.db.execute(sql`analyze heartbeat_runs`);
    const [read] = await state.db.transaction(async tx => {
      expect(await resolveIssueGraph(tx as unknown as typeof state.db, { companyId: f.companyId, runId: graph.runId })).toEqual(graph.affected);
      return tx.execute<{ rows: number }>(sql`select (coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0))::int as rows
        from pg_stat_xact_user_tables where relname = 'issues'`);
    });
    expect(read.rows).toBeLessThan(50);
  });
  it("finds a stranded task outside the affected set within the backstop bound", async () => {
    const f = await fixture();
    const graph = await runGraph(f.companyId, f.agentId);
    await graph.backlog(50);
    const checkedAt = new Map<string, number>();
    await recordedRecovery({ stranded: async scope => { checkedAt.set(scope.issueId, Date.now()); } });
    await settleWork({ backstopPending: true });
    const fullPassAt = Date.now();
    const [unrelated] = await graph.backlog(1);
    checkedAt.clear();
    await state.db.transaction(tx => notifyNativeStatusReassessment(tx, { companyId: f.companyId, runId: graph.runId }));
    await settleWork({ backstopPending: true });
    expect(checkedAt.has(unrelated)).toBe(false);
    expect(state.coordinator.nextWakeAt()).toBeLessThanOrEqual(fullPassAt + ISSUE_RECOVERY_BACKSTOP_MS);
    await vi.advanceTimersByTimeAsync(ISSUE_RECOVERY_BACKSTOP_MS);
    await settleWork();
    expect(checkedAt.get(unrelated)! - fullPassAt).toBeLessThanOrEqual(ISSUE_RECOVERY_BACKSTOP_MS + 5_000);
    checkedAt.clear();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(checkedAt.size).toBe(0);
    const [later] = await graph.backlog(1);
    const eventAt = Date.now();
    await state.db.transaction(tx => notifyNativeStatusReassessment(tx, { companyId: f.companyId, runId: graph.runId }));
    await settleWork();
    expect(checkedAt.get(later)! - eventAt).toBeLessThanOrEqual(5_000);
    await quiet();
  });
  it("keeps the company pass for hold releases that can admit any task", async () => {
    const f = await fixture();
    const graph = await runGraph(f.companyId, f.agentId);
    const backlog = await graph.backlog(150);
    const checked: string[] = [];
    await recordedRecovery({ stranded: async scope => { checked.push(scope.issueId); } });
    await settleWork({ backstopPending: true });
    const everything = new Set([...graph.affected, graph.siblingId, ...backlog]);
    await state.db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "company", scopeId: f.companyId,
      metric: "billed_cents", windowKind: "calendar_month_utc", amount: 1000, hardStopEnabled: true, isActive: true });
    for (const input of [{ trigger: "accounting_settled" as const, runId: graph.runId }, { trigger: "pause_lifted" as const }]) {
      checked.length = 0;
      await state.db.transaction(tx => promoteDeferredWorkIntents(tx, { companyId: f.companyId, ...input }));
      await settleWork({ backstopPending: true });
      expect(new Set(checked)).toEqual(everything);
      await vi.advanceTimersByTimeAsync(31_000);
    }
  });
  it("falls back to the company pass when a run affects more tasks than a hint names", async () => {
    const f = await fixture();
    const graph = await runGraph(f.companyId, f.agentId);
    const backlog = await graph.backlog(200);
    const checked: string[] = [];
    await recordedRecovery({ stranded: async scope => { checked.push(scope.issueId); } });
    await settleWork({ backstopPending: true });
    const dependents = await graph.backlog(ISSUE_RECOVERY_MAX_ISSUE_IDS);
    await state.db.insert(issueRelations).values(dependents.map(id => ({ companyId: f.companyId, issueId: graph.taskId,
      relatedIssueId: id, type: "blocks" as const })));
    checked.length = 0;
    await state.db.transaction(tx => notifyNativeStatusReassessment(tx, { companyId: f.companyId, runId: graph.runId }));
    await settleWork({ backstopPending: true });
    expect(new Set(checked)).toEqual(new Set([...graph.affected, graph.siblingId, ...backlog, ...dependents]));
  });
  it("checks only blocked tasks whose blockers are done, however many still wait", async () => {
    const f = await fixture();
    const [openBlocker, doneBlocker] = await state.db.insert(issues).values([
      { companyId: f.companyId, title: "Open blocker", status: "in_progress", assigneeAgentId: f.agentId },
      { companyId: f.companyId, title: "Done blocker", status: "done" },
    ]).returning({ id: issues.id });
    const waiting = await state.db.insert(issues).values(Array.from({ length: 300 }, (_, index) => ({
      companyId: f.companyId, title: `Waiting ${index}`, status: "blocked", assigneeAgentId: f.agentId,
    }))).returning({ id: issues.id });
    const [ready] = await state.db.insert(issues).values({ companyId: f.companyId, title: "Ready", status: "blocked",
      assigneeAgentId: f.agentId }).returning({ id: issues.id });
    await state.db.insert(issueRelations).values([
      ...waiting.map(row => ({ companyId: f.companyId, issueId: openBlocker.id, relatedIssueId: row.id, type: "blocks" as const })),
      { companyId: f.companyId, issueId: doneBlocker.id, relatedIssueId: ready.id, type: "blocks" as const },
    ]);
    const checked: string[] = [];
    await recordedRecovery({ dependencies: async scope => { checked.push(scope.issueId); return { enqueueFailed: 0 }; } });
    await settleWork();
    expect(checked).toEqual([ready.id]);
    checked.length = 0;
    await state.db.transaction(tx => notifyIssueRecovery(tx, { companyId: f.companyId }));
    await settleWork();
    expect(checked).toEqual([ready.id]);
    checked.length = 0;
    await issueService(state.db).update(openBlocker.id, { status: "done" });
    await settleWork({ backstopPending: true });
    expect(new Set(checked)).toEqual(new Set([ready.id, ...waiting.map(row => row.id)]));
    await vi.advanceTimersByTimeAsync(ISSUE_RECOVERY_BACKSTOP_MS);
    await settleWork();
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
