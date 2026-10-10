import { exactCentsSchema, pricingProvenanceSchema } from "../accounting.js";
import { z } from "zod";
import { BILLING_TYPES, COST_STATUSES } from "../constants.js";

const costEventFields = z.object({
  idempotencyKey: z.string().trim().min(1).max(200).optional().nullable(),
  agentId: z.string().guid(),
  issueId: z.string().guid().optional().nullable(),
  projectId: z.string().guid().optional().nullable(),
  goalId: z.string().guid().optional().nullable(),
  heartbeatRunId: z.string().guid().optional().nullable(),
  billingCode: z.string().optional().nullable(),
  provider: z.string().min(1),
  biller: z.string().min(1).optional(),
  billingType: z.enum(BILLING_TYPES).optional().default("unknown"),
  costStatus: z.enum(COST_STATUSES).optional().default("reported"),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative().max(2_147_483_647).optional().default(0),
  cachedInputTokens: z.number().int().nonnegative().max(2_147_483_647).optional().default(0),
  outputTokens: z.number().int().nonnegative().max(2_147_483_647).optional().default(0),
  costCents: exactCentsSchema,
  providerRequestId: z.string().min(1).max(250).nullable().optional(),
  pricingProvenance: pricingProvenanceSchema.nullable().optional(),
  occurredAt: z.string().datetime(),
});

export const createCostEventSchema = costEventFields.transform((value) => ({
  ...value,
  biller: value.biller ?? value.provider,
}));

/** Internal service receipts; the public reporting endpoint retains its required agent. */
export const createServiceCostEventSchema = costEventFields.extend({
  agentId: z.string().uuid().nullable(),
  usageKind: z.enum(["decision", "fast_response"]),
  responsibleUserId: z.string().nullable(),
}).transform(value => ({ ...value, biller: value.biller ?? value.provider }));

export type CreateCostEvent = z.input<typeof createCostEventSchema>;

export const updateBudgetSchema = z.object({
  budgetMonthlyCents: z.number().int().nonnegative(),
});

export type UpdateBudget = z.infer<typeof updateBudgetSchema>;
