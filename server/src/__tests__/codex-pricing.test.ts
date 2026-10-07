import { describe, expect, it } from "vitest";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { priceCodexReceipt } from "../services/codex-pricing.js";

const receipt: AdapterUsageCheckpoint = {
  provider: "openai",
  biller: "openai",
  billingType: "metered_api",
  model: "gpt-6-astra",
  complete: true,
  usageBasis: "per_run",
  costUsd: null,
  usage: {
    inputTokens: 123536,
    cachedInputTokens: 1567209,
    outputTokens: 6625,
  },
};
describe("prospective Codex pricing", () => {
  it.each([
    ["gpt-6-sol", "12.200000000"],
    ["gpt-6.1-sol", "12.100000000"],
    ["gpt-6-luna", "0.610000000"],
    ["gpt-5.6-sol", "24.400000000"],
  ])("uses the distinct published cache rate for %s", (model, expected) => {
    expect(
      priceCodexReceipt({
        ...receipt,
        model,
        usage: {
          inputTokens: 1_000_000,
          cachedInputTokens: 1_000_000,
          outputTokens: 1_000_000,
        },
      }).costUsdExact,
    ).toBe(expected);
  });
  it("prices the staging token shape without counting cached input twice", () => {
    const result = priceCodexReceipt(receipt);
    expect(result.costUsdExact).toBe("3.133819000");
    expect(result.costStatus).toBe("estimated");
    expect(result.pricingProvenance).toMatchObject({
      source: "rate_card",
      version: "openai-standard-2026-09-30",
    });
    expect(result.pricingProvenance?.evidence).toContain(
      "short per-request context assumed",
    );
    expect(receipt.costUsdExact).toBeUndefined();
  });
  it.each([
    { complete: false },
    { complete: false, usage: { inputTokens: 0, outputTokens: 0 } },
    { costUsd: 0 },
    { costUsd: 4.21 },
    { costUsdExact: "0.004" },
    { cacheAdjustedCostUsd: 0.01 },
    { provider: "other" },
    { biller: "proxy" },
    { model: "gpt-6-astra-custom" },
    { model: "unknown" },
    { model: "constructor" },
    { model: "__proto__" },
    { usageBasis: undefined },
    { usageBasis: null },
    { billingType: "unknown" },
    { billingType: "subscription_included" },
    { usageBasis: "session_cumulative" },
    { pricingContext: { serviceTier: "unsupported" } },
    { usage: undefined },
    { usage: { inputTokens: -1, outputTokens: 0 } },
    { usage: { inputTokens: 1, outputTokens: 0, cacheWriteTokens: 2 } },
  ])(
    "preserves reported costs and refuses ambiguous pricing: %j",
    (override) => {
      const input = { ...receipt, ...override } as AdapterUsageCheckpoint;
      expect(priceCodexReceipt(input)).toBe(input);
    },
  );
  it.each([
    ["standard", "short", "61.000000000"],
    ["fast", "short", "122.000000000"],
    ["flex", "short", "30.500000000"],
    ["standard", "long", "97.000000000"],
    ["batch", "long", "48.500000000"],
  ] as const)("handles %s/%s rates", (serviceTier, contextTier, expected) => {
    const result = priceCodexReceipt({
      ...receipt,
      pricingContext: { serviceTier, contextTier },
      usage: {
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheWriteTokens: 0,
      },
    });
    expect(result.costUsdExact).toBe(expected);
  });
  it("charges cache writes once as a subset of input", () => {
    expect(
      priceCodexReceipt({
        ...receipt,
        usage: {
          inputTokens: 1_000_000,
          cacheWriteTokens: 1_000_000,
          outputTokens: 0,
        },
      }).costUsdExact,
    ).toBe("12.500000000");
  });
  it("retains nanodollar precision and does not reprice frozen receipts", () => {
    const priced = priceCodexReceipt({
      ...receipt,
      model: "gpt-6-luna",
      usage: { inputTokens: 0, cachedInputTokens: 1, outputTokens: 0 },
    });
    expect(priced.costUsdExact).toBe("0.000000010");
    expect(priceCodexReceipt(priced)).toBe(priced);
  });
});
