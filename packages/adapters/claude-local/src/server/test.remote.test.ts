import { afterEach, describe, expect, it, vi } from "vitest";
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
  const probeResult: { value: { exitCode: number; stdout: string; stderr: string } } = {
    value: { exitCode: 1, stdout: "", stderr: "" },
  };
  return {
    probeResult,
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    maybeRunSandboxInstallCommand: vi.fn(async () => null),
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
      config: { engine: "cli", command: "claude" },
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
      config: { engine: "cli", command: "claude" },
      executionTarget: sshTarget,
      environmentName: "Remote host",
    });

    expect(result.checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(true);
    expect(result.checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(false);
  });
});
