import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  companies,
  createDb,
  issues,
  weeklyReviewActions,
  weeklyReviewFindings,
  weeklyReviewRecommendations,
  weeklyReviews,
  weeklyReviewVersions,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";

import { weeklyReviewActionService } from "../services/weekly-review/actions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres weekly review action tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("weekly review action service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-weekly-review-actions-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(weeklyReviewActions);
    await db.delete(weeklyReviewRecommendations);
    await db.delete(weeklyReviewFindings);
    await db.delete(weeklyReviewVersions);
    await db.delete(weeklyReviews);
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("accepts a recommendation, persists action history, and links activity evidence", async () => {
    const seed = await seedReviewRecommendation(db);

    const result = await weeklyReviewActionService(db).createRecommendationAction(
      seed.recommendationId,
      { actionKind: "accept_recommendation", note: "Approved for limited rollout." },
      { actorType: "user", actorId: seed.actorUserId, agentId: null, runId: null },
    );

    expect(result.action).toMatchObject({
      reviewId: seed.reviewId,
      versionId: seed.versionId,
      findingId: seed.findingId,
      recommendationId: seed.recommendationId,
      companyId: seed.companyId,
      actionKind: "accept_recommendation",
      status: "completed",
      requestedByUserId: seed.actorUserId,
      targetEntityType: "weekly_review_recommendation",
      targetEntityId: seed.recommendationId,
    });
    expect(result.action.activityLogId).toEqual(expect.any(String));

    const [recommendation] = await db
      .select()
      .from(weeklyReviewRecommendations)
      .where(eq(weeklyReviewRecommendations.id, seed.recommendationId));
    const [logged] = await db.select().from(activityLog).where(eq(activityLog.id, result.action.activityLogId!));

    expect(recommendation?.state).toBe("accepted");
    expect(logged).toMatchObject({
      companyId: seed.companyId,
      actorType: "user",
      actorId: seed.actorUserId,
      action: "weekly_review.recommendation.accepted",
      entityType: "weekly_review_recommendation",
      entityId: seed.recommendationId,
    });
  });

  it("creates a follow-up issue from a recommendation and records the target issue", async () => {
    const seed = await seedReviewRecommendation(db);

    const result = await weeklyReviewActionService(db).createRecommendationAction(
      seed.recommendationId,
      {
        actionKind: "create_followup_issue",
        title: "Assign support handoff owner",
        description: "Follow up on NSR-F01 before pilot rollout.",
        priority: "high",
      },
      { actorType: "user", actorId: seed.actorUserId, agentId: null, runId: null },
    );

    expect(result.action).toMatchObject({
      actionKind: "create_followup_issue",
      status: "completed",
      targetEntityType: "issue",
    });
    expect(result.issue).toMatchObject({
      companyId: seed.companyId,
      title: "Assign support handoff owner",
      priority: "high",
      status: "backlog",
    });
  });

  it("records fallback requests without mutating adapter configuration", async () => {
    const seed = await seedReviewRecommendation(db);

    const result = await weeklyReviewActionService(db).createRecommendationAction(
      seed.recommendationId,
      {
        actionKind: "model_profile_fallback",
        targetEntityType: "agent",
        targetEntityId: "agent-1",
        request: { requestedModelProfile: "cheap" },
      },
      { actorType: "user", actorId: seed.actorUserId, agentId: null, runId: null },
    );

    expect(result.action).toMatchObject({
      actionKind: "model_profile_fallback",
      status: "requested",
      targetEntityType: "agent",
      targetEntityId: "agent-1",
      resultJson: {
        mutationApplied: false,
        approvalRequired: true,
      },
    });
  });

  it("does not persist local implicit board actors as auth user attribution", async () => {
    const seed = await seedReviewRecommendation(db);

    const result = await weeklyReviewActionService(db).createRecommendationAction(
      seed.recommendationId,
      { actionKind: "dismiss_recommendation", note: "False alarm for this period." },
      { actorType: "user", actorId: "board", agentId: null, runId: null },
    );

    const [logged] = await db.select().from(activityLog).where(eq(activityLog.id, result.action.activityLogId!));

    expect(result.action).toMatchObject({
      actionKind: "dismiss_recommendation",
      status: "completed",
      requestedByUserId: null,
    });
    expect(logged).toMatchObject({
      actorType: "user",
      actorId: "board",
      action: "weekly_review.recommendation.dismissed",
    });
  });

  it("assigns a target issue through the domain issue service", async () => {
    const seed = await seedReviewRecommendation(db);
    const [agent] = await db.insert(agents).values({
      companyId: seed.companyId,
      name: "Support Ops Lead",
      role: "ops",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: seed.companyId,
      title: "Support handoff lacks owner",
      status: "backlog",
      priority: "high",
    }).returning();

    const result = await weeklyReviewActionService(db).createRecommendationAction(
      seed.recommendationId,
      {
        actionKind: "assign_issue",
        targetEntityType: "issue",
        targetEntityId: issue.id,
        request: { assigneeAgentId: agent.id },
      },
      { actorType: "user", actorId: seed.actorUserId, agentId: null, runId: null },
    );

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, issue.id));
    const [recommendation] = await db
      .select()
      .from(weeklyReviewRecommendations)
      .where(eq(weeklyReviewRecommendations.id, seed.recommendationId));
    const [logged] = await db.select().from(activityLog).where(eq(activityLog.id, result.action.activityLogId!));

    expect(updatedIssue).toMatchObject({
      assigneeAgentId: agent.id,
      assigneeUserId: null,
    });
    expect(recommendation?.state).toBe("accepted");
    expect(result.action).toMatchObject({
      actionKind: "assign_issue",
      status: "completed",
      targetEntityType: "issue",
      targetEntityId: issue.id,
      resultJson: {
        mutationApplied: true,
        recommendationState: "accepted",
      },
    });
    expect(logged).toMatchObject({
      action: "weekly_review.issue.assigned",
      entityType: "weekly_review_recommendation",
      entityId: seed.recommendationId,
    });
  });

  it("rejects assigning an issue that belongs to another company", async () => {
    const seed = await seedReviewRecommendation(db);
    const otherCompanyId = await seedCompany(db, "Foreign Issue");
    const [agent] = await db.insert(agents).values({
      companyId: seed.companyId,
      name: "Support Ops Lead",
      role: "ops",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
    }).returning();
    const [foreignIssue] = await db.insert(issues).values({
      companyId: otherCompanyId,
      title: "Foreign company issue",
      status: "backlog",
      priority: "high",
    }).returning();

    await expect(
      weeklyReviewActionService(db).createRecommendationAction(
        seed.recommendationId,
        {
          actionKind: "assign_issue",
          targetEntityType: "issue",
          targetEntityId: foreignIssue.id,
          request: { assigneeAgentId: agent.id },
        },
        { actorType: "user", actorId: seed.actorUserId, agentId: null, runId: null },
      ),
    ).rejects.toThrow("Issue must belong to the weekly review company");

    const [recommendation] = await db
      .select()
      .from(weeklyReviewRecommendations)
      .where(eq(weeklyReviewRecommendations.id, seed.recommendationId));
    const actionRows = await db.select().from(weeklyReviewActions).where(eq(weeklyReviewActions.companyId, seed.companyId));

    expect(recommendation?.state).toBe("open");
    expect(actionRows).toHaveLength(0);
  });

  it("pauses and resumes a target agent through the domain agent service", async () => {
    const seed = await seedReviewRecommendation(db);
    const [agent] = await db.insert(agents).values({
      companyId: seed.companyId,
      name: "Research Lead",
      role: "research",
      status: "idle",
      adapterType: "agy_local",
      adapterConfig: {},
    }).returning();

    const paused = await weeklyReviewActionService(db).createRecommendationAction(
      seed.recommendationId,
      {
        actionKind: "pause_agent",
        targetEntityType: "agent",
        targetEntityId: agent.id,
      },
      { actorType: "user", actorId: seed.actorUserId, agentId: null, runId: null },
    );
    const [pausedAgent] = await db.select().from(agents).where(eq(agents.id, agent.id));
    const [pausedLog] = await db.select().from(activityLog).where(eq(activityLog.id, paused.action.activityLogId!));

    const resumed = await weeklyReviewActionService(db).createRecommendationAction(
      seed.recommendationId,
      {
        actionKind: "resume_agent",
        targetEntityType: "agent",
        targetEntityId: agent.id,
      },
      { actorType: "user", actorId: seed.actorUserId, agentId: null, runId: null },
    );
    const [resumedAgent] = await db.select().from(agents).where(eq(agents.id, agent.id));
    const [resumedLog] = await db.select().from(activityLog).where(eq(activityLog.id, resumed.action.activityLogId!));

    expect(pausedAgent).toMatchObject({ status: "paused", pauseReason: "manual" });
    expect(resumedAgent).toMatchObject({ status: "idle", pauseReason: null, pausedAt: null });
    expect(paused.action).toMatchObject({
      actionKind: "pause_agent",
      status: "completed",
      targetEntityType: "agent",
      targetEntityId: agent.id,
    });
    expect(pausedLog?.action).toBe("weekly_review.agent.paused");
    expect(resumed.action).toMatchObject({
      actionKind: "resume_agent",
      status: "completed",
      targetEntityType: "agent",
      targetEntityId: agent.id,
    });
    expect(resumedLog?.action).toBe("weekly_review.agent.resumed");
  });

  it("rejects pausing an agent that belongs to another company", async () => {
    const seed = await seedReviewRecommendation(db);
    const otherCompanyId = await seedCompany(db, "Foreign Agent");
    const [foreignAgent] = await db.insert(agents).values({
      companyId: otherCompanyId,
      name: "Foreign Research Lead",
      role: "research",
      status: "idle",
      adapterType: "agy_local",
      adapterConfig: {},
    }).returning();

    await expect(
      weeklyReviewActionService(db).createRecommendationAction(
        seed.recommendationId,
        {
          actionKind: "pause_agent",
          targetEntityType: "agent",
          targetEntityId: foreignAgent.id,
        },
        { actorType: "user", actorId: seed.actorUserId, agentId: null, runId: null },
      ),
    ).rejects.toThrow("Agent must belong to the weekly review company");

    const [agent] = await db.select().from(agents).where(eq(agents.id, foreignAgent.id));
    const actionRows = await db.select().from(weeklyReviewActions).where(eq(weeklyReviewActions.companyId, seed.companyId));

    expect(agent?.status).toBe("idle");
    expect(actionRows).toHaveLength(0);
  });

  it("approves and rejects governed approval targets through the approval service", async () => {
    const seed = await seedReviewRecommendation(db);
    const [approvalToApprove] = await db.insert(approvals).values({
      companyId: seed.companyId,
      type: "budget_exception",
      status: "pending",
      payload: { amountCents: 1000 },
    }).returning();
    const [approvalToReject] = await db.insert(approvals).values({
      companyId: seed.companyId,
      type: "budget_exception",
      status: "pending",
      payload: { amountCents: 2000 },
    }).returning();

    const approved = await weeklyReviewActionService(db).createRecommendationAction(
      seed.recommendationId,
      {
        actionKind: "approve_governed_item",
        targetEntityType: "approval",
        targetEntityId: approvalToApprove.id,
        note: "Approved from weekly review.",
      },
      { actorType: "user", actorId: seed.actorUserId, agentId: null, runId: null },
    );
    const rejected = await weeklyReviewActionService(db).createRecommendationAction(
      seed.recommendationId,
      {
        actionKind: "reject_governed_item",
        targetEntityType: "approval",
        targetEntityId: approvalToReject.id,
        note: "Reject until support owner is assigned.",
      },
      { actorType: "user", actorId: seed.actorUserId, agentId: null, runId: null },
    );

    const [approvedRow] = await db.select().from(approvals).where(eq(approvals.id, approvalToApprove.id));
    const [rejectedRow] = await db.select().from(approvals).where(eq(approvals.id, approvalToReject.id));
    const [approvedLog] = await db.select().from(activityLog).where(eq(activityLog.id, approved.action.activityLogId!));
    const [rejectedLog] = await db.select().from(activityLog).where(eq(activityLog.id, rejected.action.activityLogId!));

    expect(approvedRow).toMatchObject({
      status: "approved",
      decidedByUserId: seed.actorUserId,
      decisionNote: "Approved from weekly review.",
    });
    expect(rejectedRow).toMatchObject({
      status: "rejected",
      decidedByUserId: seed.actorUserId,
      decisionNote: "Reject until support owner is assigned.",
    });
    expect(approved.action).toMatchObject({
      actionKind: "approve_governed_item",
      status: "completed",
      targetEntityType: "approval",
      targetEntityId: approvalToApprove.id,
    });
    expect(rejected.action).toMatchObject({
      actionKind: "reject_governed_item",
      status: "completed",
      targetEntityType: "approval",
      targetEntityId: approvalToReject.id,
    });
    expect(approvedLog?.action).toBe("weekly_review.approval.approved");
    expect(rejectedLog?.action).toBe("weekly_review.approval.rejected");
  });

  it("rejects approving a governed item that belongs to another company", async () => {
    const seed = await seedReviewRecommendation(db);
    const otherCompanyId = await seedCompany(db, "Foreign Approval");
    const [foreignApproval] = await db.insert(approvals).values({
      companyId: otherCompanyId,
      type: "budget_exception",
      status: "pending",
      payload: { amountCents: 5000 },
    }).returning();

    await expect(
      weeklyReviewActionService(db).createRecommendationAction(
        seed.recommendationId,
        {
          actionKind: "approve_governed_item",
          targetEntityType: "approval",
          targetEntityId: foreignApproval.id,
          note: "Do not approve cross-company approvals.",
        },
        { actorType: "user", actorId: seed.actorUserId, agentId: null, runId: null },
      ),
    ).rejects.toThrow("Approval must belong to the weekly review company");

    const [approval] = await db.select().from(approvals).where(eq(approvals.id, foreignApproval.id));
    const actionRows = await db.select().from(weeklyReviewActions).where(eq(weeklyReviewActions.companyId, seed.companyId));

    expect(approval?.status).toBe("pending");
    expect(actionRows).toHaveLength(0);
  });
});

