import { describe, expect, it } from "vitest";
import { isAgyUnknownSessionError, parseAgyStreamJson, shouldRetryFreshConversation } from "./parse.js";

const CONV = "709d5579-1f73-490d-a519-43174cf043a5";

const line = (value: unknown) => JSON.stringify(value);

const sample = [
  line({ event: "init", conversation_id: CONV, init: { model: "gemini-3.8-flash-low", cwd: "C:\\x", tools: [], permission_mode: "always-proceed" } }),
  line({ event: "step_update", step_update: { conversation_id: CONV, step_index: 0, state: "DONE", step_type: "user_input" } }),
  line({ event: "step_update", step_update: { conversation_id: CONV, step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "read_file", tool_info: { name: "read_file", parameters: { Path: "a.txt" } } } }),
  line({ event: "step_update", step_update: { conversation_id: CONV, step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: "hel" } }),
  line({ event: "step_update", step_update: { conversation_id: CONV, step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: "lo" } }),
  line({
    event: "result",
    result: {
      conversation_id: CONV,
      status: "SUCCESS",
      response: "hello\n",
      duration_seconds: 7,
      num_turns: 1,
      usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 5, cache_read_tokens: 40, total_tokens: 115 },
    },
  }),
].join("\n");

describe("parseAgyStreamJson", () => {
  it("extracts conversation id, model, summary, and usage", () => {
    const parsed = parseAgyStreamJson(sample);
    expect(parsed.conversationId).toBe(CONV);
    expect(parsed.model).toBe("gemini-3.8-flash-low");
    expect(parsed.summary).toBe("hello");
    expect(parsed.status).toBe("SUCCESS");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.usage).toEqual({ inputTokens: 100, outputTokens: 15, cachedInputTokens: 40 });
  });

  it("falls back to streamed text when no result event arrives", () => {
    const partial = sample.split("\n").slice(0, -1).join("\n");
    const parsed = parseAgyStreamJson(partial);
    expect(parsed.summary).toBe("hello");
    expect(parsed.status).toBeNull();
  });

  it("reports a failed result as an error", () => {
    const failed = line({ event: "result", result: { conversation_id: CONV, status: "ERROR", error: "quota exceeded" } });
    const parsed = parseAgyStreamJson(failed);
    expect(parsed.status).toBe("ERROR");
    expect(parsed.errorMessage).toBe("quota exceeded");
  });

  it("ignores non-JSON lines", () => {
    const parsed = parseAgyStreamJson(`warning: something\n${sample}`);
    expect(parsed.conversationId).toBe(CONV);
  });
});

describe("isAgyUnknownSessionError", () => {
  it("detects the not-found warning", () => {
    expect(isAgyUnknownSessionError("", 'warning: conversation "abc" not found')).toBe(true);
  });
  it("does not flag unrelated stderr", () => {
    expect(isAgyUnknownSessionError("", "network down")).toBe(false);
  });
});

describe("shouldRetryFreshConversation", () => {
  const missing = 'warning: conversation "abc" not found';
  it("retries when the missing-conversation attempt never reached a result", () => {
    expect(shouldRetryFreshConversation({ status: null }, "", missing)).toBe(true);
  });
  it("keeps a fresh conversation that already finished the task", () => {
    expect(shouldRetryFreshConversation({ status: "SUCCESS" }, "", missing)).toBe(false);
  });
  it("does not retry other failures", () => {
    expect(shouldRetryFreshConversation({ status: null }, "", "network down")).toBe(false);
  });
});
