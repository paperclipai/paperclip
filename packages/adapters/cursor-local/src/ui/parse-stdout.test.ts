import { describe, expect, it } from "vitest";
import { parseCursorStdoutLine } from "./parse-stdout.js";

const TS = "2026-04-18T00:00:00.000Z";

// ============================================================================
// Non-JSON / empty lines
// ============================================================================

describe("parseCursorStdoutLine — non-JSON input", () => {
  it("returns empty array for blank line", () => {
    expect(parseCursorStdoutLine("", TS)).toEqual([]);
  });

  it("returns empty array for whitespace-only line", () => {
    expect(parseCursorStdoutLine("   ", TS)).toEqual([]);
  });

  it("returns stdout entry for plain text", () => {
    const result = parseCursorStdoutLine("hello world", TS);
    expect(result).toEqual([{ kind: "stdout", ts: TS, text: "hello world" }]);
  });

  it("returns stdout entry for invalid JSON", () => {
    const result = parseCursorStdoutLine("{bad}", TS);
    expect(result).toEqual([{ kind: "stdout", ts: TS, text: "{bad}" }]);
  });
});

// ============================================================================
// system/init
// ============================================================================

describe("parseCursorStdoutLine — system init", () => {
  it("returns init entry with model and sessionId", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      model: "claude-cursor",
      session_id: "sess-xyz",
    });
    expect(parseCursorStdoutLine(line, TS)).toEqual([
      { kind: "init", ts: TS, model: "claude-cursor", sessionId: "sess-xyz" },
    ]);
  });

  it("uses sessionId from sessionID (capital) field", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      model: "m",
      sessionID: "cap-session",
    });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "init", sessionId: "cap-session" });
  });

  it("returns system entry for non-init system event", () => {
    const line = JSON.stringify({ type: "system", subtype: "heartbeat" });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "system", text: "system: heartbeat" });
  });

  it("returns generic system entry when subtype is empty", () => {
    const line = JSON.stringify({ type: "system" });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "system", text: "system" });
  });
});

// ============================================================================
// assistant messages
// ============================================================================

describe("parseCursorStdoutLine — assistant string message", () => {
  it("returns assistant entry for string message", () => {
    const line = JSON.stringify({ type: "assistant", message: "Hello!" });
    expect(parseCursorStdoutLine(line, TS)).toEqual([
      { kind: "assistant", ts: TS, text: "Hello!" },
    ]);
  });

  it("returns assistant entry from message.text", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { text: "Direct text" },
    });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "assistant", text: "Direct text" });
  });

  it("returns assistant entry from output_text content part", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "output_text", text: "Content text" }] },
    });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "assistant", text: "Content text" });
  });

  it("returns thinking entry from thinking content part", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", text: "Reasoning..." }] },
    });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "thinking", text: "Reasoning..." });
  });

  it("returns tool_call entry from tool_call content part", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_call",
            name: "read_file",
            call_id: "c-001",
            input: { path: "/tmp/x" },
          },
        ],
      },
    });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({
      kind: "tool_call",
      name: "read_file",
      toolUseId: "c-001",
      input: { path: "/tmp/x" },
    });
  });

  it("returns tool_result entry from tool_result content part", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_result",
            call_id: "c-001",
            output: "file contents",
            is_error: false,
          },
        ],
      },
    });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({
      kind: "tool_result",
      content: "file contents",
      isError: false,
    });
  });
});

// ============================================================================
// user messages
// ============================================================================

describe("parseCursorStdoutLine — user messages", () => {
  it("returns user entry for string user message", () => {
    const line = JSON.stringify({ type: "user", message: "Please do X" });
    expect(parseCursorStdoutLine(line, TS)).toEqual([
      { kind: "user", ts: TS, text: "Please do X" },
    ]);
  });

  it("returns user entry from message.text", () => {
    const line = JSON.stringify({
      type: "user",
      message: { text: "User input" },
    });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "user", text: "User input" });
  });

  it("returns empty array for whitespace user string", () => {
    const line = JSON.stringify({ type: "user", message: "   " });
    expect(parseCursorStdoutLine(line, TS)).toEqual([]);
  });

  it("returns user entries from output_text content parts", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "output_text", text: "Part A" },
          { type: "output_text", text: "Part B" },
        ],
      },
    });
    const result = parseCursorStdoutLine(line, TS);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ kind: "user", text: "Part A" });
    expect(result[1]).toMatchObject({ kind: "user", text: "Part B" });
  });
});

// ============================================================================
// thinking events
// ============================================================================

