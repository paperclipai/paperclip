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
});
