import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { issueRecoveryActions, issues } from "@paperclipai/db";
import { subscribeDatabaseWork } from "@paperclipai/db/work-signals";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { notifyIssueGraphRecovery } from "../services/issue-recovery-notifications.js";
import { recoveryService } from "../services/recovery/service.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

const TASK_QUEUES = [DELIVERY_QUEUES.strandedAssignments, DELIVERY_QUEUES.assignedWorkInvariant,
  DELIVERY_QUEUES.resolvedDependencies, DELIVERY_QUEUES.staleIssueLocks];
const WATCHED = [...TASK_QUEUES, DELIVERY_QUEUES.orphanBlockers, DELIVERY_QUEUES.activeRecoveryActions,
  DELIVERY_QUEUES.taskWatchdogs, DELIVERY_QUEUES.queuedRunDispatch, DELIVERY_QUEUES.executionDisposition];

describeIssueRecovery("issue recovery signal fan-out", () => {
  const state = issueRecoveryFixture();

  function record(owner: object) {
    const settled: Array<[string, string[]]> = [];
    const stops = WATCHED.map(queue => subscribeDatabaseWork(owner, queue, (event, hints) => {
      if (event === "settled") settled.push([queue, [...hints ?? []]]);
    }));
    return { settled, stop: () => { for (const stop of stops) stop(); } };
  }

  it("publishes one graph hint per task queue and no per-queue backstop twin", async () => {
    const f = await state.fixture();
    const [task] = await state.db.insert(issues).values({ companyId: f.companyId, title: "Task", status: "todo" }).returning();
    const recorder = record(state.db);
    try {
      await state.db.transaction(tx => notifyIssueGraphRecovery(tx, { companyId: f.companyId, issueId: task.id }));
    } finally { recorder.stop(); }
    const taskHints = recorder.settled.filter(([queue]) => TASK_QUEUES.includes(queue as never)).flatMap(([, hints]) => hints);
    expect(taskHints).toHaveLength(TASK_QUEUES.length);
    expect(taskHints.every(hint => JSON.parse(hint).graphIssueId === task.id)).toBe(true);
    expect(recorder.settled.flatMap(([, hints]) => hints).some(hint => hint.includes("\"backstop\""))).toBe(false);
  });

  it("resolves nothing and signals nothing when the issue has no matching active recovery action", async () => {
    const f = await state.fixture();
    const [task] = await state.db.insert(issues).values({ companyId: f.companyId, title: "Done", status: "done" }).returning();
    const [resolved] = await state.db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: task.id,
      kind: "stranded_assigned_issue", status: "resolved", ownerType: "agent", ownerAgentId: f.agentId,
      cause: "stranded_assigned_issue", fingerprint: "already-resolved", nextAction: "Done", outcome: "restored",
      resolvedAt: new Date(), evidence: {} }).returning();
    const recorder = record(state.db);
    const actions = issueRecoveryActionService(state.db);
    try {
      expect(await actions.resolveActiveForIssue({ companyId: f.companyId, sourceIssueId: task.id, actionId: resolved.id,
        status: "resolved", outcome: "restored", resolutionNote: "source_terminal" })).toBeNull();
      expect(await actions.resolveActiveForIssue({ companyId: f.companyId, sourceIssueId: task.id,
        status: "cancelled", outcome: "cancelled", resolutionNote: "source_state_changed" })).toBeNull();
    } finally { recorder.stop(); }
    expect(recorder.settled).toEqual([]);
  });

  it("still resolves an active action and wakes its task graph", async () => {
    const f = await state.fixture();
    const [task] = await state.db.insert(issues).values({ companyId: f.companyId, title: "Done", status: "done" }).returning();
    const [active] = await state.db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: task.id,
      kind: "stranded_assigned_issue", status: "escalated", ownerType: "agent", ownerAgentId: f.agentId,
      cause: "stranded_assigned_issue", fingerprint: "escalated", nextAction: "Restore", evidence: {} }).returning();
    const recorder = record(state.db);
    let result;
    try {
      result = await issueRecoveryActionService(state.db).resolveActiveForIssue({ companyId: f.companyId, sourceIssueId: task.id,
        actionId: active.id, status: "resolved", outcome: "restored", resolutionNote: "source_terminal" });
    } finally { recorder.stop(); }
    expect(result).toMatchObject({ id: active.id, status: "resolved", outcome: "restored" });
    expect(recorder.settled.filter(([queue]) => queue === DELIVERY_QUEUES.strandedAssignments).flatMap(([, hints]) => hints)
      .map(hint => JSON.parse(hint))).toContainEqual({ companyId: f.companyId, graphIssueId: task.id });
  });

  async function blockedAttention(companyId: string, sourceIssueId: string, agentId: string, fingerprint = "native-controller-space:run:digest") {
    return issueRecoveryActionService(state.db).upsertSourceScoped({ companyId, sourceIssueId, kind: "active_run_watchdog",
      ownerType: "board", returnOwnerAgentId: agentId, cause: "native_restart_recovery_blocked", fingerprint,
      evidence: { runId: "run", reason: "controller_process_space_unverified", executorStopEvidence: "unverified" },
      nextAction: "Wait for the previous controller to stop" });
  }

  it("does not re-open attention that recovery settled because its task finished", async () => {
    const f = await state.fixture();
    const [task] = await state.db.insert(issues).values({ companyId: f.companyId, title: "Cancelled", status: "cancelled" }).returning();
    const recovery = recoveryService(state.db, { enqueueWakeup: async () => null });
    await blockedAttention(f.companyId, task.id, f.agentId);
    await recovery.reconcileActiveRecoveryActions({ companyId: f.companyId });
    const recorder = record(state.db);
    try {
      for (let cycle = 0; cycle < 5; cycle++) {
        const surfaced = await blockedAttention(f.companyId, task.id, f.agentId);
        expect(surfaced.status).toBe("resolved");
        await recovery.reconcileActiveRecoveryActions({ companyId: f.companyId });
      }
    } finally { recorder.stop(); }
    const rows = await state.db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, f.companyId), eq(issueRecoveryActions.sourceIssueId, task.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "resolved", outcome: "restored", resolutionNote: "source_terminal" });
    expect(recorder.settled.filter(([queue]) => queue === DELIVERY_QUEUES.strandedAssignments
      || queue === DELIVERY_QUEUES.activeRecoveryActions)).toEqual([]);
  });

  it("settles a finished task's attention without waking run dispatch or its task graph", async () => {
    const f = await state.fixture();
    const [task] = await state.db.insert(issues).values({ companyId: f.companyId, title: "Done", status: "done" }).returning();
    await blockedAttention(f.companyId, task.id, f.agentId);
    const recorder = record(state.db);
    try {
      expect(await recoveryService(state.db, { enqueueWakeup: async () => null }).reconcileActiveRecoveryActions({ companyId: f.companyId }))
        .toMatchObject({ resolved: 1 });
    } finally { recorder.stop(); }
    expect(recorder.settled.filter(([queue]) => queue !== DELIVERY_QUEUES.executionDisposition)
      .filter(([queue]) => [...TASK_QUEUES, DELIVERY_QUEUES.queuedRunDispatch, DELIVERY_QUEUES.activeRecoveryActions].includes(queue as never)))
      .toEqual([]);
  });

  it("surfaces attention again once the task is reopened, and for a new controller authority", async () => {
    const f = await state.fixture();
    const [task] = await state.db.insert(issues).values({ companyId: f.companyId, title: "Cancelled", status: "cancelled" }).returning();
    const recovery = recoveryService(state.db, { enqueueWakeup: async () => null });
    await blockedAttention(f.companyId, task.id, f.agentId);
    await recovery.reconcileActiveRecoveryActions({ companyId: f.companyId });
    expect((await blockedAttention(f.companyId, task.id, f.agentId, "native-controller-space:run:renewed")).status).toBe("active");
    await recovery.reconcileActiveRecoveryActions({ companyId: f.companyId });
    await state.db.update(issues).set({ status: "todo" }).where(eq(issues.id, task.id));
    const reopened = await blockedAttention(f.companyId, task.id, f.agentId);
    expect(reopened.status).toBe("active");
    await recovery.reconcileActiveRecoveryActions({ companyId: f.companyId });
    expect((await state.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, reopened.id)))[0].status)
      .toBe("active");
  });
});
