import { describe, expect, it } from "vitest";
import {
  parseGeminiJsonl,
  isGeminiUnknownSessionError,
  describeGeminiFailure,
  detectGeminiAuthRequired,
  detectGeminiQuotaExhausted,
  isGeminiTurnLimitResult,
} from "../server/parse.js";

// ============================================================================
// parseGeminiJsonl
// ============================================================================

describe("parseGeminiJsonl", () => {
  it("returns empty summary for empty stdout", () => {
    const result = parseGeminiJsonl("");
    expect(result.summary).toBe("");
    expect(result.sessionId).toBeNull();
    expect(result.costUsd).toBeNull();
  });

  it("extracts sessionId from session_id field", () => {
    const line = JSON.stringify({ type: "result", session_id: "sess-abc", result: "ok" });
    const result = parseGeminiJsonl(line);
    expect(result.sessionId).toBe("sess-abc");
  });

  it("extracts sessionId from thread_id field", () => {
    const line = JSON.stringify({ type: "assistant", thread_id: "thread-xyz", message: "" });
    const result = parseGeminiJsonl(line);
    expect(result.sessionId).toBe("thread-xyz");
  });

  it("extracts assistant text message", () => {
    const line = JSON.stringify({ type: "assistant", message: "Hello world" });
    const result = parseGeminiJsonl(line);
    expect(result.summary).toBe("Hello world");
  });

  it("extracts text from result event when no assistant messages", () => {
    const line = JSON.stringify({ type: "result", result: "Done." });
    const result = parseGeminiJsonl(line);
    expect(result.summary).toBe("Done.");
  });

  it("extracts cost from result event", () => {
    const line = JSON.stringify({ type: "result", result: "ok", total_cost_usd: 0.042 });
    const result = parseGeminiJsonl(line);
    expect(result.costUsd).toBe(0.042);
  });

  it("accumulates usage tokens from result event", () => {
    const line = JSON.stringify({
      type: "result",
      result: "",
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const result = parseGeminiJsonl(line);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
  });

  it("handles error event and captures errorMessage", () => {
    const line = JSON.stringify({ type: "error", error: "Something went wrong" });
    const result = parseGeminiJsonl(line);
    expect(result.errorMessage).toBe("Something went wrong");
  });

  it("handles system subtype=error event", () => {
    const line = JSON.stringify({ type: "system", subtype: "error", message: "System failure" });
    const result = parseGeminiJsonl(line);
    expect(result.errorMessage).toBe("System failure");
  });

  it("skips blank lines without crashing", () => {
    const stdout = "\n\n\n";
    expect(() => parseGeminiJsonl(stdout)).not.toThrow();
  });

  it("skips non-JSON lines without crashing", () => {
    const stdout = "not json\nstill not json";
    const result = parseGeminiJsonl(stdout);
    expect(result.summary).toBe("");
  });

  it("joins multiple assistant messages with double newline", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: "First" }),
      JSON.stringify({ type: "assistant", message: "Second" }),
    ].join("\n");
    const result = parseGeminiJsonl(lines);
    expect(result.summary).toBe("First\n\nSecond");
  });
});

// ============================================================================
// isGeminiUnknownSessionError
// ============================================================================

describe("isGeminiUnknownSessionError", () => {
  it("returns true for 'unknown session' in stdout", () => {
    expect(isGeminiUnknownSessionError("unknown session error", "")).toBe(true);
  });

  it("returns true for 'session not found' in stderr", () => {
    expect(isGeminiUnknownSessionError("", "session abc not found")).toBe(true);
  });

  it("returns true for 'cannot resume' phrase", () => {
    expect(isGeminiUnknownSessionError("cannot resume session", "")).toBe(true);
  });

  it("returns true for 'failed to resume' phrase", () => {
    expect(isGeminiUnknownSessionError("", "failed to resume checkpoint")).toBe(true);
  });

  it("returns false for unrelated error text", () => {
    expect(isGeminiUnknownSessionError("quota exceeded", "rate limit hit")).toBe(false);
  });

  it("returns false for empty inputs", () => {
    expect(isGeminiUnknownSessionError("", "")).toBe(false);
  });
});

// ============================================================================
// describeGeminiFailure
// ============================================================================

describe("describeGeminiFailure", () => {
  it("returns null when no status or errors", () => {
    const result = describeGeminiFailure({});
    expect(result).toBeNull();
  });

  it("includes status in description", () => {
    const result = describeGeminiFailure({ status: "TIMEOUT" });
    expect(result).toContain("status=TIMEOUT");
    expect(result).toContain("Gemini run failed");
  });

  it("includes error message in description", () => {
    const result = describeGeminiFailure({ error: "auth failed" });
    expect(result).toContain("auth failed");
  });

  it("includes both status and error detail", () => {
    const result = describeGeminiFailure({ status: "ERROR", error: "quota exceeded" });
    expect(result).toContain("status=ERROR");
    expect(result).toContain("quota exceeded");
  });
});

