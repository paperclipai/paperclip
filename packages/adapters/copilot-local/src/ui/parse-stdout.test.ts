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

  it("parses tool.execution_start with data.arguments", () => {
    const line = '{"type":"tool.execution_start","data":{"toolName":"shell","toolCallId":"call-1","arguments":{"command":"ls"}}}';
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "tool_call", name: "shell", toolUseId: "call-1", input: { command: "ls" } });
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
});
