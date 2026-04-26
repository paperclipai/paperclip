import { describe, expect, it } from "vitest";
import { classifyAdapterFailure } from "./adapter-failure-reasons.js";

describe("classifyAdapterFailure", () => {
  it("classifies missing process commands without changing the surfaced UI code", () => {
    expect(classifyAdapterFailure(new Error("Process adapter missing command"), "process")).toEqual({
      adapterFailureReason: "adapter_missing_command",
      surfaceErrorCode: "adapter_failed",
    });
  });

  it("classifies probe timeouts separately from mid-run timeouts", () => {
    expect(classifyAdapterFailure(new Error("Endpoint probe timed out after 3000ms"), "http")).toEqual({
      adapterFailureReason: "adapter_probe_timeout",
      surfaceErrorCode: "adapter_failed",
    });
  });

  it("classifies HTTP invocation failures as protocol errors", () => {
    expect(classifyAdapterFailure(new Error("HTTP invoke failed with status 503"), "http")).toEqual({
      adapterFailureReason: "adapter_protocol_error",
      surfaceErrorCode: "adapter_failed",
    });
  });

  it("preserves adapter-specific surfaced auth codes", () => {
    expect(
      classifyAdapterFailure(
        {
          errorCode: "claude_auth_required",
          errorMessage: "Claude requires login",
        },
        "claude_local",
      ),
    ).toEqual({
      adapterFailureReason: "adapter_auth_failed",
      surfaceErrorCode: "claude_auth_required",
    });
  });
});
