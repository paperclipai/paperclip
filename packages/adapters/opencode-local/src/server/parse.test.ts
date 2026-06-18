import { describe, expect, it } from "vitest";
import {
  parseOpenCodeJsonl,
  isOpenCodeUnknownSessionError,
  isOpenCodeQuotaRateLimitError,
  classifyOpenCodeSilentFailure,
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
    expect(parsed.toolCallCount).toBe(0);
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
    expect(parsed.toolCallCount).toBe(1);
  });

  it("counts every tool_use event regardless of status", () => {
    const stdout = [
      JSON.stringify({ type: "tool_use", sessionID: "s", part: { state: { status: "ok" } } }),
      JSON.stringify({ type: "tool_use", sessionID: "s", part: { state: { status: "ok" } } }),
      JSON.stringify({ type: "tool_use", sessionID: "s", part: { state: { status: "error", error: "x" } } }),
    ].join("\n");
    expect(parseOpenCodeJsonl(stdout).toolCallCount).toBe(3);
  });

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });
});

describe("isOpenCodeQuotaRateLimitError (FUL-191 silent-failure envelope)", () => {
  it("flags the minimax 2056 'Token Plan usage limit reached' class via message regex", () => {
    expect(
      isOpenCodeQuotaRateLimitError({
        errorMessage: "AI_APICallError: Token Plan usage limit reached (code 2056).",
        stdout: "",
        stderr: "",
      }),
    ).toBe(true);
  });

  it("flags Anthropic 429 rate_limit_error in stdout", () => {
    expect(
      isOpenCodeQuotaRateLimitError({
        stdout: JSON.stringify({
          type: "error",
          error: { code: "rate_limit_error", message: "Rate limit reached for requests." },
        }),
        stderr: "",
        errorMessage: "",
      }),
    ).toBe(true);
  });

  it("flags provider error.code == insufficient_quota via code-based check", () => {
    expect(
      isOpenCodeQuotaRateLimitError({
        stdout: JSON.stringify({
          type: "error",
          error: { code: "insufficient_quota", message: "You exceeded your current quota." },
        }),
        stderr: "",
        errorMessage: "",
      }),
    ).toBe(true);
  });

  it("flags resource_exhausted code variants", () => {
    expect(
      isOpenCodeQuotaRateLimitError({
        stdout: JSON.stringify({
          type: "error",
          error: { code: "RESOURCE_EXHAUSTED", message: "Quota exhausted" },
        }),
        stderr: "",
        errorMessage: "",
      }),
    ).toBe(true);
  });

  it("walks nested error.data.code shape", () => {
    expect(
      isOpenCodeQuotaRateLimitError({
        stdout: JSON.stringify({
          type: "error",
          error: { data: { code: "quota_exceeded" }, message: "Provider said no" },
        }),
        stderr: "",
        errorMessage: "",
      }),
    ).toBe(true);
  });

  it("does not flag a generic non-quota error", () => {
    expect(
      isOpenCodeQuotaRateLimitError({
        stdout: JSON.stringify({
          type: "error",
          error: { code: "internal_error", message: "Provider crashed" },
        }),
        stderr: "",
        errorMessage: "",
      }),
    ).toBe(false);
  });

  it("does not flag an empty envelope as quota", () => {
    expect(isOpenCodeQuotaRateLimitError({ stdout: "", stderr: "", errorMessage: null })).toBe(false);
    expect(isOpenCodeQuotaRateLimitError({ stdout: "", stderr: "", errorMessage: "" })).toBe(false);
  });

  it("uses the most recent `error` event when multiple are present", () => {
    const stdout = [
      JSON.stringify({ type: "error", error: { code: "internal_error", message: "transient" } }),
      JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded", message: "later" } }),
    ].join("\n");
    expect(isOpenCodeQuotaRateLimitError({ stdout, stderr: "", errorMessage: "" })).toBe(true);
  });
});

