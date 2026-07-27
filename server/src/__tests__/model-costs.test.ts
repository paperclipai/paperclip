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

describe("fleet model rate coverage (fork)", () => {
  const tokens = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 };

  it.each([
    "clawrouter/claude-opus-5-200k",
    "clawrouter/gpt-5.6-terra",
    "clawrouter/gpt-5.6-sol",
  ])("estimates non-zero subscription cost for %s", (model) => {
    expect(
      resolveCostEventCostCents({
        costCents: 0,
        billingType: "subscription_included",
        provider: "clawrouter",
        model,
        ...tokens,
      }),
    ).toBeGreaterThan(0);
  });

  it("prices each gpt-5.6 variant at its own published tier", () => {
    // luna < terra < sol; a single shared rate over-bills the cheaper tiers.
    const cost = (model: string) =>
      resolveCostEventCostCents({
        costCents: 0,
        billingType: "subscription_included",
        provider: "clawrouter",
        model,
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
      });
    expect(cost("clawrouter/gpt-5.6-luna")).toBe(700);
    expect(cost("clawrouter/gpt-5.6-terra")).toBe(1750);
    expect(cost("clawrouter/gpt-5.6-sol")).toBe(3500);
    expect(cost("clawrouter/gpt-5.6-terra-pro")).toBe(1750);
  });

  it("prices claude-opus-5-fast above standard opus-5", () => {
    const cost = (model: string) =>
      resolveCostEventCostCents({
        costCents: 0,
        billingType: "subscription_included",
        provider: "clawrouter",
        model,
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
      });
    expect(cost("clawrouter/claude-opus-5-200k")).toBe(3000);
    expect(cost("clawrouter/claude-opus-5-fast")).toBe(6000);
  });

  it("prices uncached input for gpt-5.6 instead of netting it against cached tokens", () => {
    // clawrouter reports cached tokens separately; netting them out would zero the
    // uncached input whenever cached > input, which is the common case.
    const withInput = resolveCostEventCostCents({
      costCents: 0,
      billingType: "subscription_included",
      provider: "clawrouter",
      model: "clawrouter/gpt-5.6-terra",
      inputTokens: 200_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
    });
    const withoutInput = resolveCostEventCostCents({
      costCents: 0,
      billingType: "subscription_included",
      provider: "clawrouter",
      model: "clawrouter/gpt-5.6-terra",
      inputTokens: 0,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(withInput).toBeGreaterThan(withoutInput);
  });

  it("still records zero when the billing type is unknown", () => {
    expect(
      resolveCostEventCostCents({
        costCents: 0,
        billingType: "unknown",
        provider: "clawrouter",
        model: "clawrouter/gpt-5.6-terra",
        ...tokens,
      }),
    ).toBe(0);
  });
});
