import type { Db } from "@paperclipai/db";
import {
  activityLog,
  authUsers,
  issues,
  weeklyReviewActions,
  weeklyReviewRecommendations,
} from "@paperclipai/db";
import type { CreateWeeklyReviewRecommendationAction } from "@paperclipai/shared";
import { eq } from "drizzle-orm";

import { notFound, unprocessable } from "../../errors.js";
import { agentService } from "../agents.js";
import { approvalService } from "../approvals.js";
import { heartbeatService } from "../heartbeat.js";
import { issueService } from "../issues.js";

export interface WeeklyReviewActionActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
}

export function weeklyReviewActionService(db: Db) {
  return {
    async getRecommendationActionContext(recommendationId: string) {
      return await getRecommendation(db, recommendationId);
    },

    async createRecommendationAction(
      recommendationId: string,
      input: CreateWeeklyReviewRecommendationAction,
      actor: WeeklyReviewActionActor,
    ) {
      return await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const recommendation = await getRecommendation(txDb, recommendationId);
        const requestedByUserId = await resolveRequestedByUserId(txDb, actor);
        const requestJson = buildRequestJson(input);
        const actionOutcome = await applyAction(txDb, recommendation, input, actor, requestedByUserId);
        const [logged] = await txDb.insert(activityLog).values({
          companyId: recommendation.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          action: activityActionFor(input.actionKind),
          entityType: "weekly_review_recommendation",
          entityId: recommendation.id,
          agentId: actor.agentId ?? null,
          runId: actor.runId ?? null,
          details: {
            reviewId: recommendation.reviewId,
            versionId: recommendation.versionId,
            findingId: recommendation.findingId,
            recommendationId: recommendation.id,
            actionKind: input.actionKind,
            targetEntityType: actionOutcome.targetEntityType,
            targetEntityId: actionOutcome.targetEntityId,
          },
        }).returning();
        const [action] = await txDb.insert(weeklyReviewActions).values({
          reviewId: recommendation.reviewId,
          versionId: recommendation.versionId,
          findingId: recommendation.findingId,
          recommendationId: recommendation.id,
          companyId: recommendation.companyId,
          actionKind: input.actionKind,
          status: actionOutcome.status,
          requestedByUserId,
          targetEntityType: actionOutcome.targetEntityType,
          targetEntityId: actionOutcome.targetEntityId,
          requestJson,
          resultJson: actionOutcome.resultJson,
          activityLogId: logged.id,
        }).returning();

        return {
          action,
          issue: actionOutcome.issue ?? null,
        };
      });
    },
  };
}

async function getRecommendation(db: Db, recommendationId: string) {
  const [recommendation] = await db
    .select()
    .from(weeklyReviewRecommendations)
    .where(eq(weeklyReviewRecommendations.id, recommendationId))
    .limit(1);
  if (!recommendation) throw notFound("Weekly review recommendation not found");
  return recommendation;
}

