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

describe("qualified ACPX prompt cost deltas", () => {
  const receipt = { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 0, thought_tokens: 0 };
  const first = { lastRequestId: "first", usageCost: { amount: 0.21211200000000002, currency: "USD" },
    requestTokenUsage: { first: receipt }, promptMessageIds: ["first"] };
  it.each(["claude", "grok"] as const)("uses the %s fresh receipt price once and derives only the follow-up delta", agent => {
    expect(persistedAcpxTurnUsage({ promptMessageIds: [] }, first, "first", agent)?.costDelta)
      .toEqual({ amount: 0.212112, currency: "USD" });
    const second = { ...first, lastRequestId: "second", usageCost: { amount: 0.31211200000000006, currency: "USD" },
      requestTokenUsage: { first: receipt, second: receipt }, promptMessageIds: ["first", "second"] };
    expect(persistedAcpxTurnUsage(first, second, "second", agent)?.costDelta).toEqual({ amount: 0.1, currency: "USD" });
    expect(persistedAcpxTurnUsage(second, second, "second", agent)).toBeNull();
  });
  it("never reprices unknown prior work, a falling total, non-USD cost, or unqualified profiles", () => {
    expect(persistedAcpxTurnUsage({ lastRequestId: "prior", requestTokenUsage: { prior: receipt } }, first, "first", "claude")?.costDelta).toBeUndefined();
    expect(persistedAcpxTurnUsage({ promptMessageIds: ["prior"] }, first, "first", "grok")?.costDelta).toBeUndefined();
    expect(persistedAcpxTurnUsage({ usageCost: { amount: 1, currency: "USD" } }, first, "first", "grok")?.costDelta).toBeUndefined();
    expect(persistedAcpxTurnUsage({}, { ...first, usageCost: { amount: 1, currency: "EUR" } }, "first", "claude")?.costDelta).toBeUndefined();
    for (const agent of ["cursor", "copilot", "pi", "codex", null] as const) {
      expect(persistedAcpxTurnUsage({}, first, "first", agent)?.costDelta).toBeUndefined();
    }
    for (const amount of [null, undefined, -1, Infinity, Number.MAX_VALUE]) {
      expect(persistedAcpxTurnUsage({}, { ...first, usageCost: { amount, currency: "USD" } }, "first", "claude")?.costDelta).toBeUndefined();
    }
  });
});
