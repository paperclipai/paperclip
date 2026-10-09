import { describe, expect, it } from "vitest";
import { extractOpenCodeToolCallEvents, parseOpenCodeJsonl, isOpenCodeUnknownSessionError } from "./parse.js";

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

describe("extractOpenCodeToolCallEvents", () => {
  it("maps each tool-part update to a structured tool-call event", () => {
    const line = JSON.stringify({
      type: "tool_use",
      sessionID: "session_123",
      part: {
        id: "part_1",
        callID: "call_abc",
        tool: "bash",
        state: { status: "running", title: "ls -la" },
      },
    });
    expect(extractOpenCodeToolCallEvents(line)).toEqual([
      {
        eventType: "opencode.tool_call",
        stream: "stdout",
        message: "bash",
        payload: { name: "bash", toolCallId: "call_abc", status: "running" },
      },
    ]);
  });

  it("maps a completed tool part to its outcome", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        callID: "call_def",
        tool: "write",
        state: { status: "completed", title: "src/a.ts" },
      },
    });
    const events = extractOpenCodeToolCallEvents(line);
    expect(events[0]?.payload).toEqual({ name: "write", toolCallId: "call_def", status: "completed" });
  });

  it("maps an errored tool part", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        callID: "call_err",
        tool: "bash",
        state: { status: "error", error: "File not found" },
      },
    });
    const events = extractOpenCodeToolCallEvents(line);
    expect(events[0]?.payload.status).toBe("error");
    expect(events[0]?.payload.name).toBe("bash");
    expect(events[0]?.payload.toolCallId).toBe("call_err");
  });

  it("ignores non-tool and non-JSON lines", () => {
    expect(extractOpenCodeToolCallEvents(JSON.stringify({ type: "text", part: { text: "hi" } }))).toEqual([]);
    expect(extractOpenCodeToolCallEvents(JSON.stringify({ type: "step_finish", part: {} }))).toEqual([]);
    expect(extractOpenCodeToolCallEvents("not json at all")).toEqual([]);
    expect(extractOpenCodeToolCallEvents("")).toEqual([]);
    // A tool_use part with neither identity nor name cannot be recorded.
    expect(extractOpenCodeToolCallEvents(JSON.stringify({ type: "tool_use", part: { state: { status: "error" } } }))).toEqual([]);
  });
});
