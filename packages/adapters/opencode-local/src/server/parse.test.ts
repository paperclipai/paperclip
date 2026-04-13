import { describe, expect, it } from "vitest";
import { parseOpenCodeJsonl, isOpenCodeUnknownSessionError } from "./parse.js";

function jsonl(...events: Record<string, unknown>[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

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

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });
});

describe("parseOpenCodeJsonl hasBackgroundDelegation", () => {
  it("detects tool_use with name=task and run_in_background=true", () => {
    const stdout = jsonl(
      { type: "text", part: { text: "Delegating work" } },
      {
        type: "tool_use",
        part: {
          name: "task",
          input: {
            subagent_type: "explore",
            load_skills: [],
            description: "Find patterns",
            prompt: "Search for X",
            run_in_background: true,
          },
          state: { status: "done" },
        },
      },
    );

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.hasBackgroundDelegation).toBe(true);
  });

  it("returns false when task tool uses run_in_background=false", () => {
    const stdout = jsonl(
      {
        type: "tool_use",
        part: {
          name: "task",
          input: {
            subagent_type: "explore",
            load_skills: [],
            description: "Find patterns",
            prompt: "Search for X",
            run_in_background: false,
          },
          state: { status: "done" },
        },
      },
    );

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.hasBackgroundDelegation).toBe(false);
  });

  it("returns false when run_in_background is missing", () => {
    const stdout = jsonl(
      {
        type: "tool_use",
        part: {
          name: "task",
          input: {
            subagent_type: "explore",
            load_skills: [],
            description: "Find patterns",
            prompt: "Search for X",
          },
          state: { status: "done" },
        },
      },
    );

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.hasBackgroundDelegation).toBe(false);
  });

  it("returns false for non-task tool calls", () => {
    const stdout = jsonl(
      {
        type: "tool_use",
        part: {
          name: "bash",
          input: { command: "ls -la" },
          state: { status: "done" },
        },
      },
    );

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.hasBackgroundDelegation).toBe(false);
  });

  it("returns false when there are no tool_use events", () => {
    const stdout = jsonl(
      { type: "text", part: { text: "No tools used" } },
    );

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.hasBackgroundDelegation).toBe(false);
  });

  it("returns true when one of multiple tool calls is a background delegation", () => {
    const stdout = jsonl(
      {
        type: "tool_use",
        part: {
          name: "bash",
          input: { command: "ls" },
          state: { status: "done" },
        },
      },
      {
        type: "tool_use",
        part: {
          name: "task",
          input: {
            description: "Deep research",
            prompt: "Find X",
            run_in_background: true,
          },
          state: { status: "done" },
        },
      },
      {
        type: "tool_use",
        part: {
          name: "read",
          input: { filePath: "/tmp/file.txt" },
          state: { status: "done" },
        },
      },
    );

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.hasBackgroundDelegation).toBe(true);
  });

  it("returns false for empty input", () => {
    const parsed = parseOpenCodeJsonl("");
    expect(parsed.hasBackgroundDelegation).toBe(false);
  });

  it("returns false for malformed JSON lines", () => {
    const parsed = parseOpenCodeJsonl("not json\n{broken");
    expect(parsed.hasBackgroundDelegation).toBe(false);
  });
});
