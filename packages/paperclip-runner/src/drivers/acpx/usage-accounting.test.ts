import { describe, expect, it } from "vitest";
import {
  persistedAcpxTurnUsage,
  parseCursorPromptUsage,
  persistedCursorUsageNotice,
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


describe("partial native Cursor observations", () => {
  const receipt = () => ({ request_id: "request-1", prompt_message_id: "message-1", receipt: {
    schema: "paperclip.cursor.native-usage.v1", source: "native_turn_ended", promptId: "12345678-1234-1234-1234-123456789abc",
    completeness: "partial", reasons: ["native_counter_semantics_unverified", "child_run_attribution_unverified"],
    observations: [{ invocationId: "invocation-1", role: "parent", nativeRun: 1, sequence: 1, counters: { inputTokens: 12, outputTokens: 3 } }],
    limits: { maxObservations: 64, maxInvocations: 64, maxBytes: 16384 }, truncated: false,
  } });
  const before = { lastRequestId: "old-request", promptMessageIds: ["old-message"], requestTokenUsage: {} };
  const after = () => ({ lastRequestId: "request-1", promptMessageIds: ["old-message", "message-1"], cursorPromptUsage: receipt(), requestTokenUsage: {} });
  it("emits only a bounded unsummed partial notice, with no accounting side effects", () => {
    const current = after(), original = structuredClone(current);
    const notice = persistedCursorUsageNotice(before, current, "request-1", "cursor", "turn:cursor-native-usage");
    expect(notice).toMatchObject({ eventType: "provider.notice.recorded", payload: { category: "cursor_native_usage_observed" } });
    expect(JSON.stringify(notice)).toContain('native_counter_semantics_unverified');
    expect(JSON.stringify(notice)).not.toContain('request-1');
    expect(JSON.stringify(notice)).not.toContain('12345678');
    expect(current).toEqual(original);
    expect(persistedAcpxTurnUsage(before, current, "request-1", "cursor")).toBeNull();
  });
  it("rejects stale, replaced, foreign, missing, and duplicate message bindings", () => {
    for (const agent of [null, "codex", "copilot", "pi"] as const) expect(persistedCursorUsageNotice(before, after(), "request-1", agent, "notice")).toBeNull();
    for (const current of [
      { ...after(), lastRequestId: "wrong" },
      { ...after(), cursorPromptUsage: { ...receipt(), request_id: "wrong" } },
      { ...after(), promptMessageIds: [] },
      { ...after(), promptMessageIds: ["message-1", "message-1"] },
    ]) expect(persistedCursorUsageNotice(before, current, "request-1", "cursor", "notice")).toBeNull();
    for (const prior of [after(), { ...before, promptMessageIds: ["message-1"] }, { ...before, cursorPromptUsage: { ...receipt(), request_id: "old-request", prompt_message_id: "old-message" } }])
      expect(persistedCursorUsageNotice(prior, after(), "request-1", "cursor", "notice")).toBeNull();
  });
  it("drops malformed or excessive metadata without retaining unknown/free-text fields", () => {
    for (const value of [null, {}, { ...receipt(), extra: "secret" }, { ...receipt(), request_id: "x".repeat(241) },
      { ...receipt(), receipt: { ...receipt().receipt, extra: "secret" } },
      { ...receipt(), receipt: { ...receipt().receipt, reasons: ["secret"] } },
      { ...receipt(), receipt: { ...receipt().receipt, observations: [{ ...receipt().receipt.observations[0], counters: { inputTokens: -1 } }] } },
    ]) expect(parseCursorPromptUsage(value)).toBeNull();
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(parseCursorPromptUsage(circular)).toBeNull();
  });
  it("retains all legal observations within canonical per-detail bounds", () => {
    const value = receipt();
    value.receipt.observations = Array.from({ length: 64 }, (_, i) => ({ invocationId: `invocation-${i + 1}`, role: "parent", nativeRun: 1, sequence: 1, counters: { inputTokens: 12, outputTokens: 3 } }));
    const notice = persistedCursorUsageNotice(before, { ...after(), cursorPromptUsage: value }, "request-1", "cursor", "notice")!;
    const details = notice.payload.details as {name:string;value:string}[];
    expect(details.length).toBeLessThanOrEqual(64);
    expect(details.every(d => Buffer.byteLength(d.value) <= 4000)).toBe(true);
    expect(details.filter(d => d.name.startsWith("Native observations")).flatMap(d => JSON.parse(d.value))).toEqual(value.receipt.observations);
    const maxIds = { ...receipt(), request_id: "r".repeat(240), prompt_message_id: "m".repeat(240) };
    expect(parseCursorPromptUsage(maxIds)).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(maxIds)) - Buffer.byteLength(JSON.stringify(maxIds.receipt))).toBeLessThanOrEqual(640);
  });
});
