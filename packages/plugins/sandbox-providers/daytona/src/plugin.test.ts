import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    archive: vi.fn().mockResolvedValue(undefined),
    setAutoDeleteInterval: vi.fn().mockResolvedValue(undefined),
    createSshAccess: vi.fn().mockResolvedValue({
      token: "ssh-token-secret",
      command: "ssh ssh-token-secret@ssh.app.daytona.io",
    }),
    _experimental_createSnapshot: vi.fn().mockResolvedValue(undefined),
    fs: {
      createFolder: vi.fn().mockResolvedValue(undefined),
      uploadFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      // Native batch file-transfer primitives (Daytona SDK 0.171.0). Extended
      // here so the sync hooks can be exercised without a real SDK install.
      uploadFiles: vi.fn().mockResolvedValue(undefined),
      downloadFiles: vi.fn().mockResolvedValue([]),
      setFilePermissions: vi.fn().mockResolvedValue(undefined),
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
        archiveOnRelease: false,
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

  it("archives instead of deleting when the lease was acquired with archiveOnRelease", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox({ id: "sandbox-test-probe", state: "started" });
    mockGet.mockResolvedValue(sandbox);

    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "sandbox-test-probe",
      config: {
        timeoutMs: 300000,
        reuseLease: false,
        archiveOnRelease: true,
      },
    });

    expect(sandbox.stop).toHaveBeenCalledWith(300);
    expect(sandbox.setAutoDeleteInterval).toHaveBeenCalledWith(60);
    expect(sandbox.archive).toHaveBeenCalled();
    expect(sandbox.delete).not.toHaveBeenCalled();
  });

  it("falls back to delete when archiving an archiveOnRelease lease fails", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox({ id: "sandbox-test-probe", state: "stopped" });
    sandbox.archive.mockRejectedValueOnce(new Error("archive unsupported"));
    mockGet.mockResolvedValue(sandbox);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "sandbox-test-probe",
      config: {
        timeoutMs: 300000,
        reuseLease: false,
        archiveOnRelease: true,
      },
    });

    expect(sandbox.stop).not.toHaveBeenCalled();
    expect(sandbox.archive).toHaveBeenCalled();
    expect(sandbox.delete).toHaveBeenCalledWith(300);
    expect(warnSpy).toHaveBeenCalled();
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
    expect(command).toMatch(/&& env GIT_TERMINAL_PROMPT='0' GCM_INTERACTIVE='Never' GIT_ASKPASS='echo' SSH_ASKPASS='echo' SSH_ASKPASS_REQUIRE='force' FOO='bar' 'printf' 'hello'$/);
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
    expect(command).toMatch(/env .* 'cat' < '\/tmp\/paperclip-stdin-/);
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

  it("injects noninteractive git credential defaults for every one-shot command", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    mockGet.mockResolvedValue(sandbox);

    await plugin.definition.onEnvironmentExecute?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: { providerLeaseId: "sandbox-123", metadata: {} },
      command: "git",
      args: ["status"],
      timeoutMs: 5000,
    });

    const [command] = sandbox.process.executeCommand.mock.calls[0] as [string];
    expect(command).toContain("GIT_TERMINAL_PROMPT='0'");
    expect(command).toContain("GCM_INTERACTIVE='Never'");
    expect(command).toContain("GIT_ASKPASS='echo'");
    expect(command).toContain("SSH_ASKPASS='echo'");
    expect(command).toContain("SSH_ASKPASS_REQUIRE='force'");
  });

  it("caps git network commands at 120 s and returns an actionable message on timeout", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    sandbox.process.executeCommand.mockRejectedValue(new MockDaytonaTimeoutError("timed out"));
    mockGet.mockResolvedValue(sandbox);

    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: { providerLeaseId: "sandbox-123", metadata: {} },
      command: "git",
      args: ["push", "origin", "HEAD"],
      cwd: "/workspace",
      timeoutMs: 300000,
    });

    const [, , , timeoutArg] = sandbox.process.executeCommand.mock.calls[0] as [string, unknown, unknown, number];
    expect(timeoutArg).toBe(120);
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(result?.stderr).toMatch(/unreachable|credentials/i);
  });
});

