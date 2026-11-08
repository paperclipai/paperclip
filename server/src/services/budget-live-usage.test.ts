import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { describe, expect, it } from "vitest";
import { createLiveRunUsageProjection, liveRunUsageCostCents } from "./budget-live-usage.js";

const openai: AdapterUsageCheckpoint = {
  complete: false, usageBasis: "per_run", provider: "openai", biller: "openai",
  billingType: "metered_api", model: "gpt-6.1-sol", costStatus: "unpriced",
  usage: { inputTokens: 1000, cachedInputTokens: 1000, outputTokens: 1000 },
};
const anthropic: AdapterUsageCheckpoint = {
  complete: false, usageBasis: "per_run", provider: "anthropic", biller: "anthropic",
  billingType: "metered_api", model: "claude-sonnet-5", costStatus: "unpriced",
  usage: { inputTokens: 22462, cachedInputTokens: 208218, cacheWriteTokens: 22450, outputTokens: 2450 },
};

describe("live run budget pricing", () => {
  it("projects partial OpenAI token usage while preserving final-accounting uncertainty", () => {
    const receipt = Object.freeze({ ...openai, usage: Object.freeze({ ...openai.usage! }) });
    expect(liveRunUsageCostCents(receipt)).toBe("1.2100000");
    expect(receipt).toMatchObject({ complete: false, costStatus: "unpriced" });
    expect(receipt.costUsdExact).toBeUndefined();
  });

  it("projects partial Anthropic token usage using the reviewed cache-write bound", () => {
    expect(liveRunUsageCostCents(anthropic)).toBe("15.5967600");
    expect(anthropic).toMatchObject({ complete: false, costStatus: "unpriced" });
  });

  it("uses explicit provider cost before estimates even on incomplete unpriced receipts", () => {
    expect(liveRunUsageCostCents({ ...openai, costUsdExact: "0.000000001" })).toBe("0.0000001");
    expect(liveRunUsageCostCents({ ...openai, costUsd: 0 })).toBe("0.0000000");
    expect(liveRunUsageCostCents({ ...openai, costUsd: 5, cacheAdjustedCostUsd: 0.123456789 })).toBe("12.3456789");
    expect(liveRunUsageCostCents({ ...openai, model: "unsupported", costUsd: 0.05 })).toBe("5.0000000");
  });

  it("applies supported OpenAI context and processing-tier guards", () => {
    expect(liveRunUsageCostCents({ ...openai, pricingContext: { serviceTier: "priority", contextTier: "long" } }))
      .toBe("3.8400000");
    expect(liveRunUsageCostCents({ ...openai, pricingContext: { serviceTier: "unrecognized" } })).toBeNull();
  });

  it.each([
    { usageBasis: "session_cumulative" }, { usageBasis: undefined }, { provider: "unknown" }, { biller: "openrouter" },
    { billingType: "unknown" }, { model: "unsupported" }, { model: "constructor" }, { usage: undefined },
    { usage: { inputTokens: 1, cacheWriteTokens: 2, outputTokens: 1 } },
    { usageByModel: [{ model: "gpt-6.1-sol", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 1 }] },
  ] as Partial<AdapterUsageCheckpoint>[])("does not invent a price for unsupported OpenAI usage: %j", override => {
    expect(liveRunUsageCostCents({ ...openai, ...override })).toBeNull();
  });

  it.each([
    { biller: "aws_bedrock" }, { model: "claude-sonnet-latest" }, { pricingContext: { serviceTier: "priority" } },
    { usage: { inputTokens: 1, outputTokens: 1 } },
    { usage: { inputTokens: 1, cacheWriteTokens: 2, cachedInputTokens: 0, outputTokens: 1 } },
  ] as Partial<AdapterUsageCheckpoint>[])("retains Anthropic rate-card restrictions: %j", override => {
    expect(liveRunUsageCostCents({ ...anthropic, ...override })).toBeNull();
  });

  it.each(["subscription", "subscription_included"] as const)("keeps %s usage outside billed exposure", billingType => {
    expect(liveRunUsageCostCents({ ...openai, billingType, costUsd: 10 })).toBe("0");
  });

  it("does not use cumulative explicit cost as a per-run price", () => {
    expect(liveRunUsageCostCents({ ...openai, usageBasis: "session_cumulative", costUsd: 10 })).toBeNull();
  });
});

describe("live exposure across provider attempts", () => {
  it("adds a token-priced retry after an explicitly free rejected attempt", () => {
    const observe = createLiveRunUsageProjection();
    expect(observe("rejected", { ...openai, complete: true, costUsd: 0, usage: { inputTokens: 0, outputTokens: 0 } }))
      .toBe("0.0000000");
    expect(observe("retry", openai)).toBe("1.2100000");
  });

  it("prices different provider attempts separately instead of applying one model to aggregate counters", () => {
    const observe = createLiveRunUsageProjection();
    expect(observe("openai", openai)).toBe("1.2100000");
    expect(observe("anthropic", anthropic)).toBe("16.8067600");
  });

  it("preserves a known attempt price when its next partial checkpoint omits it", () => {
    const observe = createLiveRunUsageProjection();
    observe("first", { ...openai, model: "unsupported", costUsd: 0.8 });
    observe("first", { ...openai, model: "unsupported" });
    expect(observe("second", { ...openai, model: "unsupported", costUsd: 0.6 })).toBe("140.0000000");
    expect(observe("second", { ...openai, model: "unsupported", costUsd: 0.4 })).toBe("140.0000000");
  });

  it("accepts a complete attempt correction without changing other attempts", () => {
    const observe = createLiveRunUsageProjection();
    observe("first", { ...openai, costUsd: 0.8 });
    observe("second", { ...openai, costUsd: 0.6 });
    expect(observe("first", { ...openai, complete: true, costUsd: 0.5 })).toBe("110.0000000");
  });

  it("restores the durable aggregate projection after same-run recorder replacement", () => {
    const observe = createLiveRunUsageProjection({ receipt: { ...openai, costUsd: 0 }, costCents: "140" });
    expect(observe("default", { ...openai, model: "unsupported" })).toBe("140.0000000");
    expect(observe("next", { ...openai, costUsd: 0.3 })).toBe("170.0000000");
  });

  it("restores explicit unknown exposure without pricing unsafe compatibility aggregates", () => {
    const observe = createLiveRunUsageProjection({ receipt: { ...openai, costUsd: 100 }, costCents: null });
    expect(observe("default", { ...openai, model: "unsupported" })).toBeNull();
  });

  it("keeps unpriced attempts unknown while retaining known portions", () => {
    const observe = createLiveRunUsageProjection();
    expect(observe("unknown", { ...openai, usageBasis: "session_cumulative", costUsd: 100 })).toBeNull();
    expect(observe("known", { ...openai, costUsd: 0.1 })).toBe("10.0000000");
    expect(observe("subscription", { ...anthropic, billingType: "subscription_included", costUsd: 100 }))
      .toBe("10.0000000");
  });
});
