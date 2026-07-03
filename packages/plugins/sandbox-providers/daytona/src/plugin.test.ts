import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.hoisted(() => vi.fn());
const mockGet = vi.hoisted(() => vi.fn());
const mockSnapshotGet = vi.hoisted(() => vi.fn());
const mockSnapshotDelete = vi.hoisted(() => vi.fn());
const { MockDaytonaNotFoundError, MockDaytonaTimeoutError } = vi.hoisted(() => {
  class MockDaytonaNotFoundError extends Error {}
  class MockDaytonaTimeoutError extends Error {}
  return { MockDaytonaNotFoundError, MockDaytonaTimeoutError };
});

vi.mock("@daytonaio/sdk", () => ({
  Daytona: class MockDaytona {
    create = mockCreate;
    get = mockGet;
    snapshot = {
      get: mockSnapshotGet,
      delete: mockSnapshotDelete,
    };
    constructor(_config?: unknown) {}
  },
  DaytonaNotFoundError: MockDaytonaNotFoundError,
  DaytonaTimeoutError: MockDaytonaTimeoutError,
}));

import plugin from "./plugin.js";
import manifest from "./manifest.js";

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
    resize: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    createSshAccess: vi.fn().mockResolvedValue({
      token: "ssh-token-secret",
      command: "ssh ssh-token-secret@ssh.app.daytona.io",
    }),
    _experimental_createSnapshot: vi.fn().mockResolvedValue(undefined),
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
    mockSnapshotGet.mockReset();
    mockSnapshotDelete.mockReset();
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
    expect(plugin.definition.onEnvironmentStartInteractiveSetup).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentCaptureTemplate).toBeTypeOf("function");
    expect(manifest.environmentDrivers?.[0]).toMatchObject({
      supportsInteractiveSetup: true,
      interactiveSetupConnectionTypes: ["ssh"],
      supportsTemplateCapture: true,
      templateRefKind: "snapshot",
      supportsTemplateDelete: true,
    });
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

  it("applies quota-safety auto-stop/archive/delete defaults when unset", async () => {
    process.env.DAYTONA_API_KEY = "host-key";

    const result = await plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "daytona",
      config: {
        snapshot: "base-snapshot",
        timeoutMs: 300000,
        reuseLease: true,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      normalizedConfig: {
        autoStopInterval: 15,
        autoArchiveInterval: 60,
        autoDeleteInterval: 10080,
      },
    });
  });

  it("preserves an explicit 0/-1 to disable auto intervals", async () => {
    process.env.DAYTONA_API_KEY = "host-key";

    const result = await plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "daytona",
      config: {
        snapshot: "base-snapshot",
        timeoutMs: 300000,
        autoStopInterval: 0,
        autoArchiveInterval: 0,
        autoDeleteInterval: -1,
        reuseLease: true,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      normalizedConfig: {
        autoStopInterval: 0,
        autoArchiveInterval: 0,
        autoDeleteInterval: -1,
      },
    });
  });

  it("forwards auto-archive/auto-delete defaults to the Daytona create call", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    mockCreate.mockResolvedValue(sandbox);

    await plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      runId: "run-1",
      config: {
        image: "node:20",
        timeoutMs: 300000,
        reuseLease: false,
      },
    });

    const [createParams] = mockCreate.mock.calls[0] as [Record<string, unknown>];
    expect(createParams).toMatchObject({
      autoStopInterval: 15,
      autoArchiveInterval: 60,
      autoDeleteInterval: 10080,
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
      agentId: "agent-1",
      executionWorkspaceId: "workspace-1",
      adapterType: "codex_local",
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
        workspaceSentinel: {
          path: "/home/daytona/paperclip-workspace/.paperclip-runtime/reusable-sandbox-lease.json",
          result: "written",
        },
      },
    });
    expect(sandbox.fs.createFolder).toHaveBeenCalledWith(
      "/home/daytona/paperclip-workspace/.paperclip-runtime",
      "755",
    );
    expect(sandbox.fs.uploadFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      "/home/daytona/paperclip-workspace/.paperclip-runtime/reusable-sandbox-lease.json",
      300,
    );
  });

  it("starts an interactive setup sandbox with redacted metadata and one-time SSH payload", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    mockCreate.mockResolvedValue(sandbox);

    const session = await plugin.definition.onEnvironmentStartInteractiveSetup?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      sessionId: "setup-1",
      sourceTemplateRef: "existing-secret-snapshot",
      sourceTemplateKind: "snapshot",
      connectionExpiresInMinutes: 30,
      config: {
        image: "node:20",
        timeoutMs: 300000,
        reuseLease: false,
      },
    });

    const [createParams] = mockCreate.mock.calls[0] as [Record<string, unknown>];
    expect(createParams).toMatchObject({
      snapshot: "existing-secret-snapshot",
      labels: {
        "paperclip-provider": "daytona",
        "paperclip-setup-session-id": "setup-1",
        "paperclip-purpose": "interactive_setup",
      },
    });
    expect(createParams).not.toHaveProperty("image");
    expect(sandbox.createSshAccess).toHaveBeenCalledWith(30);
    expect(session).toMatchObject({
      providerLeaseId: "sandbox-123",
      status: "waiting_for_user",
      connectionSummary: {
        type: "ssh",
        username: "token",
        hostRedacted: true,
        portRedacted: true,
        commandRedacted: true,
      },
      connectionPayload: {
        type: "ssh",
        command: "ssh ssh-token-secret@ssh.app.daytona.io",
        token: "ssh-token-secret",
      },
      metadata: {
        provider: "daytona",
        connectionRedacted: true,
        sourceTemplateRefRedacted: true,
      },
    });
    expect(JSON.stringify(session?.metadata)).not.toContain("ssh-token-secret");
    expect(JSON.stringify(session?.metadata)).not.toContain("existing-secret-snapshot");
    expect(JSON.stringify(session?.connectionSummary)).not.toContain("ssh-token-secret");
  });

  it("starts interactive setup from an image source when the environment is image-backed", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    mockCreate.mockResolvedValue(sandbox);

    await plugin.definition.onEnvironmentStartInteractiveSetup?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      sessionId: "setup-image-1",
      sourceTemplateRef: "node:20",
      sourceTemplateKind: "image",
      connectionExpiresInMinutes: 30,
      config: {
        snapshot: "base-snapshot",
        timeoutMs: 300000,
        reuseLease: false,
      },
    });

    const [createParams] = mockCreate.mock.calls[0] as [Record<string, unknown>];
    expect(createParams).toMatchObject({
      image: "node:20",
      labels: {
        "paperclip-provider": "daytona",
        "paperclip-setup-session-id": "setup-image-1",
        "paperclip-purpose": "interactive_setup",
      },
    });
    expect(createParams).not.toHaveProperty("snapshot");
  });

  it("cleans up the setup sandbox if SSH access is unsupported", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    delete (sandbox as { createSshAccess?: unknown }).createSshAccess;
    mockCreate.mockResolvedValue(sandbox);

    await expect(plugin.definition.onEnvironmentStartInteractiveSetup?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      sessionId: "setup-1",
      config: {
        snapshot: "base-snapshot",
        timeoutMs: 300000,
        reuseLease: false,
      },
    })).rejects.toThrow("Sandbox.createSshAccess");

    expect(sandbox.delete).toHaveBeenCalledWith(300);
  });

  it("returns setup status without minting SSH access unless requested", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox({ id: "sandbox-setup" });
    mockGet.mockResolvedValue(sandbox);

    const session = await plugin.definition.onEnvironmentGetInteractiveSetup?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "sandbox-setup",
      includeConnectionPayload: false,
      config: {
        snapshot: "base-snapshot",
        timeoutMs: 300000,
        reuseLease: false,
      },
    });

    expect(sandbox.createSshAccess).not.toHaveBeenCalled();
    expect(session).toMatchObject({
      providerLeaseId: "sandbox-setup",
      status: "waiting_for_user",
      connectionSummary: {
        type: "ssh",
        hostRedacted: true,
        portRedacted: true,
      },
      connectionPayload: null,
    });
  });

  it("returns missing setup status when the Daytona sandbox is gone", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    mockGet.mockRejectedValue(new MockDaytonaNotFoundError("missing"));

    await expect(plugin.definition.onEnvironmentGetInteractiveSetup?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "sandbox-missing",
      includeConnectionPayload: true,
      config: {
        snapshot: "base-snapshot",
        timeoutMs: 300000,
        reuseLease: false,
      },
    })).resolves.toEqual({
      providerLeaseId: null,
      status: "missing",
      connectionSummary: null,
      connectionPayload: null,
      metadata: {
        provider: "daytona",
        missing: true,
      },
    });
  });

  it("captures a Daytona snapshot from a live setup sandbox with redacted metadata", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox({ id: "sandbox-setup" });
    mockGet.mockResolvedValue(sandbox);

    const result = await plugin.definition.onEnvironmentCaptureTemplate?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "sandbox-setup",
      templateLabel: " Paperclip Env 1 ",
      sourceTemplateRef: "source-secret-snapshot",
      previousTemplateRef: "previous-secret-snapshot",
      timeoutMs: 120000,
      config: {
        snapshot: "base-snapshot",
        timeoutMs: 300000,
        reuseLease: false,
      },
    });

    expect(sandbox._experimental_createSnapshot).toHaveBeenCalledWith("paperclip-env-1", 120);
    expect(result).toMatchObject({
      templateKind: "snapshot",
      templateRef: "paperclip-env-1",
      metadata: {
        provider: "daytona",
        sandboxId: "sandbox-setup",
        sourceTemplateRefRedacted: true,
        previousTemplateRefRedacted: true,
      },
    });
    expect(JSON.stringify(result?.metadata)).not.toContain("source-secret-snapshot");
    expect(JSON.stringify(result?.metadata)).not.toContain("previous-secret-snapshot");
  });

  it("cancels an interactive setup sandbox by deleting it", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox({ id: "sandbox-setup" });
    mockGet.mockResolvedValue(sandbox);

    const result = await plugin.definition.onEnvironmentCancelInteractiveSetup?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "sandbox-setup",
      reason: "user_cancelled",
      config: {
        snapshot: "base-snapshot",
        timeoutMs: 300000,
        reuseLease: false,
      },
    });

    expect(sandbox.delete).toHaveBeenCalledWith(300);
    expect(result).toMatchObject({
      status: "cancelled",
      metadata: {
        provider: "daytona",
        sandboxId: "sandbox-setup",
        reason: "user_cancelled",
      },
    });
  });

  it("deletes Daytona snapshot templates through the snapshot service", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const snapshot = { name: "captured-template" };
    mockSnapshotGet.mockResolvedValue(snapshot);

    const result = await plugin.definition.onEnvironmentDeleteTemplate?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      templateRef: "captured-template",
      templateKind: "snapshot",
      reason: "cleanup",
      config: {
        snapshot: "base-snapshot",
        timeoutMs: 300000,
        reuseLease: false,
      },
    });

    expect(mockSnapshotGet).toHaveBeenCalledWith("captured-template");
    expect(mockSnapshotDelete).toHaveBeenCalledWith(snapshot);
    expect(result).toEqual({
      deleted: true,
      metadata: {
        provider: "daytona",
        templateKind: "snapshot",
        templateRefRedacted: true,
        reason: "cleanup",
      },
    });
  });

  it("passes configured resources to Daytona for image-based creation", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    mockCreate.mockResolvedValue(sandbox);

    await plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      runId: "run-1",
      agentId: "agent-1",
      executionWorkspaceId: "workspace-1",
      adapterType: "codex_local",
      config: {
        image: "node:20",
        cpu: 4,
        memory: 8,
        disk: 20,
        timeoutMs: 300000,
        reuseLease: true,
      },
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [createParams] = mockCreate.mock.calls[0] as [Record<string, unknown>];
    expect(createParams).toMatchObject({
      image: "node:20",
      resources: { cpu: 4, memory: 8, disk: 20, gpu: undefined },
    });
    expect(createParams).not.toHaveProperty("snapshot");
    expect(sandbox.resize).not.toHaveBeenCalled();
  });

  it("drops resource settings for snapshot-backed runtime creation instead of failing", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    mockCreate.mockResolvedValue(sandbox);

    await plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      runId: "run-1",
      agentId: "agent-1",
      executionWorkspaceId: "workspace-1",
      adapterType: "codex_local",
      config: {
        snapshot: "captured-snapshot",
        cpu: 4,
        memory: 8,
        disk: 20,
        timeoutMs: 300000,
        reuseLease: true,
      },
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [createParams] = mockCreate.mock.calls[0] as [Record<string, unknown>];
    expect(createParams).toMatchObject({ snapshot: "captured-snapshot" });
    expect(createParams).not.toHaveProperty("resources");
    expect(createParams).not.toHaveProperty("image");
  });

  it("rejects resource settings for snapshot-backed creation", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const result = await plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "daytona",
      config: {
        snapshot: "base-snapshot",
        cpu: 4,
        memory: 8,
        disk: 20,
        timeoutMs: 300000,
        reuseLease: true,
      },
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        "Daytona resource settings require image-backed sandbox creation; snapshot/default sandbox creation cannot override CPU, memory, disk, or GPU.",
      ],
    });
  });

  it("rejects resource settings for default sandbox creation before creating a sandbox", async () => {
    process.env.DAYTONA_API_KEY = "host-key";

    await expect(plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      runId: "run-1",
      agentId: "agent-1",
      executionWorkspaceId: "workspace-1",
      adapterType: "codex_local",
      config: {
        cpu: 4,
        memory: 4,
        timeoutMs: 300000,
        reuseLease: false,
      },
    })).rejects.toThrow(
      "Daytona resource settings require image-backed sandbox creation; default sandbox creation cannot override CPU, memory, disk, or GPU.",
    );

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("records requested resources in lease metadata", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    mockCreate.mockResolvedValue(sandbox);

    const lease = await plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      runId: "run-1",
      agentId: "agent-1",
      executionWorkspaceId: "workspace-1",
      adapterType: "codex_local",
      config: {
        image: "daytonaio/sandbox:0.8.0",
        cpu: 4,
        memory: 8,
        timeoutMs: 300000,
        reuseLease: true,
      },
    });

    expect(lease?.metadata).toMatchObject({ cpu: 4, memory: 8 });
    expect(lease?.metadata).not.toHaveProperty("disk");
    expect(lease?.metadata).not.toHaveProperty("gpu");
  });

  it("changes reusable-lease sentinel identity when resources change", async () => {
    process.env.DAYTONA_API_KEY = "host-key";

    const acquireWithCpu = async (cpu: number): Promise<string> => {
      const sandbox = createMockSandbox();
      mockCreate.mockResolvedValueOnce(sandbox);
      await plugin.definition.onEnvironmentAcquireLease?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        runId: "run-1",
        agentId: "agent-1",
        executionWorkspaceId: "workspace-1",
        adapterType: "codex_local",
        config: {
          image: "daytonaio/sandbox:0.8.0",
          cpu,
          timeoutMs: 300000,
          reuseLease: true,
        },
      });
      const uploadCall = sandbox.fs.uploadFile.mock.calls.find(
        (call) => typeof call[1] === "string" && call[1].endsWith("reusable-sandbox-lease.json"),
      ) as [Buffer, string, number] | undefined;
      expect(uploadCall).toBeTruthy();
      const parsed = JSON.parse((uploadCall as [Buffer, string, number])[0].toString("utf8")) as { token: string };
      return parsed.token;
    };

    const tokenCpu1 = await acquireWithCpu(1);
    const tokenCpu4 = await acquireWithCpu(4);

    expect(tokenCpu1).toBeTruthy();
    expect(tokenCpu4).toBeTruthy();
    expect(tokenCpu1).not.toEqual(tokenCpu4);
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

  it("resumes a reusable lease when the workspace sentinel matches", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox({ id: "sandbox-reuse", state: "stopped" });
    sandbox.process.executeCommand
      .mockResolvedValueOnce({
        exitCode: 0,
        result: JSON.stringify({ token: "sentinel-token" }),
        artifacts: { stdout: JSON.stringify({ token: "sentinel-token" }) },
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        result: "bash",
        artifacts: { stdout: "bash" },
      });
    mockGet.mockResolvedValue(sandbox);

    const lease = await plugin.definition.onEnvironmentResumeLease?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "sandbox-reuse",
      config: {
        timeoutMs: 300000,
        reuseLease: true,
      },
      leaseMetadata: {
        workspaceSentinel: {
          path: "/home/daytona/paperclip-workspace/.paperclip-runtime/reusable-sandbox-lease.json",
          token: "sentinel-token",
          result: "written",
        },
      },
    });

    expect(sandbox.start).toHaveBeenCalledWith(300);
    expect(lease).toMatchObject({
      providerLeaseId: "sandbox-reuse",
      metadata: {
        resumedLease: true,
        workspaceSentinel: {
          result: "matched",
          token: "sentinel-token",
        },
      },
    });
  });

  it("expires a reusable lease when the workspace sentinel does not match", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox({ id: "sandbox-reuse", state: "stopped" });
    sandbox.process.executeCommand.mockResolvedValueOnce({
      exitCode: 0,
      result: JSON.stringify({ token: "other-token" }),
      artifacts: { stdout: JSON.stringify({ token: "other-token" }) },
    });
    mockGet.mockResolvedValue(sandbox);

    await expect(plugin.definition.onEnvironmentResumeLease?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "sandbox-reuse",
      config: {
        timeoutMs: 300000,
        reuseLease: true,
      },
      leaseMetadata: {
        workspaceSentinel: {
          path: "/home/daytona/paperclip-workspace/.paperclip-runtime/reusable-sandbox-lease.json",
          token: "sentinel-token",
          result: "written",
        },
      },
    })).resolves.toEqual({
      providerLeaseId: null,
      metadata: {
        expired: true,
        workspaceSentinel: {
          path: "/home/daytona/paperclip-workspace/.paperclip-runtime/reusable-sandbox-lease.json",
          token: "sentinel-token",
          result: "mismatch",
        },
      },
    });

    expect(sandbox.process.executeCommand).toHaveBeenCalledTimes(1);
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

describe("daytona manifest memory config", () => {
  const memorySchema = (
    manifest.environmentDrivers?.[0]?.configSchema as {
      properties?: Record<string, { type?: string; enum?: unknown[] }>;
      required?: string[];
    }
  );

  it("offers memory as a fixed dropdown of supported sandbox sizes", () => {
    expect(memorySchema.properties?.memory?.enum).toEqual([1, 2, 4, 8]);
  });

  it("excludes 0 — an invalid Daytona memory configuration", () => {
    expect(memorySchema.properties?.memory?.enum).not.toContain(0);
  });

  it("keeps memory optional so the blank/default selection stays valid", () => {
    expect(memorySchema.required ?? []).not.toContain("memory");
  });
});
