import { describe, expect, it } from "vitest";
import { estimateSubscriptionCostCents } from "./model-pricing.js";

describe("estimateSubscriptionCostCents", () => {
  it("prices a known Anthropic model from input, output, and cache-read tokens", () => {
    // claude-sonnet-5: $2/MTok in, $10/MTok out, $0.20/MTok cache read.
    const cents = estimateSubscriptionCostCents({
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
    });
    // 200 (input) + 1000 (output) + 20 (cache read) = 1220 cents.
    expect(cents).toBe(1220);
  });

  it("prices a known OpenAI Codex model", () => {
    const cents = estimateSubscriptionCostCents({
      provider: "openai",
      model: "gpt-5.3-codex",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 0,
    });
    // 175 (input) + 1400 (output) = 1575 cents.
    expect(cents).toBe(1575);
  });

  it("matches a dated/versioned model id against its family entry", () => {
    const cents = estimateSubscriptionCostCents({
      provider: "anthropic",
      model: "claude-sonnet-5-20260215",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
    expect(cents).toBe(200);
  });

  it("is case-insensitive on provider and model", () => {
    const cents = estimateSubscriptionCostCents({
      provider: "Anthropic",
      model: "Claude-Sonnet-5",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
    expect(cents).toBe(200);
  });

  it("returns null instead of guessing for an unpriced model", () => {
    expect(estimateSubscriptionCostCents({
      provider: "openai",
      model: "some-future-model-nobody-has-priced-yet",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 0,
    })).toBeNull();
  });

  it("returns null for an unpriced provider", () => {
    expect(estimateSubscriptionCostCents({
      provider: "cursor",
      model: "claude-sonnet-5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 0,
    })).toBeNull();
  });

  it("returns null when provider or model is missing", () => {
    expect(estimateSubscriptionCostCents({
      provider: null,
      model: "claude-sonnet-5",
      inputTokens: 100,
      outputTokens: 100,
      cachedInputTokens: 0,
    })).toBeNull();
    expect(estimateSubscriptionCostCents({
      provider: "anthropic",
      model: undefined,
      inputTokens: 100,
      outputTokens: 100,
      cachedInputTokens: 0,
    })).toBeNull();
  });

  it("rounds to the nearest cent and never goes negative", () => {
    const cents = estimateSubscriptionCostCents({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 1_234,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
    // 1234 tokens * $1/MTok = $0.001234 -> 0.1234 cents -> rounds to 0.
    expect(cents).toBe(0);
  });
});
