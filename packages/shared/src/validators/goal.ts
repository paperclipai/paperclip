import { z } from "zod";
import { GOAL_LEVELS, GOAL_STATUSES } from "../constants.js";

export const GOAL_REVIEW_POLICIES = ["owner", "board"] as const;
export type GoalReviewPolicy = (typeof GOAL_REVIEW_POLICIES)[number];

export const createGoalSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  level: z.enum(GOAL_LEVELS).optional().default("task"),
  status: z.enum(GOAL_STATUSES).optional().default("planned"),
  parentId: z.string().uuid().optional().nullable(),
  ownerAgentId: z.string().uuid().optional().nullable(),
  reviewPolicy: z.enum(GOAL_REVIEW_POLICIES).optional().default("owner"),
});

export type CreateGoal = z.infer<typeof createGoalSchema>;

export const updateGoalSchema = createGoalSchema.partial();

export type UpdateGoal = z.infer<typeof updateGoalSchema>;
