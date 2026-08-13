import { describe, expect, it } from "vitest";
import {
  SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_CEILING,
  SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT,
  parseSuccessfulRunMissingStateMaxAttempts,
} from "./service.js";

describe("parseSuccessfulRunMissingStateMaxAttempts", () => {
  it("returns the default for missing, empty, or non-integer values", () => {
    expect(parseSuccessfulRunMissingStateMaxAttempts(undefined)).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT,
    );
    expect(parseSuccessfulRunMissingStateMaxAttempts("")).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT,
    );
    expect(parseSuccessfulRunMissingStateMaxAttempts("  ")).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT,
    );
    expect(parseSuccessfulRunMissingStateMaxAttempts("3.5")).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT,
    );
    expect(parseSuccessfulRunMissingStateMaxAttempts("Infinity")).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT,
    );
    expect(parseSuccessfulRunMissingStateMaxAttempts("1e3")).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT,
    );
    expect(parseSuccessfulRunMissingStateMaxAttempts("abc")).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT,
    );
  });

  it("rejects zero, negatives, and values above the int32 ceiling", () => {
    expect(parseSuccessfulRunMissingStateMaxAttempts("0")).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT,
    );
    expect(parseSuccessfulRunMissingStateMaxAttempts("-1")).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT,
    );
    expect(
      parseSuccessfulRunMissingStateMaxAttempts(String(SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_CEILING + 1)),
    ).toBe(SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT);
  });

  it("accepts finite integers in the persistable range", () => {
    expect(parseSuccessfulRunMissingStateMaxAttempts("1")).toBe(1);
    expect(parseSuccessfulRunMissingStateMaxAttempts("3")).toBe(3);
    expect(parseSuccessfulRunMissingStateMaxAttempts(" 12 ")).toBe(12);
    expect(parseSuccessfulRunMissingStateMaxAttempts(String(SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_CEILING))).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_CEILING,
    );
  });
});
