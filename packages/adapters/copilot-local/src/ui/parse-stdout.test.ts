import { describe, expect, it } from "vitest";
import { parseCopilotLocalStdoutLine } from "./parse-stdout.js";

const ts = "2026-04-14T09:00:00.000Z";

describe("parseCopilotLocalStdoutLine", () => {
  // 1. message_delta → assistant delta entry
  it("parses assistant.message_delta into assistant delta entry", () => {
    const line = JSON.stringify({
      type: "assistant.message_delta",
      data: { messageId: "msg_1", deltaContent: "hello" },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([
      { kind: "assistant", ts, text: "hello", delta: true },
    ]);
  });

  it("returns empty for message_delta with empty deltaContent", () => {
    const line = JSON.stringify({
      type: "assistant.message_delta",
      data: { messageId: "msg_1", deltaContent: "" },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([]);
  });

  // 2. assistant.message with content → assistant entry
  it("parses assistant.message with content into assistant entry", () => {
    const line = JSON.stringify({
      type: "assistant.message",
      data: { content: "full response text" },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([
      { kind: "assistant", ts, text: "full response text" },
    ]);
  });

  // 3. assistant.message with toolRequests → assistant + tool_call entries
  it("parses assistant.message with toolRequests into assistant + tool_call entries", () => {
    const line = JSON.stringify({
      type: "assistant.message",
      data: {
        content: "Let me search for that.",
        toolRequests: [
          {
            toolCallId: "tc_1",
            name: "search",
            arguments: { query: "paperclip" },
          },
          {
            toolCallId: "tc_2",
            name: "read_file",
            arguments: { path: "/tmp/test.ts" },
          },
        ],
      },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([
      { kind: "assistant", ts, text: "Let me search for that." },
      {
        kind: "tool_call",
        ts,
        name: "search",
        toolUseId: "tc_1",
        input: { query: "paperclip" },
      },
      {
        kind: "tool_call",
        ts,
        name: "read_file",
        toolUseId: "tc_2",
        input: { path: "/tmp/test.ts" },
      },
    ]);
  });

  it("parses assistant.message with only toolRequests (no content)", () => {
    const line = JSON.stringify({
      type: "assistant.message",
      data: {
        content: "",
        toolRequests: [
          { toolCallId: "tc_3", name: "write_file", arguments: { path: "/tmp/out.txt" } },
        ],
      },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([
      {
        kind: "tool_call",
        ts,
        name: "write_file",
        toolUseId: "tc_3",
        input: { path: "/tmp/out.txt" },
      },
    ]);
  });

  it("returns empty for assistant.message with no content and no toolRequests", () => {
    const line = JSON.stringify({
      type: "assistant.message",
      data: { content: "" },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([]);
  });

  // 4. assistant.reasoning (readable) → thinking entry
  it("parses assistant.reasoning with readable content into thinking entry", () => {
    const line = JSON.stringify({
      type: "assistant.reasoning",
      data: { content: "I need to think about this problem carefully." },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([
      { kind: "thinking", ts, text: "I need to think about this problem carefully." },
    ]);
  });

  // 5. assistant.reasoning (encrypted-looking) → skipped
  it("skips assistant.reasoning with encrypted-looking content (>100 chars, no spaces)", () => {
    const encrypted = "a".repeat(200); // 200 chars, no spaces
    const line = JSON.stringify({
      type: "assistant.reasoning",
      data: { content: encrypted },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([]);
  });

  it("does not skip short reasoning without spaces (<= 100 chars)", () => {
    const shortNoSpaces = "a".repeat(50);
    const line = JSON.stringify({
      type: "assistant.reasoning",
      data: { content: shortNoSpaces },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([
      { kind: "thinking", ts, text: shortNoSpaces },
    ]);
  });

  // assistant.reasoning_delta → thinking delta entry
  it("parses assistant.reasoning_delta into thinking delta entry", () => {
    const line = JSON.stringify({
      type: "assistant.reasoning_delta",
      data: { deltaContent: "step 1: analyze" },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([
      { kind: "thinking", ts, text: "step 1: analyze", delta: true },
    ]);
  });

  it("skips assistant.reasoning_delta with encrypted-looking content", () => {
    const encrypted = "x".repeat(150);
    const line = JSON.stringify({
      type: "assistant.reasoning_delta",
      data: { deltaContent: encrypted },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([]);
  });

  // 6. tool.execution_start → empty array
  it("returns empty array for tool.execution_start", () => {
    const line = JSON.stringify({
      type: "tool.execution_start",
      data: { toolCallId: "tc_1", toolName: "search" },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([]);
  });

  // 7. tool.execution_complete success → tool_result with content
  it("parses tool.execution_complete success into tool_result entry", () => {
    const line = JSON.stringify({
      type: "tool.execution_complete",
      data: {
        toolCallId: "tc_1",
        success: true,
        result: { content: "Found 3 matches" },
        model: "gpt-5-mini",
      },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "tc_1",
        toolName: undefined,
        content: "Found 3 matches",
        isError: false,
      },
    ]);
  });

  it("prefers detailedContent over content in tool result", () => {
    const line = JSON.stringify({
      type: "tool.execution_complete",
      data: {
        toolCallId: "tc_1",
        success: true,
        result: { content: "short", detailedContent: "long detailed output" },
      },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "tc_1",
        toolName: undefined,
        content: "long detailed output",
        isError: false,
      },
    ]);
  });

  // 8. tool.execution_complete failure → tool_result with isError:true
  it("parses tool.execution_complete failure into tool_result with isError", () => {
    const line = JSON.stringify({
      type: "tool.execution_complete",
      data: {
        toolCallId: "tc_2",
        success: false,
        error: { message: "permission denied" },
      },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "tc_2",
        toolName: undefined,
        content: "permission denied",
        isError: true,
      },
    ]);
  });

  it("falls back to error code when error message is missing", () => {
    const line = JSON.stringify({
      type: "tool.execution_complete",
      data: {
        toolCallId: "tc_3",
        success: false,
        error: { code: "ENOENT" },
      },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "tc_3",
        toolName: undefined,
        content: "ENOENT",
        isError: true,
      },
    ]);
  });

  // 9. result event → result entry with session info text
  it("parses result event into result entry with session info", () => {
    const line = JSON.stringify({
      type: "result",
      sessionId: "sess_abc",
      exitCode: 0,
      usage: { premiumRequests: 0, sessionDurationMs: 30000 },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([
      {
        kind: "result",
        ts,
        text: "session: sess_abc, duration: 30s",
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "result",
        isError: false,
        errors: [],
      },
    ]);
  });

  it("includes premium requests and code changes in result text", () => {
    const line = JSON.stringify({
      type: "result",
      sessionId: "sess_xyz",
      exitCode: 0,
      usage: {
        premiumRequests: 5,
        sessionDurationMs: 60000,
        codeChanges: { linesAdded: 42, linesRemoved: 7 },
      },
    });
    const result = parseCopilotLocalStdoutLine(line, ts);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("result");
    expect((result[0] as { text: string }).text).toBe(
      "session: sess_xyz, premium: 5, duration: 60s, changes: +42/-7",
    );
  });

  it("shows 'completed' for result with no session info", () => {
    const line = JSON.stringify({ type: "result" });
    const result = parseCopilotLocalStdoutLine(line, ts);
    expect(result).toHaveLength(1);
    expect((result[0] as { text: string }).text).toBe("completed");
  });

  // 10. turn_start/turn_end → system entries
  it("parses assistant.turn_start into system entry", () => {
    const line = JSON.stringify({
      type: "assistant.turn_start",
      data: { turnId: "t1" },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([
      { kind: "system", ts, text: "turn t1 started" },
    ]);
  });

  it("parses assistant.turn_end into system entry", () => {
    const line = JSON.stringify({
      type: "assistant.turn_end",
      data: { turnId: "t1" },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([
      { kind: "system", ts, text: "turn t1 ended" },
    ]);
  });

  // 11. session.* → empty
  it("returns empty array for session.start", () => {
    const line = JSON.stringify({
      type: "session.start",
      data: { sessionId: "sess_abc" },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([]);
  });

  it("returns empty array for session.end", () => {
    const line = JSON.stringify({
      type: "session.end",
      data: { sessionId: "sess_abc" },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([]);
  });

  // 12. user.message → empty
  it("returns empty array for user.message", () => {
    const line = JSON.stringify({
      type: "user.message",
      data: { content: "Hello copilot" },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([]);
  });

  // 13. error → stderr entry
  it("parses error event into stderr entry", () => {
    const line = JSON.stringify({
      type: "error",
      data: { message: "something went wrong" },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([
      { kind: "stderr", ts, text: "something went wrong" },
    ]);
  });

  it("falls back to raw line for error with no message", () => {
    const line = JSON.stringify({ type: "error", data: {} });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([
      { kind: "stderr", ts, text: line },
    ]);
  });

  // 14. Multi-line chunk → multiple entries
  it("splits multi-line chunks and parses each sub-line", () => {
    const line1 = JSON.stringify({
      type: "assistant.message_delta",
      data: { deltaContent: "hello" },
    });
    const line2 = JSON.stringify({
      type: "assistant.message_delta",
      data: { deltaContent: " world" },
    });
    const multiLine = `${line1}\n${line2}`;
    expect(parseCopilotLocalStdoutLine(multiLine, ts)).toEqual([
      { kind: "assistant", ts, text: "hello", delta: true },
      { kind: "assistant", ts, text: " world", delta: true },
    ]);
  });

  it("ignores empty lines in multi-line chunks", () => {
    const line1 = JSON.stringify({
      type: "assistant.message_delta",
      data: { deltaContent: "content" },
    });
    const multiLine = `${line1}\n\n\n`;
    expect(parseCopilotLocalStdoutLine(multiLine, ts)).toEqual([
      { kind: "assistant", ts, text: "content", delta: true },
    ]);
  });

  // 15. Non-JSON line → stdout entry
  it("returns stdout entry for non-JSON line", () => {
    const line = "some plain text output";
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([
      { kind: "stdout", ts, text: "some plain text output" },
    ]);
  });

  it("returns stdout entry for malformed JSON", () => {
    const line = '{type: "broken';
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([
      { kind: "stdout", ts, text: line },
    ]);
  });

  // Skipped event types
  it("returns empty array for assistant.intent", () => {
    const line = JSON.stringify({
      type: "assistant.intent",
      data: { intent: "code_generation" },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([]);
  });

  it("returns empty array for assistant.usage", () => {
    const line = JSON.stringify({
      type: "assistant.usage",
      data: { tokens: 100 },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([]);
  });

  // Unknown event type → stdout passthrough
  it("passes unknown event types through as stdout", () => {
    const line = JSON.stringify({
      type: "custom.unknown_event",
      data: { foo: "bar" },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([
      { kind: "stdout", ts, text: line },
    ]);
  });

  // tool.execution_partial_result
  it("parses tool.execution_partial_result into tool_result entry", () => {
    const line = JSON.stringify({
      type: "tool.execution_partial_result",
      data: {
        toolCallId: "tc_5",
        success: true,
        result: { content: "partial output here" },
      },
    });
    expect(parseCopilotLocalStdoutLine(line, ts)).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "tc_5",
        toolName: undefined,
        content: "partial output here",
        isError: false,
      },
    ]);
  });
});
