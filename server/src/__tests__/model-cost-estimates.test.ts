import { describe, expect, it } from "vitest";
import { estimateModelCostCents } from "../services/model-cost-estimates.js";

describe("model cost estimates", () => {
  it("prices Luna, Terra, and Sol token usage from the shipped list rates", () => {
    expect(estimateModelCostCents({
      model: "gpt-5.6-luna",
      inputTokens: 100_000,
      cachedInputTokens: 80_000,
      outputTokens: 1_000,
    })).toBeCloseTo(0.68);
    expect(estimateModelCostCents({
      model: "gpt-5.6-terra",
      inputTokens: 100_000,
      cachedInputTokens: 80_000,
      outputTokens: 1_000,
    })).toBeCloseTo(6.8);
    expect(estimateModelCostCents({
      model: "gpt-5.6-sol",
      inputTokens: 100_000,
      cachedInputTokens: 80_000,
      outputTokens: 1_000,
    })).toBeCloseTo(17);
  });

  it("returns zero for an unknown model", () => {
    expect(estimateModelCostCents({
      model: "unknown",
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
    })).toBe(0);
  });
});
