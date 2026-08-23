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
    // 90 * 0.02 = 1.8 -> floors to 1
    expect(weightedBudgetTokens({ cachedInputTokens: 90 })).toBe(1);
  });

  it("lets a deep, well-cached run stay under a 400K per-run budget", () => {
    // 2026-08-23 regression: a 34-turn claude verdict consumed 58 fresh input,
    // 26,109 output, 92,361 cache creation (~118K real) but re-read 2,933,027
    // from cache. At 0.1x that measured ~411K and tripped the 400K cap and
    // killed an efficient run; at 0.02x it must stay comfortably under budget.
    const observed = weightedBudgetTokens({
      inputTokens: 58,
      outputTokens: 26_109,
      cachedWriteTokens: 92_361,
      cachedInputTokens: 2_933_027,
    });
    expect(observed).toBeLessThan(400_000);
    // Cache CHURN (writes at full weight) still trips the same budget:
    const churn = weightedBudgetTokens({
      inputTokens: 50_000,
      outputTokens: 50_000,
      cachedWriteTokens: 350_000,
      cachedInputTokens: 100_000,
    });
    expect(churn).toBeGreaterThan(400_000);
  });
});
