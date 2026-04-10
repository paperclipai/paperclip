import { describe, expect, it } from "vitest";
import { isClaudeRateLimitedOutput } from "@paperclipai/adapter-claude-local/server";

describe("isClaudeRateLimitedOutput", () => {
  it("detects rate_limit_event in stdout", () => {
    const stdout = '{"type":"rate_limit_event","rate_limit_info":{}}\n';
    expect(isClaudeRateLimitedOutput(stdout, null)).toBe(true);
  });

  it("detects result JSON with is_error and limit wording", () => {
    const resultJson = {
      type: "result",
      is_error: true,
      result: "You've hit your limit · resets 12pm (UTC)",
    };
    expect(isClaudeRateLimitedOutput("", resultJson)).toBe(true);
  });

  it("returns false for normal success result", () => {
    const resultJson = {
      type: "result",
      is_error: false,
      result: "hello",
    };
    expect(isClaudeRateLimitedOutput("", resultJson)).toBe(false);
  });

  it("does not treat free-form stdout mentioning limits as rate-limited without structured markers", () => {
    expect(isClaudeRateLimitedOutput("You've hit your limit in this assistant tale.\n", null)).toBe(false);
  });
});
