import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, companies, createDb, issueRecoveryActions, issueRelations, issues, type Db,
} from "@paperclipai/db";
import { ISSUE_BLOCKER_STALLED_WAKE_REASON } from "@paperclipai/shared";
import { recoveryService } from "../services/recovery/service.js";
import { issueBlockerStalledWakeKey, listStalledDependencies } from "../services/recovery/blocker-stall-wakeups.js";
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
});
