import { z } from "zod";
import { GOAL_LEVELS, GOAL_STATUSES } from "../constants.js";

// Numeric metric fields are stored as Postgres `numeric` (returned as strings).
// Accept either a JSON number or a numeric string from clients and normalize to
// a string for storage; reject non-numeric strings.
const metricNumber = z
  .union([z.number(), z.string()])
  .nullable()
  .optional()
  .transform((value) => {
    if (value === null || value === undefined || value === "") return value === "" ? null : value;
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? String(parsed) : null;
  });

export const createGoalSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  level: z.enum(GOAL_LEVELS).optional().default("task"),
  status: z.enum(GOAL_STATUSES).optional().default("planned"),
  parentId: z.string().uuid().optional().nullable(),
  ownerAgentId: z.string().uuid().optional().nullable(),
  metricTarget: metricNumber,
  metricCurrent: metricNumber,
  metricUnit: z.string().max(40).optional().nullable(),
  targetDate: z.coerce.date().optional().nullable(),
});

export type CreateGoal = z.infer<typeof createGoalSchema>;

export const updateGoalSchema = createGoalSchema.partial();

export type UpdateGoal = z.infer<typeof updateGoalSchema>;
