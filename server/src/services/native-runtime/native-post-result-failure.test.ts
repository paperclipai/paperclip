import { describe, expect, it } from "vitest";
import { NativeSessionCloseUnrecoverableError } from "../../vendor/paperclip-runner/index.js";
import { nativePostResultFailureCategory, readNativePostResultFailureDiagnostic } from "./native-post-result-failure.js";

describe("native post-result failure diagnostic", () => {
  it("names a runner that kept the result but did not prove its suspension", () => {
    const unsettled = new NativeSessionCloseUnrecoverableError({ runnerSuspended: false, providerDrained: false }, true);
    expect(nativePostResultFailureCategory(unsettled)).toBe("runner_settlement_incomplete");
    expect(nativePostResultFailureCategory(new AggregateError([unsettled], "close and receipt failed")))
      .toBe("runner_settlement_incomplete");
    expect(nativePostResultFailureCategory(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe("io_not_found");
    expect(nativePostResultFailureCategory(new Error("SYNTHETIC other failure"))).toBe("execution_failure");
  });

  it("reads only the closed labels from an error or its cause", () => {
    const diagnostic = { stage: "post_result_execution", category: "runner_settlement_incomplete", resultAlreadyAccepted: true };
    const control = Object.assign(new Error("native_session_lease_lost"), { diagnostic });
    expect(readNativePostResultFailureDiagnostic(control)).toEqual(diagnostic);
    expect(readNativePostResultFailureDiagnostic(new Error("wrapped", { cause: control }))).toEqual(diagnostic);
    expect(readNativePostResultFailureDiagnostic(Object.assign(new Error("native_session_lease_lost"),
      { diagnostic: { ...diagnostic, category: "/SYNTHETIC/private" } }))).toBeNull();
    expect(readNativePostResultFailureDiagnostic(new Error("native_session_lease_lost"))).toBeNull();
  });
});