describe("parseCursorStdoutLine — thinking", () => {
  it("returns thinking entry from top-level text", () => {
    const line = JSON.stringify({ type: "thinking", text: "Hmm..." });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "thinking", text: "Hmm..." });
  });

  it("returns thinking entry from delta.text", () => {
    const line = JSON.stringify({ type: "thinking", delta: { text: "Delta chunk" } });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "thinking", text: "Delta chunk" });
  });

  it("returns empty array for empty thinking text", () => {
    const line = JSON.stringify({ type: "thinking", text: "" });
    expect(parseCursorStdoutLine(line, TS)).toEqual([]);
  });
});

// ============================================================================
// result events
// ============================================================================

describe("parseCursorStdoutLine — result", () => {
  it("returns result entry with token counts", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "done",
      is_error: false,
      total_cost_usd: 0.005,
      usage: {
        input_tokens: 200,
        output_tokens: 80,
        cache_read_input_tokens: 30,
      },
    });
    expect(parseCursorStdoutLine(line, TS)).toEqual([
      {
        kind: "result",
        ts: TS,
        text: "done",
        inputTokens: 200,
        outputTokens: 80,
        cachedTokens: 30,
        costUsd: 0.005,
        subtype: "success",
        isError: false,
        errors: [],
      },
    ]);
  });

  it("reads camelCase token fields as fallback", () => {
    const line = JSON.stringify({
      type: "result",
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 },
    });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ inputTokens: 10, outputTokens: 5, cachedTokens: 2 });
  });

  it("marks is_error=true results as errors", () => {
    const line = JSON.stringify({ type: "result", is_error: true, subtype: "error", usage: {} });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "result", isError: true });
  });

  it("defaults missing usage to 0", () => {
    const line = JSON.stringify({ type: "result" });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "result", inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
  });

  it("appends top-level error string to errors array", () => {
    const line = JSON.stringify({ type: "result", usage: {}, error: "quota exceeded" });
    const result = parseCursorStdoutLine(line, TS);
    const entry = result[0] as { kind: string; errors: string[] };
    expect(entry.errors).toContain("quota exceeded");
  });
});

// ============================================================================
// error events
// ============================================================================

describe("parseCursorStdoutLine — error", () => {
  it("returns stderr entry with message", () => {
    const line = JSON.stringify({ type: "error", message: "connection lost" });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "stderr", text: "connection lost" });
  });

  it("stringifies error object when message is missing", () => {
    const line = JSON.stringify({ type: "error", error: { code: "ETIMEOUT" } });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "stderr" });
    expect((result[0] as { text: string }).text).toContain("ETIMEOUT");
  });
});

// ============================================================================
// legacy step_start / step_finish / text / tool_use
// ============================================================================

describe("parseCursorStdoutLine — legacy event shapes", () => {
  it("returns system entry for step_start", () => {
    const line = JSON.stringify({ type: "step_start", sessionID: "s1" });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "system", text: "step started (s1)" });
  });

  it("returns assistant entry for text event", () => {
    const line = JSON.stringify({ type: "text", part: { text: "inline text" } });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "assistant", text: "inline text" });
  });

  it("returns result entry for step_finish", () => {
    const line = JSON.stringify({
      type: "step_finish",
      part: {
        reason: "stop",
        tokens: { input: 50, output: 20, cache: { read: 5 } },
        cost: 0.0003,
      },
    });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({
      kind: "result",
      inputTokens: 50,
      outputTokens: 20,
      cachedTokens: 5,
      costUsd: 0.0003,
      subtype: "stop",
    });
  });

  it("returns tool_call and tool_result entries for legacy tool_use", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        tool: "bash",
        callID: "c-99",
        state: {
          input: { command: "pwd" },
          output: "/home/user",
          status: "completed",
        },
      },
    });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "tool_call", name: "bash" });
    expect(result[1]).toMatchObject({ kind: "tool_result", content: expect.stringContaining("/home/user") });
  });
});

// ============================================================================
// stdout prefix stripping (normalizeCursorStreamLine)
// ============================================================================

describe("parseCursorStdoutLine — stdout prefix handling", () => {
  it("strips 'stdout: ' prefix before parsing JSON", () => {
    const payload = JSON.stringify({ type: "system", subtype: "init", model: "m", session_id: "s" });
    const result = parseCursorStdoutLine(`stdout: ${payload}`, TS);
    expect(result[0]).toMatchObject({ kind: "init" });
  });
});

// ============================================================================
// fallback
// ============================================================================

describe("parseCursorStdoutLine — unknown type fallback", () => {
  it("returns stdout entry for unknown JSON type", () => {
    const line = JSON.stringify({ type: "unknown_future_type" });
    const result = parseCursorStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "stdout" });
  });
});
