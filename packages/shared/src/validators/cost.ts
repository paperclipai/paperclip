import { z } from "zod";
import { BILLING_TYPES } from "../constants.js";

export const createCostEventSchema = z.object({
  agentId: z.string().uuid(),
  issueId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  heartbeatRunId: z.string().uuid().optional().nullable(),
  billingCode: z.string().optional().nullable(),
  provider: z.string().min(1),
  biller: z.string().min(1).optional(),
  billingType: z.enum(BILLING_TYPES).optional().default("unknown"),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative().optional().default(0),
  cachedInputTokens: z.number().int().nonnegative().optional().default(0),
  outputTokens: z.number().int().nonnegative().optional().default(0),
  costCents: z.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
}).transform((value) => ({
  ...value,
  biller: value.biller ?? value.provider,
}));

export type CreateCostEvent = z.infer<typeof createCostEventSchema>;

export const updateBudgetSchema = z.object({
  budgetMonthlyCents: z.number().int().nonnegative(),
});

export type UpdateBudget = z.infer<typeof updateBudgetSchema>;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be ISO date YYYY-MM-DD");

export const recurringCostLineSchema = z
  .object({
    biller: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    monthlyCents: z.number().int().nonnegative(),
    startedOn: isoDate,
    endedOn: isoDate.nullable(),
    note: z.string().optional(),
  })
  .refine(
    (line) => line.endedOn === null || line.endedOn >= line.startedOn,
    { message: "endedOn must be on or after startedOn", path: ["endedOn"] },
  );

export const recurringCostsSchema = z.array(recurringCostLineSchema);

export type RecurringCostLineInput = z.infer<typeof recurringCostLineSchema>;
