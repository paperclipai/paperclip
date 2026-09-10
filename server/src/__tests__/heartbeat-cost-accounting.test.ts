import { describe, expect, it } from "vitest";
import {
  resolveCacheAdjustedCostUsd,
  resolveLedgerCostStatus,
  shouldRecordLedgerEvent,
} from "../services/heartbeat.js";

describe("heartbeat cost accounting", () => {
  it("marks token-bearing CLI usage without a reported cost as unpriced", () => {
    expect(resolveLedgerCostStatus({
      costUsd: null,
      inputTokens: 2_732_577,
      cachedInputTokens: 2_632_998,
      outputTokens: 32_644,
    })).toBe("unpriced");
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

  // A subscription run always bills 0 cents, so the ledger has to key off the
  // reported dollar figure. Without this, a run that burned quota and then
  // failed before reporting tokens leaves no ledger row and no owning issue,
  // and every per-issue total silently understates by that run.
  it("records a ledger event for a subscription run priced in dollars but billed at zero cents", () => {
    expect(shouldRecordLedgerEvent({
      billedCostCents: 0,
      billedCostUsd: 0.42,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    })).toBe(true);
  });

  it("records a ledger event for token usage that carries no reported cost", () => {
    expect(shouldRecordLedgerEvent({
      billedCostCents: 0,
      billedCostUsd: null,
      inputTokens: 1_200,
      cachedInputTokens: 0,
      outputTokens: 40,
    })).toBe(true);
  });

  it("records a ledger event for metered spend", () => {
    expect(shouldRecordLedgerEvent({
      billedCostCents: 125,
      billedCostUsd: 1.25,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    })).toBe(true);
  });

  // A run that reported nothing at all is still not invented into the ledger:
  // `summary.unmeteredRunCount` reports it as a known gap instead.
  it("does not record a ledger event for a run that reported neither cost nor tokens", () => {
    expect(shouldRecordLedgerEvent({
      billedCostCents: 0,
      billedCostUsd: null,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    })).toBe(false);
  });

  // Adapters such as pi-local initialize the reported cost to 0, so a run that
  // returns before collecting usage arrives here with an explicit zero rather
  // than a null. Writing an all-zero row for it would move the run out of
  // `summary.lostRunCount` and claim it was accounted for.
  it("does not record a ledger event for an explicit zero-dollar run with no usage", () => {
    expect(shouldRecordLedgerEvent({
      billedCostCents: 0,
      billedCostUsd: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    })).toBe(false);
  });

  it("does not record a ledger event for a non-finite reported cost", () => {
    expect(shouldRecordLedgerEvent({
      billedCostCents: 0,
      billedCostUsd: Number.NaN,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    })).toBe(false);
  });
});
