import { describe, expect, it } from "vitest";
import { isJcodeUnknownSessionError, parseJcodeNdjson } from "./parse.js";

describe("parseJcodeNdjson", () => {
  it("parses text, tools, usage, provider, model, and session", () => {
    const stdout = [
      JSON.stringify({ type: "start" }),
      JSON.stringify({ type: "text_delta", delta: "Hello " }),
      JSON.stringify({
        type: "tool_start",
        tool_call_id: "tool-1",
        tool_name: "read",
        args: { path: "README.md" },
      }),
      JSON.stringify({
        type: "tool_exec",
        tool_call_id: "tool-1",
        result: "contents",
      }),
      JSON.stringify({
        type: "done",
        session_id: "session-1",
        model: "anthropic/claude-sonnet-4-5",
        provider: "anthropic",
        text: "Hello from JCode",
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cache_read_input_tokens: 10,
        },
      }),
    ].join("\n");

    expect(parseJcodeNdjson(stdout)).toEqual({
      sessionId: "session-1",
      text: "Hello from JCode",
      errors: [],
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        cachedInputTokens: 10,
      },
      model: "anthropic/claude-sonnet-4-5",
      provider: "anthropic",
      toolCalls: [
        {
          toolCallId: "tool-1",
          toolName: "read",
          args: { path: "README.md" },
          result: "contents",
          isError: false,
        },
      ],
    });
  });

  it("collects error events", () => {
    const parsed = parseJcodeNdjson(
      JSON.stringify({ type: "error", message: "provider auth failed" }),
    );

    expect(parsed.errors).toEqual(["provider auth failed"]);
  });
});

describe("isJcodeUnknownSessionError", () => {
  it("detects missing session failures", () => {
    expect(isJcodeUnknownSessionError("", "session not found: session-1")).toBe(true);
    expect(isJcodeUnknownSessionError("unknown session", "")).toBe(true);
    expect(isJcodeUnknownSessionError("", "provider auth failed")).toBe(false);
  });
});
