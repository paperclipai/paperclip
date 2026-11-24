import { describe, expect, it } from "vitest";
import { priceAtListPrice, resolveListPriceModel } from "./model-list-prices.js";

const MTOK = 1_000_000;

describe("priceAtListPrice", () => {
  it("prices ordinary input and output at the model's list rates", () => {
    expect(priceAtListPrice("claude-opus-5-5", { inputTokens: MTOK, cachedInputTokens: 0, outputTokens: MTOK })).toBe(2400);
  });

  it("prices cache writes and cache reads separately; input includes cache writes", () => {
    expect(priceAtListPrice("claude-opus-5-5", {
      inputTokens: MTOK, cacheWriteTokens: MTOK, cachedInputTokens: MTOK, outputTokens: 0,
    })).toBe(820);
  });

  it("resolves aliases and provider prefixes", () => {
    const tokens = { inputTokens: 1234, cachedInputTokens: 56, outputTokens: 789 };
    expect(priceAtListPrice("opus", tokens)).toBe(priceAtListPrice("claude-opus-5-5", tokens));
    expect(priceAtListPrice("openai/gpt-6.1-terra", { inputTokens: MTOK, cachedInputTokens: MTOK, outputTokens: 0 })).toBeCloseTo(105, 6);
    expect(resolveListPriceModel("anthropic/claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(resolveListPriceModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(resolveListPriceModel("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
  });

  it("returns null for unknown models and impossible token counts", () => {
    expect(priceAtListPrice("mystery-model", { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 })).toBeNull();
    expect(priceAtListPrice("claude-opus-5-5", { inputTokens: 1, cacheWriteTokens: 2, cachedInputTokens: 0, outputTokens: 0 })).toBeNull();
    expect(resolveListPriceModel("")).toBeNull();
  });
});
