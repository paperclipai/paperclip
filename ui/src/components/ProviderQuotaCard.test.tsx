import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BillerSpendCard } from "./BillerSpendCard";
import { ProviderQuotaCard } from "./ProviderQuotaCard";

describe("provider cost shares", () => {
  it("shows a safe refresh failure when this provider has no subscription accounts", () => {
    const html = renderToStaticMarkup(<ProviderQuotaCard provider="openai" rows={[]} quotaAccounts={[]}
      quotaError="provider returned a sensitive raw error" quotaRequestFailed
      budgetMonthlyCents={0} totalCompanySpendCents={0} weekSpendCents={0} windowRows={[]} showDeficitNotch={false} />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Subscription quota is currently unavailable");
    expect(html).not.toContain("sensitive raw error");
  });
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
  it("renders normalized mixed-era OpenAI totals consistently across models, windows, and subscription shares", () => {
    // The report API combines one inclusive historical row and one exclusive
    // receipt-backed row into 40 ordinary + 160 cached + 20 output per group.
    const rows = (["metered_api", "subscription_included"] as const).map(billingType => ({
      provider: "openai", biller: "openai", model: `test-${billingType}`, billingType,
      costCents: 18, inputTokens: 40, cachedInputTokens: 160, outputTokens: 20,
      apiRunCount: billingType === "metered_api" ? 2 : 0,
      subscriptionRunCount: billingType === "subscription_included" ? 2 : 0,
      subscriptionInputTokens: billingType === "subscription_included" ? 40 : 0,
      subscriptionCachedInputTokens: billingType === "subscription_included" ? 160 : 0,
      subscriptionOutputTokens: billingType === "subscription_included" ? 20 : 0,
    }));
    const html = renderToStaticMarkup(<ProviderQuotaCard provider="openai" rows={rows}
      budgetMonthlyCents={0} totalCompanySpendCents={36} weekSpendCents={36} showDeficitNotch={false}
      windowRows={[{ provider: "openai", biller: "openai", window: "5h", windowHours: 5,
        costCents: 36, inputTokens: 80, cachedInputTokens: 320, outputTokens: 40 }]} />);
    expect(html).toContain('>400</span> in');
    expect(html).toContain('>40</span> out');
    expect(html.match(/220 tok/g)).toHaveLength(2);
    expect(html).toContain("440 tok");
    expect(html).toContain("50% of token usage via subscription");
    expect(html.match(/title="50% of provider tokens"/g)).toHaveLength(2);
    expect(html).toContain("$0.36");
  });
  it("hides historical spend-to-monthly-budget comparisons for providers and billers", () => {
    const common = { budgetMonthlyCents: 1000, totalCompanySpendCents: 20000, weekSpendCents: 0, showBudgetUtilization: false };
    const provider = renderToStaticMarkup(<ProviderQuotaCard {...common} provider="openai" rows={[]} windowRows={[]} showDeficitNotch={false} />);
    const biller = renderToStaticMarkup(<BillerSpendCard {...common} providerRows={[]} row={{ biller: "openai", costCents: 20000, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, apiRunCount: 0, subscriptionRunCount: 0, providerCount: 1, modelCount: 1, subscriptionInputTokens: 0, subscriptionCachedInputTokens: 0, subscriptionOutputTokens: 0 }} />);
    for (const html of [provider, biller]) {
      expect(html).not.toContain("Period spend");
      expect(html).not.toContain("of allocation");
      expect(html).not.toContain("of company budget");
    }
  });

  it("compares biller spend with the actual company cap", () => {
    const html = renderToStaticMarkup(<BillerSpendCard budgetMonthlyCents={1000} totalCompanySpendCents={800} weekSpendCents={0} providerRows={[]} row={{ biller: "openai", costCents: 200, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, apiRunCount: 0, subscriptionRunCount: 0, providerCount: 1, modelCount: 1, subscriptionInputTokens: 0, subscriptionCachedInputTokens: 0, subscriptionOutputTokens: 0 }} />);
    expect(html).toContain("20% of company budget");
    expect(html).not.toContain("80% of allocation");
  });

});
