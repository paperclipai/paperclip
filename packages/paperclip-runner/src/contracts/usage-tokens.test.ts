import { describe, expect, it } from "vitest";
import { parseProviderTokenAccounting, readProviderTokenAccounting } from "./usage-tokens.js";
import { validatePrpEvent } from "../protocol/replay-contract.js";

const receipt = {
  schema: "paperclip.usage.tokens/v1", source: "provider_wire", biller: "anthropic", model: "claude-haiku-4-5-20251001",
  protocol: "messages", complete: true, requestCount: 2, reportedRequestCount: 2,
  tokens: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 30, cacheWriteTokens: 20 },
  pricingContext: { serviceTier: "standard", contextTier: "short" },
};
describe("direct API wire token authority", () => {
  it("retains incomplete coverage separately from token and price completeness", () => {
    expect(parseProviderTokenAccounting(receipt)).toEqual(receipt);
    expect(parseProviderTokenAccounting({ ...receipt, complete: false, requestCount: 3 })).toMatchObject({ complete: false });
    expect(parseProviderTokenAccounting({ ...receipt, biller: "openai", protocol: "responses" }).biller).toBe("openai");
    expect(Object.hasOwn(parseProviderTokenAccounting(receipt), "amountUsd")).toBe(false);
  });
  it.each([
    { schema: "paperclip.usage.tokens/v0" }, { source: "model_estimate" }, { biller: "custom" }, { protocol: "responses" },
    { model: "" }, { amountUsd: 0 }, { requestCount: 1 }, { requestCount: 3 }, { reportedRequestCount: 2.5 },
    { biller: ["openai"], protocol: "responses" }, { biller: "openai", protocol: ["responses"] },
    { pricingContext: { serviceTier: "priority", contextTier: "short" } },
    { tokens: { ...receipt.tokens, inputTokens: -1 } }, { tokens: { ...receipt.tokens, extra: 0 } },
    { tokens: { ...receipt.tokens, inputTokens: Number.MAX_SAFE_INTEGER } },
  ])("refuses unsupported or contradictory authority: %j", override => {
    expect(readProviderTokenAccounting({ ...receipt, ...override })).toBeNull();
  });
  it("returns an owned copy so a later mutation cannot change admitted counts", () => {
    const source = structuredClone(receipt), admitted = parseProviderTokenAccounting(source);
    source.tokens.inputTokens = 500;
    expect(admitted.tokens.inputTokens).toBe(12);
  });
  it("replays old PRP usage and validates the optional receipt through both delivery paths", () => {
    const event = { schema: "paperclip.prp.event.v1", sourceEventId: "runner:1", sourceSeq: 1, sourceInstanceId: "runner", sourceKind: "runner",
      runId: "run", normalizedSessionId: "session", turnId: "turn", itemId: "usage", eventType: "usage.reported", schemaVersion: 1, priority: 0,
      emittedAt: "2026-10-09T00:00:00.000Z", payload: { provider: "acpx", model: "exact-model" } };
    expect(validatePrpEvent(event).ok).toBe(true);
    for (const nested of [false, true]) {
      const deliver = (tokenAccounting: unknown, extra = {}) => nested
        ? { ...event, eventType: "item.completed", payload: { kind: "usage", usage: { tokenAccounting, ...extra } } }
        : { ...event, payload: { ...event.payload, tokenAccounting, ...extra } };
      expect(validatePrpEvent(deliver(receipt)).ok).toBe(true);
      for (const bad of [{ ...receipt, credential: "synthetic-private" }, { ...receipt, biller: "openrouter" },
        { ...receipt, protocol: "responses" }, { ...receipt, pricingContext: { serviceTier: "priority", contextTier: "short" } }]) {
        expect(validatePrpEvent(deliver(bad)).ok).toBe(false);
      }
      expect(validatePrpEvent(deliver(receipt, { billing: {} })).ok).toBe(false);
    }
  });
});
