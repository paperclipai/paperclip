import { describe, expect, it } from "vitest";
import {
  TOKEN_WEIGHTS,
  budgetIsEnforceable,
  budgetLabel,
  formatTokenBreakdown,
  hasTokenUsage,
  weightedTokens,
} from "./token-usage";

describe("weightedTokens", () => {
  it("weights cached reads down and output up", () => {
    expect(
      weightedTokens({
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(100);
    expect(
      weightedTokens({
        inputTokens: 0,
        cachedInputTokens: 100,
        outputTokens: 0,
      }),
    ).toBe(10);
    expect(
      weightedTokens({
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 100,
      }),
    ).toBe(500);
  });

  it("keeps cached input from dominating the figure", () => {
    // Observed shape on a real deployment: cached input is ~96% of raw volume,
    // so an unweighted sum would mostly measure context size rather than work.
    const usage = {
      inputTokens: 38_178_829,
      cachedInputTokens: 990_890_405,
      outputTokens: 8_100_626,
    };
    const raw =
      usage.inputTokens + usage.cachedInputTokens + usage.outputTokens;

    expect(raw).toBeGreaterThan(1_000_000_000);
    // 38,178,829 + 99,089,040.5 + 40,503,130 = 177,770,999.5, rounded half-up.
    expect(weightedTokens(usage)).toBe(177_771_000);
    // The weighted figure must not be dominated by the cached term the way raw is.
    expect(weightedTokens(usage)).toBeLessThan(raw / 5);
  });

  it("rounds to a whole number so tiles never render a fraction", () => {
    expect(
      Number.isInteger(
        weightedTokens({
          inputTokens: 0,
          cachedInputTokens: 5,
          outputTokens: 0,
        }),
      ),
    ).toBe(true);
  });

  it("is zero for an unused period", () => {
    expect(
      weightedTokens({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }),
    ).toBe(0);
  });

  it("matches the exported weights, so UI and enforcement cannot drift", () => {
    const usage = { inputTokens: 7, cachedInputTokens: 30, outputTokens: 2 };
    expect(weightedTokens(usage)).toBe(
      Math.round(
        usage.inputTokens * TOKEN_WEIGHTS.input +
          usage.cachedInputTokens * TOKEN_WEIGHTS.cachedInput +
          usage.outputTokens * TOKEN_WEIGHTS.output,
      ),
    );
  });
});

describe("hasTokenUsage", () => {
  it("is false only when every counter is zero", () => {
    expect(
      hasTokenUsage({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }),
    ).toBe(false);
    expect(
      hasTokenUsage({ inputTokens: 0, cachedInputTokens: 1, outputTokens: 0 }),
    ).toBe(true);
    expect(
      hasTokenUsage({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 1 }),
    ).toBe(true);
  });
});

describe("formatTokenBreakdown", () => {
  it("labels each component so the headline figure is explainable", () => {
    expect(
      formatTokenBreakdown({
        inputTokens: 38_178_829,
        cachedInputTokens: 990_890_405,
        outputTokens: 8_100_626,
      }),
    ).toBe("38.2M in · 990.9M cached · 8.1M out");
  });

  it("renders small counts without a unit suffix", () => {
    expect(
      formatTokenBreakdown({
        inputTokens: 12,
        cachedInputTokens: 0,
        outputTokens: 4,
      }),
    ).toBe("12 in · 0 cached · 4 out");
  });
});

describe("budgetLabel", () => {
  const formatCents = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  it("warns even when a budget is configured on subscription billing", () => {
    // Regression: the subscription check must precede the budget check. A
    // configured budget cannot be consumed when costCents is always 0, so
    // presenting it as active is more misleading than an absent one.
    expect(budgetLabel({ budgetCents: 250_000, subscriptionOnlyBilling: true, formatCents })).toBe(
      "Budget $2500.00 — not enforceable on subscription billing",
    );
  });

  it("warns when no budget is set on subscription billing", () => {
    expect(budgetLabel({ budgetCents: 0, subscriptionOnlyBilling: true, formatCents })).toBe(
      "Budget not enforceable on subscription billing",
    );
  });

  it("leaves metered deployments unchanged", () => {
    expect(budgetLabel({ budgetCents: 250_000, subscriptionOnlyBilling: false, formatCents })).toBe(
      "Budget $2500.00",
    );
    expect(budgetLabel({ budgetCents: 0, subscriptionOnlyBilling: false, formatCents })).toBe(
      "Unlimited budget",
    );
  });

  it("treats null and undefined budgets as unset", () => {
    expect(budgetLabel({ budgetCents: null, subscriptionOnlyBilling: false, formatCents })).toBe(
      "Unlimited budget",
    );
    expect(budgetLabel({ budgetCents: undefined, subscriptionOnlyBilling: true, formatCents })).toBe(
      "Budget not enforceable on subscription billing",
    );
  });
});

describe("budgetIsEnforceable", () => {
  it("is false on subscription billing even with a positive budget", () => {
    // Regression: utilization, the progress bar, the pace notch, and the
    // threshold colour must all gate on this rather than on the amount alone.
    // Spend is structurally 0 there, so they would read a permanent healthy 0%
    // directly beneath a "not enforceable" label.
    expect(budgetIsEnforceable({ budgetCents: 250_000, subscriptionOnlyBilling: true })).toBe(false);
  });

  it("is true only for a positive budget on metered billing", () => {
    expect(budgetIsEnforceable({ budgetCents: 250_000, subscriptionOnlyBilling: false })).toBe(true);
    expect(budgetIsEnforceable({ budgetCents: 0, subscriptionOnlyBilling: false })).toBe(false);
  });

  it("treats a missing budget as not enforceable", () => {
    expect(budgetIsEnforceable({ budgetCents: null, subscriptionOnlyBilling: false })).toBe(false);
    expect(budgetIsEnforceable({ budgetCents: undefined, subscriptionOnlyBilling: false })).toBe(false);
  });

  it("agrees with budgetLabel — no state warns yet shows an active budget", () => {
    const formatCents = (c: number) => `$${(c / 100).toFixed(2)}`;
    for (const budgetCents of [0, 250_000, null, undefined]) {
      for (const subscriptionOnlyBilling of [true, false]) {
        const label = budgetLabel({ budgetCents, subscriptionOnlyBilling, formatCents });
        if (label.includes("not enforceable")) {
          expect(budgetIsEnforceable({ budgetCents, subscriptionOnlyBilling })).toBe(false);
        }
      }
    }
  });
});

describe("enforceable budget amount passed to child cards", () => {
  // Child cards (ProviderQuotaCard, BillerSpendCard) gate their budget UI on
  // `budgetMonthlyCents > 0`. Passing the raw amount when the budget cannot be
  // enforced makes them render quota bars and a healthy green state against a
  // cap that can never be consumed. Deciding it once at the source keeps every
  // card consistent, including cards added later.
  const amountFor = (budgetCents: number | null | undefined, subscriptionOnlyBilling: boolean) =>
    budgetIsEnforceable({ budgetCents, subscriptionOnlyBilling }) ? (budgetCents ?? 0) : 0;

  it("passes 0 on subscription billing so child cards hide their budget UI", () => {
    expect(amountFor(250_000, true)).toBe(0);
  });

  it("passes the real amount on metered billing", () => {
    expect(amountFor(250_000, false)).toBe(250_000);
  });

  it("passes 0 when no budget is set, in either mode", () => {
    expect(amountFor(0, false)).toBe(0);
    expect(amountFor(null, true)).toBe(0);
    expect(amountFor(undefined, false)).toBe(0);
  });

  it("never passes a positive amount that budgetIsEnforceable rejects", () => {
    for (const budgetCents of [0, 1, 250_000, null, undefined]) {
      for (const sub of [true, false]) {
        const amount = amountFor(budgetCents, sub);
        if (amount > 0) {
          expect(budgetIsEnforceable({ budgetCents, subscriptionOnlyBilling: sub })).toBe(true);
        }
      }
    }
  });
});
