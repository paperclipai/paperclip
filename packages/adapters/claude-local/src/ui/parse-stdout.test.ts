import { describe, expect, it } from "vitest";
import { parseClaudeStdoutLine } from "./parse-stdout.js";

const TS = "2026-04-18T00:00:00.000Z";

// ============================================================================
// Non-JSON lines
// ============================================================================

describe("parseClaudeStdoutLine — non-JSON input", () => {
  it("returns stdout entry for plain text", () => {
    const result = parseClaudeStdoutLine("hello world", TS);
    expect(result).toEqual([{ kind: "stdout", ts: TS, text: "hello world" }]);
  });

  it("returns stdout entry for empty string", () => {
    const result = parseClaudeStdoutLine("", TS);
    expect(result).toEqual([{ kind: "stdout", ts: TS, text: "" }]);
  });

  it("returns stdout entry for invalid JSON", () => {
    const result = parseClaudeStdoutLine("{not json}", TS);
    expect(result).toEqual([{ kind: "stdout", ts: TS, text: "{not json}" }]);
  });
});

// ============================================================================
// system/init
// ============================================================================

describe("parseClaudeStdoutLine — system init", () => {
  it("returns init entry with model and sessionId", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      model: "claude-opus-4-5",
      session_id: "sess-abc123",
    });
    expect(parseClaudeStdoutLine(line, TS)).toEqual([
      { kind: "init", ts: TS, model: "claude-opus-4-5", sessionId: "sess-abc123" },
    ]);
  });

  it("falls back to 'unknown' model when model is missing", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", session_id: "x" });
    const result = parseClaudeStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "init", model: "unknown", sessionId: "x" });
  });

  it("uses empty sessionId when session_id is missing", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", model: "claude-haiku" });
    const result = parseClaudeStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "init", sessionId: "" });
  });

  it("falls through to stdout for non-init system events", () => {
    const line = JSON.stringify({ type: "system", subtype: "other" });
    const result = parseClaudeStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "stdout" });
  });
});

// ============================================================================
// assistant messages
// ============================================================================

describe("parseClaudeStdoutLine — assistant text", () => {
  it("returns assistant entry for text block", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello!" }] },
    });
    expect(parseClaudeStdoutLine(line, TS)).toEqual([
      { kind: "assistant", ts: TS, text: "Hello!" },
    ]);
  });

  it("returns thinking entry for thinking block", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "Let me think..." }] },
    });
    expect(parseClaudeStdoutLine(line, TS)).toEqual([
      { kind: "thinking", ts: TS, text: "Let me think..." },
    ]);
  });

  it("returns tool_call entry for tool_use block", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_01abc",
            name: "bash",
            input: { command: "ls" },
          },
        ],
      },
    });
    expect(parseClaudeStdoutLine(line, TS)).toEqual([
      {
        kind: "tool_call",
        ts: TS,
        name: "bash",
        toolUseId: "toolu_01abc",
        input: { command: "ls" },
      },
    ]);
  });

  it("uses tool_use_id fallback when id is missing", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            tool_use_id: "toolu_fallback",
            name: "read_file",
            input: { path: "/tmp/x" },
          },
        ],
      },
    });
    const result = parseClaudeStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "tool_call", toolUseId: "toolu_fallback" });
  });

  it("returns multiple entries for mixed content blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "First" },
          { type: "text", text: "Second" },
        ],
      },
    });
    const result = parseClaudeStdoutLine(line, TS);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ kind: "assistant", text: "First" });
    expect(result[1]).toMatchObject({ kind: "assistant", text: "Second" });
  });

  it("falls back to stdout for assistant with empty content", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [] } });
    const result = parseClaudeStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "stdout" });
  });

  it("skips text blocks with empty text", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "" }] },
    });
    const result = parseClaudeStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "stdout" });
  });

  it("defaults tool_use name to 'unknown' when missing", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "x", input: {} }] },
    });
    const result = parseClaudeStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "tool_call", name: "unknown" });
  });
});

// ============================================================================
// user messages
// ============================================================================

describe("parseClaudeStdoutLine — user messages", () => {
  it("returns user entry for user text block", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "Do this" }] },
    });
    expect(parseClaudeStdoutLine(line, TS)).toEqual([
      { kind: "user", ts: TS, text: "Do this" },
    ]);
  });

  it("returns tool_result entry for tool_result block with string content", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01abc",
            content: "output text",
            is_error: false,
          },
        ],
      },
    });
    expect(parseClaudeStdoutLine(line, TS)).toEqual([
      {
        kind: "tool_result",
        ts: TS,
        toolUseId: "toolu_01abc",
        content: "output text",
        isError: false,
      },
    ]);
  });

  it("returns tool_result with isError=true when is_error is true", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_err",
            content: "fail",
            is_error: true,
          },
        ],
      },
    });
    const result = parseClaudeStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "tool_result", isError: true });
  });

  it("joins array content parts for tool_result", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "part1" },
              { type: "text", text: "part2" },
            ],
          },
        ],
      },
    });
    const result = parseClaudeStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "tool_result", content: "part1\npart2" });
  });
});

// ============================================================================
// result events
// ============================================================================

describe("parseClaudeStdoutLine — result", () => {
  it("returns result entry with token counts and cost", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "done",
      is_error: false,
      total_cost_usd: 0.0012,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20,
      },
    });
    expect(parseClaudeStdoutLine(line, TS)).toEqual([
      {
        kind: "result",
        ts: TS,
        text: "done",
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 20,
        costUsd: 0.0012,
        subtype: "success",
        isError: false,
        errors: [],
      },
    ]);
  });

  it("returns result with isError=true when is_error is set", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: true,
      subtype: "error",
      usage: {},
      errors: ["something broke"],
    });
    const result = parseClaudeStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "result", isError: true, errors: ["something broke"] });
  });

  it("defaults missing usage fields to 0", () => {
    const line = JSON.stringify({ type: "result", usage: {} });
    const result = parseClaudeStdoutLine(line, TS);
    expect(result[0]).toMatchObject({
      kind: "result",
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
    });
  });

  it("uses empty string subtype when not provided", () => {
    const line = JSON.stringify({ type: "result", usage: {} });
    const result = parseClaudeStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "result", subtype: "" });
  });

  it("filters non-string error entries", () => {
    const line = JSON.stringify({
      type: "result",
      usage: {},
      errors: [{ message: "oops" }, null, "string error"],
    });
    const result = parseClaudeStdoutLine(line, TS);
    // Non-string errors are stringified via errorText helper
    const resultEntry = result[0] as { kind: string; errors: string[] };
    expect(resultEntry.errors).toContain("string error");
  });
});

// ============================================================================
// fallback
// ============================================================================

describe("parseClaudeStdoutLine — unknown type fallback", () => {
  it("returns stdout entry for unknown JSON type", () => {
    const line = JSON.stringify({ type: "unknown_event", data: 42 });
    const result = parseClaudeStdoutLine(line, TS);
    expect(result).toEqual([{ kind: "stdout", ts: TS, text: line }]);
  });

  it("returns stdout entry for JSON without type field", () => {
    const line = JSON.stringify({ foo: "bar" });
    const result = parseClaudeStdoutLine(line, TS);
    expect(result).toEqual([{ kind: "stdout", ts: TS, text: line }]);
  });
});
