import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  assets,
  budgetIncidents,
  budgetPolicies,
  companies,
  createDb,
  decisionQueueItems,
  decisionQueues,
  decisionArchiveNotificationOutbox,
  decisionRetention,
  decisions,
  decisionTriage,
  decisionTriageEvents,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  inboxDismissals,
  invites,
  issueApprovals,
  issueAttachments,
  issueDocuments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
  joinRequests,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { attentionRoutes } from "../routes/attention.js";
import { attentionService } from "../services/attention.js";
import { agentService } from "../services/agents.js";
import { ROUTABLE_BLOCKED_ROLLOUT_AT } from "../services/routable-blocked.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres attention service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("attention service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-service-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(inboxDismissals);
    await db.delete(decisionArchiveNotificationOutbox);
    await db.delete(decisionRetention);
    await db.delete(decisionTriageEvents);
    await db.delete(decisionTriage);
    await db.delete(decisionQueueItems);
    await db.delete(decisionQueues);
    await db.delete(decisions);
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(issueAttachments);
    await db.delete(issueDocuments);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(budgetIncidents);
    await db.delete(budgetPolicies);
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(issueRecoveryActions);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(assets);
    await db.delete(documents);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix = "ATN") {
    const companyId = randomUUID();
    const workerId = randomUUID();
    const reviewerId = randomUUID();
    const errorAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Co`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: workerId,
        companyId,
        name: "Worker",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerId,
        companyId,
        name: "Reviewer",
        role: "qa",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: errorAgentId,
        companyId,
        name: "Broken Agent",
        role: "engineer",
        status: "error",
        errorReason: "adapter config missing",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    return { companyId, workerId, reviewerId, errorAgentId, prefix };
  }

  async function insertIssue(input: {
    companyId: string;
    id?: string;
    identifier: string;
    title: string;
    status: string;
    priority?: string;
    parentId?: string | null;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
    originKind?: string;
    originId?: string | null;
    originFingerprint?: string;
    projectId?: string | null;
    projectWorkspaceId?: string | null;
    executionState?: Record<string, unknown> | null;
    updatedAt?: Date;
    createdAt?: Date;
    unblockDescriptor?: { owner: { userId: string } | "board"; action: string } | null;
    blockedTransitionAt?: Date | null;
    harnessKind?: string | null;
    reviewPolicy?: "anyone" | "not_creator" | "human_only" | null;
  }) {
    const id = input.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.title,
      status: input.status,
      priority: input.priority ?? "medium",
      reviewPolicy: input.reviewPolicy ?? null,
      parentId: input.parentId ?? null,
      projectId: input.projectId ?? null,
      projectWorkspaceId: input.projectWorkspaceId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      originKind: input.originKind ?? "manual",
      originId: input.originId ?? null,
      originFingerprint: input.originFingerprint ?? "default",
      executionState: input.executionState ?? null,
      unblockDescriptor: input.unblockDescriptor ?? null,
      blockedTransitionAt: input.blockedTransitionAt ?? null,
      harnessKind: input.harnessKind ?? null,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    });
    return id;
  }

  function pendingUserExecutionState(userId = "board-user") {
    return {
      status: "pending",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: "review",
      currentParticipant: { type: "user", userId },
      returnAssignee: null,
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      monitor: null,
    };
  }

  function pendingAgentExecutionState(agentId: string) {
    return {
      ...pendingUserExecutionState(),
      currentParticipant: { type: "agent", agentId },
    };
  }

  it("excludes internal harness reviews from items, counts, and decision queues", async () => {
    const { companyId, workerId } = await seedCompany("ATH");
    const harnessIssueId = await insertIssue({
      companyId,
      identifier: "ATH-1",
      title: "Internal harness review",
      status: "in_review",
      assigneeAgentId: workerId,
      harnessKind: "skill_test",
    });
    const queueId = randomUUID();
    await db.insert(decisionQueues).values({
      id: queueId,
      companyId,
      key: "internal-review",
      title: "Internal review",
      createdByType: "user",
      createdByUserId: "board-user",
    });
    await db.insert(decisionQueueItems).values({
      companyId,
      queueId,
      sourceKind: "review",
      sourceId: harnessIssueId,
      addedByType: "user",
      addedByUserId: "board-user",
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    expect(feed.items.some((item) => item.subject.id === harnessIssueId)).toBe(false);
    expect(feed.countsBySourceKind.review ?? 0).toBe(0);
    expect(feed.items.flatMap((item) => item.queues).some((queue) => queue.key === "internal-review")).toBe(false);
  });

  it("returns ranked decision-only items for every active source and excludes non-human or transient rows", async () => {
    const { companyId, workerId, reviewerId } = await seedCompany("ATN");
    const baseTime = new Date("2026-07-09T12:00:00.000Z");
    const interactionIssueId = await insertIssue({
      companyId,
      identifier: "ATN-1",
      title: "Needs interaction",
      status: "in_progress",
      assigneeAgentId: workerId,
      updatedAt: baseTime,
    });
    const recoverySourceIssueId = await insertIssue({
      companyId,
      identifier: "ATN-2",
      title: "Needs recovery",
      status: "in_progress",
      assigneeAgentId: workerId,
      updatedAt: baseTime,
    });
    const agentRecoverySourceIssueId = await insertIssue({
      companyId,
      identifier: "ATN-21",
      title: "Agent-owned recovery source",
      status: "in_progress",
      assigneeAgentId: workerId,
      updatedAt: baseTime,
    });
    const productivitySourceIssueId = await insertIssue({
      companyId,
      identifier: "ATN-3",
      title: "Needs productivity review source",
      status: "in_progress",
      assigneeAgentId: workerId,
      updatedAt: baseTime,
    });
    const agentProductivitySourceIssueId = await insertIssue({
      companyId,
      identifier: "ATN-31",
      title: "Agent productivity review source",
      status: "in_progress",
      assigneeAgentId: workerId,
      updatedAt: baseTime,
    });
    const blockerParentId = await insertIssue({
      companyId,
      identifier: "ATN-4",
      title: "Blocked parent",
      status: "blocked",
      blockedTransitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1),
      updatedAt: new Date("2026-07-09T12:04:00.000Z"),
    });
    const blockerLeafId = await insertIssue({
      companyId,
      identifier: "ATN-5",
      title: "Stalled review blocker",
      status: "in_review",
      assigneeAgentId: reviewerId,
      // PAP-16506: the /decisions review card states who may give the verdict,
      // so the subject has to carry the issue's opt-in constraint.
      reviewPolicy: "human_only",
      updatedAt: new Date("2026-07-09T12:05:00.000Z"),
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerLeafId,
      relatedIssueId: blockerParentId,
      type: "blocks",
    });
    const reviewUserIssueId = await insertIssue({
      companyId,
      identifier: "ATN-6",
      title: "Human review",
      status: "in_review",
      executionState: pendingUserExecutionState(),
      updatedAt: new Date("2026-07-09T12:06:00.000Z"),
    });
    await insertIssue({
      companyId,
      identifier: "ATN-7",
      title: "Agent review excluded",
      status: "in_review",
      executionState: pendingAgentExecutionState(reviewerId),
      updatedAt: new Date("2026-07-09T12:07:00.000Z"),
    });

    const pendingApprovalId = randomUUID();
    await db.insert(approvals).values([
      {
        id: pendingApprovalId,
        companyId,
        type: "hire_agent",
        status: "pending",
        payload: { title: "Hire Designer" },
        createdAt: new Date("2026-07-09T12:01:00.000Z"),
        updatedAt: new Date("2026-07-09T12:01:00.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        type: "hire_agent",
        status: "revision_requested",
        payload: { title: "Revision requested" },
        createdAt: new Date("2026-07-09T12:02:00.000Z"),
        updatedAt: new Date("2026-07-09T12:02:00.000Z"),
      },
    ]);

    await db.insert(issueThreadInteractions).values([
      {
        id: randomUUID(),
        companyId,
        issueId: interactionIssueId,
        kind: "ask_user_questions",
        status: "pending",
        continuationPolicy: "wake_assignee",
        title: "Pick a launch date",
        payload: { version: 1, questions: [] },
        createdAt: new Date("2026-07-09T12:03:00.000Z"),
        updatedAt: new Date("2026-07-09T12:03:00.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        issueId: interactionIssueId,
        kind: "ask_user_questions",
        status: "pending",
        continuationPolicy: "wake_assignee",
        addresseeAgentId: reviewerId,
        title: "Ask the reviewer privately",
        payload: { version: 1, questions: [] },
        createdAt: new Date("2026-07-09T12:03:15.000Z"),
        updatedAt: new Date("2026-07-09T12:03:15.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        issueId: interactionIssueId,
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee",
        title: "Already accepted",
        payload: { version: 1, prompt: "Already done" },
        createdAt: new Date("2026-07-09T12:03:30.000Z"),
        updatedAt: new Date("2026-07-09T12:03:30.000Z"),
      },
    ]);

    const inviteId = randomUUID();
    await db.insert(invites).values({
      id: inviteId,
      companyId,
      tokenHash: `hash-${inviteId}`,
      allowedJoinTypes: "both",
      expiresAt: new Date("2026-07-10T00:00:00.000Z"),
    });
    await db.insert(joinRequests).values({
      id: randomUUID(),
      inviteId,
      companyId,
      requestType: "human",
      status: "pending_approval",
      requestIp: "127.0.0.1",
      requestEmailSnapshot: "new@paperclip.test",
      createdAt: new Date("2026-07-09T12:04:00.000Z"),
      updatedAt: new Date("2026-07-09T12:04:00.000Z"),
    });

    await db.insert(issueRecoveryActions).values([
      {
        id: randomUUID(),
        companyId,
        sourceIssueId: recoverySourceIssueId,
        kind: "missing_disposition",
        status: "escalated",
        ownerType: "board",
        ownerAgentId: null,
        ownerUserId: null,
        cause: "missing_disposition",
        fingerprint: "human-recovery",
        evidence: {},
        nextAction: "Choose the final disposition.",
        createdAt: new Date("2026-07-09T12:05:00.000Z"),
        updatedAt: new Date("2026-07-09T12:05:00.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        sourceIssueId: agentRecoverySourceIssueId,
        kind: "stranded_assigned_issue",
        status: "active",
        ownerType: "agent",
        ownerAgentId: workerId,
        ownerUserId: null,
        cause: "stranded",
        fingerprint: "agent-recovery",
        evidence: {},
        nextAction: "Agent should self-heal.",
        createdAt: new Date("2026-07-09T12:05:30.000Z"),
        updatedAt: new Date("2026-07-09T12:05:30.000Z"),
      },
    ]);

    await insertIssue({
      companyId,
      identifier: "ATN-8",
      title: "Human productivity review",
      status: "todo",
      priority: "high",
      parentId: productivitySourceIssueId,
      assigneeUserId: "board-user",
      originKind: "issue_productivity_review",
      originId: productivitySourceIssueId,
      originFingerprint: `productivity-review:${productivitySourceIssueId}`,
      updatedAt: new Date("2026-07-09T12:08:00.000Z"),
    });
    await insertIssue({
      companyId,
      identifier: "ATN-9",
      title: "Agent productivity review excluded",
      status: "todo",
      priority: "high",
      parentId: agentProductivitySourceIssueId,
      assigneeAgentId: workerId,
      originKind: "issue_productivity_review",
      originId: agentProductivitySourceIssueId,
      originFingerprint: `productivity-review-agent:${agentProductivitySourceIssueId}`,
      updatedAt: new Date("2026-07-09T12:08:30.000Z"),
    });

    const exhaustedRunId = randomUUID();
    const transientRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: exhaustedRunId,
        companyId,
        agentId: workerId,
        invocationSource: "automation",
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        contextSnapshot: { issueId: reviewUserIssueId },
        scheduledRetryAttempt: 4,
        scheduledRetryReason: "transient_failure",
        createdAt: new Date("2026-07-09T12:09:00.000Z"),
        updatedAt: new Date("2026-07-09T12:09:00.000Z"),
        finishedAt: new Date("2026-07-09T12:09:00.000Z"),
      },
      {
        id: transientRunId,
        companyId,
        agentId: reviewerId,
        invocationSource: "automation",
        status: "failed",
        error: "will retry",
        errorCode: "provider_quota",
        contextSnapshot: { issueId: interactionIssueId },
        createdAt: new Date("2026-07-09T12:09:30.000Z"),
        updatedAt: new Date("2026-07-09T12:09:30.000Z"),
        finishedAt: new Date("2026-07-09T12:09:30.000Z"),
      },
    ]);
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId: exhaustedRunId,
      agentId: workerId,
      seq: 1,
      eventType: "lifecycle",
      message: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
      payload: { retryReason: "transient_failure", maxAttempts: 4 },
      createdAt: new Date("2026-07-09T12:09:01.000Z"),
    });

    const softPolicy85Id = randomUUID();
    const softPolicy84Id = randomUUID();
    const hardPolicyId = randomUUID();
    await db.insert(budgetPolicies).values([
      {
        id: softPolicy85Id,
        companyId,
        scopeType: "company",
        scopeId: companyId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
      },
      {
        id: softPolicy84Id,
        companyId,
        scopeType: "company",
        scopeId: companyId,
        metric: "billed_cents",
        windowKind: "lifetime",
        amount: 100,
      },
      {
        id: hardPolicyId,
        companyId,
        scopeType: "agent",
        scopeId: workerId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
      },
    ]);
    await db.insert(budgetIncidents).values([
      {
        companyId,
        policyId: softPolicy85Id,
        scopeType: "company",
        scopeId: companyId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        windowStart: new Date("2026-07-01T00:00:00.000Z"),
        windowEnd: new Date("2026-08-01T00:00:00.000Z"),
        thresholdType: "soft",
        amountLimit: 100,
        amountObserved: 85,
        status: "open",
        createdAt: new Date("2026-07-09T12:10:00.000Z"),
        updatedAt: new Date("2026-07-09T12:10:00.000Z"),
      },
      {
        companyId,
        policyId: softPolicy84Id,
        scopeType: "company",
        scopeId: companyId,
        metric: "billed_cents",
        windowKind: "lifetime",
        windowStart: new Date("1970-01-01T00:00:00.000Z"),
        windowEnd: new Date("9999-01-01T00:00:00.000Z"),
        thresholdType: "soft",
        amountLimit: 100,
        amountObserved: 84,
        status: "open",
        createdAt: new Date("2026-07-09T12:10:30.000Z"),
        updatedAt: new Date("2026-07-09T12:10:30.000Z"),
      },
      {
        companyId,
        policyId: hardPolicyId,
        scopeType: "agent",
        scopeId: workerId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        windowStart: new Date("2026-07-01T00:00:00.000Z"),
        windowEnd: new Date("2026-08-01T00:00:00.000Z"),
        thresholdType: "hard",
        amountLimit: 100,
        amountObserved: 100,
        status: "open",
        createdAt: new Date("2026-07-09T12:11:00.000Z"),
        updatedAt: new Date("2026-07-09T12:11:00.000Z"),
      },
    ]);

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    expect(feed.totalCount).toBe(12);
    expect(feed.countsBySourceKind).toMatchObject({
      approval: 1,
      issue_thread_interaction: 1,
      join_request: 1,
      recovery_action: 1,
      productivity_review: 1,
      blocker_attention: 1,
      review: 2,
      failed_run: 1,
      budget_alert: 2,
      agent_error_alert: 1,
    });
    expect(feed.items.map((item) => item.sourceKind)).toEqual(expect.arrayContaining([
      "approval",
      "issue_thread_interaction",
      "join_request",
      "recovery_action",
      "productivity_review",
      "blocker_attention",
      "review",
      "failed_run",
      "budget_alert",
      "agent_error_alert",
    ]));
    for (const item of feed.items) {
      expect(item.dedupKey).toBeTruthy();
      expect(item.dismissalKey).toBe(`attention:${item.dedupKey}`);
      expect(item.whyNow).toBeTruthy();
      expect(item.entryRule).toBeTruthy();
      expect(item.exitRule).toBeTruthy();
      expect(item.decisionVerbs.length).toBeGreaterThan(0);
      expect(item.rank).toBeGreaterThan(0);
    }
    expect(feed.items.some((item) => item.subject.title === "Revision requested")).toBe(false);
    expect(feed.items.some((item) => item.subject.title === "Agent productivity review excluded")).toBe(false);
    expect(feed.items.some((item) => item.subject.title === "Agent review excluded")).toBe(false);
    expect(feed.items.some((item) =>
      item.sourceKind === "failed_run" && item.subject.metadata?.errorCode === "provider_quota"
    )).toBe(false);
    expect(feed.items.find((item) => item.sourceKind === "approval")?.detail).toMatchObject({
      kind: "approval",
      approvalType: "hire_agent",
      summaryExcerpt: "Hire Designer",
    });
    expect(feed.items.find((item) => item.sourceKind === "issue_thread_interaction")?.detail).toMatchObject({
      kind: "questions",
      questionCount: 0,
    });
    expect(feed.items.find((item) => item.sourceKind === "blocker_attention")?.detail).toMatchObject({
      kind: "blocker",
      blockingIssue: null,
      blockedTaskCount: 1,
    });
    expect(feed.items.find((item) => item.sourceKind === "blocker_attention")?.subject.id).toBe(blockerLeafId);
    expect(feed.items.find((item) =>
      item.sourceKind === "review" && item.subject.title === "Stalled review blocker"
    )).toMatchObject({
      whyNow: expect.stringContaining("without a maintained"),
      // A stalled review resolves in-row on the /decisions card (PAP-16080 §4.4).
      inlineResolvable: true,
      subject: expect.objectContaining({
        metadata: expect.objectContaining({
          reviewAttentionState: "stalled",
          reviewPolicy: "human_only",
        }),
      }),
      decisionVerbs: expect.arrayContaining([
        expect.objectContaining({ id: "choose_review_path", label: "Choose review path" }),
      ]),
    });
    expect(feed.items.find((item) => item.sourceKind === "failed_run")?.detail).toMatchObject({
      kind: "failed_run",
      agentName: "Worker",
      failureReasonExcerpt: "adapter failed",
    });
    expect(feed.items.find((item) =>
      item.sourceKind === "budget_alert" && item.detail?.kind === "budget" && item.detail.observedPercent === 100
    )).toBeTruthy();
    expect(feed.items.find((item) => item.sourceKind === "agent_error_alert")?.detail).toMatchObject({
      kind: "agent_error",
      agentName: "Broken Agent",
      failureReasonExcerpt: "adapter config missing",
    });
  });

  it("returns addressed interactions to board attention after addressee pause or termination", async () => {
    const { companyId, reviewerId } = await seedCompany("ATF");
    const pausedReviewerId = randomUUID();
    const terminatedReviewerId = randomUUID();
    await db.insert(agents).values([
      {
        id: pausedReviewerId,
        companyId,
        name: "Paused Reviewer",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: terminatedReviewerId,
        companyId,
        name: "Terminated Reviewer",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    const issueId = await insertIssue({
      companyId,
      identifier: "ATF-1",
      title: "Needs a decision",
      status: "in_progress",
    });
    await db.insert(issueThreadInteractions).values([
      {
        id: randomUUID(),
        companyId,
        issueId,
        kind: "ask_user_questions",
        status: "pending",
        continuationPolicy: "wake_assignee",
        title: "Board question",
        payload: { version: 1, questions: [] },
      },
      {
        id: randomUUID(),
        companyId,
        issueId,
        kind: "ask_user_questions",
        status: "pending",
        continuationPolicy: "wake_assignee",
        addresseeAgentId: reviewerId,
        title: "Active reviewer question",
        payload: { version: 1, questions: [] },
      },
      {
        id: randomUUID(),
        companyId,
        issueId,
        kind: "ask_user_questions",
        status: "pending",
        continuationPolicy: "wake_assignee",
        addresseeAgentId: pausedReviewerId,
        title: "Paused reviewer question",
        payload: { version: 1, questions: [] },
      },
      {
        id: randomUUID(),
        companyId,
        issueId,
        kind: "ask_user_questions",
        status: "pending",
        continuationPolicy: "wake_assignee",
        addresseeAgentId: terminatedReviewerId,
        title: "Terminated reviewer question",
        payload: { version: 1, questions: [] },
      },
    ]);

    await agentService(db).pause(pausedReviewerId);
    await agentService(db).terminate(terminatedReviewerId);

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const interactionTitles = feed.items
      .filter((item) => item.sourceKind === "issue_thread_interaction")
      .map((item) => item.subject.title);

    expect(interactionTitles).toEqual(expect.arrayContaining([
      "Board question",
      "Paused reviewer question",
      "Terminated reviewer question",
    ]));
    expect(interactionTitles).not.toContain("Active reviewer question");
  });

  it("suppresses failed-run attention after a newer run for the same issue", async () => {
    const { companyId, workerId } = await seedCompany("ATN");
    const issueId = await insertIssue({
      companyId,
      identifier: "ATN-1",
      title: "Recoverable task",
      status: "in_progress",
    });
    const failedRunId = randomUUID();
    const failedAt = new Date("2026-07-09T12:00:00.000Z");

    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId: workerId,
        invocationSource: "automation",
        status: "failed",
        error: "adapter failed",
        contextSnapshot: { issueId },
        createdAt: failedAt,
        updatedAt: failedAt,
        finishedAt: failedAt,
      },
      {
        id: randomUUID(),
        companyId,
        agentId: workerId,
        invocationSource: "automation",
        status: "succeeded",
        contextSnapshot: { issueId },
        createdAt: new Date("2026-07-09T12:01:00.000Z"),
        updatedAt: new Date("2026-07-09T12:01:00.000Z"),
        finishedAt: new Date("2026-07-09T12:01:00.000Z"),
      },
    ]);
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId: failedRunId,
      agentId: workerId,
      seq: 1,
      eventType: "lifecycle",
      message: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
      createdAt: new Date("2026-07-09T12:00:01.000Z"),
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    expect(feed.items.filter((item) => item.sourceKind === "failed_run")).toEqual([]);
  });

  it("enriches interaction details with project, workspace, plan metadata, and images", async () => {
    const { companyId, workerId } = await seedCompany("ATE");
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const issueId = randomUUID();
    const planDocumentId = randomUUID();
    const planRevisionId = randomUUID();
    const imageAssetIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Attention Project",
      status: "in_progress",
      color: "#0f766e",
      icon: "rocket",
    });
    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      name: "Preview workspace",
      sourceType: "local_path",
      isPrimary: true,
    });
    await insertIssue({
      id: issueId,
      companyId,
      identifier: "ATE-1",
      title: "Approve launch plan",
      status: "in_progress",
      assigneeAgentId: workerId,
      projectId,
      projectWorkspaceId: workspaceId,
      updatedAt: new Date("2026-07-09T12:00:00.000Z"),
    });
    await db.insert(documents).values({
      id: planDocumentId,
      companyId,
      title: "Launch Plan",
      format: "markdown",
      latestBody: "# Summary\n\nThis plan explains the launch checklist, rollout owner, QA gates, and risk controls for the homepage release.",
      latestRevisionId: planRevisionId,
      latestRevisionNumber: 2,
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId: planDocumentId,
      key: "plan",
    });
    await db.insert(assets).values([
      { id: imageAssetIds[0], companyId, provider: "local_disk", objectKey: "img-1", contentType: "image/png", byteSize: 10, sha256: "a".repeat(64), originalFilename: "one.png" },
      { id: imageAssetIds[1], companyId, provider: "local_disk", objectKey: "img-2", contentType: "image/jpeg", byteSize: 10, sha256: "b".repeat(64), originalFilename: "two.jpg" },
      { id: imageAssetIds[2], companyId, provider: "local_disk", objectKey: "img-3", contentType: "image/gif", byteSize: 10, sha256: "c".repeat(64), originalFilename: "three.gif" },
      { id: imageAssetIds[3], companyId, provider: "local_disk", objectKey: "img-4", contentType: "image/png", byteSize: 10, sha256: "d".repeat(64), originalFilename: "four.png" },
    ]);
    await db.insert(issueAttachments).values(imageAssetIds.map((assetId, index) => ({
      companyId,
      issueId,
      assetId,
      createdAt: new Date(`2026-07-09T12:0${index}:30.000Z`),
      updatedAt: new Date(`2026-07-09T12:0${index}:30.000Z`),
    })));

    const planInteractionId = randomUUID();
    const questionsInteractionId = randomUUID();
    const tasksInteractionId = randomUUID();
    const checkboxInteractionId = randomUUID();
    const verdictInteractionId = randomUUID();
    await db.insert(issueThreadInteractions).values([
      {
        id: planInteractionId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        title: "Approve the plan",
        payload: {
          version: 1,
          prompt: "Approve plan?",
          acceptLabel: "Approve plan",
          rejectLabel: "Request changes",
          target: { type: "issue_document", issueId, key: "plan", revisionId: planRevisionId },
        },
        createdAt: new Date("2026-07-09T12:01:00.000Z"),
        updatedAt: new Date("2026-07-09T12:01:00.000Z"),
      },
      {
        id: questionsInteractionId,
        companyId,
        issueId,
        kind: "ask_user_questions",
        status: "pending",
        continuationPolicy: "wake_assignee",
        title: "Questions",
        payload: {
          version: 1,
          questions: [
            { id: "q1", prompt: "Which auth provider should we use?", selectionMode: "single", options: [] },
            { id: "q2", prompt: "Should we add a fallback?", selectionMode: "single", options: [] },
          ],
        },
        createdAt: new Date("2026-07-09T12:02:00.000Z"),
        updatedAt: new Date("2026-07-09T12:02:00.000Z"),
      },
      {
        id: tasksInteractionId,
        companyId,
        issueId,
        kind: "suggest_tasks",
        status: "pending",
        continuationPolicy: "wake_assignee",
        title: "Tasks",
        payload: { version: 1, tasks: [{ clientKey: "t1", title: "Build API" }, { clientKey: "t2", title: "Wire UI" }] },
        createdAt: new Date("2026-07-09T12:03:00.000Z"),
        updatedAt: new Date("2026-07-09T12:03:00.000Z"),
      },
      {
        id: checkboxInteractionId,
        companyId,
        issueId,
        kind: "request_checkbox_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        title: "Checkbox",
        payload: { version: 1, prompt: "Select rollout regions", options: [{ id: "us", label: "US" }, { id: "eu", label: "EU" }] },
        createdAt: new Date("2026-07-09T12:04:00.000Z"),
        updatedAt: new Date("2026-07-09T12:04:00.000Z"),
      },
      {
        id: verdictInteractionId,
        companyId,
        issueId,
        kind: "request_item_verdicts",
        status: "pending",
        continuationPolicy: "wake_assignee",
        title: "Verdicts",
        payload: { version: 1, prompt: "Approve these screenshots", items: [{ id: "one", label: "One" }, { id: "two", label: "Two" }] },
        createdAt: new Date("2026-07-09T12:05:00.000Z"),
        updatedAt: new Date("2026-07-09T12:05:00.000Z"),
      },
    ]);

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const interactionItems = feed.items.filter((item) => item.sourceKind === "issue_thread_interaction");
    const detailsByKind = new Map(interactionItems.map((item) => [item.detail?.kind, item]));

    const planItem = detailsByKind.get("plan_approval");
    expect(planItem?.subject.title).toBe("Plan approval - Approve launch plan");
    expect(planItem?.subject.metadata).toMatchObject({ isPlanTarget: true, targetDocumentKey: "plan" });
    expect(planItem?.decisionVerbs).toEqual([
      expect.objectContaining({ id: "accept", label: "Approve plan" }),
      expect.objectContaining({ id: "reject", label: "Request changes" }),
    ]);
    expect(planItem?.project).toMatchObject({
      id: projectId,
      name: "Attention Project",
      color: "#0f766e",
      icon: "rocket",
    });
    expect(planItem?.project?.urlKey).toEqual(expect.any(String));
    expect(planItem?.workspace).toEqual({ id: workspaceId, name: "Preview workspace" });
    expect(planItem?.detail).toMatchObject({
      kind: "plan_approval",
      issueTitle: "Approve launch plan",
      planTitle: "Launch Plan",
      summaryExcerpt: expect.stringContaining("launch checklist"),
      images: imageAssetIds.slice(0, 3).map((assetId) => ({ assetId, alt: expect.any(String) })),
    });
    expect(detailsByKind.get("questions")?.detail).toMatchObject({
      kind: "questions",
      questionCount: 2,
      firstQuestionText: "Which auth provider should we use?",
    });
    expect(detailsByKind.get("suggested_tasks")?.detail).toMatchObject({
      kind: "suggested_tasks",
      taskCount: 2,
      firstTaskTitle: "Build API",
    });
    expect(detailsByKind.get("checkbox_confirmation")?.detail).toMatchObject({
      kind: "checkbox_confirmation",
      optionCount: 2,
      promptExcerpt: "Select rollout regions",
    });
    expect(detailsByKind.get("item_verdicts")?.detail).toMatchObject({
      kind: "item_verdicts",
      itemCount: 2,
      promptExcerpt: "Approve these screenshots",
    });
  });

  it("shows only the newest pending confirmation per issue and kind", async () => {
    const { companyId, workerId, reviewerId } = await seedCompany("ATC");
    const issueId = await insertIssue({
      companyId,
      identifier: "ATC-1",
      title: "Repeated sign-offs",
      status: "in_review",
      assigneeAgentId: workerId,
    });
    const olderConfirmationId = randomUUID();
    const newerConfirmationId = randomUUID();
    const checkboxId = randomUUID();
    await db.insert(issueThreadInteractions).values([
      {
        id: olderConfirmationId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        createdByAgentId: workerId,
        title: "Approve V1",
        payload: { version: 1, prompt: "Approve V1?" },
        createdAt: new Date("2026-07-09T12:00:00.000Z"),
        updatedAt: new Date("2026-07-09T12:10:00.000Z"),
      },
      {
        id: newerConfirmationId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        createdByAgentId: reviewerId,
        title: "Approve V2",
        payload: { version: 1, prompt: "Approve V2?" },
        createdAt: new Date("2026-07-09T12:05:00.000Z"),
        updatedAt: new Date("2026-07-09T12:05:00.000Z"),
      },
      {
        id: checkboxId,
        companyId,
        issueId,
        kind: "request_checkbox_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        createdByAgentId: workerId,
        title: "Select rollout",
        payload: { version: 1, prompt: "Select rollout", options: [{ id: "one", label: "One" }] },
        createdAt: new Date("2026-07-09T12:01:00.000Z"),
        updatedAt: new Date("2026-07-09T12:01:00.000Z"),
      },
    ]);

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const interactionIds = feed.items
      .filter((item) => item.sourceKind === "issue_thread_interaction")
      .map((item) => item.subject.id);

    expect(interactionIds).toContain(newerConfirmationId);
    expect(interactionIds).toContain(checkboxId);
    expect(interactionIds).not.toContain(olderConfirmationId);
  });

  it("uses inbox_dismissals with attention-prefixed dedup keys and resurfaces newer activity", async () => {
    const { companyId } = await seedCompany("ATD");
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "hire_agent",
      status: "pending",
      payload: { title: "Hire Writer" },
      createdAt: new Date("2026-07-09T12:00:00.000Z"),
      updatedAt: new Date("2026-07-09T12:00:00.000Z"),
    });
    await db.insert(inboxDismissals).values({
      companyId,
      userId: "board-user",
      itemKey: `attention:approval:${approvalId}`,
      dismissedAt: new Date("2026-07-09T13:00:00.000Z"),
    });

    await expect(attentionService(db).list(companyId, { userId: "board-user" }))
      .resolves.toMatchObject({ totalCount: 1 }); // agent_error_alert from seed
    const includeDismissedFeed = await attentionService(db).list(companyId, { userId: "board-user", includeDismissed: true });
    expect(includeDismissedFeed.totalCount).toBe(2);
    expect(includeDismissedFeed.items.find((item) => item.dedupKey === `approval:${approvalId}`)?.dismissal)
      .toMatchObject({ kind: "dismiss", isActive: true, snoozedUntil: null });

    await db
      .update(approvals)
      .set({ updatedAt: new Date("2026-07-09T14:00:00.000Z") })
      .where(eq(approvals.id, approvalId));

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    expect(feed.items.some((item) => item.dedupKey === `approval:${approvalId}`)).toBe(true);
  });

  it("delivers a structured human unblock descriptor once per blocked transition", async () => {
    const { companyId } = await seedCompany("ATU");
    const transitionAt = new Date("2026-07-23T18:30:00.000Z");
    const issueId = await insertIssue({
      companyId,
      identifier: "ATU-1",
      title: "Needs board action",
      status: "blocked",
      unblockDescriptor: { owner: "board", action: "Approve the exception" },
      blockedTransitionAt: transitionAt,
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const items = feed.items.filter((item) => item.dedupKey === `blocked-owner:${issueId}:${transitionAt.toISOString()}`);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sourceKind: "blocker_attention", whyNow: "Approve the exception" });
  });

  it("keeps legacy blocker attention visible for pre-rollout blocked issues", async () => {
    const { companyId } = await seedCompany("ATP");
    const issueId = await insertIssue({
      companyId,
      identifier: "ATP-1",
      title: "Blocked before rollout",
      status: "blocked",
      blockedTransitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() - 1),
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    expect(feed.items.some((item) => item.dedupKey === `blocker:${issueId}`)).toBe(true);
  });

  // Regression: both blocker_attention call sites fell back to the blocked
  // task's own identity when no `blocks` relation was loaded, so every such row
  // claimed the task was blocked by itself ("PAP-23 — Blocked by PAP-23").
  it("reports no blocking task rather than a self-reference when the blocker is unknown", async () => {
    const { companyId } = await seedCompany("ATV");
    const issueId = await insertIssue({
      companyId,
      identifier: "ATV-1",
      title: "Blocked with no relation",
      status: "blocked",
      blockedTransitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() - 1),
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const row = feed.items.find((item) => item.dedupKey === `blocker:${issueId}`);

    expect(row).toBeTruthy();
    expect(row?.detail).toMatchObject({ kind: "blocker", blockingIssue: null });
    expect(row?.dismissalKey).toBe(`attention:blocker:${issueId}`);
  });

  it("suppresses a blocked dependency row while its blocker is actively progressing", async () => {
    const { companyId } = await seedCompany("ATW");
    const blockedId = await insertIssue({
      companyId,
      identifier: "ATW-1",
      title: "Blocked parent",
      status: "blocked",
      blockedTransitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() - 1),
    });
    const blockerId = await insertIssue({
      companyId,
      identifier: "ATW-2",
      title: "The actual blocker",
      status: "in_progress",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    expect(feed.items.some((item) => item.sourceKind === "blocker_attention")).toBe(false);
  });

  it("suppresses a mixed blocker tree when any blocker is live", async () => {
    const { companyId } = await seedCompany("ATL");
    const blockedId = await insertIssue({
      companyId,
      identifier: "ATL-1",
      title: "Blocked rollout",
      status: "blocked",
    });
    const blockerIds = await Promise.all([
      insertIssue({ companyId, identifier: "ATL-2", title: "Live phase one", status: "in_progress" }),
      insertIssue({ companyId, identifier: "ATL-3", title: "Live phase two", status: "in_progress" }),
      insertIssue({ companyId, identifier: "ATL-4", title: "Live phase three", status: "in_progress" }),
      insertIssue({ companyId, identifier: "ATL-5", title: "Stopped phase", status: "todo" }),
    ]);
    await db.insert(issueRelations).values(blockerIds.map((issueId) => ({
      companyId,
      issueId,
      relatedIssueId: blockedId,
      type: "blocks" as const,
    })));

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    expect(feed.items.filter((item) => item.sourceKind === "blocker_attention")).toEqual([]);
  });

  it("emits one terminal-blocker row with a cycle-safe transitive blocked-work count", async () => {
    const { companyId } = await seedCompany("ATC");
    const terminalId = await insertIssue({
      companyId,
      identifier: "ATC-1",
      title: "Choose migration owner",
      status: "todo",
    });
    const blockedId = await insertIssue({
      companyId,
      identifier: "ATC-2",
      title: "Blocked migration",
      status: "blocked",
    });
    await insertIssue({
      companyId,
      identifier: "ATC-3",
      title: "Open migration child",
      status: "todo",
      parentId: blockedId,
    });
    const transitiveId = await insertIssue({
      companyId,
      identifier: "ATC-4",
      title: "Transitively blocked follow-up",
      status: "todo",
    });
    await insertIssue({
      companyId,
      identifier: "ATC-5",
      title: "Closed child",
      status: "done",
      parentId: blockedId,
    });
    await db.insert(issueRelations).values([
      { companyId, issueId: terminalId, relatedIssueId: blockedId, type: "blocks" },
      { companyId, issueId: blockedId, relatedIssueId: transitiveId, type: "blocks" },
      // Corrupt legacy cycles must not inflate or hang the count.
      { companyId, issueId: transitiveId, relatedIssueId: blockedId, type: "blocks" },
    ]);

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const rows = feed.items.filter((item) => item.sourceKind === "blocker_attention");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject: { id: terminalId, identifier: "ATC-1", title: "Choose migration owner" },
      relatedIssue: { id: blockedId },
      whyNow: "Blocks 3 tasks and needs human attention.",
      detail: { kind: "blocker", blockingIssue: null, blockedTaskCount: 3 },
    });
    expect(rows[0]?.subject.id).not.toBe(blockedId);
  });

  it("orders terminal blockers by blocked-work weight descending", async () => {
    const { companyId } = await seedCompany("ATR");
    const heavyTerminalId = await insertIssue({
      companyId,
      identifier: "ATR-1",
      title: "Heavy blocker",
      status: "todo",
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    const lightTerminalId = await insertIssue({
      companyId,
      identifier: "ATR-2",
      title: "Light blocker",
      status: "todo",
      updatedAt: new Date("2026-07-03T00:00:00.000Z"),
    });
    const heavyBlockedId = await insertIssue({
      companyId,
      identifier: "ATR-3",
      title: "Heavy blocked root",
      status: "blocked",
    });
    const lightBlockedId = await insertIssue({
      companyId,
      identifier: "ATR-4",
      title: "Light blocked root",
      status: "blocked",
    });
    await insertIssue({ companyId, identifier: "ATR-5", title: "Heavy child one", status: "todo", parentId: heavyBlockedId });
    await insertIssue({ companyId, identifier: "ATR-6", title: "Heavy child two", status: "todo", parentId: heavyBlockedId });
    await db.insert(issueRelations).values([
      { companyId, issueId: heavyTerminalId, relatedIssueId: heavyBlockedId, type: "blocks" },
      { companyId, issueId: lightTerminalId, relatedIssueId: lightBlockedId, type: "blocks" },
    ]);

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const rows = feed.items.filter((item) => item.sourceKind === "blocker_attention");

    expect(rows.map((item) => item.subject.id)).toEqual([heavyTerminalId, lightTerminalId]);
    expect(rows.map((item) => item.detail?.kind === "blocker" ? item.detail.blockedTaskCount : null)).toEqual([3, 1]);
  });

  it("does not name the blocked task as its own blocker on a human-owned unblock row", async () => {
    const { companyId } = await seedCompany("ATX");
    const transitionAt = new Date("2026-07-23T18:30:00.000Z");
    const issueId = await insertIssue({
      companyId,
      identifier: "ATX-1",
      title: "Needs board action",
      status: "blocked",
      unblockDescriptor: { owner: "board", action: "Approve the exception" },
      blockedTransitionAt: transitionAt,
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const row = feed.items.find(
      (item) => item.dedupKey === `blocked-owner:${issueId}:${transitionAt.toISOString()}`,
    );

    expect(row?.detail).toMatchObject({ kind: "blocker", blockingIssue: null });
  });

  it("does not route pre-rollout human unblock descriptors", async () => {
    const { companyId } = await seedCompany("ATQ");
    const transitionAt = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() - 1);
    const issueId = await insertIssue({
      companyId,
      identifier: "ATQ-1",
      title: "Human-owned before rollout",
      status: "blocked",
      unblockDescriptor: { owner: "board", action: "Review the issue" },
      blockedTransitionAt: transitionAt,
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    expect(feed.items.some((item) => item.dedupKey === `blocked-owner:${issueId}:${transitionAt.toISOString()}`)).toBe(false);
  });

  it("returns one pending approval row when the approval is linked to multiple tasks", async () => {
    const { companyId } = await seedCompany("ATM");
    const approvalId = randomUUID();
    const firstIssueId = "00000000-0000-4000-8000-000000000001";
    const secondIssueId = "00000000-0000-4000-8000-000000000002";
    await insertIssue({ companyId, id: firstIssueId, identifier: "ATM-1", title: "First task", status: "in_progress" });
    await insertIssue({ companyId, id: secondIssueId, identifier: "ATM-2", title: "Second task", status: "in_progress" });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { title: "Approve rollout" },
    });
    await db.insert(issueApprovals).values([
      { companyId, issueId: secondIssueId, approvalId },
      { companyId, issueId: firstIssueId, approvalId },
    ]);

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const approvalItems = feed.items.filter((item) => item.dedupKey === `approval:${approvalId}`);

    expect(approvalItems).toHaveLength(1);
    expect(approvalItems[0]?.subject.metadata?.issueId).toBe(firstIssueId);
  });

  it("hides snoozed attention rows until snoozedUntil passes, then returns them unconditionally", async () => {
    const { companyId } = await seedCompany("ATS");
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "hire_agent",
      status: "pending",
      payload: { title: "Hire Researcher" },
      createdAt: new Date("2026-07-09T12:00:00.000Z"),
      updatedAt: new Date("2026-07-09T12:00:00.000Z"),
    });
    await db.insert(inboxDismissals).values({
      companyId,
      userId: "board-user",
      itemKey: `attention:approval:${approvalId}`,
      kind: "snooze",
      dismissedAt: new Date("2099-01-01T00:00:00.000Z"),
      snoozedUntil: new Date("2099-01-02T00:00:00.000Z"),
    });

    await expect(attentionService(db).list(companyId, { userId: "board-user" }))
      .resolves.toMatchObject({ totalCount: 1 }); // agent_error_alert from seed
    const hiddenFeed = await attentionService(db).list(companyId, { userId: "board-user", includeDismissed: true });
    expect(hiddenFeed.items.find((item) => item.dedupKey === `approval:${approvalId}`)?.dismissal)
      .toMatchObject({ kind: "snooze", isActive: true, snoozedUntil: "2099-01-02T00:00:00.000Z" });

    await db
      .update(inboxDismissals)
      .set({ snoozedUntil: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(inboxDismissals.itemKey, `attention:approval:${approvalId}`));

    const visibleFeed = await attentionService(db).list(companyId, { userId: "board-user" });
    const visibleApproval = visibleFeed.items.find((item) => item.dedupKey === `approval:${approvalId}`);
    expect(visibleApproval?.dismissal).toMatchObject({ kind: "snooze", isActive: false });
    expect(visibleApproval).toBeTruthy();
  });

  it("enriches, filters, paginates, snoozes, and ranks the decide-now feed", async () => {
    const { companyId, workerId, errorAgentId } = await seedCompany("ATP");
    const now = Date.now();
    const originIssueId = await insertIssue({
      companyId,
      identifier: "ATP-1",
      title: "Decision origin",
      status: "in_progress",
      assigneeAgentId: workerId,
      updatedAt: new Date(now - 10 * 60_000),
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: workerId,
      status: "succeeded",
      contextSnapshot: { issueId: originIssueId },
    });

    const expiringSoonId = randomUUID();
    const expiringLaterId = randomUUID();
    const wheneverId = randomUUID();
    const snoozedId = randomUUID();
    const decisionValues = [
      { id: expiringSoonId, ruleKey: "release.soon", title: "Expires sooner", updatedAt: new Date(now - 60_000), expiresAt: new Date(now + 60 * 60_000) },
      { id: expiringLaterId, ruleKey: "release.later", title: "Expires later", updatedAt: new Date(now - 2 * 60_000), expiresAt: new Date(now + 2 * 60 * 60_000) },
      { id: wheneverId, ruleKey: "release.whenever", title: "Can wait", updatedAt: new Date(now), expiresAt: new Date(now + 30 * 60_000) },
      { id: snoozedId, ruleKey: "release.snoozed", title: "Snoozed", updatedAt: new Date(now - 3 * 60_000), expiresAt: new Date(now + 15 * 60_000) },
    ];
    await db.insert(decisions).values(decisionValues.map((value) => ({
      ...value,
      companyId,
      originAgentId: workerId,
      originIssueId,
      originRunId: runId,
      body: value.title,
      options: [],
      status: "open",
      signedSpec: "test",
      targetSnapshots: {},
      createdAt: value.updatedAt,
    })));

    const queueId = randomUUID();
    await db.insert(decisionQueues).values({
      id: queueId,
      companyId,
      key: "urgent-releases",
      title: "Urgent releases",
      createdByType: "user",
      createdByUserId: "board-user",
    });
    await db.insert(decisionQueueItems).values([expiringSoonId, expiringLaterId].map((sourceId) => ({
      companyId,
      queueId,
      sourceKind: "decision",
      sourceId,
      addedByType: "user",
      addedByUserId: "board-user",
    })));
    await db.insert(decisionTriage).values([
      expiringSoonId,
      expiringLaterId,
      snoozedId,
    ].map((sourceId) => ({
      companyId,
      sourceKind: "decision",
      sourceId,
      decideBy: "today",
      setByType: "agent",
      setByAgentId: workerId,
      snoozedUntil: sourceId === snoozedId ? new Date(now + 60 * 60_000) : null,
    })));
    await db.insert(decisionTriage).values({
      companyId,
      sourceKind: "decision",
      sourceId: wheneverId,
      decideBy: "whenever",
      setByType: "agent",
      setByAgentId: workerId,
    });

    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "hire_agent",
      status: "pending",
      payload: { title: "Newer medium-severity approval" },
      createdAt: new Date(now + 5 * 60_000),
      updatedAt: new Date(now + 5 * 60_000),
    });
    await db.update(agents).set({ updatedAt: new Date(now - 5 * 60_000) }).where(eq(agents.id, errorAgentId));

    const feed = await attentionService(db).list(companyId, {
      userId: "board-user",
      sort: "decide",
      limit: 20,
    });
    // Desk badge = distinct items surfaced today OR with a due decide-by
    // Everything here was seeded ~now, so every visible row
    // counts; the whole page fits under limit:20 so items == rankedItems.
    const startOfUtcDay = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate(),
    );
    const expectedBadge = feed.items.filter(
      (item) => new Date(item.createdAt).getTime() >= startOfUtcDay || item.decideBy === "today",
    ).length;
    expect(expectedBadge).toBeGreaterThanOrEqual(2);
    expect(feed.deskBadgeCount).toBe(expectedBadge);
    expect(feed.items.some((item) => item.subject.id === snoozedId)).toBe(false);
    expect(feed.items.slice(0, 3).map((item) => item.subject.id)).toEqual([
      expiringSoonId,
      expiringLaterId,
      wheneverId,
    ]);
    const erroredAgentIndex = feed.items.findIndex((item) => item.subject.id === errorAgentId);
    const approvalIndex = feed.items.findIndex((item) => item.subject.id === approvalId);
    expect(erroredAgentIndex).toBeGreaterThan(-1);
    expect(erroredAgentIndex).toBeLessThan(approvalIndex);

    const enriched = feed.items.find((item) => item.subject.id === expiringSoonId);
    expect(enriched).toMatchObject({
      expiresAt: decisionValues[0]!.expiresAt.toISOString(),
      ruleKey: "release.soon",
      originAgentName: "Worker",
      queues: [{ key: "urgent-releases", title: "Urgent releases" }],
      decideBy: "today",
      decideByAttribution: {
        type: "agent",
        agentId: workerId,
        agentName: "Worker",
      },
      snoozedUntil: null,
    });

    const firstPage = await attentionService(db).list(companyId, {
      userId: "board-user",
      queue: "urgent-releases",
      sort: "decide",
      limit: 1,
    });
    expect(firstPage).toMatchObject({ totalCount: 2, deskBadgeCount: 2 });
    expect(firstPage.items.map((item) => item.subject.id)).toEqual([expiringSoonId]);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = await attentionService(db).list(companyId, {
      userId: "board-user",
      queue: "urgent-releases",
      sort: "decide",
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.items.map((item) => item.subject.id)).toEqual([expiringLaterId]);
    expect(secondPage.nextCursor).toBeNull();

    const completeSnapshot = await attentionService(db).list(companyId, {
      userId: "board-user",
      queue: "urgent-releases",
      sort: "decide",
      all: true,
    });
    expect(completeSnapshot.items.map((item) => item.subject.id)).toEqual([expiringSoonId, expiringLaterId]);
    expect(completeSnapshot.nextCursor).toBeNull();

    const dateFiltered = await attentionService(db).list(companyId, {
      userId: "board-user",
      queue: "urgent-releases",
      activitySince: new Date(now - 90_000).toISOString(),
      activityUntil: new Date(now).toISOString(),
    });
    expect(dateFiltered.items.map((item) => item.subject.id)).toEqual([expiringSoonId]);

    const withSnoozed = await attentionService(db).list(companyId, {
      userId: "board-user",
      includeDismissed: true,
      limit: 20,
    });
    expect(withSnoozed.items.find((item) => item.subject.id === snoozedId)?.snoozedUntil)
      .toBe(new Date(now + 60 * 60_000).toISOString());
  });

  it("returns a complete queue snapshot beyond the normal page limit", async () => {
    const { companyId } = await seedCompany("ATS");
    const queueId = randomUUID();
    await db.insert(decisionQueues).values({
      id: queueId,
      companyId,
      key: "bulk-review",
      title: "Bulk review",
      createdByType: "user",
      createdByUserId: "board-user",
    });

    const approvalRows = Array.from({ length: 101 }, (_, index) => ({
      id: randomUUID(),
      companyId,
      type: "hire_agent",
      status: "pending",
      payload: { title: `Review ${index + 1}` },
      createdAt: new Date(Date.UTC(2026, 7, 2, 12, 0, index)),
      updatedAt: new Date(Date.UTC(2026, 7, 2, 12, 0, index)),
    }));
    await db.insert(approvals).values(approvalRows);
    await db.insert(decisionQueueItems).values(approvalRows.map((approval) => ({
      companyId,
      queueId,
      sourceKind: "approval",
      sourceId: approval.id,
      addedByType: "user",
      addedByUserId: "board-user",
    })));

    const firstPage = await attentionService(db).list(companyId, {
      userId: "board-user",
      queue: "bulk-review",
    });
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.nextCursor).toBeTruthy();

    const completeSnapshot = await attentionService(db).list(companyId, {
      userId: "board-user",
      queue: "bulk-review",
      all: true,
    });
    expect(completeSnapshot.items).toHaveLength(101);
    expect(new Set(completeSnapshot.items.map((item) => item.id)).size).toBe(101);
    expect(completeSnapshot.nextCursor).toBeNull();

    const internalSnapshot = await attentionService(db).list(companyId, {
      userId: "board-user",
      all: true,
      allowUnscopedAll: true,
    });
    const internalSnapshotIds = new Set(internalSnapshot.items.map((item) => item.subject.id));
    expect(approvalRows.every((approval) => internalSnapshotIds.has(approval.id))).toBe(true);
    expect(internalSnapshot.items.length).toBeGreaterThan(100);
    expect(internalSnapshot.nextCursor).toBeNull();

    await expect(attentionService(db).list(companyId, { userId: "board-user", all: true }))
      .rejects.toThrow("all requires a queue filter");
    await expect(attentionService(db).list(companyId, {
      userId: "board-user",
      queue: "bulk-review",
      all: true,
      limit: 25,
    })).rejects.toThrow("all cannot be combined with cursor or limit");
  });

  it("does not apply the open-decision safety limit to complete snapshots", async () => {
    const { companyId, workerId } = await seedCompany("ATC");
    const originIssueId = await insertIssue({
      companyId,
      identifier: "ATC-1",
      title: "Decision origin",
      status: "in_progress",
      assigneeAgentId: workerId,
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: workerId,
      status: "succeeded",
      contextSnapshot: { issueId: originIssueId },
    });
    await db.insert(decisions).values(["First decision", "Second decision"].map((title) => ({
      id: randomUUID(),
      companyId,
      originAgentId: workerId,
      originIssueId,
      originRunId: runId,
      title,
      body: title,
      options: [],
      status: "open" as const,
      expiresAt: new Date("2026-08-10T00:00:00.000Z"),
      signedSpec: "test",
      targetSnapshots: {},
    })));

    const svc = attentionService(db, { openDecisionLimit: 1 });
    const limited = await svc.list(companyId, { userId: "board-user" });
    expect(limited.items.filter((item) => item.sourceKind === "decision")).toHaveLength(1);

    const complete = await svc.list(companyId, {
      userId: "board-user",
      all: true,
      allowUnscopedAll: true,
    });
    expect(complete.items.filter((item) => item.sourceKind === "decision")).toHaveLength(2);
    expect(complete.nextCursor).toBeNull();
  });

  it("keeps this-week deadlines in the current UTC week", async () => {
    const { companyId, workerId } = await seedCompany("ATW");
    const now = Date.parse("2026-08-02T12:00:00.000Z"); // Sunday in an ISO Monday-Sunday week.
    const originIssueId = await insertIssue({
      companyId,
      identifier: "ATW-1",
      title: "Decision origin",
      status: "in_progress",
      assigneeAgentId: workerId,
      updatedAt: new Date(now),
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: workerId,
      status: "succeeded",
      contextSnapshot: { issueId: originIssueId },
    });

    const thisWeekId = randomUUID();
    const nextWeekId = randomUUID();
    await db.insert(decisions).values([
      { id: thisWeekId, title: "This week", expiresAt: new Date("2026-08-09T12:00:00.000Z") },
      { id: nextWeekId, title: "Next week", expiresAt: new Date("2026-08-03T12:00:00.000Z") },
    ].map((value) => ({
      ...value,
      companyId,
      originAgentId: workerId,
      originIssueId,
      originRunId: runId,
      body: value.title,
      options: [],
      status: "open" as const,
      signedSpec: "test",
      targetSnapshots: {},
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })));
    await db.insert(decisionTriage).values([
      {
        companyId,
        sourceKind: "decision",
        sourceId: thisWeekId,
        decideBy: "this_week",
        setByType: "user",
        setByUserId: "board-user",
      },
      {
        companyId,
        sourceKind: "decision",
        sourceId: nextWeekId,
        decideBy: "date",
        decideByDate: "2026-08-03",
        setByType: "user",
        setByUserId: "board-user",
      },
    ]);

    const feed = await attentionService(db, { now: () => now }).list(companyId, {
      userId: "board-user",
      sort: "decide",
      limit: 20,
    });
    const decisionItems = feed.items.filter((item) => item.sourceKind === "decision");

    expect(decisionItems.map((item) => item.subject.id)).toEqual([thisWeekId, nextWeekId]);
    expect(decisionItems[0]).toMatchObject({
      decideBy: "this_week",
      expiresAt: "2026-08-09T12:00:00.000Z",
    });
    expect(decisionItems[1]).toMatchObject({
      decideBy: "2026-08-03",
      expiresAt: "2026-08-03T12:00:00.000Z",
    });
  });

  it("serves the route for board users and rejects agent callers", async () => {
    const { companyId } = await seedCompany("ATR");

    function app(actor: Record<string, unknown>) {
      const testApp = express();
      testApp.use(express.json());
      testApp.use((req, _res, next) => {
        (req as any).actor = actor;
        next();
      });
      testApp.use("/api", attentionRoutes(db));
      testApp.use(errorHandler);
      return testApp;
    }

    const board = {
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [companyId],
      isInstanceAdmin: false,
    };
    const agent = {
      type: "agent",
      source: "agent_key",
      companyId,
      agentId: randomUUID(),
      runId: null,
    };

    await request(app(board)).get(`/api/companies/${companyId}/attention`).expect(200);
    const completeFeed = await request(app(board))
      .get(`/api/companies/${companyId}/attention?includeDismissed=true&all=true`)
      .expect(200);
    expect(completeFeed.body.nextCursor).toBeNull();
    await request(app(board))
      .get(`/api/companies/${companyId}/attention?activitySince=yesterday`)
      .expect(400, { error: "activitySince must be an ISO timestamp" });
    await request(app(board))
      .get(`/api/companies/${companyId}/attention?sort=oldest`)
      .expect(400, { error: "sort must be 'activity' or 'decide'" });
    await request(app(agent)).get(`/api/companies/${companyId}/attention`).expect(403);
  });

  it("computes the aging shelf uniformly across approval, interaction, and review sources", async () => {
    const { companyId, workerId } = await seedCompany("AGE");
    const now = Date.parse("2026-08-02T12:00:00.000Z");
    const idleAt = new Date("2026-06-30T12:00:00.000Z");
    const interactionIssueId = await insertIssue({
      companyId,
      identifier: "AGE-1",
      title: "Old questions",
      status: "in_progress",
      assigneeAgentId: workerId,
      createdAt: idleAt,
      updatedAt: idleAt,
    });
    const reviewIssueId = await insertIssue({
      companyId,
      identifier: "AGE-2",
      title: "Old review",
      status: "in_review",
      assigneeUserId: "board-user",
      createdAt: idleAt,
      updatedAt: idleAt,
    });
    const approvalId = randomUUID();
    const queueApprovalId = randomUUID();
    const interactionId = randomUUID();
    const queueIdleAt = new Date("2026-07-18T12:00:00.000Z");
    await db.insert(approvals).values([
      {
        id: approvalId,
        companyId,
        type: "request_board_approval",
        requestedByAgentId: workerId,
        status: "pending",
        payload: { title: "Old approval" },
        createdAt: idleAt,
        updatedAt: idleAt,
      },
      {
        id: queueApprovalId,
        companyId,
        type: "request_board_approval",
        requestedByAgentId: workerId,
        status: "pending",
        payload: { title: "Queue-retained approval" },
        createdAt: queueIdleAt,
        updatedAt: queueIdleAt,
      },
    ]);
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId: interactionIssueId,
      kind: "ask_user_questions",
      status: "pending",
      createdByAgentId: workerId,
      payload: { version: 1, questions: [] },
      createdAt: idleAt,
      updatedAt: idleAt,
    });
    const [queue] = await db.insert(decisionQueues).values({
      companyId,
      key: "fast-aging",
      title: "Fast aging",
      retentionDays: 10,
      createdByType: "system",
    }).returning();
    await db.insert(decisionQueueItems).values({
      companyId,
      queueId: queue!.id,
      sourceKind: "approval",
      sourceId: queueApprovalId,
      addedByType: "system",
    });

    const feed = await attentionService(db, { now: () => now }).list(companyId, {
      userId: "board-user",
      limit: 100,
    });
    const byKey = new Map(feed.items.map((item) => [`${item.sourceKind}:${item.subject.id}`, item]));
    for (const key of [
      `approval:${approvalId}`,
      `issue_thread_interaction:${interactionId}`,
      `review:${reviewIssueId}`,
    ]) {
      expect(byKey.get(key)).toMatchObject({ shelf: true, retentionDays: 30, archivedAt: null });
    }
    expect(byKey.get(`approval:${queueApprovalId}`)).toMatchObject({ shelf: true, retentionDays: 10 });
  });
});
