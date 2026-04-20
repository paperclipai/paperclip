import { describe, expect, it } from "vitest";
import { parseCopilotJsonl, isCopilotUnknownSessionError } from "./parse.js";

describe("parseCopilotJsonl", () => {
  it("parses assistant.message content + outputTokens, captures sessionId, premium and code changes", () => {
    const stdout = [
      JSON.stringify({
        type: "session.tools_updated",
        data: { model: "gpt-5.4" },
      }),
      JSON.stringify({
        type: "user.message",
        data: { content: "hi" },
      }),
      JSON.stringify({
        type: "assistant.message",
        data: { content: "Hello", toolRequests: [], outputTokens: 64 },
      }),
      JSON.stringify({
        type: "assistant.message",
        data: { content: "World", toolRequests: [], outputTokens: 16 },
      }),
      JSON.stringify({
        type: "tool.execution_complete",
        data: {
          toolCallId: "tc1",
          success: false,
          error: { message: "timeout", code: "failure" },
        },
      }),
      JSON.stringify({
        type: "result",
        sessionId: "9b877a00-e04c-4a8c-8434-a66b7ad30370",
        exitCode: 0,
        usage: {
          premiumRequests: 7.5,
          totalApiDurationMs: 9722,
          sessionDurationMs: 35812,
          codeChanges: { linesAdded: 1, linesRemoved: 2, filesModified: ["a.ts"] },
        },
      }),
    ].join("\n");

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.sessionId).toBe("9b877a00-e04c-4a8c-8434-a66b7ad30370");
    expect(parsed.summary).toBe("Hello\n\nWorld");
    expect(parsed.usage).toEqual({ inputTokens: 0, outputTokens: 80, cachedInputTokens: 0 });
    expect(parsed.costUsd).toBeNull();
    expect(parsed.premiumRequests).toBe(7.5);
    expect(parsed.totalApiDurationMs).toBe(9722);
    expect(parsed.sessionDurationMs).toBe(35812);
    expect(parsed.codeChanges).toEqual({ linesAdded: 1, linesRemoved: 2, filesModified: ["a.ts"] });
    expect(parsed.model).toBe("gpt-5.4");
    expect(parsed.errorMessage).toContain("timeout");
  });

  it("falls back to a premium-requests summary when no assistant text is present", () => {
    const stdout = JSON.stringify({
      type: "result",
      sessionId: "abc",
      exitCode: 0,
      usage: { premiumRequests: 2, totalApiDurationMs: 0, sessionDurationMs: 0, codeChanges: {} },
    });
    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.summary).toBe("[Copilot used 2 premium requests]");
  });

  it("parses SDK session events with assistant usage and shutdown metrics", () => {
    const sessionStartTime = Date.UTC(2026, 0, 1, 0, 0, 0);
    const shutdownTimestamp = new Date(sessionStartTime + 4_200).toISOString();
    const stdout = [
      JSON.stringify({
        type: "session.tools_updated",
        data: { model: "claude-opus-4.7" },
      }),
      JSON.stringify({
        type: "assistant.message",
        data: { content: "Done", outputTokens: 11 },
      }),
      JSON.stringify({
        type: "assistant.usage",
        data: {
          model: "claude-opus-4.7",
          inputTokens: 21,
          outputTokens: 11,
          cacheReadTokens: 5,
        },
      }),
      JSON.stringify({
        timestamp: shutdownTimestamp,
        type: "session.shutdown",
        data: {
          shutdownType: "routine",
          totalPremiumRequests: 3,
          totalApiDurationMs: 700,
          sessionStartTime,
          codeChanges: { linesAdded: 2, linesRemoved: 1, filesModified: ["a.ts"] },
          modelMetrics: {
            "claude-opus-4.7": {
              requests: { count: 1, cost: 1 },
              usage: {
                inputTokens: 21,
                outputTokens: 11,
                cacheReadTokens: 5,
                cacheWriteTokens: 0,
              },
            },
          },
          currentModel: "claude-opus-4.7",
        },
      }),
    ].join("\n");

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.summary).toBe("Done");
    expect(parsed.usage).toEqual({
      inputTokens: 21,
      outputTokens: 11,
      cachedInputTokens: 5,
    });
    expect(parsed.premiumRequests).toBe(3);
    expect(parsed.totalApiDurationMs).toBe(700);
    expect(parsed.sessionDurationMs).toBe(4_200);
    expect(parsed.codeChanges).toEqual({
      linesAdded: 2,
      linesRemoved: 1,
      filesModified: ["a.ts"],
    });
    expect(parsed.model).toBe("claude-opus-4.7");
  });

  it("ignores malformed JSON lines", () => {
    const stdout = ["not json", "", "{not valid"].join("\n");
    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.sessionId).toBeNull();
    expect(parsed.summary).toBe("");
    expect(parsed.errorMessage).toBeNull();
  });

  it("detects unknown session errors", () => {
    expect(isCopilotUnknownSessionError("Unknown session: abc", "")).toBe(true);
    expect(isCopilotUnknownSessionError("", "session id not found")).toBe(true);
    expect(isCopilotUnknownSessionError("no such session id", "")).toBe(true);
    expect(isCopilotUnknownSessionError("all good", "")).toBe(false);
  });
});
