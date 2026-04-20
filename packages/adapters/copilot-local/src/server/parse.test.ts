import { describe, expect, it } from "vitest";
import { parseCopilotLocalJsonl, isCopilotLocalStaleSessionError } from "./parse.js";

/* ------------------------------------------------------------------ */
/*  Helper: build a JSONL line from a plain object                    */
/* ------------------------------------------------------------------ */
function jsonl(...objs: Record<string, unknown>[]): string {
  return objs.map((o) => JSON.stringify(o)).join("\n");
}

/* ================================================================== */
/*  parseCopilotLocalJsonl                                            */
/* ================================================================== */
describe("parseCopilotLocalJsonl", () => {
  it("concatenates multiple message_delta events into summary", () => {
    const input = jsonl(
      { type: "assistant.message_delta", data: { deltaContent: "Hello" }, id: "1", timestamp: "t1", ephemeral: true },
      { type: "assistant.message_delta", data: { deltaContent: " world" }, id: "2", timestamp: "t2", ephemeral: true },
      { type: "assistant.message_delta", data: { deltaContent: "!" }, id: "3", timestamp: "t3", ephemeral: true },
    );
    const result = parseCopilotLocalJsonl(input);
    expect(result.summary).toBe("Hello world!");
  });

  it("accumulates outputTokens from assistant.message events", () => {
    const input = jsonl(
      { type: "assistant.message", data: { content: "first", outputTokens: 10 } },
      { type: "assistant.message", data: { content: " second", outputTokens: 25 } },
    );
    const result = parseCopilotLocalJsonl(input);
    expect(result.summary).toBe("first second");
    expect(result.usage.outputTokens).toBe(35);
  });

  it("extracts model from tool.execution_complete", () => {
    const input = jsonl(
      { type: "tool.execution_start", data: { toolCallId: "tc1", toolName: "read_file", arguments: {} } },
      { type: "tool.execution_complete", data: { toolCallId: "tc1", success: true, result: { content: "file data" }, model: "gpt-5-mini" } },
    );
    const result = parseCopilotLocalJsonl(input);
    expect(result.model).toBe("gpt-5-mini");
  });

  it("uses first model from tool.execution_complete (ignores subsequent)", () => {
    const input = jsonl(
      { type: "tool.execution_complete", data: { toolCallId: "tc1", success: true, result: {}, model: "gpt-5-mini" } },
      { type: "tool.execution_complete", data: { toolCallId: "tc2", success: true, result: {}, model: "claude-4" } },
    );
    const result = parseCopilotLocalJsonl(input);
    expect(result.model).toBe("gpt-5-mini");
  });

  it("extracts sessionId and premiumRequests from result event", () => {
    const input = jsonl(
      { type: "result", sessionId: "sess_abc", exitCode: 0, usage: { premiumRequests: 3, sessionDurationMs: 30000 } },
    );
    const result = parseCopilotLocalJsonl(input);
    expect(result.sessionId).toBe("sess_abc");
    expect(result.premiumRequests).toBe(3);
  });

  it("populates errorMessage from error events", () => {
    const input = jsonl(
      { type: "error", data: { message: "something failed" } },
    );
    const result = parseCopilotLocalJsonl(input);
    expect(result.errorMessage).toBe("something failed");
    expect(result.summary).toBe("");
  });

  it("concatenates multiple error messages", () => {
    const input = jsonl(
      { type: "error", data: { message: "first error" } },
      { type: "error", data: { message: "second error" } },
    );
    const result = parseCopilotLocalJsonl(input);
    expect(result.errorMessage).toBe("first error\nsecond error");
  });

  it("handles a mixed real-world JSONL stream", () => {
    const input = jsonl(
      { type: "session.created", data: { sessionId: "sess_xyz" } },
      { type: "user.message", data: { content: "explain code" } },
      { type: "assistant.intent", data: { intent: "explain" } },
      { type: "assistant.reasoning", data: { content: "thinking..." } },
      { type: "assistant.message_delta", data: { deltaContent: "This code " }, id: "d1", timestamp: "t1", ephemeral: true },
      { type: "assistant.message_delta", data: { deltaContent: "does X." }, id: "d2", timestamp: "t2", ephemeral: true },
      { type: "tool.execution_start", data: { toolCallId: "tc1", toolName: "read_file", arguments: {} } },
      { type: "tool.execution_complete", data: { toolCallId: "tc1", success: true, result: { content: "..." }, model: "gpt-5-mini" } },
      { type: "assistant.usage", data: { inputTokens: 100, outputTokens: 50 } },
      { type: "result", sessionId: "sess_xyz", exitCode: 0, usage: { premiumRequests: 1, sessionDurationMs: 5000 } },
    );
    const result = parseCopilotLocalJsonl(input);
    expect(result.sessionId).toBe("sess_xyz");
    expect(result.summary).toBe("This code does X.");
    expect(result.model).toBe("gpt-5-mini");
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.premiumRequests).toBe(1);
    expect(result.errorMessage).toBeNull();
  });

  it("parses multi-line chunks (lines separated by \\n in a single string)", () => {
    // Simulate buffered output: two JSON objects in one chunk separated by newline
    const chunk =
      `{"type":"assistant.message_delta","data":{"deltaContent":"A"}}\n{"type":"assistant.message_delta","data":{"deltaContent":"B"}}`;
    const result = parseCopilotLocalJsonl(chunk);
    expect(result.summary).toBe("AB");
  });

  it("gracefully skips empty and invalid lines", () => {
    const input = [
      "",
      "   ",
      "not valid json at all",
      '{"type":"assistant.message_delta","data":{"deltaContent":"ok"}}',
      "{}",
      '{"noType": true}',
      "",
    ].join("\n");
    const result = parseCopilotLocalJsonl(input);
    expect(result.summary).toBe("ok");
    expect(result.errorMessage).toBeNull();
  });

  it("accumulates inputTokens and outputTokens from assistant.usage events", () => {
    const input = jsonl(
      { type: "assistant.usage", data: { inputTokens: 100, outputTokens: 50 } },
      { type: "assistant.usage", data: { inputTokens: 200, outputTokens: 75 } },
    );
    const result = parseCopilotLocalJsonl(input);
    expect(result.usage.inputTokens).toBe(300);
    expect(result.usage.outputTokens).toBe(125);
  });

  it("returns defaults when given an empty string", () => {
    const result = parseCopilotLocalJsonl("");
    expect(result.sessionId).toBeNull();
    expect(result.summary).toBe("");
    expect(result.errorMessage).toBeNull();
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    expect(result.premiumRequests).toBe(0);
    expect(result.model).toBeNull();
  });

  it("handles \\r\\n line endings", () => {
    const input =
      '{"type":"assistant.message_delta","data":{"deltaContent":"line1"}}\r\n{"type":"assistant.message_delta","data":{"deltaContent":"line2"}}';
    const result = parseCopilotLocalJsonl(input);
    expect(result.summary).toBe("line1line2");
  });

  it("extracts error from nested error object when data.message is missing", () => {
    const input = jsonl(
      { type: "error", data: { error: { message: "nested failure" } } },
    );
    const result = parseCopilotLocalJsonl(input);
    expect(result.errorMessage).toBe("nested failure");
  });

  it("skips assistant.reasoning events", () => {
    const input = jsonl(
      { type: "assistant.reasoning", data: { content: "thinking hard..." } },
      { type: "assistant.message_delta", data: { deltaContent: "answer" } },
    );
    const result = parseCopilotLocalJsonl(input);
    expect(result.summary).toBe("answer");
  });
});

