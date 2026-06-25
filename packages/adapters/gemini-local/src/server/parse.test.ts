import { describe, expect, it } from "vitest";
import {
  parseGeminiJsonl,
  isGeminiSessionUnrecoverableError,
  isGeminiTransientNetworkError,
  describeGeminiFailure,
  detectGeminiAuthRequired,
  detectGeminiQuotaExhausted,
  isGeminiTurnLimitResult,
} from "./parse.js";

describe("parseGeminiJsonl", () => {
  it("collects assistant text from message events with string content", () => {
    const stdout = [
      '{"type":"init","session_id":"session-1"}',
      '{"type":"message","role":"user","content":"Respond with hello."}',
      '{"type":"message","role":"assistant","content":"hello","delta":true}',
      '{"type":"result","status":"success"}',
    ].join("\n");

    const parsed = parseGeminiJsonl(stdout);
    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.summary).toBe("hello");
    expect(parsed.errorMessage).toBeNull();
  });

  it("collects assistant text from structured object content", () => {
    const stdout = [
      '{"type":"init","session_id":"session-2"}',
      '{"type":"message","role":"assistant","content":{"content":[{"type":"text","text":"first"},{"type":"text","text":"second"}]}}',
      '{"type":"result","status":"success"}',
    ].join("\n");

    const parsed = parseGeminiJsonl(stdout);
    expect(parsed.sessionId).toBe("session-2");
    expect(parsed.summary).toBe("first\n\nsecond");
  });

  it("ignores non-assistant message events", () => {
    const stdout = [
      '{"type":"message","role":"user","content":"hidden"}',
      '{"type":"message","role":"system","content":"hidden"}',
      '{"type":"message","role":"assistant","content":"visible"}',
      '{"type":"result","status":"success"}',
    ].join("\n");

    const parsed = parseGeminiJsonl(stdout);
    expect(parsed.summary).toBe("visible");
  });

  it("captures assistant text from CLI stream-json schema", () => {
    const stdout = [
      JSON.stringify({ type: "init", session_id: "session-abc", model: "auto-Gemini-3" }),
      JSON.stringify({ type: "message", role: "user", content: "Respond with hello." }),
      JSON.stringify({ type: "message", role: "assistant", content: "hello.", delta: true }),
      JSON.stringify({
        type: "result", status: "success",
        stats: { total_tokens: 9468, input_tokens: 9095, output_tokens: 29, cached: 8132, duration_ms: 4616 },
      }),
    ].join("\n");

    const result = parseGeminiJsonl(stdout);
    expect(result.summary).toBe("hello.");
    expect(result.sessionId).toBe("session-abc");
    expect(result.errorMessage).toBeNull();
    expect(result.usage.inputTokens).toBe(9095);
    expect(result.usage.outputTokens).toBe(29);
    expect(result.usage.cachedInputTokens).toBe(8132);
  });

  it("ignores user messages and only collects assistant content", () => {
    const stdout = [
      JSON.stringify({ type: "message", role: "user", content: "ignore me" }),
      JSON.stringify({ type: "message", role: "assistant", content: "first" }),
      JSON.stringify({ type: "message", role: "assistant", content: "second" }),
    ].join("\n");

    const result = parseGeminiJsonl(stdout);
    expect(result.summary).toBe("first\n\nsecond");
  });

  it("preserves the legacy assistant event handler", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "legacy-session" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "output_text", text: "legacy hello" }] } }),
      JSON.stringify({ type: "result", subtype: "success", result: "legacy hello" }),
    ].join("\n");

    const result = parseGeminiJsonl(stdout);
    expect(result.summary).toBe("legacy hello");
    expect(result.sessionId).toBe("legacy-session");
  });

  it("flags result events with status=error", () => {
    const stdout = JSON.stringify({ type: "result", status: "error", error: "boom" });
    const result = parseGeminiJsonl(stdout);
    expect(result.errorMessage).toBe("boom");
  });

  it("extracts cost from result events", () => {
    const stdout = JSON.stringify({ type: "result", status: "success", total_cost_usd: 0.42 });
    const result = parseGeminiJsonl(stdout);
    expect(result.costUsd).toBe(0.42);
  });

  it("extracts usage from step_finish events", () => {
    const stdout = JSON.stringify({
      type: "step_finish",
      usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 80 },
    });
    const result = parseGeminiJsonl(stdout);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.cachedInputTokens).toBe(80);
  });

  it("captures questions from assistant messages", () => {
    const stdout = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "question", prompt: "Proceed?", choices: [{ key: "y", label: "Yes" }, { key: "n", label: "No" }] }] },
    });
    const result = parseGeminiJsonl(stdout);
    expect(result.question).not.toBeNull();
    expect(result.question!.prompt).toBe("Proceed?");
    expect(result.question!.choices).toHaveLength(2);
  });
});

