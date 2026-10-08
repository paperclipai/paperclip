import type { AcpSessionRecord } from "acpx/runtime";
import { describe, expect, it } from "vitest";
import { createGrokUsageCapture, parseGrokPromptUsage } from "./grok-usage-receipt.js";
import { persistedAcpxTurnUsage } from "./usage-accounting.js";

// Numeric projection of the Grok 1.0.13 qualification receipt; no prompt text.
const terminal = {
  sessionUpdate: "turn_completed", prompt_id: "c3a6c31b-2e75-42bd-aa6e-54340aeb418a",
  usage: { inputTokens: 238601, outputTokens: 2668, totalTokens: 241269,
    cachedReadTokens: 151424, cacheCreationTokens: 0, reasoningTokens: 940,
    costUsdTicks: 2717140000 },
};
const state = (requestId: string, ids: string[]) => ({
  acpxRecordId: "record", acpSessionId: "session", lastRequestId: requestId,
  request_token_usage: {}, messages: ids.map(id => ({ User: { id, content: [] } })),
}) as unknown as AcpSessionRecord;
const status = (record: AcpSessionRecord) => ({ lastRequestId: record.lastRequestId,
  requestTokenUsage: record.request_token_usage, usageCost: record.cumulative_cost });

describe("Grok terminal prompt usage", () => {
  it("normalizes observed full input and reasoning without double counting", () => {
    expect(parseGrokPromptUsage(terminal)).toEqual({ promptId: terminal.prompt_id, costTicks: 2717140000,
      tokens: { input_tokens: 87177, output_tokens: 2668, total_tokens: 241269,
        cache_read_input_tokens: 151424, cache_creation_input_tokens: 0, thought_tokens: 0 } });
  });
  it.each([undefined, null, 0, -1, Infinity, Number.MAX_SAFE_INTEGER + 1])("never treats missing or invalid cost %s as free", costUsdTicks => {
    expect(parseGrokPromptUsage({ ...terminal, usage: { ...terminal.usage, costUsdTicks } })?.costTicks).toBeNull();
  });
  it("rejects incomplete usage and excludes partial cost", () => {
    expect(parseGrokPromptUsage({ ...terminal, usage: { ...terminal.usage, usageIsIncomplete: true } })).toBeNull();
    expect(parseGrokPromptUsage({ ...terminal, usage: { ...terminal.usage, costIsPartial: true } })?.costTicks).toBeNull();
    expect(parseGrokPromptUsage({ ...terminal, usage: { ...terminal.usage, usageIsIncomplete: "false" } })).toBeNull();
  });
  it.each([{ inputTokens: -1 }, { cachedReadTokens: 238602 }, { totalTokens: 1 }, { reasoningTokens: 2669 }, { outputTokens: undefined }])("rejects malformed token buckets %s", overrides => {
    expect(parseGrokPromptUsage({ ...terminal, usage: { ...terminal.usage, ...overrides } })).toBeNull();
  });
});

