import { describe, expect, it } from "vitest";
import { NativeProviderTerminalFailure, NativeSessionProtocolIntegrityError, SANDBOX_DISK_FULL_FAILURE_CODE } from "../../vendor/paperclip-runner/index.js";
import { nativeSessionFailureDisposition, nativeSessionFailureSourceCode } from "./native-session-executor.js";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { isSandboxProviderDiskFullError, NATIVE_SANDBOX_DISK_FULL } from "./native-sandbox-disk-full.js";
import { NativeSessionDiagnostics } from "./native-session-diagnostics.js";

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

  it("names the full disk when a failed relaunch reaches the run as a failed event", () => {
    const failed = new NativeProviderTerminalFailure("notification_transport_failed", false,
      "Notification transport failed closed: sandbox_disk_full: the sandbox disk is full, so the runner cannot be started");
    expect(nativeSessionFailureSourceCode(failed)).toBe("sandbox_disk_full");
    const owner = { companyId: "company", sessionScope: "session", runId: "run-a" };
    const channel = new NativeSessionDiagnostics(owner, owner, () => undefined, () => undefined);
    const lease = channel.activate(owner, async () => undefined);
    channel.record("[paperclip-runner] runnerd diagnostic: sandbox_disk_full: the sandbox disk is full, so the runner cannot be started\n");
    expect(lease.sandboxDiskFullObserved()).toBe(true);
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

  it.each(["runner_ingress_unavailable: PRP command session.open timed out", "provider_initialize_timeout", "provider_request_protocol_error",
    "provider_process_status_failed"])("names the full disk for a later %s on the same run", message => {
    expect(nativeSessionFailureSourceCode(new Error(message), true)).toBe("sandbox_disk_full");
    expect(nativeSessionFailureDisposition(1, new Date(), nativeSessionFailureSourceCode(new Error(message), true)))
      .toMatchObject({ phase: "terminal_failure", failureCode: "sandbox_disk_full" });
  });

  it("keeps a full-disk report on the run that saw it", () => {
    const owner = { companyId: "company", sessionScope: "session", runId: "run-a" };
    const channel = new NativeSessionDiagnostics(owner, owner, () => undefined, () => undefined);
    const sink = async () => undefined;
    const first = channel.activate(owner, sink);
    channel.record("[paperclip-runner] runnerd diagnostic: runner process disconnected; recovery is allowed for 420000ms\n");
    expect(first.sandboxDiskFullObserved()).toBe(false);
    channel.record("[paperclip-runner] runnerd diagnostic: failed to write state: No space left on device (os error 28)\n");
    expect(first.sandboxDiskFullObserved()).toBe(true);
    first.retire();
    channel.record("[paperclip-runner] runnerd diagnostic: late exit: No space left on device (os error 28)\n");
    const second = channel.activate({ ...owner, runId: "run-b" }, sink);
    channel.record("[paperclip-runner] runnerd diagnostic: runner process restored its durable PRP session\n");
    expect(second.sandboxDiskFullObserved()).toBe(false);
  });

  it("uses the runner's own code", () => {
    expect(NATIVE_SANDBOX_DISK_FULL).toBe(SANDBOX_DISK_FULL_FAILURE_CODE);
  });
});

describe("a run setup that the sandbox provider refused because the sandbox disk is full", () => {
  const daytonaRefusal = () => new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
    message: "internal server error: failed to create session config directory: "
      + "mkdir /home/daytona/.daytona/sessions/paperclip-78f6ce53: no space left on device" });

  it("names the full disk from the provider plugin's refusal, also when it is wrapped", () => {
    expect(isSandboxProviderDiskFullError(daytonaRefusal())).toBe(true);
    expect(isSandboxProviderDiskFullError(new Error("Reconnect failed", { cause: daytonaRefusal() }))).toBe(true);
    expect(isSandboxProviderDiskFullError(new AggregateError([new Error("other"), daytonaRefusal()], "setup failed"))).toBe(true);
  });

  it("names the full disk from the runner's named failure", () => {
    const launch = Object.assign(new Error("sandbox_disk_full: the sandbox disk is full, so the runner cannot be started"),
      { code: SANDBOX_DISK_FULL_FAILURE_CODE });
    expect(isSandboxProviderDiskFullError(new Error("setup failed", { cause: launch }))).toBe(true);
  });

  it("keeps a full disk on the Paperclip host and other plugin errors as they are", () => {
    const hostDisk = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    expect(isSandboxProviderDiskFullError(hostDisk)).toBe(false);
    expect(isSandboxProviderDiskFullError(new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "unauthorized: authentication failed: Bearer token validation error" }))).toBe(false);
    expect(isSandboxProviderDiskFullError(new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.TIMEOUT,
      message: "no space left on device" }))).toBe(false);
    expect(isSandboxProviderDiskFullError(null)).toBe(false);
  });
});
