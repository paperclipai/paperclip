import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  agentRuntimeState,
  budgetPolicies,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueRecoveryActions,
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged liveness escalation.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { attentionService } from "../services/attention.ts";
import { issueService } from "../services/issues.ts";
import { escalateExhaustedIssueReviewPathRecovery } from "../services/recovery/review-path-recovery-escalation.ts";
import { runningProcesses } from "../adapters/index.ts";
import {
  buildIssueBlockersResolvedWakeStateKey,
  buildIssueBlockersResolvedWakeStateKeyWithoutCycle,
} from "../services/issue-dependency-wakeups.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue liveness escalation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat resolved dependency wake reconciliation", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-issue-liveness-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // Dependency reconciliation heals missing wakes by enqueuing an
    // on-demand wake, which dispatches a heartbeat run fire-and-forget (see
    // startNextQueuedRunForAgent → executeRun in the heartbeat service). That
    // background run keeps writing rows (workspace_operations, heartbeat_run_events)
    // after the awaited call resolves. Deterministically await those in-flight
    // executions before clearing tables — otherwise an escaping heartbeat_run_events
    // insert can land between the events delete and the heartbeat_runs delete and
    // trip the run_events → runs foreign key.
    await heartbeatService(db).drainActiveRunExecutions();
    vi.clearAllMocks();
    runningProcesses.clear();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(issueTreeHoldMembers);
    await db.delete(issueTreeHolds);
    await db.delete(issueRelations);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedBlockedChain(opts: {
    outsideLookback?: boolean;
    blockerStatus?: string;
    blockerAssigneeAgentId?: "coder" | "manager" | null;
  } = {}) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);

    const issueTimestamp = opts.outsideLookback === true
      ? new Date(Date.now() - 25 * 60 * 60 * 1000)
      : new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked parent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: coderId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
      {
        id: blockerIssueId,
        companyId,
        title: "Missing unblock owner",
        status: opts.blockerStatus ?? "todo",
        priority: "medium",
        assigneeAgentId: opts.blockerAssigneeAgentId === "coder"
          ? coderId
          : opts.blockerAssigneeAgentId === "manager"
            ? managerId
            : null,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
    ]);

    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    return { companyId, managerId, coderId, blockedIssueId, blockerIssueId };
  }

  async function seedResolvedDependencyBackstopFixture(opts: {
    workspaceState?: "none" | "not_finalized" | "finalized";
    assignee?: "agent" | null;
  } = {}) {
    const workspaceState = opts.workspaceState ?? "none";
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerUserId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Priya",
      role: "engineer",
      status: "idle",
      adapterType: "test_adapter",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    if (workspaceState !== "none") {
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Synthetic dependency project",
        status: "in_progress",
      });
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "Synthetic workspace",
        sourceType: "git_worktree",
      });
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Synthetic execution workspace",
        providerType: "git_worktree",
      });
    }

    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        projectId: workspaceState === "none" ? null : projectId,
        title: "Synthetic blocked dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: opts.assignee === null ? null : agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: blockerIssueId,
        companyId,
        projectId: workspaceState === "none" ? null : projectId,
        title: "Synthetic completed blocker",
        status: "done",
        priority: "medium",
        executionWorkspaceId: workspaceState === "none" ? null : executionWorkspaceId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    if (workspaceState === "not_finalized") {
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        issueId: blockerIssueId,
        phase: "adapter_execute",
        status: "succeeded",
        startedAt: new Date(Date.now() - 60_000),
      });
    } else if (workspaceState === "finalized") {
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        issueId: blockerIssueId,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date(),
      });
    }

    return { companyId, agentId, blockedIssueId, blockerIssueId, executionWorkspaceId };
  }

  it.each(["pathless", "monitor"] as const)("runs exactly one bounded review-path recovery with %s disposition", async (disposition) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Review Recovery Co",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Review Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "External build follow-up",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    if (disposition === "monitor") {
      const execute = mockAdapterExecute.getMockImplementation()!;
      mockAdapterExecute.mockImplementationOnce(execute).mockImplementationOnce(async () => {
        await issueService(db).update(issueId, {
          monitorNextCheckAt: new Date(Date.now() + 60_000), monitorNotes: "Check external build",
        });
        return execute();
      });
    }

    const heartbeat = heartbeatService(db);
    const followUpRun = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: {
        issueId,
        interactionId: "superseded-confirmation",
        reviewPathLost: true,
        reviewPathConsumedRef: "superseded-confirmation",
      },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_commented",
        interactionId: "superseded-confirmation",
        reviewPathLost: true,
        reviewPathConsumedRef: "superseded-confirmation",
      },
    });
    expect(followUpRun).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();

    const recoveryWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.reason, "issue_review_path_lost"),
      ));
    expect(recoveryWakes).toHaveLength(1);
    expect(recoveryWakes[0]).toMatchObject({
      status: "completed",
      payload: expect.objectContaining({
        issueId,
        reviewPathConsumedRef: "superseded-confirmation",
        reviewPathRecoveryAttempt: 1,
        maxReviewPathRecoveryAttempts: 1,
      }),
    });

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    if (disposition === "monitor") {
      expect(issue).toMatchObject({ status: "in_review", assigneeAgentId: agentId, monitorNextCheckAt: expect.any(Date) });
      expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
      expect(await db.select().from(issueComments)).toHaveLength(0);
      const attention = await issueService(db).listReviewAttention(companyId, [issue]);
      expect(attention.get(issueId)).toMatchObject({ state: "covered", paths: expect.arrayContaining([expect.objectContaining({ kind: "monitor" })]) });
      return;
    }
    expect(issue).toMatchObject({ status: "blocked", assigneeAgentId: agentId });
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      ownerType: "board", ownerAgentId: null, ownerUserId: null,
      returnOwnerAgentId: agentId, cause: "issue_review_path_lost", attemptCount: 1, maxAttempts: 1,
    });
    const notices = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ authorType: "system", presentation: expect.objectContaining({ title: "No follow-up scheduled" }) });

    const recoveryRun = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, recoveryWakes[0].runId!)).then((rows) => rows[0]);
    // Replayed finalization must not duplicate the notice, action, or wake.
    expect(await escalateExhaustedIssueReviewPathRecovery(db, { run: recoveryRun, issueId })).toBeNull();
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(1);
    expect(await db.select().from(issueComments)).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.reason, "issue_review_path_lost"))).toHaveLength(1);

    const feed = await attentionService(db).list(companyId, { userId: "responsible-user" });
    expect(feed.items.find((item) => item.subject.id === actions[0].id)).toMatchObject({
      sourceKind: "recovery_action",
      relatedIssue: expect.objectContaining({ id: issueId }),
      decisionVerbs: expect.arrayContaining([
        expect.objectContaining({ id: "resolve", label: "Resolve" }),
      ]),
    });
  });

  it.each(["monitor", "completed", "reassigned", "newer_run", "other_company"] as const)(
    "does not escalate a stale review recovery after %s",
    async (change) => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Review Co", issuePrefix: `R${companyId.slice(0, 6)}` });
      await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", role: "engineer", adapterType: "codex_local" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Async review", status: "in_review", assigneeAgentId: agentId });
      const [run] = await db.insert(heartbeatRuns).values({
        companyId, agentId, status: "succeeded", issueId,
        createdAt: new Date(Date.now() - 60_000),
        contextSnapshot: { issueId, wakeReason: "issue_review_path_lost", reviewPathRecoveryAttempt: 1 },
      }).returning();
      if (change === "monitor") {
        await issueService(db).update(issueId, { monitorNextCheckAt: new Date(Date.now() + 60_000), monitorNotes: "Check build" });
      } else if (change === "completed") {
        await issueService(db).update(issueId, { status: "done" });
      } else if (change === "reassigned") {
        const nextAgentId = randomUUID();
        await db.insert(agents).values({ id: nextAgentId, companyId, name: "New reviewer", role: "engineer", adapterType: "codex_local" });
        await issueService(db).update(issueId, { assigneeAgentId: nextAgentId });
      } else if (change === "newer_run") {
        await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, status: "succeeded", contextSnapshot: { issueId } });
      }
      expect(await escalateExhaustedIssueReviewPathRecovery(db, {
        run: change === "other_company" ? { ...run, companyId: randomUUID() } : run,
        issueId,
      })).toBeNull();
      expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
      expect(await db.select().from(issueComments)).toHaveLength(0);
      const current = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
      expect(current.status).toBe(change === "completed" ? "done" : "in_review");
      if (change === "monitor") expect(current.monitorNextCheckAt).not.toBeNull();
    },
  );

  it("serializes concurrent finalization of a failed review repair", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Review Co", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", role: "engineer", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Failed review repair", status: "in_review", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, issueId, status: "failed",
      contextSnapshot: { issueId, wakeReason: "issue_review_path_lost", reviewPathRecoveryAttempt: 1 },
    }).returning();
    const results = await Promise.all([
      escalateExhaustedIssueReviewPathRecovery(db, { run, issueId }),
      escalateExhaustedIssueReviewPathRecovery(db, { run, issueId }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(1);
    expect(await db.select().from(issueComments)).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.review_path_recovery_exhausted"))).toHaveLength(1);
  });

  it.each(["restart", "transaction_failure", "due_monitor", "claimed_monitor", "expired_monitor", "exhausted_monitor", "disabled_monitor"] as const)("reconciles a committed review repair after %s with a one-connection pool", async (gap) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const wakeId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Review Co", issuePrefix: `R${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", role: "engineer", adapterType: "codex_local", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Repair finalized before restart", status: "in_review", assigneeAgentId: agentId, responsibleUserId: "responsible-user" });
    await db.insert(agentWakeupRequests).values({
      id: wakeId, companyId, agentId, source: "automation", status: "completed",
      reason: "issue_review_path_lost", payload: { issueId, reviewPathRecoveryAttempt: 1 },
    });
    const [repairRun] = await db.insert(heartbeatRuns).values({
      companyId, agentId, issueId, status: "succeeded", wakeupRequestId: wakeId, finishedAt: new Date(),
      contextSnapshot: { issueId, wakeReason: "issue_review_path_lost", reviewPathRecoveryAttempt: 1 },
    }).returning();
    const dueAt = new Date(Date.now() - 60_000);
    if (gap.endsWith("monitor")) {
      const monitored = await issueService(db).update(issueId, {
        monitorNextCheckAt: dueAt, monitorNotes: "Check external build",
        executionPolicy: { monitor: {
          nextCheckAt: dueAt.toISOString(), notes: "Check external build", scheduledBy: "assignee",
          kind: "external_service", serviceName: "github_checks",
          ...(gap === "disabled_monitor" ? {} : { timeoutAt: new Date(Date.now() + 60_000).toISOString(), maxAttempts: 3 }),
        } },
      });
      if (gap === "disabled_monitor") {
        // A policy change after saving an unbounded check must not hide the
        // spent repair forever: dispatch cannot accept its on-demand wake.
        await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } }).where(eq(agents.id, agentId));
      } else if (gap === "claimed_monitor") {
        await db.update(issues).set({ monitorWakeRequestedAt: new Date() }).where(eq(issues.id, issueId));
      } else if (gap === "expired_monitor" || gap === "exhausted_monitor") {
        const policy = monitored!.executionPolicy as { monitor: Record<string, unknown> };
        await db.update(issues).set({
          executionPolicy: { ...policy, monitor: { ...policy.monitor, ...(gap === "expired_monitor" ? { timeoutAt: new Date(Date.now() - 1_000).toISOString() } : { maxAttempts: 1 }) } },
          ...(gap === "exhausted_monitor" ? { monitorAttemptCount: 1 } : {}),
        }).where(eq(issues.id, issueId));
      }
    }
    // Only the terminal run and completed wake were persisted before the crash.
    // A new service must restore the missing action without invoking the agent.
    const singleConnectionDb = createDb(tempDb!.connectionString, { maxConnections: 1 });
    try {
      if (gap === "transaction_failure") {
        await db.execute(sql`alter table issue_comments add constraint review_repair_notice_test check (false) not valid`);
        try {
          await expect(escalateExhaustedIssueReviewPathRecovery(singleConnectionDb, { run: repairRun, issueId })).rejects.toThrow();
        } finally {
          await db.execute(sql`alter table issue_comments drop constraint review_repair_notice_test`);
        }
        expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
        expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe("in_review");
      }
      const recovery = heartbeatService(singleConnectionDb);
      const result = await recovery.reconcileStrandedAssignedIssues();
      if (gap === "due_monitor" || gap === "claimed_monitor") {
        expect(result.escalated).toBe(0);
        expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
        expect(await db.select().from(issueComments)).toHaveLength(0);
        const current = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
        expect(current).toMatchObject({ status: "in_review", monitorNextCheckAt: dueAt });
        // A claim left by a crashed dispatcher can be reclaimed after its lease.
        if (gap === "claimed_monitor") {
          await db.update(issues).set({ monitorWakeRequestedAt: new Date(Date.now() - 6 * 60_000) }).where(eq(issues.id, issueId));
        }
        const execute = mockAdapterExecute.getMockImplementation()!;
        mockAdapterExecute.mockImplementationOnce(async () => {
          await issueService(db).update(issueId, { status: "done" });
          return execute();
        });
        const dispatcher = heartbeatService(db, { runtimeEnv: {} });
        await dispatcher.tickTimers();
        await dispatcher.drainActiveRunExecutions();
        const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.reason, "issue_monitor_due"));
        expect(wakes).toHaveLength(1);
        expect(mockAdapterExecute).toHaveBeenCalledOnce();
        expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "done", monitorNextCheckAt: null });
        return;
      }
      expect(result).toMatchObject({ escalated: 1, issueIds: [issueId] });
      expect(await db.select().from(issueRecoveryActions)).toHaveLength(1);
      expect(await db.select().from(issueComments)).toHaveLength(1);
      const second = await recovery.reconcileStrandedAssignedIssues();
      expect(second.escalated).toBe(0);
      expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
      expect(mockAdapterExecute).not.toHaveBeenCalled();
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "blocked", assigneeAgentId: agentId });
    } finally {
      await singleConnectionDb.$client.end({ timeout: 1 });
    }
  });

  it("keeps resolved dependency wake reconciliation active", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);

    expect(wake?.reason).toBe("issue_blockers_resolved");
    expect(wake?.idempotencyKey).toBe(
      buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    );
    expect(["queued", "claimed", "completed"]).toContain(wake?.status);

    const events = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityId: blockedIssueId,
      details: expect.objectContaining({ source: "issue_graph_liveness.backstop" }),
    });
  });

  it("heals a blocked dependent whose done blocker has no workspace finalize obligation", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);

    expect(wake?.reason).toBe("issue_blockers_resolved");
    expect(wake?.idempotencyKey).toBe(
      buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    );
    expect(["queued", "claimed", "completed"]).toContain(wake?.status);

    const events = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entityId: blockedIssueId });
  });

  it("reconciles a resolved blocked dependency after the assignee-null window closes", async () => {
    const { agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none", assignee: null });
    const heartbeat = heartbeatService(db);

    const beforeAssignment = await heartbeat.reconcileResolvedDependencyWakes();

    expect(beforeAssignment.healed).toBe(0);
    expect(beforeAssignment.checked).toBe(0);

    await db
      .update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, blockedIssueId));

    const afterAssignment = await heartbeat.reconcileResolvedDependencyWakes();

    expect(afterAssignment.healed).toBe(1);
    expect(afterAssignment.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);
    expect(wake).toMatchObject({
      reason: "issue_blockers_resolved",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });
  });

  async function seedExecutionWait(status: "active" | "resolved" = "resolved") {
    const fixture = await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId: fixture.companyId, sourceIssueId: fixture.blockedIssueId,
      kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: fixture.agentId,
      cause: "legacy_execution_requires_reconciliation", status,
      evidence: status === "resolved" ? { automaticRecovery: { replay: "blocked" } } : {},
      fingerprint: randomUUID(), nextAction: "Check the stopped execution before resuming.",
    }).returning();
    return { ...fixture, action: action! };
  }

  it.each(["active", "resolved"] as const)("keeps repeated wakes behind a %s execution hold run-free, then resumes once", async (status) => {
    const { companyId, agentId, blockedIssueId, action } = await seedExecutionWait(status);
    const heartbeat = heartbeatService(db);
    // Different producers and wake keys must not create new attempts or notices.
    await Promise.all(Array.from({ length: 6 }, (_, i) => heartbeat.wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_continuation_needed",
      requestedByActorType: "system", requestedByActorId: "wait-regression",
      idempotencyKey: `producer-${i}`, payload: { issueId: blockedIssueId },
      contextSnapshot: { issueId: blockedIssueId },
    })));
    for (let i = 0; i < 3; i++) {
      // Recreate the service to prove the wait is durable across scheduler restarts.
      expect((await heartbeatService(db).reconcileResolvedDependencyWakes()).healed).toBe(0);
    }
    const waits = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({
      status: "skipped", runId: null, reason: "execution_reconciliation_required", coalescedCount: 8,
      payload: { issueId: blockedIssueId, executionWait: { recoveryActionId: action.id } },
    });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted"),
    ))).toHaveLength(0);

    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockedIssueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Finished the dependency-ready task.", provider: "test", model: "test-model" };
    });
    await db.update(issueRecoveryActions).set({ status: "resolved", evidence: {} }).where(eq(issueRecoveryActions.id, action.id));
    expect((await heartbeat.reconcileResolvedDependencyWakes()).healed).toBe(1);
    expect((await heartbeat.reconcileResolvedDependencyWakes()).healed).toBe(0);
    await heartbeat.drainActiveRunExecutions();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("rechecks every gate after an execution hold clears", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId, action } = await seedExecutionWait();
    const wake = () => heartbeatService(db).wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_continuation_needed",
      requestedByActorType: "system", requestedByActorId: "wait-regression",
      payload: { issueId: blockedIssueId }, contextSnapshot: { issueId: blockedIssueId },
    });
    await wake();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, blockerIssueId));
    await db.update(issueRecoveryActions).set({ evidence: {} }).where(eq(issueRecoveryActions.id, action.id));
    await wake();
    await wake();
    const waits = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(waits).toHaveLength(2);
    expect(waits.find((row) => row.reason === "issue_dependencies_blocked")?.coalescedCount).toBe(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerIssueId));
    expect((await heartbeatService(db).reconcileResolvedDependencyWakes()).healed).toBe(1);
  });

  it("preserves distinct comments through a hold and adopts them on the next eligible wake", async () => {
    const { companyId, agentId, blockedIssueId, action } = await seedExecutionWait();
    const heartbeat = heartbeatService(db);
    const commentIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [comment] = await db.insert(issueComments).values({
        companyId, issueId: blockedIssueId, authorUserId: "board-user", body: `Follow-up ${i}`,
      }).returning();
      commentIds.push(comment!.id);
      expect(await heartbeat.wakeup(agentId, {
        source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
        requestedByActorType: "user", requestedByActorId: "board-user",
        payload: { issueId: blockedIssueId, commentId: comment!.id },
        contextSnapshot: { issueId: blockedIssueId, wakeReason: "issue_commented", wakeCommentId: comment!.id },
      })).toBeNull();
    }
    const deferred = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(deferred).toHaveLength(2);
    expect(deferred.every((row) => row.status === "deferred_issue_execution" && row.runId === null)).toBe(true);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    await db.update(issueRecoveryActions).set({ evidence: {} }).where(eq(issueRecoveryActions.id, action.id));
    const resumed = await heartbeat.wakeup(agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "issue_resumed",
      requestedByActorType: "user", requestedByActorId: "board-user",
      payload: { issueId: blockedIssueId }, contextSnapshot: { issueId: blockedIssueId },
    });
    expect(resumed?.contextSnapshot?.wakeCommentIds).toEqual(commentIds);
    const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(receipts.filter((row) => row.status === "coalesced")).toHaveLength(2);
  });

  it("retries a resolved dependency wake when the prior wake was skipped as stale", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    // The route-time wake writes the level-triggered state key. A skip records a
    // `skipped` row with that key. `skipped` is not an in-flight status, so the
    // backstop must still re-emit for the same ready state.
    const idempotencyKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "skipped",
      finishedAt: new Date(),
      error: "Cancelled because issue assignee changed before the queued run could start",
      idempotencyKey,
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.existingWakeSkipped).toBe(0);

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")))
      .orderBy(agentWakeupRequests.requestedAt);

    expect(wakes).toHaveLength(2);
    expect(wakes.map((wake) => wake.status)).toContain("skipped");
    expect(wakes.every((wake) => wake.idempotencyKey === idempotencyKey)).toBe(true);
    expect(wakes.some((wake) => ["queued", "claimed", "completed"].includes(wake.status))).toBe(true);
  });

  it("waits for workspace finalize before healing a resolved blocked dependent", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId, executionWorkspaceId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "not_finalized" });
    const heartbeat = heartbeatService(db);

    const beforeFinalize = await heartbeat.reconcileResolvedDependencyWakes();

    expect(beforeFinalize.healed).toBe(0);
    expect(beforeFinalize.notReadySkipped).toBe(1);

    const wakesBeforeFinalize = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakesBeforeFinalize).toHaveLength(0);

    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: blockerIssueId,
      phase: "workspace_finalize",
      status: "succeeded",
      startedAt: new Date(),
    });

    const afterFinalize = await heartbeat.reconcileResolvedDependencyWakes();

    expect(afterFinalize.healed).toBe(1);
    expect(afterFinalize.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);
    expect(wake).toMatchObject({
      reason: "issue_blockers_resolved",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });
  });

  it("does not duplicate an existing dependency wake keyed to any resolved blocker", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const secondBlockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondBlockerIssueId,
      companyId,
      title: "Second completed blocker",
      status: "done",
      priority: "medium",
      issueNumber: 3,
      identifier: "R-MULTI-3",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: secondBlockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const readiness = await issueService(db).getDependencyReadiness(blockedIssueId);
    const blockerIdNotUsedByBackstop = readiness.blockerIssueIds.find((id) => id !== blockerIssueId);
    if (!blockerIdNotUsedByBackstop) {
      throw new Error("Expected a second blocker id in dependency readiness");
    }
    expect(blockerIdNotUsedByBackstop).toBe(secondBlockerIssueId);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIdNotUsedByBackstop,
      },
      status: "queued",
      idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${blockerIdNotUsedByBackstop}`,
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    expect(result.existingWakeSkipped).toBe(1);

    const wakes = await db
      .select({
        id: agentWakeupRequests.id,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.idempotencyKey).toBe(
      `issue_blockers_resolved:${blockedIssueId}:${blockerIdNotUsedByBackstop}`,
    );
  });

  it("heals a multi-blocker dependent when only a completed wake for an earlier blocker exists", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const secondBlockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondBlockerIssueId,
      companyId,
      title: "Earlier completed blocker",
      status: "done",
      priority: "medium",
      issueNumber: 3,
      identifier: "R-MULTI-3",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: secondBlockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    // An earlier partial resolution left a `completed` per-edge wake. The bug was
    // that this stale wake suppressed the wake for the current ready state. The
    // level-triggered dedup keys on the full blocker set, so this completed wake
    // no longer strands the dependent.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: secondBlockerIssueId,
      },
      status: "completed",
      finishedAt: new Date(),
      idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${secondBlockerIssueId}`,
    });

    const readiness = await issueService(db).getDependencyReadiness(blockedIssueId);
    expect(readiness.isDependencyReady).toBe(true);

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);
    expect(result.existingWakeSkipped).toBe(0);

    const stateKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: readiness.blockerIssueIds,
    });
    const healedWake = await db
      .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, stateKey)))
      .then((rows) => rows[0] ?? null);
    expect(healedWake).not.toBeNull();
    expect(["queued", "claimed", "completed"]).toContain(healedWake?.status);

    // A second reconciliation pass finds the state-key wake and stays bounded:
    // it heals nothing more and never enqueues a second wake for the same state.
    const secondPass = await heartbeatService(db).reconcileResolvedDependencyWakes();
    expect(secondPass.healed).toBe(0);

    const stateKeyWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, stateKey)));
    expect(stateKeyWakes).toHaveLength(1);
  });

  it("heals a blocked dependent after a terminal reset when a previous-cycle old-key wake exists", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const previousCycleWakeAt = new Date("2026-07-01T12:00:00.000Z");
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    await db
      .update(issues)
      .set({ blockedTransitionAt, updatedAt: blockedTransitionAt })
      .where(eq(issues.id, blockedIssueId));
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "completed",
      finishedAt: previousCycleWakeAt,
      requestedAt: previousCycleWakeAt,
      idempotencyKey: buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);
    expect(result.existingWakeSkipped).toBe(0);

    const cycleKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt,
    });
    const healedWake = await db
      .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, cycleKey)))
      .then((rows) => rows[0] ?? null);
    expect(healedWake).not.toBeNull();
    expect(["queued", "claimed", "completed"]).toContain(healedWake?.status);

    const secondPass = await heartbeatService(db).reconcileResolvedDependencyWakes();
    expect(secondPass.healed).toBe(0);

    const cycleKeyWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, cycleKey)));
    expect(cycleKeyWakes).toHaveLength(1);
  });

  it("does not re-heal when a completed old-key wake is from the current blocked cycle", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    const sameCycleWakeAt = new Date("2026-08-01T12:00:01.000Z");
    await db
      .update(issues)
      .set({ blockedTransitionAt, updatedAt: blockedTransitionAt })
      .where(eq(issues.id, blockedIssueId));
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "completed",
      finishedAt: sameCycleWakeAt,
      requestedAt: sameCycleWakeAt,
      idempotencyKey: buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    expect(result.existingWakeSkipped).toBe(1);
  });

  it("does not re-wake an assignee agent that opened the current blocked cycle itself", async () => {
    const { companyId, agentId, blockedIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    await db
      .update(issues)
      .set({ blockedTransitionAt, updatedAt: blockedTransitionAt })
      .where(eq(issues.id, blockedIssueId));
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: blockedIssueId,
      details: { status: "blocked", changes: { status: { from: "in_progress", to: "blocked" } } },
      createdAt: blockedTransitionAt,
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    expect(result.selfBlockedSkipped).toBe(1);
  });

  it("heals a self-blocked issue after a later board edit in the same blocked cycle", async () => {
    const { companyId, agentId, blockedIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    await db
      .update(issues)
      .set({ blockedTransitionAt, updatedAt: blockedTransitionAt })
      .where(eq(issues.id, blockedIssueId));
    await db.insert(activityLog).values([
      {
        companyId, actorType: "agent", actorId: agentId, agentId, action: "issue.updated",
        entityType: "issue", entityId: blockedIssueId, details: { status: "blocked" }, createdAt: blockedTransitionAt,
      },
      {
        companyId, actorType: "user", actorId: "board-user", action: "issue.updated",
        entityType: "issue", entityId: blockedIssueId, details: { blockedByIssueIds: [] },
        createdAt: new Date("2026-08-01T12:05:00.000Z"),
      },
    ]);

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.selfBlockedSkipped).toBe(0);
    expect(result.healed).toBe(1);
  });

  it("still heals when someone other than the assignee opened the blocked cycle", async () => {
    const { companyId, agentId, blockedIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    await db
      .update(issues)
      .set({ blockedTransitionAt, updatedAt: blockedTransitionAt })
      .where(eq(issues.id, blockedIssueId));
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: blockedIssueId,
      details: { status: "blocked" },
      createdAt: blockedTransitionAt,
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.selfBlockedSkipped).toBe(0);
    expect(result.healed).toBe(1);
    void agentId;
  });

  it("counts null dependency wake returns as deferred instead of enqueue failures", async () => {
    const { companyId, agentId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    await db
      .update(agents)
      .set({
        runtimeConfig: { heartbeat: { wakeOnDemand: false, maxConcurrentRuns: 1 } },
      })
      .where(eq(agents.id, agentId));

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    expect(result.deferredOrFailed).toBe(1);
    expect(result.enqueueFailed).toBe(0);

    const skippedWake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)))
      .then((rows) => rows[0] ?? null);
    expect(skippedWake).toMatchObject({
      status: "skipped",
      reason: "heartbeat.wakeOnDemand.disabled",
    });
  });

});
