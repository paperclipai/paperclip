export const PAID_PLAN_TIERS = ["starter", "pro", "enterprise"] as const;
export type PaidPlanTier = (typeof PAID_PLAN_TIERS)[number];

export interface PlanLimits {
  tier: PaidPlanTier;
  maxAgents: number;
  maxRunsPerMonth: number;
  maxSeats: number;
}

export const planLimits: Record<PaidPlanTier, PlanLimits> = {
  starter: { tier: "starter", maxAgents: 5, maxRunsPerMonth: 500, maxSeats: 5 },
  pro: { tier: "pro", maxAgents: 20, maxRunsPerMonth: 2000, maxSeats: 20 },
  enterprise: { tier: "enterprise", maxAgents: Infinity, maxRunsPerMonth: Infinity, maxSeats: Infinity },
};

export function getStripePriceId(tier: PaidPlanTier): string | null {
  return process.env[`STRIPE_PRICE_${tier.toUpperCase()}`] ?? null;
}

export function getStripePriceLookupKey(tier: PaidPlanTier): string {
  return `plan_${tier}`;
}
