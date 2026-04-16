import { describe, it, expect } from "vitest";
import {
  detectClaudeQuotaWarning,
  detectClaudeQuotaExhausted,
} from "./parse.js";
import type { ClaudeRateLimits } from "./parse.js";

describe("detectClaudeQuotaWarning", () => {
  it("triggers at seven_day.used_percentage = 90", () => {
    const rateLimits: ClaudeRateLimits = {
      seven_day: { used_percentage: 90 },
    };
    const result = detectClaudeQuotaWarning(rateLimits);
    expect(result.warning).toBe(true);
    expect(result.sevenDayPercent).toBe(90);
  });

  it("does not trigger at seven_day.used_percentage = 89", () => {
    const rateLimits: ClaudeRateLimits = {
      seven_day: { used_percentage: 89 },
    };
    const result = detectClaudeQuotaWarning(rateLimits);
    expect(result.warning).toBe(false);
    expect(result.sevenDayPercent).toBe(89);
  });

  it("five_hour.used_percentage = 95 alone does NOT trigger", () => {
    const rateLimits: ClaudeRateLimits = {
      five_hour: { used_percentage: 95 },
    };
    const result = detectClaudeQuotaWarning(rateLimits);
    expect(result.warning).toBe(false);
    expect(result.sevenDayPercent).toBeNull();
  });

  it("five_hour = 100 with seven_day = 50 does NOT trigger", () => {
    const rateLimits: ClaudeRateLimits = {
      five_hour: { used_percentage: 100 },
      seven_day: { used_percentage: 50 },
    };
    const result = detectClaudeQuotaWarning(rateLimits);
    expect(result.warning).toBe(false);
  });

  it("returns no warning for null rateLimits", () => {
    const result = detectClaudeQuotaWarning(null);
    expect(result.warning).toBe(false);
    expect(result.sevenDayPercent).toBeNull();
  });

  it("returns no warning when seven_day has null used_percentage", () => {
    const rateLimits: ClaudeRateLimits = {
      seven_day: { used_percentage: null },
    };
    const result = detectClaudeQuotaWarning(rateLimits);
    expect(result.warning).toBe(false);
    expect(result.sevenDayPercent).toBeNull();
  });
});

describe("detectClaudeQuotaExhausted", () => {
  it("detects 'You've hit your limit' in stderr", () => {
    const result = detectClaudeQuotaExhausted({
      stdout: "",
      stderr: "Error: You've hit your limit for the day. Usage resets 12am (Australia/Brisbane).",
    });
    expect(result.exhausted).toBe(true);
    expect(result.meta.resetTime).toBe("12am");
    expect(result.meta.resetTimezone).toBe("Australia/Brisbane");
  });

  it("detects 'You've hit your limit' in stdout", () => {
    const result = detectClaudeQuotaExhausted({
      stdout: "You've hit your limit. Usage resets 5pm (US/Pacific).",
      stderr: "",
    });
    expect(result.exhausted).toBe(true);
    expect(result.meta.resetTime).toBe("5pm");
    expect(result.meta.resetTimezone).toBe("US/Pacific");
  });

  it("does not trigger on unrelated error messages", () => {
    const result = detectClaudeQuotaExhausted({
      stdout: "",
      stderr: "Error: something went wrong",
    });
    expect(result.exhausted).toBe(false);
    expect(result.meta.resetTime).toBeNull();
    expect(result.meta.resetTimezone).toBeNull();
  });

  it("handles missing reset time gracefully", () => {
    const result = detectClaudeQuotaExhausted({
      stdout: "You've hit your limit.",
      stderr: "",
    });
    expect(result.exhausted).toBe(true);
    expect(result.meta.resetTime).toBeNull();
    expect(result.meta.resetTimezone).toBeNull();
  });

  it("handles smart quote in 'You\u2019ve hit your limit'", () => {
    const result = detectClaudeQuotaExhausted({
      stdout: "",
      stderr: "You\u2019ve hit your limit. Usage resets 12am (Australia/Brisbane).",
    });
    expect(result.exhausted).toBe(true);
    expect(result.meta.resetTime).toBe("12am");
  });
});
