import { describe, expect, it } from "vitest";
import {
  parseClaudeStreamJson,
  isClaudeUnknownSessionError,
  shouldFallbackToFreshSession,
} from "./parse.js";

describe("parseClaudeStreamJson", () => {
  it("extracts session id, model, summary, and usage from a complete stream", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess_abc", model: "claude-sonnet-4-5" }),
      JSON.stringify({ type: "assistant", session_id: "sess_abc", message: { content: [{ type: "text", text: "Hello!" }] } }),
      JSON.stringify({ type: "result", session_id: "sess_abc", result: "Hello!", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 }, total_cost_usd: 0.001 }),
    ].join("\n");

    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed.sessionId).toBe("sess_abc");
    expect(parsed.model).toBe("claude-sonnet-4-5");
    expect(parsed.summary).toBe("Hello!");
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 });
    expect(parsed.costUsd).toBeCloseTo(0.001, 6);
  });

  it("returns null resultJson when no result event is present", () => {
    const stdout = JSON.stringify({ type: "system", subtype: "init", session_id: "sess_xyz", model: "claude-sonnet-4-5" });
    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed.resultJson).toBeNull();
    expect(parsed.sessionId).toBe("sess_xyz");
  });
});

describe("isClaudeUnknownSessionError", () => {
  it("detects 'no conversation found with session id' message", () => {
    expect(isClaudeUnknownSessionError({ result: "No conversation found with session ID: abc-123" })).toBe(true);
  });

  it("detects 'unknown session' message in errors array", () => {
    expect(isClaudeUnknownSessionError({ errors: ["Unknown session encountered"] })).toBe(true);
  });

  it("detects 'session * not found' pattern", () => {
    expect(isClaudeUnknownSessionError({ result: "session abc-123 not found" })).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isClaudeUnknownSessionError({ result: "Something went wrong" })).toBe(false);
  });
});

describe("shouldFallbackToFreshSession", () => {
  const failedProc = { exitCode: 1, timedOut: false };
  const timedOutProc = { exitCode: null, timedOut: true };
  const successProc = { exitCode: 0, timedOut: false };

  it("falls back when session resume fails and parsed is null (API-level failure)", () => {
    // This is the core bug: API returns 500 before emitting any JSON → parsed is null
    expect(shouldFallbackToFreshSession("sess-dead", failedProc, null)).toBe(true);
  });

  it("falls back when parsed contains an unknown session error", () => {
    const parsed = { result: "No conversation found with session ID: sess-dead" };
    expect(shouldFallbackToFreshSession("sess-dead", failedProc, parsed)).toBe(true);
  });

  it("does NOT fall back when there is no session to resume (fresh start)", () => {
    expect(shouldFallbackToFreshSession(null, failedProc, null)).toBe(false);
  });

  it("does NOT fall back when the process timed out", () => {
    expect(shouldFallbackToFreshSession("sess-abc", timedOutProc, null)).toBe(false);
  });

  it("does NOT fall back when the process succeeded", () => {
    expect(shouldFallbackToFreshSession("sess-abc", successProc, null)).toBe(false);
  });

  it("does NOT fall back when failure is unrelated to session (not a session error)", () => {
    const parsed = { result: "Internal server error" };
    expect(shouldFallbackToFreshSession("sess-abc", failedProc, parsed)).toBe(false);
  });
});
