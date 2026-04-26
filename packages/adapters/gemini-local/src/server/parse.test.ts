import { describe, expect, it } from "vitest";
import {
  parseGeminiJsonl,
  isGeminiUnknownSessionError,
  describeGeminiFailure,
  detectGeminiAuthRequired,
  detectGeminiQuotaExhausted,
  isGeminiTurnLimitResult,
} from "./parse.js";

// ============================================================================
// parseGeminiJsonl
// ============================================================================

describe("parseGeminiJsonl", () => {
  it("returns empty defaults for empty string", () => {
    const result = parseGeminiJsonl("");
    expect(result.sessionId).toBeNull();
    expect(result.summary).toBe("");
    expect(result.errorMessage).toBeNull();
    expect(result.costUsd).toBeNull();
    expect(result.question).toBeNull();
    expect(result.usage).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  });

  it("returns empty defaults for lines that are not JSON", () => {
    const result = parseGeminiJsonl("not json\nalso not json");
    expect(result.sessionId).toBeNull();
    expect(result.summary).toBe("");
  });

  it("extracts session_id from assistant event", () => {
    const line = JSON.stringify({ type: "assistant", session_id: "sess-abc", message: "hello" });
    const result = parseGeminiJsonl(line);
    expect(result.sessionId).toBe("sess-abc");
  });

  it("extracts sessionId (camelCase) from event", () => {
    const line = JSON.stringify({ type: "assistant", sessionId: "sess-xyz", message: "hello" });
    const result = parseGeminiJsonl(line);
    expect(result.sessionId).toBe("sess-xyz");
  });

  it("parses string message content from assistant event", () => {
    const line = JSON.stringify({ type: "assistant", message: "Hello world" });
    const result = parseGeminiJsonl(line);
    expect(result.summary).toBe("Hello world");
  });

  it("parses message.text from assistant event", () => {
    const line = JSON.stringify({ type: "assistant", message: { text: "response text" } });
    const result = parseGeminiJsonl(line);
    expect(result.summary).toBe("response text");
  });

  it("parses message content parts with output_text type", () => {
    const message = {
      content: [
        { type: "output_text", text: "part one" },
        { type: "output_text", text: "part two" },
      ],
    };
    const line = JSON.stringify({ type: "assistant", message });
    const result = parseGeminiJsonl(line);
    expect(result.summary).toContain("part one");
    expect(result.summary).toContain("part two");
  });

  it("captures result event text when no assistant messages", () => {
    const line = JSON.stringify({ type: "result", result: "Final answer" });
    const result = parseGeminiJsonl(line);
    expect(result.summary).toBe("Final answer");
  });

  it("captures cost from result event total_cost_usd", () => {
    const line = JSON.stringify({ type: "result", total_cost_usd: 0.0042 });
    const result = parseGeminiJsonl(line);
    expect(result.costUsd).toBeCloseTo(0.0042);
  });

  it("captures cost from result event cost_usd", () => {
    const line = JSON.stringify({ type: "result", cost_usd: 0.005 });
    const result = parseGeminiJsonl(line);
    expect(result.costUsd).toBeCloseTo(0.005);
  });

  it("captures error from result event with is_error=true", () => {
    const line = JSON.stringify({ type: "result", is_error: true, error: "something failed" });
    const result = parseGeminiJsonl(line);
    expect(result.errorMessage).toBe("something failed");
  });

  it("captures error from error event", () => {
    const line = JSON.stringify({ type: "error", error: "rate limit exceeded" });
    const result = parseGeminiJsonl(line);
    expect(result.errorMessage).toBe("rate limit exceeded");
  });

  it("captures error from system event with subtype=error", () => {
    const line = JSON.stringify({ type: "system", subtype: "error", message: "system problem" });
    const result = parseGeminiJsonl(line);
    expect(result.errorMessage).toBe("system problem");
  });

  it("captures text from text event", () => {
    const line = JSON.stringify({ type: "text", part: { text: "streaming text" } });
    const result = parseGeminiJsonl(line);
    expect(result.summary).toBe("streaming text");
  });

  it("accumulates usage tokens from step_finish event", () => {
    const line = JSON.stringify({
      type: "step_finish",
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const result = parseGeminiJsonl(line);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
  });

  it("accumulates usage tokens from usageMetadata field", () => {
    const line = JSON.stringify({
      type: "result",
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 80 },
    });
    const result = parseGeminiJsonl(line);
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(80);
  });

  it("accumulates cachedInputTokens", () => {
    const line = JSON.stringify({
      type: "step_finish",
      usage: { cached_input_tokens: 30, input_tokens: 10, output_tokens: 5 },
    });
    const result = parseGeminiJsonl(line);
    expect(result.usage.cachedInputTokens).toBe(30);
  });

  it("combines messages from multiple assistant events with double newline", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: "first" }),
      JSON.stringify({ type: "assistant", message: "second" }),
    ].join("\n");
    const result = parseGeminiJsonl(lines);
    expect(result.summary).toBe("first\n\nsecond");
  });

  it("parses question from assistant message with question content part", () => {
    const message = {
      content: [
        {
          type: "question",
          prompt: "Which option?",
          choices: [
            { key: "a", label: "Option A" },
            { key: "b", label: "Option B", description: "The second one" },
          ],
        },
      ],
    };
    const line = JSON.stringify({ type: "assistant", message });
    const result = parseGeminiJsonl(line);
    expect(result.question).not.toBeNull();
    expect(result.question?.prompt).toBe("Which option?");
    expect(result.question?.choices).toHaveLength(2);
    expect(result.question?.choices[0]?.key).toBe("a");
    expect(result.question?.choices[1]?.description).toBe("The second one");
  });

  it("skips blank lines", () => {
    const input = "\n\n" + JSON.stringify({ type: "assistant", message: "hi" }) + "\n\n";
    const result = parseGeminiJsonl(input);
    expect(result.summary).toBe("hi");
  });
});

