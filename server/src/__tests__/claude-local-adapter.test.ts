import { describe, expect, it } from "vitest";
import {
  isClaudeMaxTurnsResult,
  isClaudeUsageLimitResult,
} from "@paperclipai/adapter-claude-local/server";

describe("claude_local max-turn detection", () => {
  it("detects max-turn exhaustion by subtype", () => {
    expect(
      isClaudeMaxTurnsResult({
        subtype: "error_max_turns",
        result: "Reached max turns",
      }),
    ).toBe(true);
  });

  it("detects max-turn exhaustion by stop_reason", () => {
    expect(
      isClaudeMaxTurnsResult({
        stop_reason: "max_turns",
      }),
    ).toBe(true);
  });

  it("returns false for non-max-turn results", () => {
    expect(
      isClaudeMaxTurnsResult({
        subtype: "success",
        stop_reason: "end_turn",
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Usage-limit detection
//
// Empirical trigger: a `claude_local` Backend Engineer run hit the Claude
// subscription usage limit mid-session. The Claude CLI exited non-zero with
// the stream result:
//
//   { subtype: "success", result: "You've hit your limit · resets 10am (UTC)" }
//
// The adapter at the time returned `errorCode: null` for this failure — same
// as any other generic claude_local failure. In the heartbeat, that null
// flowed into `shouldSelfWake("failed", null) === true`, which enqueued an
// `inbox_remaining` wakeup, which claimed a new run, which hit the same rate
// limit, which enqueued another wakeup, ... 20+ failed runs in 35 seconds,
// all making real API calls to Anthropic, all 429-ing.
//
// `isClaudeUsageLimitResult` recognises the known usage/rate-limit phrasing
// from the Claude CLI output so the adapter can return a specific errorCode
// (`"claude_usage_limited"`) that the heartbeat's SYSTEMIC_ERROR_CODES set
// rejects from self-wake, breaking the loop at the source.
// ---------------------------------------------------------------------------

describe("claude_local usage-limit detection", () => {
  it("detects the observed 'You've hit your limit' phrasing", () => {
    expect(
      isClaudeUsageLimitResult({
        subtype: "success",
        result: "You've hit your limit · resets 10am (UTC)",
      }),
    ).toBe(true);
  });

  it("detects the apostrophe-less variant", () => {
    expect(
      isClaudeUsageLimitResult({
        subtype: "success",
        result: "Youve hit your limit — try again later",
      }),
    ).toBe(true);
  });

  it("detects 'usage limit reached' phrasing", () => {
    expect(
      isClaudeUsageLimitResult({
        result: "Claude usage limit reached for this subscription window",
      }),
    ).toBe(true);
  });

  it("detects 'rate limit exceeded' phrasing", () => {
    expect(
      isClaudeUsageLimitResult({
        result: "Rate limit exceeded — please slow down",
      }),
    ).toBe(true);
  });

  it("detects the marker when it's in an errors[] entry rather than result", () => {
    expect(
      isClaudeUsageLimitResult({
        result: "",
        errors: [{ message: "You've hit your limit · resets at 10am UTC" }],
      }),
    ).toBe(true);
  });

  it("detects the marker from a plain-string errors[] entry", () => {
    expect(
      isClaudeUsageLimitResult({
        errors: ["usage limit reached"],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated failures", () => {
    expect(
      isClaudeUsageLimitResult({
        subtype: "error_max_turns",
        result: "Reached max turns",
      }),
    ).toBe(false);
  });

  it("returns false for auth-required failures (different error class)", () => {
    expect(
      isClaudeUsageLimitResult({
        result: "Please log in with `claude login` to continue",
      }),
    ).toBe(false);
  });

  it("returns false for successful runs", () => {
    expect(
      isClaudeUsageLimitResult({
        subtype: "success",
        result: "Here is the answer to your question...",
      }),
    ).toBe(false);
  });

  it("returns false for null/empty input", () => {
    expect(isClaudeUsageLimitResult(null)).toBe(false);
    expect(isClaudeUsageLimitResult(undefined)).toBe(false);
    expect(isClaudeUsageLimitResult({})).toBe(false);
  });

  it("does not match the word 'limit' in unrelated contexts", () => {
    // Guard against overly-greedy regex — a task that talks about a "time
    // limit" or "memory limit" in its output should NOT trip the rate-limit
    // detector.
    expect(
      isClaudeUsageLimitResult({
        result: "Updated the time limit constant in config.ts",
      }),
    ).toBe(false);
  });
});
