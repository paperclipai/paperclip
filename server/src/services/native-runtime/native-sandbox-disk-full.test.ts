import { describe, expect, it } from "vitest";
import { NativeProviderTerminalFailure, NativeSessionProtocolIntegrityError, SANDBOX_DISK_FULL_FAILURE_CODE } from "../../vendor/paperclip-runner/index.js";
import { nativeSessionFailureDisposition, nativeSessionFailureSourceCode } from "./native-session-executor.js";
import { NATIVE_SANDBOX_DISK_FULL, observeNativeRunnerDiagnostic, takeNativeRunnerSandboxDiskFull } from "./native-sandbox-disk-full.js";

const turnLostOnRestore = () => new NativeProviderTerminalFailure("provider_turn_lost_on_restore", true);

describe("a native run that ends because its sandbox disk filled", () => {
  it("names the full disk and stops instead of retrying the same work", () => {
    const code = nativeSessionFailureSourceCode(turnLostOnRestore(), true);
    expect(code).toBe("sandbox_disk_full");
    expect(nativeSessionFailureDisposition(1, new Date(), code)).toEqual({
      phase: "terminal_failure", failureCode: "sandbox_disk_full", nextAttemptAt: null });
  });

  it("names the full disk when the runner could not be relaunched on it", () => {
    const launch = Object.assign(new Error("sandbox_disk_full: the sandbox disk is full, so the runner cannot be started"),
      { code: SANDBOX_DISK_FULL_FAILURE_CODE });
    const transport = new Error("Notification transport failed closed: sandbox_disk_full: the sandbox disk is full", { cause: launch });
    expect(nativeSessionFailureSourceCode(transport)).toBe("sandbox_disk_full");
  });

  it("keeps other failures as they are", () => {
    expect(nativeSessionFailureSourceCode(turnLostOnRestore())).toBe("native_provider_terminal_failed");
    expect(nativeSessionFailureSourceCode(new NativeSessionProtocolIntegrityError("semantic_input_digest_mismatch"), true))
      .toBe("native_event_replay_conflict");
    expect(nativeSessionFailureSourceCode(new NativeProviderTerminalFailure("approval_required", false, "Approval required"), true))
      .toBe("native_provider_approval_required");
    expect(nativeSessionFailureDisposition(1, new Date(), nativeSessionFailureSourceCode(new Error("runnerd exited"))))
      .toMatchObject({ phase: "retryable_failure" });
  });

  it("remembers a disk-full runner exit for its own run only, once", () => {
    observeNativeRunnerDiagnostic("run-a", "runner process disconnected; recovery is allowed for 420000ms");
    expect(takeNativeRunnerSandboxDiskFull("run-a")).toBe(false);
    observeNativeRunnerDiagnostic("run-a", "Error: failed to write state: No space left on device (os error 28)");
    expect(takeNativeRunnerSandboxDiskFull("run-b")).toBe(false);
    expect(takeNativeRunnerSandboxDiskFull("run-a")).toBe(true);
    expect(takeNativeRunnerSandboxDiskFull("run-a")).toBe(false);
  });

  it("uses the runner's own code", () => {
    expect(NATIVE_SANDBOX_DISK_FULL).toBe(SANDBOX_DISK_FULL_FAILURE_CODE);
  });
});
