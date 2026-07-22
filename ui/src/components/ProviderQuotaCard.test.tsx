import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CostByProviderModel } from "@paperclipai/shared";
import { ProviderQuotaCard } from "./ProviderQuotaCard";

function row(overrides: Partial<CostByProviderModel> = {}): CostByProviderModel {
  return {
    provider: "deepseek",
    biller: "deepseek",
    billingType: "metered_api",
    model: "deepseek-v4-flash",
    costCents: 2,
    inputTokens: 100,
    cachedInputTokens: 900,
    outputTokens: 50,
    apiRunCount: 1,
    subscriptionRunCount: 0,
    subscriptionCachedInputTokens: 0,
    subscriptionInputTokens: 0,
    subscriptionOutputTokens: 0,
    ...overrides,
  };
}

function render(rows: CostByProviderModel[]) {
  return renderToStaticMarkup(
    <ProviderQuotaCard
      provider="deepseek"
      rows={rows}
      budgetMonthlyCents={0}
      totalCompanySpendCents={0}
      weekSpendCents={0}
      windowRows={[]}
      showDeficitNotch={false}
    />,
  );
}

describe("ProviderQuotaCard", () => {
  it("includes cached input in provider token totals", () => {
    const markup = render([row()]);
    expect(markup).toContain(">1.0k</span> in");
    expect(markup).toContain(">50</span> out");
  });

  it("labels legacy zero-cost unknown usage as unverified", () => {
    const markup = render([
      row({
        billingType: "unknown",
        model: "unknown",
        costCents: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 1_200_000,
        apiRunCount: 0,
      }),
    ]);
    expect(markup).toContain("includes 1.2M legacy unverified");
    expect(markup).toContain("Legacy unverified usage");
    expect(markup).toContain("excluded from priced usage");
  });

  it("does not double-count subscription tokens when calculating their share", () => {
    const markup = render([
      row({
        billingType: "subscription_included",
        costCents: 0,
        inputTokens: 100,
        cachedInputTokens: 900,
        outputTokens: 50,
        apiRunCount: 0,
        subscriptionRunCount: 1,
        subscriptionInputTokens: 100,
        subscriptionCachedInputTokens: 900,
        subscriptionOutputTokens: 50,
      }),
    ]);
    expect(markup).toContain("1.0k</span> in");
    expect(markup).toContain("100% of token usage via subscription");
  });
});