// ============================================================================
// isGeminiUnknownSessionError
// ============================================================================

describe("isGeminiUnknownSessionError", () => {
  it("returns false for clean output", () => {
    expect(isGeminiUnknownSessionError("all good", "")).toBe(false);
  });

  it("returns true for 'unknown session' in stdout", () => {
    expect(isGeminiUnknownSessionError("unknown session id=abc", "")).toBe(true);
  });

  it("returns true for 'session not found' in stderr", () => {
    expect(isGeminiUnknownSessionError("", "session xyz not found")).toBe(true);
  });

  it("returns true for 'cannot resume' in stderr", () => {
    expect(isGeminiUnknownSessionError("", "cannot resume the session")).toBe(true);
  });

  it("returns true for 'failed to resume' in stdout", () => {
    expect(isGeminiUnknownSessionError("failed to resume checkpoint", "")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isGeminiUnknownSessionError("UNKNOWN SESSION", "")).toBe(true);
  });
});

// ============================================================================
// describeGeminiFailure
// ============================================================================

describe("describeGeminiFailure", () => {
  it("returns null when no status or errors", () => {
    expect(describeGeminiFailure({})).toBeNull();
  });

  it("includes status in failure description", () => {
    const result = describeGeminiFailure({ status: "failed" });
    expect(result).toContain("status=failed");
  });

  it("includes error message in failure description", () => {
    const result = describeGeminiFailure({ status: "error", error: "quota exceeded" });
    expect(result).toContain("quota exceeded");
  });

  it("returns only prefix when status is empty and no errors", () => {
    expect(describeGeminiFailure({ status: "" })).toBeNull();
  });

  it("extracts first error from errors array", () => {
    const result = describeGeminiFailure({ errors: ["first error", "second error"] });
    expect(result).toContain("first error");
  });
});

// ============================================================================
// detectGeminiAuthRequired
// ============================================================================

