import { describe, expect, it } from "vitest";
import {
  effectiveCostCents,
  imputeCostCents,
  resolveModelPricing,
} from "./model-pricing.js";

describe("model-pricing", () => {
  it("imputes non-zero cents for subscription token usage", () => {
    // 1M uncached input on opus = $15.00 = 1500 cents.
    expect(
      imputeCostCents({ model: "claude-opus-4-8", inputTokens: 1_000_000 }),
    ).toBe(1500);
  });

  it("prices cached input far below uncached input", () => {
    const uncached = imputeCostCents({ model: "claude-sonnet-4", inputTokens: 1_000_000 });
    const cached = imputeCostCents({ model: "claude-sonnet-4", cachedInputTokens: 1_000_000 });
    expect(uncached).toBe(300);
    expect(cached).toBe(30);
    expect(cached).toBeLessThan(uncached);
  });

  it("distinguishes model families and falls back for unknown models", () => {
    expect(resolveModelPricing("claude-3-5-haiku-20241022").outputPer1M).toBe(400);
    expect(resolveModelPricing("claude-opus-4-8").outputPer1M).toBe(7500);
    expect(resolveModelPricing("some-unknown-model").inputPer1M).toBe(300);
  });

  it("effectiveCostCents prefers a real billed cost and imputes only when zero", () => {
    // Metered run with a real billed cost is returned as-is.
    expect(
      effectiveCostCents({ costCents: 250, model: "claude-opus-4-8", inputTokens: 1_000_000 }),
    ).toBe(250);
    // Subscription run (costCents=0) falls back to imputed token cost.
    expect(
      effectiveCostCents({ costCents: 0, model: "claude-opus-4-8", outputTokens: 1_000_000 }),
    ).toBe(7500);
  });

  it("sums all three token classes and rounds to whole cents", () => {
    // opus: 500k input (750) + 2M cached (300) + 100k output (750) = 1800 cents.
    expect(
      imputeCostCents({
        model: "claude-opus-4-8",
        inputTokens: 500_000,
        cachedInputTokens: 2_000_000,
        outputTokens: 100_000,
      }),
    ).toBe(1800);
  });

  it("returns zero for no usage", () => {
    expect(imputeCostCents({ model: "claude-opus-4-8" })).toBe(0);
  });
});
