import { describe, expect, it } from "vitest";
import { createGrokPromptUsageCollector, grokPromptUsage } from "./grok-usage.js";
import { persistedAcpxTurnUsage } from "./usage-accounting.js";

const usage = { inputTokens: 505795, outputTokens: 5763, totalTokens: 511558, cachedReadTokens: 475008,
  cacheCreationTokens: 0, reasoningTokens: 531, modelCalls: 20, costUsdTicks: 3368420000 };
const meta = { sessionId: "session-1", promptId: "prompt-1", requestId: "prompt-1", usage,
  inputTokens: 999, outputTokens: 999, totalTokens: 999 };
const request = { jsonrpc: "2.0", id: 7, method: "session/prompt", params: { sessionId: "session-1" } };
const response = { jsonrpc: "2.0", id: 7, result: { stopReason: "end_turn", _meta: meta } };

describe("Grok terminal prompt usage", () => {
  it("uses the complete prompt ledger with disjoint cache buckets and exact USD tick conversion", () => {
    expect(grokPromptUsage({ ...meta, usage: { ...usage, cacheCreationTokens: 100 } }, "session-1")).toEqual({
      promptId: "prompt-1", event: { type: "status", tag: "usage_update", text: "terminal prompt usage",
        cost: { amount: 0.336842, currency: "USD", basis: "turn" },
        breakdown: { inputTokens: 30687, outputTokens: 5763, totalTokens: 511558, cachedReadTokens: 475008,
          cachedWriteTokens: 100, thoughtTokens: 0 } },
    });
  });

  it.each([
    { usageIsIncomplete: true }, { usageIsIncomplete: "false" }, { cachedReadTokens: 505796 },
    { inputTokens: -1 }, { outputTokens: 1.5 }, { reasoningTokens: -1 }, { reasoningTokens: 1.5 }, { totalTokens: 1 },
    { modelCalls: undefined }, { inputTokens: Number.MAX_SAFE_INTEGER + 1 },
  ])("refuses incomplete or invalid token authority: %j", patch => {
    expect(grokPromptUsage({ ...meta, usage: { ...usage, ...patch } }, "session-1")).toBeNull();
  });

  it("settles a real Grok prompt whose reasoning counter exceeds its output counter", () => {
    const collector = createGrokPromptUsageCollector();
    collector.begin("runner-1", "session-1");
    collector.observe("outbound", request);
    collector.observe("inbound", { ...response, result: { _meta: { ...meta, usage: {
      inputTokens: 517350, outputTokens: 7969, totalTokens: 525319, cachedReadTokens: 458624,
      cacheCreationTokens: 0, reasoningTokens: 9859, modelCalls: 15, costUsdTicks: 4537320000,
    } } } });
    const state = { lastRequestId: "runner-1", terminalPromptUsage: collector.snapshot() };
    expect(persistedAcpxTurnUsage({}, state, "runner-1")).toEqual({
      type: "status", tag: "usage_update", text: "terminal prompt usage",
      cost: { amount: 0.453732, currency: "USD", basis: "turn" },
      breakdown: { inputTokens: 58726, outputTokens: 7969, totalTokens: 525319,
        cachedReadTokens: 458624, cachedWriteTokens: 0, thoughtTokens: 0 },
    });
  });

  it.each([{ costUsdTicks: undefined }, { costUsdTicks: -1 }, { costIsPartial: true }, { costIsPartial: "false" }])(
    "preserves complete tokens without inventing cost: %j", patch => {
      const result = grokPromptUsage({ ...meta, usage: { ...usage, ...patch } }, "session-1");
      expect(result?.event.breakdown).toMatchObject({ inputTokens: 30787, outputTokens: 5763 });
      expect(result?.event).not.toHaveProperty("cost");
    });

  it("binds only the matching prompt response, rejects replay and leaves the next turn's price independent", () => {
    const collector = createGrokPromptUsageCollector();
    collector.begin("runner-1", "session-1");
    collector.observe("inbound", response);
    expect(collector.snapshot()).toBeNull();
    collector.observe("outbound", request);
    collector.observe("inbound", { ...response, id: 6 });
    collector.observe("inbound", { ...response, method: "_x.ai/session/update" });
    expect(collector.snapshot()).toBeNull();
    collector.observe("inbound", response);
    const first = collector.snapshot();
    collector.observe("inbound", response);
    expect(collector.snapshot()).toEqual(first);
    const before = { lastRequestId: "runner-1", terminalPromptUsage: first };
    expect(persistedAcpxTurnUsage({}, before, "runner-1")?.cost).toEqual({ amount: 0.336842, currency: "USD", basis: "turn" });
    expect(persistedAcpxTurnUsage(before, before, "runner-1")).toBeNull();
    expect(persistedAcpxTurnUsage({}, before, "foreign")).toBeNull();
    collector.begin("runner-2", "session-1");
    collector.observe("inbound", response);
    expect(collector.snapshot()).toBeNull();
    collector.observe("outbound", { ...request, id: 8 });
    collector.observe("inbound", { ...response, id: 8, result: { _meta: { ...meta, promptId: "prompt-2", requestId: "prompt-2",
      usage: { ...usage, costUsdTicks: 10000000 } } } });
    const after = { lastRequestId: "runner-2", terminalPromptUsage: collector.snapshot() };
    expect(persistedAcpxTurnUsage(before, after, "runner-2")?.cost).toEqual({ amount: 0.001, currency: "USD", basis: "turn" });
  });

  it.each(["foreign-session", "conflicting-receipt", "second-prompt", "rpc-error", "reused-prompt"])("rejects %s", kind => {
    const collector = createGrokPromptUsageCollector();
    collector.begin("runner-1", "session-1");
    collector.observe("outbound", request);
    collector.observe("inbound", response);
    if (kind === "reused-prompt") { collector.begin("runner-2", "session-1"); collector.observe("outbound", request); }
    if (kind === "second-prompt") collector.observe("outbound", request);
    else collector.observe("inbound", kind === "rpc-error" ? { ...response, error: {} } : { ...response, result: { _meta: {
      ...meta, ...(kind === "foreign-session" ? { sessionId: "session-2" } : {}),
      ...(kind === "conflicting-receipt" ? { usage: { ...usage, costUsdTicks: 1 } } : {}),
    } } });
    expect(collector.snapshot()).toBeNull();
  });
});
