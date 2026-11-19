import { describe, expect, it } from "vitest";
import { explainNativeTurnFailure, NATIVE_RUN_FAILED_UNEXPLAINED } from "./native-run-failure-explanation.js";

describe("explainNativeTurnFailure", () => {
  const explained = (provider: string, cause: string) => ({
    errorCode: NATIVE_RUN_FAILED_UNEXPLAINED.errorCode,
    error: `The ${provider} turn failed (${cause}). Inspect the run events for the last recorded step.`,
  });

  it("names a runner-issued failure code", () => {
    expect(explainNativeTurnFailure({ provider: "opencode", category: "turn_failed", runnerFailureCode: "opencode_empty_response" }))
      .toEqual(explained("OpenCode", "opencode_empty_response"));
    expect(explainNativeTurnFailure({ provider: "codex", category: "turn_failed", codexErrorInfo: "other", runnerFailureCode: "turn_binding_mismatch" }))
      .toEqual(explained("Codex", "turn_binding_mismatch"));
  });

  it("names a specific Codex error kind when no runner code was issued", () => {
    expect(explainNativeTurnFailure({ provider: "codex", category: "turn_failed", codexErrorInfo: "usageLimitExceeded", httpStatus: 429 }))
      .toEqual(explained("Codex", "usageLimitExceeded"));
  });

  it("leaves a failure without a specific cause unexplained", () => {
    expect(explainNativeTurnFailure(null)).toBeNull();
    expect(explainNativeTurnFailure({ provider: "opencode", category: "turn_failed" })).toBeNull();
    expect(explainNativeTurnFailure({ provider: "opencode", category: "turn_failed", runnerFailureCode: "unrecognized" })).toBeNull();
    for (const codexErrorInfo of ["absent", "unrecognized", "other"]) {
      expect(explainNativeTurnFailure({ provider: "codex", category: "turn_failed", codexErrorInfo, runnerFailureCode: "unrecognized" })).toBeNull();
    }
  });
});
