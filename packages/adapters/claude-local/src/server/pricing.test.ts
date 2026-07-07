import { describe, expect, it } from "vitest";
import { computeCostUsdFromUsage, lookupModelRate } from "./pricing.js";

describe("lookupModelRate", () => {
  it("matches bare first-party ids", () => {
    expect(lookupModelRate("claude-opus-4-8")).toMatchObject({ input: 5, output: 25, cacheRead: 0.5 });
    expect(lookupModelRate("claude-sonnet-5")).toMatchObject({ input: 3, output: 15 });
    expect(lookupModelRate("claude-haiku-4-5")).toMatchObject({ input: 1, output: 5 });
    expect(lookupModelRate("claude-fable-5")).toMatchObject({ input: 10, output: 50 });
  });

  it("matches platform-qualified ids (vertex @, bedrock prefix)", () => {
    expect(lookupModelRate("claude-opus-4-8@20260101")).toMatchObject({ input: 5 });
    expect(lookupModelRate("us.anthropic.claude-opus-4-8-v1")).toMatchObject({ input: 5 });
  });

  it("returns null for unknown / empty models", () => {
    expect(lookupModelRate("gpt-4o")).toBeNull();
    expect(lookupModelRate(null)).toBeNull();
    expect(lookupModelRate("")).toBeNull();
  });
});

describe("computeCostUsdFromUsage", () => {
  it("prices input, cached-read, and output tokens for opus-4-8", () => {
    // Regression for WOR-47: Vertex runs report tokens but no CLI cost.
    const cost = computeCostUsdFromUsage("claude-opus-4-8", {
      inputTokens: 72170,
      cachedInputTokens: 51206714,
      outputTokens: 687289,
    });
    expect(cost).toBeCloseTo(43.146432, 4);
  });

  it("returns null for unknown model (do not book $0)", () => {
    expect(
      computeCostUsdFromUsage("mystery-model", {
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 100,
      }),
    ).toBeNull();
  });

  it("returns null when usage is missing", () => {
    expect(computeCostUsdFromUsage("claude-opus-4-8", null)).toBeNull();
  });

  it("treats missing token fields as zero", () => {
    const cost = computeCostUsdFromUsage("claude-haiku-4-5", {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(1.0, 6);
  });
});