describe("daytona native file-sync hooks", () => {
  const REMOTE_DIR = "/home/daytona/paperclip-workspace";
  const tempDirs: string[] = [];

  async function makeHostDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "daytona-sync-test-"));
    tempDirs.push(dir);
    return dir;
  }

  function syncLease(overrides: Record<string, unknown> = {}) {
    return {
      providerLeaseId: "sandbox-123",
      metadata: { provider: "daytona", remoteCwd: REMOTE_DIR, ...overrides },
    };
  }

  beforeEach(() => {
    process.env.DAYTONA_API_KEY = "host-key";
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("declares both sync hooks so the worker advertises the native transport", () => {
    expect(plugin.definition.onEnvironmentSyncIn).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentSyncOut).toBeTypeOf("function");
  });

  it("syncIn coalesces file mappings into one uploadFiles batch to reserved temp destinations, then one batched mv, applying secret mode via setFilePermissions before the rename", async () => {
    const hostDir = await makeHostDir();
    const secretSource = path.join(hostDir, "auth.json");
    const plainSource = path.join(hostDir, "config.txt");
    await fs.writeFile(secretSource, "credential-material");
    await fs.writeFile(plainSource, "plain");

    const sandbox = createMockSandbox();
    mockGet.mockResolvedValue(sandbox);

    const result = await plugin.definition.onEnvironmentSyncIn?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: syncLease(),
      operations: [
        {
          operationId: "sync-op-1",
          files: [
            { sourcePath: secretSource, targetPath: `${REMOTE_DIR}/.secret/auth.json`, kind: "file", mode: 0o600 },
            { sourcePath: plainSource, targetPath: `${REMOTE_DIR}/config.txt`, kind: "file" },
          ],
        },
      ],
    });

    // Exactly one bulk upload for both file mappings.
    expect(sandbox.fs.uploadFiles).toHaveBeenCalledTimes(1);
    const [uploads] = sandbox.fs.uploadFiles.mock.calls[0] as [Array<{ source: string; destination: string }>];
    expect(uploads).toHaveLength(2);
    // String sources stream from the local path; destinations are reserved temps.
    expect(uploads[0].source).toBe(secretSource);
    for (const upload of uploads) {
      expect(path.posix.basename(upload.destination)).toMatch(/^\.paperclip-upload-/);
      expect(upload.destination).not.toBe(`${REMOTE_DIR}/.secret/auth.json`);
      // TOCTOU-hardened: the privileged upload destination is a DIRECT child of the
      // workspace root, never a sibling under the target's (sandbox-swappable)
      // parent dir, so a parent symlink swap cannot redirect the write out of root.
      expect(path.posix.dirname(upload.destination)).toBe(REMOTE_DIR);
    }

    // Secret mode applied on the TEMP path (before the rename) so the target
    // never appears at a widened window; applied via setFilePermissions as "600".
    expect(sandbox.fs.setFilePermissions).toHaveBeenCalledTimes(1);
    const [permPath, perms] = sandbox.fs.setFilePermissions.mock.calls[0] as [string, { mode: string }];
    expect(path.posix.basename(permPath)).toMatch(/^\.paperclip-upload-/);
    expect(perms).toEqual({ mode: "600" });

    // The setFilePermissions on the temp precedes the mv that promotes it.
    const secretTemp = permPath;
    const mvCall = sandbox.process.executeCommand.mock.calls.find(([cmd]) => String(cmd).includes("mv -f"));
    expect(mvCall).toBeDefined();
    const mvCommand = String(mvCall?.[0]);
    // TOCTOU-hardened rename: each promotion re-canonicalizes the target's parent
    // dir, confirms it is still confined, OPENS that dir as fd 8, re-verifies the
    // pinned inode is in-root, then `mv`s into `/proc/self/fd/8/<base>` — all in ONE
    // sh invocation, so neither an ancestor swap before the open nor a path swap
    // after it can redirect the rename. The rename is wrapped in `sh -c '...'`, so
    // inner single-quotes are shell-escaped; assert on the un-escaped components.
    expect(mvCommand).toContain("_pc_resolve");
    // The parent dir is opened as fd 8 and its pinned inode re-verified in-root
    // before the rename, which targets the inode via /proc/self/fd/8 rather than the
    // literal (swappable) path string.
    expect(mvCommand).toContain(secretTemp);
    expect(mvCommand).toContain('exec 8<"$_pc_tgt_dir"');
    expect(mvCommand).toContain("_pc_fd_dir=$(_pc_resolve /proc/self/fd/8)");
    expect(mvCommand).toContain("/proc/self/fd/8/");
    expect(mvCommand).toContain("auth.json");
    // Both temps are promoted (one mv line per rename).
    expect(mvCommand.match(/mv -f /g)).toHaveLength(2);

    expect(result).toEqual({
      operations: [{ operationId: "sync-op-1", filesTransferred: 2, bytesTransferred: "credential-material".length + "plain".length }],
    });
  });

  it("syncIn tars a directory mapping host-side honoring excludes and the followSymlinks flag, then extracts it in-sandbox via a single quoted tar command", async () => {
    const hostDir = await makeHostDir();
    const sourceDir = path.join(hostDir, "assets");
    await fs.mkdir(path.join(sourceDir, "keep"), { recursive: true });
    await fs.writeFile(path.join(sourceDir, "keep", "a.txt"), "alpha");
    await fs.writeFile(path.join(sourceDir, "skip.log"), "noise");
    await fs.symlink("keep/a.txt", path.join(sourceDir, "link.txt"));

    const sandbox = createMockSandbox();
    // Capture the tar listing inside the upload mock, before withHostTempDir
    // cleans the host scratch dir.
    let capturedTarListing = "";
    sandbox.fs.uploadFiles.mockImplementation(async (uploads: Array<{ source: string }>) => {
      capturedTarListing = execFileSync("tar", ["-tvf", uploads[0].source]).toString();
    });
    mockGet.mockResolvedValue(sandbox);

    // Preserve-symlink case (followSymlinks falsy → no -h).
    await plugin.definition.onEnvironmentSyncIn?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: syncLease(),
      operations: [
        {
          operationId: "sync-op-dir",
          files: [
            {
              sourcePath: sourceDir,
              targetPath: `${REMOTE_DIR}/.paperclip-runtime/assets`,
              kind: "directory",
              exclude: ["*.log"],
            },
          ],
        },
      ],
    });

    expect(sandbox.fs.uploadFiles).toHaveBeenCalledTimes(1);
    const [uploads] = sandbox.fs.uploadFiles.mock.calls[0] as [Array<{ source: string; destination: string }>];
    expect(uploads).toHaveLength(1);
    expect(uploads[0].source).toMatch(/\.tar$/);
    expect(path.posix.basename(uploads[0].destination)).toMatch(/^\.paperclip-upload-.*\.tar$/);
    expect(uploads[0].destination.startsWith(`${REMOTE_DIR}/`)).toBe(true);

    // Inspect the real host tar: excluded file gone; symlink preserved AS a link.
    expect(capturedTarListing).toContain("keep/a.txt");
    expect(capturedTarListing).not.toContain("skip.log");
    expect(capturedTarListing).toMatch(/link\.txt ->|link\.txt link to/);

    // The target dir is created by its own mkdir command (so the realpath guard
    // that follows resolves real components), no longer inside the extract chain.
    const mkdirCall = sandbox.process.executeCommand.mock.calls.find(
      ([cmd]) =>
        String(cmd).includes("mkdir -p") &&
        String(cmd).includes(`'${REMOTE_DIR}/.paperclip-runtime/assets'`) &&
        !String(cmd).includes("tar -xf"),
    );
    expect(mkdirCall).toBeDefined();
    // The realpath symlink-escape guard runs on the target before extraction.
    const inboundGuardCall = sandbox.process.executeCommand.mock.calls.find(([cmd]) =>
      String(cmd).includes("_pc_resolve"),
    );
    expect(inboundGuardCall).toBeDefined();

    const extractCall = sandbox.process.executeCommand.mock.calls.find(([cmd]) => String(cmd).includes("tar -xf"));
    expect(extractCall).toBeDefined();
    const extractCommand = String(extractCall?.[0]);
    // The extract binds validation and extraction into one sandbox invocation: it
    // re-canonicalizes the target, opens the resolved dir as fd 9, re-verifies the
    // PINNED inode (`/proc/self/fd/9`) is still in-root — closing the ancestor-swap
    // race in the `open()` itself — then extracts via /proc/self/fd/9, binding
    // extraction to the directory inode rather than the path string.
    expect(extractCommand).toContain("_pc_resolve");
    expect(extractCommand).toContain(".paperclip-runtime/assets");
    expect(extractCommand).toContain("tar -xf");
    expect(extractCommand).toContain('exec 9<"$_pc_real"');
    expect(extractCommand).toContain("_pc_fd_real=$(_pc_resolve /proc/self/fd/9)");
    expect(extractCommand).toContain("-C /proc/self/fd/9");
    expect(extractCommand).toMatch(/rm -f .*\.paperclip-upload-.*\.tar/);
  });

  it("syncIn dereferences symlinks to bytes when followSymlinks is true (tar -h)", async () => {
    const hostDir = await makeHostDir();
    const sourceDir = path.join(hostDir, "deref");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "real.txt"), "payload");
    await fs.symlink("real.txt", path.join(sourceDir, "alias.txt"));

    const sandbox = createMockSandbox();
    let capturedTarListing = "";
    sandbox.fs.uploadFiles.mockImplementation(async (uploads: Array<{ source: string }>) => {
      capturedTarListing = execFileSync("tar", ["-tvf", uploads[0].source]).toString();
    });
    mockGet.mockResolvedValue(sandbox);

    await plugin.definition.onEnvironmentSyncIn?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: syncLease(),
      operations: [
        {
          operationId: "sync-op-deref",
          files: [{ sourcePath: sourceDir, targetPath: `${REMOTE_DIR}/deref`, kind: "directory", followSymlinks: true }],
        },
      ],
    });

    // Dereferenced: alias becomes a regular file, not a link.
    expect(capturedTarListing).not.toMatch(/alias\.txt ->/);
    expect(capturedTarListing).toContain("alias.txt");
  });

  it("syncOut reads all file mappings via one downloadFiles batch, writes each to its host target, and returns per-operation counts", async () => {
    const hostDir = await makeHostDir();
    const sandbox = createMockSandbox();
    // The download reads sandbox-side snapshots (reserved temp names), which are
    // index-aligned with the file mappings; write payloads in request order.
    const payloadsInOrder = ["result-bytes", "secret-bytes"];
    sandbox.fs.downloadFiles.mockImplementation(async (requests: Array<{ source: string; destination?: string }>) => {
      return Promise.all(
        requests.map(async (req, index) => {
          await fs.writeFile(req.destination!, payloadsInOrder[index]);
          return { source: req.source, result: req.destination };
        }),
      );
    });
    mockGet.mockResolvedValue(sandbox);

    const resultTarget = path.join(hostDir, "result.txt");
    const secretTarget = path.join(hostDir, "secret.key");
    const result = await plugin.definition.onEnvironmentSyncOut?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: syncLease(),
      operations: [
        {
          operationId: "sync-op-out",
          files: [
            { sourcePath: `${REMOTE_DIR}/out/result.txt`, targetPath: resultTarget, kind: "file" },
            { sourcePath: `${REMOTE_DIR}/out/secret.key`, targetPath: secretTarget, kind: "file", mode: 0o600 },
          ],
        },
      ],
    });

    expect(sandbox.fs.downloadFiles).toHaveBeenCalledTimes(1);
    const [requests] = sandbox.fs.downloadFiles.mock.calls[0] as [Array<{ source: string; destination: string }>];
    expect(requests).toHaveLength(2);
    for (const req of requests) {
      expect(path.basename(req.destination)).toMatch(/^\.paperclip-upload-/);
      // TOCTOU-closed: the download reads a reserved snapshot inside the remote
      // dir, never the mutable original source path.
      expect(req.source.startsWith(`${REMOTE_DIR}/`)).toBe(true);
      expect(path.posix.basename(req.source)).toMatch(/^\.paperclip-upload-/);
    }
    expect(requests.map((req) => req.source)).not.toContain(`${REMOTE_DIR}/out/result.txt`);
    expect(requests.map((req) => req.source)).not.toContain(`${REMOTE_DIR}/out/secret.key`);

    expect(await fs.readFile(resultTarget, "utf8")).toBe("result-bytes");
    expect(await fs.readFile(secretTarget, "utf8")).toBe("secret-bytes");
    // Secret lands 0600 on the host target.
    expect((await fs.stat(secretTarget)).mode & 0o777).toBe(0o600);

    expect(result).toEqual({
      operations: [
        { operationId: "sync-op-out", filesTransferred: 2, bytesTransferred: "result-bytes".length + "secret-bytes".length },
      ],
    });
  });

  it("syncOut snapshot guard re-checks the resolved source is a non-symlink regular file immediately before copying (validation→copy TOCTOU)", async () => {
    const hostDir = await makeHostDir();
    const sandbox = createMockSandbox();
    sandbox.fs.downloadFiles.mockImplementation(async (requests: Array<{ source: string; destination?: string }>) => {
      return Promise.all(
        requests.map(async (req) => {
          await fs.writeFile(req.destination!, "bytes");
          return { source: req.source, result: req.destination };
        }),
      );
    });
    mockGet.mockResolvedValue(sandbox);

    await plugin.definition.onEnvironmentSyncOut?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: syncLease(),
      operations: [
        {
          operationId: "sync-op-out-nofollow",
          files: [{ sourcePath: `${REMOTE_DIR}/out/data.txt`, targetPath: path.join(hostDir, "data.txt"), kind: "file" }],
        },
      ],
    });

    // The snapshot guard runs realpath → confine → no-follow re-check → cp, all in
    // one `sh -c`. The `[ -L ]`/`[ -f ]` re-check must precede the `cp` so a source
    // the sandbox repointed to a symlink after realpath is refused, not followed.
    const guardCall = sandbox.process.executeCommand.mock.calls.find(
      ([cmd]) => String(cmd).includes("_pc_resolve") && String(cmd).includes("cp --"),
    );
    expect(guardCall).toBeDefined();
    const guardCommand = String(guardCall?.[0]);
    expect(guardCommand).toContain('[ -L "$_pc_real" ]');
    expect(guardCommand).toContain('[ -f "$_pc_real" ]');
    const noFollowIdx = guardCommand.indexOf('[ -L "$_pc_real" ]');
    const copyIdx = guardCommand.indexOf('cp -- "$_pc_real"');
    expect(noFollowIdx).toBeGreaterThan(-1);
    expect(copyIdx).toBeGreaterThan(noFollowIdx);
  });

  it("syncOut fails loud when any per-file download reports an error, and leaves no target file", async () => {
    const hostDir = await makeHostDir();
    const sandbox = createMockSandbox();
    // Requests read snapshots (index-aligned with mappings); the second mapping
    // (`missing.txt`) reports a per-file error.
    sandbox.fs.downloadFiles.mockImplementation(async (requests: Array<{ source: string; destination?: string }>) => {
      return requests.map((req, index) =>
        index === 1
          ? { source: req.source, error: "not found", errorDetails: { message: "not found", statusCode: 404 } }
          : { source: req.source, result: req.destination },
      );
    });
    mockGet.mockResolvedValue(sandbox);

    const okTarget = path.join(hostDir, "ok.txt");
    const badTarget = path.join(hostDir, "missing.txt");
    await expect(
      plugin.definition.onEnvironmentSyncOut?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        config: { timeoutMs: 300000, reuseLease: false },
        lease: syncLease(),
        operations: [
          {
            operationId: "sync-op-err",
            files: [
              { sourcePath: `${REMOTE_DIR}/ok.txt`, targetPath: okTarget, kind: "file" },
              { sourcePath: `${REMOTE_DIR}/missing.txt`, targetPath: badTarget, kind: "file" },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/download failed for .*missing\.txt: not found/);

    // Fail-loud: no target file is promoted when the batch has any error.
    await expect(fs.stat(okTarget)).rejects.toThrow();
    await expect(fs.stat(badTarget)).rejects.toThrow();
  });

  it("rejects a sync target path that escapes the workspace remote dir (path confinement)", async () => {
    const hostDir = await makeHostDir();
    const source = path.join(hostDir, "evil.txt");
    await fs.writeFile(source, "x");
    const sandbox = createMockSandbox();
    mockGet.mockResolvedValue(sandbox);

    await expect(
      plugin.definition.onEnvironmentSyncIn?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        config: { timeoutMs: 300000, reuseLease: false },
        lease: syncLease(),
        operations: [
          {
            operationId: "sync-op-escape",
            files: [{ sourcePath: source, targetPath: `${REMOTE_DIR}/../../etc/passwd`, kind: "file" }],
          },
        ],
      }),
    ).rejects.toThrow(/escapes the workspace remote dir|not a confined absolute path/);

    expect(sandbox.fs.uploadFiles).not.toHaveBeenCalled();
  });

  it("syncOut rejects an outbound source whose in-sandbox realpath escapes the workspace remote dir, before any download", async () => {
    const hostDir = await makeHostDir();
    const sandbox = createMockSandbox();
    // The in-sandbox realpath guard runs as a single `sh -c` probe; report the
    // escape exit code (42) for that probe while leaving any other command green,
    // so the guard is the only thing that can trip this test.
    sandbox.process.executeCommand.mockImplementation(async (command: string) => {
      if (command.includes("_pc_resolve")) {
        return { exitCode: 42, result: `ESCAPE:${REMOTE_DIR}/out/link.txt`, artifacts: { stdout: "" } };
      }
      return { exitCode: 0, result: "bash", artifacts: { stdout: "bash" } };
    });
    mockGet.mockResolvedValue(sandbox);

    const target = path.join(hostDir, "link.txt");
    await expect(
      plugin.definition.onEnvironmentSyncOut?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        config: { timeoutMs: 300000, reuseLease: false },
        lease: syncLease(),
        operations: [
          {
            operationId: "sync-op-escape-out",
            files: [{ sourcePath: `${REMOTE_DIR}/out/link.txt`, targetPath: target, kind: "file" }],
          },
        ],
      }),
    ).rejects.toThrow(/outbound symlink-escape guard command failed \(exit 42\)/);

    // Fail-closed: the guard trips before any bytes are read, and no target lands.
    expect(sandbox.fs.downloadFiles).not.toHaveBeenCalled();
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it("syncOut fails closed when the sandbox has no path canonicalizer to resolve the symlink guard", async () => {
    const hostDir = await makeHostDir();
    const sandbox = createMockSandbox();
    // Neither `realpath` nor `readlink` present → the probe exits 40 rather than
    // silently skipping the guard the host-side string check cannot enforce.
    sandbox.process.executeCommand.mockImplementation(async (command: string) => {
      if (command.includes("_pc_resolve")) {
        return { exitCode: 40, result: "no path canonicalizer available", artifacts: { stdout: "" } };
      }
      return { exitCode: 0, result: "bash", artifacts: { stdout: "bash" } };
    });
    mockGet.mockResolvedValue(sandbox);

    const target = path.join(hostDir, "data.txt");
    await expect(
      plugin.definition.onEnvironmentSyncOut?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        config: { timeoutMs: 300000, reuseLease: false },
        lease: syncLease(),
        operations: [
          {
            operationId: "sync-op-no-canon",
            files: [{ sourcePath: `${REMOTE_DIR}/out/data.txt`, targetPath: target, kind: "file" }],
          },
        ],
      }),
    ).rejects.toThrow(/outbound symlink-escape guard command failed \(exit 40\)/);

    expect(sandbox.fs.downloadFiles).not.toHaveBeenCalled();
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it("syncIn rejects a file mapping whose in-sandbox target parent resolves outside the remote dir (symlinked-parent escape), before uploading", async () => {
    const hostDir = await makeHostDir();
    const source = path.join(hostDir, "auth.json");
    await fs.writeFile(source, "credential-material");

    const sandbox = createMockSandbox();
    // The lexical path check passes (the target string is confined), but the
    // realpath guard on the materialized parent dir resolves outside the root:
    // report the escape exit (42) for the `_pc_resolve` probe, green otherwise.
    sandbox.process.executeCommand.mockImplementation(async (command: string) => {
      if (command.includes("_pc_resolve")) {
        return { exitCode: 42, result: `ESCAPE:${REMOTE_DIR}/.secret`, artifacts: { stdout: "" } };
      }
      return { exitCode: 0, result: "bash", artifacts: { stdout: "bash" } };
    });
    mockGet.mockResolvedValue(sandbox);

    await expect(
      plugin.definition.onEnvironmentSyncIn?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        config: { timeoutMs: 300000, reuseLease: false },
        lease: syncLease(),
        operations: [
          {
            operationId: "sync-op-in-escape",
            files: [{ sourcePath: source, targetPath: `${REMOTE_DIR}/.secret/auth.json`, kind: "file", mode: 0o600 }],
          },
        ],
      }),
    ).rejects.toThrow(/inbound symlink-escape guard command failed \(exit 42\)/);

    // Fail-closed: the guard trips after mkdir but before any bytes are uploaded.
    expect(sandbox.fs.uploadFiles).not.toHaveBeenCalled();
    expect(sandbox.fs.setFilePermissions).not.toHaveBeenCalled();
  });

  it("syncIn rejects a directory mapping whose in-sandbox target resolves outside the remote dir (symlinked-dir extraction), before uploading the tarball", async () => {
    const hostDir = await makeHostDir();
    const sourceDir = path.join(hostDir, "assets");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "a.txt"), "alpha");

    const sandbox = createMockSandbox();
    sandbox.process.executeCommand.mockImplementation(async (command: string) => {
      if (command.includes("_pc_resolve")) {
        return { exitCode: 42, result: `ESCAPE:${REMOTE_DIR}/assets`, artifacts: { stdout: "" } };
      }
      return { exitCode: 0, result: "bash", artifacts: { stdout: "bash" } };
    });
    mockGet.mockResolvedValue(sandbox);

    await expect(
      plugin.definition.onEnvironmentSyncIn?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        config: { timeoutMs: 300000, reuseLease: false },
        lease: syncLease(),
        operations: [
          {
            operationId: "sync-op-in-dir-escape",
            files: [{ sourcePath: sourceDir, targetPath: `${REMOTE_DIR}/assets`, kind: "directory" }],
          },
        ],
      }),
    ).rejects.toThrow(/inbound symlink-escape guard command failed \(exit 42\)/);

    // Fail-closed: no tarball is uploaded and no in-sandbox extraction runs.
    expect(sandbox.fs.uploadFiles).not.toHaveBeenCalled();
    const extractCall = sandbox.process.executeCommand.mock.calls.find(([cmd]) => String(cmd).includes("tar -xf"));
    expect(extractCall).toBeUndefined();
  });

  it("syncIn sweeps staged temps when the batched rename fails mid-promotion", async () => {
    const hostDir = await makeHostDir();
    const source = path.join(hostDir, "config.txt");
    await fs.writeFile(source, "plain");

    const sandbox = createMockSandbox();
    // mkdir + realpath guard succeed; the promoting `mv -f` fails, leaving staged
    // `.paperclip-upload-*` temps that the error path must sweep with `rm -f`.
    sandbox.process.executeCommand.mockImplementation(async (command: string) => {
      if (command.includes("mv -f")) {
        return { exitCode: 1, result: "mv: permission denied", artifacts: { stdout: "mv: permission denied" } };
      }
      return { exitCode: 0, result: "bash", artifacts: { stdout: "bash" } };
    });
    mockGet.mockResolvedValue(sandbox);

    await expect(
      plugin.definition.onEnvironmentSyncIn?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        config: { timeoutMs: 300000, reuseLease: false },
        lease: syncLease(),
        operations: [
          {
            operationId: "sync-op-in-rename-fail",
            files: [{ sourcePath: source, targetPath: `${REMOTE_DIR}/config.txt`, kind: "file" }],
          },
        ],
      }),
    ).rejects.toThrow(/syncIn rename command failed \(exit 1\)/);

    // The upload happened, so a temp was staged; the error path cleans it up.
    expect(sandbox.fs.uploadFiles).toHaveBeenCalledTimes(1);
    const cleanupCall = sandbox.process.executeCommand.mock.calls.find(
      ([cmd]) => String(cmd).includes("rm -f") && String(cmd).includes(".paperclip-upload-"),
    );
    expect(cleanupCall).toBeDefined();
  });

  it("syncOut refuses a sandbox-authored tarball whose members escape the extraction dir (path traversal)", async () => {
    const hostRoot = await makeHostDir();
    const restored = path.join(hostRoot, "restored");
    const sandbox = createMockSandbox();
    sandbox.fs.downloadFiles.mockImplementation(async (requests: Array<{ source: string; destination?: string }>) => {
      return Promise.all(
        requests.map(async (req) => {
          // Craft a tar containing a traversal member `../escape.txt`.
          const staging = await fs.mkdtemp(path.join(os.tmpdir(), "daytona-evil-"));
          tempDirs.push(staging);
          await fs.mkdir(path.join(staging, "sub"), { recursive: true });
          await fs.writeFile(path.join(staging, "sub", "escape.txt"), "escape");
          execFileSync("tar", [
            "-cf",
            req.destination!,
            "-C",
            path.join(staging, "sub"),
            "--transform",
            "s,^,../,",
            "escape.txt",
          ]);
          return { source: req.source, result: req.destination };
        }),
      );
    });
    mockGet.mockResolvedValue(sandbox);

    await expect(
      plugin.definition.onEnvironmentSyncOut?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        config: { timeoutMs: 300000, reuseLease: false },
        lease: syncLease(),
        operations: [
          {
            operationId: "sync-op-out-traversal",
            files: [{ sourcePath: `${REMOTE_DIR}/proj`, targetPath: restored, kind: "directory" }],
          },
        ],
      }),
    ).rejects.toThrow(/escapes the extraction dir/);

    // The traversal member (`../escape.txt` relative to `restored`) was never
    // written above the extraction dir.
    await expect(fs.stat(path.join(hostRoot, "escape.txt"))).rejects.toThrow();
  });

  it("round-trips a directory (syncIn then syncOut) preserving contents, a 0600 file, and a preserved symlink", async () => {
    const hostRoot = await makeHostDir();
    const source = path.join(hostRoot, "src");
    await fs.mkdir(path.join(source, "nested"), { recursive: true });
    await fs.writeFile(path.join(source, "nested", "data.txt"), "hello world");
    await fs.writeFile(path.join(source, "secret"), "top-secret");
    await fs.chmod(path.join(source, "secret"), 0o600);
    await fs.symlink("nested/data.txt", path.join(source, "shortcut"));

    // Simulate the sandbox filesystem with a host-side directory the mock tar
    // commands operate on, so the round-trip exercises real tar create/extract.
    const sandboxFsRoot = await makeHostDir();
    const remoteTargetDir = path.join(sandboxFsRoot, "materialized");

    const sandbox = createMockSandbox();
    // syncIn: capture the uploaded host tar and extract it into the simulated
    // sandbox dir, mirroring the in-sandbox `tar -xf`.
    sandbox.fs.uploadFiles.mockImplementation(async (uploads: Array<{ source: string; destination: string }>) => {
      for (const upload of uploads) {
        await fs.mkdir(remoteTargetDir, { recursive: true });
        execFileSync("tar", ["-xpf", upload.source, "-C", remoteTargetDir]);
      }
    });
    // syncOut: build a tar of the simulated sandbox dir and stream it to the
    // requested host destination, mirroring in-sandbox `tar -c` + downloadFiles.
    sandbox.fs.downloadFiles.mockImplementation(async (requests: Array<{ source: string; destination?: string }>) => {
      return Promise.all(
        requests.map(async (req) => {
          const entries = (await fs.readdir(remoteTargetDir)).sort();
          execFileSync("tar", ["-cpf", req.destination!, "-C", remoteTargetDir, "--", ...entries]);
          return { source: req.source, result: req.destination };
        }),
      );
    });
    mockGet.mockResolvedValue(sandbox);

    await plugin.definition.onEnvironmentSyncIn?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: syncLease(),
      operations: [
        { operationId: "rt-in", files: [{ sourcePath: source, targetPath: `${REMOTE_DIR}/proj`, kind: "directory" }] },
      ],
    });

    const restored = path.join(hostRoot, "restored");
    await plugin.definition.onEnvironmentSyncOut?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: syncLease(),
      operations: [
        { operationId: "rt-out", files: [{ sourcePath: `${REMOTE_DIR}/proj`, targetPath: restored, kind: "directory" }] },
      ],
    });

    expect(await fs.readFile(path.join(restored, "nested", "data.txt"), "utf8")).toBe("hello world");
    expect(await fs.readFile(path.join(restored, "secret"), "utf8")).toBe("top-secret");
    expect((await fs.stat(path.join(restored, "secret"))).mode & 0o777).toBe(0o600);
    const linkStat = await fs.lstat(path.join(restored, "shortcut"));
    expect(linkStat.isSymbolicLink()).toBe(true);
    expect(await fs.readlink(path.join(restored, "shortcut"))).toBe("nested/data.txt");
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
