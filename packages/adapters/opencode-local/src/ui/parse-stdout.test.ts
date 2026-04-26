import { describe, expect, it } from "vitest";
import { parseOpenCodeStdoutLine } from "./parse-stdout.js";

const TS = "2026-04-17T00:00:00.000Z";

// ============================================================================
// Non-JSON fallback
// ============================================================================

describe("parseOpenCodeStdoutLine — non-JSON input", () => {
  it("returns stdout entry for plain text", () => {
    const result = parseOpenCodeStdoutLine("plain text", TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "stdout", ts: TS, text: "plain text" });
  });

  it("returns stdout entry for malformed JSON", () => {
    const result = parseOpenCodeStdoutLine("{broken", TS);
    expect(result[0]?.kind).toBe("stdout");
  });
});

// ============================================================================
// text events — assistant output
// ============================================================================

describe("parseOpenCodeStdoutLine — text event", () => {
  it("returns assistant entry for text event with text", () => {
    const line = JSON.stringify({ type: "text", part: { text: "Hello!" } });
    const result = parseOpenCodeStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "assistant", ts: TS, text: "Hello!" });
  });

  it("returns empty array for text event with empty text", () => {
    const line = JSON.stringify({ type: "text", part: { text: "   " } });
    const result = parseOpenCodeStdoutLine(line, TS);
    expect(result).toEqual([]);
  });

  it("trims whitespace from text content", () => {
    const line = JSON.stringify({ type: "text", part: { text: "  answer  " } });
    const result = parseOpenCodeStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "assistant", text: "answer" });
  });
});

// ============================================================================
// reasoning events — thinking output
// ============================================================================

describe("parseOpenCodeStdoutLine — reasoning event", () => {
  it("returns thinking entry for reasoning event", () => {
    const line = JSON.stringify({ type: "reasoning", part: { text: "I'm thinking..." } });
    const result = parseOpenCodeStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "thinking", ts: TS, text: "I'm thinking..." });
  });

  it("returns empty array for reasoning event with empty text", () => {
    const line = JSON.stringify({ type: "reasoning", part: { text: "" } });
    const result = parseOpenCodeStdoutLine(line, TS);
    expect(result).toEqual([]);
  });
});

// ============================================================================
// tool_use events
// ============================================================================

describe("parseOpenCodeStdoutLine — tool_use event", () => {
  it("returns tool_call for tool_use with non-completed status", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        tool: "Read",
        callID: "call-abc",
        state: { status: "running", input: { path: "/tmp/foo.ts" } },
      },
    });
    const result = parseOpenCodeStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "tool_call", name: "Read", toolUseId: "call-abc" });
  });

  it("returns tool_call and tool_result for completed tool_use", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        tool: "Bash",
        callID: "call-done",
        state: { status: "completed", input: { command: "ls" }, output: "file.ts" },
      },
    });
    const result = parseOpenCodeStdoutLine(line, TS);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ kind: "tool_call", name: "Bash" });
    expect(result[1]).toMatchObject({ kind: "tool_result", isError: false });
  });

  it("marks tool_result as error for error status", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        tool: "Write",
        callID: "call-err",
        state: { status: "error", input: {}, error: "Permission denied" },
      },
    });
    const result = parseOpenCodeStdoutLine(line, TS);
    const resultEntry = result.find((e) => e.kind === "tool_result");
    expect(resultEntry).toMatchObject({ kind: "tool_result", isError: true });
  });

  it("returns system fallback when no part", () => {
    const line = JSON.stringify({ type: "tool_use" });
    const result = parseOpenCodeStdoutLine(line, TS);
    expect(result[0]?.kind).toBe("system");
  });
});

// ============================================================================
// step_start events
// ============================================================================

describe("parseOpenCodeStdoutLine — step_start event", () => {
  it("returns system entry with sessionId when present", () => {
    const line = JSON.stringify({ type: "step_start", sessionID: "sess-42" });
    const result = parseOpenCodeStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("system");
    const entry = result[0] as { text: string };
    expect(entry.text).toContain("sess-42");
  });

  it("returns system entry without sessionId when absent", () => {
    const line = JSON.stringify({ type: "step_start" });
    const result = parseOpenCodeStdoutLine(line, TS);
    expect(result[0]?.kind).toBe("system");
  });
});

// ============================================================================
// step_finish events
// ============================================================================

describe("parseOpenCodeStdoutLine — step_finish event", () => {
  it("returns result entry with token counts", () => {
    const line = JSON.stringify({
      type: "step_finish",
      part: {
        reason: "end_turn",
        cost: 0.005,
        tokens: {
          input: 100,
          output: 50,
          reasoning: 10,
          cache: { read: 20 },
        },
      },
    });
    const result = parseOpenCodeStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "result",
      inputTokens: 100,
      outputTokens: 60, // output + reasoning
      cachedTokens: 20,
      costUsd: 0.005,
      isError: false,
    });
  });

  it("returns result entry with zero tokens when not provided", () => {
    const line = JSON.stringify({ type: "step_finish", part: { reason: "done" } });
    const result = parseOpenCodeStdoutLine(line, TS);
    expect(result[0]).toMatchObject({
      kind: "result",
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});

// ============================================================================
// error events
// ============================================================================

describe("parseOpenCodeStdoutLine — error event", () => {
  it("returns stderr entry with error message string", () => {
    const line = JSON.stringify({ type: "error", error: "something broke" });
    const result = parseOpenCodeStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "stderr", text: "something broke" });
  });

  it("returns stderr entry extracting message from error object", () => {
    const line = JSON.stringify({ type: "error", error: { message: "internal error" } });
    const result = parseOpenCodeStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "stderr", text: "internal error" });
  });

  it("falls back to raw line when no error text", () => {
    const raw = JSON.stringify({ type: "error" });
    const result = parseOpenCodeStdoutLine(raw, TS);
    expect(result[0]?.kind).toBe("stderr");
  });
});

// ============================================================================
// Unknown event type fallback
// ============================================================================

describe("parseOpenCodeStdoutLine — unknown event type", () => {
  it("falls back to stdout entry for unrecognized JSON event", () => {
    const line = JSON.stringify({ type: "something_else" });
    const result = parseOpenCodeStdoutLine(line, TS);
    expect(result[0]?.kind).toBe("stdout");
  });
});
