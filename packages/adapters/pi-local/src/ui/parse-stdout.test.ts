import { afterEach, describe, expect, it } from "vitest";
import { parsePiStdoutLine, resetParserState } from "./parse-stdout.js";

const TS = "2026-04-17T00:00:00.000Z";

afterEach(() => {
  resetParserState();
});

// ============================================================================
// Non-JSON lines
// ============================================================================

describe("parsePiStdoutLine — non-JSON input", () => {
  it("returns empty array for blank line", () => {
    expect(parsePiStdoutLine("", TS)).toEqual([]);
  });

  it("returns stdout entry for plain text", () => {
    const result = parsePiStdoutLine("hello world", TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "stdout", text: "hello world", ts: TS });
  });

  it("returns empty array for whitespace-only line", () => {
    expect(parsePiStdoutLine("   ", TS)).toEqual([]);
  });
});

// ============================================================================
// RPC protocol messages — filtered out
// ============================================================================

describe("parsePiStdoutLine — RPC protocol messages", () => {
  it("filters out response events", () => {
    const line = JSON.stringify({ type: "response", data: {} });
    expect(parsePiStdoutLine(line, TS)).toEqual([]);
  });

  it("filters out extension_ui_request events", () => {
    const line = JSON.stringify({ type: "extension_ui_request" });
    expect(parsePiStdoutLine(line, TS)).toEqual([]);
  });

  it("filters out extension_ui_response events", () => {
    const line = JSON.stringify({ type: "extension_ui_response" });
    expect(parsePiStdoutLine(line, TS)).toEqual([]);
  });

  it("filters out extension_error events", () => {
    const line = JSON.stringify({ type: "extension_error" });
    expect(parsePiStdoutLine(line, TS)).toEqual([]);
  });
});

// ============================================================================
// Agent lifecycle events
// ============================================================================

describe("parsePiStdoutLine — agent_start", () => {
  it("returns a system entry for agent_start", () => {
    const line = JSON.stringify({ type: "agent_start" });
    const result = parsePiStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "system", ts: TS });
    const entry = result[0] as { text: string };
    expect(entry.text).toContain("Pi agent started");
  });
});

describe("parsePiStdoutLine — agent_end", () => {
  it("returns system 'finished' entry when no messages", () => {
    const line = JSON.stringify({ type: "agent_end" });
    const result = parsePiStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "system", ts: TS });
    const entry = result[0] as { text: string };
    expect(entry.text).toContain("finished");
  });

  it("extracts assistant text from final messages array", () => {
    const line = JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "I'm done." }],
        },
      ],
    });
    const result = parsePiStdoutLine(line, TS);
    const assistantEntry = result.find((e) => e.kind === "assistant");
    expect(assistantEntry).toBeDefined();
    expect(assistantEntry?.text).toBe("I'm done.");
  });
});

// ============================================================================
// Turn lifecycle
// ============================================================================

describe("parsePiStdoutLine — turn lifecycle", () => {
  it("returns empty array for turn_start", () => {
    const line = JSON.stringify({ type: "turn_start" });
    expect(parsePiStdoutLine(line, TS)).toEqual([]);
  });

  it("returns empty array for turn_end with no message and no toolResults", () => {
    const line = JSON.stringify({ type: "turn_end" });
    expect(parsePiStdoutLine(line, TS)).toEqual([]);
  });

  it("extracts assistant text from turn_end message", () => {
    const line = JSON.stringify({
      type: "turn_end",
      message: { content: "Turn complete" },
    });
    const result = parsePiStdoutLine(line, TS);
    const assistantEntry = result.find((e) => e.kind === "assistant");
    expect(assistantEntry?.text).toBe("Turn complete");
  });

  it("extracts thinking from turn_end content array", () => {
    const line = JSON.stringify({
      type: "turn_end",
      message: {
        content: [
          { type: "thinking", thinking: "My reasoning" },
          { type: "text", text: "Answer" },
        ],
      },
    });
    const result = parsePiStdoutLine(line, TS);
    expect(result.some((e) => e.kind === "thinking" && e.text === "My reasoning")).toBe(true);
    expect(result.some((e) => e.kind === "assistant" && e.text === "Answer")).toBe(true);
  });
});

// ============================================================================
// Message streaming events
// ============================================================================

describe("parsePiStdoutLine — message streaming", () => {
  it("returns empty array for message_start", () => {
    const line = JSON.stringify({ type: "message_start" });
    expect(parsePiStdoutLine(line, TS)).toEqual([]);
  });

  it("returns empty array for message_update with no assistantMessageEvent", () => {
    const line = JSON.stringify({ type: "message_update" });
    expect(parsePiStdoutLine(line, TS)).toEqual([]);
  });

  it("returns thinking delta entry for thinking_delta event", () => {
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "hmm..." },
    });
    const result = parsePiStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "thinking", text: "hmm...", delta: true });
  });

  it("returns assistant delta entry for text_delta event", () => {
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello " },
    });
    const result = parsePiStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "assistant", text: "Hello ", delta: true });
  });

  it("returns full thinking block for thinking_end event", () => {
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", content: "Full thoughts" },
    });
    const result = parsePiStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "thinking", text: "Full thoughts" });
    expect((result[0] as { delta?: boolean }).delta).toBeUndefined();
  });

  it("returns full assistant block for text_end event", () => {
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", content: "Full answer" },
    });
    const result = parsePiStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "assistant", text: "Full answer" });
  });

  it("returns empty array for message_end with no message", () => {
    const line = JSON.stringify({ type: "message_end" });
    expect(parsePiStdoutLine(line, TS)).toEqual([]);
  });
});

// ============================================================================
// Tool execution events
// ============================================================================

describe("parsePiStdoutLine — tool execution", () => {
  it("returns tool_call entry for tool_execution_start", () => {
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "Read",
      args: { path: "/tmp/foo.ts" },
    });
    const result = parsePiStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "tool_call",
      name: "Read",
      toolUseId: "call-1",
    });
  });

  it("returns empty array for tool_execution_update", () => {
    const line = JSON.stringify({ type: "tool_execution_update" });
    expect(parsePiStdoutLine(line, TS)).toEqual([]);
  });

  it("returns tool_result for tool_execution_end with string result", () => {
    const line = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call-2",
      toolName: "Bash",
      result: "output text",
      isError: false,
    });
    const result = parsePiStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "tool_result",
      toolUseId: "call-2",
      toolName: "Bash",
      content: "output text",
      isError: false,
    });
  });

  it("marks tool_result as error when isError=true", () => {
    const line = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call-err",
      toolName: "Bash",
      result: "error msg",
      isError: true,
    });
    const result = parsePiStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "tool_result", isError: true });
  });
});

// ============================================================================
// Unknown event type fallback
// ============================================================================

describe("parsePiStdoutLine — unknown event type", () => {
  it("falls back to stdout entry for unknown JSON event", () => {
    const line = JSON.stringify({ type: "something_unknown", data: 42 });
    const result = parsePiStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("stdout");
  });
});
