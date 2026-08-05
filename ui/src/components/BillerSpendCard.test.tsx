// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CostByBiller, CostByProviderModel } from "@paperclipai/shared";
import { BillerSpendCard } from "./BillerSpendCard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function providerRow(overrides: Partial<CostByProviderModel>): CostByProviderModel {
  return {
    provider: "anthropic",
    biller: "anthropic",
    billingType: "subscription_included",
    model: "claude-opus-5",
    costCents: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    rateCardCents: 0,
    apiRunCount: 0,
    subscriptionRunCount: 0,
    subscriptionCachedInputTokens: 0,
    subscriptionInputTokens: 0,
    subscriptionOutputTokens: 0,
    subscriptionCacheWriteTokens: 0,
    subscriptionRateCardCents: 0,
    ...overrides,
  };
}

function billerRow(overrides: Partial<CostByBiller>): CostByBiller {
  return {
    biller: "anthropic",
    costCents: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    rateCardCents: 0,
    apiRunCount: 0,
    subscriptionRunCount: 0,
    subscriptionCachedInputTokens: 0,
    subscriptionInputTokens: 0,
    subscriptionOutputTokens: 0,
    subscriptionCacheWriteTokens: 0,
    subscriptionRateCardCents: 0,
    providerCount: 1,
    modelCount: 1,
    ...overrides,
  };
}

/**
 * Text of one breakdown section only. The card header repeats the same totals,
 * so an unscoped assertion passes even when the section itself renders $0.00 —
 * which is exactly how this bug survived its first round of tests.
 */
function section(heading: "Billing types" | "Upstream providers"): string {
  const text = container.textContent ?? "";
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const next = text.indexOf("Upstream providers", start + heading.length);
  return next < 0 ? text.slice(start) : text.slice(start, next);
}

function render(row: CostByBiller, providerRows: CostByProviderModel[]): void {
  flushSync(() =>
    root.render(
      <BillerSpendCard
        row={row}
        providerRows={providerRows}
        weekSpendCents={0}
        budgetMonthlyCents={0}
        totalCompanySpendCents={0}
      />,
    ),
  );
}

describe("BillerSpendCard subscription usage", () => {
  it("shows the rate-card equivalent for a subscription-only upstream provider", () => {
    // The exact shape from PHA-1626: real tokens, zero cash. Before the
    // breakdown aggregated subscriptionRateCardCents, this row rendered a bare
    // $0.00 and the provider looked free.
    render(
      billerRow({ subscriptionRateCardCents: 15_868, subscriptionRunCount: 40 }),
      [providerRow({ subscriptionRateCardCents: 15_868, cachedInputTokens: 800_000_000 })],
    );

    expect(section("Upstream providers")).toContain("$158.68");
    expect(section("Upstream providers")).toContain("rate card");
  });

  it("attributes the rate card to the provider that produced it", () => {
    render(
      billerRow({ subscriptionRateCardCents: 12_000, providerCount: 2, modelCount: 2 }),
      [
        providerRow({ provider: "anthropic", subscriptionRateCardCents: 10_000 }),
        providerRow({ provider: "openai", subscriptionRateCardCents: 2_000 }),
      ],
    );

    // Both providers must be individually attributable, otherwise a runaway is
    // visible in the total but not traceable to its source.
    expect(section("Upstream providers")).toContain("$100.00");
    expect(section("Upstream providers")).toContain("$20.00");
  });

  it("ranks a subscription-only provider above a cheaper metered one", () => {
    render(
      billerRow({ subscriptionRateCardCents: 15_868, costCents: 25, providerCount: 2, modelCount: 2 }),
      [
        providerRow({
          provider: "openai",
          billingType: "metered_api",
          costCents: 25,
          subscriptionRateCardCents: 0,
        }),
        providerRow({ provider: "anthropic", subscriptionRateCardCents: 15_868 }),
      ],
    );

    const text = section("Upstream providers");
    // Sorting on cash alone pinned the heaviest consumer to the bottom at $0.00,
    // which is the ranking inversion this issue exists to fix.
    expect(text).toContain("$158.68");
    expect(text.indexOf("$158.68")).toBeLessThan(text.indexOf("$0.25"));
  });

  it("labels the subscription billing-type row with its rate card rather than $0.00", () => {
    render(
      billerRow({ subscriptionRateCardCents: 3_355, subscriptionRunCount: 12 }),
      [providerRow({ subscriptionRateCardCents: 3_355 })],
    );

    expect(section("Billing types")).toContain("$33.55");
  });

  it("stays silent about rate cards for purely metered usage", () => {
    render(
      billerRow({ costCents: 4_200, apiRunCount: 9 }),
      [providerRow({ provider: "openai", billingType: "metered_api", costCents: 4_200 })],
    );

    expect(container.textContent).toContain("$42.00");
    expect(container.textContent).not.toContain("rate card");
  });
});
