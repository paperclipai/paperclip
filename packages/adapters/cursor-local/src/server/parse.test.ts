import { describe, expect, it } from "vitest";
import { parseCursorJsonl, isCursorUnknownSessionError } from "./parse.js";

// ============================================================================
// parseCursorJsonl — empty / no result
// ============================================================================

describe("parseCursorJsonl — empty input", () => {
  it("returns defaults for empty stdout", () => {
    const result = parseCursorJsonl("");
    expect(result.sessionId).toBeNull();
    expect(result.summary).toBe("");
    expect(result.costUsd).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.usage).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  });

  it("returns defaults for whitespace-only stdout", () => {
    const result = parseCursorJsonl("\n\n   \n");
    expect(result.sessionId).toBeNull();
    expect(result.summary).toBe("");
  });

  it("ignores non-JSON lines", () => {
    const result = parseCursorJsonl("not json\nstill not json");
    expect(result.sessionId).toBeNull();
    expect(result.summary).toBe("");
  });
});

// ============================================================================
// parseCursorJsonl — session ID variants
// ============================================================================

describe("parseCursorJsonl — session ID extraction", () => {
  it("reads session_id (snake_case)", () => {
    const lines = [
      JSON.stringify({ type: "assistant", session_id: "sess-snake", message: "hi" }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.sessionId).toBe("sess-snake");
  });

  it("reads sessionId (camelCase)", () => {
    const lines = [
      JSON.stringify({ type: "assistant", sessionId: "sess-camel", message: "hi" }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.sessionId).toBe("sess-camel");
  });

  it("reads sessionID (all caps ID)", () => {
    const lines = [
      JSON.stringify({ type: "assistant", sessionID: "sess-caps", message: "hi" }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.sessionId).toBe("sess-caps");
  });

  it("keeps first non-empty session ID when multiple events arrive", () => {
    const lines = [
      JSON.stringify({ type: "assistant", session_id: "first", message: "hi" }),
      JSON.stringify({ type: "assistant", session_id: "second", message: "bye" }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.sessionId).toBe("second"); // last non-empty wins
  });
});

// ============================================================================
// parseCursorJsonl — assistant text accumulation
// ============================================================================

describe("parseCursorJsonl — assistant text", () => {
  it("collects string message", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: "Hello world" }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.summary).toBe("Hello world");
  });

  it("collects message.text from object message", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { text: "Direct text" } }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.summary).toBe("Direct text");
  });

  it("collects output_text content parts", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "output_text", text: "Content text" }] },
      }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.summary).toBe("Content text");
  });

  it("collects text content parts", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Text part" }] },
      }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.summary).toBe("Text part");
  });

  it("joins multiple messages with double newlines", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: "First" }),
      JSON.stringify({ type: "assistant", message: "Second" }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.summary).toBe("First\n\nSecond");
  });

  it("uses result.result text as summary when no assistant messages", () => {
    const lines = [
      JSON.stringify({ type: "result", result: "Final result", usage: {} }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.summary).toBe("Final result");
  });

  it("does not include result.result when assistant messages already present", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: "Intermediate" }),
      JSON.stringify({ type: "result", result: "ignored", usage: {} }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.summary).toBe("Intermediate");
  });
});

// ============================================================================
// parseCursorJsonl — usage accumulation
// ============================================================================

