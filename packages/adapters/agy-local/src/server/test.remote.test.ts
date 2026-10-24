import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { ADAPTER_AUTH_MISSING_CHECK_CODE, SANDBOX_INSTALL_COMMAND } from "../index.js";

const {
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  prepareAdapterExecutionTargetRuntime,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  readAdapterExecutionTargetHomeDir,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  probeResult,
  restoreWorkspaceSpy,
  capturedAssets,
} = vi.hoisted(() => {
  const restoreWorkspaceSpy = vi.fn(async () => {});
  const capturedAssets: { value: any[] | null } = { value: null };
  const probeResult: {
    value: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };
  } = {
    value: { exitCode: 0, stdout: "", stderr: "" },
  };

  return {
    restoreWorkspaceSpy,
    capturedAssets,
    probeResult,
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    maybeRunSandboxInstallCommand: vi.fn(async () => null as any),
    readAdapterExecutionTargetHomeDir: vi.fn(async () => "/home/agent"),
    runAdapterExecutionTargetShellCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    describeAdapterExecutionTarget: vi.fn(() => "QA Daytona"),
    resolveAdapterExecutionTargetCwd: vi.fn((_target, cwd) => cwd || "/remote/workspace"),
    prepareAdapterExecutionTargetRuntime: vi.fn(async (input: { assets?: any[] }) => {
      capturedAssets.value = input.assets ?? [];
      return {
        workspaceRemoteDir: "/remote/workspace",
        runtimeRootDir: "/remote/runtime",
        assetDirs: {
          "agy-home": "/remote/runtime/assets/agy-home",
        },
        restoreWorkspace: restoreWorkspaceSpy,
      };
    }),
    runAdapterExecutionTargetProcess: vi.fn(async () => ({
      exitCode: probeResult.value.exitCode,
      signal: null,
      timedOut: probeResult.value.timedOut ?? false,
      stdout: probeResult.value.stdout,
      stderr: probeResult.value.stderr,
      pid: 123,
      startedAt: new Date().toISOString(),
    })),
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
    prepareAdapterExecutionTargetRuntime,
    runAdapterExecutionTargetProcess,
    runAdapterExecutionTargetShellCommand,
    readAdapterExecutionTargetHomeDir,
    describeAdapterExecutionTarget,
    resolveAdapterExecutionTargetCwd,
  };
});

import { testEnvironment } from "./test.js";

function sandboxTarget(): AdapterExecutionTarget {
  return {
    kind: "remote",
    transport: "sandbox",
    providerKey: "daytona",
    remoteCwd: "/remote/workspace",
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
}

function sshTarget(): AdapterExecutionTarget {
  return {
    kind: "remote",
    transport: "ssh",
    remoteCwd: "/remote/workspace",
    spec: {
      host: "127.0.0.1",
      port: 2222,
      username: "agent",
      remoteCwd: "/remote/workspace",
      remoteWorkspacePath: "/remote/workspace",
      privateKey: null,
      knownHosts: null,
      strictHostKeyChecking: true,
    },
  };
}

describe("agy-local testEnvironment (remote execution)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreWorkspaceSpy.mockClear();
    capturedAssets.value = null;
    maybeRunSandboxInstallCommand.mockResolvedValue(null);
    probeResult.value = {
      exitCode: 0,
      stdout:
        JSON.stringify({
          event: "result",
          result: { status: "SUCCESS", response: "hello there" },
        }) + "\n",
      stderr: "",
      timedOut: false,
    };
  });

  it("auto-invokes maybeRunSandboxInstallCommand when probing remote sandbox target", async () => {
    maybeRunSandboxInstallCommand.mockResolvedValue({
      code: "sandbox_install_succeeded",
      level: "info",
      message: "Antigravity CLI was installed in the sandbox.",
    });

    const ctx: AdapterEnvironmentTestContext = {
      companyId: "company-1",
      adapterType: "agy_local",
      config: { command: "agy" },
      executionTarget: sandboxTarget(),
      environmentName: "Daytona",
    };

    const result = await testEnvironment(ctx);
    expect(result.status).toBe("pass");
    expect(maybeRunSandboxInstallCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterKey: "agy",
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: "agy",
      }),
    );
    expect(result.checks.some((c) => c.code === "sandbox_install_succeeded")).toBe(true);
  });

  it("stages credentials and config into sandbox for hello probe, and cleans them up in finally", async () => {
    const ctx: AdapterEnvironmentTestContext = {
      companyId: "company-1",
      adapterType: "agy_local",
      config: { command: "agy" },
      executionTarget: sandboxTarget(),
      environmentName: "Daytona",
    };

    const result = await testEnvironment(ctx);
    expect(result.status).toBe("pass");

    expect(prepareAdapterExecutionTargetRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterKey: "agy",
        assets: expect.arrayContaining([expect.objectContaining({ key: "agy-home" })]),
      }),
    );

    // Verify workspace restoration ran in finally
    expect(restoreWorkspaceSpy).toHaveBeenCalled();
  });

  it("emits ADAPTER_AUTH_MISSING_CHECK_CODE when hello probe fails with unauthenticated status on sandbox target", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: "",
      stderr: "Please log in: authentication required. Run agy login to authenticate.",
    };

    const ctx: AdapterEnvironmentTestContext = {
      companyId: "company-1",
      adapterType: "agy_local",
      config: { command: "agy" },
      executionTarget: sandboxTarget(),
      environmentName: "Daytona",
    };

    const result = await testEnvironment(ctx);
    expect(result.status).toBe("warn");
    expect(result.checks.some((c) => c.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(true);
    expect(result.checks.some((c) => c.code === "agy_hello_probe_auth_required")).toBe(true);
  });

  it("does not emit ADAPTER_AUTH_MISSING_CHECK_CODE when non-sandbox remote target fails with auth required", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: "",
      stderr: "Please log in: authentication required. Run agy login to authenticate.",
    };

    const ctx: AdapterEnvironmentTestContext = {
      companyId: "company-1",
      adapterType: "agy_local",
      config: { command: "agy" },
      executionTarget: sshTarget(),
      environmentName: "Remote host",
    };

    const result = await testEnvironment(ctx);
    expect(result.checks.some((c) => c.code === "agy_hello_probe_auth_required")).toBe(true);
    expect(result.checks.some((c) => c.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(false);
  });
});