async function applyAction(
  db: Db,
  recommendation: typeof weeklyReviewRecommendations.$inferSelect,
  input: CreateWeeklyReviewRecommendationAction,
  actor: WeeklyReviewActionActor,
  requestedByUserId: string | null,
) {
  if (input.actionKind === "accept_recommendation" || input.actionKind === "dismiss_recommendation") {
    const state = input.actionKind === "accept_recommendation" ? "accepted" : "dismissed";
    await db
      .update(weeklyReviewRecommendations)
      .set({ state, updatedAt: new Date() })
      .where(eq(weeklyReviewRecommendations.id, recommendation.id));
    return {
      status: "completed" as const,
      targetEntityType: "weekly_review_recommendation",
      targetEntityId: recommendation.id,
      resultJson: { recommendationState: state },
    };
  }

  if (input.actionKind === "create_followup_issue") {
    const [issue] = await db.insert(issues).values({
      companyId: recommendation.companyId,
      title: input.title!,
      description: input.description ?? recommendation.rationale,
      status: "backlog",
      priority: input.priority ?? "medium",
      originKind: "weekly_review_action",
      originId: recommendation.id,
      originFingerprint: input.actionKind,
      createdByUserId: null,
    }).returning();
    await db
      .update(weeklyReviewRecommendations)
      .set({ state: "accepted", updatedAt: new Date() })
      .where(eq(weeklyReviewRecommendations.id, recommendation.id));
    return {
      status: "completed" as const,
      targetEntityType: "issue",
      targetEntityId: issue.id,
      resultJson: { issueId: issue.id, recommendationState: "accepted" },
      issue,
    };
  }

  if (input.actionKind === "assign_issue") {
    const targetIssueId = requiredTarget(input, "issue");
    const existing = await issueService(db).getById(targetIssueId);
    if (!existing) throw notFound("Issue not found");
    assertSameCompany(recommendation.companyId, existing.companyId, "Issue");
    const request = input.request ?? {};
    const assigneeAgentId = readString(request.assigneeAgentId);
    const assigneeUserId = readString(request.assigneeUserId);
    const nextStatus = readString(request.status);
    const issue = await issueService(db).update(targetIssueId, {
      assigneeAgentId: assigneeAgentId ?? null,
      assigneeUserId: assigneeUserId ?? null,
      ...(nextStatus ? { status: nextStatus } : {}),
      actorAgentId: actor.agentId ?? null,
      actorUserId: requestedByUserId,
    }, db);
    if (!issue) throw notFound("Issue not found");
    await markRecommendationAccepted(db, recommendation.id);
    return {
      status: "completed" as const,
      targetEntityType: "issue",
      targetEntityId: issue.id,
      resultJson: {
        mutationApplied: true,
        recommendationState: "accepted",
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        issueStatus: issue.status,
      },
      issue,
    };
  }

  if (input.actionKind === "pause_agent" || input.actionKind === "resume_agent") {
    const targetAgentId = requiredTarget(input, "agent");
    const existing = await agentService(db).getById(targetAgentId);
    if (!existing) throw notFound("Agent not found");
    assertSameCompany(recommendation.companyId, existing.companyId, "Agent");
    const agent = input.actionKind === "pause_agent"
      ? await agentService(db).pause(targetAgentId)
      : await agentService(db).resume(targetAgentId);
    if (!agent) throw notFound("Agent not found");
    if (input.actionKind === "pause_agent") {
      await heartbeatService(db).cancelActiveForAgent(targetAgentId);
    }
    await markRecommendationAccepted(db, recommendation.id);
    return {
      status: "completed" as const,
      targetEntityType: "agent",
      targetEntityId: agent.id,
      resultJson: {
        mutationApplied: true,
        recommendationState: "accepted",
        agentStatus: agent.status,
        pauseReason: agent.pauseReason ?? null,
      },
    };
  }

  if (input.actionKind === "approve_governed_item" || input.actionKind === "reject_governed_item") {
    const targetApprovalId = requiredTarget(input, "approval");
    const existing = await approvalService(db).getById(targetApprovalId);
    if (!existing) throw notFound("Approval not found");
    assertSameCompany(recommendation.companyId, existing.companyId, "Approval");
    const decisionNote = input.note ?? readString(input.request?.decisionNote) ?? null;
    const decidedByUserId = requestedByUserId ?? "board";
    const result = input.actionKind === "approve_governed_item"
      ? await approvalService(db).approve(targetApprovalId, decidedByUserId, decisionNote)
      : await approvalService(db).reject(targetApprovalId, decidedByUserId, decisionNote);
    await markRecommendationAccepted(db, recommendation.id);
    return {
      status: "completed" as const,
      targetEntityType: "approval",
      targetEntityId: result.approval.id,
      resultJson: {
        mutationApplied: result.applied,
        recommendationState: "accepted",
        approvalStatus: result.approval.status,
      },
    };
  }

  const approvalRequired = input.actionKind === "operator_fallback" || input.actionKind === "model_profile_fallback";
  if (approvalRequired) {
    await db
      .update(weeklyReviewRecommendations)
      .set({ state: "accepted", updatedAt: new Date() })
      .where(eq(weeklyReviewRecommendations.id, recommendation.id));
  }
  return {
    status: approvalRequired ? "requested" as const : "completed" as const,
    targetEntityType: input.targetEntityType ?? null,
    targetEntityId: input.targetEntityId ?? null,
    resultJson: approvalRequired
      ? { mutationApplied: false, approvalRequired: true }
      : { mutationApplied: false, approvalRequired: false },
  };
}

async function resolveRequestedByUserId(db: Db, actor: WeeklyReviewActionActor) {
  if (actor.actorType !== "user") return null;
  const [user] = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.id, actor.actorId))
    .limit(1);
  return user?.id ?? null;
}

async function markRecommendationAccepted(db: Db, recommendationId: string) {
  await db
    .update(weeklyReviewRecommendations)
    .set({ state: "accepted", updatedAt: new Date() })
    .where(eq(weeklyReviewRecommendations.id, recommendationId));
}

function requiredTarget(input: CreateWeeklyReviewRecommendationAction, targetEntityType: string) {
  if (input.targetEntityType !== targetEntityType || !input.targetEntityId) {
    throw unprocessable(`Action requires target ${targetEntityType}`);
  }
  return input.targetEntityId;
}

function assertSameCompany(expectedCompanyId: string, actualCompanyId: string, entityName: string) {
  if (actualCompanyId !== expectedCompanyId) {
    throw unprocessable(`${entityName} must belong to the weekly review company`);
  }
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function buildRequestJson(input: CreateWeeklyReviewRecommendationAction) {
  return {
    note: input.note ?? null,
    title: input.title ?? null,
    description: input.description ?? null,
    priority: input.priority ?? null,
    request: input.request ?? null,
  };
}

function activityActionFor(actionKind: string) {
  if (actionKind === "accept_recommendation") return "weekly_review.recommendation.accepted";
  if (actionKind === "dismiss_recommendation") return "weekly_review.recommendation.dismissed";
  if (actionKind === "create_followup_issue") return "weekly_review.followup_issue.created";
  if (actionKind === "assign_issue") return "weekly_review.issue.assigned";
  if (actionKind === "pause_agent") return "weekly_review.agent.paused";
  if (actionKind === "resume_agent") return "weekly_review.agent.resumed";
  if (actionKind === "approve_governed_item") return "weekly_review.approval.approved";
  if (actionKind === "reject_governed_item") return "weekly_review.approval.rejected";
  if (actionKind === "operator_fallback") return "weekly_review.fallback.requested";
  if (actionKind === "model_profile_fallback") return "weekly_review.model_profile_fallback.requested";
  return "weekly_review.action.requested";
}
