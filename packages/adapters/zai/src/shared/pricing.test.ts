import { describe, expect, it } from "vitest";
import {
  ZAI_MODEL_PRICING,
  computeZaiCostUsd,
  isCodingPlanEndpoint,
} from "./pricing.js";

describe("ZAI_MODEL_PRICING", () => {
  it("includes the default model glm-5.1 with current published rates", () => {
    expect(ZAI_MODEL_PRICING["glm-5.1"]).toEqual({
      inputPer1M: 1.4,
      outputPer1M: 4.4,
      cachedInputPer1M: 0.26,
    });
  });

  it("marks free-tier models with zero pricing across all slots", () => {
    expect(ZAI_MODEL_PRICING["glm-4.7-flash"]).toEqual({
      inputPer1M: 0,
      outputPer1M: 0,
      cachedInputPer1M: 0,
    });
    expect(ZAI_MODEL_PRICING["glm-4.5-flash"]).toEqual({
      inputPer1M: 0,
      outputPer1M: 0,
      cachedInputPer1M: 0,
    });
  });
});

describe("computeZaiCostUsd", () => {
  it("computes cost for glm-5.1 with no cached input", () => {
    // 1000 non-cached input @ $1.4/1M + 500 output @ $4.4/1M
    //   = 0.0014 + 0.0022 = 0.0036
    expect(
      computeZaiCostUsd("glm-5.1", { inputTokens: 1000, outputTokens: 500 }),
    ).toBeCloseTo(0.0036, 6);
  });

  it("splits input between cached and non-cached when cachedInputTokens is present", () => {
    // 1000 input total, 400 cached + 600 non-cached, 200 output
    //   non-cached: 600 * 1.4 / 1e6 = 0.00084
    //   cached:     400 * 0.26 / 1e6 = 0.000104
    //   output:     200 * 4.4 / 1e6 = 0.00088
    //   total = 0.001824
    const cost = computeZaiCostUsd("glm-5.1", {
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 400,
    });
    expect(cost).toBeCloseTo(0.001824, 6);
  });

  it("returns 0 for free-tier models even with token usage", () => {
    expect(
      computeZaiCostUsd("glm-4.7-flash", { inputTokens: 10_000, outputTokens: 5_000 }),
    ).toBe(0);
  });

  it("returns null for unknown model ids (safer than guessing)", () => {
    expect(
      computeZaiCostUsd("glm-9000-future", { inputTokens: 1, outputTokens: 1 }),
    ).toBeNull();
  });

  it("normalizes model id case and trims whitespace", () => {
    expect(
      computeZaiCostUsd("  GLM-5.1  ", { inputTokens: 1000, outputTokens: 500 }),
    ).toBeCloseTo(0.0036, 6);
  });

  it("clamps negative cached hints to zero non-cached input", () => {
    // If cached > input for some reason, non-cached floor is 0, not negative
    const cost = computeZaiCostUsd("glm-5.1", {
      inputTokens: 100,
      outputTokens: 0,
      cachedInputTokens: 500,
    });
    // Only cached gets charged, at the cached rate (capped at cachedInputTokens value)
    // 500 * 0.26 / 1e6 = 0.00013
    expect(cost).toBeCloseTo(0.00013, 6);
  });
});

describe("isCodingPlanEndpoint", () => {
  it("recognizes the Coding Plan URL", () => {
    expect(isCodingPlanEndpoint("https://api.z.ai/api/coding/paas/v4")).toBe(true);
    expect(isCodingPlanEndpoint("https://api.z.ai/api/coding/paas/v4/")).toBe(true);
  });

  it("rejects the general pay-as-you-go URL", () => {
    expect(isCodingPlanEndpoint("https://api.z.ai/api/paas/v4")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isCodingPlanEndpoint("https://api.z.ai/API/Coding/paas/v4")).toBe(true);
  });
});