describe("classifyOpenCodeSilentFailure (FUL-191 mapping table)", () => {
  const baseInput = {
    timedOut: false,
    exitCode: 0,
    errorMessage: null,
    summary: "",
    toolCallCount: 0,
    stdout: "",
    stderr: "",
  };

  it("maps a timed-out run to (true, adapter_failed)", () => {
    expect(
      classifyOpenCodeSilentFailure({ ...baseInput, timedOut: true }),
    ).toEqual({ silentFailure: true, silentFailureReason: "adapter_failed" });
  });

  it("maps a non-zero exit with fatal error to (true, adapter_failed)", () => {
    expect(
      classifyOpenCodeSilentFailure({
        ...baseInput,
        exitCode: 1,
        errorMessage: "Unexpected server error",
        summary: "",
      }),
    ).toEqual({ silentFailure: true, silentFailureReason: "adapter_failed" });
  });

  it("maps a non-zero exit with no error message to (true, adapter_failed)", () => {
    expect(
      classifyOpenCodeSilentFailure({
        ...baseInput,
        exitCode: 137,
        errorMessage: null,
      }),
    ).toEqual({ silentFailure: true, silentFailureReason: "adapter_failed" });
  });

  it("maps a 2056 'Token Plan usage limit reached' to (true, quota_rate_limit)", () => {
    expect(
      classifyOpenCodeSilentFailure({
        ...baseInput,
        exitCode: 1,
        errorMessage: "AI_APICallError: Token Plan usage limit reached (code 2056).",
        summary: "",
      }),
    ).toEqual({ silentFailure: true, silentFailureReason: "quota_rate_limit" });
  });

  it("maps a 429 rate_limit_error in stdout to (true, quota_rate_limit) even with exit 0", () => {
    expect(
      classifyOpenCodeSilentFailure({
        ...baseInput,
        exitCode: 1,
        errorMessage: null,
        stdout: JSON.stringify({
          type: "error",
          error: { code: "rate_limit_error", message: "Rate limit reached for requests." },
        }),
      }),
    ).toEqual({ silentFailure: true, silentFailureReason: "quota_rate_limit" });
  });

  it("prefers quota_rate_limit over adapter_failed when both apply", () => {
    expect(
      classifyOpenCodeSilentFailure({
        ...baseInput,
        exitCode: 1,
        errorMessage: "quota exceeded",
      }),
    ).toEqual({ silentFailure: true, silentFailureReason: "quota_rate_limit" });
  });

  it("maps exit 0, no errors, no assistant text, no tool calls to (true, output_silence)", () => {
    expect(
      classifyOpenCodeSilentFailure({
        ...baseInput,
        exitCode: 0,
        errorMessage: null,
        summary: "",
        toolCallCount: 0,
      }),
    ).toEqual({ silentFailure: true, silentFailureReason: "output_silence" });
  });

  it("maps exit 0, no errors, normal assistant text to (false, null)", () => {
    expect(
      classifyOpenCodeSilentFailure({
        ...baseInput,
        exitCode: 0,
        errorMessage: null,
        summary: "All done.",
        toolCallCount: 2,
      }),
    ).toEqual({ silentFailure: false, silentFailureReason: null });
  });

  it("maps exit 0 with tool calls only (no text) to (false, null)", () => {
    expect(
      classifyOpenCodeSilentFailure({
        ...baseInput,
        exitCode: 0,
        errorMessage: null,
        summary: "",
        toolCallCount: 3,
      }),
    ).toEqual({ silentFailure: false, silentFailureReason: null });
  });

  it("maps exit 0 with only a recovered tool error to (false, null)", () => {
    expect(
      classifyOpenCodeSilentFailure({
        ...baseInput,
        exitCode: 0,
        errorMessage: null,
        summary: "Recovered.",
        toolCallCount: 4,
      }),
    ).toEqual({ silentFailure: false, silentFailureReason: null });
  });

  it("maps exit 0 with a fatal error envelope to (true, adapter_failed)", () => {
    expect(
      classifyOpenCodeSilentFailure({
        ...baseInput,
        exitCode: 0,
        errorMessage: "Internal server error",
        summary: "Started but failed",
      }),
    ).toEqual({ silentFailure: true, silentFailureReason: "adapter_failed" });
  });
});
