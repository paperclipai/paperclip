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

  it.each([
    ["openrouter/anthropic/claude-sonnet-5", 2, 0.2, 10],
    ["openrouter/qwen/qwen3.8-max-0902", 2, 0.25, 6],
    ["openrouter/google/gemini-3.8-flash", 0.75, 0.075, 3.75],
    ["openrouter/z-ai/glm-5.3", 1.4, 0.14, 4.4],
    ["openrouter/deepseek/deepseek-v4-flash-0731", 0.065, 0.016, 0.18],
    ["openrouter/openai/gpt-6-astra", 10, 1, 50],
  ])("pins the OpenRouter breadth price for %s", (model, input, cachedInput, output) => {
    expect(
      estimateModelCostNanodollars(model, {
        inputTokens: 1_000,
        cachedInputTokens: 400,
        outputTokens: 100,
      }).ratesUsdPerMillionTokens,
    ).toEqual({ input, cachedInput, output });
  });
});
