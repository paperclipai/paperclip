import { describe, expect, it } from "vitest";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { isDeepSeekPeak, priceDeepSeekReceipt } from "./deepseek-pricing.js";

// 2026-10-08 is a Thursday.
const OFF_PEAK = new Date("2026-10-08T00:00:00Z"); // 00:00 UTC
const PEAK = new Date("2026-10-08T02:00:00Z"); // 02:00 UTC, weekday peak window
const WEEKEND = new Date("2026-10-10T02:00:00Z"); // Saturday

/** The projection synthesizes this descriptor for a native DeepSeek connection. */
const DEEPSEEK_ROUTE = { kind: "deepseek", protocol: "chat", auth: "bearer" };

const base: Omit<AdapterUsageCheckpoint, "provider" | "biller" | "model"> = {
  complete: true,
  usageBasis: "per_run",
  billingType: "unknown",
  costUsd: 0,
  costStatus: "reported",
  usage: { inputTokens: 10_000, cachedInputTokens: 100_000, outputTokens: 20_000 },
};

// Each harness reports its own provider/biller labels for the same connection.
const openCodeReceipt: AdapterUsageCheckpoint = {
  ...base, provider: "paperclip", biller: "paperclip", model: "paperclip/deepseek-flash",
};
const codexReceipt: AdapterUsageCheckpoint = {
  ...base, provider: "openai", biller: "unknown", model: "deepseek-flash",
};
const claudeReceipt: AdapterUsageCheckpoint = {
  ...base, provider: "anthropic", biller: "anthropic", model: "deepseek-flash[1m]",
};

describe("DeepSeek peak windows", () => {
  it("flags weekday peak windows only", () => {
    expect(isDeepSeekPeak(PEAK)).toBe(true);
    expect(isDeepSeekPeak(OFF_PEAK)).toBe(false);
    expect(isDeepSeekPeak(WEEKEND)).toBe(false);
  });
});

describe("DeepSeek receipt pricing", () => {
  it.each([
    ["OpenCode", openCodeReceipt],
    ["Codex", codexReceipt],
    ["Claude", claudeReceipt],
  ])("prices an unpriced %s receipt on the native DeepSeek route", (_harness, receipt) => {
    const priced = priceDeepSeekReceipt(receipt, OFF_PEAK, DEEPSEEK_ROUTE);
    expect(priced.costStatus).toBe("estimated");
    expect(Number(priced.costUsdExact)).toBeGreaterThan(0);
    expect(priced.pricingProvenance).toMatchObject({
      source: "rate_card",
      version: "deepseek-standard-2026-10-08",
      serviceTier: "off-peak",
    });
    expect(priced.pricingProvenance?.evidence).toContain("off-peak");
    expect(priced.usage).toBe(receipt.usage);
    // The input receipt must not be mutated.
    expect(receipt.costStatus).toBe("reported");
    expect(receipt.costUsdExact).toBeUndefined();
  });

  it("prices the projected model id back to the DeepSeek model", () => {
    expect(priceDeepSeekReceipt(codexReceipt, OFF_PEAK, DEEPSEEK_ROUTE).costStatus).toBe("estimated");
    expect(priceDeepSeekReceipt(claudeReceipt, OFF_PEAK, DEEPSEEK_ROUTE).costStatus).toBe("estimated");
  });

  it("doubles the estimate inside a peak window", () => {
    const off = priceDeepSeekReceipt(openCodeReceipt, OFF_PEAK, DEEPSEEK_ROUTE);
    const peak = priceDeepSeekReceipt(openCodeReceipt, PEAK, DEEPSEEK_ROUTE);
    expect(Number(peak.costUsdExact)).toBeCloseTo(Number(off.costUsdExact) * 2, 6);
    expect(peak.pricingProvenance?.serviceTier).toBe("peak");
  });

  it("leaves receipts on another route or no route unpriced", () => {
    const openRouterModel: AdapterUsageCheckpoint = {
      ...base, provider: "openai", biller: "openrouter", model: "openrouter/deepseek/deepseek-v4-pro",
    };
    // No managed route: a local/custom endpoint must not borrow DeepSeek prices.
    expect(priceDeepSeekReceipt(openCodeReceipt, OFF_PEAK)).toBe(openCodeReceipt);
    expect(priceDeepSeekReceipt(codexReceipt, OFF_PEAK, undefined)).toBe(codexReceipt);
    // An OpenRouter route that happens to serve DeepSeek keeps its own billing.
    expect(priceDeepSeekReceipt(openRouterModel, OFF_PEAK, { kind: "openrouter" })).toBe(openRouterModel);
    // A non-DeepSeek managed route never applies this card.
    expect(priceDeepSeekReceipt(codexReceipt, OFF_PEAK, { kind: "openai" })).toBe(codexReceipt);
  });

  it.each([
    { complete: false },
    { usage: undefined },
    { usageBasis: "session_cumulative" },
    { billingType: "subscription" },
    { billingType: "subscription_included" },
    { costUsd: 0.12 },
    { costUsdExact: "0.12" },
    { cacheAdjustedCostUsd: 0.12 },
    { model: "paperclip/deepseek-unknown" },
    { model: "openrouter/deepseek/deepseek-v4-flash-0731" },
    { usage: { inputTokens: -1, cachedInputTokens: 0, outputTokens: 0 } },
  ] as Partial<AdapterUsageCheckpoint>[])(
    "preserves incomplete, incompatible or already priced receipts: %j",
    (override) => {
      const original = { ...openCodeReceipt, ...override };
      expect(priceDeepSeekReceipt(original, OFF_PEAK, DEEPSEEK_ROUTE)).toBe(original);
    },
  );
});
