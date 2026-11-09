// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderQuotaCard } from "./ProviderQuotaCard";
import { BillerSpendCard } from "./BillerSpendCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const base = { provider: "openai", biller: "openai", billingType: "metered_api" as const, model: "gpt-6-astra",
  inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, apiRunCount: 1, subscriptionRunCount: 0,
  subscriptionInputTokens: 0, subscriptionCachedInputTokens: 0, subscriptionOutputTokens: 0,
  providerCount: 1, modelCount: 1 };
const cases = [
  { name: "unpriced", costCents: 0, eventCount: 2, estimatedEventCount: 0, unpricedEventCount: 2, amount: "—", estimate: null, unavailable: "2 costs unavailable" },
  { name: "mixed", costCents: 125, eventCount: 3, estimatedEventCount: 1, unpricedEventCount: 1, amount: "$1.25", estimate: "Partially estimated", unavailable: "1 cost unavailable" },
  { name: "estimated", costCents: 125, eventCount: 2, estimatedEventCount: 2, unpricedEventCount: 0, amount: "$1.25", estimate: "Estimated", unavailable: null },
  { name: "included subscription", costCents: 0, eventCount: 2, estimatedEventCount: 0, unpricedEventCount: 0, amount: "$0.00", estimate: null, unavailable: null },
  { name: "older response", costCents: 125, amount: "$1.25", estimate: null, unavailable: null },
];
describe.each(["provider", "biller"] as const)("%s price status", kind => {
  let container: HTMLDivElement, root: ReturnType<typeof createRoot>;
  beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  it.each(cases)("labels $name totals without implying missing costs are free", async example => {
    const row = { ...base, ...example };
    const props = { budgetMonthlyCents: 0, totalCompanySpendCents: row.costCents, weekSpendCents: 0 };
    await act(async () => root.render(kind === "provider"
      ? <ProviderQuotaCard {...props} provider="openai" rows={[row]} windowRows={[]} showDeficitNotch={false} />
      : <BillerSpendCard {...props} row={row} providerRows={[row]} />));
    const header = container.querySelector('[data-slot="card-header"]')!;
    expect(header.textContent).toContain(example.amount);
    if (example.amount === "—") expect(header.textContent).not.toContain("$0.00");
    const badges = [...header.querySelectorAll('[data-slot="badge"]')].map(badge => badge.textContent);
    expect(badges).toEqual([example.estimate, example.unavailable].filter(Boolean));
  });
});
