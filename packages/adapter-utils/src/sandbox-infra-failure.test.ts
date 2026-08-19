import { describe, expect, it } from "vitest";
import {
  SANDBOX_NOT_READY_ERROR_CODE,
  SANDBOX_UNSCHEDULABLE_ERROR_CODE,
  classifySandboxInfraFailure,
} from "./sandbox-infra-failure.js";

describe("classifySandboxInfraFailure", () => {
  it("classifies the kubernetes plugin's unschedulable message as sandbox_unschedulable", () => {
    expect(
      classifySandboxInfraFailure(
        "Sandbox pod could not be scheduled: cluster has no capacity for it. This is an infrastructure issue, not a problem with your task.",
      ),
    ).toBe(SANDBOX_UNSCHEDULABLE_ERROR_CODE);
  });

  it("classifies the message when it is embedded in a prep-exec failure wrapper", () => {
    expect(
      classifySandboxInfraFailure(
        "command -v 'opencode' >/dev/null 2>&1 failed with exit code 1: Sandbox pod could not be scheduled: cluster has no capacity for it.",
      ),
    ).toBe(SANDBOX_UNSCHEDULABLE_ERROR_CODE);
  });

  it("classifies the plugin's readiness-timeout message as sandbox_not_ready", () => {
    expect(
      classifySandboxInfraFailure("Sandbox pod did not become Ready within 300000ms"),
    ).toBe(SANDBOX_NOT_READY_ERROR_CODE);
  });

  it("classifies the orchestrator's raw timeout message as sandbox_not_ready", () => {
    expect(
      classifySandboxInfraFailure(
        "Sandbox paperclip-acme/pc-abc did not reach Ready phase within 300000ms",
      ),
    ).toBe(SANDBOX_NOT_READY_ERROR_CODE);
  });

  it("prefers the unschedulable class when both markers appear", () => {
    expect(
      classifySandboxInfraFailure(
        "Sandbox pod did not become Ready within 300000ms; Sandbox pod could not be scheduled: cluster has no capacity for it.",
      ),
    ).toBe(SANDBOX_UNSCHEDULABLE_ERROR_CODE);
  });

  it("returns null for unrelated failures", () => {
    expect(classifySandboxInfraFailure("OpenCode exited with code 1")).toBeNull();
    expect(classifySandboxInfraFailure("fatal: repository not found")).toBeNull();
    expect(classifySandboxInfraFailure("")).toBeNull();
    expect(classifySandboxInfraFailure(null)).toBeNull();
    expect(classifySandboxInfraFailure(undefined)).toBeNull();
  });
});
