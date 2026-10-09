import { describe, expect, it } from "vitest";
import { parseProviderUsageBilling, readProviderUsageBilling } from "./usage-billing.js";
import { validatePrpEvent } from "../protocol/replay-contract.js";

export const billingFixture = {
  schema: "paperclip.usage.billing/v1", source: "provider_reported", biller: "openrouter", currency: "USD",
  complete: true, requestCount: 2, reportedRequestCount: 2, amountUsd: 0.0042, amountUsdExact: "0.004200000",
} as const;

describe("versioned per-turn billing authority", () => {
  it("retains positive partial spend and explicit zero without promoting unknown price", () => {
    expect(parseProviderUsageBilling(billingFixture)).toEqual(billingFixture);
    expect(parseProviderUsageBilling({ ...billingFixture, complete: false, reportedRequestCount: 1 }).complete).toBe(false);
    expect(parseProviderUsageBilling({ ...billingFixture, amountUsd: 0, amountUsdExact: "0.000000000" }).complete).toBe(true);
    expect(readProviderUsageBilling(undefined)).toBeNull();
  });
  it.each([
    { schema: "paperclip.usage.billing/v2" }, { source: "rate_card" }, { biller: "other" }, { currency: "EUR" },
    { complete: "true" }, { requestCount: 1 }, { reportedRequestCount: 3 }, { reportedRequestCount: 1 },
    { amountUsd: -1 }, { amountUsd: Infinity }, { amountUsd: 1_000_001 }, { amountUsdExact: "0.5" },
    { amountUsdExact: "00.004200000" }, { amountUsdExact: "0.004200001" }, { unexpected: "private" },
  ])("rejects malformed or conflicting billing %j", mutation => {
    expect(() => parseProviderUsageBilling({ ...billingFixture, ...mutation })).toThrow();
  });
  it("replays existing PRP usage and validates the optional closed billing version", () => {
    const measurement = { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, activeSeconds: 0, requests: 1, providerCostUsd: 0 };
    const event = { schema: "paperclip.prp.event.v1", sourceEventId: "runner:1", sourceSeq: 1,
      sourceInstanceId: "runner", sourceKind: "runner", runId: "run", normalizedSessionId: "session",
      turnId: "turn", itemId: "usage", eventType: "usage.reported", schemaVersion: 1, priority: 0,
      emittedAt: "2026-10-08T00:00:00.000Z", payload: { provider: "acpx", model: "exact-model", cumulative: measurement, runDelta: measurement } };
    expect(validatePrpEvent(event).ok).toBe(true);
    expect(validatePrpEvent({ ...event, payload: { ...event.payload, billing: billingFixture } }).ok).toBe(true);
    expect(validatePrpEvent({ ...event, payload: { ...event.payload, billing: { ...billingFixture, credential: "private" } } }).ok).toBe(false);
    expect(validatePrpEvent({ ...event, eventType: "item.completed", payload: { kind: "usage", usage: null } }).ok).toBe(true);
    expect(validatePrpEvent({ ...event, eventType: "item.completed", payload: { kind: "usage", usage: { billing: billingFixture } } }).ok).toBe(true);
    expect(validatePrpEvent({ ...event, eventType: "item.completed", payload: { kind: "usage", usage: { billing: { ...billingFixture, credential: "private" } } } }).ok).toBe(false);
  });
});
