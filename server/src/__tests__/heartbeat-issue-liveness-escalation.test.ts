import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issueTreeHolds,
  issues,
  projects,
  projectWorkspaces,
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
import { instanceSettingsService } from "../services/instance-settings.ts";
import { issueService } from "../services/issues.ts";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.ts";
import { runningProcesses } from "../adapters/index.ts";
import { DEFAULT_LIVENESS_REESCALATION_COOLDOWN_MS } from "../services/recovery/service.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue liveness escalation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat issue graph liveness escalation", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-issue-liveness-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
    await instanceSettingsService(db).updateExperimental({
      enableIssueGraphLivenessAutoRecovery: false,
      enableIsolatedWorkspaces: false,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function enableAutoRecovery() {
    await instanceSettingsService(db).updateExperimental({
      enableIssueGraphLivenessAutoRecovery: true,
    });
  }

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

  it("keeps liveness findings advisory when auto recovery is disabled", async () => {
    await instanceSettingsService(db).updateExperimental({
      enableIssueGraphLivenessAutoRecovery: false,
    });
    const { companyId } = await seedBlockedChain();
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.autoRecoveryEnabled).toBe(false);
    expect(result.escalationsCreated).toBe(0);
    expect(result.skippedAutoRecoveryDisabled).toBe(1);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
  });

  it("does not create recovery issues outside the configured lookback window", async () => {
    await enableAutoRecovery();
    const { companyId } = await seedBlockedChain({ outsideLookback: true });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(0);
    expect(result.skippedOutsideLookback).toBe(1);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
  });

  it("suppresses liveness escalation when the source issue is under an active pause hold", async () => {
    await enableAutoRecovery();
    const { companyId, blockedIssueId } = await seedBlockedChain();

    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: blockedIssueId,
      mode: "pause",
      status: "active",
      reason: "pause liveness recovery subtree",
      releasePolicy: { strategy: "manual" },
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(0);
    expect(result.existingEscalations).toBe(0);
    expect(result.skipped).toBe(1);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
  });

  it("treats an active executionRunId on the leaf blocker as a live execution path", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      status: "running",
      contextSnapshot: { issueId: blockedIssueId },
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, blockerIssueId));
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(0);
    expect(result.escalationsCreated).toBe(0);
  });

  it("retains one bounded escalation for an assigned backlog blocker until dependency state changes", async () => {
    await enableAutoRecovery();
    const { companyId, coderId, blockedIssueId, blockerIssueId } = await seedBlockedChain({
      blockerStatus: "backlog",
      blockerAssigneeAgentId: "coder",
    });
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileIssueGraphLiveness();
    const second = await heartbeat.reconcileIssueGraphLiveness();
    const third = await heartbeat.reconcileIssueGraphLiveness();

    expect(first.findings).toBe(1);
    expect(first.escalationsCreated).toBe(1);
    expect(second.findings).toBe(1);
    expect(second.escalationsCreated).toBe(0);
    expect(second.existingEscalations).toBe(1);
    expect(third.findings).toBe(1);
    expect(third.escalationsCreated).toBe(0);
    expect(third.existingEscalations).toBe(1);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerIssueId,
      assigneeAgentId: coderId,
      originId: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "blocked_by_assigned_backlog_issue",
        blockerIssueId,
      ].join(":"),
      originFingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_assigned_backlog_issue",
        blockerIssueId,
      ].join(":"),
    });

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, blockedIssueId));
    expect(comments).toHaveLength(1);
    const wakeups = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakeups.filter((row) => row.payload?.incidentKey === escalations[0]?.originId)).toHaveLength(1);
  });

  it("treats an old pending request_confirmation as a durable waiting path", async () => {
    await enableAutoRecovery();
    const { companyId, blockerIssueId } = await seedBlockedChain({
      blockerStatus: "backlog",
      blockerAssigneeAgentId: "coder",
    });
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: blockerIssueId,
      kind: "request_confirmation",
      status: "pending",
      payload: { version: 1, prompt: "Should this parked work proceed?" },
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.findings).toBe(0);
    expect(result.escalationsCreated).toBe(0);
  });

  it("surfaces a stale pending interaction without resolving the responder's request", async () => {
    await enableAutoRecovery();
    const { companyId, blockedIssueId, blockerIssueId } = await seedBlockedChain({
      blockerStatus: "backlog",
      blockerAssigneeAgentId: "coder",
    });
    const interactionId = randomUUID();
    const staleAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId: blockerIssueId,
      kind: "ask_user_questions",
      status: "pending",
      payload: { version: 1, prompt: "Should this parked work proceed?" },
      createdAt: staleAt,
      updatedAt: staleAt,
    });
    // Interaction creation normally touches the issue. Backdate the complete
    // dependency path to reproduce a periodic reconciliation after both that
    // touch and the response lease have aged past the default 24-hour lookback.
    await db
      .update(issues)
      .set({ updatedAt: staleAt })
      .where(inArray(issues.id, [blockedIssueId, blockerIssueId]));

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(1);
    const [interaction] = await db
      .select({ status: issueThreadInteractions.status })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId));
    expect(interaction?.status).toBe("pending");
    const escalations = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, "harness_liveness_escalation"),
      ));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerIssueId,
      originId: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "blocked_by_assigned_backlog_issue",
        blockerIssueId,
      ].join(":"),
    });
  });

  it("creates one manager escalation, preserves blockers, and records owner selection", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileIssueGraphLiveness();

    expect(first.escalationsCreated).toBe(1);
    const [sourceAfterFirst] = await db
      .select({ updatedAt: issues.updatedAt })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    const eventsAfterFirst = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(eventsAfterFirst.filter((event) => event.action === "issue.blockers.updated")).toHaveLength(1);

    const second = await heartbeat.reconcileIssueGraphLiveness();

    expect(second.escalationsCreated).toBe(0);
    const [sourceAfterSecond] = await db
      .select({ updatedAt: issues.updatedAt })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    expect(sourceAfterSecond?.updatedAt.getTime()).toBe(sourceAfterFirst?.updatedAt.getTime());

    const escalations = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "harness_liveness_escalation"),
        ),
      );
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerIssueId,
      assigneeAgentId: managerId,
      assigneeAdapterOverrides: { modelProfile: "cheap" },
      status: expect.stringMatching(/^(todo|in_progress|done)$/),
      originFingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_unassigned_issue",
        blockerIssueId,
      ].join(":"),
    });

    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.map((row) => row.blockerIssueId).sort()).toEqual(
      [blockerIssueId, escalations[0]!.id].sort(),
    );

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Action needed:");
    expect(comments[0]?.presentation).toMatchObject({
      kind: "system_notice",
      title: "Needs unblock",
      detailsDefaultOpen: false,
    });
    expect(comments[0]?.body).toContain(escalations[0]?.identifier ?? escalations[0]!.id);

    const events = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const createdEvent = events.find((event) => event.action === "issue.harness_liveness_escalation_created");
    expect(createdEvent).toBeTruthy();
    expect(createdEvent?.details).toMatchObject({
      recoveryIssueId: blockerIssueId,
      ownerSelection: {
        selectedAgentId: managerId,
        selectedReason: "root_agent",
        selectedSourceIssueId: blockerIssueId,
      },
      workspaceSelection: {
        reuseRecoveryExecutionWorkspace: false,
        inheritedExecutionWorkspaceFromIssueId: null,
        projectWorkspaceSourceIssueId: blockerIssueId,
      },
    });
    expect(events.filter((event) => event.action === "issue.blockers.updated")).toHaveLength(1);
  });

  it("creates exactly one reporting-manager escalation for an agent-owned blocked issue with no blockers", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId } = await seedBlockedChain();
    await db
      .delete(issueRelations)
      .where(and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.relatedIssueId, blockedIssueId),
      ));
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileIssueGraphLiveness();
    const second = await heartbeat.reconcileIssueGraphLiveness();
    const third = await heartbeat.reconcileIssueGraphLiveness();

    expect(first).toMatchObject({
      findings: 1,
      escalationsCreated: 1,
      existingEscalations: 0,
      boardEscalationsCreated: 0,
    });
    expect(second).toMatchObject({
      findings: 1,
      escalationsCreated: 0,
      existingEscalations: 1,
    });
    expect(third).toMatchObject({
      findings: 1,
      escalationsCreated: 0,
      existingEscalations: 1,
    });

    const escalations = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, "harness_liveness_escalation"),
      ));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockedIssueId,
      assigneeAgentId: managerId,
      originId: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "blocked_without_action_path",
        blockedIssueId,
      ].join(":"),
      originFingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_without_action_path",
        blockedIssueId,
      ].join(":"),
    });

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, blockedIssueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Action needed:");
    expect(comments[0]?.metadata).toMatchObject({
      version: 1,
      sections: [expect.objectContaining({ title: "Recovery details" })],
    });

    const wakeups = await db
      .select({ agentId: agentWakeupRequests.agentId, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    const incidentWakeups = wakeups.filter(
      (row) => row.payload?.incidentKey === escalations[0]?.originId,
    );
    expect(incidentWakeups).toEqual([
      expect.objectContaining({ agentId: managerId }),
    ]);

    const events = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    expect(events.filter((event) =>
      event.action === "issue.harness_liveness_escalation_created" &&
      event.entityId === escalations[0]?.id
    )).toHaveLength(1);
    expect(events.find((event) =>
      event.action === "issue.harness_liveness_escalation_created" &&
      event.entityId === escalations[0]?.id
    )?.details).toMatchObject({
      findingState: "blocked_without_action_path",
      ownerSelection: {
        selectedAgentId: managerId,
        selectedReason: "assignee_reporting_chain",
        selectedSourceIssueId: blockedIssueId,
      },
    });

    const boardInteractions = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.companyId, companyId));
    expect(boardInteractions).toHaveLength(0);
  });

  it("creates one durable board interaction across three passes when no invokable company candidate exists", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, coderId, blockerIssueId } = await seedBlockedChain();
    await db
      .update(agents)
      .set({ status: "error" })
      .where(inArray(agents.id, [managerId, coderId]));
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileIssueGraphLiveness();
    const second = await heartbeat.reconcileIssueGraphLiveness();
    const third = await heartbeat.reconcileIssueGraphLiveness();

    expect(first).toMatchObject({
      findings: 1,
      escalationsCreated: 0,
      boardEscalationsCreated: 1,
      existingBoardEscalations: 0,
      skipped: 0,
    });
    expect(second).toMatchObject({ findings: 0, boardEscalationsCreated: 0 });
    expect(third).toMatchObject({ findings: 0, boardEscalationsCreated: 0 });

    const interactions = await db
      .select()
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, companyId),
        eq(issueThreadInteractions.issueId, blockerIssueId),
      ));
    expect(interactions).toHaveLength(1);
    expect(interactions[0]).toMatchObject({
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "none",
      createdByAgentId: null,
      createdByUserId: null,
    });
    expect(interactions[0]?.idempotencyKey).toMatch(/^harness-liveness-board:[a-f0-9]{64}:1$/);
    expect(interactions[0]?.payload).toMatchObject({
      version: 1,
      context: {
        kind: "issue_graph_liveness_board_escalation",
        version: 1,
        generation: 1,
        cause: "no_invokable_same_company_candidate",
        companyId,
        recoveryIssue: { id: blockerIssueId },
        budgetBlockedCandidateAgentIds: [],
        continuation: {
          issueId: blockerIssueId,
          policy: "none",
          questionId: "continuation_path",
          boardStateChangeRequiredBeforeSubmit: true,
          automaticWake: false,
        },
      },
      questions: [expect.objectContaining({
        id: "continuation_path",
        selectionMode: "single",
        required: true,
      })],
    });

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
    const events = await db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "issue.harness_liveness_board_escalation_created"),
      ));
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({
      cause: "no_invokable_same_company_candidate",
      recoveryIssueId: blockerIssueId,
      interactionId: interactions[0]?.id,
      budgetBlockedCandidateAgentIds: [],
      continuation: {
        issueId: blockerIssueId,
        interactionId: interactions[0]?.id,
        policy: "none",
      },
    });

    const boardQueue = await issueService(db).list(companyId, {
      awaitingDecisionForUserId: "board-user",
    });
    expect(boardQueue.map((issue) => issue.id)).toContain(blockerIssueId);

    // Answering without making the selected state change must not permanently
    // mask the live incident. The next pass creates exactly one new generation,
    // and that pending generation then deduplicates subsequent passes.
    await issueThreadInteractionService(db).answerQuestions(
      { id: blockerIssueId, companyId },
      interactions[0]!.id,
      {
        answers: [{
          questionId: "continuation_path",
          optionIds: ["assign_or_restore_owner"],
        }],
      },
      { userId: "board-user" },
    );
    const afterUnfulfilledAnswer = await heartbeat.reconcileIssueGraphLiveness();
    const afterReplacementPending = await heartbeat.reconcileIssueGraphLiveness();
    const finalDedupePass = await heartbeat.reconcileIssueGraphLiveness();
    expect(afterUnfulfilledAnswer).toMatchObject({
      findings: 1,
      boardEscalationsCreated: 1,
      existingBoardEscalations: 0,
    });
    expect(afterReplacementPending).toMatchObject({ findings: 0, boardEscalationsCreated: 0 });
    expect(finalDedupePass).toMatchObject({ findings: 0, boardEscalationsCreated: 0 });

    const regeneratedInteractions = await db
      .select()
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, companyId),
        eq(issueThreadInteractions.issueId, blockerIssueId),
      ));
    expect(regeneratedInteractions).toHaveLength(2);
    expect(regeneratedInteractions.map((interaction) => interaction.status).sort()).toEqual([
      "answered",
      "pending",
    ]);
    expect(regeneratedInteractions.map((interaction) => interaction.idempotencyKey).sort()).toEqual([
      expect.stringMatching(/^harness-liveness-board:[a-f0-9]{64}:1$/),
      expect.stringMatching(/^harness-liveness-board:[a-f0-9]{64}:2$/),
    ]);
    const replacement = regeneratedInteractions.find((interaction) => interaction.status === "pending");
    expect(replacement?.payload).toMatchObject({
      context: {
        kind: "issue_graph_liveness_board_escalation",
        generation: 2,
        recoveryIssue: { id: blockerIssueId },
      },
    });
  });

  it("does not self-escalate an actionless blocked issue when its assignee is the only invokable root", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, coderId, blockedIssueId } = await seedBlockedChain();
    await db
      .delete(issueRelations)
      .where(and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.relatedIssueId, blockedIssueId),
      ));
    await db.update(agents).set({ reportsTo: null }).where(eq(agents.id, coderId));
    await db.update(agents).set({ status: "error" }).where(eq(agents.id, managerId));

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result).toMatchObject({
      findings: 1,
      escalationsCreated: 0,
      boardEscalationsCreated: 1,
      skipped: 0,
    });
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
    const interactions = await db
      .select()
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, companyId),
        eq(issueThreadInteractions.issueId, blockedIssueId),
      ));
    expect(interactions).toHaveLength(1);
    expect(interactions[0]?.payload).toMatchObject({
      context: {
        cause: "stranded_assignee_is_only_invokable_candidate",
        recoveryIssue: { id: blockedIssueId },
        companyAgents: expect.arrayContaining([
          expect.objectContaining({
            agentId: coderId,
            invokable: true,
            excludedAsStrandedAssignee: true,
          }),
        ]),
      },
    });
  });

  it("deduplicates shared-leaf board recovery and preserves every source incident", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, coderId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const secondBlockedIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondBlockedIssueId,
      companyId,
      title: "Second blocked source sharing one leaf",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: coderId,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: secondBlockedIssueId,
      type: "blocks",
    });
    await db
      .update(agents)
      .set({ status: "error" })
      .where(inArray(agents.id, [managerId, coderId]));
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileIssueGraphLiveness();
    const second = await heartbeat.reconcileIssueGraphLiveness();
    const third = await heartbeat.reconcileIssueGraphLiveness();

    expect(first).toMatchObject({
      findings: 2,
      boardEscalationsCreated: 1,
      existingBoardEscalations: 1,
      skipped: 0,
    });
    expect(first.boardInteractionIds).toHaveLength(1);
    expect(second).toMatchObject({ findings: 0, boardEscalationsCreated: 0 });
    expect(third).toMatchObject({ findings: 0, boardEscalationsCreated: 0 });

    const interactions = await db
      .select()
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, companyId),
        eq(issueThreadInteractions.issueId, blockerIssueId),
      ));
    expect(interactions).toHaveLength(1);
    expect(interactions[0]).toMatchObject({
      status: "pending",
      continuationPolicy: "none",
    });
    const context = (interactions[0]?.payload as {
      context?: {
        sourceIncidentCount?: number;
        sourceIncidents?: Array<{
          incidentKey?: string;
          sourceIssue?: { id?: string };
          recoveryIssueId?: string;
        }>;
      };
    }).context;
    expect(context?.sourceIncidentCount).toBe(2);
    expect(context?.sourceIncidents).toHaveLength(2);
    expect(context?.sourceIncidents?.map((incident) => incident.sourceIssue?.id).sort()).toEqual(
      [blockedIssueId, secondBlockedIssueId].sort(),
    );
    expect(context?.sourceIncidents?.every((incident) =>
      incident.recoveryIssueId === blockerIssueId &&
      typeof incident.incidentKey === "string"
    )).toBe(true);

    const events = await db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "issue.harness_liveness_board_escalation_created"),
      ));
    expect(events).toHaveLength(1);
  });

  it("does not let an active source recovery action owned by an errored agent mask liveness", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, coderId, blockedIssueId, blockerIssueId } = await seedBlockedChain({
      blockerStatus: "blocked",
      blockerAssigneeAgentId: "coder",
    });
    await db.update(agents).set({ status: "error" }).where(eq(agents.id, coderId));
    await db.insert(issueRecoveryActions).values({
      id: randomUUID(),
      companyId,
      sourceIssueId: blockerIssueId,
      recoveryIssueId: null,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: coderId,
      ownerUserId: null,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      fingerprint: `source_scoped_recovery:${companyId}:${blockerIssueId}:stranded_assigned_issue`,
      evidence: { latestRunErrorCode: "process_lost" },
      nextAction: "Restore a live execution path.",
      attemptCount: 1,
      lastAttemptAt: new Date(),
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(1);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerIssueId,
      assigneeAgentId: managerId,
      originId: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "blocked_by_uninvokable_assignee",
        blockerIssueId,
      ].join(":"),
    });
  });

  it("creates sibling escalation when the blocked leaf is already a child issue", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    await db
      .update(issues)
      .set({ parentId: blockedIssueId })
      .where(eq(issues.id, blockerIssueId));

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(1);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockedIssueId,
      assigneeAgentId: managerId,
      originId: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "blocked_by_unassigned_issue",
        blockerIssueId,
      ].join(":"),
    });

    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.map((row) => row.blockerIssueId).sort()).toEqual(
      [blockerIssueId, escalations[0]!.id].sort(),
    );
  });

  it("falls back to top-level escalation when the recovery target is nested below a child issue", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const rootIssueId = randomUUID();

    await db.insert(issues).values({
      id: rootIssueId,
      companyId,
      title: "Root parent",
      status: "in_progress",
      priority: "medium",
    });
    await db
      .update(issues)
      .set({ parentId: rootIssueId })
      .where(eq(issues.id, blockedIssueId));
    await db
      .update(issues)
      .set({ parentId: blockedIssueId })
      .where(eq(issues.id, blockerIssueId));

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(1);
    expect(result.failed).toBe(0);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: null,
      assigneeAgentId: managerId,
    });
  });

  it("falls back to top-level escalation when the preferred parent is at the lane cap", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    await db
      .update(issues)
      .set({ parentId: blockedIssueId })
      .where(eq(issues.id, blockerIssueId));
    await db.insert(issues).values(
      Array.from({ length: 9 }, (_, index) => ({
        id: randomUUID(),
        companyId,
        parentId: blockedIssueId,
        title: `Existing lane ${index + 1}`,
        status: "done",
        priority: "medium",
      })),
    );

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(1);
    expect(result.failed).toBe(0);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: null,
      assigneeAgentId: managerId,
    });

    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.map((row) => row.blockerIssueId).sort()).toEqual(
      [blockerIssueId, escalations[0]!.id].sort(),
    );
  });

  it("creates a structured board interaction when every same-company candidate is budget-blocked", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, coderId, blockerIssueId } = await seedBlockedChain();
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "company",
      scopeId: companyId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1,
      hardStopEnabled: true,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId,
      agentId: coderId,
      issueId: blockerIssueId,
      provider: "test",
      biller: "test",
      billingType: "tokens",
      model: "test-model",
      costCents: 1,
      occurredAt: new Date(),
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result).toMatchObject({
      findings: 1,
      escalationsCreated: 0,
      boardEscalationsCreated: 1,
      existingBoardEscalations: 0,
      skipped: 0,
    });
    const interactions = await db
      .select()
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, companyId),
        eq(issueThreadInteractions.issueId, blockerIssueId),
      ));
    expect(interactions).toHaveLength(1);
    expect(interactions[0]?.payload).toMatchObject({
      context: {
        cause: "all_same_company_candidates_budget_blocked",
        companyId,
        recoveryIssue: { id: blockerIssueId },
        budgetBlockedCandidateAgentIds: [managerId, coderId],
      },
    });
    const interactionContext = (interactions[0]?.payload as {
      context?: { candidates?: Array<Record<string, unknown>> };
    }).context;
    expect(interactionContext?.candidates).toHaveLength(2);
    expect(interactionContext?.candidates?.[0]).toMatchObject({
      agentId: managerId,
      reason: "root_agent",
      eligible: true,
      budgetBlock: {
        scopeType: "company",
        scopeId: companyId,
      },
    });
    expect(interactionContext?.candidates?.[1]).toMatchObject({
      agentId: coderId,
      reason: "ordered_invokable_fallback",
      eligible: true,
      budgetBlock: {
        scopeType: "company",
        scopeId: companyId,
      },
    });
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
  });

  it("skips budget-blocked direct owners and assigns recovery to the manager fallback", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, coderId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const issueTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db
      .update(issues)
      .set({
        status: "in_review",
        assigneeAgentId: coderId,
        updatedAt: issueTimestamp,
      })
      .where(eq(issues.id, blockerIssueId));
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: coderId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1,
      hardStopEnabled: true,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId,
      agentId: coderId,
      issueId: blockerIssueId,
      provider: "test",
      biller: "test",
      billingType: "tokens",
      model: "test-model",
      costCents: 1,
      occurredAt: new Date(),
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.escalationsCreated).toBe(1);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerIssueId,
      assigneeAgentId: managerId,
      originId: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "in_review_without_action_path",
        blockerIssueId,
      ].join(":"),
    });

    const events = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const createdEvent = events.find((event) => event.action === "issue.harness_liveness_escalation_created");
    expect(createdEvent?.details).toMatchObject({
      ownerSelection: {
        selectedAgentId: managerId,
        selectedReason: "assignee_reporting_chain",
        budgetBlockedCandidateAgentIds: [coderId],
      },
    });
  });

  it("creates executable recovery when an invokable agent review participant has no delivery path", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, coderId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    await db
      .update(agents)
      .set({ runtimeConfig: { heartbeat: { wakeOnDemand: true } } })
      .where(inArray(agents.id, [managerId, coderId]));
    await db
      .update(issues)
      .set({
        status: "in_review",
        assigneeAgentId: coderId,
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: managerId, userId: null },
          returnAssignee: { type: "agent", agentId: coderId, userId: null },
        },
      })
      .where(eq(issues.id, blockerIssueId));

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result).toMatchObject({
      findings: 1,
      escalationsCreated: 1,
      skipped: 0,
    });
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerIssueId,
      status: "todo",
      originId: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "in_review_without_action_path",
        blockerIssueId,
      ].join(":"),
    });
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakeups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reason: "issue_assigned",
        payload: expect.objectContaining({
          issueId: escalations[0]!.id,
          sourceIssueId: blockedIssueId,
          recoveryIssueId: blockerIssueId,
        }),
      }),
    ]));
  });

  it("does not let an orphaned deferred wake mask a stalled agent review", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, coderId, blockerIssueId } = await seedBlockedChain();
    await db
      .update(agents)
      .set({ runtimeConfig: { heartbeat: { wakeOnDemand: true } } })
      .where(inArray(agents.id, [managerId, coderId]));
    await db
      .update(issues)
      .set({
        status: "in_review",
        assigneeAgentId: coderId,
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: managerId, userId: null },
        },
      })
      .where(eq(issues.id, blockerIssueId));
    const staleAt = new Date(Date.now() - 6 * 60 * 1000);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: managerId,
      source: "assignment",
      reason: "issue_execution_deferred",
      status: "deferred_issue_execution",
      payload: { issueId: blockerIssueId },
      requestedAt: staleAt,
      createdAt: staleAt,
      updatedAt: staleAt,
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result).toMatchObject({ findings: 1, escalationsCreated: 1 });
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(recoveryIssues).toHaveLength(1);
    const recoveryWake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId))
      .then((rows) => rows.find((row) => row.payload?.issueId === recoveryIssues[0]?.id));
    expect(recoveryWake).toBeTruthy();
  });

  it("allows a fresh deferred wake its bounded dispatch lease", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, coderId, blockerIssueId } = await seedBlockedChain();
    await db
      .update(issues)
      .set({
        status: "in_review",
        assigneeAgentId: coderId,
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: managerId, userId: null },
        },
      })
      .where(eq(issues.id, blockerIssueId));
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: managerId,
      source: "assignment",
      reason: "issue_execution_deferred",
      status: "deferred_issue_execution",
      payload: { issueId: blockerIssueId },
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result).toMatchObject({ findings: 0, escalationsCreated: 0 });
  });

  it("parents recovery under the leaf blocker without inheriting dependent or blocker execution state for manager-owned recovery", async () => {
    await enableAutoRecovery();
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    const companyId = randomUUID();
    const managerId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const dependentProjectId = randomUUID();
    const blockerProjectId = randomUUID();
    const dependentProjectWorkspaceId = randomUUID();
    const blockerProjectWorkspaceId = randomUUID();
    const dependentExecutionWorkspaceId = randomUUID();
    const blockerExecutionWorkspaceId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const issueTimestamp = new Date(Date.now() - 60 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "Root Operator",
      role: "operator",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await db.insert(projects).values([
      {
        id: dependentProjectId,
        companyId,
        name: "Dependent workspace project",
        status: "in_progress",
      },
      {
        id: blockerProjectId,
        companyId,
        name: "Blocker workspace project",
        status: "in_progress",
      },
    ]);
    await db.insert(projectWorkspaces).values([
      {
        id: dependentProjectWorkspaceId,
        companyId,
        projectId: dependentProjectId,
        name: "Dependent primary",
      },
      {
        id: blockerProjectWorkspaceId,
        companyId,
        projectId: blockerProjectId,
        name: "Blocker primary",
      },
    ]);
    await db.insert(executionWorkspaces).values([
      {
        id: dependentExecutionWorkspaceId,
        companyId,
        projectId: dependentProjectId,
        projectWorkspaceId: dependentProjectWorkspaceId,
        mode: "operator_branch",
        strategyType: "git_worktree",
        name: "Dependent branch",
        status: "active",
        providerType: "git_worktree",
      },
      {
        id: blockerExecutionWorkspaceId,
        companyId,
        projectId: blockerProjectId,
        projectWorkspaceId: blockerProjectWorkspaceId,
        mode: "operator_branch",
        strategyType: "git_worktree",
        name: "Blocker branch",
        status: "active",
        providerType: "git_worktree",
      },
    ]);
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        projectId: dependentProjectId,
        projectWorkspaceId: dependentProjectWorkspaceId,
        executionWorkspaceId: dependentExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "operator_branch" },
        title: "Blocked dependent",
        status: "blocked",
        priority: "medium",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
      {
        id: blockerIssueId,
        companyId,
        projectId: blockerProjectId,
        projectWorkspaceId: blockerProjectWorkspaceId,
        executionWorkspaceId: blockerExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "operator_branch" },
        title: "Unassigned leaf blocker",
        status: "todo",
        priority: "medium",
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

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.escalationsCreated).toBe(1);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerIssueId,
      projectId: blockerProjectId,
      projectWorkspaceId: blockerProjectWorkspaceId,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      assigneeAgentId: managerId,
      assigneeAdapterOverrides: { modelProfile: "cheap" },
    });
  });

  it("reuses one open recovery issue for multiple dependents with the same leaf blocker", async () => {
    await enableAutoRecovery();
    const { companyId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const secondBlockedIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const issueTimestamp = new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(issues).values({
      id: secondBlockedIssueId,
      companyId,
      title: "Second blocked parent",
      status: "blocked",
      priority: "medium",
      issueNumber: 3,
      identifier: `${issuePrefix}-3`,
      createdAt: issueTimestamp,
      updatedAt: issueTimestamp,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: secondBlockedIssueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(2);
    expect(result.escalationsCreated).toBe(1);
    expect(result.existingEscalations).toBe(1);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);

    const blockers = await db
      .select({ blockedIssueId: issueRelations.relatedIssueId })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.issueId, escalations[0]!.id)));
    expect(blockers.map((row) => row.blockedIssueId).sort()).toEqual(
      [blockedIssueId, secondBlockedIssueId].sort(),
    );
  });

  it("defers a fresh escalation during the terminal incident cooldown despite a classifier change", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const heartbeat = heartbeatService(db);
    const currentIncidentKey = [
      "harness_liveness",
      companyId,
      blockedIssueId,
      "blocked_by_unassigned_issue",
      blockerIssueId,
    ].join(":");
    const terminalIncidentKey = [
      "harness_liveness",
      companyId,
      blockedIssueId,
      "in_review_without_action_path",
      blockerIssueId,
    ].join(":");
    const closedEscalationId = randomUUID();

    await db.insert(issues).values({
      id: closedEscalationId,
      companyId,
      title: "Closed escalation",
      status: "done",
      priority: "high",
      parentId: blockedIssueId,
      assigneeAgentId: managerId,
      issueNumber: 3,
      identifier: "CLOSED-3",
      originKind: "harness_liveness_escalation",
      originId: terminalIncidentKey,
    });

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.escalationsCreated).toBe(0);
    expect(result.existingEscalations).toBe(0);

    const openEscalations = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "harness_liveness_escalation"),
        ),
      );
    expect(openEscalations).toHaveLength(1);
    expect(openEscalations[0]).toMatchObject({
      id: closedEscalationId,
      parentId: blockedIssueId,
      assigneeAgentId: managerId,
      status: "done",
    });

    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.some((row) => row.blockerIssueId === closedEscalationId)).toBe(false);
  });

  it("retries recovery after the terminal incident cooldown when the leaf remains stranded", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const terminalIncidentKey = [
      "harness_liveness",
      companyId,
      blockedIssueId,
      "in_review_without_action_path",
      blockerIssueId,
    ].join(":");
    const closedAt = new Date(
      Date.now() - DEFAULT_LIVENESS_REESCALATION_COOLDOWN_MS - 60_000,
    );
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Previous recovery attempt",
      status: "done",
      priority: "high",
      parentId: blockedIssueId,
      assigneeAgentId: managerId,
      issueNumber: 3,
      identifier: "CLOSED-3",
      originKind: "harness_liveness_escalation",
      originId: terminalIncidentKey,
      createdAt: closedAt,
      updatedAt: closedAt,
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result).toMatchObject({
      findings: 1,
      escalationsCreated: 1,
      skipped: 0,
    });
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(2);
    expect(escalations.map((issue) => issue.status).sort()).toEqual(["done", "todo"]);
    const retry = escalations.find((issue) => issue.status === "todo");
    expect(retry).toMatchObject({
      parentId: blockerIssueId,
      assigneeAgentId: managerId,
    });
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakeups.some((wakeup) => wakeup.payload?.issueId === retry?.id)).toBe(true);
  });
});
