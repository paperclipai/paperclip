import { describe, expect, it } from "vitest";
import {
  PRICING_CATALOG_VERSION,
  catalogCostCents,
  classifyCost,
  normalizePricingIdentifier,
  resolveCatalogPrice,
} from "./pricing-catalog.js";

describe("pricing catalog", () => {
  it("normalizes provider prefixes, dated ids, and the 1m suffix", () => {
    expect(normalizePricingIdentifier("models/openai:gpt-4o[1m]")).toBe("gpt-4o");
    expect(resolveCatalogPrice("openai", "OpenAI", "gpt-4o-2024-05-13[1m]")?.catalogVersion)
      .toBe(PRICING_CATALOG_VERSION);
  });

  it("calculates catalog pricing using cached input separately", () => {
    expect(catalogCostCents({
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 1_000_000,
    })).toEqual({ costCents: 1188, pricingCatalogVersion: PRICING_CATALOG_VERSION });
  });

  it("does not guess unknown models and preserves explicit unpriced events", () => {
    expect(catalogCostCents({ provider: "unknown", model: "mystery", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 })).toBeNull();
    expect(classifyCost({ provider: "openai", model: "gpt-4o", inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, costCents: 0, billingType: "subscription_included", costStatus: "unpriced" }))
      .toMatchObject({ costStatus: "unpriced", costCents: 0 });
  });

  it("prefers a positive provider cost and leaves unknown zero-cost usage unpriced", () => {
    expect(classifyCost({
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      costCents: 777,
    })).toMatchObject({ costStatus: "reported", costCents: 777, pricingCatalogVersion: null });
    expect(classifyCost({
      provider: "unknown",
      model: "mystery",
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      costCents: 0,
    })).toMatchObject({ costStatus: "unpriced", costCents: 0, pricingCatalogVersion: null });
  });

  it("prices an event the provider did not price, and leaves a reported zero alone", () => {
    // `resolveLedgerCostStatus` writes `unpriced` only when the provider named
    // no cost while tokens were used. That is the case the catalog exists for,
    // so the writer has to price it, exactly as the historical repair does.
    expect(classifyCost({
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      costCents: 0,
      costStatus: "unpriced",
    })).toEqual({ costStatus: "reported", costCents: 1250, pricingCatalogVersion: PRICING_CATALOG_VERSION });

    // A charge below half a cent rounds to zero and keeps the status `reported`.
    // It is a number the provider named, so an estimate must not restate it.
    expect(classifyCost({
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      costCents: 0,
      costStatus: "reported",
    })).toEqual({ costStatus: "reported", costCents: 0, pricingCatalogVersion: null });
  });

  it("keeps a subscription zero whatever status is stated beside it", () => {
    for (const costStatus of ["reported", "unpriced"]) {
      expect(classifyCost({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
        costCents: 0,
        billingType: "subscription_included",
        costStatus,
      })).toMatchObject({ costCents: 0, pricingCatalogVersion: null });
    }
  });

  it("prices an Anthropic event on disjoint counts and an OpenAI event on an inclusive one", () => {
    // Anthropic reports input_tokens and cache_read_input_tokens separately, so
    // 1,000,000 uncached at 300 plus 1,000,000 cached at 30 is 330 cents.
    expect(catalogCostCents({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
    })).toEqual({ costCents: 330, pricingCatalogVersion: PRICING_CATALOG_VERSION });

    // OpenAI reports cached tokens inside input_tokens, so the same figures are
    // 500,000 uncached at 250 plus 500,000 cached at 125, which is 188 cents.
    expect(catalogCostCents({
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 0,
    })).toEqual({ costCents: 188, pricingCatalogVersion: PRICING_CATALOG_VERSION });
  });

  it("does not let a cached count drive an Anthropic event to the cached rate alone", () => {
    // A cache-heavy turn, which is the ordinary shape of a long agent run. The
    // old arithmetic subtracted the cached count from a count that never held
    // it, priced every input token at the cached rate, and reported 30 cents.
    const heavy = catalogCostCents({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      inputTokens: 200_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(heavy).toEqual({ costCents: 90, pricingCatalogVersion: PRICING_CATALOG_VERSION });
  });

  it("resolves the provider that priced the event, including through the biller", () => {
    expect(resolveCatalogPrice("unknown", "anthropic", "claude-opus-4-1")?.providerKey).toBe("anthropic");
    expect(resolveCatalogPrice("openai", null, "gpt-5")?.providerKey).toBe("openai");
  });
});
