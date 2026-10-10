import { describe, expect, it } from "vitest";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { priceAnthropicReceipt } from "./anthropic-pricing.js";

const receipt: AdapterUsageCheckpoint = { complete: true, usageBasis: "per_run", provider: "anthropic", biller: "anthropic",
  billingType: "metered_api", model: "claude-sonnet-5", costUsd: null, costStatus: "unpriced",
  usage: { inputTokens: 22462, cachedInputTokens: 208218, cacheWriteTokens: 22450, outputTokens: 2450 } };
describe("complete Anthropic receipt pricing", () => {
  it("prices complete counters conservatively and labels their provenance as an estimate", () => {
    const priced = priceAnthropicReceipt(receipt);
    expect(priced.costUsdExact).toBe("0.155967600");
    expect(priced.costStatus).toBe("estimated");
    expect(priced.pricingProvenance).toMatchObject({ source: "rate_card", version: "anthropic-standard-2026-10-09" });
    expect(priced.pricingProvenance?.evidence).toContain("one-hour upper rate");
    expect(priced.usage).toBe(receipt.usage);
    expect(receipt.costStatus).toBe("unpriced");
  });
  it.each([
    ["claude-haiku-4-5-20251001", "0.077983800"], ["claude-sonnet-4-6", "0.233951400"],
  ])("prices the exact %s API model while retaining the conservative cache-write assumption", (model, expected) => {
    expect(priceAnthropicReceipt({ ...receipt, model })).toMatchObject({ costUsdExact: expected, costStatus: "estimated" });
  });
  it.each([
    { complete: false }, { billingType: "unknown" }, { billingType: "subscription_included" },
    { provider: "unknown" }, { biller: "aws_bedrock" }, { model: "claude-sonnet-latest" },
    { usageBasis: "session_cumulative" }, { costUsd: 0.12 }, { costUsdExact: "0.12" }, { cacheAdjustedCostUsd: 0.12 },
    { pricingContext: { serviceTier: "priority" } }, { usageByModel: [{ model: "other", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 1 }] },
    { usage: undefined }, { usage: { inputTokens: 1, outputTokens: 1 } },
    { usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 2, cachedInputTokens: 0 } },
  ] as Partial<AdapterUsageCheckpoint>[])("preserves incomplete, incompatible or already priced receipts: %j", override => {
    const original = { ...receipt, ...override };
    expect(priceAnthropicReceipt(original)).toBe(original);
  });
});
