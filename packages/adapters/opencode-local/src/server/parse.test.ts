import { describe, expect, it } from "vitest";
import {
  isOpenCodeProviderAdmissionError,
  isOpenCodeUnknownSessionError,
  parseOpenCodeJsonl,
} from "./parse.js";

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

  it("detects provider admission failures that require a fresh session", () => {
    expect(
      isOpenCodeProviderAdmissionError("failed to read request body (ref: abc)", ""),
    ).toBe(true);
    expect(
      isOpenCodeProviderAdmissionError(
        "",
        "Too many images were provided, we currently limit the number of images per conversation to 60",
      ),
    ).toBe(true);
    expect(isOpenCodeProviderAdmissionError("spawn E2BIG", "")).toBe(true);
    expect(
      isOpenCodeProviderAdmissionError(
        JSON.stringify({
          type: "error",
          error: {
            name: "APIError",
            data: {
              message: "failed to read request body (ref: 8ba04c1b-228f-4d72)",
              statusCode: 400,
              isRetryable: false,
            },
          },
        }),
        "",
      ),
    ).toBe(true);
    expect(isOpenCodeProviderAdmissionError("all good", "")).toBe(false);
    expect(isOpenCodeProviderAdmissionError("", "")).toBe(false);
    // An unknown-session error must not be classified as an admission failure.
    expect(
      isOpenCodeProviderAdmissionError("ProviderError: unknown session id", ""),
    ).toBe(false);
    // Assistant text and tool output that merely quote the phrase are not
    // admission failures: a resumable session must not be discarded.
    expect(
      isOpenCodeProviderAdmissionError(
        JSON.stringify({
          type: "text",
          sessionID: "session_123",
          part: { text: "The provider said: failed to read request body" },
        }),
        "",
      ),
    ).toBe(false);
    expect(
      isOpenCodeProviderAdmissionError(
        JSON.stringify({
          type: "tool_use",
          sessionID: "session_123",
          part: {
            state: { status: "error", error: "Too many images were provided" },
          },
        }),
        "",
      ),
    ).toBe(false);
  });
});

describe("OpenCode price availability", () => {
  it("distinguishes missing cost from reported zero and counts cache writes", () => {
    const event = { type: "step_finish", part: { tokens: { input: 10, output: 3, cache: { read: 100, write: 20 } } } };
    expect(parseOpenCodeJsonl(JSON.stringify(event))).toMatchObject({ costUsd: null, usage: { inputTokens: 30, cachedInputTokens: 100, outputTokens: 3 } });
    expect(parseOpenCodeJsonl(JSON.stringify({ ...event, part: { ...event.part, cost: 0 } })).costUsd).toBe(0);
    expect(parseOpenCodeJsonl([event, { ...event, part: { ...event.part, cost: 1 } }].map((row) => JSON.stringify(row)).join("\n")).costUsd).toBeNull();
  });
});

describe("OpenCode reported usage completeness", () => {
  it.each([undefined, {}, { input: 1 }, { input: -1, output: 2 }, { input: 1, output: 0.5 }, { input: 1, output: 2, cache: { read: -1 } }, { input: 1, output: 2, cache: { read: null } }, { input: 1, output: 2, reasoning: null }])("preserves unknown usage for incomplete counters %j", tokens => {
    expect(parseOpenCodeJsonl(JSON.stringify({ type: "step_finish", part: { tokens } }))).toMatchObject({ usageReported: false, usageComplete: false, costUsd: null });
  });
  it("accepts explicit zeros but keeps a later missing step incomplete", () => {
    const line = JSON.stringify({ type: "step_finish", part: { tokens: { input: 0, output: 0 } } });
    expect(parseOpenCodeJsonl(line)).toMatchObject({ usageReported: true, usageComplete: true, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: null });
    expect(parseOpenCodeJsonl(line + '\n' + JSON.stringify({ type: "step_finish" }))).toMatchObject({ usageReported: true, usageComplete: false });
  });
});
