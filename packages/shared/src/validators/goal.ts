import { z } from "zod";
import { GOAL_LEVELS, GOAL_STATUSES } from "../constants.js";
import { databaseTextSchema, multilineTextSchema } from "./text.js";

export const createGoalSchema = z.object({
  title: databaseTextSchema.pipe(z.string().min(1)),
  description: multilineTextSchema.optional().nullable(),
  level: z.enum(GOAL_LEVELS).optional().default("task"),
  status: z.enum(GOAL_STATUSES).optional().default("planned"),
  parentId: z.string().uuid().optional().nullable(),
  ownerAgentId: z.string().uuid().optional().nullable(),
});

export type CreateGoal = z.infer<typeof createGoalSchema>;

export const updateGoalSchema = createGoalSchema.partial();

export type UpdateGoal = z.infer<typeof updateGoalSchema>;