async function seedCompany(db: ReturnType<typeof createDb>, namePrefix: string) {
  const companyId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: `${namePrefix} ${companyId.slice(0, 8)}`,
    issuePrefix: `WX${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  return companyId;
}

async function seedReviewRecommendation(db: ReturnType<typeof createDb>) {
  const companyId = randomUUID();
  const actorUserId = `board-user-${companyId.slice(0, 8)}`;
  await db.insert(authUsers).values({
    id: actorUserId,
    name: "Board User",
    email: `${actorUserId}@example.test`,
    emailVerified: true,
    createdAt: new Date("2026-05-17T00:00:00.000Z"),
    updatedAt: new Date("2026-05-17T00:00:00.000Z"),
  });

  await db.insert(companies).values({
    id: companyId,
    name: `Weekly Actions ${companyId.slice(0, 8)}`,
    issuePrefix: `WA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });

  const [review] = await db.insert(weeklyReviews).values({
    companyId,
    periodStart: new Date("2026-05-11T00:00:00.000Z"),
    periodEnd: new Date("2026-05-17T23:59:59.000Z"),
    status: "ready",
  }).returning();
  const [version] = await db.insert(weeklyReviewVersions).values({
    reviewId: review.id,
    companyId,
    versionNumber: 1,
    status: "ready",
    sourceWindowStart: new Date("2026-05-11T00:00:00.000Z"),
    sourceWindowEnd: new Date("2026-05-17T23:59:59.000Z"),
  }).returning();
  await db.update(weeklyReviews).set({ latestVersionId: version.id }).where(eq(weeklyReviews.id, review.id));
  const [finding] = await db.insert(weeklyReviewFindings).values({
    reviewId: review.id,
    versionId: version.id,
    companyId,
    stableId: "NSR-F01",
    category: "decision_blocker",
    severity: "critical",
    status: "open",
    title: "Pilot rollout blocked by missing support owner",
    summary: "Support handoff owner is missing.",
    sourceEntityType: "issue",
    sourceEntityId: "issue-support",
    confidence: "high",
    detectedAt: new Date("2026-05-17T23:59:59.000Z"),
    validationStatus: "valid",
  }).returning();
  const [recommendation] = await db.insert(weeklyReviewRecommendations).values({
    reviewId: review.id,
    versionId: version.id,
    findingId: finding.id,
    companyId,
    kind: "assign_owner",
    severity: "critical",
    state: "open",
    title: "Assign support handoff owner",
    rationale: "The rollout needs an accountable support owner.",
    proposedActionJson: { kind: "assign_owner" },
  }).returning();

  return {
    companyId,
    reviewId: review.id,
    versionId: version.id,
    findingId: finding.id,
    recommendationId: recommendation.id,
    actorUserId,
  };
}
