import { describe, expect, it } from "vitest";
import { isClaudeCodeAuthError, isClaudeCodeUnknownSessionError, parseClaudeCodeJsonl } from "./parse.js";

describe("parseClaudeCodeJsonl", () => {
  it("captures session id, model, usage, and result", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "session_123", model: "claude-opus-4-7" }),
      JSON.stringify({
        type: "assistant",
        session_id: "session_123",
        message: { content: [{ type: "text", text: "Working on the fix" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "session_123",
        result: "Fixed the issue",
        usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 4 },
        total_cost_usd: 0.05,
      }),
    ].join("\n");

    expect(parseClaudeCodeJsonl(stdout)).toEqual({
      sessionId: "session_123",
      model: "claude-opus-4-7",
      costUsd: 0.05,
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 4,
      },
      summary: "Fixed the issue",
      resultJson: expect.objectContaining({ result: "Fixed the issue" }),
    });
  });

  it("uses assistant messages when no result event", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "session_456", model: "claude-sonnet-4-6" }),
      JSON.stringify({
        type: "assistant",
        session_id: "session_456",
        message: { content: [{ type: "text", text: "First message" }] },
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "session_456",
        message: { content: [{ type: "text", text: "Second message" }] },
      }),
    ].join("\n");

    const result = parseClaudeCodeJsonl(stdout);
    expect(result.sessionId).toBe("session_456");
    expect(result.summary).toBe("First message\n\nSecond message");
    expect(result.resultJson).toBeNull();
  });

  it("handles empty stdout", () => {
    const result = parseClaudeCodeJsonl("");
    expect(result.sessionId).toBeNull();
    expect(result.model).toBe("");
    expect(result.summary).toBe("");
  });
});

describe("isClaudeCodeUnknownSessionError", () => {
  it("detects unknown session errors", () => {
    expect(isClaudeCodeUnknownSessionError({ result: "no conversation found with session id abc" })).toBe(true);
    expect(isClaudeCodeUnknownSessionError({ result: "unknown session: def" })).toBe(true);
    expect(isClaudeCodeUnknownSessionError({ result: "session 123 not found" })).toBe(true);
  });

  it("does not classify unrelated errors as session errors", () => {
    expect(isClaudeCodeUnknownSessionError({ result: "rate limit exceeded" })).toBe(false);
    expect(isClaudeCodeUnknownSessionError({ result: "" })).toBe(false);
  });
});

describe("isClaudeCodeAuthError", () => {
  it("detects login-required errors", () => {
    expect(isClaudeCodeAuthError(null, "", "Please log in to continue")).toBe(true);
    expect(isClaudeCodeAuthError(null, "", "Authentication required")).toBe(true);
    expect(isClaudeCodeAuthError(null, "not logged in", "")).toBe(true);
  });

  it("does not classify unrelated errors as auth errors", () => {
    expect(isClaudeCodeAuthError(null, "rate limit exceeded", "")).toBe(false);
    expect(isClaudeCodeAuthError({ result: "server error" }, "", "")).toBe(false);
  });
});