import { z } from "zod";
import {
  ISSUE_PRIORITIES,
  WEEKLY_REVIEW_EVENT_STATUSES,
  WEEKLY_REVIEW_EVENT_TYPES,
  WEEKLY_REVIEW_ACTION_KINDS,
  WEEKLY_REVIEW_ACTION_STATUSES,
  WEEKLY_REVIEW_FINDING_CATEGORIES,
  WEEKLY_REVIEW_FINDING_SEVERITIES,
  WEEKLY_REVIEW_FINDING_STATUSES,
  WEEKLY_REVIEW_RECOMMENDATION_STATES,
  WEEKLY_REVIEW_STATUSES,
  WEEKLY_REVIEW_VERSION_STATUSES,
} from "../constants.js";

export const weeklyReviewStatusSchema = z.enum(WEEKLY_REVIEW_STATUSES);
export const weeklyReviewVersionStatusSchema = z.enum(WEEKLY_REVIEW_VERSION_STATUSES);
export const weeklyReviewFindingCategorySchema = z.enum(WEEKLY_REVIEW_FINDING_CATEGORIES);
export const weeklyReviewFindingSeveritySchema = z.enum(WEEKLY_REVIEW_FINDING_SEVERITIES);
export const weeklyReviewFindingStatusSchema = z.enum(WEEKLY_REVIEW_FINDING_STATUSES);
export const weeklyReviewRecommendationStateSchema = z.enum(WEEKLY_REVIEW_RECOMMENDATION_STATES);
export const weeklyReviewActionStatusSchema = z.enum(WEEKLY_REVIEW_ACTION_STATUSES);
export const weeklyReviewActionKindSchema = z.enum(WEEKLY_REVIEW_ACTION_KINDS);
export const weeklyReviewEventTypeSchema = z.enum(WEEKLY_REVIEW_EVENT_TYPES);
export const weeklyReviewEventStatusSchema = z.enum(WEEKLY_REVIEW_EVENT_STATUSES);

export const generateWeeklyReviewSchema = z.object({
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  previousVersionId: z.string().uuid().optional(),
});

export const createWeeklyReviewRecommendationActionSchema = z.object({
  actionKind: weeklyReviewActionKindSchema,
  note: z.string().trim().max(2000).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(10000).nullable().optional(),
  priority: z.enum(ISSUE_PRIORITIES).optional(),
  targetEntityType: z.string().trim().min(1).max(80).optional(),
  targetEntityId: z.string().trim().min(1).max(200).optional(),
  request: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.actionKind === "create_followup_issue" && !value.title) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["title"],
      message: "Follow-up issue actions require a title",
    });
  }
  if (value.actionKind === "assign_issue") {
    if (value.targetEntityType !== "issue" || !value.targetEntityId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetEntityId"],
        message: "Assign issue actions require a target issue",
      });
    }
    const assigneeAgentId = typeof value.request?.assigneeAgentId === "string" ? value.request.assigneeAgentId : null;
    const assigneeUserId = typeof value.request?.assigneeUserId === "string" ? value.request.assigneeUserId : null;
    if (!assigneeAgentId && !assigneeUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["request"],
        message: "Assign issue actions require assigneeAgentId or assigneeUserId",
      });
    }
  }
  if (value.actionKind === "pause_agent" || value.actionKind === "resume_agent") {
    if (value.targetEntityType !== "agent" || !value.targetEntityId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetEntityId"],
        message: "Agent lifecycle actions require a target agent",
      });
    }
  }
  if (value.actionKind === "approve_governed_item" || value.actionKind === "reject_governed_item") {
    if (value.targetEntityType !== "approval" || !value.targetEntityId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetEntityId"],
        message: "Governed item actions require a target approval",
      });
    }
  }
});

export type CreateWeeklyReviewRecommendationAction = z.infer<typeof createWeeklyReviewRecommendationActionSchema>;
