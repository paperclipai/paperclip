import { describe, expect, it } from "vitest";
import {
  normalizeAdapterRunUsage,
  resolveCacheAdjustedCostUsd,
  resolveLedgerCostStatus,
} from "../services/heartbeat.js";

describe("heartbeat cost accounting", () => {
  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "keeps a paused run without a valid cost receipt unpriced (%s)",
    (costUsd) => {
      expect(resolveLedgerCostStatus({
        costUsd,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      })).toBe("unpriced");
    },
  );

  it("preserves an explicitly reported zero-dollar receipt without token usage", () => {
    expect(resolveLedgerCostStatus({
      costUsd: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    })).toBe("reported");
  });

  it("marks token-bearing CLI usage without a reported cost as unpriced", () => {
    expect(resolveLedgerCostStatus({
      costUsd: null,
      inputTokens: 2_732_577,
      cachedInputTokens: 2_632_998,
      outputTokens: 32_644,
    })).toBe("unpriced");
  });

  it("distinguishes missing receipts, reported zeroes, and included subscription usage", () => {
    const noTokens = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    expect(resolveLedgerCostStatus({ ...noTokens, costUsd: null })).toBe("unpriced");
    expect(resolveLedgerCostStatus({ ...noTokens, costUsd: 0 })).toBe("reported");
    expect(resolveLedgerCostStatus({ ...noTokens, costUsd: null, billingType: "subscription_included" })).toBe("reported");
  });

  it("marks reported CLI cost as priced", () => {
    expect(resolveLedgerCostStatus({
      costUsd: 1.25,
      inputTokens: 2_090,
      cachedInputTokens: 300_000,
      outputTokens: 77_000,
    })).toBe("reported");
  });

  it("uses an explicit cache-adjusted provider cost when available", () => {
    expect(resolveCacheAdjustedCostUsd({
      costUsd: 1.25,
      cacheAdjustedCostUsd: 0.92,
    })).toBe(0.92);
  });

  it("attributes provider-reported billed cost as cache-adjusted by default", () => {
    expect(resolveCacheAdjustedCostUsd({
      costUsd: 1.25,
      cacheAdjustedCostUsd: null,
    })).toBe(1.25);
  });

  it("does not attribute invalid or unavailable costs", () => {
    expect(resolveCacheAdjustedCostUsd({
      costUsd: null,
      cacheAdjustedCostUsd: Number.NaN,
    })).toBeNull();
  });

  it("prices a run that only reports a cache-adjusted cost", () => {
    const billedCostUsd = resolveCacheAdjustedCostUsd({
      costUsd: null,
      cacheAdjustedCostUsd: 0.42,
    });
    expect(billedCostUsd).toBe(0.42);
    expect(resolveLedgerCostStatus({
      costUsd: billedCostUsd,
      inputTokens: 1_000,
      cachedInputTokens: 900_000,
      outputTokens: 5_000,
    })).toBe("reported");
  });

  it("bills the discounted amount when both nominal and cache-adjusted costs are reported", () => {
    expect(resolveCacheAdjustedCostUsd({
      costUsd: 3.1,
      cacheAdjustedCostUsd: 1.5,
    })).toBe(1.5);
  });
});


describe("adapter usage basis", () => {
  const prior = { inputTokens: 100, cachedInputTokens: 500, outputTokens: 20 };
  it.each([undefined, null, "per_run"] as const)("keeps equal consecutive run usage when the basis is %s", (basis) => {
    expect(normalizeAdapterRunUsage(prior, prior, basis)).toEqual(prior);
  });
  it("subtracts session totals only when explicitly declared", () => {
    expect(normalizeAdapterRunUsage({ inputTokens: 110, cachedInputTokens: 700, outputTokens: 25 }, prior, "session_cumulative"))
      .toEqual({ inputTokens: 10, cachedInputTokens: 200, outputTokens: 5 });
    expect(normalizeAdapterRunUsage({ inputTokens: 5, cachedInputTokens: 10, outputTokens: 2 }, prior, "session_cumulative"))
      .toEqual({ inputTokens: 5, cachedInputTokens: 10, outputTokens: 2 });
  });
});
