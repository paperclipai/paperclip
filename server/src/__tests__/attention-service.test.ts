import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { createFullDatabaseResponseCapture, installDatabaseResponseCapture } from "./helpers/full-database-response-capture.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  assets,
  budgetIncidents,
  budgetPolicies,
  companies,
  createDb,
  decisionQueueItems,
  decisionQueues,
  decisions,
  decisionTriage,
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
import { errorHandler } from "../middleware/index.js";
import { attentionRoutes } from "../routes/attention.js";
import { attentionService } from "../services/attention.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { decisionHistoryService } from "../services/decision-history.js";
import { listAttentionExhaustedRuns } from "../services/attention-exhausted-runs.js";
import { agentService } from "../services/agents.js";
import { ROUTABLE_BLOCKED_ROLLOUT_AT } from "../services/routable-blocked.js";

import {
  createAttentionServiceHarness,
  describeAttentionEmbeddedPostgres,
} from "./helpers/attention-service-harness.js";

describeAttentionEmbeddedPostgres("attention service", () => {
  const h = createAttentionServiceHarness();
  let db!: ReturnType<typeof createDb>;
  beforeAll(() => { db = h.db; });
  const { seedCompany, insertIssue, pendingUserExecutionState, pendingAgentExecutionState } = h;

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

  it("includes existing pending chat questions and confirmations, then retains answered questions in history", async () => {
    const { companyId, workerId } = await seedCompany("CHQ");
    const issueId = randomUUID(), questionId = randomUUID(), confirmationId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, identifier: "CHQ-1", title: "Chat with Worker", status: "in_review",
      conversationAgentId: workerId, conversationUserId: "board-user", conversationState: "waiting", assigneeAgentId: workerId,
    });
    await db.insert(issueThreadInteractions).values([
      { id: questionId, companyId, issueId, kind: "ask_user_questions", status: "pending", title: "Choose the screen",
        createdByAgentId: workerId, addresseeUserId: "board-user", effectiveResolverPolicy: "human_only",
        payload: { version: 1, questions: [{ id: "screen", prompt: "Which screen should we redesign?", options: [], selectionMode: "single", required: true, allowOther: true }] } },
      { id: confirmationId, companyId, issueId, kind: "request_confirmation", status: "pending", title: "Approve the plan",
        createdByAgentId: workerId, addresseeUserId: "board-user", payload: { version: 1, prompt: "Approve this plan?" } },
    ]);
    const actor = { type: "board" as const, source: "session" as const, userId: "board-user", companyIds: [companyId] };
    const options = { userId: actor.userId, actor };
    const service = attentionService(db);
    const feed = await service.list(companyId, options);
    expect(feed.items.filter((item) => item.sourceKind === "issue_thread_interaction").map((item) => item.subject.id).sort())
      .toEqual([questionId, confirmationId].sort());
    expect(feed.items.find((item) => item.subject.id === questionId)).toMatchObject({
      inlineResolvable: true,
      relatedIssue: { id: issueId, identifier: "CHQ-1", href: "/CHQ/issues/CHQ-1" },
      subject: { href: `/CHQ/issues/CHQ-1#interaction-${questionId}`, metadata: { kind: "ask_user_questions", issueId } },
      detail: { kind: "questions", questionCount: 1, firstQuestionText: "Which screen should we redesign?" },
      resolverAudience: { effectiveResolverPolicy: "human_only" },
    });
    expect(feed.countsBySourceKind.issue_thread_interaction).toBe(2);
    expect(feed.countsBySourceKind.review).toBe(0);

    await db.update(issueThreadInteractions).set({ status: "answered", resolvedAt: new Date(), resolvedByUserId: actor.userId,
      result: { version: 1, answers: [{ questionId: "screen", optionIds: [], otherText: "Agent detail" }] } }).where(eq(issueThreadInteractions.id, questionId));
    const after = await service.list(companyId, options);
    expect(after.items.some((item) => item.subject.id === questionId)).toBe(false);
    expect(after.countsBySourceKind.issue_thread_interaction).toBe(1);
    const history = await decisionHistoryService(db).list(companyId, options);
    expect(history.items).toEqual([expect.objectContaining({ sourceId: questionId, issueId, outcome: "answered", label: "Answers recorded" })]);
  });

  it("keeps chat attention company, issue visibility, and addressee filters while ignoring idle chats without requests", async () => {
    const { companyId, workerId, reviewerId } = await seedCompany("CHA");
    const other = await seedCompany("CHB");
    const scenarios = [
      { user: "board-user", allowed: true },
      { user: "other-user", addresseeUserId: "other-user" },
      { user: "private-owner", visibility: "private", createdByUserId: "private-owner" },
      { user: "hidden-owner", hiddenAt: new Date() },
      { user: "harness-owner", harnessKind: "skill_test" },
      { user: "agent-addressee", addresseeAgentId: reviewerId },
      { user: "idle-owner", idle: true },
      { user: "other-company", companyId: other.companyId, agentId: other.workerId },
    ];
    const expected: string[] = [];
    for (const [index, scenario] of scenarios.entries()) {
      const issueId = randomUUID(), interactionId = randomUUID();
      const scopedCompanyId = scenario.companyId ?? companyId, agentId = scenario.agentId ?? workerId;
      await db.insert(issues).values({
        id: issueId, companyId: scopedCompanyId, identifier: `CH-${index}`, title: `Chat ${scenario.user}`, status: "in_review",
        conversationAgentId: agentId, conversationUserId: scenario.user, conversationState: "waiting", assigneeAgentId: agentId,
        visibility: scenario.visibility ?? "open", createdByUserId: scenario.createdByUserId,
        hiddenAt: scenario.hiddenAt, harnessKind: scenario.harnessKind,
      });
      if (scenario.idle) continue;
      await db.insert(issueThreadInteractions).values({
        id: interactionId, companyId: scopedCompanyId, issueId, kind: "ask_user_questions", status: "pending",
        title: `Question ${scenario.user}`, createdByAgentId: agentId,
        addresseeUserId: scenario.addresseeUserId ?? (scenario.addresseeAgentId ? null : "board-user"),
        addresseeAgentId: scenario.addresseeAgentId,
        payload: { version: 1, questions: [] },
      });
      if (scenario.allowed) expected.push(interactionId);
    }
    const actor = { type: "board" as const, source: "session" as const, userId: "board-user", companyIds: [companyId], ignoreInstanceAdmin: true };
    const feed = await attentionService(db).list(companyId, { actor, userId: actor.userId });
    expect(feed.items.filter((item) => item.sourceKind === "issue_thread_interaction").map((item) => item.subject.id)).toEqual(expected);
    expect(feed.countsBySourceKind.review).toBe(0);
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

    expect(feed.totalCount).toBe(11);
    expect(feed.countsBySourceKind).toMatchObject({
      approval: 1,
      issue_thread_interaction: 1,
      join_request: 1,
      recovery_action: 1,
      productivity_review: 0,
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
    expect(feed.items.some((item) => item.sourceKind === "productivity_review")).toBe(false);
    expect(feed.items.some((item) => item.subject.title === "Agent productivity review excluded")).toBe(false);
    const legacyReviews = await db.select().from(issues).where(eq(issues.originKind, "issue_productivity_review"));
    expect(legacyReviews).toHaveLength(2);
    expect(legacyReviews).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Human productivity review", status: "todo", assigneeUserId: "board-user", parentId: productivitySourceIssueId }),
      expect.objectContaining({ title: "Agent productivity review excluded", status: "todo", assigneeAgentId: workerId, parentId: agentProductivitySourceIssueId }),
    ]));
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
    // PAP-749 Rule 7: cards offer only actions they can complete; hiding a
    // card is the Close… menu, and withdraw only where a request exists.
    const verbIds = (kind: string) => feed.items.find((item) => item.sourceKind === kind)?.decisionVerbs.map((verb) => verb.id);
    expect(verbIds("failed_run")).toEqual(["retry", "inspect"]);
    expect(verbIds("recovery_action")).toEqual(["open_recovery"]);
    expect(verbIds("agent_error_alert")).toEqual(["inspect"]);
    expect(verbIds("budget_alert")).toEqual(["raise_budget_and_resume", "keep_paused"]);
    expect(feed.items.find((item) => item.sourceKind === "budget_alert")?.closeModes).toEqual(["archive", "snooze"]);
    expect(feed.items.find((item) => item.sourceKind === "issue_thread_interaction")?.closeModes).toEqual(["withdraw", "archive", "snooze"]);
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

    await createAgentLifecycle(db).pauseAgent(pausedReviewerId);
    await createAgentLifecycle(db).terminateAgent(terminatedReviewerId);

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

  // PAP-17287: a collapsed queue row offers Accept/Reject before anything fetches
  // the interaction, so the audience the resolution routes will enforce has to
  // ship with the feed item.
  it("ships the effective resolver audience with each interaction row", async () => {
    const { companyId, workerId, reviewerId } = await seedCompany("ARA");
    const issueId = await insertIssue({
      companyId,
      identifier: "ARA-1",
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
        title: "Open question",
        createdByAgentId: workerId,
        payload: { version: 1, questions: [] },
      },
      {
        id: randomUUID(),
        companyId,
        issueId,
        kind: "ask_user_questions",
        status: "pending",
        title: "Creator-excluded question",
        createdByAgentId: workerId,
        requestedResolverPolicy: "not_creator",
        effectiveResolverPolicy: "not_creator",
        resolverPolicyProvenance: "explicit",
        payload: { version: 1, questions: [] },
      },
      {
        id: randomUUID(),
        companyId,
        issueId,
        kind: "ask_user_questions",
        status: "pending",
        title: "Capped question",
        createdByAgentId: workerId,
        requestedResolverPolicy: "anyone",
        effectiveResolverPolicy: "human_only",
        effectiveResolverPolicySource: "company_cap",
        payload: { version: 1, questions: [] },
      },
    ]);
    // An addressed card only reaches board attention once its addressee cannot
    // act, which is exactly when naming the addressee matters most.
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "pending",
      title: "Addressed question",
      createdByAgentId: workerId,
      addresseeAgentId: reviewerId,
      payload: { version: 1, questions: [] },
    });
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "pending",
      title: "User-addressed question",
      createdByAgentId: workerId,
      addresseeUserId: "board-user",
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      payload: { version: 1, questions: [] },
    });
    await createAgentLifecycle(db).pauseAgent(reviewerId);

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const otherUserFeed = await attentionService(db).list(companyId, { userId: "other-user" });
    const audienceByTitle = new Map(feed.items
      .filter((item) => item.sourceKind === "issue_thread_interaction")
      .map((item) => [item.subject.title, item.resolverAudience]));

    expect(audienceByTitle.get("Open question")).toMatchObject({
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "anyone",
      effectiveResolverPolicySource: "requested",
      addresseeAgentId: null,
      addresseeName: null,
    });
    expect(audienceByTitle.get("Creator-excluded question")).toMatchObject({
      effectiveResolverPolicy: "not_creator",
      createdByAgentId: workerId,
      createdByAgentName: "Worker",
    });
    expect(audienceByTitle.get("Capped question")).toMatchObject({
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "human_only",
      effectiveResolverPolicySource: "company_cap",
    });
    expect(audienceByTitle.get("Addressed question")).toMatchObject({
      addresseeAgentId: reviewerId,
      addresseeName: "Reviewer",
    });
    expect(audienceByTitle.get("User-addressed question")).toMatchObject({
      addresseeUserId: "board-user",
      effectiveResolverPolicy: "human_only",
    });
    expect(otherUserFeed.items.some((item) => item.subject.title === "User-addressed question")).toBe(false);
    // Non-interaction rows carry no resolver policy at all.
    expect(feed.items.find((item) => item.sourceKind !== "issue_thread_interaction")?.resolverAudience)
      .toBeNull();
  });

  it("reads one compact row per exhausted run despite thousands of historical receipts", async () => {
    const { companyId, workerId, reviewerId } = await seedCompany("MEM");
    const other = await seedCompany("OTH");
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, reviewerId));
    const issueId = await insertIssue({
      companyId, identifier: "MEM-1", title: "Failed task", status: "in_progress",
    });
    const taskId = await insertIssue({
      companyId, identifier: "MEM-2", title: "Timed out task", status: "in_progress",
    });
    const [failedId, timedOutId, succeededId, terminatedId, foreignId, noReceiptId] =
      Array.from({ length: 6 }, () => randomUUID());
    const createdAt = new Date("2026-07-09T12:00:00.000Z");
    await db.insert(heartbeatRuns).values([
      { id: failedId, companyId, agentId: workerId, status: "failed", contextSnapshot: { issueId, prompt: "x".repeat(32_000) } },
      { id: timedOutId, companyId, agentId: workerId, status: "timed_out", contextSnapshot: { taskId, prompt: "y".repeat(32_000) } },
      { id: succeededId, companyId, agentId: workerId, status: "succeeded" },
      { id: terminatedId, companyId, agentId: reviewerId, status: "failed" },
      { id: foreignId, companyId: other.companyId, agentId: other.workerId, status: "failed" },
      { id: noReceiptId, companyId, agentId: workerId, status: "failed" },
    ].map((run) => ({ ...run, createdAt, updatedAt: createdAt, finishedAt: createdAt })));
    for (let batch = 0; batch < 5; batch += 1) {
      await db.insert(heartbeatRunEvents).values(Array.from({ length: 500 }, (_, index) => ({
        companyId, agentId: workerId, runId: failedId, seq: batch * 500 + index + 1,
        eventType: "lifecycle", message: `Bounded retry exhausted receipt ${batch * 500 + index + 1}`,
      })));
    }
    await db.insert(heartbeatRunEvents).values([
      { companyId, agentId: workerId, runId: timedOutId, seq: 1, eventType: "lifecycle", message: "Bounded retry exhausted timeout" },
      { companyId, agentId: workerId, runId: succeededId, seq: 1, eventType: "lifecycle", message: "Bounded retry exhausted success" },
      { companyId, agentId: reviewerId, runId: terminatedId, seq: 1, eventType: "lifecycle", message: "Bounded retry exhausted terminated" },
      { companyId: other.companyId, agentId: other.workerId, runId: foreignId, seq: 1, eventType: "lifecycle", message: "Bounded retry exhausted other company" },
      // A newer event must not replace the latest matching, company-scoped receipt.
      { companyId: other.companyId, agentId: other.workerId, runId: failedId, seq: 2501, eventType: "lifecycle", message: "Bounded retry exhausted foreign receipt" },
      { companyId, agentId: workerId, runId: failedId, seq: 2502, eventType: "stdout", message: "Bounded retry exhausted quoted output" },
      { companyId, agentId: workerId, runId: failedId, seq: 2503, eventType: "lifecycle", message: "Unrelated lifecycle event" },
    ]);

    // Assert the database result itself: JavaScript feed deduplication used to
    // hide the thousands of full run contexts already loaded into memory.
    const rows = await listAttentionExhaustedRuns(db, companyId);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === failedId)).toMatchObject({
      exhaustionMessage: "Bounded retry exhausted receipt 2500",
      contextSnapshot: { issueId, taskId: null },
    });
    expect(rows.find((row) => row.id === timedOutId)?.contextSnapshot).toEqual({ issueId: null, taskId });
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThan(4096);

    const feed = await attentionService(db).list(companyId, {
      includeDismissed: true, all: true, allowUnscopedAll: true,
    });
    const failures = feed.items.filter((item) => item.sourceKind === "failed_run");
    expect(failures.map((item) => item.subject.id).sort()).toEqual([failedId, timedOutId].sort());
    expect(failures.find((item) => item.subject.id === timedOutId)?.relatedIssue?.id).toBe(taskId);
  });

  it("bounds the newer-run scan per agent without changing failed-run feed results", async () => {
    const { companyId, workerId, reviewerId } = await seedCompany("AGW");
    const workerIssueId = await insertIssue({
      companyId,
      identifier: "AGW-1",
      title: "Worker failed task",
      status: "in_progress",
    });
    const reviewerIssueId = await insertIssue({
      companyId,
      identifier: "AGW-2",
      title: "Reviewer failed task",
      status: "in_progress",
    });
    // The worker's exhausted failure is much older than the reviewer's. The
    // newer-run window must be computed per agent: the reviewer's window
    // starts at its own failure, so the old worker run and the stale
    // pre-failure reviewer run must not leak into it, while the reviewer's
    // newer succeeded run on the same issue still suppresses its failure.
    const workerFailureId = randomUUID();
    const workerFailureAt = new Date("2026-07-01T12:00:00.000Z");
    const reviewerFailureId = randomUUID();
    const reviewerFailureAt = new Date("2026-07-09T12:00:00.000Z");
    await db.insert(heartbeatRuns).values([
      {
        id: workerFailureId,
        companyId,
        agentId: workerId,
        invocationSource: "automation",
        status: "failed",
        error: "worker adapter failed",
        contextSnapshot: { issueId: workerIssueId },
        createdAt: workerFailureAt,
        updatedAt: workerFailureAt,
        finishedAt: workerFailureAt,
      },
      {
        id: randomUUID(),
        companyId,
        agentId: reviewerId,
        invocationSource: "automation",
        status: "succeeded",
        // Older than the reviewer's failure: outside its per-agent window
        // and never a "newer run" for the failure either way.
        contextSnapshot: { issueId: reviewerIssueId },
        createdAt: new Date("2026-07-08T12:00:00.000Z"),
        updatedAt: new Date("2026-07-08T12:00:00.000Z"),
        finishedAt: new Date("2026-07-08T12:00:00.000Z"),
      },
      {
        id: reviewerFailureId,
        companyId,
        agentId: reviewerId,
        invocationSource: "automation",
        status: "failed",
        error: "reviewer adapter failed",
        contextSnapshot: { issueId: reviewerIssueId },
        createdAt: reviewerFailureAt,
        updatedAt: reviewerFailureAt,
        finishedAt: reviewerFailureAt,
      },
      {
        id: randomUUID(),
        companyId,
        agentId: reviewerId,
        invocationSource: "automation",
        status: "succeeded",
        // Newer run for the same issue/agent pair: suppresses the failure.
        contextSnapshot: { issueId: reviewerIssueId },
        createdAt: new Date("2026-07-09T12:01:00.000Z"),
        updatedAt: new Date("2026-07-09T12:01:00.000Z"),
        finishedAt: new Date("2026-07-09T12:01:00.000Z"),
      },
    ]);
    await db.insert(heartbeatRunEvents).values([
      {
        companyId,
        runId: workerFailureId,
        agentId: workerId,
        seq: 1,
        eventType: "lifecycle",
        message: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
        createdAt: new Date("2026-07-01T12:00:01.000Z"),
      },
      {
        companyId,
        runId: reviewerFailureId,
        agentId: reviewerId,
        seq: 1,
        eventType: "lifecycle",
        message: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
        createdAt: new Date("2026-07-09T12:00:01.000Z"),
      },
    ]);

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    const failures = feed.items.filter((item) => item.sourceKind === "failed_run");
    expect(failures.map((item) => item.subject.id)).toEqual([workerFailureId]);
    expect(failures[0]?.relatedIssue?.id).toBe(workerIssueId);
  });
});
