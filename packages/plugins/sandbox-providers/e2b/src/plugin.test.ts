import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.hoisted(() => vi.fn());
const mockConnect = vi.hoisted(() => vi.fn());
const { MockCommandExitError, MockSandboxNotFoundError, MockTimeoutError } = vi.hoisted(() => {
  class MockCommandExitError extends Error {
    exitCode: number;
    stdout: string;
    stderr: string;

    constructor(result: { exitCode: number; stdout: string; stderr: string }) {
      super("command failed");
      this.exitCode = result.exitCode;
      this.stdout = result.stdout;
      this.stderr = result.stderr;
    }
  }
  class MockSandboxNotFoundError extends Error {}
  class MockTimeoutError extends Error {}
  return { MockCommandExitError, MockSandboxNotFoundError, MockTimeoutError };
});

vi.mock("e2b", () => ({
  CommandExitError: MockCommandExitError,
  SandboxNotFoundError: MockSandboxNotFoundError,
  TimeoutError: MockTimeoutError,
  Sandbox: {
    create: mockCreate,
    connect: mockConnect,
  },
}));

import plugin from "./plugin.js";

function createMockSandbox(overrides: {
  sandboxId?: string;
  sandboxDomain?: string;
  pwd?: string;
  waitResult?: { exitCode: number; stdout: string; stderr: string };
} = {}) {
  const handle = {
    pid: 42,
    stdout: "",
    stderr: "",
    wait: vi.fn().mockResolvedValue(overrides.waitResult ?? {
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
    }),
  };
  return {
    sandboxId: overrides.sandboxId ?? "sandbox-123",
    sandboxDomain: overrides.sandboxDomain ?? "sandbox.example.test",
    setTimeout: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    commands: {
      run: vi.fn(async (command: string, options?: { background?: boolean }) => {
        if (options?.background) return handle;
        if (command === "pwd") {
          return {
            exitCode: 0,
            stdout: `${overrides.pwd ?? "/home/user"}\n`,
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      }),
      sendStdin: vi.fn().mockResolvedValue(undefined),
      closeStdin: vi.fn().mockResolvedValue(undefined),
    },
    handle,
  };
}

describe("E2B sandbox provider plugin", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockConnect.mockReset();
    vi.restoreAllMocks();
    delete process.env.E2B_API_KEY;
  });

  it("declares environment lifecycle handlers", async () => {
    expect(await plugin.definition.onHealth?.()).toEqual({
      status: "ok",
      message: "E2B sandbox provider plugin healthy",
    });
    expect(plugin.definition.onEnvironmentAcquireLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentExecute).toBeTypeOf("function");
  });

  it("normalizes E2B config through the generic provider shape", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "e2b",
      config: {
        template: "  base  ",
        apiKey: "  e2b_test_key  ",
        timeoutMs: "450000.9",
        reuseLease: true,
      },
    });

    expect(result).toEqual({
      ok: true,
      normalizedConfig: {
        template: "base",
        apiKey: "e2b_test_key",
        timeoutMs: 450000,
        reuseLease: true,
      },
    });
  });

  it("rejects empty template strings instead of silently normalizing them", async () => {
    await expect(plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "e2b",
      config: {
        template: "   ",
      },
    })).resolves.toEqual({
      ok: false,
      errors: ["E2B sandbox environments require a template."],
    });
  });

  it("uses resolved config keys before falling back to E2B_API_KEY", async () => {
    const sandbox = createMockSandbox();
    mockCreate.mockResolvedValue(sandbox);
    process.env.E2B_API_KEY = "host-key";

    const lease = await plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "e2b",
      companyId: "company-1",
      environmentId: "env-1",
      runId: "run-1",
      config: {
        template: "base",
        apiKey: "resolved-key",
        timeoutMs: 300000,
        reuseLease: false,
      },
    });

    expect(mockCreate).toHaveBeenCalledWith("base", expect.objectContaining({
      apiKey: "resolved-key",
      timeoutMs: 300000,
    }));
    expect(lease).toMatchObject({
      providerLeaseId: "sandbox-123",
      metadata: {
        provider: "e2b",
        remoteCwd: "/home/user/paperclip-workspace",
      },
    });
    expect(sandbox.commands.run).toHaveBeenNthCalledWith(1, "pwd");
    expect(sandbox.commands.run).toHaveBeenNthCalledWith(2, "mkdir -p '/home/user/paperclip-workspace'");
  });

  it("kills the sandbox if acquire setup fails after creation", async () => {
    const sandbox = createMockSandbox();
    const failure = new Error("set-timeout failed");
    sandbox.setTimeout.mockRejectedValueOnce(failure);
    mockCreate.mockResolvedValue(sandbox);

    await expect(plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "e2b",
      companyId: "company-1",
      environmentId: "env-1",
      runId: "run-1",
      config: {
        template: "base",
        apiKey: "resolved-key",
        timeoutMs: 300000,
        reuseLease: false,
      },
    })).rejects.toThrow("set-timeout failed");

    expect(sandbox.kill).toHaveBeenCalled();
  });

  it("falls back to host E2B_API_KEY when config omits the API key", async () => {
    process.env.E2B_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    mockCreate.mockResolvedValue(sandbox);

    await expect(plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "e2b",
      companyId: "company-1",
      environmentId: "env-1",
      runId: "run-1",
      config: {
        template: "base",
        apiKey: null,
        timeoutMs: 300000,
        reuseLease: false,
      },
    })).resolves.toMatchObject({
      providerLeaseId: "sandbox-123",
    });
    expect(mockCreate).toHaveBeenCalledWith("base", expect.objectContaining({ apiKey: "host-key" }));
  });

  it("kills the sandbox if resume setup fails after reconnect", async () => {
    const sandbox = createMockSandbox();
    const failure = new Error("set-timeout failed");
    sandbox.setTimeout.mockRejectedValueOnce(failure);
    mockConnect.mockResolvedValue(sandbox);

    await expect(plugin.definition.onEnvironmentResumeLease?.({
      driverKey: "e2b",
      companyId: "company-1",
      environmentId: "env-1",
      runId: "run-1",
      providerLeaseId: "sandbox-123",
      config: {
        template: "base",
        apiKey: "resolved-key",
        timeoutMs: 300000,
        reuseLease: false,
      },
    })).rejects.toThrow("set-timeout failed");

    expect(sandbox.kill).toHaveBeenCalled();
  });

  it("executes commands through a connected sandbox", async () => {
    const sandbox = createMockSandbox();
    mockConnect.mockResolvedValue(sandbox);

    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "e2b",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        template: "base",
        apiKey: "resolved-key",
        timeoutMs: 300000,
        reuseLease: false,
      },
      lease: { providerLeaseId: "sandbox-123", metadata: {} },
      command: "printf",
      args: ["hello"],
      cwd: "/workspace",
      env: { FOO: "bar" },
      stdin: "input",
      timeoutMs: 1000,
    });

    expect(mockConnect).toHaveBeenCalledWith("sandbox-123", expect.objectContaining({ apiKey: "resolved-key" }));
    expect(sandbox.commands.run).toHaveBeenCalledWith("exec 'printf' 'hello'", expect.objectContaining({
      background: true,
      cwd: "/workspace",
      envs: { FOO: "bar" },
      stdin: true,
      timeoutMs: 1000,
    }));
    expect(sandbox.commands.sendStdin).toHaveBeenCalledWith(42, "input");
    expect(sandbox.commands.closeStdin).toHaveBeenCalledWith(42);
    expect(result).toEqual({
      exitCode: 0,
      timedOut: false,
      stdout: "ok\n",
      stderr: "",
    });
  });

  it("closes stdin even when sendStdin throws unexpectedly", async () => {
    const sandbox = createMockSandbox();
    const failure = new Error("send failed");
    sandbox.commands.sendStdin.mockRejectedValueOnce(failure);
    mockConnect.mockResolvedValue(sandbox);

    await expect(plugin.definition.onEnvironmentExecute?.({
      driverKey: "e2b",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        template: "base",
        apiKey: "resolved-key",
        timeoutMs: 300000,
        reuseLease: false,
      },
      lease: { providerLeaseId: "sandbox-123", metadata: {} },
      command: "printf",
      args: ["hello"],
      cwd: "/workspace",
      env: { FOO: "bar" },
      stdin: "input",
      timeoutMs: 1000,
    })).rejects.toThrow("send failed");

    expect(sandbox.commands.closeStdin).toHaveBeenCalledWith(42);
    expect(sandbox.handle.wait).not.toHaveBeenCalled();
  });

  it("pauses reusable leases and kills ephemeral leases on release", async () => {
    const reusable = createMockSandbox({ sandboxId: "sandbox-reusable" });
    const ephemeral = createMockSandbox({ sandboxId: "sandbox-ephemeral" });
    mockConnect.mockResolvedValueOnce(reusable).mockResolvedValueOnce(ephemeral);

    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "e2b",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        template: "base",
        apiKey: "resolved-key",
        timeoutMs: 300000,
        reuseLease: true,
      },
      providerLeaseId: "sandbox-reusable",
    });
    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "e2b",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        template: "base",
        apiKey: "resolved-key",
        timeoutMs: 300000,
        reuseLease: false,
      },
      providerLeaseId: "sandbox-ephemeral",
    });

    expect(reusable.pause).toHaveBeenCalled();
    expect(reusable.kill).not.toHaveBeenCalled();
    expect(ephemeral.kill).toHaveBeenCalled();
  });

  it("falls back to kill when pausing a reusable lease fails", async () => {
    const sandbox = createMockSandbox({ sandboxId: "sandbox-reusable" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    sandbox.pause.mockRejectedValueOnce(new Error("pause failed"));
    mockConnect.mockResolvedValue(sandbox);

    await expect(plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "e2b",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        template: "base",
        apiKey: "resolved-key",
        timeoutMs: 300000,
        reuseLease: true,
      },
      providerLeaseId: "sandbox-reusable",
    })).resolves.toBeUndefined();

    expect(sandbox.pause).toHaveBeenCalled();
    expect(sandbox.kill).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("creates the remote workspace before returning it", async () => {
    const sandbox = createMockSandbox({ sandboxId: "sandbox-realize" });
    mockConnect.mockResolvedValue(sandbox);

    await expect(plugin.definition.onEnvironmentRealizeWorkspace?.({
      driverKey: "e2b",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        template: "base",
        apiKey: "resolved-key",
        timeoutMs: 300000,
        reuseLease: false,
      },
      lease: {
        providerLeaseId: "sandbox-realize",
        metadata: { remoteCwd: "/home/user/paperclip-workspace" },
      },
      workspace: {
        localPath: "/tmp/paperclip-workspace",
      },
    })).resolves.toEqual({
      cwd: "/home/user/paperclip-workspace",
      metadata: {
        provider: "e2b",
        remoteCwd: "/home/user/paperclip-workspace",
      },
    });

    expect(mockConnect).toHaveBeenCalledWith("sandbox-realize", expect.objectContaining({ apiKey: "resolved-key" }));
    expect(sandbox.commands.run).toHaveBeenCalledWith("mkdir -p '/home/user/paperclip-workspace'");
  });

  it("swallows destroy kill errors after logging them", async () => {
    const sandbox = createMockSandbox({ sandboxId: "sandbox-destroy" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    sandbox.kill.mockRejectedValueOnce(new Error("kill failed"));
    mockConnect.mockResolvedValue(sandbox);

    await expect(plugin.definition.onEnvironmentDestroyLease?.({
      driverKey: "e2b",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        template: "base",
        apiKey: "resolved-key",
        timeoutMs: 300000,
        reuseLease: false,
      },
      providerLeaseId: "sandbox-destroy",
    })).resolves.toBeUndefined();

    expect(sandbox.kill).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });
});
