import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOKEN_RATE_CARD,
  TOKEN_RATE_CARD_ENV_KEY,
  applyTokenRateCard,
  lookupTokenRateCardEntry,
  priceUsageWithRateCard,
} from "./token-rate-card.js";

describe("token rate card", () => {
  it("bills cached input at the same rate as input for github-copilot", () => {
    const entry = DEFAULT_TOKEN_RATE_CARD["github-copilot"]!;
    const cachedOnly = priceUsageWithRateCard(entry, {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    });
    const inputOnly = priceUsageWithRateCard(entry, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
    expect(cachedOnly).toBeCloseTo(inputOnly, 10);
    expect(cachedOnly).toBeCloseTo(9.2, 10);
  });

  it("prices a cache-heavy workload at the full credit rate, not the API rate", () => {
    // Shape of a long-running agent workload: ~99.3% of tokens are cache reads.
    // An API-shaped price table with a 10x cache-read discount prices the same
    // volume an order of magnitude lower, which is the bug this card fixes.
    const priced = applyTokenRateCard({
      biller: "github-copilot",
      model: "github-copilot/claude-opus-4.5",
      usage: {
        inputTokens: 22_000,
        cachedInputTokens: 9_930_000,
        outputTokens: 48_000,
      },
      reportedCostUsd: 7.5,
    });

    expect(priced.pricingSource).toBe("rate_card");
    expect(priced.billingType).toBe("credits");
    // 10,000,000 tokens at $0.0092 per 1,000 tokens.
    expect(priced.costUsd).toBeCloseTo(92, 6);
  });

  it("leaves billers without a rate card entry priced by the adapter", () => {
    const priced = applyTokenRateCard({
      biller: "anthropic",
      model: "claude-sonnet-4.5",
      usage: { inputTokens: 1_000, cachedInputTokens: 500_000, outputTokens: 2_000 },
      reportedCostUsd: 1.23,
      reportedBillingType: "metered_api",
    });
    expect(priced).toEqual({
      costUsd: 1.23,
      billingType: "metered_api",
      pricingSource: "adapter",
    });
  });

  it("reports no cost rather than zero when an unpriced lane reports nothing", () => {
    const priced = applyTokenRateCard({
      biller: "opencode",
      usage: { inputTokens: 10, outputTokens: 10 },
      reportedCostUsd: null,
    });
    expect(priced.costUsd).toBeNull();
    expect(priced.billingType).toBe("unknown");
  });

  it("prices a zero-token run at zero without touching the reported cost source", () => {
    const priced = applyTokenRateCard({
      biller: "github-copilot",
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      reportedCostUsd: 4.2,
    });
    expect(priced.costUsd).toBe(0);
    expect(priced.pricingSource).toBe("rate_card");
  });

  it("applies a per-model multiplier by longest matching prefix", () => {
    const env = {
      [TOKEN_RATE_CARD_ENV_KEY]: JSON.stringify({
        "github-copilot": {
          usdPerThousandTokens: 0.01,
          billingType: "credits",
          modelMultipliers: { "claude-opus": 2, "claude-opus-4.5": 3, "claude-sonnet": 0.5 },
        },
      }),
    };
    const usage = { inputTokens: 500_000, cachedInputTokens: 500_000, outputTokens: 0 };

    expect(
      applyTokenRateCard({ biller: "github-copilot", model: "github-copilot/claude-opus-4.5", usage, env })
        .costUsd,
    ).toBeCloseTo(30, 10);
    expect(
      applyTokenRateCard({ biller: "github-copilot", model: "claude-opus-4.6", usage, env }).costUsd,
    ).toBeCloseTo(20, 10);
    expect(
      applyTokenRateCard({ biller: "github-copilot", model: "claude-sonnet-4.5", usage, env }).costUsd,
    ).toBeCloseTo(5, 10);
    expect(
      applyTokenRateCard({ biller: "github-copilot", model: "gpt-5.4", usage, env }).costUsd,
    ).toBeCloseTo(10, 10);
  });

  it("drops an empty or provider-only multiplier key instead of matching every model", () => {
    const env = {
      [TOKEN_RATE_CARD_ENV_KEY]: JSON.stringify({
        "github-copilot": {
          usdPerThousandTokens: 0.01,
          billingType: "credits",
          // "", " ", and "provider/" all normalize to an empty key. Stored as
          // a multiplier, an empty prefix would match every model id.
          modelMultipliers: { "": 5, " ": 5, "provider/": 5, "claude-opus": 2 },
        },
      }),
    };
    const usage = { inputTokens: 500_000, cachedInputTokens: 500_000, outputTokens: 0 };

    // Unrelated model: no multiplier should apply (would be 50 if the empty
    // key matched).
    expect(
      applyTokenRateCard({ biller: "github-copilot", model: "gpt-5.4", usage, env }).costUsd,
    ).toBeCloseTo(10, 10);
    // The real "claude-opus" multiplier still applies normally.
    expect(
      applyTokenRateCard({ biller: "github-copilot", model: "claude-opus-4.5", usage, env }).costUsd,
    ).toBeCloseTo(20, 10);
  });

  it("lets an operator zero-price a lane that is not actually billed", () => {
    const env = {
      [TOKEN_RATE_CARD_ENV_KEY]: JSON.stringify({
        google: { usdPerThousandTokens: 0, billingType: "fixed", note: "AI Studio free tier" },
      }),
    };
    const priced = applyTokenRateCard({
      biller: "google",
      model: "google/gemini-3.7-flash",
      usage: { inputTokens: 1_000_000, cachedInputTokens: 5_000_000, outputTokens: 100_000 },
      reportedCostUsd: 0.11,
      env,
    });
    expect(priced.costUsd).toBe(0);
    expect(priced.billingType).toBe("fixed");
    expect(priced.rateCardNote).toBe("AI Studio free tier");
  });

  it("ignores malformed override JSON instead of failing the run", () => {
    for (const raw of ["not json", "[]", '{"github-copilot":{"usdPerThousandTokens":"free"}}', '{"":{}}']) {
      const entry = lookupTokenRateCardEntry("github-copilot", { [TOKEN_RATE_CARD_ENV_KEY]: raw });
      expect(entry?.usdPerThousandTokens).toBe(0.0092);
    }
  });

  it("rejects an override with an unsupported billingType instead of degrading to unknown", () => {
    const env = {
      [TOKEN_RATE_CARD_ENV_KEY]: JSON.stringify({
        "github-copilot": { usdPerThousandTokens: 0.02, billingType: "credit" },
      }),
    };
    const entry = lookupTokenRateCardEntry("github-copilot", env);
    // Falls back to the built-in entry rather than adopting the typo'd
    // override: a malformed billingType override must not silently degrade
    // the biller to "unknown" the way the CLI-reported path did before this
    // rate card existed.
    expect(entry?.usdPerThousandTokens).toBe(0.0092);
    expect(entry?.billingType).toBe("credits");
  });

  it("matches the biller case-insensitively", () => {
    expect(lookupTokenRateCardEntry("GitHub-Copilot")?.billingType).toBe("credits");
    expect(lookupTokenRateCardEntry("  ")).toBeNull();
    expect(lookupTokenRateCardEntry(null)).toBeNull();
  });
});
