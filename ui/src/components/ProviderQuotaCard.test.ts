import { describe, expect, it } from "vitest";
import type { CostByProviderModel } from "@paperclipai/shared";
import { aggregateProviderTotals } from "./ProviderQuotaCard";

// row factories shaped to match the byProvider SQL aggregate at
// server/src/services/costs.ts:228-258 (GROUP BY provider, biller, billing_type, model).
// each row is single-billing-type, so for subscription rows
//   inputTokens === subscriptionInputTokens and outputTokens === subscriptionOutputTokens,
// and for metered rows the subscription* fields are 0. the helper must respect that
// shape — it is what the live cost-aggregation query produces (e.g. for Test2 the
// anthropic provider returns one subscription_included row whose inputTokens equals
// subscriptionInputTokens, and the share must render 100%, not 50%).

function subscriptionRow(over: Partial<CostByProviderModel> = {}): CostByProviderModel {
  return {
    provider: "anthropic",
    biller: "anthropic",
    billingType: "subscription_included",
    model: "claude-sonnet-4.5",
    costCents: 0,
    inputTokens: 1_420_000,
    cachedInputTokens: 210_000,
    outputTokens: 385_000,
    apiRunCount: 0,
    subscriptionRunCount: 38,
    subscriptionCachedInputTokens: 210_000,
    subscriptionInputTokens: 1_420_000,
    subscriptionOutputTokens: 385_000,
    ...over,
  };
}

function meteredRow(over: Partial<CostByProviderModel> = {}): CostByProviderModel {
  return {
    provider: "anthropic",
    biller: "anthropic",
    billingType: "metered_api",
    model: "claude-opus-4.5",
    costCents: 11_240,
    inputTokens: 280_000,
    cachedInputTokens: 35_000,
    outputTokens: 92_000,
    apiRunCount: 7,
    subscriptionRunCount: 0,
    subscriptionCachedInputTokens: 0,
    subscriptionInputTokens: 0,
    subscriptionOutputTokens: 0,
    ...over,
  };
}

describe("aggregateProviderTotals → subSharePct", () => {
  it("renders 100% when all usage is via subscription", () => {
    const totals = aggregateProviderTotals([subscriptionRow()]);
    expect(totals.subSharePct).toBe(100);
    expect(totals.totalTokens).toBe(1_420_000 + 385_000);
    expect(totals.totalSubTokens).toBe(1_420_000 + 385_000);
  });

  it("renders 0% when all usage is API-billed", () => {
    const totals = aggregateProviderTotals([meteredRow()]);
    expect(totals.subSharePct).toBe(0);
    expect(totals.totalTokens).toBe(280_000 + 92_000);
    expect(totals.totalSubTokens).toBe(0);
  });

  it("renders the correct fraction in mixed cases (30% sub / 70% API)", () => {
    // sub row: 300k tokens (all subscription); api row: 700k tokens (none sub).
    const rows = [
      subscriptionRow({
        inputTokens: 200_000,
        outputTokens: 100_000,
        subscriptionInputTokens: 200_000,
        subscriptionOutputTokens: 100_000,
      }),
      meteredRow({
        inputTokens: 500_000,
        outputTokens: 200_000,
      }),
    ];
    const totals = aggregateProviderTotals(rows);
    expect(totals.totalTokens).toBe(1_000_000);
    expect(totals.totalSubTokens).toBe(300_000);
    expect(totals.subSharePct).toBeCloseTo(30, 6);
  });

  it("renders 0% (not NaN, not Infinity) when there is no usage", () => {
    expect(aggregateProviderTotals([]).subSharePct).toBe(0);
    // also covers rows-present-but-zero-tokens (e.g. empty period for a known provider)
    const empty = aggregateProviderTotals([
      meteredRow({ inputTokens: 0, outputTokens: 0, costCents: 0, apiRunCount: 0 }),
    ]);
    expect(empty.subSharePct).toBe(0);
  });
});
