import { describe, expect, it } from "vitest";
import { hasExplicitSuccessfulResult } from "../services/heartbeat.js";

describe("heartbeat run outcome helpers", () => {
  it("treats subtype=success as an explicit success", () => {
    expect(
      hasExplicitSuccessfulResult({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: null,
        resultJson: {
          subtype: "success",
          is_error: false,
          result: "completed",
        },
      }),
    ).toBe(true);
  });

  it("does not treat explicit error results as success", () => {
    expect(
      hasExplicitSuccessfulResult({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "boom",
        resultJson: {
          subtype: "error",
          is_error: true,
          result: "boom",
        },
      }),
    ).toBe(false);
  });
});
