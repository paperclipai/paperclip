import { describe, it, expect } from "vitest";
import { parseCopilotStdoutLine } from "./parse-stdout.js";

const ts = "2026-03-29T00:00:00.000Z";

describe("parseCopilotStdoutLine", () => {
  it("parses session.tools_updated as init", () => {
    const line = '{"type":"session.tools_updated","data":{"model":"gpt-5.4"},"ephemeral":true}';
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "init", model: "gpt-5.4" });
  });

  it("parses user.message", () => {
    const line = '{"type":"user.message","data":{"content":"hello world","attachments":[]}}';
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "user", text: "hello world" });
  });

  it("parses assistant.message with text", () => {
    const line = '{"type":"assistant.message","data":{"content":"hello","toolRequests":[],"outputTokens":5}}';
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "assistant", text: "hello" });
  });

  it("parses assistant.message with tool requests (Copilot format)", () => {
    const line = JSON.stringify({
      type: "assistant.message",
      data: {
        content: "",
        toolRequests: [
          { toolCallId: "call-1", name: "shell", arguments: { command: "ls" }, type: "function" },
        ],
        outputTokens: 10,
      },
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "tool_call",
      name: "shell",
      toolUseId: "call-1",
      input: { command: "ls" },
    });
  });

  it("parses assistant.message with both text and tool requests", () => {
    const line = JSON.stringify({
      type: "assistant.message",
      data: {
        content: "I'll run ls for you.",
        toolRequests: [
          { toolCallId: "call-1", name: "shell", arguments: { command: "ls" }, type: "function" },
        ],
        outputTokens: 15,
      },
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "assistant", text: "I'll run ls for you." });
    expect(entries[1]).toMatchObject({ kind: "tool_call", name: "shell", toolUseId: "call-1" });
  });

  it("parses assistant.message with string arguments in tool requests", () => {
    const line = JSON.stringify({
      type: "assistant.message",
      data: {
        content: "",
        toolRequests: [
          { toolCallId: "call-2", name: "read_file", arguments: '{"path":"/tmp/foo.txt"}', type: "function" },
        ],
        outputTokens: 5,
      },
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "tool_call",
      name: "read_file",
      toolUseId: "call-2",
      input: { path: "/tmp/foo.txt" },
    });
  });

  it("wraps malformed string arguments in { raw: ... }", () => {
    const line = JSON.stringify({
      type: "assistant.message",
      data: {
        content: "",
        toolRequests: [
          { toolCallId: "call-3", name: "test", arguments: "not valid json{", type: "function" },
        ],
      },
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "tool_call",
      name: "test",
      input: { raw: "not valid json{" },
    });
  });

  it("parses assistant.message_delta as streaming assistant", () => {
    const line = '{"type":"assistant.message_delta","data":{"deltaContent":"chunk"},"ephemeral":true}';
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "assistant", text: "chunk", delta: true });
  });

  it("parses assistant.reasoning as thinking", () => {
    const line = '{"type":"assistant.reasoning","data":{"reasoningText":"Let me think about this..."},"ephemeral":true}';
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "thinking", text: "Let me think about this..." });
  });

  it("parses assistant.reasoning_delta as streaming thinking", () => {
    const line = '{"type":"assistant.reasoning_delta","data":{"deltaContent":"reasoning chunk"},"ephemeral":true}';
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "thinking", text: "reasoning chunk", delta: true });
  });

  it("skips tool.execution_start (deduplication with assistant.message toolRequests)", () => {
    const line = '{"type":"tool.execution_start","data":{"toolName":"shell","toolCallId":"call-1","arguments":{"command":"ls"}}}';
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(0);
  });

  it("parses tool.execution_complete success with result.content", () => {
    const line = JSON.stringify({
      type: "tool.execution_complete",
      data: {
        toolName: "shell",
        toolCallId: "call-1",
        success: true,
        result: { content: "file1.txt\nfile2.txt" },
      },
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "tool_result",
      toolUseId: "call-1",
      toolName: "shell",
      content: "file1.txt\nfile2.txt",
      isError: false,
    });
  });

  it("parses tool.execution_complete failure with error.message", () => {
    const line = JSON.stringify({
      type: "tool.execution_complete",
      data: {
        toolName: "shell",
        toolCallId: "call-2",
        success: false,
        error: { message: "Permission denied", code: "EPERM" },
      },
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "tool_result",
      toolUseId: "call-2",
      toolName: "shell",
      content: "Permission denied",
      isError: true,
    });
  });

  it("handles tool.execution_complete error without message field", () => {
    const line = JSON.stringify({
      type: "tool.execution_complete",
      data: {
        toolCallId: "call-3",
        success: false,
        error: { code: "UNKNOWN" },
      },
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "tool_result", isError: true });
    // Falls back to JSON.stringify(errObj)
    expect((entries[0] as Record<string, unknown>).content).toContain("UNKNOWN");
  });

  it("handles tool.execution_complete success without result object", () => {
    const line = JSON.stringify({
      type: "tool.execution_complete",
      data: {
        toolCallId: "call-4",
        success: true,
      },
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "tool_result", isError: false, content: "" });
  });

  it("parses result event", () => {
    const line = '{"type":"result","sessionId":"abc-123","exitCode":0,"usage":{"premiumRequests":1,"totalApiDurationMs":5000,"sessionDurationMs":8000}}';
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "result",
      subtype: "success",
      isError: false,
    });
  });

  it("parses result with non-zero exit as error", () => {
    const line = '{"type":"result","sessionId":"abc-123","exitCode":1,"usage":{"premiumRequests":0}}';
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "result",
      subtype: "error",
      isError: true,
    });
    expect((entries[0] as Record<string, unknown>).errors).toContain("Copilot exited with code 1");
  });

  it("skips ephemeral events silently", () => {
    const line = '{"type":"session.mcp_server_status_changed","data":{"serverName":"notion","status":"connected"},"ephemeral":true}';
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(0);
  });

  it("returns stdout for non-JSON lines", () => {
    const entries = parseCopilotStdoutLine("plain text output", ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "stdout", text: "plain text output" });
  });

  // Edge cases

  it("handles empty string input", () => {
    const entries = parseCopilotStdoutLine("", ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "stdout", text: "" });
  });

  it("handles valid JSON that is not an object (number)", () => {
    const entries = parseCopilotStdoutLine("42", ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "stdout", text: "42" });
  });

  it("handles valid JSON that is not an object (array)", () => {
    const entries = parseCopilotStdoutLine("[1,2,3]", ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "stdout", text: "[1,2,3]" });
  });

  it("handles JSON null", () => {
    const entries = parseCopilotStdoutLine("null", ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "stdout", text: "null" });
  });

  it("handles event with missing data field", () => {
    const line = '{"type":"assistant.message"}';
    const entries = parseCopilotStdoutLine(line, ts);
    // No content, no toolRequests → falls through to stdout
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "stdout" });
  });

  it("handles assistant.message with empty content and empty toolRequests", () => {
    const line = JSON.stringify({
      type: "assistant.message",
      data: { content: "", toolRequests: [] },
    });
    const entries = parseCopilotStdoutLine(line, ts);
    // No entries produced → falls through to stdout
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "stdout" });
  });

  it("handles user.message with empty content", () => {
    const line = JSON.stringify({
      type: "user.message",
      data: { content: "" },
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "stdout" });
  });

  it("handles unrecognized event type", () => {
    const line = '{"type":"some.future.event","data":{"foo":"bar"}}';
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "stdout", text: line });
  });
});
