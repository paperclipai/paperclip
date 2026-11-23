import { describe, expect, it } from "vitest";
import { nativeSessionFailureDisposition, nativeSessionFailureSourceCode } from "./native-session-executor.js";
import { NATIVE_RUN_PAYLOAD_TOO_LARGE } from "./native-run-payload-too-large.js";

describe("a native run whose setup is too large for the runner", () => {
  it.each([
    "durable_prp_canonical_json_too_large",
    "runner_ingress_unavailable: command_payload_too_large",
  ])("stops on the first attempt for %s instead of retrying the same setup", message => {
    const code = nativeSessionFailureSourceCode(new Error(message));
    expect(code).toBe(NATIVE_RUN_PAYLOAD_TOO_LARGE);
    expect(nativeSessionFailureDisposition(1, new Date(), code)).toEqual({
      phase: "terminal_failure", failureCode: NATIVE_RUN_PAYLOAD_TOO_LARGE, nextAttemptAt: null });
  });

  it("keeps naming the oversized setup when the sandbox disk is also full", () => {
    expect(nativeSessionFailureSourceCode(new Error("durable_prp_canonical_json_too_large"), true)).toBe(NATIVE_RUN_PAYLOAD_TOO_LARGE);
  });
});
