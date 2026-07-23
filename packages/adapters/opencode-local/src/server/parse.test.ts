import { describe, expect, it } from "vitest";
import { parseOpenCodeJsonl, parseOpenCodeSessionExport, isOpenCodeUnknownSessionError } from "./parse.js";

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
    expect(parsed.toolErrors).toEqual([]);
  });

  it("keeps failed tool calls separate from fatal run errors", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          state: {
            status: "error",
            error: "File not found: e2b-adapter-result.txt",
          },
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Recovered and completed the task" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Recovered and completed the task");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrors).toEqual(["File not found: e2b-adapter-result.txt"]);
  });

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });
});

describe("parseOpenCodeSessionExport", () => {
  it("extracts assistant text and usage from opencode export JSON", () => {
    const exportJson = JSON.stringify({
      info: {
        cost: 0.001,
        tokens: { input: 100, output: 30, reasoning: 5, cache: { read: 10 } },
      },
      messages: [
        {
          info: { role: "user" },
          parts: [{ type: "text", text: "ignored" }],
        },
        {
          info: { role: "assistant" },
          parts: [
            { type: "text", text: "First paragraph" },
            { type: "text", text: "Second paragraph" },
          ],
        },
      ],
    });

    const parsed = parseOpenCodeSessionExport(exportJson);
    expect(parsed).not.toBeNull();
    expect(parsed!.summary).toBe("First paragraph\n\nSecond paragraph");
    expect(parsed!.usage).toEqual({
      inputTokens: 100,
      outputTokens: 35,
      cachedInputTokens: 10,
    });
    expect(parsed!.costUsd).toBeCloseTo(0.001, 6);
  });

  it("returns null for invalid JSON", () => {
    expect(parseOpenCodeSessionExport("not json")).toBeNull();
  });
});
