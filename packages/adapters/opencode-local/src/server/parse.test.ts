import { describe, expect, it } from "vitest";
import { parseOpenCodeJsonl, isOpenCodeUnknownSessionError } from "./parse.js";
import { parseOpenCodeStdoutLine } from "../ui/parse-stdout.js";

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

describe("parseOpenCodeJsonl v2 event shapes", () => {
  it("parses a v2 text-only run with no step_finish and zero usage", () => {
    // Ground truth A: v2.0.1 trivial run emits only step_start + text.
    const stdout = [
      JSON.stringify({
        type: "step_start",
        timestamp: 1790584396523,
        sessionID: "ses_A",
        part: {
          id: "prt_1",
          sessionID: "ses_A",
          messageID: "msg_1",
          type: "step-start",
        },
      }),
      JSON.stringify({
        type: "text",
        timestamp: 1790584397008,
        sessionID: "ses_A",
        part: {
          id: "prt_2_text-0",
          sessionID: "ses_A",
          messageID: "msg_1",
          type: "text",
          text: "PONG",
          time: { start: 1790584396523, end: 1790584397008 },
        },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("ses_A");
    expect(parsed.summary).toBe("PONG");
    expect(parsed.usage).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(parsed.costUsd).toBe(0);
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrors).toEqual([]);
  });

  it("parses a v2 tool-using run across snake envelopes and kebab parts", () => {
    // Ground truth B: envelope `type` snake_case, part.type kebab-case, and a
    // step_finish part whose keys are exactly
    // ["cost","id","messageID","reason","sessionID","tokens","type"].
    const stdout = [
      JSON.stringify({
        type: "step_start",
        timestamp: 1790584396523,
        sessionID: "ses_B",
        part: {
          id: "prt_s1",
          sessionID: "ses_B",
          messageID: "msg_1",
          type: "step-start",
        },
      }),
      JSON.stringify({
        type: "tool_use",
        timestamp: 1790584396600,
        sessionID: "ses_B",
        part: {
          id: "prt_t1",
          sessionID: "ses_B",
          messageID: "msg_1",
          type: "tool",
          callID: "call_1",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "echo hi" },
            output: "hi\n",
          },
        },
      }),
      JSON.stringify({
        type: "step_finish",
        timestamp: 1790584396700,
        sessionID: "ses_B",
        part: {
          id: "prt_f1",
          sessionID: "ses_B",
          messageID: "msg_1",
          type: "step-finish",
          reason: "tool-calls",
          cost: 0,
          tokens: {
            input: 7540,
            output: 17,
            reasoning: 37,
            cache: { read: 3200, write: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "step_start",
        timestamp: 1790584396800,
        sessionID: "ses_B",
        part: {
          id: "prt_s2",
          sessionID: "ses_B",
          messageID: "msg_1",
          type: "step-start",
        },
      }),
      JSON.stringify({
        type: "text",
        timestamp: 1790584397008,
        sessionID: "ses_B",
        part: {
          id: "prt_2_text-0",
          sessionID: "ses_B",
          messageID: "msg_1",
          type: "text",
          text: "Done",
          time: { start: 1790584396800, end: 1790584397008 },
        },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("ses_B");
    expect(parsed.summary).toBe("Done");
    expect(parsed.usage).toEqual({
      inputTokens: 7540,
      cachedInputTokens: 3200,
      outputTokens: 54,
    });
    expect(parsed.costUsd).toBe(0);
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrors).toEqual([]);
  });

  it("records a v2 non-JSONL error envelope instead of reporting success", () => {
    // Ground truth C: a cancelled v2 run prints this single object.
    const stdout = JSON.stringify({
      error: { type: "unknown", message: "Command cancelled" },
      content: [],
    });

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.errorMessage).toBe("Command cancelled");
  });

  it("falls back to the error type when a v2 error envelope has no message", () => {
    const stdout = JSON.stringify({ error: { type: "unknown" }, content: [] });

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.errorMessage).toBe("unknown");
  });

  it("tolerates unknown event types and unparseable lines without failing", () => {
    const stdout = [
      "not json at all",
      JSON.stringify({ type: "future_event", payload: { nested: true } }),
      JSON.stringify({
        type: "text",
        sessionID: "ses_C",
        part: { type: "text", text: "still works" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("ses_C");
    expect(parsed.summary).toBe("still works");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.usage).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
  });

  it("detects v2 stale-session failure wording", () => {
    expect(isOpenCodeUnknownSessionError('{"error":{"type":"unknown","message":"Invalid session"}}', "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "session does not exist")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "no such session")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "failed to load session ses_missing")).toBe(true);
    expect(
      isOpenCodeUnknownSessionError('{"type":"step_finish","part":{"reason":"stop"}}', ""),
    ).toBe(false);
  });
});

describe("parseOpenCodeStdoutLine v2 event shapes", () => {
  const ts = "2026-03-04T00:00:00.000Z";

  it("surfaces a v2 non-JSONL error envelope as stderr", () => {
    const entries = parseOpenCodeStdoutLine(
      JSON.stringify({
        error: { type: "unknown", message: "Command cancelled" },
        content: [],
      }),
      ts,
    );

    expect(entries).toEqual([
      { kind: "stderr", ts, text: "Command cancelled" },
    ]);
  });

  it("treats a v2 text-only run as a single assistant message", () => {
    expect(
      parseOpenCodeStdoutLine(
        JSON.stringify({
          type: "text",
          timestamp: 1790584397008,
          sessionID: "ses_A",
          part: {
            id: "prt_2_text-0",
            type: "text",
            text: "PONG",
            time: { start: 1790584396523, end: 1790584397008 },
          },
        }),
        ts,
      ),
    ).toEqual([{ kind: "assistant", ts, text: "PONG" }]);
  });
});
