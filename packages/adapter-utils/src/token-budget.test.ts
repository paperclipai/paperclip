import { describe, expect, it } from "vitest";
import { CACHED_INPUT_BUDGET_WEIGHT, weightedBudgetTokens } from "./token-budget.js";

describe("weightedBudgetTokens", () => {
  it("weights cache reads at the reduced budget rate", () => {
    expect(
      weightedBudgetTokens({ inputTokens: 10_000, cachedInputTokens: 100_000, outputTokens: 500 }),
    ).toBe(10_000 + 500 + 100_000 * CACHED_INPUT_BUDGET_WEIGHT);
  });

  it("keeps fresh input, output, cache writes and thought tokens at full weight", () => {
    expect(
      weightedBudgetTokens({
        inputTokens: 1_000,
        outputTokens: 2_000,
        cachedWriteTokens: 3_000,
        thoughtTokens: 4_000,
      }),
    ).toBe(10_000);
  });

  it("does not let a 25-turn run with a ~30K resident context exhaust a 100K budget (TSMC-20840)", () => {
    // The Kestrel shape: each turn re-reads ~28K of context as cache hits.
    const observed = weightedBudgetTokens({
      inputTokens: 28_733,
      cachedInputTokens: 361_699,
      outputTokens: 4_871,
    });
    expect(observed).toBeLessThan(100_000);
  });

  it("ignores negative, missing, and non-finite parts", () => {
    expect(
      weightedBudgetTokens({
        inputTokens: -5,
        cachedInputTokens: Number.NaN,
        outputTokens: undefined,
        cachedWriteTokens: null,
      }),
    ).toBe(0);
  });

  it("floors fractional weighted totals", () => {
    expect(weightedBudgetTokens({ cachedInputTokens: 15 })).toBe(1);
  });
});
