import { describe, expect, it } from "vitest";
import {
  classifyHeartbeatRunFailure,
  mergeHeartbeatRunFailureClassification,
} from "../services/heartbeat-failure-classification.js";

describe("classifyHeartbeatRunFailure", () => {
  it("classifies timeout failures", () => {
    expect(classifyHeartbeatRunFailure({ status: "timed_out", timedOut: true })?.failureType)
      .toBe("timeout");
  });

  it("classifies permission/auth failures", () => {
    expect(classifyHeartbeatRunFailure({
      status: "failed",
      errorCode: "access_denied",
      errorMessage: "Forbidden",
    })?.failureType).toBe("permission");
  });

  it("classifies invalid adapter configuration failures", () => {
    expect(classifyHeartbeatRunFailure({
      status: "failed",
      errorMessage: "OpenClaw gateway adapter missing url",
    })?.failureType).toBe("invalid_config");
  });

  it("classifies invalid_request and unsupported adapter/model route failures as invalid config", () => {
    for (const errorMessage of [
      "400 invalid_request: process adapter missing command",
      "unsupported model for adapter route",
      "Gemini adapter unsupported route",
    ]) {
      expect(classifyHeartbeatRunFailure({
        status: "failed",
        errorCode: "invalid_request",
        errorMessage,
      })?.failureType).toBe("invalid_config");
    }
  });

  it("classifies TerminalQuotaError as quota exhaustion", () => {
    expect(classifyHeartbeatRunFailure({
      status: "failed",
      errorMessage: "TerminalQuotaError: shell execution quota exceeded",
    })?.failureType).toBe("quota_exhausted");
  });

  it("classifies exit code 143 and control-plane cancellations", () => {
    expect(classifyHeartbeatRunFailure({
      status: "failed",
      errorMessage: "Claude exited with code 143",
      exitCode: 143,
    })?.failureType).toBe("process_lost");

    expect(classifyHeartbeatRunFailure({
      status: "cancelled",
      errorCode: "cancelled",
      errorMessage: "cancelled by control plane",
    })?.failureType).toBe("control_plane_cancelled");
  });

  it("classifies transient upstream failures as provider errors", () => {
    expect(classifyHeartbeatRunFailure({
      status: "failed",
      errorFamily: "transient_upstream",
      errorMessage: "provider overloaded",
    })?.failureType).toBe("provider_error");
  });

  it("preserves an existing adapter-provided classification", () => {
    expect(classifyHeartbeatRunFailure({
      status: "failed",
      resultJson: { failureType: "quota_exhausted" },
    })).toEqual({
      failureType: "quota_exhausted",
      failureClassifiedFrom: "existing_result_json",
    });
  });

  it("merges classification metadata into result JSON", () => {
    expect(mergeHeartbeatRunFailureClassification(
      { summary: "failed" },
      { failureType: "provider_error", failureClassifiedFrom: "provider_or_upstream" },
    )).toEqual({
      summary: "failed",
      failureType: "provider_error",
      failureClassifiedFrom: "provider_or_upstream",
    });
  });
});
