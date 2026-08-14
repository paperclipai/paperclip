import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

// A shared handle so each test can set the stub Claude hello-probe output the
// sandbox runner returns.
const { runAdapterExecutionTargetProcess, probeResult } = vi.hoisted(() => {
  const probeResult: {
    value: { exitCode: number; stdout: string; stderr: string; timedOut: boolean };
    throwError: Error | null;
  } = {
    value: { exitCode: 1, stdout: "", stderr: "", timedOut: false },
    throwError: null,
  };
  return {
    probeResult,
    runAdapterExecutionTargetProcess: vi.fn(async () => {
      if (probeResult.throwError) throw probeResult.throwError;
      return {
        exitCode: probeResult.value.exitCode,
        signal: null,
        timedOut: probeResult.value.timedOut,
        stdout: probeResult.value.stdout,
        stderr: probeResult.value.stderr,
        pid: 321,
        startedAt: new Date().toISOString(),
      };
    }),
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    runAdapterExecutionTargetProcess,
  };
});

import { mapClaudeAcpAuthErrorCode, probeClaudeAcpSandboxLogin } from "./acp.js";
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "./auth-check.js";

const sandboxTarget: AdapterExecutionTarget = {
  kind: "remote",
  transport: "sandbox",
  providerKey: "daytona",
  remoteCwd: "/home/daytona/paperclip-workspace",
  runner: {
    execute: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: new Date().toISOString(),
    }),
  },
};

const initLine =
  '{"type":"system","subtype":"init","cwd":"/home/daytona/paperclip-workspace","session_id":"abc","tools":["Bash","Read"]}';

const loginRequiredStdout = [
  initLine,
  '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Please run `claude login` to authenticate.","session_id":"abc"}',
].join("\n");

const helloStdout = [
  initLine,
  '{"type":"result","subtype":"success","is_error":false,"result":"hello","session_id":"abc"}',
].join("\n");

afterEach(() => {
  vi.clearAllMocks();
  probeResult.value = { exitCode: 1, stdout: "", stderr: "", timedOut: false };
  probeResult.throwError = null;
});

describe("mapClaudeAcpAuthErrorCode", () => {
  it("translates the generic acpx_auth_required code into claude_auth_required", () => {
    const engineResult: AdapterExecutionResult = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Claude requires login.",
      errorCode: "acpx_auth_required",
      errorMeta: { category: "auth", errorName: "Error" },
    };

    const mapped = mapClaudeAcpAuthErrorCode(engineResult);

    // The user interface run gate reads claude_auth_required to show the login
    // affordance on the default ACP path.
    expect(mapped.errorCode).toBe("claude_auth_required");
    // The mapping keeps every other field so diagnostics stay intact.
    expect(mapped.errorMessage).toBe("Claude requires login.");
    expect(mapped.errorMeta).toEqual({ category: "auth", errorName: "Error" });
  });

  it("leaves a different error code unchanged", () => {
    const engineResult: AdapterExecutionResult = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "acpx_runtime_error",
    };

    expect(mapClaudeAcpAuthErrorCode(engineResult).errorCode).toBe("acpx_runtime_error");
  });

  it("leaves a null error code unchanged", () => {
    const engineResult: AdapterExecutionResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorCode: null,
    };

    expect(mapClaudeAcpAuthErrorCode(engineResult).errorCode).toBeNull();
  });
});

describe("probeClaudeAcpSandboxLogin", () => {
  it("emits the canonical adapter_auth_missing check when the sandbox probe reports missing auth", async () => {
    probeResult.value = { exitCode: 1, stdout: loginRequiredStdout, stderr: "", timedOut: false };

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    expect(checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(true);
    // The descriptive check stays for diagnostics.
    expect(checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(true);
    // A missing-auth probe is a warning, not a failure, so the environment stays
    // testable and the user interface can offer login.
    expect(checks.every((check) => check.level === "warn")).toBe(true);
  });

  it("emits no checks when the sandbox probe reports a healthy login", async () => {
    probeResult.value = { exitCode: 0, stdout: helloStdout, stderr: "", timedOut: false };

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    expect(checks).toEqual([]);
  });

  it("fails safe and emits no checks when the probe cannot run", async () => {
    probeResult.throwError = new Error("claude command not found");

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    expect(checks).toEqual([]);
  });

  it("fails safe and emits no checks when the probe times out", async () => {
    probeResult.value = { exitCode: null as unknown as number, stdout: "", stderr: "", timedOut: true };

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    expect(checks).toEqual([]);
  });
});
