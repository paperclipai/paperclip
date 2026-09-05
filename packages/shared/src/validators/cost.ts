import { z } from "zod";
import { BILLING_TYPES, COST_STATUSES, PRICING_METHODOLOGIES } from "../constants.js";

export const createCostEventSchema = z.object({
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
  inputTokens: z.number().int().nonnegative().optional().default(0),
  cachedInputTokens: z.number().int().nonnegative().optional().default(0),
  outputTokens: z.number().int().nonnegative().optional().default(0),
  cacheWriteTokens: z.number().int().nonnegative().optional().default(0),
  costCents: z.number().int().nonnegative(),
  // Nullable since 0241_pricing_methodology: a row with no measurable rate
  // records NULL. `pricing_methodology='unpriced'` is the companion signal.
  rateCardCents: z.number().int().nonnegative().nullable().optional(),
  pricingMethodology: z.enum(PRICING_METHODOLOGIES).optional(),
  occurredAt: z.string().datetime(),
}).transform((value) => ({
  ...value,
  biller: value.biller ?? value.provider,
  // `unpriced` is the only methodology that means "no rate-card figure
  // exists". Derive the default from whether one was actually supplied
  // instead of always defaulting to `measured`, so an omitted flag can never
  // claim a null rate was measured.
  pricingMethodology: value.pricingMethodology ?? (value.rateCardCents == null ? "unpriced" : "measured"),
})).superRefine((value, ctx) => {
  if (value.rateCardCents == null && value.pricingMethodology !== "unpriced") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pricingMethodology"],
      message: "rateCardCents is null; pricingMethodology must be 'unpriced'",
    });
  }
  if (value.rateCardCents != null && value.pricingMethodology === "unpriced") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pricingMethodology"],
      message: "pricingMethodology is 'unpriced'; rateCardCents must be null",
    });
  }
});

export type CreateCostEvent = z.infer<typeof createCostEventSchema>;

export const updateBudgetSchema = z.object({
  budgetMonthlyCents: z.number().int().nonnegative(),
});

export type UpdateBudget = z.infer<typeof updateBudgetSchema>;
