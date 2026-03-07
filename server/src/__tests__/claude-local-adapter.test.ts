import { describe, expect, it } from "vitest";
import {
  isClaudeMaxTurnsResult,
  parseClaudeStreamJson,
  detectClaudeLoginRequired,
  describeClaudeFailure,
} from "@paperclipai/adapter-claude-local/server";

// ---------------------------------------------------------------------------
// isClaudeMaxTurnsResult
// ---------------------------------------------------------------------------
describe("isClaudeMaxTurnsResult", () => {
  it("detects by subtype=error_max_turns", () => {
    expect(isClaudeMaxTurnsResult({ subtype: "error_max_turns" })).toBe(true);
  });

  it("detects by subtype case-insensitively", () => {
    expect(isClaudeMaxTurnsResult({ subtype: "ERROR_MAX_TURNS" })).toBe(true);
  });

  it("detects by stop_reason=max_turns", () => {
    expect(isClaudeMaxTurnsResult({ stop_reason: "max_turns" })).toBe(true);
  });

  it("detects by result text containing max turns", () => {
    expect(isClaudeMaxTurnsResult({ result: "Reached maximum turns" })).toBe(true);
    expect(isClaudeMaxTurnsResult({ result: "reached max turns limit" })).toBe(true);
  });

  it("returns false for normal success", () => {
    expect(isClaudeMaxTurnsResult({ subtype: "success", stop_reason: "end_turn" })).toBe(false);
  });

  it("returns false for empty object", () => {
    expect(isClaudeMaxTurnsResult({})).toBe(false);
  });

  it("returns false for null", () => {
    expect(isClaudeMaxTurnsResult(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isClaudeMaxTurnsResult(undefined)).toBe(false);
  });

  it("returns false for timeout errorCode", () => {
    expect(isClaudeMaxTurnsResult({ subtype: "timeout", stop_reason: "timed_out" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseClaudeStreamJson with max-turns output
// ---------------------------------------------------------------------------
describe("parseClaudeStreamJson — max-turns output", () => {
  it("extracts result JSON from a max-turns stream", () => {
    const maxTurnsResult = {
      type: "result",
      subtype: "error_max_turns",
      result: "Reached maximum number of turns (80)",
      session_id: "sess-abc",
      usage: { input_tokens: 10000, cache_read_input_tokens: 5000, output_tokens: 2000 },
      total_cost_usd: 0.05,
    };
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-abc", model: "claude-sonnet-4-5" }),
      JSON.stringify({ type: "assistant", session_id: "sess-abc", message: { content: [{ type: "text", text: "Working on it..." }] } }),
      JSON.stringify(maxTurnsResult),
    ].join("\n");

    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed.sessionId).toBe("sess-abc");
    expect(parsed.resultJson).not.toBeNull();
    expect(parsed.resultJson?.subtype).toBe("error_max_turns");
    expect(parsed.usage?.inputTokens).toBe(10000);
    expect(parsed.usage?.cachedInputTokens).toBe(5000);
    expect(parsed.usage?.outputTokens).toBe(2000);
    expect(parsed.costUsd).toBe(0.05);
  });

  it("returns null resultJson when stdout is empty", () => {
    const parsed = parseClaudeStreamJson("");
    expect(parsed.resultJson).toBeNull();
    expect(parsed.sessionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectClaudeLoginRequired — must NOT fire for max-turns
// ---------------------------------------------------------------------------
describe("detectClaudeLoginRequired — max-turns is not an auth error", () => {
  it("does not flag max-turns result as auth required", () => {
    const result = detectClaudeLoginRequired({
      parsed: { subtype: "error_max_turns", result: "Reached maximum number of turns (80)" },
      stdout: "",
      stderr: "",
    });
    expect(result.requiresLogin).toBe(false);
    expect(result.loginUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// describeClaudeFailure — error_max_turns subtype
// ---------------------------------------------------------------------------
describe("describeClaudeFailure — error_max_turns subtype", () => {
  it("includes subtype and result text", () => {
    const msg = describeClaudeFailure({
      subtype: "error_max_turns",
      result: "Reached maximum number of turns",
    });
    expect(msg).toContain("error_max_turns");
    expect(msg).toContain("Reached maximum number of turns");
  });
});
