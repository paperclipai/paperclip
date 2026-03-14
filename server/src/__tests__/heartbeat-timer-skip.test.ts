import { describe, expect, it } from "vitest";
import { isTimerSkipEnabled } from "../services/heartbeat.ts";

describe("isTimerSkipEnabled", () => {
  it("returns false when runtimeConfig is absent", () => {
    expect(isTimerSkipEnabled(null)).toBe(false);
    expect(isTimerSkipEnabled(undefined)).toBe(false);
  });

  it("returns false when runtimeConfig has no heartbeat key", () => {
    expect(isTimerSkipEnabled({})).toBe(false);
  });

  it("returns false when heartbeat object has no flag", () => {
    expect(isTimerSkipEnabled({ heartbeat: {} })).toBe(false);
  });

  it("returns false when flag is explicitly false", () => {
    expect(
      isTimerSkipEnabled({ heartbeat: { skipTimerWhenNoAssignedOpenIssue: false } }),
    ).toBe(false);
  });

  it("returns true when flag is enabled", () => {
    expect(
      isTimerSkipEnabled({ heartbeat: { skipTimerWhenNoAssignedOpenIssue: true } }),
    ).toBe(true);
  });

  it("returns false for truthy non-boolean values (strict boolean check)", () => {
    expect(
      isTimerSkipEnabled({ heartbeat: { skipTimerWhenNoAssignedOpenIssue: 1 } }),
    ).toBe(false);
    expect(
      isTimerSkipEnabled({ heartbeat: { skipTimerWhenNoAssignedOpenIssue: "true" } }),
    ).toBe(false);
  });

  it("ignores unrelated runtimeConfig keys", () => {
    expect(
      isTimerSkipEnabled({ budget: { monthlyCents: 5000 }, heartbeat: { skipTimerWhenNoAssignedOpenIssue: true } }),
    ).toBe(true);
  });
});
