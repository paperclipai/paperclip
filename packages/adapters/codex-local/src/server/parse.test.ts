import { describe, expect, it } from "vitest";
import { isCodexContextWindowError, isCodexUnknownSessionError, parseCodexJsonl } from "./parse.js";

describe("parseCodexJsonl", () => {
  it("captures session id, assistant summary, usage, and error message", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Recovered response" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
      }),
      JSON.stringify({ type: "turn.failed", error: { message: "resume failed" } }),
    ].join("\n");

    expect(parseCodexJsonl(stdout)).toEqual({
      sessionId: "thread_123",
      summary: "Recovered response",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 4,
      },
      errorMessage: "resume failed",
    });
  });
});

describe("isCodexContextWindowError", () => {
  it("detects context_length_exceeded error code", () => {
    expect(isCodexContextWindowError("", "context_length_exceeded: prompt too large")).toBe(true);
  });

  it("detects maximum context length message", () => {
    expect(
      isCodexContextWindowError(
        "",
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
      ),
    ).toBe(true);
  });

  it("detects 'exceeds the model's context' phrasing", () => {
    expect(isCodexContextWindowError("", "Request exceeds the model's context limit")).toBe(true);
  });

  it("detects 'too many tokens' phrasing", () => {
    expect(isCodexContextWindowError("too many tokens in request", "")).toBe(true);
  });

  it("detects 'prompt is too long' phrasing", () => {
    expect(isCodexContextWindowError("", "prompt is too long for this model")).toBe(true);
  });

  it("does not classify unrelated errors as context window errors", () => {
    expect(isCodexContextWindowError("", "model overloaded")).toBe(false);
    expect(isCodexContextWindowError("", "unknown session")).toBe(false);
  });
});

describe("isCodexUnknownSessionError", () => {
  it("still detects existing stale-session wordings", () => {
    expect(isCodexUnknownSessionError("unknown thread id", "")).toBe(true);
    expect(isCodexUnknownSessionError("", "state db missing rollout path for thread abc")).toBe(true);
  });

  it("does not classify unrelated Codex failures as stale sessions", () => {
    expect(isCodexUnknownSessionError("", "model overloaded")).toBe(false);
  });
});
