import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { parseCopilotStdoutLine } from "./parse-stdout.js";

const ts = "2026-03-20T13:38:34.000Z";

describe("parseCopilotStdoutLine", () => {
  it("returns stdout for non-JSON lines", () => {
    const entries = parseCopilotStdoutLine("plain text", ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("stdout");
  });

  it("parses session.tools_updated as init", () => {
    const line = JSON.stringify({
      type: "session.tools_updated",
      data: { model: "gpt-5-4" },
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("init");
    if (entries[0]!.kind === "init") {
      expect(entries[0]!.model).toBe("gpt-5-4");
    }
  });

  it("parses assistant.message_delta as streaming delta", () => {
    const line = JSON.stringify({
      type: "assistant.message_delta",
      data: { messageId: "m1", deltaContent: "hello" },
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("assistant");
    if (entries[0]!.kind === "assistant") {
      expect(entries[0]!.text).toBe("hello");
      expect(entries[0]!.delta).toBe(true);
    }
  });

  it("parses assistant.message with text content", () => {
    const line = JSON.stringify({
      type: "assistant.message",
      data: {
        messageId: "m1",
        content: "hello world",
        toolRequests: [],
        interactionId: "i1",
        outputTokens: 5,
      },
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries.some((e: TranscriptEntry) => e.kind === "assistant")).toBe(true);
  });

  it("parses assistant.message with tool requests", () => {
    const line = JSON.stringify({
      type: "assistant.message",
      data: {
        messageId: "m1",
        content: "",
        toolRequests: [
          {
            toolCallId: "tc1",
            name: "bash",
            arguments: { command: "ls" },
            type: "function",
          },
        ],
        interactionId: "i1",
        outputTokens: 10,
      },
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries.some((e: TranscriptEntry) => e.kind === "tool_call")).toBe(true);
    const toolCall = entries.find((e: TranscriptEntry) => e.kind === "tool_call");
    if (toolCall && toolCall.kind === "tool_call") {
      expect(toolCall.name).toBe("bash");
      expect(toolCall.toolUseId).toBe("tc1");
    }
  });

  it("parses tool.execution_start", () => {
    const line = JSON.stringify({
      type: "tool.execution_start",
      data: {
        toolCallId: "tc1",
        toolName: "bash",
        arguments: { command: "echo hi" },
      },
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("tool_call");
  });

  it("parses tool.execution_complete", () => {
    const line = JSON.stringify({
      type: "tool.execution_complete",
      data: {
        toolCallId: "tc1",
        model: "claude-sonnet-4.6",
        interactionId: "i1",
        success: true,
        result: { content: "output", detailedContent: "output" },
        toolTelemetry: {},
      },
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("tool_result");
    if (entries[0]!.kind === "tool_result") {
      expect(entries[0]!.content).toBe("output");
      expect(entries[0]!.isError).toBe(false);
    }
  });

  it("parses tool.execution_complete failure", () => {
    const line = JSON.stringify({
      type: "tool.execution_complete",
      data: {
        toolCallId: "tc2",
        success: false,
        result: { content: "command failed" },
      },
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    if (entries[0]!.kind === "tool_result") {
      expect(entries[0]!.isError).toBe(true);
    }
  });

  it("parses result event", () => {
    const line = JSON.stringify({
      type: "result",
      sessionId: "sess-123",
      exitCode: 0,
      usage: { premiumRequests: 1 },
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("result");
    if (entries[0]!.kind === "result") {
      expect(entries[0]!.isError).toBe(false);
    }
  });

  it("parses result event with non-zero exit code as error", () => {
    const line = JSON.stringify({
      type: "result",
      sessionId: "sess-123",
      exitCode: 1,
      usage: {},
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    if (entries[0]!.kind === "result") {
      expect(entries[0]!.isError).toBe(true);
    }
  });

  it("returns empty array for ephemeral session events", () => {
    const line = JSON.stringify({
      type: "session.mcp_servers_loaded",
      data: { servers: [] },
      ephemeral: true,
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(0);
  });

  it("parses reasoning delta", () => {
    const line = JSON.stringify({
      type: "assistant.reasoning_delta",
      data: { reasoningId: "r1", deltaContent: "thinking..." },
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("thinking");
  });

  it("parses user.message", () => {
    const line = JSON.stringify({
      type: "user.message",
      data: { content: "test prompt", transformedContent: "test prompt", attachments: [] },
    });
    const entries = parseCopilotStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("user");
  });
});
