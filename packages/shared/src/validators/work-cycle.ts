import { z } from "zod";
import { WORK_CYCLE_STATUSES } from "../constants.js";

const workCycleBaseSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional().nullable(),
  status: z.enum(WORK_CYCLE_STATUSES).optional().default("planned"),
  startDate: z.string().date().optional().nullable(),
  endDate: z.string().date().optional().nullable(),
  capacityStoryPoints: z.number().int().min(0).max(100000).optional().nullable(),
  capacityHours: z.number().int().min(0).max(100000).optional().nullable(),
});

export const createWorkCycleSchema = workCycleBaseSchema.superRefine((value, ctx) => {
  if (value.startDate && value.endDate && value.endDate < value.startDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Cycle end date must be on or after the start date",
      path: ["endDate"],
    });
  }
});

export const updateWorkCycleSchema = workCycleBaseSchema.partial().superRefine((value, ctx) => {
  if (value.startDate && value.endDate && value.endDate < value.startDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Cycle end date must be on or after the start date",
      path: ["endDate"],
    });
  }
});

export type CreateWorkCycle = z.infer<typeof createWorkCycleSchema>;
export type UpdateWorkCycle = z.infer<typeof updateWorkCycleSchema>;
