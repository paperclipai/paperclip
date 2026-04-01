import { z } from "zod";

export const createSubscriptionPlanSchema = z.object({
  agentId: z.string().uuid().optional().nullable(),
  provider: z.string().min(1),
  biller: z.string().min(1),
  monthlyCostCents: z.number().int().nonnegative(),
  seatCount: z.number().int().min(1).optional().default(1),
  effectiveFrom: z.string().datetime().optional(),
  effectiveUntil: z.string().datetime().optional().nullable(),
});

export type CreateSubscriptionPlan = z.infer<typeof createSubscriptionPlanSchema>;

export const updateSubscriptionPlanSchema = z.object({
  monthlyCostCents: z.number().int().nonnegative().optional(),
  seatCount: z.number().int().min(1).optional(),
  effectiveUntil: z.string().datetime().optional().nullable(),
  isActive: z.boolean().optional(),
});

export type UpdateSubscriptionPlan = z.infer<typeof updateSubscriptionPlanSchema>;
