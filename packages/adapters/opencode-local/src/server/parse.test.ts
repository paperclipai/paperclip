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

  it("tracks structured telemetry counters", () => {
    const base = { sessionID: "s1" };
    const t0 = "2026-01-01T00:00:00.000Z";
    const t1 = "2026-01-01T00:00:01.000Z";
    const t2 = "2026-01-01T00:00:02.000Z";
    const t3 = "2026-01-01T00:00:03.000Z";
    const t4 = "2026-01-01T00:00:04.000Z";
    const stdout = [
      JSON.stringify({ ...base, type: "step_start", ts: t0 }),
      JSON.stringify({ ...base, type: "tool_use", ts: t1, part: { tool: "grep", state: { status: "completed" } } }),
      JSON.stringify({ ...base, type: "tool_use", ts: t2, part: { tool: "write", state: { status: "completed" } } }),
      JSON.stringify({ ...base, type: "tool_use", ts: t3, part: { tool: "bash", state: { status: "error", error: "fail" } } }),
      JSON.stringify({ ...base, type: "tool_use", ts: t4, part: { tool: "vitest", state: { status: "completed" } } }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    const t = parsed.telemetry;
    expect(t.toolCalls).toBe(4);
    expect(t.failedToolCalls).toBe(1);
    expect(t.searchCalls).toBe(1);
    expect(t.fileWrites).toBe(1);
    expect(t.bashCalls).toBe(1);
    expect(t.testCalls).toBe(1);
    expect(t.stepCount).toBe(1);
    expect(t.timeToFirstWriteMs).toBe(2000);
    expect(t.timeToFirstTestMs).toBe(4000);
    expect(t.firstEventAt).toBe(t0);
    expect(t.lastEventAt).toBe(t4);
  });

  it("returns null timeToFirstWriteMs when no write tools used", () => {
    const stdout = [
      JSON.stringify({ sessionID: "s1", type: "tool_use", ts: "2026-01-01T00:00:00.000Z", part: { tool: "grep", state: { status: "completed" } } }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.telemetry.timeToFirstWriteMs).toBeNull();
    expect(parsed.telemetry.timeToFirstTestMs).toBeNull();
    expect(parsed.telemetry.toolCalls).toBe(1);
    expect(parsed.telemetry.searchCalls).toBe(1);
  });
});
