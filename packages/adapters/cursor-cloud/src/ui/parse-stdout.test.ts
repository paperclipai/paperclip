import { describe, expect, it } from "vitest";
import { parseCursorCloudStdoutLine } from "./parse-stdout.js";

const ts = "2026-05-10T05:10:00.000Z";

describe("parseCursorCloudStdoutLine", () => {
  it("parses init and status events", () => {
    expect(
      parseCursorCloudStdoutLine(
        JSON.stringify({ type: "cursor_cloud.init", sessionId: "agent-123", model: "gpt-5.4" }),
        ts,
      ),
    ).toEqual([{ kind: "init", ts, sessionId: "agent-123", model: "gpt-5.4" }]);

    expect(
      parseCursorCloudStdoutLine(
        JSON.stringify({ type: "cursor_cloud.status", status: "running", message: "Reattached" }),
        ts,
      ),
    ).toEqual([{ kind: "system", ts, text: "running: Reattached" }]);
  });

  it("parses assistant text and tool lifecycle SDK messages", () => {
    const assistantLine = JSON.stringify({
      type: "cursor_cloud.message",
      message: {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Working on it." },
            { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "README.md" } },
          ],
        },
      },
    });
    expect(parseCursorCloudStdoutLine(assistantLine, ts)).toEqual([
      { kind: "assistant", ts, text: "Working on it." },
      { kind: "tool_call", ts, name: "read_file", toolUseId: "tool-1", input: { path: "README.md" } },
    ]);

    const toolStartLine = JSON.stringify({
      type: "cursor_cloud.message",
      message: {
        type: "tool_call",
        id: "call-1",
        name: "bash",
        status: "running",
        args: { command: "pwd" },
      },
    });
    expect(parseCursorCloudStdoutLine(toolStartLine, ts)).toEqual([
      { kind: "tool_call", ts, name: "bash", toolUseId: "call-1", input: { command: "pwd" } },
    ]);

    const toolEndLine = JSON.stringify({
      type: "cursor_cloud.message",
      message: {
        type: "tool_call",
        id: "call-1",
        name: "bash",
        status: "completed",
        result: { stdout: "/repo" },
      },
    });
    expect(parseCursorCloudStdoutLine(toolEndLine, ts)).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "call-1",
        toolName: "bash",
        content: JSON.stringify({ stdout: "/repo" }, null, 2),
        isError: false,
      },
    ]);
  });

  it("parses standalone tool_result SDK messages", () => {
    const line = JSON.stringify({
      type: "cursor_cloud.message",
      message: {
        type: "tool_result",
        call_id: "call-9",
        name: "read_file",
        result: { contents: "file body" },
      },
    });
    expect(parseCursorCloudStdoutLine(line, ts)).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "call-9",
        toolName: "read_file",
        content: JSON.stringify({ contents: "file body" }, null, 2),
        isError: false,
      },
    ]);

    const errorLine = JSON.stringify({
      type: "cursor_cloud.message",
      message: {
        type: "tool_result",
        call_id: "call-10",
        name: "bash",
        is_error: true,
        content: "exit 1",
      },
    });
    expect(parseCursorCloudStdoutLine(errorLine, ts)).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "call-10",
        toolName: "bash",
        content: "exit 1",
        isError: true,
      },
    ]);
  });

  it("parses result events and preserves unknown lines as stdout", () => {
    expect(
      parseCursorCloudStdoutLine(
        JSON.stringify({ type: "cursor_cloud.result", status: "finished", result: "Done", model: "gpt-5.4" }),
        ts,
      ),
    ).toEqual([
      {
        kind: "result",
        ts,
        text: "Done",
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "finished",
        isError: false,
        errors: [],
      },
    ]);

    expect(parseCursorCloudStdoutLine("plain text", ts)).toEqual([{ kind: "stdout", ts, text: "plain text" }]);
  });
});
