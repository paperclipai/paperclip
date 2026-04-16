import { describe, expect, it } from "vitest";
import { computeEquivalentCostCents, resolveModelPricing, calculateDriftPct } from "@paperclipai/shared";

describe("resolveModelPricing", () => {
  it("returns Opus rates for exact match", () => {
    expect(resolveModelPricing("claude-opus-4-5")).toEqual({ inputPerMtok: 15, outputPerMtok: 75 });
  });

  it("prefix-matches versioned Opus model ID", () => {
    expect(resolveModelPricing("claude-opus-4-5-20251001")).toEqual({ inputPerMtok: 15, outputPerMtok: 75 });
  });

  it("returns Haiku rates", () => {
    expect(resolveModelPricing("claude-haiku-4-5")).toEqual({ inputPerMtok: 1, outputPerMtok: 5 });
  });

  it("falls back to Opus rates for unknown model", () => {
    expect(resolveModelPricing("unknown-model-xyz")).toEqual({ inputPerMtok: 15, outputPerMtok: 75 });
  });

  it("is case-insensitive", () => {
    expect(resolveModelPricing("CLAUDE-SONNET-4-6")).toEqual({ inputPerMtok: 3, outputPerMtok: 15 });
  });
});

describe("computeEquivalentCostCents", () => {
  it("computes Opus output-only cost — 1M output @ $75/Mtok = 7500 cents", () => {
    expect(
      computeEquivalentCostCents(
        { inputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 1_000_000 },
        "claude-opus-4-5",
      ),
    ).toBe(7500);
  });

  it("computes Sonnet input+output — 1M+1M @ $3+$15/Mtok = 1800 cents", () => {
    expect(
      computeEquivalentCostCents(
        { inputTokens: 1_000_000, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 1_000_000 },
        "claude-sonnet-4-6",
      ),
    ).toBe(1800);
  });

  it("applies 10% multiplier for cache read tokens — 1M Haiku cache reads = 10 cents", () => {
    expect(
      computeEquivalentCostCents(
        { inputTokens: 0, cachedInputTokens: 1_000_000, cacheCreationInputTokens: 0, outputTokens: 0 },
        "claude-haiku-4-5",
      ),
    ).toBe(10);
  });

  it("applies 125% multiplier for cache creation tokens — 1M Haiku cache writes = 125 cents", () => {
    expect(
      computeEquivalentCostCents(
        { inputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 1_000_000, outputTokens: 0 },
        "claude-haiku-4-5",
      ),
    ).toBe(125);
  });

  it("returns 0 for all-zero usage", () => {
    expect(
      computeEquivalentCostCents(
        { inputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 },
        "claude-opus-4-5",
      ),
    ).toBe(0);
  });
});

describe("calculateDriftPct", () => {
  it("calculates drift between non-zero values — |100-120|/120 ≈ 16.67%", () => {
    expect(calculateDriftPct(100, 120)).toBeCloseTo(16.67, 1);
  });

  it("returns 0 when both are zero", () => {
    expect(calculateDriftPct(0, 0)).toBe(0);
  });

  it("returns 100 when anthropic is zero but paperclip has spend", () => {
    expect(calculateDriftPct(500, 0)).toBe(100);
  });

  it("returns 100 when paperclip is zero but anthropic has spend", () => {
    expect(calculateDriftPct(0, 100)).toBe(100);
  });
});
