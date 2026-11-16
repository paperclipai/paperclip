import { randomUUID } from "node:crypto";
import { setImmediate as immediate } from "node:timers/promises";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, subscribeDatabaseWork } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../services/delivery-work-notifications.js";
import { executionControlSchedule, registerExecutionControlWork } from "../services/execution-control-work.js";
import { reconcileAbandonedExecutionControl } from "../services/execution-control-reconciliation.js";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";
import { nextAbandonedNativeOwnerReleaseAt, resetAbandonedNativeOwnerReleaseForTests } from "../services/native-runtime/native-failed-run-owner-release.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

describeIssueRecovery("failed native runs held by an unverifiable foreign controller", () => {
  const state = issueRecoveryFixture();

  async function seedTask(f: { companyId: string; agentId: string }, status: "in_progress" | "done" | "cancelled") {
    const db = state.db;
    const issueId = randomUUID(), runId = randomUUID();
    const leaseExpiresAt = new Date(Date.now() - 40 * 60_000);
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: `Native task ${status}`, status,
      assigneeAgentId: f.agentId, workMode: "standard", executionRunId: null, checkoutRunId: null,
      ...(status === "done" ? { completedAt: new Date() } : status === "cancelled" ? { cancelledAt: new Date() } : {}) });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: issueId,
      status: "failed", runtimeMode: "native", runtimeModeResolvedAt: new Date(), contextSnapshot: { issueId },
      startedAt: new Date(Date.now() - 60 * 60_000), finishedAt: new Date(Date.now() - 50 * 60_000), errorCode: "setup_failed" });
    await db.insert(nativeRunFinalizations).values({ runId, companyId: f.companyId, issueId, phase: "observed", attempt: 1,
      leaseOwner: `foreign:${randomUUID()}`, leaseExpiresAt, controllerBootId: randomUUID(), controllerHostHash: null,
      recoveryState: "awaiting_evidence" });
    if (status !== "in_progress") {
      await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
        status: "resolved", ownerType: "board", returnOwnerAgentId: f.agentId, cause: "native_restart_recovery_blocked",
        fingerprint: `native-controller-space:${runId}:${"0".repeat(64)}`, attemptCount: 0, outcome: "restored",
        resolutionNote: "source_terminal", resolvedAt: new Date(leaseExpiresAt.getTime() - 60_000),
        evidence: { runId, reason: "controller_process_space_unverified", executorStopEvidence: "unverified" },
        nextAction: "The server running this task restarted. Paperclip continues the task in a fresh run from its saved work shortly." });
    }
    return { issueId, runId };
  }

  async function advance(ms: number) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await vi.advanceTimersByTimeAsync(Math.min(500, until - Date.now()));
      await Promise.allSettled([...state.passes]); await immediate();
    }
  }

  async function measure(work: () => Promise<unknown>) {
    const statements: string[] = [], signals: string[] = [], prior = state.db.$client.options.debug;
    const unsubscribes = Object.values(DELIVERY_QUEUES).map(queue => subscribeDatabaseWork(state.db, queue, event => {
      if (event === "settled") signals.push(queue);
    }));
    state.db.$client.options.debug = (_connection, query) => { statements.push(query); };
    try { await work(); } finally {
      state.db.$client.options.debug = prior;
      for (const unsubscribe of unsubscribes) unsubscribe();
    }
    return {
      statements: statements.length,
      attentionInserts: statements.filter(query => query.startsWith("insert into \"issue_recovery_actions\"")).length,
      attentionWrites: statements.filter(query => /^(insert into|update) "issue_recovery_actions"/.test(query)).length,
      runWrites: statements.filter(query => query.startsWith("update \"heartbeat_runs\"")).length,
      signals: signals.length,
    };
  }

  async function start() {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    resetAbandonedNativeOwnerReleaseForTests();
    await state.start({});
    const schedule = executionControlSchedule(state.db);
    await registerExecutionControlWork(state.coordinator, [
      { queue: DELIVERY_QUEUES.executionFinalization, run: () => reconcileAbandonedExecutionControl(state.db, new Date()),
        next: schedule.finalization },
      { queue: DELIVERY_QUEUES.executionDisposition, run: () => settleUnrecoverableExecutions(state.db), next: schedule.disposition },
    ]).ready;
  }

  const rowsFor = (issueId: string) => state.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));

  it("stays quiet after a live task's surfaced attention is settled", async () => {
    const f = await state.fixture();
    await state.db.update(agents).set({ status: "error" }).where(eq(agents.id, f.agentId));
    const tasks = [await seedTask(f, "in_progress"), await seedTask(f, "in_progress"), await seedTask(f, "in_progress")];
    await start();
    for (let minute = 0; minute < 30; minute++) {
      await advance(60_000);
      const active = await state.db.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, f.companyId), eq(issueRecoveryActions.status, "active")));
      const resolved = await state.db.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, f.companyId), eq(issueRecoveryActions.status, "resolved")));
      if (active.length === 0 && resolved.length === tasks.length) break;
    }
    for (const task of tasks) {
      expect(await rowsFor(task.issueId)).toEqual([expect.objectContaining({ status: "resolved",
        resolutionNote: "continued_fresh_from_last_saved", fingerprint: expect.stringContaining(`native-controller-space:${task.runId}:`) })]);
    }
    expect(await nextAbandonedNativeOwnerReleaseAt(state.db)).toBeNull();
    const idle = await measure(async () => {
      for (let wake = 0; wake < 6; wake++) {
        await state.db.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.executionFinalization));
        await advance(5 * 60_000);
      }
    });
    expect({ attentionWrites: idle.attentionWrites, runWrites: idle.runWrites, signals: idle.signals })
      .toEqual({ attentionWrites: 0, runWrites: 0, signals: 6 });
    expect(idle.statements).toBeLessThan(6 * 60);
    expect(await state.db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId),
      eq(issueRecoveryActions.status, "active")))).toEqual([]);
  }, 300_000);

  it("never surfaces attention for finished tasks and surfaces a live task exactly once", async () => {
    const f = await state.fixture();
    await state.db.update(agents).set({ status: "error" }).where(eq(agents.id, f.agentId));
    const done = await seedTask(f, "done");
    const cancelled = await seedTask(f, "cancelled");
    const live = await seedTask(f, "in_progress");
    const idle = await measure(async () => {
      await start();
      await advance(30 * 60_000);
    });
    for (const task of [done, cancelled]) {
      expect(await rowsFor(task.issueId)).toEqual([expect.objectContaining({ status: "resolved", resolutionNote: "source_terminal" })]);
    }
    const liveRows = await rowsFor(live.issueId);
    expect(liveRows).toEqual([expect.objectContaining({ cause: "native_restart_recovery_blocked",
      fingerprint: expect.stringContaining(`native-controller-space:${live.runId}:`),
      evidence: expect.objectContaining({ runId: live.runId, reason: "controller_process_space_unverified" }) })]);
    expect(idle.attentionInserts).toBe(1);
    expect(await nextAbandonedNativeOwnerReleaseAt(state.db)).toBeNull();
    expect(await state.db.select({ phase: nativeRunFinalizations.phase }).from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, done.runId))).toEqual([{ phase: "observed" }]);
  }, 300_000);
});
