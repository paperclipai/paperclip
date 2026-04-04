import { describe, expect, it } from "vitest";
import { estimateMeteredCostUsd, resolveBilledCost } from "./cost-estimation.js";

describe("estimateMeteredCostUsd", () => {
  it("treats cached input as a subset of total input tokens", () => {
    const estimated = estimateMeteredCostUsd({
      provider: "openai",
      biller: "openai",
      model: "gpt-5.4",
      billingType: "metered_api",
      usage: {
        inputTokens: 200_000,
        cachedInputTokens: 50_000,
        outputTokens: 1_000_000,
      },
      rawUsage: {
        inputTokens: 200_000,
        cachedInputTokens: 50_000,
        outputTokens: 1_000_000,
      },
    });

    expect(estimated).toBeCloseTo(15.3875, 6);
  });

  it("applies the long-context uplift to uncached input and output only", () => {
    const estimated = estimateMeteredCostUsd({
      provider: "openai",
      biller: "openai",
      model: "gpt-5.4",
      billingType: "metered_api",
      usage: {
        inputTokens: 100_000,
        cachedInputTokens: 20_000,
        outputTokens: 10_000,
      },
      rawUsage: {
        inputTokens: 350_000,
        cachedInputTokens: 90_000,
        outputTokens: 25_000,
      },
      previousRawUsage: {
        inputTokens: 230_000,
        cachedInputTokens: 50_000,
        outputTokens: 15_000,
      },
    });

    expect(estimated).toBeCloseTo(0.5695, 6);
  });
});

describe("resolveBilledCost", () => {
  it("prefers provider-reported cost when available", () => {
    const resolved = resolveBilledCost({
      providerCostUsd: 1.234,
      provider: "openai",
      biller: "openai",
      model: "gpt-5.4",
      billingType: "metered_api",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
    });

    expect(resolved).toEqual({
      costUsd: 1.234,
      costCents: 123,
      estimated: false,
      source: "provider_reported",
    });
  });

  it("returns an estimated metered cost when the provider does not report dollars", () => {
    const resolved = resolveBilledCost({
      providerCostUsd: null,
      provider: "openai",
      biller: "openai",
      model: "gpt-5.4",
      billingType: "metered_api",
      usage: {
        inputTokens: 1_000_000,
        cachedInputTokens: 400_000,
        outputTokens: 0,
      },
      rawUsage: {
        inputTokens: 1_000_000,
        cachedInputTokens: 400_000,
        outputTokens: 0,
      },
    });

    expect(resolved.costUsd).toBeCloseTo(2.692, 6);
    expect(resolved.costCents).toBe(269);
    expect(resolved.estimated).toBe(true);
    expect(resolved.source).toBe("openai_model_pricing");
  });
});