describe("Grok admitted receipt persistence", () => {
  const envelope = (update = terminal, sessionId = "session") => ({ method: "_x.ai/session_notification", params: { sessionId, update } });
  const prompt = { method: "session/prompt", params: { sessionId: "session" } };

  it("persists the prompt receipt once and sums costs across follow-ups", () => {
    let active = { requestId: "turn-1", sessionId: "session", signal: new AbortController().signal };
    const capture = createGrokUsageCapture(() => active);
    const before = state("previous", ["previous"]); capture.remember(before); capture.admit();
    capture.observe("outbound", prompt); capture.observe("inbound", envelope());
    const first = capture.project(state("turn-1", ["previous", "first"]), before);
    const repeated = capture.project(state("turn-1", ["previous", "first"]), first);
    expect(first.cumulative_cost).toEqual({ amount: 0.271714, currency: "USD" });
    expect(repeated).toEqual(first);
    expect(persistedAcpxTurnUsage(status(before), status(first), "turn-1", "grok")).toMatchObject({
      cost: { amount: 0.271714, currency: "USD" }, breakdown: { inputTokens: 87177,
        outputTokens: 2668, cachedReadTokens: 151424, cachedWriteTokens: 0, thoughtTokens: 0 } });
    active = { ...active, requestId: "turn-2" };
    capture.admit();
    capture.observe("outbound", prompt);
    capture.observe("inbound", envelope({ ...terminal, prompt_id: "22222222-2222-2222-2222-222222222222" }));
    const second = capture.project(state("turn-2", ["previous", "first", "second"]), first);
    expect(second.cumulative_cost).toEqual({ amount: 0.543428, currency: "USD" });
    expect(Object.keys(second.request_token_usage ?? {})).toEqual(["first", "second"]);
    expect(persistedAcpxTurnUsage(status(first), status(second), "turn-2", "grok")).not.toBeNull();
  });
  it("freezes prior message IDs before ACPX saves its prepared prompt", () => {
    const active = { requestId: "turn", sessionId: "session", signal: new AbortController().signal };
    const capture = createGrokUsageCapture(() => active);
    const before = state("previous", ["previous"]); capture.remember(before); capture.admit();
    // ACPX 0.13.1 prepareRuntimeTurnState saves User before session/prompt.
    // resolveRuntimeTurnReady then checkpoints its current request identity.
    const prepared = capture.project(state("previous", ["previous", "current"]), before);
    const ready = capture.project({ ...prepared, lastRequestId: "turn" }, prepared);
    capture.observe("outbound", prompt); capture.observe("inbound", envelope());
    const after = capture.project(ready, ready);
    expect(after.request_token_usage?.current).toEqual(parseGrokPromptUsage(terminal)?.tokens);
    expect(after.cumulative_cost).toEqual({ amount: 0.271714, currency: "USD" });
    expect(persistedAcpxTurnUsage(status(before), status(after), "turn", "grok")).toMatchObject({
      cost: { amount: 0.271714, currency: "USD" },
    });
  });
  it.each(["replay_stream", "replay_tag", "malformed_replay_tag", "request_envelope"])("does not settle current work from %s", kind => {
    const active = { requestId: "turn", sessionId: "session", signal: new AbortController().signal };
    const capture = createGrokUsageCapture(() => active);
    const before = state("previous", ["previous"]); capture.remember(before); capture.admit();
    capture.observe("outbound", prompt);
    const notification = envelope();
    capture.observe("inbound", kind === "replay_stream" ? { ...notification, method: "_x.ai/session/update" }
      : kind === "request_envelope" ? { ...notification, id: 1 }
      : { ...notification, params: { ...notification.params, _meta: { isReplay: kind === "replay_tag" ? true : "false" } } });
    const after = capture.project(state("turn", ["previous", "current"]), before);
    expect(after.request_token_usage).toEqual({});
    expect(after.cumulative_cost).toBeUndefined();
    // An ignored replay has no authority to consume or poison the live receipt.
    capture.observe("inbound", envelope());
    const live = capture.project(state("turn", ["previous", "current"]), after);
    expect(live.request_token_usage?.current).toEqual(parseGrokPromptUsage(terminal)?.tokens);
    expect(live.cumulative_cost).toEqual({ amount: 0.271714, currency: "USD" });
  });
  it.each(["no_admission", "no_prompt", "foreign_session", "cancelled", "expired", "replayed", "duplicate", "old_message"])("does not authorize %s receipts", kind => {
    const controller = new AbortController();
    let active = { requestId: "turn", sessionId: "session", signal: controller.signal };
    const capture = createGrokUsageCapture(() => active);
    const before = state("previous", ["previous"]); capture.remember(before);
    if (kind !== "no_admission") capture.admit();
    if (kind !== "no_prompt") capture.observe("outbound", prompt);
    if (kind === "cancelled") controller.abort();
    if (kind === "expired") active = { ...active, requestId: "other" };
    capture.observe("inbound", envelope(terminal, kind === "foreign_session" ? "other" : "session"));
    if (kind === "duplicate") capture.observe("inbound", envelope());
    if (kind === "replayed") { active = { ...active, requestId: "turn" }; capture.admit(); capture.observe("outbound", prompt); capture.observe("inbound", envelope()); }
    const after = capture.project(state("turn", kind === "old_message" ? ["previous"] : ["previous", "current"]), before);
    expect(after.request_token_usage).toEqual({});
    expect(after.cumulative_cost).toBeUndefined();
  });
  it("keeps complete tokens with unknown cost and never restores prior price as current cost", () => {
    const active = { requestId: "turn", sessionId: "session", signal: new AbortController().signal };
    const capture = createGrokUsageCapture(() => active);
    const before = { ...state("previous", ["previous"]), cumulative_cost: { amount: 1, currency: "USD" } };
    capture.remember(before); capture.admit(); capture.observe("outbound", prompt);
    capture.observe("inbound", envelope({ ...terminal, usage: { ...terminal.usage, costUsdTicks: 0 } }));
    const after = capture.project(state("turn", ["previous", "current"]), before);
    expect(after.request_token_usage?.current).toMatchObject({ input_tokens: 87177 });
    expect(after.cumulative_cost).toBeUndefined();
    expect(capture.project(state("turn", ["previous", "current"]), after).cumulative_cost).toBeUndefined();
  });
  it("cannot present a later priced receipt as a complete cumulative bill after unknown prior work", () => {
    const active = { requestId: "turn", sessionId: "session", signal: new AbortController().signal };
    const capture = createGrokUsageCapture(() => active);
    const before = { ...state("previous", ["previous"]), request_token_usage: { previous: { input_tokens: 1 } } };
    capture.remember(before); capture.admit(); capture.observe("outbound", prompt); capture.observe("inbound", envelope());
    const after = capture.project(state("turn", ["previous", "current"]), before);
    expect(after.request_token_usage?.current).toMatchObject({ input_tokens: 87177 });
    expect(after.cumulative_cost).toBeUndefined();
  });
});