describe("isGeminiSessionUnrecoverableError", () => {
  it("matches 'unknown session'", () => {
    expect(isGeminiSessionUnrecoverableError("", "Error: unknown session 'abc-123'")).toBe(true);
  });

  it("matches 'session ... not found'", () => {
    expect(isGeminiSessionUnrecoverableError("", "Resumed session abc-123 not found on disk")).toBe(true);
    expect(isGeminiSessionUnrecoverableError("", "session not found")).toBe(true);
  });

  it("matches 'cannot resume' and 'failed to resume'", () => {
    expect(isGeminiSessionUnrecoverableError("cannot resume session", "")).toBe(true);
    expect(isGeminiSessionUnrecoverableError("failed to resume", "")).toBe(true);
  });

  it("matches 'exceeds the maximum number of tokens' (compression overflow)", () => {
    const stderr =
      '_ApiError: {"error":{"code":400,"message":"The input token count exceeds the maximum number of tokens allowed 1048576","status":"INVALID_ARGUMENT"}} at ChatCompressionService.compress';
    expect(isGeminiSessionUnrecoverableError("", stderr)).toBe(true);
  });

  it("matches 'input token count exceeds'", () => {
    expect(isGeminiSessionUnrecoverableError("", "input token count exceeds maximum")).toBe(true);
  });

  it("does not match unrelated stderr", () => {
    expect(isGeminiSessionUnrecoverableError("", "Some other error")).toBe(false);
    expect(isGeminiSessionUnrecoverableError("hello world", "success")).toBe(false);
  });

  it("does not match transient network errors (those go to isGeminiTransientNetworkError)", () => {
    expect(
      isGeminiSessionUnrecoverableError(
        "",
        "_GaxiosError: getaddrinfo ENOTFOUND oauth2.googleapis.com",
      ),
    ).toBe(false);
  });
});

describe("describeGeminiFailure", () => {
  it("describes failure with status and error", () => {
    const result = describeGeminiFailure({ status: "error", error: "timeout" });
    expect(result).toBe("Gemini run failed: status=error: timeout");
  });

  it("returns null for empty input", () => {
    expect(describeGeminiFailure({})).toBeNull();
  });

  it("describes failure with status only", () => {
    const result = describeGeminiFailure({ status: "failed" });
    expect(result).toBe("Gemini run failed: status=failed");
  });
});

describe("detectGeminiAuthRequired", () => {
  it("detects authentication errors", () => {
    expect(detectGeminiAuthRequired({ parsed: null, stdout: "not authenticated", stderr: "" }).requiresAuth).toBe(true);
    expect(detectGeminiAuthRequired({ parsed: null, stdout: "", stderr: "api_key required" }).requiresAuth).toBe(true);
    expect(detectGeminiAuthRequired({ parsed: { error: "unauthorized" }, stdout: "", stderr: "" }).requiresAuth).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(detectGeminiAuthRequired({ parsed: null, stdout: "hello", stderr: "" }).requiresAuth).toBe(false);
  });
});

describe("detectGeminiQuotaExhausted", () => {
  it("detects quota exhaustion", () => {
    expect(detectGeminiQuotaExhausted({ parsed: null, stdout: "resource_exhausted", stderr: "" }).exhausted).toBe(true);
    expect(detectGeminiQuotaExhausted({ parsed: null, stdout: "rate-limit exceeded", stderr: "" }).exhausted).toBe(true);
    expect(detectGeminiQuotaExhausted({ parsed: null, stdout: "429 too many requests", stderr: "" }).exhausted).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(detectGeminiQuotaExhausted({ parsed: null, stdout: "hello", stderr: "" }).exhausted).toBe(false);
  });
});

describe("isGeminiTurnLimitResult", () => {
  it("detects turn limit by exit code", () => {
    expect(isGeminiTurnLimitResult(null, 53)).toBe(true);
  });

  it("detects turn limit by status field", () => {
    expect(isGeminiTurnLimitResult({ status: "turn_limit" })).toBe(true);
    expect(isGeminiTurnLimitResult({ stop_reason: "max_turns" })).toBe(true);
    expect(isGeminiTurnLimitResult({ stopReason: "max_turns_exhausted" })).toBe(true);
    expect(isGeminiTurnLimitResult({ error_code: "turn_limit_exhausted" })).toBe(true);
  });

  it("returns false for normal completion", () => {
    expect(isGeminiTurnLimitResult({ status: "success" })).toBe(false);
    expect(isGeminiTurnLimitResult(null, 0)).toBe(false);
    expect(isGeminiTurnLimitResult(null)).toBe(false);
  });
});

describe("isGeminiTransientNetworkError", () => {
  it("matches DNS failure on oauth2.googleapis.com", () => {
    const stderr =
      "_GaxiosError: request to https://oauth2.googleapis.com/token failed, reason: getaddrinfo ENOTFOUND oauth2.googleapis.com";
    expect(isGeminiTransientNetworkError("", stderr)).toBe(true);
  });

  it("matches EAI_AGAIN on any googleapis.com host", () => {
    expect(
      isGeminiTransientNetworkError("", "Error: getaddrinfo EAI_AGAIN sts.googleapis.com"),
    ).toBe(true);
  });

  it("matches _UserRefreshClient ENOTFOUND", () => {
    const stderr =
      "at _UserRefreshClient.refreshTokenNoCache (.../google-auth-library/...)\n" +
      "  caused by: ENOTFOUND oauth2.googleapis.com";
    expect(isGeminiTransientNetworkError("", stderr)).toBe(true);
  });

  it("matches _GaxiosError ENOTFOUND on sts.googleapis.com", () => {
    expect(
      isGeminiTransientNetworkError("", "_GaxiosError: ENOTFOUND sts.googleapis.com"),
    ).toBe(true);
  });

  it("does not match unrelated stderr", () => {
    expect(isGeminiTransientNetworkError("", "Some other error")).toBe(false);
    expect(isGeminiTransientNetworkError("hello", "")).toBe(false);
  });

  it("does not match unknown-session errors (those go to isGeminiSessionUnrecoverableError)", () => {
    expect(
      isGeminiTransientNetworkError("", "Error: unknown session 'abc-123'"),
    ).toBe(false);
  });
});
