import { describe, expect, it } from "vitest";
import { isCopilotUnknownSessionError, parseCopilotJsonOutput } from "./parse.js";

describe("parseCopilotJsonOutput", () => {
  it("parses wrapped Copilot JSON events with assistant summary and session id", () => {
    const stdout = [
      JSON.stringify({
        type: "session.tools_updated",
        data: { model: "claude-sonnet-4.6" },
      }),
      JSON.stringify({
        type: "assistant.message",
        data: {
          content: "",
          outputTokens: 134,
          toolRequests: [{ id: "toolu_1", toolName: "bash", arguments: "pwd" }],
        },
      }),
      JSON.stringify({
        type: "tool.execution_start",
        data: { toolCallId: "toolu_1", toolName: "bash", arguments: "pwd" },
      }),
      JSON.stringify({
        type: "tool.execution_complete",
        data: {
          toolCallId: "toolu_1",
          toolName: "bash",
          success: true,
          result: { content: "/workspace/repo" },
        },
      }),
      JSON.stringify({
        type: "assistant.message",
        data: {
          content: "Done. Updated adapter wiring.",
          outputTokens: 182,
        },
      }),
      JSON.stringify({
        type: "result",
        sessionId: "copilot-session-1",
        exitCode: 0,
        usage: {
          premiumRequests: 3,
        },
      }),
    ].join("\n");

    expect(parseCopilotJsonOutput(stdout)).toEqual({
      sessionId: "copilot-session-1",
      summary: "Done. Updated adapter wiring.",
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 182,
      },
      costUsd: null,
      errorMessage: null,
    });
  });

  it("treats plain-text error output as an error message", () => {
    const stdout =
      "Error: invalid value 'task-123' for '--resume [<SESSION_ID>]': value is not a valid uuid";

    expect(parseCopilotJsonOutput(stdout)).toEqual({
      sessionId: null,
      summary: "",
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
      costUsd: null,
      errorMessage:
        "Error: invalid value 'task-123' for '--resume [<SESSION_ID>]': value is not a valid uuid",
    });
  });
});

describe("isCopilotUnknownSessionError", () => {
  it("detects stale/unknown resume session errors from Copilot", () => {
    expect(
      isCopilotUnknownSessionError("", "Error: unknown session id abc"),
    ).toBe(true);
    expect(
      isCopilotUnknownSessionError("", "resume failed: session not found"),
    ).toBe(true);
    expect(
      isCopilotUnknownSessionError("", "No session or task matched for '--resume=9d3f...'"),
    ).toBe(true);
    expect(
      isCopilotUnknownSessionError(
        "",
        "Error: invalid value 'task-123' for '--resume [<SESSION_ID>]': value is not a valid uuid",
      ),
    ).toBe(true);
  });

  it("does not classify unrelated errors as session misses", () => {
    expect(
      isCopilotUnknownSessionError("", "Error: network timeout"),
    ).toBe(false);
  });
});
