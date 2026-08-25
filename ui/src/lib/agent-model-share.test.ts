import { describe, expect, it } from "vitest";
import { agentModelShare, agentShareBasis } from "./agent-model-share";

const cashRow = { billingType: "metered_api" as const, costCents: 300, rateCardCents: 300 };
const subRow = { billingType: "subscription_included" as const, costCents: 0, rateCardCents: 700 };

describe("agentModelShare", () => {
  it("shows cash and no rate-card tag for a metered row", () => {
    const share = agentModelShare(cashRow, 1000);
    expect(share.isSubscription).toBe(false);
    expect(share.rateCardTagCents).toBe(0);
    expect(share.sharePct).toBe(30);
  });

  it("shows the rate-card equivalent for a subscription row", () => {
    const share = agentModelShare(subRow, 1000);
    expect(share.isSubscription).toBe(true);
    expect(share.rateCardTagCents).toBe(700);
    expect(share.sharePct).toBe(70);
  });

  it("treats subscription_overage as subscription too", () => {
    const share = agentModelShare(
      { billingType: "subscription_overage", costCents: 0, rateCardCents: 500 },
      500,
    );
    expect(share.isSubscription).toBe(true);
    expect(share.sharePct).toBe(100);
  });

  // An overage row meters real cash on top of its rate-card value, and both
  // feed the agent's shared basis (costCents sums every row, subscriptionRateCardCents
  // sums subscription rows). The numerator has to include both too, or the
  // row's share undercounts and a mixed agent's shares stop summing to 100%.
  it("folds overage cash into the row's share, not just its rate card", () => {
    const overageRow = { billingType: "subscription_overage" as const, costCents: 200, rateCardCents: 300 };
    const agent = { costCents: 200, subscriptionRateCardCents: 300 };
    const basis = agentShareBasis(agent);
    expect(basis).toBe(500);

    const share = agentModelShare(overageRow, basis);
    expect(share.sharePct).toBe(100);
  });

  // The regression this file exists for. An agent with both kinds of row used to
  // decide cash-vs-rate-card from its own aggregate: because the aggregate was
  // positive, every subscription row rendered "$0.00 (0%)" with no tag, so the
  // subscription half of a mixed agent was invisible in the one view built to show it.
  it("keeps a mixed-billing agent's subscription rows visible", () => {
    const agent = { costCents: 300, subscriptionRateCardCents: 700 };
    const basis = agentShareBasis(agent);
    expect(basis).toBe(1000);

    const cash = agentModelShare(cashRow, basis);
    const sub = agentModelShare(subRow, basis);

    expect(sub.rateCardTagCents).toBeGreaterThan(0);
    expect(sub.sharePct).toBeGreaterThan(0);
    expect(cash.sharePct + sub.sharePct).toBe(100);
  });

  it("still splits a subscription-only agent across its models", () => {
    const basis = agentShareBasis({ costCents: 0, subscriptionRateCardCents: 1000 });
    const opus = agentModelShare(
      { billingType: "subscription_included", costCents: 0, rateCardCents: 750 },
      basis,
    );
    const sonnet = agentModelShare(
      { billingType: "subscription_included", costCents: 0, rateCardCents: 250 },
      basis,
    );
    expect(opus.sharePct).toBe(75);
    expect(sonnet.sharePct).toBe(25);
  });

  it("reports 0% rather than dividing by zero on an empty agent", () => {
    expect(agentShareBasis({ costCents: 0, subscriptionRateCardCents: 0 })).toBe(0);
    expect(agentModelShare({ billingType: "unknown", costCents: 0, rateCardCents: 0 }, 0).sharePct).toBe(0);
  });
});