describe("parseCursorJsonl — usage tokens", () => {
  it("reads snake_case token fields from result event", () => {
    const lines = [
      JSON.stringify({
        type: "result",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 20,
        },
      }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50, cachedInputTokens: 20 });
  });

  it("reads camelCase token fields as fallback", () => {
    const lines = [
      JSON.stringify({
        type: "result",
        usage: {
          inputTokens: 80,
          outputTokens: 40,
          cachedInputTokens: 10,
        },
      }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.usage).toEqual({ inputTokens: 80, outputTokens: 40, cachedInputTokens: 10 });
  });

  it("reads cache_read_input_tokens as fallback for cachedInputTokens", () => {
    const lines = [
      JSON.stringify({
        type: "result",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 3,
        },
      }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.usage.cachedInputTokens).toBe(3);
  });

  it("accumulates tokens from multiple result events", () => {
    const lines = [
      JSON.stringify({ type: "result", usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 5 } }),
      JSON.stringify({ type: "result", usage: { input_tokens: 30, output_tokens: 10, cache_read_input_tokens: 0 } }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.usage).toEqual({ inputTokens: 80, outputTokens: 30, cachedInputTokens: 5 });
  });

  it("accumulates tokens from step_finish events", () => {
    const lines = [
      JSON.stringify({
        type: "step_finish",
        part: { tokens: { input: 40, output: 15, cache: { read: 8 } }, cost: 0.001 },
      }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.usage.inputTokens).toBe(40);
    expect(result.usage.outputTokens).toBe(15);
    expect(result.usage.cachedInputTokens).toBe(8);
  });
});

// ============================================================================
// parseCursorJsonl — cost
// ============================================================================

describe("parseCursorJsonl — cost", () => {
  it("reads total_cost_usd from result event", () => {
    const lines = [
      JSON.stringify({ type: "result", total_cost_usd: 0.0042, usage: {} }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.costUsd).toBe(0.0042);
  });

  it("reads cost_usd as fallback", () => {
    const lines = [
      JSON.stringify({ type: "result", cost_usd: 0.001, usage: {} }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.costUsd).toBe(0.001);
  });

  it("reads cost as second fallback", () => {
    const lines = [
      JSON.stringify({ type: "result", cost: 0.0005, usage: {} }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.costUsd).toBe(0.0005);
  });

  it("accumulates cost from step_finish events", () => {
    const lines = [
      JSON.stringify({ type: "step_finish", part: { tokens: {}, cost: 0.002 } }),
      JSON.stringify({ type: "step_finish", part: { tokens: {}, cost: 0.003 } }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.costUsd).toBeCloseTo(0.005);
  });

  it("returns null costUsd when no cost found", () => {
    const lines = [
      JSON.stringify({ type: "result", usage: {} }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.costUsd).toBeNull();
  });
});

// ============================================================================
// parseCursorJsonl — error handling
// ============================================================================

describe("parseCursorJsonl — error message extraction", () => {
  it("captures error message from is_error result event", () => {
    const lines = [
      JSON.stringify({
        type: "result",
        is_error: true,
        error: "Rate limit exceeded",
        usage: {},
      }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.errorMessage).toBe("Rate limit exceeded");
  });

  it("captures error from subtype=error result event", () => {
    const lines = [
      JSON.stringify({
        type: "result",
        subtype: "error",
        message: "Something went wrong",
        usage: {},
      }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.errorMessage).toBe("Something went wrong");
  });

  it("captures error message from type=error event", () => {
    const lines = [
      JSON.stringify({ type: "error", message: "Connection failed" }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.errorMessage).toBe("Connection failed");
  });

  it("captures error message from type=system subtype=error event", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "error", message: "System crashed" }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.errorMessage).toBe("System crashed");
  });

  it("returns null errorMessage for successful run", () => {
    const lines = [
      JSON.stringify({ type: "result", result: "done", usage: {} }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.errorMessage).toBeNull();
  });
});

// ============================================================================
// parseCursorJsonl — legacy event shapes
// ============================================================================

describe("parseCursorJsonl — legacy event shapes", () => {
  it("reads text from type=text event part", () => {
    const lines = [
      JSON.stringify({ type: "text", part: { text: "Legacy text" } }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.summary).toBe("Legacy text");
  });

  it("accumulates tokens from step_finish event", () => {
    const lines = [
      JSON.stringify({
        type: "step_finish",
        part: {
          reason: "stop",
          tokens: { input: 100, output: 50, cache: { read: 10 } },
          cost: 0.001,
        },
      }),
    ];
    const result = parseCursorJsonl(lines.join("\n"));
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.cachedInputTokens).toBe(10);
    expect(result.costUsd).toBe(0.001);
  });
});

// ============================================================================
// isCursorUnknownSessionError
// ============================================================================

describe("isCursorUnknownSessionError", () => {
  it("returns false for normal output", () => {
    expect(isCursorUnknownSessionError("All good", "")).toBe(false);
  });

  it("detects 'unknown session' in stdout", () => {
    expect(isCursorUnknownSessionError("unknown session abc123", "")).toBe(true);
  });

  it("detects 'unknown chat' in stdout", () => {
    expect(isCursorUnknownSessionError("unknown chat xyz", "")).toBe(true);
  });

  it("detects 'session not found' in stderr", () => {
    expect(isCursorUnknownSessionError("", "session abc not found")).toBe(true);
  });

  it("detects 'chat not found' in stderr", () => {
    expect(isCursorUnknownSessionError("", "chat def not found")).toBe(true);
  });

  it("detects 'resume not found' pattern", () => {
    expect(isCursorUnknownSessionError("resume abc123 not found", "")).toBe(true);
  });

  it("detects 'could not resume' pattern", () => {
    expect(isCursorUnknownSessionError("could not resume previous session", "")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isCursorUnknownSessionError("Unknown Session XYZ", "")).toBe(true);
  });

  it("returns false for empty strings", () => {
    expect(isCursorUnknownSessionError("", "")).toBe(false);
  });
});
