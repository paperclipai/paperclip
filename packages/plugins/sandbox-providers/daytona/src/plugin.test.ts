import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.hoisted(() => vi.fn());
const mockGet = vi.hoisted(() => vi.fn());
const { MockDaytonaNotFoundError, MockDaytonaTimeoutError } = vi.hoisted(() => {
  class MockDaytonaNotFoundError extends Error {}
  class MockDaytonaTimeoutError extends Error {}
  return { MockDaytonaNotFoundError, MockDaytonaTimeoutError };
});

vi.mock("@daytonaio/sdk", () => ({
  Daytona: class MockDaytona {
    create = mockCreate;
    get = mockGet;
    constructor(_config?: unknown) {}
  },
  DaytonaNotFoundError: MockDaytonaNotFoundError,
  DaytonaTimeoutError: MockDaytonaTimeoutError,
}));

import plugin from "./plugin.js";

function createMockSandbox(overrides: {
  id?: string;
  name?: string;
  state?: string;
  recoverable?: boolean;
  workDir?: string;
} = {}) {
  return {
    id: overrides.id ?? "sandbox-123",
    name: overrides.name ?? "paperclip-sandbox",
    state: overrides.state ?? "started",
    recoverable: overrides.recoverable ?? false,
    target: "us",
    errorReason: null,
    getWorkDir: vi.fn().mockResolvedValue(overrides.workDir ?? "/home/daytona"),
    getUserHomeDir: vi.fn().mockResolvedValue("/home/daytona"),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    recover: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    fs: {
      createFolder: vi.fn().mockResolvedValue(undefined),
      uploadFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
    },
    process: {
      executeCommand: vi.fn().mockResolvedValue({
        exitCode: 0,
        result: "bash",
        artifacts: { stdout: "bash" },
      }),
    },
  };
}

