import { describe, expect, it } from "vitest";
import { parseGeminiJsonl } from "./parse.js";

describe("parseGeminiJsonl", () => {
  it("collects assistant text from message events with string content", () => {
    const stdout = [
      '{"type":"init","session_id":"session-1"}',
      '{"type":"message","role":"user","content":"Respond with hello."}',
      '{"type":"message","role":"assistant","content":"hello","delta":true}',
      '{"type":"result","status":"success"}',
    ].join("\n");

    const parsed = parseGeminiJsonl(stdout);

    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.summary).toBe("hello");
    expect(parsed.errorMessage).toBeNull();
  });

  it("collects assistant text from message events with structured object content", () => {
    const stdout = [
      '{"type":"init","session_id":"session-2"}',
      '{"type":"message","role":"assistant","content":{"content":[{"type":"text","text":"first part"},{"type":"text","text":"second part"}]}}',
      '{"type":"result","status":"success"}',
    ].join("\n");

    const parsed = parseGeminiJsonl(stdout);

    expect(parsed.sessionId).toBe("session-2");
    expect(parsed.summary).toBe("first part\n\nsecond part");
    expect(parsed.errorMessage).toBeNull();
  });

  it("ignores non-assistant message events", () => {
    const stdout = [
      '{"type":"message","role":"user","content":"hidden user input"}',
      '{"type":"message","role":"system","content":"hidden system note"}',
      '{"type":"message","role":"assistant","content":"visible response"}',
      '{"type":"result","status":"success"}',
    ].join("\n");

    const parsed = parseGeminiJsonl(stdout);

    expect(parsed.summary).toBe("visible response");
  });

  it("captures assistant text from gemini CLI v0.38 stream-json schema", () => {
    const stdout = [
      JSON.stringify({
        type: "init",
        timestamp: "2026-05-04T05:43:41.203Z",
        session_id: "session-abc",
        model: "auto-gemini-3",
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-05-04T05:43:41.205Z",
        role: "user",
        content: "Respond with hello.",
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-05-04T05:43:45.198Z",
        role: "assistant",
        content: "hello.",
        delta: true,
      }),
      JSON.stringify({
        type: "result",
        timestamp: "2026-05-04T05:43:45.819Z",
        status: "success",
        stats: {
          total_tokens: 9468,
          input_tokens: 9095,
          output_tokens: 29,
          cached: 8132,
          duration_ms: 4616,
        },
      }),
    ].join("\n");

    const result = parseGeminiJsonl(stdout);
    expect(result.summary).toBe("hello.");
    expect(result.sessionId).toBe("session-abc");
    expect(result.errorMessage).toBeNull();
    expect(result.usage.inputTokens).toBe(9095);
    expect(result.usage.outputTokens).toBe(29);
    expect(result.usage.cachedInputTokens).toBe(8132);
  });

  it("ignores user messages and only collects assistant content", () => {
    const stdout = [
      JSON.stringify({ type: "message", role: "user", content: "ignore me" }),
      JSON.stringify({ type: "message", role: "assistant", content: "first" }),
      JSON.stringify({ type: "message", role: "assistant", content: "second" }),
    ].join("\n");

    const result = parseGeminiJsonl(stdout);
    expect(result.summary).toBe("first\n\nsecond");
  });

  it("preserves the legacy claude-style `assistant` event handler", () => {
    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "legacy-session",
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "output_text", text: "legacy hello" }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", result: "legacy hello" }),
    ].join("\n");

    const result = parseGeminiJsonl(stdout);
    expect(result.summary).toBe("legacy hello");
    expect(result.sessionId).toBe("legacy-session");
  });

  it("flags result events with status=error", () => {
    const stdout = [
      JSON.stringify({
        type: "result",
        status: "error",
        error: "boom",
      }),
    ].join("\n");

    const result = parseGeminiJsonl(stdout);
    expect(result.errorMessage).toBe("boom");
  });
});