describe("detectGeminiAuthRequired", () => {
  it("returns false when no auth signals present", () => {
    const result = detectGeminiAuthRequired({ parsed: null, stdout: "all good", stderr: "" });
    expect(result.requiresAuth).toBe(false);
  });

  it("detects 'not authenticated' in stderr", () => {
    const result = detectGeminiAuthRequired({ parsed: null, stdout: "", stderr: "Error: not authenticated" });
    expect(result.requiresAuth).toBe(true);
  });

  it("detects 'please authenticate' in stdout", () => {
    const result = detectGeminiAuthRequired({ parsed: null, stdout: "please authenticate", stderr: "" });
    expect(result.requiresAuth).toBe(true);
  });

  it("detects 'api key required' in stderr", () => {
    const result = detectGeminiAuthRequired({ parsed: null, stdout: "", stderr: "api key required" });
    expect(result.requiresAuth).toBe(true);
  });

  it("detects auth error from parsed error field", () => {
    const result = detectGeminiAuthRequired({
      parsed: { error: "unauthorized: invalid credentials" },
      stdout: "",
      stderr: "",
    });
    expect(result.requiresAuth).toBe(true);
  });

  it("is case-insensitive", () => {
    const result = detectGeminiAuthRequired({ parsed: null, stdout: "UNAUTHORIZED", stderr: "" });
    expect(result.requiresAuth).toBe(true);
  });
});

// ============================================================================
// detectGeminiQuotaExhausted
// ============================================================================

describe("detectGeminiQuotaExhausted", () => {
  it("returns false when no quota signals present", () => {
    const result = detectGeminiQuotaExhausted({ parsed: null, stdout: "success", stderr: "" });
    expect(result.exhausted).toBe(false);
  });

  it("detects 'resource_exhausted' in stdout", () => {
    const result = detectGeminiQuotaExhausted({ parsed: null, stdout: "resource_exhausted", stderr: "" });
    expect(result.exhausted).toBe(true);
  });

  it("detects 'rate limit' in stderr", () => {
    const result = detectGeminiQuotaExhausted({ parsed: null, stdout: "", stderr: "rate limit exceeded" });
    expect(result.exhausted).toBe(true);
  });

  it("detects '429' in output", () => {
    const result = detectGeminiQuotaExhausted({ parsed: null, stdout: "HTTP 429", stderr: "" });
    expect(result.exhausted).toBe(true);
  });

  it("detects 'too many requests' in stderr", () => {
    const result = detectGeminiQuotaExhausted({ parsed: null, stdout: "", stderr: "too many requests" });
    expect(result.exhausted).toBe(true);
  });

  it("detects quota exhausted from parsed errors array", () => {
    const result = detectGeminiQuotaExhausted({
      parsed: { errors: ["quota exceeded for model"] },
      stdout: "",
      stderr: "",
    });
    expect(result.exhausted).toBe(true);
  });
});

// ============================================================================
// isGeminiTurnLimitResult
// ============================================================================

describe("isGeminiTurnLimitResult", () => {
  it("returns false for null parsed and no exit code", () => {
    expect(isGeminiTurnLimitResult(null)).toBe(false);
  });

  it("returns true for exit code 53", () => {
    expect(isGeminiTurnLimitResult(null, 53)).toBe(true);
  });

  it("returns true for status='turn_limit'", () => {
    expect(isGeminiTurnLimitResult({ status: "turn_limit" })).toBe(true);
  });

  it("returns true for status='max_turns'", () => {
    expect(isGeminiTurnLimitResult({ status: "max_turns" })).toBe(true);
  });

  it("returns true for error containing 'turn limit'", () => {
    expect(isGeminiTurnLimitResult({ error: "reached turn limit" })).toBe(true);
  });

  it("returns true for error containing 'maximum turns'", () => {
    expect(isGeminiTurnLimitResult({ error: "maximum turns exceeded" })).toBe(true);
  });

  it("returns false for unrelated status", () => {
    expect(isGeminiTurnLimitResult({ status: "success" })).toBe(false);
  });

  it("returns false for undefined parsed", () => {
    expect(isGeminiTurnLimitResult(undefined)).toBe(false);
  });
});
