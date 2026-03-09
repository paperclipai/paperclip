import { describe, expect, it } from "vitest";
import { hasRateLimitEvent, isClaudeRateLimitResult, detectClaudeLoginRequired } from "./parse.js";

describe("hasRateLimitEvent", () => {
  it("detects rate_limit_event type", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "rate_limit_event", retry_after: 30 }),
    ].join("\n");
    expect(hasRateLimitEvent(stdout)).toBe(true);
  });

  it("detects error with subtype rate_limit", () => {
    const stdout = JSON.stringify({ type: "error", subtype: "rate_limit", message: "Rate limited" });
    expect(hasRateLimitEvent(stdout)).toBe(true);
  });

  it("detects error with overloaded in message", () => {
    const stdout = JSON.stringify({ type: "error", subtype: "api_error", message: "API is overloaded" });
    expect(hasRateLimitEvent(stdout)).toBe(true);
  });

  it("detects error with rate_limit in error field", () => {
    const stdout = JSON.stringify({ type: "error", subtype: "api_error", error: "rate_limit exceeded" });
    expect(hasRateLimitEvent(stdout)).toBe(true);
  });

  it("returns false when no rate limit events present", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }),
      JSON.stringify({ type: "result", result: "Done", subtype: "success" }),
    ].join("\n");
    expect(hasRateLimitEvent(stdout)).toBe(false);
  });

  it("returns false for empty stdout", () => {
    expect(hasRateLimitEvent("")).toBe(false);
  });

  it("handles non-JSON lines gracefully", () => {
    const stdout = "not json\n" + JSON.stringify({ type: "result", result: "ok" });
    expect(hasRateLimitEvent(stdout)).toBe(false);
  });
});

describe("isClaudeRateLimitResult", () => {
  it("returns true for subtype rate_limit", () => {
    expect(isClaudeRateLimitResult({ subtype: "rate_limit", result: "" })).toBe(true);
  });

  it("returns true for subtype error_rate_limit", () => {
    expect(isClaudeRateLimitResult({ subtype: "error_rate_limit", result: "" })).toBe(true);
  });

  it("returns true when result text contains 429", () => {
    expect(isClaudeRateLimitResult({ subtype: "error", result: "HTTP 429 Too Many Requests" })).toBe(true);
  });

  it("returns true when error array contains overloaded", () => {
    expect(
      isClaudeRateLimitResult({
        subtype: "error",
        result: "",
        errors: [{ message: "API is overloaded, please retry" }],
      }),
    ).toBe(true);
  });

  it("returns true when result text contains too many requests", () => {
    expect(isClaudeRateLimitResult({ subtype: "error", result: "too many requests" })).toBe(true);
  });

  it("returns false for non-rate-limit results", () => {
    expect(
      isClaudeRateLimitResult({
        subtype: "error",
        result: "Something went wrong",
        errors: [{ message: "internal server error" }],
      }),
    ).toBe(false);
  });

  it("returns false for null/undefined input", () => {
    expect(isClaudeRateLimitResult(null)).toBe(false);
    expect(isClaudeRateLimitResult(undefined)).toBe(false);
  });

  it("returns false for success result", () => {
    expect(isClaudeRateLimitResult({ subtype: "success", result: "Task completed" })).toBe(false);
  });
});

describe("detectClaudeLoginRequired", () => {
  it("does not false-positive when agent stdout contains 'unauthorized'", () => {
    // Agent output may discuss auth topics without meaning Claude itself needs login
    const stdout = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "The API returned unauthorized. Let me fix the auth header." }] } }),
      JSON.stringify({ type: "result", subtype: "error_max_turns", result: "Reached maximum turns" }),
    ].join("\n");
    const result = detectClaudeLoginRequired({ parsed: { subtype: "error_max_turns", result: "Reached maximum turns" }, stdout, stderr: "" });
    expect(result.requiresLogin).toBe(false);
  });

  it("detects login required from stderr", () => {
    const result = detectClaudeLoginRequired({ parsed: null, stdout: "", stderr: "Please run `claude login` to authenticate" });
    expect(result.requiresLogin).toBe(true);
  });

  it("detects login required from parsed result", () => {
    const result = detectClaudeLoginRequired({ parsed: { result: "Authentication required. Please log in." }, stdout: "", stderr: "" });
    expect(result.requiresLogin).toBe(true);
  });

  it("detects login required from parsed errors", () => {
    const result = detectClaudeLoginRequired({ parsed: { errors: ["Not logged in"] }, stdout: "", stderr: "" });
    expect(result.requiresLogin).toBe(true);
  });

  it("returns false for normal output", () => {
    const result = detectClaudeLoginRequired({ parsed: { result: "Task completed successfully" }, stdout: "", stderr: "" });
    expect(result.requiresLogin).toBe(false);
  });
});
