import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const {
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  probeResult,
} = vi.hoisted(() => {
  const probeResult: {
    value: { exitCode: number; stdout: string; stderr: string };
    throwError: Error | null;
  } = {
    value: { exitCode: 1, stdout: "", stderr: "" },
    throwError: null,
  };
  return {
    probeResult,
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    maybeRunSandboxInstallCommand: vi.fn(async () => null),
    runAdapterExecutionTargetProcess: vi.fn(async () => {
      if (probeResult.throwError) throw probeResult.throwError;
      return {
        exitCode: probeResult.value.exitCode,
        signal: null,
        timedOut: false,
        stdout: probeResult.value.stdout,
        stderr: probeResult.value.stderr,
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    }),
    describeAdapterExecutionTarget: vi.fn(() => "Daytona"),
    resolveAdapterExecutionTargetCwd: vi.fn(() => "/home/daytona/paperclip-workspace"),
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetDirectory,
    ensureAdapterExecutionTargetCommandResolvable,
    maybeRunSandboxInstallCommand,
    runAdapterExecutionTargetProcess,
    describeAdapterExecutionTarget,
    resolveAdapterExecutionTargetCwd,
  };
});

import { testEnvironment } from "./test.js";

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

afterEach(() => {
  vi.clearAllMocks();
  probeResult.throwError = null;
});

describe("claude sandbox hello probe diagnostics", () => {
  it("keeps the raw failure result out of every check and out of the log", async () => {
    // The non-zero result event carries a marker. The check must not repeat the
    // marker, and the log must carry only the allowlisted classification.
    const marker = "NONPATTERNMARKERfailure";
    probeResult.value = {
      exitCode: 1,
      stdout: [
        initLine,
        `{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: 404 model not found ${marker}","session_id":"abc"}`,
      ].join("\n"),
      stderr: "",
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude", model: "claude-opus-4-8" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).toBe("fail");
    const failed = result.checks.find((check) => check.code === "claude_hello_probe_failed");
    expect(failed).toBeTruthy();
    // The public check carries only a fixed message and hint, no raw detail.
    expect(failed?.detail).toBeUndefined();
    const checkText = JSON.stringify(result.checks);
    expect(checkText).not.toContain(marker);
    // The unhelpful init line must never reach a check either.
    expect(checkText).not.toContain('"subtype":"init"');
    // The raw diagnostic never reaches the server log. The log carries only the
    // fixed context and an allowlisted classification.
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(marker);
    expect(loggedText).toContain("nonzero_exit");
    warnSpy.mockRestore();
  });

  it("keeps a stdout-fallback failure line out of every check and out of the log", async () => {
    // The CLI dies before a result event, so the last non-init stdout line is
    // the diagnostic. The check and the log must not repeat its marker.
    const marker = "NONPATTERNMARKERstdout";
    probeResult.value = {
      exitCode: 1,
      stdout: [initLine, `fatal: claude crashed ${marker}`].join("\n"),
      stderr: "",
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    const failed = result.checks.find((check) => check.code === "claude_hello_probe_failed");
    expect(failed).toBeTruthy();
    expect(failed?.detail).toBeUndefined();
    const checkText = JSON.stringify(result.checks);
    expect(checkText).not.toContain(marker);
    expect(checkText).not.toContain('"subtype":"init"');
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(marker);
    expect(loggedText).toContain("nonzero_exit");
    warnSpy.mockRestore();
  });

  it("never copies a credential-bearing stderr failure line into a check or the log", async () => {
    // A verbose CLI can print a credential to stderr on failure. The check and
    // the log must not repeat it.
    const secret = "sk-ant-STDERRLEAK0123456789abcdef";
    probeResult.value = {
      exitCode: 1,
      stdout: initLine,
      stderr: `fatal: request failed with token ${secret}`,
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    const checkText = JSON.stringify(result.checks);
    expect(checkText).not.toContain(secret);
    expect(checkText).not.toContain("STDERRLEAK");
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(secret);
    expect(loggedText).not.toContain("STDERRLEAK");
    expect(loggedText).toContain("nonzero_exit");
    warnSpy.mockRestore();
  });

  it("keeps an auth-required probe marker out of every check", async () => {
    // The auth-required stdout and stderr carry a marker. The login-required
    // checks must not repeat it, and the login gate code must stay stable.
    const marker = "NONPATTERNMARKERauthcli";
    probeResult.value = {
      exitCode: 1,
      stdout: [
        initLine,
        `{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Please run \`claude login\` ${marker}","session_id":"abc"}`,
      ].join("\n"),
      stderr: `Please run claude login ${marker}`,
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(true);
    // The login gate code stays stable so the user interface can offer login.
    expect(result.checks.some((check) => check.code === "adapter_auth_missing")).toBe(true);
    const checkText = JSON.stringify(result.checks);
    expect(checkText).not.toContain(marker);
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(marker);
    expect(loggedText).toContain("auth_required");
    warnSpy.mockRestore();
  });

  it("classifies an invalid or expired token as adapter_auth_missing without leaking the token", async () => {
    // Grounded on the real Claude CLI output for CLAUDE_CODE_OAUTH_TOKEN=invalid.
    // The probe exits non-zero and the result event reports a 401 authentication
    // failure with an "Invalid bearer token" message. A synthetic bearer marker
    // rides along on a retry line, so the test proves the raw text never reaches
    // a check.
    const marker = "SUPERSECRETbearerMARKERcli";
    probeResult.value = {
      exitCode: 1,
      stdout: [
        initLine,
        `{"type":"system","subtype":"api_retry","attempt":1,"error_status":401,"error":"authentication_failed: bearer ${marker} is invalid","session_id":"abc"}`,
        '{"type":"result","subtype":"success","is_error":true,"api_error_status":401,"error":"authentication_failed","result":"Failed to authenticate. API Error: 401 Invalid bearer token","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    // An auth failure returns the canonical login gate code, so the user
    // interface can offer login.
    expect(result.checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(true);
    expect(result.checks.some((check) => check.code === "adapter_auth_missing")).toBe(true);
    // The raw probe text, including the bearer marker, never reaches a check.
    expect(JSON.stringify(result.checks)).not.toContain(marker);
    warnSpy.mockRestore();
  });

  it("does not flag a healthy probe whose assistant text repeats a token phrase", async () => {
    // A healthy run prints an auth phrase in its answer text. The parsed result
    // is a success, so the probe stays healthy and offers no login gate.
    probeResult.value = {
      exitCode: 0,
      stdout: [
        initLine,
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello — authentication_failed means an invalid bearer token"}]},"session_id":"abc"}',
        '{"type":"result","subtype":"success","is_error":false,"result":"hello","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.checks.some((check) => check.code === "adapter_auth_missing")).toBe(false);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(false);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_passed")).toBe(true);
  });

  it("keeps a transient failure with an assistant token phrase off the login gate", async () => {
    // The probe fails on a 529 overload. The auth phrase appears only in the raw
    // stdout assistant event, not the parsed result, so the run stays transient
    // and never surfaces the login gate.
    probeResult.value = {
      exitCode: 1,
      stdout: [
        initLine,
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"authentication_failed: the bearer token is invalid"}]},"session_id":"abc"}',
        '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: 529 overloaded_error","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.checks.some((check) => check.code === "adapter_auth_missing")).toBe(false);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(false);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_transient_upstream")).toBe(true);
  });

  it("keeps an unexpected successful summary out of every check", async () => {
    // The probe exits 0 but does not return `hello`. The unexpected summary is
    // untrusted output. The check must not repeat its marker.
    const marker = "NONPATTERNMARKERunexpected";
    probeResult.value = {
      exitCode: 0,
      stdout: [
        initLine,
        `{"type":"result","subtype":"success","is_error":false,"result":"Here is something else ${marker}","session_id":"abc"}`,
      ].join("\n"),
      stderr: "",
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    const unexpected = result.checks.find(
      (check) => check.code === "claude_hello_probe_unexpected_output",
    );
    expect(unexpected).toBeTruthy();
    expect(unexpected?.detail).toBeUndefined();
    const checkText = JSON.stringify(result.checks);
    expect(checkText).not.toContain(marker);
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(marker);
    expect(loggedText).toContain("unexpected_output");
    warnSpy.mockRestore();
  });

  it("keeps an opaque credential marker and a proxy marker out of every check and the log", async () => {
    // The failure output carries two untrusted values that the pattern
    // sanitizer did not recognize: an opaque credential with no token shape and
    // a proxy URL. One rides in stdout, the other in stderr. Neither may reach a
    // check or the server log.
    const opaqueCredMarker = "OPAQUECREDMARKERnoshape";
    const proxyMarker = "http://user:pass@proxy.corp.internal:3128";
    probeResult.value = {
      exitCode: 7,
      stdout: [
        initLine,
        `{"type":"result","subtype":"error_during_execution","is_error":true,"result":"probe failed with ${opaqueCredMarker}","session_id":"abc"}`,
      ].join("\n"),
      stderr: `proxy connect failed: ${proxyMarker}`,
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    const checkText = JSON.stringify(result.checks);
    expect(checkText).not.toContain(opaqueCredMarker);
    expect(checkText).not.toContain("proxy.corp.internal");
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(opaqueCredMarker);
    expect(loggedText).not.toContain("proxy.corp.internal");
    // The log still carries the allowlisted classification and the safe exit
    // code, so the diagnostic stays useful.
    expect(loggedText).toContain("nonzero_exit");
    expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({
      classification: "nonzero_exit",
      exitCode: 7,
    });
    warnSpy.mockRestore();
  });

  it("never copies a thrown CLI probe error into a check or the log", async () => {
    // A spawn or transport failure can throw an error whose text carries a
    // credential. Inject an opaque credential marker and a proxy marker through
    // the thrown error. The CLI lane has no catch around the hello probe call,
    // so the thrown error propagates to the caller, which owns it. No check and
    // no console.warn call inside this lane repeats either marker.
    const opaqueCredMarker = "OPAQUECREDMARKERnoshape";
    const proxyMarker = "http://user:pass@proxy.corp.internal:3128";
    probeResult.throwError = new Error(
      `probe spawn failed with ${opaqueCredMarker} via ${proxyMarker}`,
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The current contract propagates the thrown error. The lane builds no
    // Test-result check from the error, so the raw text cannot reach a check.
    await expect(
      testEnvironment({
        companyId: "company-1",
        adapterType: "claude_local",
        config: { engine: "cli", command: "claude" },
        executionTarget: sandboxTarget,
        environmentName: "Daytona",
      }),
    ).rejects.toThrow(opaqueCredMarker);

    // The lane never routes the raw error text to the server log. No
    // console.warn call repeats either marker.
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(opaqueCredMarker);
    expect(loggedText).not.toContain("proxy.corp.internal");
    warnSpy.mockRestore();
  });

  it("classifies subscription usage-limit failures as a usage-limited warning, not a hard fail", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: [
        initLine,
        '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Claude usage limit reached. Please try again later.","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.checks.some((check) => check.code === "claude_hello_probe_usage_limited")).toBe(true);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_transient_upstream")).toBe(false);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_failed")).toBe(false);
  });

  it("classifies overload failures as a transient warning, not a hard fail", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: [
        initLine,
        '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: 529 overloaded_error","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.checks.some((check) => check.code === "claude_hello_probe_transient_upstream")).toBe(true);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_usage_limited")).toBe(false);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_failed")).toBe(false);
  });

  it("keeps the failed check free of a detail when only the system/init line is present", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: initLine,
      stderr: "",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    const failed = result.checks.find((check) => check.code === "claude_hello_probe_failed");
    expect(failed?.detail).toBeUndefined();
    expect(JSON.stringify(result.checks)).not.toContain('"subtype":"init"');
  });
});

describe("claude auth mode hints", () => {
  const successStdout = [
    initLine,
    '{"type":"result","subtype":"success","is_error":false,"result":"hello","session_id":"abc"}',
  ].join("\n");

  it("reports the configured subscription token for remote targets", async () => {
    probeResult.value = { exitCode: 0, stdout: successStdout, stderr: "" };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        engine: "cli",
        command: "claude",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-test-token" },
      },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    const hint = result.checks.find((check) => check.code === "claude_oauth_token_configured");
    expect(hint).toBeTruthy();
    expect(hint?.level).toBe("info");
    expect(hint?.detail).toContain("configured environment variables");
    expect(
      result.checks.some((check) => check.code === "claude_anthropic_api_key_overrides_subscription"),
    ).toBe(false);
  });

  it("keeps the API-key warning authoritative when both ANTHROPIC_API_KEY and the token are set", async () => {
    probeResult.value = { exitCode: 0, stdout: successStdout, stderr: "" };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        engine: "cli",
        command: "claude",
        env: {
          ANTHROPIC_API_KEY: "api-test-key",
          CLAUDE_CODE_OAUTH_TOKEN: "oauth-test-token",
        },
      },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(
      result.checks.some((check) => check.code === "claude_anthropic_api_key_overrides_subscription"),
    ).toBe(true);
    expect(result.checks.some((check) => check.code === "claude_oauth_token_configured")).toBe(false);
  });
});

describe("claude CLI local hello probe hardening", () => {
  // Clear the host proxy and host auth variables so a local probe reads a
  // deterministic env regardless of the machine that runs the suite.
  const CLEARED_HOST_ENV_KEYS = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "ANTHROPIC_BEDROCK_BASE_URL",
  ];
  const successStdout = [
    initLine,
    '{"type":"result","subtype":"success","is_error":false,"result":"hello","session_id":"abc"}',
  ].join("\n");

  let tempDir: string | null = null;
  let claudePath = "";
  let savedPath: string | undefined;
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-cli-localprobe-"));
    claudePath = path.join(tempDir, "claude");
    await writeFile(claudePath, "#!/bin/sh\nexit 0\n");
    await chmod(claudePath, 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = tempDir;
    savedEnv = {};
    for (const key of CLEARED_HOST_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // The mocked cwd resolver returns a sandbox path; the local probe reads it
    // as the cwd, so no host directory is touched.
    resolveAdapterExecutionTargetCwd.mockReturnValue("/home/daytona/paperclip-workspace");
  });

  afterEach(async () => {
    process.env.PATH = savedPath;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    tempDir = null;
  });

  it("spawns the trusted resolved claude and drops hostile caller env for a local probe", async () => {
    probeResult.value = { exitCode: 0, stdout: successStdout, stderr: "" };
    process.env.HTTPS_PROXY = "http://trusted-proxy:8443";

    await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        engine: "cli",
        command: "/tmp/evil/claude",
        env: {
          ANTHROPIC_API_KEY: "keep-this-key",
          NODE_OPTIONS: "--require /hostile/evil.js",
          PATH: "/hostile/bin",
          LD_PRELOAD: "/hostile/evil.so",
          HTTP_PROXY: "http://caller-proxy:8080",
        },
      },
      executionTarget: null,
      environmentName: null,
    });

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as unknown[];
    const spawnedCommand = call[2] as string;
    const spawnedEnv = (call[4] as { env: Record<string, string> }).env;
    // The trusted resolved claude executable, never the caller command path.
    expect(spawnedCommand).toBe(claudePath);
    expect(spawnedCommand).not.toContain("/tmp/evil");
    // The approved key reaches the child; the hostile keys never do.
    expect(spawnedEnv.ANTHROPIC_API_KEY).toBe("keep-this-key");
    expect(spawnedEnv.NODE_OPTIONS).toBeUndefined();
    expect(spawnedEnv.PATH).toBeUndefined();
    expect(spawnedEnv.LD_PRELOAD).toBeUndefined();
    expect(spawnedEnv.HTTP_PROXY).toBeUndefined();
    // The trusted proxy reaches the child; the caller proxy never does.
    expect(spawnedEnv.HTTPS_PROXY).toBe("http://trusted-proxy:8443");
    expect(JSON.stringify(spawnedEnv)).not.toContain("caller-proxy");
  });

  it("names the local host target on every result", async () => {
    probeResult.value = { exitCode: 0, stdout: successStdout, stderr: "" };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: null,
      environmentName: null,
    });

    const targetCheck = result.checks.find((check) => check.code === "claude_environment_target");
    expect(targetCheck).toBeTruthy();
    expect(targetCheck?.message).toContain("Paperclip host");
  });
});
