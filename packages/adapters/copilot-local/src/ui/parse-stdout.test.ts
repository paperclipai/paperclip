import { describe, expect, it } from "vitest";
import { createCopilotStdoutParser, parseCopilotStdoutLine } from "./parse-stdout.js";

const ts = "2026-04-23T00:00:00.000Z";

describe("parseCopilotStdoutLine", () => {
  it("parses assistant message events from nested data payload", () => {
    const line = JSON.stringify({
      type: "assistant.message",
      data: { content: "hello from copilot" },
    });

    expect(parseCopilotStdoutLine(line, ts)).toEqual([
      { kind: "assistant", ts, text: "hello from copilot" },
    ]);
  });

  it("parses tool execution start/complete events", () => {
    const start = JSON.stringify({
      type: "tool.execution_start",
      data: { toolCallId: "toolu_1", toolName: "bash", arguments: "pwd" },
    });
    const complete = JSON.stringify({
      type: "tool.execution_complete",
      data: {
        toolCallId: "toolu_1",
        toolName: "bash",
        success: true,
        result: { content: "/workspace/repo" },
      },
    });

    expect(parseCopilotStdoutLine(start, ts)).toEqual([
      { kind: "tool_call", ts, toolUseId: "toolu_1", name: "bash", input: "pwd" },
    ]);
    expect(parseCopilotStdoutLine(complete, ts)).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "toolu_1",
        toolName: "bash",
        content: "/workspace/repo",
        isError: false,
      },
    ]);
  });

  it("parses result events with init metadata and usage", () => {
    const line = JSON.stringify({
      type: "result",
      sessionId: "copilot-session-1",
      exitCode: 0,
      usage: {
        input_tokens: 120,
        output_tokens: 40,
        cached_input_tokens: 5,
      },
    });

    expect(parseCopilotStdoutLine(line, ts)).toEqual([
      {
        kind: "init",
        ts,
        model: "copilot",
        sessionId: "copilot-session-1",
      },
      {
        kind: "result",
        ts,
        text: "completed",
        inputTokens: 120,
        outputTokens: 40,
        cachedTokens: 5,
        costUsd: 0,
        subtype: "completed",
        isError: false,
        errors: [],
      },
    ]);
  });

  it("suppresses noisy session events", () => {
    const line = JSON.stringify({
      type: "session.skills_loaded",
      data: { skills: [] },
    });

    expect(parseCopilotStdoutLine(line, ts)).toEqual([]);
  });

  it("carries session.tools_updated model into the later result init entry", () => {
    const parser = createCopilotStdoutParser();

    expect(
      parser.parseLine(
        JSON.stringify({
          type: "session.tools_updated",
          data: { model: "claude-sonnet-4.6" },
        }),
        ts,
      ),
    ).toEqual([]);

    expect(
      parser.parseLine(
        JSON.stringify({
          type: "result",
          sessionId: "copilot-session-1",
          exitCode: 0,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "init",
        ts,
        model: "claude-sonnet-4.6",
        sessionId: "copilot-session-1",
      },
      {
        kind: "result",
        ts,
        text: "completed",
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "completed",
        isError: false,
        errors: [],
      },
    ]);
  });

  it("emits stderr entries for explicit error events", () => {
    const line = JSON.stringify({
      type: "error",
      data: { message: "authentication required" },
    });

    expect(parseCopilotStdoutLine(line, ts)).toEqual([
      { kind: "stderr", ts, text: "authentication required" },
    ]);
  });
});
