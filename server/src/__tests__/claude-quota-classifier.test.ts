import { describe, expect, it } from "vitest";
import {
  isClaudeTokenPlanCapFailure,
  CLAUDE_TOKEN_PLAN_CAP_RE,
  QUOTA_PAUSE_COOLDOWN_MS,
} from "../services/claude-quota-classifier.js";

describe("isClaudeTokenPlanCapFailure", () => {
  it("returns false when errorCode is not claude_transient_upstream", () => {
    expect(
      isClaudeTokenPlanCapFailure("claude_auth_required", "usage limit reached"),
    ).toBe(false);
    expect(isClaudeTokenPlanCapFailure("timeout", "plan limit reached")).toBe(false);
    expect(isClaudeTokenPlanCapFailure(null, "usage limit reached")).toBe(false);
  });

  it("returns false when failureReason is missing or empty", () => {
    expect(isClaudeTokenPlanCapFailure("claude_transient_upstream", null)).toBe(false);
    expect(isClaudeTokenPlanCapFailure("claude_transient_upstream", "")).toBe(false);
    expect(isClaudeTokenPlanCapFailure("claude_transient_upstream", undefined)).toBe(false);
  });

  it("returns false for genuine transient errors (5xx / 429 burst without plan-cap markers)", () => {
    // The adapter collapses real-transient and plan-cap into one code; only
    // plan-cap messages should flip the agent. This guards against over-pausing
    // on a normal 503 from Anthropic that will recover on its own.
    expect(
      isClaudeTokenPlanCapFailure("claude_transient_upstream", "529 server overloaded"),
    ).toBe(false);
    expect(
      isClaudeTokenPlanCapFailure(
        "claude_transient_upstream",
        "429 too many requests, retry after 2s",
      ),
    ).toBe(false);
  });

  it("returns true for 5-hour plan window messages", () => {
    expect(
      isClaudeTokenPlanCapFailure(
        "claude_transient_upstream",
        "Claude run failed: 5-hour limit reached",
      ),
    ).toBe(true);
  });

  it("returns true for weekly plan limit messages", () => {
    expect(
      isClaudeTokenPlanCapFailure(
        "claude_transient_upstream",
        "weekly limit reached, resets Sunday",
      ),
    ).toBe(true);
  });

  it("returns true for 'usage limit reached' pattern (matches 2056)", () => {
    expect(
      isClaudeTokenPlanCapFailure(
        "claude_transient_upstream",
        "Anthropic API: usage limit reached; resets at 04:00 UTC",
      ),
    ).toBe(true);
  });

  it("returns true for 'token plan' messages", () => {
    expect(
      isClaudeTokenPlanCapFailure(
        "claude_transient_upstream",
        "Token plan usage limit exceeded for the day",
      ),
    ).toBe(true);
  });

  it("returns true for 'out of extra usage' pattern", () => {
    expect(
      isClaudeTokenPlanCapFailure(
        "claude_transient_upstream",
        "You are out of extra usage for this billing period",
      ),
    ).toBe(true);
  });

  it("QUOTA_PAUSE_COOLDOWN_MS is five minutes", () => {
    // The cooldown is the contract that prevents a successful probe after a
    // 429 burst from immediately re-firing the pause. Five minutes is short
    // enough for the board Token Plan tier upgrade to take effect and long
    // enough that a transient burst doesn't lock the agent for the hour.
    expect(QUOTA_PAUSE_COOLDOWN_MS).toBe(5 * 60 * 1000);
  });

  it("regex compiles and matches expected patterns", () => {
    // Sanity: the exported regex is the same one wired into the heartbeat.
    expect(CLAUDE_TOKEN_PLAN_CAP_RE.test("usage limit reached")).toBe(true);
    expect(CLAUDE_TOKEN_PLAN_CAP_RE.test("rate limit exceeded")).toBe(false);
    expect(CLAUDE_TOKEN_PLAN_CAP_RE.test("server overloaded")).toBe(false);
  });
});