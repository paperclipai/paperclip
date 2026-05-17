import { z } from "zod";
import { GOAL_LEVELS, GOAL_STATUSES } from "../constants.js";

export const createGoalSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  level: z.enum(GOAL_LEVELS).optional().default("task"),
  status: z.enum(GOAL_STATUSES).optional().default("planned"),
  parentId: z.string().uuid().optional().nullable(),
  ownerAgentId: z.string().uuid().optional().nullable(),
}).strict();

export type CreateGoal = z.infer<typeof createGoalSchema>;

export const updateGoalSchema = createGoalSchema.partial().strict();

export type UpdateGoal = z.infer<typeof updateGoalSchema>;
