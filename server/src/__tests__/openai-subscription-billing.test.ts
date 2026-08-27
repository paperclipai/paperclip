import { describe, expect, it } from "vitest";

import { resolveOpenAiSubscriptionBilling } from "../services/heartbeat.ts";

const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 };

describe("resolveOpenAiSubscriptionBilling", () => {
  it("prices OpenAI subscription runs as metered API in USD", () => {
    const result = resolveOpenAiSubscriptionBilling({
      provider: "openai",
      model: "gpt-5",
      usage,
      billingType: "subscription_included",
      reportedCostUsd: null,
    });

    expect(result).toEqual({ costCents: 1125, billingType: "metered_api", biller: "openai" });
  });

  it("uses the configured fallback price when the subscription model is empty", () => {
    const result = resolveOpenAiSubscriptionBilling({
      provider: "openai",
      model: "",
      usage,
      billingType: "subscription_included",
      reportedCostUsd: null,
    });

    expect(result).toEqual({ costCents: 1750, billingType: "metered_api", biller: "openai" });
  });

  it("does not override metered API runs", () => {
    expect(
      resolveOpenAiSubscriptionBilling({
        provider: "openai",
        model: "gpt-5",
        usage,
        billingType: "metered_api",
        reportedCostUsd: 5,
      }),
    ).toBeNull();
  });

  it("does not override an adapter-reported subscription cost", () => {
    expect(
      resolveOpenAiSubscriptionBilling({
        provider: "openai",
        model: "gpt-5",
        usage,
        billingType: "subscription_overage",
        reportedCostUsd: 0.42,
      }),
    ).toBeNull();
  });

  it("leaves non-OpenAI subscription runs untouched", () => {
    expect(
      resolveOpenAiSubscriptionBilling({
        provider: "anthropic",
        model: "claude-opus-4-8",
        usage,
        billingType: "subscription_included",
        reportedCostUsd: null,
      }),
    ).toBeNull();
  });

  it("returns null when there is no usage to price", () => {
    expect(
      resolveOpenAiSubscriptionBilling({
        provider: "openai",
        model: "gpt-5",
        usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        billingType: "subscription_included",
        reportedCostUsd: null,
      }),
    ).toBeNull();
  });
});
