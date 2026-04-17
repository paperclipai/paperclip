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
  });

  it("ignores tool_use errors so they do not fail the run", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          name: "edit",
          state: {
            status: "error",
            error: "Error: Could not find oldString in the file.",
          },
        },
      }),
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          name: "read",
          state: {
            status: "error",
            error: "Error: Please read the file again before modifying it.",
          },
        },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.errorMessage).toBeNull();
  });

  it("collects fatal errors even if preceded by tool_use errors", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          name: "edit",
          state: {
            status: "error",
            error: "Error: Could not find oldString in the file.",
          },
        },
      }),
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "fatal connection error" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.errorMessage).toContain("fatal connection error");
    expect(parsed.errorMessage).not.toContain("oldString");
  });

  it("skips tool_use events regardless of status", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_456",
        part: {
          name: "bash",
          state: {
            status: "completed",
            result: "build succeeded",
          },
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_456",
        part: { text: "All tasks completed successfully" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_456",
        part: {
          reason: "done",
          cost: 0.001,
          tokens: {
            input: 80,
            output: 20,
            reasoning: 5,
            cache: { read: 10, write: 0 },
          },
        },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.summary).toBe("All tasks completed successfully");
    expect(parsed.usage).toEqual({
      inputTokens: 80,
      cachedInputTokens: 10,
      outputTokens: 25,
    });
  });

  it("realistic happy path with tool errors followed by successful completion", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_789",
        part: {
          name: "edit",
          state: {
            status: "error",
            error: "Error: Could not find oldString in the file.",
          },
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_789",
        part: { text: "Fixed the issue" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_789",
        part: {
          reason: "done",
          cost: 0.005,
          tokens: {
            input: 200,
            output: 60,
            reasoning: 15,
            cache: { read: 50, write: 0 },
          },
        },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.summary).toBe("Fixed the issue");
    expect(parsed.usage.inputTokens).toBeGreaterThan(0);
    expect(parsed.costUsd).toBeGreaterThan(0);
  });

  it("fails the run on permission auto-rejection tool errors", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_999",
        part: {
          name: "bash",
          state: {
            status: "error",
            error: "Error: permission requested: external_directory (/home/mja311/*); auto-rejecting",
          },
        },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.errorMessage).toContain("permission requested");
    expect(parsed.errorMessage).toContain("auto-rejecting");
  });

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });
});
