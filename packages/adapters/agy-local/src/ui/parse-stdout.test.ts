import { describe, expect, it } from "vitest";
import { parseAgyStdoutLine } from "./parse-stdout.js";

describe("parseAgyStdoutLine", () => {
  const ts = "2026-08-28T12:00:00.000Z";

  it("handles init event", () => {
    const line = JSON.stringify({
      event: "init",
      conversation_id: "conv-123",
      init: { cwd: "/app" },
    });
    const entries = parseAgyStdoutLine(line, ts);
    expect(entries).toEqual([
      {
        kind: "init",
        ts,
        model: "agy",
        sessionId: "conv-123",
      },
    ]);
  });

  it("handles assistant text delta", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        step_type: "agent_response",
        text_delta: "Working on the task...",
      },
    });
    const entries = parseAgyStdoutLine(line, ts);
    expect(entries).toEqual([
      {
        kind: "assistant",
        ts,
        text: "Working on the task...",
      },
    ]);
  });

  it("handles tool events", () => {
    const activeLine = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        step_type: "tool",
        tool_name: "list_dir",
        state: "ACTIVE",
        tool_info: {
          parameters: { DirectoryPath: "/app" },
        },
      },
    });
    const activeEntries = parseAgyStdoutLine(activeLine, ts);
    expect(activeEntries).toEqual([
      {
        kind: "tool_call",
        ts,
        name: "list_dir",
        toolUseId: "list_dir",
        input: { DirectoryPath: "/app" },
      },
    ]);

    const doneLine = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        step_type: "tool",
        tool_name: "list_dir",
        state: "DONE",
        tool_info: {
          parameters: { DirectoryPath: "/app" },
          output: "file1.txt\nfile2.txt",
        },
      },
    });
    const doneEntries = parseAgyStdoutLine(doneLine, ts);
    expect(doneEntries).toEqual([
      {
        kind: "tool_call",
        ts,
        name: "list_dir",
        toolUseId: "list_dir",
        input: { DirectoryPath: "/app" },
      },
      {
        kind: "tool_result",
        ts,
        toolUseId: "list_dir",
        content: "file1.txt\nfile2.txt",
        isError: false,
      },
    ]);
  });

  it("handles result event", () => {
    const line = JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conv-123",
        status: "SUCCESS",
        response: "All tasks completed.",
        duration_seconds: 2.5,
        usage: {
          input_tokens: 200,
          output_tokens: 50,
          cache_read_tokens: 100,
        },
      },
    });
    const entries = parseAgyStdoutLine(line, ts);
    expect(entries).toEqual([
      {
        kind: "result",
        ts,
        text: "All tasks completed.",
        inputTokens: 200,
        outputTokens: 50,
        cachedTokens: 100,
        costUsd: 0,
        subtype: "success",
        isError: false,
        errors: [],
      },
    ]);
  });

  it("handles assistant response with thinking and text delta", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        step_type: "agent_response",
        thinking: "Let me plan the next steps...",
        text_delta: "Here is the response.",
      },
    });
    const entries = parseAgyStdoutLine(line, ts);
    expect(entries).toEqual([
      {
        kind: "thinking",
        ts,
        text: "Let me plan the next steps...",
      },
      {
        kind: "assistant",
        ts,
        text: "Here is the response.",
      },
    ]);
  });

  it("handles tool output with JSON object payload", () => {
    const doneLine = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 3,
        step_type: "tool",
        tool_name: "custom_tool",
        tool_call_id: "call_abc123",
        state: "DONE",
        tool_info: {
          parameters: { query: "search terms" },
          output: { count: 2, items: ["item1", "item2"] },
        },
      },
    });
    const entries = parseAgyStdoutLine(doneLine, ts);
    expect(entries).toEqual([
      {
        kind: "tool_call",
        ts,
        name: "custom_tool",
        toolUseId: "call_abc123",
        input: { query: "search terms" },
      },
      {
        kind: "tool_result",
        ts,
        toolUseId: "call_abc123",
        content: JSON.stringify({ count: 2, items: ["item1", "item2"] }, null, 2),
        isError: false,
      },
    ]);
  });

  it("falls back to stdout entry for non-json lines", () => {
    const line = "Plain text output from process";
    const entries = parseAgyStdoutLine(line, ts);
    expect(entries).toEqual([
      {
        kind: "stdout",
        ts,
        text: line,
      },
    ]);
  });
});
