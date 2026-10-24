import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget, AdapterSandboxInstallCommandCheck } from "@paperclipai/adapter-utils/execution-target";

const {
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  probeResult,
} = vi.hoisted(() => {
  const probeResult: { value: { exitCode: number; stdout: string; stderr: string } } = {
    value: { exitCode: 1, stdout: "", stderr: "" },
  };
  return {
    probeResult,
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    maybeRunSandboxInstallCommand: vi.fn(async (): Promise<AdapterSandboxInstallCommandCheck | null> => null),
    runAdapterExecutionTargetProcess: vi.fn(async () => ({
      exitCode: probeResult.value.exitCode,
      signal: null,
      timedOut: false,
      stdout: probeResult.value.stdout,
      stderr: probeResult.value.stderr,
      pid: 123,
      startedAt: new Date().toISOString(),
    })),
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
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "./auth-check.js";
import { resetClaudeCliCapabilitiesCacheForTests } from "./cli-capabilities.js";

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

const sshTarget: AdapterExecutionTarget = {
  kind: "remote",
  transport: "ssh",
  remoteCwd: "/home/agent/paperclip-workspace",
  spec: {
    host: "ssh.example.test",
    port: 22,
    username: "agent",
    remoteCwd: "/home/agent/paperclip-workspace",
    remoteWorkspacePath: "/home/agent/paperclip-workspace",
    privateKey: null,
    knownHosts: null,
    strictHostKeyChecking: true,
  },
};

const initLine =
  '{"type":"system","subtype":"init","cwd":"/home/daytona/paperclip-workspace","session_id":"abc","tools":["Bash","Read"]}';

const loginRequiredStdout = [
  initLine,
  '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Please run `claude login` to authenticate.","session_id":"abc"}',
].join("\n");

afterEach(() => {
  vi.clearAllMocks();
  resetClaudeCliCapabilitiesCacheForTests();
});

describe("claude sandbox auth-missing check", () => {
  it("emits the canonical adapter_auth_missing check when a sandbox hello probe reports missing auth", async () => {
    // The sandbox has no ready login, so the hello probe returns a
    // login-required result. The Test must emit the neutral canonical check
    // code. The user interface reads this code to decide login eligibility; it
    // does not parse the message text or the top-level status.
    probeResult.value = { exitCode: 1, stdout: loginRequiredStdout, stderr: "" };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { model: "claude-opus-5", engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    // A missing-auth probe is a warning, not a failure, so the environment stays
    // testable and the user interface can offer login.
    expect(result.status).toBe("warn");
    expect(result.checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(true);
    // The descriptive probe check stays, so existing diagnostics keep working.
    expect(result.checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(true);
  });

  it("does not emit adapter_auth_missing when a non-sandbox remote probe reports missing auth", async () => {
    // Only a sandbox target can start login. A non-sandbox remote target keeps
    // the descriptive probe check but does not carry the neutral login code.
    probeResult.value = { exitCode: 1, stdout: loginRequiredStdout, stderr: "" };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { model: "claude-opus-5", engine: "cli", command: "claude" },
      executionTarget: sshTarget,
      environmentName: "Remote host",
    });

    expect(result.checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(true);
    expect(result.checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(false);
  });
});

describe("claude CLI hello probe timeout", () => {
  it.each([
    ["the default", {}, 90],
    ["an explicit override", { helloProbeTimeoutSec: 120 }, 120],
  ])("gives a non-sandbox remote hello probe %s timeout", async (_label, override, expectedTimeoutSec) => {
    probeResult.value = { exitCode: 1, stdout: loginRequiredStdout, stderr: "" };

    await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude", ...override },
      executionTarget: sshTarget,
      environmentName: "Remote host",
    });

    const helloCall = runAdapterExecutionTargetProcess.mock.calls
      .map((call) => (call as unknown as unknown[])[4] as { stdin?: string; timeoutSec?: number })
      .find((options) => options?.stdin === "Respond with hello.");
    expect(helloCall?.timeoutSec).toBe(expectedTimeoutSec);
  });
});

describe("claude CLI model compatibility check", () => {
  it("runs the hello probe with the compatible private CLI after updating an old sandbox", async () => {
    const command = "/home/daytona/paperclip-workspace/.paperclip-runtime/claude-cli/2.1.280/bin/claude";
    const response = { signal: null, timedOut: false, pid: 123, startedAt: new Date().toISOString(), stderr: "" };
    runAdapterExecutionTargetProcess
      .mockResolvedValueOnce({ ...response, exitCode: 0, stdout: "2.1.263 (Claude Code)\n" })
      .mockResolvedValueOnce({ ...response, exitCode: 1, stdout: "" })
      .mockResolvedValueOnce({ ...response, exitCode: 0, stdout: "2.1.280 (Claude Code)\n" });
    maybeRunSandboxInstallCommand.mockResolvedValueOnce(null).mockResolvedValueOnce({
      code: "claude_install_command_run", level: "info", message: "Installed compatible Claude runtime.",
    });
    probeResult.value = { exitCode: 0, stdout: [initLine,
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "hello", session_id: "abc" }),
    ].join("\n"), stderr: "" };
    const result = await testEnvironment({ companyId: "company-1", adapterType: "claude_local",
      config: { engine: "cli", model: "claude-opus-5-5", env: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-subscription" } },
      executionTarget: sandboxTarget, environmentName: "Daytona" });
    expect(result.status).toBe("pass");
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "claude_hello_probe_passed" }));
    const hello = runAdapterExecutionTargetProcess.mock.calls.find(call => (call as unknown as [string, unknown, string, string[]])[3]?.includes("--print"));
    expect((hello as unknown as [string, unknown, string])[2]).toBe(command);
  });

  it("includes a safe runtime preparation failure in the environment checks", async () => {
    const response = { signal: null, timedOut: false, pid: 123, startedAt: new Date().toISOString(), stderr: "" };
    runAdapterExecutionTargetProcess
      .mockResolvedValueOnce({ ...response, exitCode: 0, stdout: "2.1.263 (Claude Code)\n" })
      .mockResolvedValueOnce({ ...response, exitCode: 1, stdout: "" });
    maybeRunSandboxInstallCommand.mockResolvedValueOnce(null).mockResolvedValueOnce({
      code: "claude_install_command_run", level: "warn", message: "Install command exited 1: npm install",
      detail: "npm error code ENOTFOUND https://registry-secret@example.test/private",
    });
    const result = await testEnvironment({ companyId: "company-1", adapterType: "claude_local",
      config: { engine: "cli", model: "claude-opus-5-5" }, executionTarget: sandboxTarget });
    expect(result.status).toBe("fail");
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "claude_runtime_preparation_failed",
      detail: "The package installation could not reach the registry." }));
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "claude_cli_version_incompatible" }));
    expect(JSON.stringify(result)).not.toContain("registry-secret");
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["claude-fable-5-1", "2.1.251", "2.1.247"],
    ["claude-opus-5-5", "2.1.280", "2.1.279"],
    ["claude-sonnet-5-5", "2.1.284", "2.1.283"],
  ])("fails before the hello probe for %s below CLI %s", async (model, minimumVersion, detectedVersion) => {
    probeResult.value = {
      exitCode: 0,
      stdout: `${detectedVersion} (Claude Code)\n`,
      stderr: "",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        engine: "cli",
        command: "/opt/operator/claude",
        model,
      },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toContainEqual(expect.objectContaining({
      code: "claude_cli_version_incompatible",
      level: "error",
      message: `${model} requires Claude Code ${minimumVersion} or newer on the CLI lane.`,
      detail: `Detected Claude Code ${detectedVersion}.`,
    }));
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const versionCall = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [
      string,
      AdapterExecutionTarget,
      string,
      string[],
    ];
    expect(versionCall[3]).toEqual(["--version"]);
  });
});
