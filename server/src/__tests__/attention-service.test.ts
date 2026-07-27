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
  }) {
    const id = input.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.title,
      status: input.status,
      priority: input.priority ?? "medium",
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

    expect(feed.totalCount).toBe(11);
    expect(feed.countsBySourceKind).toMatchObject({
      approval: 1,
      issue_thread_interaction: 1,
      join_request: 1,
      recovery_action: 1,
      productivity_review: 1,
      blocker_attention: 1,
      review: 1,
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
      blockingIssue: { identifier: "ATN-5", title: "Stalled review blocker" },
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

    expect(feed.items.some((item) => item.dedupKey === `blocker:${issueId}:ATP-1`)).toBe(true);
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
    await request(app(agent)).get(`/api/companies/${companyId}/attention`).expect(403);
  });
});