describe("Daytona sandbox provider plugin", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockGet.mockReset();
    vi.restoreAllMocks();
    delete process.env.DAYTONA_API_KEY;
  });

  it("declares environment lifecycle handlers", async () => {
    expect(await plugin.definition.onHealth?.()).toEqual({
      status: "ok",
      message: "Daytona sandbox provider plugin healthy",
    });
    expect(plugin.definition.onEnvironmentAcquireLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentExecute).toBeTypeOf("function");
  });

  it("normalizes config and validates the API key fallback", async () => {
    process.env.DAYTONA_API_KEY = "host-key";

    const result = await plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "daytona",
      config: {
        apiKey: "  explicit-key  ",
        apiUrl: " https://app.daytona.io/api ",
        target: " us ",
        snapshot: " base-snapshot ",
        language: " typescript ",
        timeoutMs: "450000.9",
        autoStopInterval: "15",
        autoArchiveInterval: "60",
        autoDeleteInterval: "-1",
        reuseLease: true,
      },
    });

    expect(result).toEqual({
      ok: true,
      normalizedConfig: {
        apiKey: "explicit-key",
        apiUrl: "https://app.daytona.io/api",
        target: "us",
        snapshot: "base-snapshot",
        image: null,
        language: "typescript",
        timeoutMs: 450000,
        cpu: null,
        memory: null,
        disk: null,
        gpu: null,
        autoStopInterval: 15,
        autoArchiveInterval: 60,
        autoDeleteInterval: -1,
        reuseLease: true,
      },
    });
  });

  it("rejects ambiguous or invalid config", async () => {
    await expect(plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "daytona",
      config: {
        apiUrl: "not-a-url",
        image: "node:20",
        snapshot: "snapshot-a",
        timeoutMs: 0,
      },
    })).resolves.toEqual({
      ok: false,
      errors: [
        "Daytona sandbox environments must set either image or snapshot, not both.",
        "apiUrl must be a valid URL.",
        "timeoutMs must be between 1 and 86400000.",
        "Daytona sandbox environments require an API key in config or DAYTONA_API_KEY.",
      ],
    });
  });

  it("probes by creating and then deleting a sandbox", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    mockCreate.mockResolvedValue(sandbox);

    const result = await plugin.definition.onEnvironmentProbe?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        snapshot: "base-snapshot",
        timeoutMs: 300000,
        reuseLease: false,
      },
    });

    expect(mockCreate).toHaveBeenCalled();
    expect(sandbox.fs.createFolder).toHaveBeenCalledWith("/home/daytona/paperclip-workspace", "755");
    expect(sandbox.delete).toHaveBeenCalledWith(300);
    expect(result).toMatchObject({
      ok: true,
      metadata: {
        provider: "daytona",
        shellCommand: "bash",
        sandboxId: "sandbox-123",
        remoteCwd: "/home/daytona/paperclip-workspace",
      },
    });
  });

  it("acquires a lease from a created sandbox", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    mockCreate.mockResolvedValue(sandbox);

    const lease = await plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      runId: "run-1",
      config: {
        image: "node:20",
        timeoutMs: 300000,
        reuseLease: true,
      },
    });

    expect(lease).toMatchObject({
      providerLeaseId: "sandbox-123",
      metadata: {
        provider: "daytona",
        shellCommand: "bash",
        sandboxId: "sandbox-123",
        remoteCwd: "/home/daytona/paperclip-workspace",
        reuseLease: true,
      },
    });
  });

  it("deletes the sandbox if lease setup throws after sandbox creation", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    sandbox.getWorkDir.mockRejectedValue(new Error("workdir lookup failed"));
    mockCreate.mockResolvedValue(sandbox);

    await expect(
      plugin.definition.onEnvironmentAcquireLease?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        runId: "run-1",
        config: {
          image: "node:20",
          timeoutMs: 300000,
          reuseLease: true,
        },
      }),
    ).rejects.toThrow("workdir lookup failed");

    expect(sandbox.delete).toHaveBeenCalledTimes(1);
  });

  it("falls back to sh metadata when bash is not present in the sandbox image", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    sandbox.process.executeCommand.mockResolvedValue({
      exitCode: 0,
      result: "sh",
      artifacts: { stdout: "sh" },
    });
    mockCreate.mockResolvedValue(sandbox);

    const lease = await plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      runId: "run-1",
      config: {
        image: "busybox:latest",
        timeoutMs: 300000,
        reuseLease: true,
      },
    });

    expect(lease).toMatchObject({
      metadata: {
        shellCommand: "sh",
      },
    });
  });

  it("deletes the sandbox if resume setup throws after the sandbox starts", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox({ id: "sandbox-resume", state: "stopped" });
    sandbox.getWorkDir.mockRejectedValue(new Error("workdir lookup failed"));
    mockGet.mockResolvedValue(sandbox);

    await expect(
      plugin.definition.onEnvironmentResumeLease?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "sandbox-resume",
        config: {
          timeoutMs: 300000,
          reuseLease: true,
        },
      }),
    ).rejects.toThrow("workdir lookup failed");

    expect(sandbox.start).toHaveBeenCalled();
    expect(sandbox.delete).toHaveBeenCalledTimes(1);
  });

  it("marks missing reusable leases as expired on resume", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    mockGet.mockRejectedValue(new MockDaytonaNotFoundError("missing"));

    await expect(plugin.definition.onEnvironmentResumeLease?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "sandbox-123",
      config: {
        timeoutMs: 300000,
        reuseLease: true,
      },
    })).resolves.toEqual({
      providerLeaseId: null,
      metadata: { expired: true },
    });
  });

  it("stops reusable leases and deletes ephemeral leases on release", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const reusable = createMockSandbox({ id: "sandbox-reusable" });
    const ephemeral = createMockSandbox({ id: "sandbox-ephemeral" });
    mockGet.mockResolvedValueOnce(reusable).mockResolvedValueOnce(ephemeral);

    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "sandbox-reusable",
      config: {
        timeoutMs: 300000,
        reuseLease: true,
      },
    });
    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "sandbox-ephemeral",
      config: {
        timeoutMs: 300000,
        reuseLease: false,
      },
    });

    expect(reusable.stop).toHaveBeenCalledWith(300);
    expect(reusable.delete).not.toHaveBeenCalled();
    expect(ephemeral.delete).toHaveBeenCalledWith(300);
  });

  it("falls back to delete when stopping a reusable lease from an error state fails", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const errored = createMockSandbox({ id: "sandbox-error", state: "error" });
    errored.stop.mockRejectedValueOnce(new Error("stop failed"));
    mockGet.mockResolvedValue(errored);

    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "sandbox-error",
      config: {
        timeoutMs: 300000,
        reuseLease: true,
      },
    });

    expect(errored.stop).toHaveBeenCalledWith(300);
    expect(errored.delete).toHaveBeenCalledWith(300);
  });

  it("falls back to delete when stopping a healthy reusable lease fails mid-call", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox({ id: "sandbox-running", state: "started" });
    sandbox.stop.mockRejectedValueOnce(new Error("api timeout"));
    mockGet.mockResolvedValue(sandbox);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "sandbox-running",
      config: {
        timeoutMs: 300000,
        reuseLease: true,
      },
    });

    expect(sandbox.stop).toHaveBeenCalledWith(300);
    expect(sandbox.delete).toHaveBeenCalledWith(300);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("executes commands one-shot and returns combined output via stdout", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    sandbox.process.executeCommand.mockResolvedValue({
      exitCode: 7,
      result: "stdout\nstderr\n",
      artifacts: { stdout: "stdout\nstderr\n" },
    });
    mockGet.mockResolvedValue(sandbox);

    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        timeoutMs: 300000,
        reuseLease: false,
      },
      lease: { providerLeaseId: "sandbox-123", metadata: {} },
      command: "printf",
      args: ["hello"],
      cwd: "/workspace",
      env: { FOO: "bar" },
      timeoutMs: 1000,
    });

    expect(sandbox.process.executeCommand).toHaveBeenCalledTimes(1);
    const [command, cwdArg, envArg, timeoutArg] = sandbox.process.executeCommand.mock.calls[0] as [string, unknown, unknown, number];
    expect(command).toMatch(/\/etc\/profile/);
    expect(command).toMatch(/"\$HOME\/\.profile"/);
    expect(command).toMatch(/cd '\/workspace'/);
    expect(command).toMatch(/&& env FOO='bar' 'printf' 'hello'$/);
    expect(command).not.toMatch(/(?:^|&& )exec /);
    // cwd/env are baked into the login-shell command itself; we pass undefined
    // to the SDK so it doesn't run the cd before profile sourcing.
    expect(cwdArg).toBeUndefined();
    expect(envArg).toBeUndefined();
    expect(timeoutArg).toBe(1);
    expect(result).toEqual({
      exitCode: 7,
      timedOut: false,
      stdout: "stdout\nstderr\n",
      stderr: "",
    });
  });

  it("stages stdin in the sandbox filesystem when execution needs redirected input", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    mockGet.mockResolvedValue(sandbox);

    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        timeoutMs: 300000,
        reuseLease: false,
      },
      lease: { providerLeaseId: "sandbox-123", metadata: {} },
      command: "cat",
      args: [],
      cwd: "/workspace",
      stdin: "input payload",
      timeoutMs: 1000,
    });

    expect(sandbox.fs.uploadFile).toHaveBeenCalledWith(
      Buffer.from("input payload", "utf8"),
      expect.stringMatching(/^\/tmp\/paperclip-stdin-/),
      1,
    );
    const [command] = sandbox.process.executeCommand.mock.calls[0] as [string];
    expect(command).toMatch(/\/etc\/profile/);
    expect(command).toMatch(/cd '\/workspace'/);
    expect(command).toMatch(/&& 'cat' < '\/tmp\/paperclip-stdin-/);
    expect(command).not.toMatch(/(?:^|&& )exec /);
    expect(sandbox.fs.deleteFile).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/paperclip-stdin-/));
    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
    });
  });

  it("rejects invalid shell env keys before execution", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    mockGet.mockResolvedValue(sandbox);

    await expect(plugin.definition.onEnvironmentExecute?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        timeoutMs: 300000,
        reuseLease: false,
      },
      lease: { providerLeaseId: "sandbox-123", metadata: {} },
      command: "printf",
      args: ["hello"],
      env: { "BAD-KEY": "bar" },
    })).rejects.toThrow("Invalid sandbox environment variable key: BAD-KEY");

    expect(sandbox.process.executeCommand).not.toHaveBeenCalled();
  });

  it("returns a timed out execute result when the Daytona SDK times out", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    sandbox.process.executeCommand.mockRejectedValue(new MockDaytonaTimeoutError("command timed out"));
    mockGet.mockResolvedValue(sandbox);

    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        timeoutMs: 300000,
        reuseLease: false,
      },
      lease: { providerLeaseId: "sandbox-123", metadata: {} },
      command: "sleep",
      args: ["60"],
      cwd: "/workspace",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      exitCode: null,
      timedOut: true,
      stdout: "",
      stderr: "command timed out\n",
    });
  });
});
