import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

const lateCopyBack = vi.hoisted(() => new Set<string>());
vi.mock("../services/legacy-workspace-restore-recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/legacy-workspace-restore-recovery.js")>();
  return {
    ...actual,
    hasUnrestoredRemoteWorkspace: async (...args: Parameters<typeof actual.hasUnrestoredRemoteWorkspace>) =>
      lateCopyBack.delete(args[1].id) ? false : actual.hasUnrestoredRemoteWorkspace(...args),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("stranded sweep and in-run hand-overs", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-handoff-stop-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb.cleanup();
  });

  const handover = {
    status: "cancelled",
    errorCode: "issue_reassigned",
    error: "Cancelled before issue reassignment",
    resultJson: { reassignmentStopConfirmed: true },
  } as const;
  const failure = {
    status: "failed",
    errorCode: "adapter_failed",
    error: "The adapter exited 1",
    resultJson: { conversationContinuation: "continue_conversation_v1" },
  } as const;

  async function seedCompany(names: string[]) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Hop Co",
      issuePrefix: `P${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "responsible-user",
      status: "active",
      membershipRole: "member",
    });
    const ids = names.map(() => randomUUID());
    await db.insert(agents).values(
      names.map((name, i) => ({
        id: ids[i],
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
      })),
    );
    return { companyId, ids };
  }

  async function seedTodoHops(last: "handover" | "failure") {
    const { companyId, ids: [a, b, c] } = await seedCompany(["A", "B", "C"]);
    const issueId = randomUUID();
    const assignee = last === "handover" ? c : b;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Hand the work on",
      status: "todo",
      assigneeAgentId: assignee,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: a,
      issueId,
      ...handover,
      createdAt: new Date(Date.now() - 6 * 60_000),
      startedAt: new Date(Date.now() - 6 * 60_000),
      finishedAt: new Date(Date.now() - 5 * 60_000),
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: b,
      issueId,
      ...(last === "handover" ? handover : failure),
      createdAt: new Date(Date.now() - 4 * 60_000),
      startedAt: new Date(Date.now() - 4 * 60_000),
      finishedAt: new Date(Date.now() - 3 * 60_000),
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assignment_recovery",
        retryReason: "assignment_recovery",
      },
    });
    return { companyId, issueId, assignee };
  }

  function recordingEnqueue(companyId: string, issueId: string) {
    return vi.fn().mockImplementation(async (agentId: string) => {
      const [run] = await db.insert(heartbeatRuns).values({
        companyId,
        agentId,
        issueId,
        status: "queued",
        contextSnapshot: { issueId },
      }).returning();
      return run;
    });
  }

  async function recoveryActionsOf(issueId: string) {
    return db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
  }

  it("dispatches the new assignee of a todo issue after hand-overs and opens no recovery action", async () => {
    const f = await seedTodoHops("handover");
    const enqueueWakeup = recordingEnqueue(f.companyId, f.issueId);

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 0, dispatchRequeued: 1, issueIds: [f.issueId] });
    expect(enqueueWakeup).toHaveBeenCalledOnce();
    expect(enqueueWakeup).toHaveBeenCalledWith(
      f.assignee,
      expect.objectContaining({ reason: "issue_assignment_recovery" }),
    );
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue).toMatchObject({ status: "todo", assigneeAgentId: f.assignee });
    expect(await recoveryActionsOf(f.issueId)).toHaveLength(0);
  });

  it("dispatches the new assignee when dispatch refused the stopped agent's immediate recovery after the hand-over", async () => {
    const { companyId, ids: [a, b] } = await seedCompany(["A", "B"]);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Hand the work on once",
      status: "todo",
      assigneeAgentId: b,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const [stopped] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId: a,
      issueId,
      ...handover,
      createdAt: new Date(Date.now() - 6 * 60_000),
      startedAt: new Date(Date.now() - 6 * 60_000),
      finishedAt: new Date(Date.now() - 5 * 60_000),
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assignment_recovery",
        retryReason: "assignment_recovery",
      },
    }).returning();
    const refusedAt = new Date(Date.now() - 4 * 60_000);
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: a,
      issueId,
      status: "cancelled",
      createdAt: new Date(Date.now() - 5 * 60_000),
      finishedAt: refusedAt,
      updatedAt: refusedAt,
      error: "Cancelled because issue assignee changed before the queued run could start; the new owner will be woken instead",
      errorCode: "issue_assignee_changed",
      resultJson: {
        stopReason: "issue_assignee_changed",
        effectiveTimeoutSec: 0,
        timeoutConfigured: false,
        timeoutSource: "stale_queued_run_gate",
        timeoutFired: false,
      },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assignment_recovery",
        retryReason: "assignment_recovery",
        source: "issue.assignment_recovery",
        retryOfRunId: stopped.id,
      },
    });
    const enqueueWakeup = recordingEnqueue(companyId, issueId);

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 0, dispatchRequeued: 1, issueIds: [issueId] });
    expect(enqueueWakeup).toHaveBeenCalledOnce();
    expect(enqueueWakeup).toHaveBeenCalledWith(b, expect.objectContaining({ reason: "issue_assignment_recovery" }));
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ status: "todo", assigneeAgentId: b });
    expect(await recoveryActionsOf(issueId)).toHaveLength(0);
  });

  it("still escalates a todo issue whose assignment recovery failed", async () => {
    const f = await seedTodoHops("failure");
    const enqueueWakeup = vi.fn();

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ escalated: 1, issueIds: [f.issueId] });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue).toMatchObject({ status: "blocked", assigneeAgentId: f.assignee });
  });

  async function seedStoppedRemoteRun(lease: boolean) {
    const { companyId, ids: [a] } = await seedCompany(["A"]);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Hand the work back",
      status: "todo",
      assigneeAgentId: a,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId: a,
      issueId,
      runtimeMode: "legacy",
      ...handover,
      resultJson: { ...handover.resultJson, workspaceRestoreFailure: "restore_failed" },
      createdAt: new Date(Date.now() - 6 * 60_000),
      startedAt: new Date(Date.now() - 6 * 60_000),
      finishedAt: new Date(Date.now() - 5 * 60_000),
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    }).returning();
    if (lease) {
      const [environment] = await db.insert(environments)
        .values({ name: `Sandbox ${run.id}`, driver: "sandbox" })
        .returning();
      await db.insert(environmentLeases).values({
        companyId,
        issueId,
        heartbeatRunId: run.id,
        environmentId: environment.id,
        status: "active",
        leasePolicy: "ephemeral",
        provider: "daytona",
        providerLeaseId: randomUUID(),
        metadata: { remoteCwd: "/work/fixture", driver: "sandbox", sandboxProviderPlugin: true },
      });
    }
    heldIssues.push(issueId);
    return { companyId, issueId, assignee: a, runId: run.id };
  }

  const heldIssues: string[] = [];
  afterEach(async () => {
    if (heldIssues.length === 0) return;
    await db.update(issues).set({ hiddenAt: new Date() }).where(inArray(issues.id, heldIssues.splice(0)));
  });

  async function expectHeldForWorkspaceRepair(issueId: string) {
    const actions = await recoveryActionsOf(issueId);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ ownerType: "board", cause: "legacy_execution_requires_reconciliation" });
  }

  it("holds a hand-over stop with unrestored remote files for the workspace repair at the sweep's gate", async () => {
    const f = await seedStoppedRemoteRun(true);
    const enqueueWakeup = vi.fn();

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ escalated: 1, issueIds: [f.issueId] });
    await expectHeldForWorkspaceRepair(f.issueId);
  });

  it("holds a hand-over stop whose copy-back failure lands after the gate when the recovery is queued", async () => {
    const f = await seedStoppedRemoteRun(true);
    lateCopyBack.add(f.runId);
    const enqueueWakeup = vi.fn();

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(lateCopyBack.has(f.runId)).toBe(false);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ escalated: 0, dispatchRequeued: 0 });
    await expectHeldForWorkspaceRepair(f.issueId);
  });

  it("requeues the assignee after a hand-over stop whose remote files need no repair", async () => {
    const f = await seedStoppedRemoteRun(false);
    const enqueueWakeup = recordingEnqueue(f.companyId, f.issueId);

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 0, dispatchRequeued: 1, issueIds: [f.issueId] });
    expect(enqueueWakeup).toHaveBeenCalledWith(f.assignee, expect.anything());
    expect(await recoveryActionsOf(f.issueId)).toHaveLength(0);
  });

  it("does not count the assignee's own hand-over as a failed continuation retry of an in_progress issue", async () => {
    const { companyId, ids: [a, b] } = await seedCompany(["A", "B"]);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Continue the work",
      status: "in_progress",
      assigneeAgentId: a,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await db.insert(heartbeatRuns).values([
      {
        companyId,
        agentId: a,
        issueId,
        ...handover,
        createdAt: new Date(Date.now() - 20 * 60_000),
        startedAt: new Date(Date.now() - 20 * 60_000),
        finishedAt: new Date(Date.now() - 19 * 60_000),
        contextSnapshot: {
          issueId,
          wakeReason: "issue_continuation_needed",
          retryReason: "issue_continuation_needed",
        },
      },
      {
        companyId,
        agentId: b,
        issueId,
        ...handover,
        createdAt: new Date(Date.now() - 10 * 60_000),
        startedAt: new Date(Date.now() - 10 * 60_000),
        finishedAt: new Date(Date.now() - 9 * 60_000),
        contextSnapshot: {
          issueId,
          wakeReason: "issue_continuation_needed",
          retryReason: "issue_continuation_needed",
        },
      },
    ]);
    const enqueueWakeup = recordingEnqueue(companyId, issueId);

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 0, continuationRequeued: 1, issueIds: [issueId] });
    expect(enqueueWakeup).toHaveBeenCalledOnce();
    expect(enqueueWakeup).toHaveBeenCalledWith(a, expect.anything());
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("in_progress");
    expect(await recoveryActionsOf(issueId)).toHaveLength(0);
  });

  it("leaves an in_progress issue back on the agent whose native run its hand-over stopped to the native runtime", async () => {
    const { companyId, ids: [a] } = await seedCompany(["A"]);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Continue natively",
      status: "in_progress",
      assigneeAgentId: a,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: a,
      issueId,
      runtimeMode: "native",
      ...handover,
      createdAt: new Date(Date.now() - 10 * 60_000),
      startedAt: new Date(Date.now() - 10 * 60_000),
      finishedAt: new Date(Date.now() - 9 * 60_000),
      contextSnapshot: {
        issueId,
        wakeReason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
      },
    });
    const enqueueWakeup = recordingEnqueue(companyId, issueId);

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ escalated: 0, continuationRequeued: 0 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("in_progress");
    expect(await recoveryActionsOf(issueId)).toHaveLength(0);
    heldIssues.push(issueId);
  });

  it("requeues the reviewer of an in_review issue after one review round whose wake was lost", async () => {
    const { companyId, ids: [author, reviewer] } = await seedCompany(["Author", "Reviewer"]);
    const issueId = randomUUID();
    const participant = { type: "agent", agentId: reviewer, userId: null } as const;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review the work",
      status: "in_review",
      assigneeAgentId: reviewer,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: participant,
        returnAssignee: participant,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    await db.insert(heartbeatRuns).values([
      {
        companyId,
        agentId: reviewer,
        issueId,
        ...handover,
        createdAt: new Date(Date.now() - 20 * 60_000),
        startedAt: new Date(Date.now() - 20 * 60_000),
        finishedAt: new Date(Date.now() - 19 * 60_000),
        contextSnapshot: {
          issueId,
          wakeReason: "execution_review_participant_recovery",
          retryReason: "execution_review_participant_recovery",
        },
      },
      {
        companyId,
        agentId: author,
        issueId,
        ...handover,
        createdAt: new Date(Date.now() - 10 * 60_000),
        startedAt: new Date(Date.now() - 10 * 60_000),
        finishedAt: new Date(Date.now() - 9 * 60_000),
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      },
    ]);
    const enqueueWakeup = recordingEnqueue(companyId, issueId);

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 0, reviewParticipantRequeued: 1, issueIds: [issueId] });
    expect(enqueueWakeup).toHaveBeenCalledOnce();
    expect(enqueueWakeup).toHaveBeenCalledWith(reviewer, expect.anything());
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("in_review");
    expect(await recoveryActionsOf(issueId)).toHaveLength(0);
  });
});