// ============================================================================
// detectGeminiAuthRequired
// ============================================================================

describe("detectGeminiAuthRequired", () => {
  it("detects auth requirement from stdout", () => {
    const result = detectGeminiAuthRequired({
      parsed: null,
      stdout: "Not authenticated. Please authenticate first.",
      stderr: "",
    });
    expect(result.requiresAuth).toBe(true);
  });

  it("detects auth requirement from stderr", () => {
    const result = detectGeminiAuthRequired({
      parsed: null,
      stdout: "",
      stderr: "API key required",
    });
    expect(result.requiresAuth).toBe(true);
  });

  it("detects 'unauthorized' pattern", () => {
    const result = detectGeminiAuthRequired({
      parsed: null,
      stdout: "unauthorized",
      stderr: "",
    });
    expect(result.requiresAuth).toBe(true);
  });

  it("detects 'invalid credentials' pattern", () => {
    const result = detectGeminiAuthRequired({
      parsed: null,
      stdout: "invalid credentials",
      stderr: "",
    });
    expect(result.requiresAuth).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    const result = detectGeminiAuthRequired({
      parsed: null,
      stdout: "quota exceeded",
      stderr: "",
    });
    expect(result.requiresAuth).toBe(false);
  });

  it("returns false for empty inputs", () => {
    const result = detectGeminiAuthRequired({ parsed: null, stdout: "", stderr: "" });
    expect(result.requiresAuth).toBe(false);
  });
});

// ============================================================================
// detectGeminiQuotaExhausted
// ============================================================================

describe("detectGeminiQuotaExhausted", () => {
  it("detects RESOURCE_EXHAUSTED pattern", () => {
    const result = detectGeminiQuotaExhausted({
      parsed: null,
      stdout: "resource_exhausted",
      stderr: "",
    });
    expect(result.exhausted).toBe(true);
  });

  it("detects 'too many requests' pattern", () => {
    const result = detectGeminiQuotaExhausted({
      parsed: null,
      stdout: "too many requests",
      stderr: "",
    });
    expect(result.exhausted).toBe(true);
  });

  it("detects 429 status code mention", () => {
    const result = detectGeminiQuotaExhausted({
      parsed: null,
      stdout: "HTTP 429 from API",
      stderr: "",
    });
    expect(result.exhausted).toBe(true);
  });

  it("detects rate-limit from stderr", () => {
    const result = detectGeminiQuotaExhausted({
      parsed: null,
      stdout: "",
      stderr: "rate limit exceeded",
    });
    expect(result.exhausted).toBe(true);
  });

  it("returns false for auth error", () => {
    const result = detectGeminiQuotaExhausted({
      parsed: null,
      stdout: "unauthorized",
      stderr: "",
    });
    expect(result.exhausted).toBe(false);
  });

  it("returns false for empty inputs", () => {
    const result = detectGeminiQuotaExhausted({ parsed: null, stdout: "", stderr: "" });
    expect(result.exhausted).toBe(false);
  });
});

// ============================================================================
// isGeminiTurnLimitResult
// ============================================================================

describe("isGeminiTurnLimitResult", () => {
  it("returns true when exitCode is 53", () => {
    expect(isGeminiTurnLimitResult(null, 53)).toBe(true);
  });

  it("returns true when status is turn_limit", () => {
    expect(isGeminiTurnLimitResult({ status: "turn_limit" })).toBe(true);
  });

  it("returns true when status is max_turns", () => {
    expect(isGeminiTurnLimitResult({ status: "max_turns" })).toBe(true);
  });

  it("returns true when error contains 'turn limit'", () => {
    expect(isGeminiTurnLimitResult({ error: "reached turn limit" })).toBe(true);
  });

  it("returns true when error contains 'maximum turns'", () => {
    expect(isGeminiTurnLimitResult({ error: "maximum turns reached" })).toBe(true);
  });

  it("returns false for null parsed", () => {
    expect(isGeminiTurnLimitResult(null)).toBe(false);
  });

  it("returns false for unrelated status", () => {
    expect(isGeminiTurnLimitResult({ status: "error" })).toBe(false);
  });

  it("returns false for non-53 exit code with null parsed", () => {
    expect(isGeminiTurnLimitResult(null, 1)).toBe(false);
  });
});
