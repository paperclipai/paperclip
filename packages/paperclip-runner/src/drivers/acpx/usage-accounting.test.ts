import { describe, expect, it } from "vitest";
import {
  persistedAcpxTurnUsage,
  acpxUsageEstimateNotice,
  qualifiedAcpxUsageBreakdown,
} from "./usage-accounting.js";

describe("qualified ACPX usage", () => {
  it("accepts Claude's four-field aggregate without inventing extra reasoning", () => {
    expect(
      qualifiedAcpxUsageBreakdown("claude", {
        inputTokens: 12,
        outputTokens: 30,
        cachedReadTokens: 40,
        cachedWriteTokens: 50,
      }),
    ).toEqual({
      inputTokens: 12,
      outputTokens: 30,
      cachedReadTokens: 40,
      cachedWriteTokens: 50,
      thoughtTokens: 0,
    });
  });

  it("does not count Codex reasoning twice and knows cache writes are inapplicable", () => {
    expect(
      qualifiedAcpxUsageBreakdown("codex", {
        inputTokens: 12,
        outputTokens: 30,
        cachedReadTokens: 40,
        thoughtTokens: 20,
      }),
    ).toEqual({
      inputTokens: 12,
      outputTokens: 30,
      cachedReadTokens: 40,
      cachedWriteTokens: 0,
      thoughtTokens: 0,
    });
  });

  it("preserves unknown billable fields and explicit invalid values", () => {
    expect(qualifiedAcpxUsageBreakdown("claude", { inputTokens: 12 })).toEqual({
      inputTokens: 12,
      thoughtTokens: 0,
    });
    expect(
      qualifiedAcpxUsageBreakdown("codex", {
        inputTokens: null,
        cachedWriteTokens: null,
      }),
    ).toEqual({ inputTokens: null, cachedWriteTokens: null, thoughtTokens: 0 });
    expect(qualifiedAcpxUsageBreakdown("codex", undefined)).toBeUndefined();
    expect(qualifiedAcpxUsageBreakdown("claude", null)).toBeNull();
  });

  it("does not double count reasoning for the exact pinned Pi model and preserves unknown profiles", () => {
    const usage = { inputTokens: 12, outputTokens: 30, thoughtTokens: 20 };
    expect(qualifiedAcpxUsageBreakdown("pi", usage)).toEqual({ ...usage, thoughtTokens: 0 });
    expect(qualifiedAcpxUsageBreakdown(null, usage)).toEqual(usage);
  });
});

describe("persisted terminal ACPX usage", () => {
  const before = { requestTokenUsage: { previous: { input_tokens: 999 } } };
  const receipt = {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 30,
    thought_tokens: 5,
    total_tokens: 60,
  };
  const after = {
    lastRequestId: "run:turn-2",
    usageCost: { amount: 0.5, currency: "USD" },
    requestTokenUsage: { ...before.requestTokenUsage, current: receipt },
  };

  it("recovers only the newly persisted prompt receipt, including prompt-response-only usage", () => {
    expect(persistedAcpxTurnUsage(before, after, "run:turn-2")).toEqual({
      type: "status",
      tag: "usage_update",
      text: "terminal prompt usage",
      cost: { amount: 0.5, currency: "USD" },
      breakdown: {
        inputTokens: 10,
        outputTokens: 20,
        cachedReadTokens: 30,
        cachedWriteTokens: undefined,
        thoughtTokens: 5,
        totalTokens: 60,
      },
    });
  });

  it("rejects old, ambiguous, or differently bound receipts", () => {
    expect(persistedAcpxTurnUsage(before, after, "run:other")).toBeNull();
    expect(persistedAcpxTurnUsage(after, after, "run:turn-2")).toBeNull();
    expect(
      persistedAcpxTurnUsage(
        before,
        {
          ...after,
          requestTokenUsage: { current: receipt, extra: receipt },
        },
        "run:turn-2",
      ),
    ).toBeNull();
    expect(
      persistedAcpxTurnUsage(undefined, undefined, "run:turn-2"),
    ).toBeNull();
  });

  it("works for the first turn without prior usage and retains missing fields", () => {
    expect(
      persistedAcpxTurnUsage(
        {},
        {
          lastRequestId: "first",
          requestTokenUsage: { current: { input_tokens: 10 } },
        },
        "first",
      ),
    ).toMatchObject({
      breakdown: {
        inputTokens: 10,
        outputTokens: undefined,
        cachedReadTokens: undefined,
      },
    });
  });
});

describe("Pi prompt accounting authority", () => {
  const after = { lastRequestId: "turn", usageCost: { amount: 999, currency: "USD" }, requestTokenUsage: {
    message: { input_tokens: 12, paperclip_pi: { provenance: "assistant_message_receipts", cost_usd: 0.123 } },
  } };
  it("preserves an exact new Pi receipt estimate without charging it as billed spend", () => {
    const usage = persistedAcpxTurnUsage({}, after, "turn", "pi")!;
    expect(usage.cost).toBeUndefined();
    expect(usage.pricingEstimateUsd).toBe(0.123);
    expect(acpxUsageEstimateNotice(usage, "turn:pricing")?.payload).toMatchObject({
      category: "pi_usage_pricing_estimate", summary: expect.stringContaining("Billing cost is unverified"),
    });
    expect(persistedAcpxTurnUsage(after, after, "turn", "pi")).toBeNull();
  });
  it("ignores foreign, missing, invalid and unproven estimates", () => {
    expect(persistedAcpxTurnUsage({}, after, "turn", "copilot")?.pricingEstimateUsd).toBeUndefined();
    for (const receipt of [{}, { provenance: "other", cost_usd: 2 },
      { provenance: "assistant_message_receipts", cost_usd: -1 },
      { provenance: "assistant_message_receipts", cost_usd: Infinity }]) {
      const usage = persistedAcpxTurnUsage({}, { ...after, requestTokenUsage: {
        message: { input_tokens: 12, paperclip_pi: receipt },
      } }, "turn", "pi")!;
      expect(usage.cost).toBeUndefined();
      expect(acpxUsageEstimateNotice(usage, "turn:pricing")).toBeNull();
    }
  });
  it("preserves compaction receipt provenance without treating estimates as billing", () => {
    const usage = persistedAcpxTurnUsage({}, { ...after, requestTokenUsage: {
      message: { input_tokens: 12, paperclip_pi: {
        provenance: "assistant_message_and_compaction_receipts", cost_usd: 0.25,
      } },
    } }, "turn", "pi")!;
    expect(usage.cost).toBeUndefined();
    expect(usage.usageProvenance).toBe("pi_assistant_message_and_compaction_receipts");
    expect(acpxUsageEstimateNotice(usage, "turn:pricing")?.payload).toMatchObject({
      details: expect.arrayContaining([{ name: "Usage source", value: "Assistant message and compaction receipts for this prompt" }]),
    });
  });
});
