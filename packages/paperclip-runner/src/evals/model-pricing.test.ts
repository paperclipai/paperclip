import { describe, expect, it } from "vitest";

import {
  estimateModelCostNanodollars,
  MODEL_PRICING_VERSION,
} from "./model-pricing.js";

describe("model pricing", () => {
  it("prices uncached, cached, and output tokens with explicit provenance", () => {
    expect(
      estimateModelCostNanodollars("gpt-5.6-sol", {
        inputTokens: 1_000,
        cachedInputTokens: 400,
        outputTokens: 100,
      }),
    ).toEqual({
      estimatedCostNanodollars: 6_200_000,
      pricingVersion: MODEL_PRICING_VERSION,
      ratesUsdPerMillionTokens: { input: 5, cachedInput: 0.5, output: 30 },
    });
  });

  it("fails closed for an unpriced model", () => {
    expect(() =>
      estimateModelCostNanodollars("unknown", {
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
      }),
    ).toThrow("model pricing unavailable");
  });
});