/* ================================================================== */
/*  isCopilotLocalStaleSessionError                                   */
/* ================================================================== */
describe("isCopilotLocalStaleSessionError", () => {
  it("returns true for 'invalid session' in stdout", () => {
    expect(isCopilotLocalStaleSessionError("Error: invalid session id", "")).toBe(true);
  });

  it("returns true for 'session not found' in stderr", () => {
    expect(isCopilotLocalStaleSessionError("", "session not found for user")).toBe(true);
  });

  it("returns true for 'session expired' in stderr", () => {
    expect(isCopilotLocalStaleSessionError("", "your session has expired")).toBe(true);
  });

  it("returns true for 'unknown session' in stdout", () => {
    expect(isCopilotLocalStaleSessionError("unknown session abc123", "")).toBe(true);
  });

  it("returns true for case-insensitive matches", () => {
    expect(isCopilotLocalStaleSessionError("INVALID SESSION", "")).toBe(true);
    expect(isCopilotLocalStaleSessionError("", "Session Not Found")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isCopilotLocalStaleSessionError("rate limit exceeded", "timeout error")).toBe(false);
  });

  it("returns false for empty strings", () => {
    expect(isCopilotLocalStaleSessionError("", "")).toBe(false);
  });

  it("returns false for whitespace-only strings", () => {
    expect(isCopilotLocalStaleSessionError("   ", "  \n  ")).toBe(false);
  });

  it("detects stale session across stdout and stderr combined", () => {
    expect(isCopilotLocalStaleSessionError("some output", "error: invalid session")).toBe(true);
  });
});
