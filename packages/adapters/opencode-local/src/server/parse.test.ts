import { describe, expect, it } from "vitest";
import { parseOpenCodeJsonl, isOpenCodeUnknownSessionError } from "./parse.js";

describe("parseOpenCodeJsonl", () => {
  it("parses assistant text, usage, cost, and errors", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Hello from OpenCode" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_123",
        part: {
          reason: "done",
          cost: 0.0025,
          tokens: {
            input: 120,
            output: 40,
            reasoning: 10,
            cache: { read: 20, write: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "model unavailable" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Hello from OpenCode");
    expect(parsed.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
    expect(parsed.costUsd).toBeCloseTo(0.0025, 6);
    expect(parsed.errorMessage).toContain("model unavailable");
    expect(parsed.toolErrorMessages).toEqual([]);
  });

  it("keeps tool errors separate from terminal adapter errors", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Tried the tool" },
      }),
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          tool: "read",
          state: {
            status: "error",
            error: "File not found",
          },
        },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_123",
        part: {
          reason: "stop",
          cost: 0.001,
          tokens: {
            input: 10,
            output: 5,
            cache: { read: 0, write: 0 },
          },
        },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Tried the tool");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrorMessages).toEqual(["File not found"]);
  });

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });
});
