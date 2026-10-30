import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("stranded todo sweep and other agents' parked wakes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-stranded-todo-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb.cleanup();
  });

  async function seedHandoff(parkedWakeOwner: "previous" | "assignee") {
    const companyId = randomUUID();
    const previousAgentId = randomUUID();
    const assigneeAgentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Handoff Co",
      issuePrefix: `H${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "responsible-user",
      status: "active",
      membershipRole: "member",
    });
    await db.insert(agents).values([
      { id: previousAgentId, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "codex_local" },
      { id: assigneeAgentId, companyId, name: "CEO", role: "ceo", status: "idle", adapterType: "codex_local" },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review the pull request",
      status: "todo",
      assigneeAgentId,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const [previousRun] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId: previousAgentId,
      issueId,
      status: "cancelled",
      errorCode: "issue_reassigned",
      error: "Cancelled before issue reassignment",
      createdAt: new Date(Date.now() - 5 * 60_000),
      startedAt: new Date(Date.now() - 5 * 60_000),
      finishedAt: new Date(Date.now() - 4 * 60_000),
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    }).returning();
    await db.insert(agentWakeupRequests).values([
      {
        companyId,
        agentId: parkedWakeOwner === "previous" ? previousAgentId : assigneeAgentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        status: "deferred_issue_execution",
        payload: { issueId, mutation: "update" },
        requestedAt: new Date(Date.now() - 30 * 60_000),
      },
      {
        companyId,
        agentId: assigneeAgentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "execution_reconciliation_required",
        status: "skipped",
        error: "The previous execution has not released its environment lease. Wait for cleanup before continuing this task.",
        payload: { issueId, mutation: "update" },
        requestedAt: new Date(Date.now() - 4 * 60_000),
        finishedAt: new Date(Date.now() - 4 * 60_000),
      },
    ]);
    return { companyId, previousAgentId, assigneeAgentId, issueId, previousRun };
  }

  it("queues the assignment recovery wake when only a previous assignee's parked wake remains", async () => {
    const f = await seedHandoff("previous");
    const enqueueWakeup = vi.fn().mockImplementation(async (agentId: string) => {
      const [run] = await db.insert(heartbeatRuns).values({
        companyId: f.companyId,
        agentId,
        issueId: f.issueId,
        status: "queued",
        contextSnapshot: { issueId: f.issueId, wakeReason: "issue_assignment_recovery" },
      }).returning();
      return run;
    });

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ dispatchRequeued: 1, issueIds: [f.issueId] });
    expect(enqueueWakeup).toHaveBeenCalledOnce();
    expect(enqueueWakeup).toHaveBeenCalledWith(
      f.assigneeAgentId,
      expect.objectContaining({
        source: "automation",
        reason: "issue_assignment_recovery",
        payload: expect.objectContaining({ issueId: f.issueId, retryOfRunId: f.previousRun.id }),
      }),
    );
    const parked = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, f.previousAgentId));
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
  });

  it("escalates to blocked when the assignee's exhausted dispatch leaves only another agent's parked wake", async () => {
    const f = await seedHandoff("previous");
    await db.insert(heartbeatRuns).values({
      companyId: f.companyId,
      agentId: f.assigneeAgentId,
      issueId: f.issueId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "interrupted",
      errorCode: "server_shutdown_interrupted",
      error: "Interrupted by graceful server shutdown (SIGTERM)",
      scheduledRetryAttempt: 2,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "transient_failure_retry" },
      resultJson: { stopReason: "interrupted", conversationContinuation: "continue_conversation_v1" },
      createdAt: new Date(Date.now() - 3 * 60_000),
      startedAt: new Date(Date.now() - 3 * 60_000),
      finishedAt: new Date(Date.now() - 2 * 60_000),
      updatedAt: new Date(Date.now() - 2 * 60_000),
    });
    const enqueueWakeup = vi.fn();

    const result = await recoveryService(db, {
      enqueueWakeup,
      scheduleRecoveryRetry: async () => null,
      transientRetryBudgetSpent: () => true,
    }).reconcileStrandedAssignedIssues();

    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ escalated: 1, dispatchRequeued: 0, issueIds: [f.issueId] });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue).toMatchObject({ status: "blocked", assigneeAgentId: f.assigneeAgentId });
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: "active", ownerType: "board", returnOwnerAgentId: f.assigneeAgentId });
    const parked = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, f.previousAgentId));
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
  });

  it("leaves the issue alone while the assignee's own parked wake is live", async () => {
    const f = await seedHandoff("assignee");
    const enqueueWakeup = vi.fn();

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.issueIds).not.toContain(f.issueId);
  });
});
