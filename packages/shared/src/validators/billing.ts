import { z } from "zod";
import { BILLING_PERIODS } from "../constants.js";

export const createSubscriptionSchema = z.object({
  tierId: z.string().uuid(),
  billingPeriod: z.enum(BILLING_PERIODS).default("monthly"),
});

export type CreateSubscription = z.infer<typeof createSubscriptionSchema>;

export const createCheckoutSessionSchema = z.object({
  tierId: z.string().uuid(),
  billingPeriod: z.enum(BILLING_PERIODS).default("monthly"),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

export type CreateCheckoutSession = z.infer<typeof createCheckoutSessionSchema>;

export const updateSubscriptionSchema = z.object({
  tierId: z.string().uuid(),
  billingPeriod: z.enum(BILLING_PERIODS).optional(),
});

export type UpdateSubscription = z.infer<typeof updateSubscriptionSchema>;

export const reportUsageSchema = z.object({
  metric: z.enum(["seats", "agent_runs", "storage_gb"]),
  quantity: z.number().int().nonnegative(),
});

export type ReportUsage = z.infer<typeof reportUsageSchema>;
