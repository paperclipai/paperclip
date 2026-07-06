import { describe, expect, it } from "vitest";
import {
  normalizeModelCostCents,
  resolveCostEventCostCents,
  resolveModelCostCents,
} from "../services/model-costs.ts";

describe("normalizeModelCostCents", () => {
  it("keeps reported model-equivalent cost for subscription-backed usage", () => {
    expect(normalizeModelCostCents(1.74)).toBe(174);
  });

  it("rounds reported model cost to cents", () => {
    expect(normalizeModelCostCents(0.005)).toBe(1);
    expect(normalizeModelCostCents(0.004)).toBe(0);
  });

  it("ignores missing, invalid, and negative costs", () => {
    expect(normalizeModelCostCents(null)).toBe(0);
    expect(normalizeModelCostCents(undefined)).toBe(0);
    expect(normalizeModelCostCents(Number.NaN)).toBe(0);
    expect(normalizeModelCostCents(-1)).toBe(0);
  });
});

describe("resolveModelCostCents", () => {
  it("prefers reported cost from the runtime or proxy", () => {
    expect(
      resolveModelCostCents({
        costUsd: 1.74,
        billingType: "subscription_included",
        provider: "clawrouter",
        model: "clawrouter/claude-opus-4-8-200k",
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(174);
  });

  it("estimates missing ClawRouter Opus costs from underlying model pricing", () => {
    expect(
      resolveModelCostCents({
        costUsd: 0,
        billingType: "subscription_included",
        provider: "clawrouter",
        model: "clawrouter/claude-opus-4-8-200k",
        inputTokens: 454,
        cachedInputTokens: 9_093_372,
        outputTokens: 138_628,
      }),
    ).toBe(801);
  });

  it("estimates Sonnet and OpenAI-compatible models by normalized model id", () => {
    expect(
      resolveModelCostCents({
        billingType: "subscription_included",
        provider: "claude-bridge",
        model: "claude-sonnet-4-6",
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(1830);
    expect(
      resolveModelCostCents({
        billingType: "subscription_included",
        provider: "openai-codex",
        model: "openai-codex/gpt-5.5",
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(3050);
  });

  it("leaves metered or unknown zero-cost models unpriced", () => {
    expect(
      resolveModelCostCents({
        billingType: "metered_api",
        provider: "clawrouter",
        model: "clawrouter/claude-opus-4-8-200k",
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(0);
    expect(
      resolveModelCostCents({
        billingType: "subscription_included",
        provider: "local",
        model: "unknown-free-model",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(0);
  });
});

describe("resolveCostEventCostCents", () => {
  it("keeps non-zero reported cost cents", () => {
    expect(
      resolveCostEventCostCents({
        costCents: 174,
        billingType: "subscription_included",
        provider: "clawrouter",
        model: "clawrouter/claude-opus-4-8-200k",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(174);
  });

  it("fills zero subscription cost cents for known models", () => {
    expect(
      resolveCostEventCostCents({
        costCents: 0,
        billingType: "subscription_included",
        provider: "clawrouter",
        model: "clawrouter/claude-opus-4-8-200k",
        inputTokens: 454,
        cachedInputTokens: 9_093_372,
        outputTokens: 138_628,
      }),
    ).toBe(801);
  });
});
