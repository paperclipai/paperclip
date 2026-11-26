import { describe, expect, it } from "vitest";
import {
  isNativeRunnerOwnershipHeld,
  NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE,
} from "./native-runner-ownership.js";

describe("durable native runner ownership hold", () => {
  const held = {
    runtimeMode: "native",
    status: "running",
    nativePhase: "terminal_failure",
    errorCode: NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE,
  };
  it("retains the authentication hold through process absence and coordinator expiry", () => {
    expect(isNativeRunnerOwnershipHeld(held)).toBe(true);
    expect(
      isNativeRunnerOwnershipHeld({
        ...held,
        nativePhase: "observed",
        errorCode: "native_adopted_runner_authentication_timeout",
      }),
    ).toBe(true);
  });
  it.each([
    { runtimeMode: "legacy" },
    { status: "failed" },
    { status: "succeeded" },
    { nativePhase: "observed" },
    { nativePhase: "retryable_failure" },
    { errorCode: "native_session_retry_exhausted" },
  ])("does not change ordinary or resolved recovery: %j", (override) => {
    expect(isNativeRunnerOwnershipHeld({ ...held, ...override })).toBe(false);
  });
});
