import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, companies, createDb, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issueRelations,
  issues, type Db,
} from "@paperclipai/db";
import { ISSUE_BLOCKER_STALLED_WAKE_REASON } from "@paperclipai/shared";
import { recoveryService } from "../services/recovery/service.js";
import { issueBlockerStalledWakeKey, listStalledDependencies, recoveryActionSweepCondition, wakeWaitersOfStalledIssues } from "../services/recovery/blocker-stall-wakeups.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_RECOVERY_ACTION_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

// Restart chaos w-20261108T181313-s9701 t05: a child blocked on a board-owned
// recovery action (retries exhausted), and its parent sat silently blocked for
// 50+ minutes because only completion or resolution wakes a parent.
(support.supported ? describe : describe.skip)("issue_blocker_stalled wakes", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("blocker-stall-");
    db = createDb(external ?? temporary!.connectionString);
    db.$client.options.onnotice = () => {};
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  // Records each wake the way the queue does, so the idempotency check sees it.
  function wakeRecorder() {
    const calls: Array<{ agentId: string; input: Record<string, any> }> = [];
    const enqueueWakeup = vi.fn(async (agentId: string, input: Record<string, any>) => {
      calls.push({ agentId, input });
      const [row] = await db.insert(agentWakeupRequests).values({ companyId: input.payload.companyId ?? companyIdOf.get(agentId)!,
        agentId, source: input.source, triggerDetail: input.triggerDetail, reason: input.reason, payload: input.payload,
        idempotencyKey: input.idempotencyKey, status: "queued" }).returning();
      return { id: row.id };
    });
    return { calls, enqueueWakeup };
  }
  const companyIdOf = new Map<string, string>();

  async function fixture(options: { ownerType?: "board" | "agent"; status?: "active" | "escalated" } = {}) {
    const companyId = randomUUID(), parentAgent = randomUUID(), childAgent = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stall", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: parentAgent, companyId, name: "Parent owner", role: "engineer", status: "idle" },
      { id: childAgent, companyId, name: "Child owner", role: "engineer", status: "idle" },
    ]);
    companyIdOf.set(parentAgent, companyId); companyIdOf.set(childAgent, companyId);
    const [parent] = await db.insert(issues).values({ companyId, title: "Parent", status: "blocked", assigneeAgentId: parentAgent }).returning();
    const [child] = await db.insert(issues).values({ companyId, title: "Child", status: "blocked", parentId: parent.id,
      assigneeAgentId: childAgent }).returning();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: child.id,
      kind: "run_recovery", status: options.status ?? "escalated", ownerType: options.ownerType ?? "board",
      cause: "execution_recovery_budget_exhausted", fingerprint: "fixture", nextAction: "Retry the run or reassign the task" }).returning();
    return { companyId, parentAgent, childAgent, parent, child, action };
  }

  it("wakes the parent's assignee once per stall, with the stalled child and its recovery action", async () => {
    const f = await fixture();
    const { calls, enqueueWakeup } = wakeRecorder();
    const service = recoveryService(db, { enqueueWakeup: enqueueWakeup as never });
    await service.reconcileActiveRecoveryActions({ companyId: f.companyId });
    await service.reconcileActiveRecoveryActions({ companyId: f.companyId });
    const parentWakes = calls.filter(call => call.input.reason === ISSUE_BLOCKER_STALLED_WAKE_REASON);
    expect(parentWakes).toHaveLength(1);
    expect(parentWakes[0]).toMatchObject({ agentId: f.parentAgent, input: {
      idempotencyKey: issueBlockerStalledWakeKey({ waiterIssueId: f.parent.id, stalledIssueId: f.child.id, recoveryActionId: f.action.id }),
      contextSnapshot: { issueId: f.parent.id, wakeReason: ISSUE_BLOCKER_STALLED_WAKE_REASON, blockerStall: {
        stalledIssueId: f.child.id, stalledIssueStatus: "blocked", relation: "child",
        recoveryAction: { id: f.action.id, status: "escalated", ownerType: "board", nextAction: "Retry the run or reassign the task" },
      } },
    } });
    const activity = await db.select().from(activityLog).where(eq(activityLog.action, "issue.blocker_stalled_wake"));
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ entityId: f.parent.id, actorType: "system" });

    // Unstalled, then stalled again: a new recovery action is a new stall.
    await db.update(issueRecoveryActions).set({ status: "resolved", resolvedAt: new Date() }).where(eq(issueRecoveryActions.id, f.action.id));
    const [again] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.child.id,
      kind: "run_recovery", status: "escalated", ownerType: "board", cause: "execution_recovery_budget_exhausted",
      fingerprint: "fixture-2", nextAction: "Retry" }).returning();
    await service.reconcileActiveRecoveryActions({ companyId: f.companyId });
    const later = calls.filter(call => call.input.reason === ISSUE_BLOCKER_STALLED_WAKE_REASON);
    expect(later).toHaveLength(2);
    expect(later[1]!.input.contextSnapshot.blockerStall.recoveryAction.id).toBe(again.id);
  });

  it("wakes the assignee of an issue the stalled one blocks", async () => {
    const f = await fixture();
    const dependentAgent = randomUUID();
    await db.insert(agents).values({ id: dependentAgent, companyId: f.companyId, name: "Dependent owner", role: "engineer", status: "idle" });
    companyIdOf.set(dependentAgent, f.companyId);
    const [dependent] = await db.insert(issues).values({ companyId: f.companyId, title: "Dependent", status: "blocked",
      assigneeAgentId: dependentAgent }).returning();
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: f.child.id, relatedIssueId: dependent.id, type: "blocks" });
    const { calls, enqueueWakeup } = wakeRecorder();
    await recoveryService(db, { enqueueWakeup: enqueueWakeup as never }).reconcileActiveRecoveryActions({ companyId: f.companyId });
    const stalled = calls.filter(call => call.input.reason === ISSUE_BLOCKER_STALLED_WAKE_REASON);
    expect(stalled.map(call => [call.agentId, call.input.contextSnapshot.blockerStall.relation]).sort())
      .toEqual([[dependentAgent, "blocker"], [f.parentAgent, "child"]].sort());
  });

  it("wakes only the swept waiter for a shared stalled blocker, so N dependents cost N, not N squared", async () => {
    const f = await fixture();
    const dependentAgent = randomUUID();
    await db.insert(agents).values({ id: dependentAgent, companyId: f.companyId, name: "Dependent owner", role: "engineer", status: "idle" });
    companyIdOf.set(dependentAgent, f.companyId);
    const dependents = await db.insert(issues).values([1, 2, 3].map(index => ({ companyId: f.companyId,
      title: `Dependent ${index}`, status: "blocked" as const, assigneeAgentId: dependentAgent }))).returning();
    await db.insert(issueRelations).values(dependents.map(dependent => ({ companyId: f.companyId, issueId: f.child.id,
      relatedIssueId: dependent.id, type: "blocks" as const })));
    const { calls, enqueueWakeup } = wakeRecorder();
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId, issueId: dependents[0]!.id });
    expect(calls.map(call => call.input.payload.issueId)).toEqual([dependents[0]!.id]);
    // The stalled issue's own pass reaches every waiter, skipping those already woken.
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId, issueId: f.child.id });
    expect(calls.map(call => call.input.payload.issueId).sort())
      .toEqual([f.parent.id, ...dependents.map(dependent => dependent.id)].sort());
  });

  it("pages past waiters whose agents take no wakes, so later waiters are reached", async () => {
    const f = await fixture();
    const [sleepy, awake] = [randomUUID(), randomUUID()];
    await db.insert(agents).values([
      { id: sleepy, companyId: f.companyId, name: "Sleepy", role: "engineer", status: "paused" },
      { id: awake, companyId: f.companyId, name: "Awake", role: "engineer", status: "idle" },
    ]);
    companyIdOf.set(sleepy, f.companyId); companyIdOf.set(awake, f.companyId);
    const rows = Array.from({ length: 101 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      companyId: f.companyId, title: `Waiter ${index}`, status: "todo" as const, assigneeAgentId: index < 100 ? sleepy : awake }));
    await db.insert(issues).values(rows);
    await db.insert(issueRelations).values(rows.map(row => ({ companyId: f.companyId, issueId: f.child.id,
      relatedIssueId: row.id, type: "blocks" as const })));
    const { calls, enqueueWakeup } = wakeRecorder();
    const result = await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId, issueId: f.child.id });
    expect(calls.map(call => call.input.payload.issueId)).toContain(rows[100]!.id);
    expect(result.deferred).toBe(100);
  });

  it("wakes the dependent when the blocker's board action resolved as blocked (t05 shape)", async () => {
    // t05: CHA-8 blocks CHA-5. Its board-owned action was resolved with outcome
    // "blocked" six seconds after creation, as the issue moved to blocked for
    // the board, so no open action remained to find.
    const f = await fixture();
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "blocked", resolvedAt: new Date() })
      .where(eq(issueRecoveryActions.id, f.action.id));
    await db.update(issues).set({ parentId: null }).where(eq(issues.id, f.child.id));
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: f.child.id, relatedIssueId: f.parent.id, type: "blocks" });
    const { calls, enqueueWakeup } = wakeRecorder();
    const service = recoveryService(db, { enqueueWakeup: enqueueWakeup as never });
    // The per-issue blocked sweep visits the stalled blocker itself.
    await service.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId, issueId: f.child.id });
    await service.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId, issueId: f.child.id });
    const stalled = calls.filter(call => call.input.reason === ISSUE_BLOCKER_STALLED_WAKE_REASON);
    expect(stalled).toHaveLength(1);
    expect(stalled[0]).toMatchObject({ agentId: f.parentAgent, input: { contextSnapshot: { blockerStall: {
      stalledIssueId: f.child.id, relation: "blocker", recoveryAction: { id: f.action.id, status: "resolved" } } } } });

    // Retry moves it out of blocked: not a stall any more, and no new wake.
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.child.id));
    await service.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId, issueId: f.child.id });
    await service.reconcileActiveRecoveryActions({ companyId: f.companyId });
    expect(calls.filter(call => call.input.reason === ISSUE_BLOCKER_STALLED_WAKE_REASON)).toHaveLength(1);
  });

  it("lists the waiting issue's stalled children and blockers for its page", async () => {
    const f = await fixture();
    const [blocker] = await db.insert(issues).values({ companyId: f.companyId, title: "Blocker", status: "blocked" }).returning();
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blocker.id, relatedIssueId: f.parent.id, type: "blocks" });
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: blocker.id, kind: "run_recovery",
      status: "resolved", outcome: "blocked", ownerType: "board", cause: "native_session_retry_exhausted",
      fingerprint: "blocker", nextAction: "Retry", resolvedAt: new Date() });
    const listed = await listStalledDependencies(db, { companyId: f.companyId, issueId: f.parent.id });
    expect(listed.map(entry => [entry.stalledIssueId, entry.relation]).sort())
      .toEqual([[blocker.id, "blocker"], [f.child.id, "child"]].sort());
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, blocker.id));
    expect((await listStalledDependencies(db, { companyId: f.companyId, issueId: f.parent.id })).map(entry => entry.stalledIssueId))
      .toEqual([f.child.id]);
  });

  it("never wakes a waiter parked in the backlog", async () => {
    const f = await fixture();
    await db.update(issues).set({ status: "backlog" }).where(eq(issues.id, f.parent.id));
    const { calls, enqueueWakeup } = wakeRecorder();
    await recoveryService(db, { enqueueWakeup: enqueueWakeup as never }).reconcileActiveRecoveryActions({ companyId: f.companyId });
    expect(calls).toEqual([]);
  });

  it("does not let a merged run swallow a second stall, and guards the waiter's state", async () => {
    const f = await fixture();
    const [second] = await db.insert(issues).values({ companyId: f.companyId, title: "Second child", status: "blocked",
      parentId: f.parent.id, assigneeAgentId: f.childAgent }).returning();
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: second.id, kind: "run_recovery",
      status: "escalated", ownerType: "board", cause: "execution_recovery_budget_exhausted", fingerprint: "second", nextAction: "Retry" });
    const { calls, enqueueWakeup } = wakeRecorder();
    await recoveryService(db, { enqueueWakeup: enqueueWakeup as never }).reconcileActiveRecoveryActions({ companyId: f.companyId });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.input).toMatchObject({ allowRunCoalescing: false,
        issueStateGuard: { statuses: expect.not.arrayContaining(["backlog", "done", "cancelled"]), assigneeAgentId: f.parentAgent } });
    }
  });

  it("defers while the agent takes no wakes, and retries a refused wake once the refusal is old", async () => {
    const f = await fixture();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } }).where(eq(agents.id, f.parentAgent));
    const { calls, enqueueWakeup } = wakeRecorder();
    const result = await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId });
    expect(result).toMatchObject({ woken: 0, deferred: 1 });
    expect(result.retryAt).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(calls).toEqual([]);

    // Wakes enabled again; an earlier refusal row exists for this stall.
    await db.update(agents).set({ runtimeConfig: {} }).where(eq(agents.id, f.parentAgent));
    const key = issueBlockerStalledWakeKey({ waiterIssueId: f.parent.id, stalledIssueId: f.child.id, recoveryActionId: f.action.id });
    const [refused] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.parentAgent, source: "automation",
      triggerDetail: "system", reason: "heartbeat.wakeOnDemand.disabled", payload: { issueId: f.parent.id }, idempotencyKey: key,
      status: "skipped" }).returning();
    const refusedPass = await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId });
    expect(calls).toEqual([]); // a fresh refusal is not retried at once
    expect(refusedPass.retryAt).toBe(refused.requestedAt.getTime() + 10 * 60_000);
    await db.update(agentWakeupRequests).set({ requestedAt: new Date(Date.now() - 11 * 60_000) }).where(eq(agentWakeupRequests.id, refused.id));
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId });
    expect(calls).toHaveLength(1);
  });

  it("does not wake again while a resource-wait retry carries the stall", async () => {
    const f = await fixture();
    const { calls, enqueueWakeup } = wakeRecorder();
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId });
    expect(calls).toHaveLength(1);
    // A workspace-busy deferral cancels the wake and schedules a keyless retry
    // that keeps the stall context.
    await db.update(agentWakeupRequests).set({ status: "cancelled", requestedAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(agentWakeupRequests.companyId, f.companyId));
    const [retry] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.parentAgent,
      invocationSource: "automation", status: "scheduled_retry", scheduledRetryAt: new Date(),
      contextSnapshot: { ...calls[0]!.input.contextSnapshot, wakeReason: "workspace_busy_retry", retryOfRunId: randomUUID() } }).returning();
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId });
    expect(calls).toHaveLength(1);
    // A retry chain that failed no longer carries the stall. Its failure counts
    // as a failed run of this stall, so the stall is retried after the wait.
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, retry.id));
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId });
    expect(calls).toHaveLength(1);
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - 11 * 60_000) }).where(eq(heartbeatRuns.id, retry.id));
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId });
    expect(calls).toHaveLength(2);
  });

  it("counts failed resource-wait retries toward the stall's failed-run limit", async () => {
    const f = await fixture();
    const { calls, enqueueWakeup } = wakeRecorder();
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId });
    // Each keyed wake is cancelled by a workspace wait; its keyless retry then fails.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await db.update(agentWakeupRequests).set({ status: "cancelled", requestedAt: new Date(Date.now() - 24 * 60 * 60_000) })
        .where(eq(agentWakeupRequests.companyId, f.companyId));
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.parentAgent, invocationSource: "automation",
        status: "failed", finishedAt: new Date(Date.now() - 24 * 60 * 60_000),
        contextSnapshot: { ...calls[0]!.input.contextSnapshot, wakeReason: "workspace_busy_retry", retryOfRunId: randomUUID() } });
      await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId });
    }
    expect(calls).toHaveLength(3);
  });

  it("reaches a waiter through its own sweep when the stalled blocker is unassigned", async () => {
    const f = await fixture();
    await db.update(issues).set({ parentId: null, assigneeAgentId: null }).where(eq(issues.id, f.child.id));
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: f.child.id, relatedIssueId: f.parent.id, type: "blocks" });
    const { calls, enqueueWakeup } = wakeRecorder();
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId, issueId: f.parent.id });
    expect(calls.map(call => call.agentId)).toEqual([f.parentAgent]);
  });

  it("makes progress past the per-pass cap", async () => {
    const f = await fixture();
    const [second] = await db.insert(issues).values({ companyId: f.companyId, title: "Second child", status: "blocked",
      parentId: f.parent.id, assigneeAgentId: f.childAgent }).returning();
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: second.id, kind: "run_recovery",
      status: "escalated", ownerType: "board", cause: "c", fingerprint: "second", nextAction: "Retry" });
    const { calls, enqueueWakeup } = wakeRecorder();
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId, maxStalls: 1 });
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId, maxStalls: 1 });
    expect(new Set(calls.map(call => call.input.contextSnapshot.blockerStall.stalledIssueId))).toEqual(new Set([f.child.id, second.id]));
  });

  it("delivers one wake when two sweeps race for the same stall", async () => {
    const f = await fixture();
    const { calls, enqueueWakeup } = wakeRecorder();
    const results = await Promise.all([
      wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId }),
      wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId, issueId: f.child.id }),
    ]);
    const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.reason, ISSUE_BLOCKER_STALLED_WAKE_REASON));
    expect(rows).toHaveLength(1);
    expect(results.reduce((total, result) => total + result.woken, 0)).toBe(1);
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps a company with only a resolved-as-blocked stall in the recovery-action sweep", async () => {
    const f = await fixture();
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "blocked", resolvedAt: new Date() })
      .where(eq(issueRecoveryActions.id, f.action.id));
    const selected = async () => (await db.selectDistinct({ companyId: issueRecoveryActions.companyId }).from(issueRecoveryActions)
      .where(recoveryActionSweepCondition())).map(row => row.companyId);
    expect(await selected()).toContain(f.companyId);
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.child.id));
    expect(await selected()).not.toContain(f.companyId);
  });

  it("withholds a private stalled issue's details from a waiter agent that cannot read it", async () => {
    const f = await fixture();
    await db.update(issues).set({ visibility: "private", title: "Secret acquisition" }).where(eq(issues.id, f.child.id));
    const { calls, enqueueWakeup } = wakeRecorder();
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId });
    expect(calls).toHaveLength(1);
    const stall = calls[0]!.input.contextSnapshot.blockerStall;
    expect(JSON.stringify(stall)).not.toContain("Secret acquisition");
    expect(JSON.stringify(stall)).not.toContain("execution_recovery_budget_exhausted");
    expect(stall).toMatchObject({ stalledIssueId: f.child.id, stalledIssueIdentifier: null });
    const [activity] = await db.select().from(activityLog).where(eq(activityLog.action, "issue.blocker_stalled_wake"));
    expect(activity.details).toMatchObject({ detailsWithheld: true, stalledIssueIdentifier: null });
  });

  it("ignores an action resolved any other way", async () => {
    const f = await fixture();
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: new Date() })
      .where(eq(issueRecoveryActions.id, f.action.id));
    const { calls, enqueueWakeup } = wakeRecorder();
    const service = recoveryService(db, { enqueueWakeup: enqueueWakeup as never });
    await service.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId, issueId: f.child.id });
    await service.reconcileActiveRecoveryActions({ companyId: f.companyId });
    expect(calls.filter(call => call.input.reason === ISSUE_BLOCKER_STALLED_WAKE_REASON)).toEqual([]);
  });

  it("does not wake for an agent-owned action, a terminal or unassigned waiter, or a hidden waiter", async () => {
    const agentOwned = await fixture({ ownerType: "agent", status: "active" });
    const doneParent = await fixture();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, doneParent.parent.id));
    const unassigned = await fixture();
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, unassigned.parent.id));
    const hidden = await fixture();
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, hidden.parent.id));
    const { calls, enqueueWakeup } = wakeRecorder();
    const service = recoveryService(db, { enqueueWakeup: enqueueWakeup as never });
    for (const f of [agentOwned, doneParent, unassigned, hidden]) await service.reconcileActiveRecoveryActions({ companyId: f.companyId });
    expect(calls.filter(call => call.input.reason === ISSUE_BLOCKER_STALLED_WAKE_REASON)).toEqual([]);
  });

  // Staging, 2026-11-09: a legacy child (created before subtasks got
  // their own workspace) shares its parent's remote workspace. The child's save
  // failed and its automatic recovery was exhausted, so its ended run still
  // holds the shared workspace, days past the holder cutoff. Each stall wake of
  // the parent created a run that could only fail setup ("The workspace still
  // has an unfinished writer or save operation."), twice every ten minutes.
  async function legacySharedWorkspaceFixture() {
    const f = await fixture();
    const endedAt = new Date(Date.now() - 4 * 24 * 60 * 60_000);
    const [writer] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.childAgent,
      runtimeMode: "native", nativeIssueId: f.child.id, status: "failed", startedAt: new Date(endedAt.getTime() - 15 * 60_000),
      finishedAt: endedAt, lastOutputAt: endedAt,
      resultJson: { failureCode: "native_workspace_sync_out_retry_exhausted", finalizationPhase: "terminal_failure" } }).returning();
    const authority = { schema: "paperclip.remote-workspace.v1" as const, epoch: 2, snapshotId: randomUUID(),
      source: { kind: "empty" as const }, dirty: true, writerRunId: writer.id,
      location: { leaseId: randomUUID(), providerLeaseId: randomUUID(), environmentId: randomUUID(), remoteCwd: "/home/daytona/ws" } };
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, sourceIssueId: f.parent.id,
      name: "Task workspace", mode: "shared_workspace", strategyType: "project_primary", providerType: "cloud_sandbox",
      status: "active", cwd: `/workspaces/${randomUUID()}`, metadata: { remoteWorkspace: authority } }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id, executionWorkspacePreference: "reuse_existing" })
      .where(inArray(issues.id, [f.parent.id, f.child.id]));
    // The child's stall: its exhausted save recovery, handed to the board.
    await db.update(issueRecoveryActions).set({ kind: "active_run_watchdog", cause: "native_workspace_sync_out_retry_exhausted",
      ownerType: "board", status: "escalated", evidence: { runId: writer.id, systemRecovery: { state: "exhausted" } } })
      .where(eq(issueRecoveryActions.id, f.action.id));
    // The parent's own last run (an earlier wake) already failed setup on that hold.
    const [refused] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.parentAgent,
      invocationSource: "automation", status: "failed", errorCode: "setup_failed",
      error: "The workspace still has an unfinished writer or save operation.",
      createdAt: new Date(Date.now() - 30 * 60_000), finishedAt: new Date(Date.now() - 30 * 60_000),
      contextSnapshot: { issueId: f.parent.id, wakeReason: "issue_commented" } }).returning();
    return { ...f, writer, workspace, authority, refused };
  }

  it("holds a stall wake while the waiter's workspace is held by a writer reservation would refuse", async () => {
    const f = await legacySharedWorkspaceFixture();
    const { calls, enqueueWakeup } = wakeRecorder();
    const service = recoveryService(db, { enqueueWakeup: enqueueWakeup as never });
    for (let pass = 0; pass < 3; pass += 1) await service.reconcileActiveRecoveryActions({ companyId: f.companyId });
    const held = await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId, issueId: f.parent.id });
    // No run is created that could only fail setup; the sweep looks again later.
    expect(calls.filter(call => call.input.reason === ISSUE_BLOCKER_STALLED_WAKE_REASON)).toEqual([]);
    expect(held).toMatchObject({ woken: 0, deferred: 1 });
    expect(held.retryAt).toBeGreaterThan(Date.now());
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual([]);

    // A writer still inside the holder cutoff parks the run in a workspace wait
    // instead of failing it, so that wake is delivered as before.
    await db.update(heartbeatRuns).set({ finishedAt: new Date(), lastOutputAt: new Date() }).where(eq(heartbeatRuns.id, f.writer.id));
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId });
    expect(calls).toHaveLength(1);
  });

  it("delivers the held stall wake once the workspace hold settles", async () => {
    const f = await legacySharedWorkspaceFixture();
    const { calls, enqueueWakeup } = wakeRecorder();
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId });
    expect(calls).toEqual([]);
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { ...f.authority, dirty: false, writerRunId: null } } })
      .where(eq(executionWorkspaces.id, f.workspace.id));
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId });
    expect(calls.map(call => call.agentId)).toEqual([f.parentAgent]);
  });

  it("wakes a waiter with no evidence that its own run is refused by the hold", async () => {
    // No run of this assignee has failed on the hold yet: reservation may still
    // release the writer, or this agent may not use the workspace at all.
    const fresh = await legacySharedWorkspaceFixture();
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, fresh.refused.id));
    // Reassigned to another agent: the old assignee's refused run is no evidence for it.
    const reassigned = await legacySharedWorkspaceFixture();
    const otherAgent = randomUUID();
    await db.insert(agents).values({ id: otherAgent, companyId: reassigned.companyId, name: "New owner", role: "engineer", status: "idle" });
    companyIdOf.set(otherAgent, reassigned.companyId);
    await db.update(issues).set({ assigneeAgentId: otherAgent }).where(eq(issues.id, reassigned.parent.id));
    const { calls, enqueueWakeup } = wakeRecorder();
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: fresh.companyId });
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: reassigned.companyId });
    expect(calls.map(call => call.agentId)).toEqual([fresh.parentAgent, otherAgent]);
  });

  it("backs off a stall wake whose run keeps failing, and stops after a bounded number of failed runs", async () => {
    const f = await fixture();
    const { calls, enqueueWakeup } = wakeRecorder();
    const age = async (minutesAgo: number) => {
      const at = new Date(Date.now() - minutesAgo * 60_000);
      await db.update(agentWakeupRequests).set({ requestedAt: at }).where(eq(agentWakeupRequests.companyId, f.companyId));
      await db.update(heartbeatRuns).set({ finishedAt: at }).where(eq(heartbeatRuns.companyId, f.companyId));
    };
    // The latest wake's run fails, as the queue records it.
    const fail = async (minutesAgo: number) => {
      await db.update(agentWakeupRequests).set({ status: "failed" }).where(eq(agentWakeupRequests.companyId, f.companyId));
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.parentAgent, invocationSource: "automation",
        status: "failed", contextSnapshot: calls.at(-1)!.input.contextSnapshot });
      await age(minutesAgo);
    };
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId });
    expect(calls).toHaveLength(1);
    // First failed run: retried after ten minutes.
    await fail(11);
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId });
    expect(calls).toHaveLength(2);
    // Second failed run: the wait doubles.
    await fail(11);
    const backingOff = await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId });
    expect(calls).toHaveLength(2);
    expect(backingOff.retryAt).toBeGreaterThan(Date.now() + 8 * 60_000);
    await age(21);
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId });
    expect(calls).toHaveLength(3);
    // Third failed run: the stall is not retried again, and no timer is asked for.
    await fail(24 * 60);
    const spent = await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId });
    expect(calls).toHaveLength(3);
    expect(spent.retryAt).toBeNull();
    // A new stall (a new recovery action) is delivered again.
    await db.update(issueRecoveryActions).set({ status: "resolved", resolvedAt: new Date(), outcome: "restored" })
      .where(eq(issueRecoveryActions.id, f.action.id));
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.child.id, kind: "run_recovery",
      status: "escalated", ownerType: "board", cause: "execution_recovery_budget_exhausted", fingerprint: "fixture-2", nextAction: "Retry" });
    await wakeWaitersOfStalledIssues(db, enqueueWakeup as never, { companyId: f.companyId });
    expect(calls).toHaveLength(4);
  });
});
