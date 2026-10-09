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
    ["fail", []], ["warn", ["claude_hello_probe_auth_required"]],
    ["warn", ["gemini_hello_probe_timed_out"]], ["pass", ["claude_hello_probe_skipped_custom_command"]],
    ["warn", ["cli_version_probe_mismatch"]], ["pass", [ADAPTER_AUTH_MISSING_CHECK_CODE]],
    ["warn", ["claude_hello_probe_passed", "claude_hello_probe_auth_required"]],
  ] as const)("rejects %s with %j", (status, codes) => {
    expect(() => assertHarnessTestPassed(result(status, [...codes]))).toThrow("The harness test failed");
  });
  it.each([
    ["pass", ["process_command_available"]], ["warn", ["claude_hello_probe_passed", "optional_environment_warning"]],
    ["pass", ["codex_hello_probe_succeeded"]], ["warn", ["ai_connection_api_key_reverified"]],
  ] as const)("accepts %s with %j", (status, codes) => {
    expect(() => assertHarnessTestPassed(result(status, [...codes]))).not.toThrow();
  });
});
