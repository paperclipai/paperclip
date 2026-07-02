import { describe, expect, it } from "vitest";
import { estimateCursorCloudCostUsd } from "./pricing-fallback.js";

describe("estimateCursorCloudCostUsd", () => {
  it("returns positive USD for known model with tokens", () => {
    const cost = estimateCursorCloudCostUsd({
      modelId: "composer-2",
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 1_000_000,
      },
    });
    expect(cost).toBeGreaterThan(0);
  });

  it("returns null when usage is zero", () => {
    expect(
      estimateCursorCloudCostUsd({
        modelId: "composer-2",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
        },
      }),
    ).toBeNull();
  });

  it("falls back to auto pricing for unknown models", () => {
    const cost = estimateCursorCloudCostUsd({
      modelId: "unknown-model-xyz",
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 1500,
      },
    });
    expect(cost).toBeGreaterThan(0);
  });
});
