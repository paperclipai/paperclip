import { describe, expect, it } from "vitest";
import {
  parseGeminiJsonl,
  isGeminiSessionUnrecoverableError,
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
  it("detects unknown session errors", () => {
    expect(isGeminiSessionUnrecoverableError("unknown session abc", "")).toBe(true);
    expect(isGeminiSessionUnrecoverableError("", "session not found")).toBe(true);
    expect(isGeminiSessionUnrecoverableError("cannot resume session", "")).toBe(true);
    expect(isGeminiSessionUnrecoverableError("failed to resume", "")).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(isGeminiSessionUnrecoverableError("hello world", "success")).toBe(false);
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
