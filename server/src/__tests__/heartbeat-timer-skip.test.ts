import { describe, expect, it } from "vitest";
import { isTimerSkipEnabled, shouldSkipTimerWake } from "../services/heartbeat.ts";

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

const enabledConfig = { heartbeat: { skipTimerWhenNoAssignedOpenIssue: true } };
const disabledConfig = { heartbeat: { skipTimerWhenNoAssignedOpenIssue: false } };

describe("shouldSkipTimerWake", () => {
  it("skips when flag is enabled and agent has no open issues", () => {
    expect(shouldSkipTimerWake(enabledConfig, 0)).toBe(true);
  });

  it("does not skip when flag is enabled and agent has open issues", () => {
    expect(shouldSkipTimerWake(enabledConfig, 1)).toBe(false);
    expect(shouldSkipTimerWake(enabledConfig, 5)).toBe(false);
  });

  it("does not skip when flag is disabled, regardless of issue count", () => {
    expect(shouldSkipTimerWake(disabledConfig, 0)).toBe(false);
    expect(shouldSkipTimerWake(disabledConfig, 3)).toBe(false);
  });

  it("does not skip when flag is absent, regardless of issue count", () => {
    expect(shouldSkipTimerWake(null, 0)).toBe(false);
    expect(shouldSkipTimerWake({}, 0)).toBe(false);
    expect(shouldSkipTimerWake({ heartbeat: {} }, 0)).toBe(false);
  });

  it("does not skip when count is non-zero with flag enabled (boundary check)", () => {
    expect(shouldSkipTimerWake(enabledConfig, 1)).toBe(false);
  });
});
