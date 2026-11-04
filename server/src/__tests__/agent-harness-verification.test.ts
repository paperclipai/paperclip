import { describe, expect, it } from "vitest";
import type { AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
import { assertHarnessTestPassed } from "../services/agent-harness-verification.js";

describe("saved harness verification", () => {
  const result = (status: AdapterEnvironmentTestResult["status"], codes: string[]): AdapterEnvironmentTestResult => ({
    adapterType: "test", status, testedAt: new Date().toISOString(),
    checks: codes.map(code => ({ code, level: "info", message: code })),
  });
  it.each([
    ["opencode_hello_probe_auth_required", "harness_auth_failed"],
    ["opencode_hello_probe_model_unavailable", "harness_model_unavailable"],
    ["opencode_command_unresolvable", "harness_command_unavailable"],
    ["opencode_cwd_invalid", "harness_cwd_invalid"],
    ["opencode_hello_probe_timed_out", "harness_probe_timed_out"],
    ["opencode_hello_probe_unexpected_output", "harness_probe_unexpected_output"],
    ["private provider error", "harness_test_failed"],
  ])("classifies %s without keeping provider output", (checkCode, code) => {
    try {
      assertHarnessTestPassed(result("fail", [checkCode]));
      expect.fail("Expected verification to fail");
    } catch (error) {
      expect(error).toMatchObject({ code, message: "The harness test failed" });
    }
  });
  it("preserves a retryable failed check before classifying configuration failures", () => {
    const temporary = result("fail", ["opencode_cwd_invalid", "opencode_command_unresolvable"]);
    temporary.checks[0] = { ...temporary.checks[0], level: "error", retryable: true };
    expect(() => assertHarnessTestPassed(temporary)).toThrow(expect.objectContaining({ code: "test_environment_unavailable" }));
    temporary.checks[0].level = "info";
    expect(() => assertHarnessTestPassed(temporary)).toThrow(expect.objectContaining({ code: "harness_command_unavailable" }));
  });
  it.each([
    ["fail", []], ["warn", ["claude_hello_probe_auth_required"]],
    ["warn", ["gemini_hello_probe_timed_out"]], ["pass", ["claude_hello_probe_skipped_custom_command"]],
    ["warn", ["claude_acp_anthropic_api_key_detected", "claude_acp_login_probe_unavailable"]],
    ["warn", ["cli_version_probe_mismatch"]], ["pass", [ADAPTER_AUTH_MISSING_CHECK_CODE]],
    ["warn", ["claude_hello_probe_passed", "claude_hello_probe_auth_required"]],
    ["pass", ["COPILOT_AUTH_REQUIRED"]], ["fail", ["COPILOT_MODEL_UNAVAILABLE"]],
  ] as const)("rejects %s with %j", (status, codes) => {
    expect(() => assertHarnessTestPassed(result(status, [...codes]))).toThrow("The harness test failed");
  });
  it.each([
    ["pass", ["process_command_available"]], ["warn", ["claude_hello_probe_passed", "optional_environment_warning"]],
    ["warn", ["claude_acp_anthropic_api_key_detected", "claude_hello_probe_passed"]],
    ["pass", ["codex_hello_probe_succeeded"]], ["warn", ["ai_connection_api_key_reverified"]],
    ["pass", ["copilot_metadata_verified"]], ["warn", ["copilot_metadata_verified"]],
  ] as const)("accepts %s with %j", (status, codes) => {
    expect(() => assertHarnessTestPassed(result(status, [...codes]))).not.toThrow();
  });

  const cloudAccountResult = (modelListed = true): AdapterEnvironmentTestResult => ({
    adapterType: "paperclip_runner", status: "warn", testedAt: new Date().toISOString(),
    checks: [
      { code: "cursor_cloud_account_ready", level: "info", message: "The bound key can read its catalog. No prompt was sent." },
      { code: modelListed ? "cursor_cloud_model_listed" : "cursor_cloud_model_unlisted", level: modelListed ? "info" : "warn", message: "Exact model availability is decided by Cursor." },
      { code: "cursor_cloud_model_identity_unverified", level: "warn", message: "Cursor does not acknowledge the effective model." },
    ],
  });

  it.each([true, false])("admits an authenticated experimental Cloud account with model listed=%s", modelListed => {
    expect(() => assertHarnessTestPassed(cloudAccountResult(modelListed))).not.toThrow();
  });

  it("keeps an unverified Cloud warning blocked without an informational account receipt", () => {
    const unverified = cloudAccountResult();
    unverified.checks[0].level = "warn";
    expect(() => assertHarnessTestPassed(unverified)).toThrow("The harness test failed");
  });

  it("does not accept the Cloud receipt from an unrelated adapter", () => {
    const unrelated = { ...cloudAccountResult(), adapterType: "test" };
    expect(() => assertHarnessTestPassed(unrelated)).toThrow("The harness test failed");
  });

  it.each(["fail", "warn"] as const)("keeps a %s authentication failure blocked despite a Cloud account receipt", status => {
    const failed = cloudAccountResult();
    failed.status = status;
    failed.checks.push({ code: ADAPTER_AUTH_MISSING_CHECK_CODE, level: "error", message: "Authentication required" });
    expect(() => assertHarnessTestPassed(failed)).toThrow("The harness test failed");
  });
});
