import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderQuotaCard } from "./ProviderQuotaCard";

describe("provider cost shares", () => {
  it("counts subscription tokens once and compares provider spend to the company budget", () => {
    const html = renderToStaticMarkup(<ProviderQuotaCard provider="anthropic" budgetMonthlyCents={1000} totalCompanySpendCents={500}
      weekSpendCents={0} windowRows={[]} showDeficitNotch={false} rows={[{
        provider: "anthropic", biller: "anthropic", model: "test", billingType: "subscription_overage",
        costCents: 500, inputTokens: 10, cachedInputTokens: 1000, outputTokens: 20,
        apiRunCount: 0, subscriptionRunCount: 1, subscriptionInputTokens: 10, subscriptionCachedInputTokens: 1000, subscriptionOutputTokens: 20,
      }]} />);
    expect(html).toContain("100% of token usage via subscription");
    expect(html).toContain("50% of company budget");
    expect(html).not.toContain("of allocation");
  });
});
