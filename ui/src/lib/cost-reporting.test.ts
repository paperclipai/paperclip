import { describe, expect, it } from "vitest";
import { formatCents, visibleRunCostUsd, visibleRunTokenTotal } from "./utils";

describe("cost presentation", () => {
  it("keeps historical inclusive input totals and counts receipt-backed cache hits once", () => {
    expect(visibleRunTokenTotal({ provider: "openai", inputTokens: 100, cachedInputTokens: 80, outputTokens: 10 })).toBe(110);
    expect(visibleRunTokenTotal({ provider: "openai", inputTokens: 20, cachedInputTokens: 80, outputTokens: 10, accountingReceiptId: "saved-receipt" })).toBe(110);
    expect(visibleRunTokenTotal({ input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 })).toBe(110);
    expect(visibleRunTokenTotal({ input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 10, accountingReceiptId: "saved-receipt" })).toBe(110);
    expect(visibleRunTokenTotal(null)).toBe(0);
  });

  it("shows the adjusted charge and respects an explicit zero", () => {
    expect(visibleRunCostUsd({ costUsd: 3.1, cacheAdjustedCostUsd: 1.5 })).toBe(1.5);
    expect(visibleRunCostUsd({ cacheAdjustedCostUsd: 0 }, { costUsd: 5 })).toBe(0);
    expect(visibleRunCostUsd({ cacheAdjustedCostUsd: 0.004 })).toBe(0.004);
    expect(visibleRunCostUsd({ costUsd: -1 }, { costUsd: 2 })).toBe(2);
    expect(visibleRunCostUsd({ billingType: "subscription_included", costUsd: 50 })).toBe(0);
  });

  it.each(["anthropic", "google"])("includes separate legacy %s cache reads without changing legacy Codex totals", (provider) => {
    const tokens = { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10 };
    expect(visibleRunTokenTotal({ ...tokens, provider })).toBe(190);
    expect(visibleRunTokenTotal({ ...tokens, provider: "openai" })).toBe(110);
    expect(visibleRunTokenTotal({ ...tokens, provider, accountingReceiptId: "saved-receipt" })).toBe(190);
    expect(visibleRunTokenTotal({ provider, input_tokens: 100, cache_read_input_tokens: 80, output_tokens: 10 })).toBe(190);
  });

  it("formats finance amounts in their recorded currency", () => {
    expect(formatCents(123, "USD")).toBe("$1.23");
    expect(formatCents(123, "EUR")).toBe("€1.23");
    expect(formatCents(123, "123")).toBe("123 1.23");
    expect(formatCents(-123, " X ")).toBe(" X  -1.23");
  });

  it("shows exact estimated run charges in agent and issue views", () => {
    expect(visibleRunCostUsd({ costUsdExact: "0.001234", costUsd: null })).toBe(0.001234);
    expect(visibleRunCostUsd(null, { costUsdExact: "12.34" })).toBe(12.34);
    expect(visibleRunCostUsd({ costUsdExact: "0", costUsd: 4 })).toBe(0);
    expect(visibleRunCostUsd({ costUsdExact: "3", cacheAdjustedCostUsd: 2 })).toBe(2);
    expect(visibleRunCostUsd({ costUsdExact: "-1", costUsd: 2 })).toBe(2);
    expect(visibleRunCostUsd({ costUsdExact: "", costUsd: 2 })).toBe(2);
    expect(visibleRunCostUsd({ costUsdExact: "Infinity", costUsd: 2 })).toBe(2);
    expect(visibleRunCostUsd({ costUsdExact: "20", billingType: "subscription_included" })).toBe(0);
  });

  it.each(["openai", "openrouter", "opencode", "xai"])("recognizes saved OpenCode/Pi %s model layouts without changing legacy Codex", (provider) => {
    const tokens = { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10 };
    expect(visibleRunTokenTotal({ ...tokens, provider, model: `${provider}/vendor/model` })).toBe(190);
    expect(visibleRunTokenTotal({ ...tokens, provider: "openai", model: "gpt-5" })).toBe(110);
    expect(visibleRunTokenTotal({ ...tokens, provider: "openai", model: "different/model" })).toBe(110);
    expect(visibleRunTokenTotal({ ...tokens, provider: "openai", model: "openai/" })).toBe(110);
    expect(visibleRunTokenTotal({ ...tokens, provider: "unknown", model: "unknown/model" })).toBe(110);
    expect(visibleRunTokenTotal({ ...tokens, inputTokens: 20, provider: "openai", model: "gpt-5", accountingReceiptId: "saved" })).toBe(110);
  });

});
