import { isSubscriptionBillingType, type BillingType } from "@paperclipai/shared";

/**
 * How one model row inside an agent's breakdown should be presented.
 *
 * Subscription-included runs meter no cash, so a breakdown that reads `cost_cents`
 * alone renders them as "$0.00 (0%)" — the heaviest consumers looking like the
 * cheapest. The fix has to be decided per row rather than per agent: a single agent
 * can hold cash-billed and subscription rows side by side, and an agent-level
 * "does this agent have any cash spend" test hides the subscription half of a
 * mixed agent completely.
 */
export interface AgentModelShareInput {
  billingType: BillingType;
  /**
   * cash metered for this row. Always 0 for subscription_included; can be
   * non-zero for subscription_overage, which meters real cash on top of its
   * rate-card value once a run crosses the plan's included allowance.
   */
  costCents: number;
  /** list-price value of this row's tokens */
  rateCardCents: number;
}

export interface AgentModelShare {
  /** true when this row's spend is only visible as a rate-card equivalent */
  isSubscription: boolean;
  /** cents to render as the "+ $X rate card" tag, or 0 to render no tag */
  rateCardTagCents: number;
  /** this row's share of the agent, 0-100 */
  sharePct: number;
}

/**
 * Denominator for share-of-agent percentages.
 *
 * Cash and rate card are not interchangeable as money — one is owed, one is
 * notional — but the breakdown is answering "how much of this agent is this
 * model", and both halves of its consumption belong in that answer. Using cash
 * alone drives a mixed agent's visible shares past 100% once the subscription
 * rows start reporting a rate-card share against a cash-only basis.
 */
export function agentShareBasis(agent: { costCents: number; subscriptionRateCardCents: number }): number {
  return agent.costCents + agent.subscriptionRateCardCents;
}

export function agentModelShare(row: AgentModelShareInput, basis: number): AgentModelShare {
  const isSubscription = isSubscriptionBillingType(row.billingType);
  // The denominator (agentShareBasis) sums costCents across every row plus
  // rateCardCents across subscription rows only. A subscription_overage row
  // feeds both sums, so its numerator has to include both too — using
  // rateCardCents alone drops the metered overage cash and the row's share
  // undercounts against that basis.
  const value = isSubscription ? row.rateCardCents + row.costCents : row.costCents;
  return {
    isSubscription,
    rateCardTagCents: isSubscription ? row.rateCardCents : 0,
    sharePct: basis > 0 ? Math.round((value / basis) * 100) : 0,
  };
}
