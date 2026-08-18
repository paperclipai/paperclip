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

// The real Claude CLI output for CLAUDE_CODE_OAUTH_TOKEN=invalid. The probe
// exits non-zero and the result event reports a 401 authentication failure with
// an "Invalid bearer token" message. A synthetic bearer marker rides along on a
// retry line, so the test can prove the raw probe text never reaches a check.
const invalidTokenMarker = "SUPERSECRETbearerMARKER";
const invalidTokenStdout = [
  initLine,
  `{"type":"system","subtype":"api_retry","attempt":1,"error_status":401,"error":"authentication_failed: bearer ${invalidTokenMarker} is invalid","session_id":"abc"}`,
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Failed to authenticate. API Error: 401 Invalid bearer token"}]},"session_id":"abc","error":"authentication_failed"}',
  '{"type":"result","subtype":"success","is_error":true,"api_error_status":401,"error":"authentication_failed","result":"Failed to authenticate. API Error: 401 Invalid bearer token","session_id":"abc"}',
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

  it("classifies an invalid or expired token as adapter_auth_missing without leaking the token", async () => {
    probeResult.value = { exitCode: 1, stdout: invalidTokenStdout, stderr: "", timedOut: false };

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    // An auth failure returns the canonical login gate code, not the
    // probe-could-not-run code.
    expect(checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(true);
    expect(checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(true);
    expect(checks.some((check) => check.code === "claude_acp_login_probe_unavailable")).toBe(false);
    // The raw probe text, including the bearer marker, never reaches a check.
    expect(JSON.stringify(checks)).not.toContain(invalidTokenMarker);
  });

  it("does not flag a healthy probe whose assistant text repeats a token phrase", async () => {
    // A healthy run prints an auth phrase in its answer text. The parsed result
    // is a success, so the probe stays healthy and offers no login gate.
    probeResult.value = {
      exitCode: 0,
      stdout: [
        initLine,
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello — note authentication_failed means an invalid bearer token"}]},"session_id":"abc"}',
        '{"type":"result","subtype":"success","is_error":false,"result":"hello","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
      timedOut: false,
    };

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    // The parsed result is a success, so no login gate and no probe-unavailable
    // check appears.
    expect(checks).toEqual([]);
  });

  it("keeps a non-auth failed probe with a token phrase on the probe-unavailable path", async () => {
    // The probe fails on a transient upstream error and prints an auth phrase in
    // its assistant text. The parsed result is not an auth failure, so the probe
    // stays on the neutral probe-unavailable code, not the login gate.
    probeResult.value = {
      exitCode: 1,
      stdout: [
        initLine,
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"authentication_failed: the bearer token is invalid"}]},"session_id":"abc"}',
        '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: 503 service unavailable","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
      timedOut: false,
    };

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    expect(checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(false);
    expect(checks.some((check) => check.code === "claude_acp_login_probe_unavailable")).toBe(true);
  });

  it("never renders an untrusted login URL with sensitive query or fragment text", async () => {
    // The sandbox prints a login-required line that carries a malicious URL. The
    // URL has a non-allowlisted host, a query, and a fragment, each with a
    // marker. The normalizer must reject the URL, so no marker reaches a check.
    probeResult.value = {
      exitCode: 1,
      stdout: [
        initLine,
        '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Please run `claude login`. Visit https://evil.example.com/claude-login?leak=SECRETQUERYmarker#SECRETFRAGmarker","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
      timedOut: false,
    };

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    // The login-required checks still appear.
    expect(checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(true);
    expect(checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(true);
    const checkText = JSON.stringify(checks);
    // No marker and no untrusted host reaches any check.
    expect(checkText).not.toContain("SECRETQUERYmarker");
    expect(checkText).not.toContain("SECRETFRAGmarker");
    expect(checkText).not.toContain("evil.example.com");
    // The hint falls back to the fixed `claude login` text.
    const authRequired = checks.find((check) => check.code === "claude_hello_probe_auth_required");
    expect(authRequired?.hint).toBe("Run `claude login` in this environment, then retry the probe.");
  });

  it("emits no checks when the sandbox probe reports a healthy login", async () => {
    probeResult.value = { exitCode: 0, stdout: helloStdout, stderr: "", timedOut: false };

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    expect(checks).toEqual([]);
  });

  it("emits a distinct warn check, not a silent pass, when the probe cannot run", async () => {
    probeResult.throwError = new Error("claude command not found");

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    // A probe that cannot run must not report a success. It emits a distinct
    // warn check that is NOT the login affordance code.
    expect(checks).toHaveLength(1);
    expect(checks[0]?.code).toBe("claude_acp_login_probe_unavailable");
    expect(checks[0]?.level).toBe("warn");
    expect(checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(false);
  });

  it("emits a distinct warn check when the probe times out", async () => {
    probeResult.value = { exitCode: null as unknown as number, stdout: "", stderr: "", timedOut: true };

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    expect(checks).toHaveLength(1);
    expect(checks[0]?.code).toBe("claude_acp_login_probe_unavailable");
    expect(checks[0]?.level).toBe("warn");
    expect(checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(false);
  });

  it("emits a distinct warn check when the probe runs but does not complete", async () => {
    // The probe ran, login is not detected, and the exit code is non-zero. This
    // is not a healthy login, so it must not be a silent pass.
    probeResult.value = {
      exitCode: 1,
      stdout: initLine,
      stderr: "unexpected sandbox error",
      timedOut: false,
    };

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    expect(checks).toHaveLength(1);
    expect(checks[0]?.code).toBe("claude_acp_login_probe_unavailable");
    expect(checks[0]?.level).toBe("warn");
  });

  it("never copies a thrown probe error into a Test-result check", async () => {
    // A sandbox transport failure can carry a credential. Inject a secret
    // marker through the thrown error and assert no check text repeats it.
    const secret = "sk-ant-LEAKMARKER0123456789abcdef";
    probeResult.throwError = new Error(`transport failed with ${secret}`);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    const checkText = JSON.stringify(checks);
    expect(checkText).not.toContain(secret);
    expect(checkText).not.toContain("LEAKMARKER");
    expect(checks[0]?.code).toBe("claude_acp_login_probe_unavailable");
    // The diagnostic still reaches the server log, but the secret is redacted.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(secret);
    expect(loggedText).toContain("***REDACTED***");
    warnSpy.mockRestore();
  });

  it("never copies raw probe stderr or stdout into a Test-result check", async () => {
    // A non-zero probe can print a credential to stderr. Inject a secret marker
    // and assert no check text repeats it.
    const secret = "sk-ant-STDERRMARKER0123456789abcdef";
    probeResult.value = {
      exitCode: 2,
      stdout: initLine,
      stderr: `fatal: leaked ${secret}`,
      timedOut: false,
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    const checkText = JSON.stringify(checks);
    expect(checkText).not.toContain(secret);
    expect(checkText).not.toContain("STDERRMARKER");
    expect(checks[0]?.code).toBe("claude_acp_login_probe_unavailable");
    // The diagnostic still reaches the server log, but the secret is redacted.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(secret);
    expect(loggedText).toContain("***REDACTED***");
    warnSpy.mockRestore();
  });
});
