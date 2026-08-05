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

import plugin, {
  setDaytonaTimingClockForTest,
  setDaytonaHandleFreshnessClockForTest,
  __resetDaytonaSandboxHandleCacheForTest,
  __getDaytonaWritableDirsForTest,
  __setDaytonaPluginContextForTest,
  buildBwrapCommand,
} from "./plugin.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
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
    // Real `refreshData` re-reads live provider state and mutates `state` in
    // place; the default mock leaves state untouched, and tests that exercise a
    // provider-initiated auto-stop override it to flip `state` to "stopped".
    refreshData: vi.fn().mockResolvedValue(undefined),
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
    // The started-sandbox handle cache is process-scoped; clear it between tests
    // so a handle memoized under a reused composite key never leaks forward.
    __resetDaytonaSandboxHandleCacheForTest();
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
    expect(command).not.toMatch(/nvm\.sh/);
    expect(command).toMatch(/&& cd '\/workspace'/);
    expect(command).toMatch(/&& env GIT_TERMINAL_PROMPT='0' GCM_INTERACTIVE='Never' GIT_ASKPASS='echo' SSH_ASKPASS='echo' SSH_ASKPASS_REQUIRE='force' FOO='bar' 'printf' 'hello'$/);
    expect(command).not.toMatch(/(?:^|&& )exec /);
    // cwd/env are baked into the command itself; we pass undefined to the SDK
    // so its own cwd argument does not run before the caller env is applied.
    expect(cwdArg).toBeUndefined();
    expect(envArg).toBeUndefined();
    expect(timeoutArg).toBe(1);
    expect(result).toMatchObject({
      exitCode: 7,
      timedOut: false,
      stdout: "stdout\nstderr\n",
      stderr: "",
    });
    // Provider-boundary timings ride the free-form result metadata (Open Q1).
    expect(typeof (result!.metadata as Record<string, unknown>)?.durationMs).toBe("number");
    expect(typeof (result!.metadata as Record<string, unknown>)?.getDurationMs).toBe("number");
  });

  it("reports provider executeCommand and client.get durations via result metadata (injected clock)", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    sandbox.process.executeCommand.mockResolvedValue({
      exitCode: 0,
      result: "ok",
      artifacts: { stdout: "ok" },
    });
    mockGet.mockResolvedValue(sandbox);

    // Deterministic clock: getSandbox spans 40ms, executeCommand spans 600ms.
    // Call order across the execute path is: getStart, getEnd, execStart, execEnd.
    const ticks = [1000, 1040, 1040, 1640];
    let i = 0;
    const restoreClock = setDaytonaTimingClockForTest(() => ticks[Math.min(i++, ticks.length - 1)]!);
    try {
      const result = await plugin.definition.onEnvironmentExecute?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        config: { timeoutMs: 300000, reuseLease: false },
        lease: { providerLeaseId: "sandbox-123", metadata: {} },
        command: "printf",
        args: ["hello"],
        cwd: "/workspace",
        timeoutMs: 1000,
      });

      expect(result!.metadata).toMatchObject({ durationMs: 600, getDurationMs: 40 });
    } finally {
      restoreClock();
    }
  });

  it("sets metadata.cacheHit false on a client.get miss and true on a warm-handle hit", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    sandbox.process.executeCommand.mockResolvedValue({
      exitCode: 0,
      result: "ok",
      artifacts: { stdout: "ok" },
    });
    mockGet.mockResolvedValue(sandbox);

    const execParams = {
      driverKey: "daytona" as const,
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: { providerLeaseId: "sandbox-123", metadata: {} },
      command: "printf",
      args: ["hello"],
      cwd: "/workspace",
      timeoutMs: 1000,
    };

    // First execute: the handle cache is empty, so the lookup calls `client.get`
    // and reports a miss.
    const first = await plugin.definition.onEnvironmentExecute?.(execParams);
    expect(first!.metadata).toMatchObject({ cacheHit: false });
    expect(mockGet).toHaveBeenCalledTimes(1);

    // Second execute: the warm handle cache serves the handle, so the lookup
    // makes no `client.get` round trip and reports a hit.
    const second = await plugin.definition.onEnvironmentExecute?.(execParams);
    expect(second!.metadata).toMatchObject({ cacheHit: true });
    expect(mockGet).toHaveBeenCalledTimes(1);
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
    expect(command).not.toMatch(/nvm\.sh/);
    expect(command).toMatch(/&& cd '\/workspace'/);
    expect(command).toMatch(/env .* 'cat' < '\/tmp\/paperclip-stdin-/);
    expect(command).not.toMatch(/(?:^|&& )exec /);
    expect(sandbox.fs.deleteFile).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/paperclip-stdin-/));
    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
    });
  });

  it("wraps the command when the lease reports bwrap available and username known", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    mockGet.mockResolvedValue(sandbox);

    await plugin.definition.onEnvironmentExecute?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: {
        providerLeaseId: "sandbox-123",
        metadata: {
          remoteCwd: "/home/daytona/paperclip-workspace",
          bwrapAvailable: true,
          sandboxUsername: "daytona",
        },
      },
      command: "printf",
      args: ["hello"],
      timeoutMs: 1000,
    });

    const [command] = sandbox.process.executeCommand.mock.calls[0] as [string];
    // The wrapper runs `sudo -n bwrap`, drops to the sandbox user via su, and
    // binds the workspace directory read-write.
    expect(command.startsWith("sudo -n bwrap")).toBe(true);
    expect(command).toContain("su -s /bin/sh 'daytona'");
    expect(command).toContain(
      "--bind-try '/home/daytona/paperclip-workspace' '/home/daytona/paperclip-workspace'",
    );
    // The login-shell script still rides inside the wrapper through `su -c`.
    expect(command).toContain("/etc/profile");
  });

  it("binds collected rw sync directories", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const remoteCwd = "/home/daytona/paperclip-workspace";
    const collectedDir = `${remoteCwd}/data`;
    const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), "daytona-bwrap-test-"));
    const source = path.join(hostDir, "in-place.txt");
    await fs.writeFile(source, "bytes");
    const sandbox = createMockSandbox();
    mockGet.mockResolvedValue(sandbox);

    const scopeParams = {
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
    };

    // Record a read-write sync destination under the shared scope. The execute
    // hook reads the same scope, so the wrapper must bind this directory too.
    await plugin.definition.onEnvironmentSyncIn?.({
      ...scopeParams,
      lease: { providerLeaseId: "sandbox-123", metadata: { remoteCwd } },
      operations: [
        {
          operationId: "sync-op-rw",
          files: [
            {
              sourcePath: source,
              targetPath: `${collectedDir}/in-place.txt`,
              kind: "file" as const,
              access: "rw" as const,
            },
          ],
        },
      ],
    });
    sandbox.process.executeCommand.mockClear();

    await plugin.definition.onEnvironmentExecute?.({
      ...scopeParams,
      lease: {
        providerLeaseId: "sandbox-123",
        metadata: { remoteCwd, bwrapAvailable: true, sandboxUsername: "daytona" },
      },
      command: "printf",
      args: ["hello"],
      timeoutMs: 1000,
    });

    const [command] = sandbox.process.executeCommand.mock.calls[0] as [string];
    expect(command).toContain(`--bind-try '${collectedDir}' '${collectedDir}'`);
    await fs.rm(hostDir, { recursive: true, force: true });
  });

  it("keeps binding a collected rw directory after a later sync deletes it, so a stale path does not abort a later command", async () => {
    // A sync records a read-write destination, then a later operation removes
    // that path in the sandbox. The store still holds the path, so the wrapper
    // still adds it to the command. `--bind-try` skips a missing source, so the
    // command still runs. This test proves the wrapper uses `--bind-try` (not
    // `--bind`) for the collected path, which stops a stale path from failing
    // every later command for the scope.
    process.env.DAYTONA_API_KEY = "host-key";
    const remoteCwd = "/home/daytona/paperclip-workspace";
    const collectedDir = `${remoteCwd}/scratch`;
    const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), "daytona-bwrap-stale-"));
    const source = path.join(hostDir, "note.txt");
    await fs.writeFile(source, "bytes");
    const sandbox = createMockSandbox();
    mockGet.mockResolvedValue(sandbox);

    const scopeParams = {
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
    };

    await plugin.definition.onEnvironmentSyncIn?.({
      ...scopeParams,
      lease: { providerLeaseId: "sandbox-123", metadata: { remoteCwd } },
      operations: [
        {
          operationId: "sync-op-rw",
          files: [
            {
              sourcePath: source,
              targetPath: `${collectedDir}/note.txt`,
              kind: "file" as const,
              access: "rw" as const,
            },
          ],
        },
      ],
    });
    sandbox.process.executeCommand.mockClear();

    await plugin.definition.onEnvironmentExecute?.({
      ...scopeParams,
      lease: {
        providerLeaseId: "sandbox-123",
        metadata: { remoteCwd, bwrapAvailable: true, sandboxUsername: "daytona" },
      },
      command: "printf",
      args: ["hello"],
      timeoutMs: 1000,
    });

    const [command] = sandbox.process.executeCommand.mock.calls[0] as [string];
    // The stale collected path binds with `--bind-try`, so a missing source is
    // skipped and the command still runs.
    expect(command).toContain(`--bind-try '${collectedDir}' '${collectedDir}'`);
    // No writable directory uses a plain `--bind`, so no stale source can abort.
    expect(command).not.toMatch(/(^| )--bind '/);
    await fs.rm(hostDir, { recursive: true, force: true });
  });

  it("re-binds the stdin path when stdin is present and bwrap is available", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    mockGet.mockResolvedValue(sandbox);

    await plugin.definition.onEnvironmentExecute?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: {
        providerLeaseId: "sandbox-123",
        metadata: {
          remoteCwd: "/home/daytona/paperclip-workspace",
          bwrapAvailable: true,
          sandboxUsername: "daytona",
        },
      },
      command: "cat",
      args: [],
      stdin: "input payload",
      timeoutMs: 1000,
    });

    const stdinPath = sandbox.fs.uploadFile.mock.calls[0][1] as string;
    expect(stdinPath).toMatch(/^\/tmp\/paperclip-stdin-/);
    const [command] = sandbox.process.executeCommand.mock.calls[0] as [string];
    // The `--tmpfs /tmp` flag hides the uploaded stdin file, so the wrapper must
    // re-bind it read-only after the tmpfs.
    expect(command).toContain(`--ro-bind '${stdinPath}' '${stdinPath}'`);
  });

  it("runs the plain command when bwrap is unavailable or username is unknown", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    mockGet.mockResolvedValue(sandbox);

    // Case 1: the probe reported bwrap unavailable.
    await plugin.definition.onEnvironmentExecute?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: {
        providerLeaseId: "sandbox-123",
        metadata: {
          remoteCwd: "/home/daytona/paperclip-workspace",
          bwrapAvailable: false,
          sandboxUsername: "daytona",
        },
      },
      command: "printf",
      args: ["hello"],
      timeoutMs: 1000,
    });
    expect((sandbox.process.executeCommand.mock.calls[0] as [string])[0]).not.toContain("bwrap");

    // Case 2: bwrap is available but the username is unknown. A wrap without a
    // username would run as root inside bwrap and give the agent's files root
    // ownership, so the seam keeps the plain command.
    sandbox.process.executeCommand.mockClear();
    await plugin.definition.onEnvironmentExecute?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: {
        providerLeaseId: "sandbox-123",
        metadata: {
          remoteCwd: "/home/daytona/paperclip-workspace",
          bwrapAvailable: true,
          sandboxUsername: null,
        },
      },
      command: "printf",
      args: ["hello"],
      timeoutMs: 1000,
    });
    expect((sandbox.process.executeCommand.mock.calls[0] as [string])[0]).not.toContain("bwrap");
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

    // Injected clock: getStart=0, getEnd=10 (getDurationMs=10), execStart=20,
    // execEnd/timeout=1520 (durationMs=1500). Deterministic so the timeout path's
    // provider-exec attribution is asserted exactly.
    const ticks = [0, 10, 20, 1520];
    let i = 0;
    const restoreClock = setDaytonaTimingClockForTest(() => ticks[Math.min(i++, ticks.length - 1)]!);

    let result;
    try {
      result = await plugin.definition.onEnvironmentExecute?.({
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
    } finally {
      restoreClock();
    }

    expect(result).toMatchObject({
      exitCode: null,
      timedOut: true,
      stdout: "",
      stderr: "command timed out\n",
    });
    // The exec reached executeCommand before timing out, so its wall-time is
    // preserved as durationMs (provider-exec attribution is not dropped on the
    // timeout path); the getSandbox re-fetch duration is also reported.
    expect(result!.metadata).toMatchObject({ durationMs: 1500, getDurationMs: 10 });
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

  // ─── Exec command shape ────────────────────────────────────────────────────
  // The wrapper sources the login profiles so `node` resolves on the reference
  // image, then runs the command. It no longer sources `nvm.sh`, while every
  // other exec surface (env prefix, cwd, quoting, stdin, durationMs) stays
  // intact.
  it("test_exec_command_preserves_env_cwd_and_duration", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    sandbox.process.executeCommand.mockResolvedValue({
      exitCode: 0,
      result: "ok",
      artifacts: { stdout: "ok" },
    });
    mockGet.mockResolvedValue(sandbox);

    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: { providerLeaseId: "sandbox-123", metadata: {} },
      command: "base64",
      args: ["-d"],
      cwd: "/workspace",
      env: { FOO: "bar" },
      timeoutMs: 1000,
    });

    const [command] = sandbox.process.executeCommand.mock.calls[0] as [string];
    // The command sources the login profiles first, then runs the `cd` and the
    // env prefix with the noninteractive git defaults.
    expect(command).toMatch(/^if \[ -f \/etc\/profile \]/);
    expect(command).toMatch(/&& cd '\/workspace' && env /);
    expect(command).toMatch(/GIT_TERMINAL_PROMPT='0'/);
    expect(command).toMatch(/FOO='bar' 'base64' '-d'$/);
    expect(command).toMatch(/\/etc\/profile/);
    expect(command).not.toMatch(/nvm\.sh/);
    // durationMs attribution stays intact.
    expect(typeof (result!.metadata as Record<string, unknown>)?.durationMs).toBe("number");
  });

  it("test_exec_command_sources_profile_without_nvm", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    mockGet.mockResolvedValue(sandbox);

    // A node-launching exec resolves `node` through the login profiles, which
    // Daytona's non-login `executeCommand` shell does not source on its own. The
    // wrapper sources the profiles but no longer sources `nvm.sh`.
    await plugin.definition.onEnvironmentExecute?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: { providerLeaseId: "sandbox-123", metadata: {} },
      command: "node",
      args: ["--version"],
      cwd: "/workspace",
      timeoutMs: 1000,
    });

    const [command] = sandbox.process.executeCommand.mock.calls[0] as [string];
    expect(command).toMatch(/\/etc\/profile/);
    expect(command).toMatch(/"\$HOME\/\.profile"/);
    expect(command).not.toMatch(/nvm\.sh/);
    expect(command).not.toMatch(/NVM_DIR/);
  });

  // ─── Per-lease started-sandbox handle cache ────────────────────────────────
  // These prove the security conditions: single-fetch-per-lease, strict
  // composite-key isolation (no cross-lease / cross-company / cross-env reuse),
  // eviction at every teardown, no caching of failed populates, single-flight
  // concurrency, and sentinel re-verification on a cached resume — plus that a
  // handle left idle past the provider auto-stop window is refreshed before
  // reuse so a provider-initiated stop is not hidden behind a stale snapshot.
  describe("started-sandbox handle cache", () => {
    function execParams(
      providerLeaseId: string,
      overrides: { companyId?: string; environmentId?: string; driverKey?: string } = {},
    ) {
      return {
        driverKey: overrides.driverKey ?? "daytona",
        companyId: overrides.companyId ?? "company-1",
        environmentId: overrides.environmentId ?? "env-1",
        config: { timeoutMs: 300000, reuseLease: false },
        lease: { providerLeaseId, metadata: {} },
        command: "printf",
        args: ["hi"],
        timeoutMs: 1000,
      };
    }

    it("reuses the cached handle across execs on one lease (single client.get)", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const sandbox = createMockSandbox({ id: "lease-a" });
      mockGet.mockResolvedValue(sandbox);

      await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));

      // Second exec is served from the cache: no second REST re-fetch.
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(sandbox.process.executeCommand).toHaveBeenCalledTimes(2);
    });

    it("keeps getDurationMs present (≈0) on a cache hit", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const sandbox = createMockSandbox({ id: "lease-a" });
      mockGet.mockResolvedValue(sandbox);

      await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      const hit = await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));

      // The observability contract holds even when the fetch is elided.
      expect(typeof (hit!.metadata as Record<string, unknown>)?.getDurationMs).toBe("number");
    });

    it("never serves lease A's handle to lease B (distinct fetch per lease)", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const sandboxA = createMockSandbox({ id: "lease-a" });
      const sandboxB = createMockSandbox({ id: "lease-b" });
      mockGet.mockImplementation(async (id: string) => (id === "lease-a" ? sandboxA : sandboxB));

      await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      await plugin.definition.onEnvironmentExecute?.(execParams("lease-b"));

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(sandboxA.process.executeCommand).toHaveBeenCalledTimes(1);
      expect(sandboxB.process.executeCommand).toHaveBeenCalledTimes(1);
    });

    it("does not share a handle across companies or environments for the same providerLeaseId", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      mockGet.mockImplementation(async () => createMockSandbox({ id: "sandbox-x" }));

      await plugin.definition.onEnvironmentExecute?.(execParams("sandbox-x", { companyId: "company-1", environmentId: "env-1" }));
      await plugin.definition.onEnvironmentExecute?.(execParams("sandbox-x", { companyId: "company-2", environmentId: "env-1" }));
      await plugin.definition.onEnvironmentExecute?.(execParams("sandbox-x", { companyId: "company-1", environmentId: "env-2" }));

      // Three distinct composite keys → three independent fetches; the bare
      // providerLeaseId is never a shared cache slot.
      expect(mockGet).toHaveBeenCalledTimes(3);
    });

    it("rejects a queued execute after release teardown closes the lease", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      mockGet.mockImplementation(async () => createMockSandbox({ id: "lease-a" }));

      await plugin.definition.onEnvironmentExecute?.(execParams("lease-a")); // miss → get #1 (cached)
      const releasePromise = plugin.definition.onEnvironmentReleaseLease?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "lease-a",
        config: { timeoutMs: 300000, reuseLease: false },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const queuedExecute = plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      await expect(queuedExecute).rejects.toThrow(/no longer active/);
      await releasePromise;

      // The tombstone closes the lease, so the queued execute never reacquires
      // the sandbox after teardown.
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it("rejects an overlapping execute after release teardown closes the lease", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const sandbox = createMockSandbox({ id: "lease-a" });
      let stopStarted = false;
      let resolveRelease!: () => void;
      const releaseGate = new Promise<void>((resolve) => {
        resolveRelease = resolve;
      });
      sandbox.stop.mockImplementation(() => {
        stopStarted = true;
        return releaseGate;
      });
      mockGet.mockResolvedValue(sandbox);

      await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      const releasePromise = plugin.definition.onEnvironmentReleaseLease?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "lease-a",
        config: { timeoutMs: 300000, reuseLease: true },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stopStarted).toBe(true);

      const overlappingExec = plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      await expect(overlappingExec).rejects.toThrow(/no longer active/);
      resolveRelease();
      await releasePromise;

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(sandbox.stop).toHaveBeenCalledTimes(1);
      expect(sandbox.process.executeCommand).toHaveBeenCalledTimes(1);
    });

    it("rejects a late execute after the release tombstone is set", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const sandbox = createMockSandbox({ id: "lease-a" });
      let stopStarted = false;
      let resolveRelease!: () => void;
      const releaseGate = new Promise<void>((resolve) => {
        resolveRelease = resolve;
      });
      sandbox.stop.mockImplementation(() => {
        stopStarted = true;
        return releaseGate;
      });
      mockGet.mockResolvedValue(sandbox);

      await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      const releasePromise = plugin.definition.onEnvironmentReleaseLease?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "lease-a",
        config: { timeoutMs: 300000, reuseLease: true },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stopStarted).toBe(true);

      const overlappingExec = plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      await expect(overlappingExec).rejects.toThrow(/no longer active/);

      resolveRelease();
      await releasePromise;

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(sandbox.stop).toHaveBeenCalledTimes(1);
      expect(sandbox.process.executeCommand).toHaveBeenCalledTimes(1);
    });

    it("waits for an in-flight execute before teardown cleanup starts", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const sandbox = createMockSandbox({ id: "lease-a" });
      let resolveExecute!: () => void;
      sandbox.process.executeCommand.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          resolveExecute = resolve;
        });
        return {
          exitCode: 0,
          result: "bash",
          artifacts: { stdout: "bash" },
        };
      });
      mockGet.mockResolvedValue(sandbox);

      const executePromise = plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const releasePromise = plugin.definition.onEnvironmentReleaseLease?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "lease-a",
        config: { timeoutMs: 300000, reuseLease: true },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sandbox.stop).not.toHaveBeenCalled();

      resolveExecute();
      await Promise.all([executePromise, releasePromise]);

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(sandbox.process.executeCommand).toHaveBeenCalledTimes(1);
      expect(sandbox.stop).toHaveBeenCalledTimes(1);
    });

    it("keeps the teardown gate closed until overlapping teardowns both finish", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const sandbox = createMockSandbox({ id: "lease-a" });
      let stopStarted = false;
      let deleteStarted = false;
      let resolveStop!: () => void;
      let resolveDelete!: () => void;
      const stopGate = new Promise<void>((resolve) => {
        resolveStop = resolve;
      });
      const deleteGate = new Promise<void>((resolve) => {
        resolveDelete = resolve;
      });
      sandbox.stop.mockImplementation(() => {
        stopStarted = true;
        return stopGate;
      });
      sandbox.delete.mockImplementation(() => {
        deleteStarted = true;
        return deleteGate;
      });
      mockGet.mockResolvedValue(sandbox);

      await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      const releasePromise = plugin.definition.onEnvironmentReleaseLease?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "lease-a",
        config: { timeoutMs: 300000, reuseLease: true },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stopStarted).toBe(true);

      const destroyPromise = plugin.definition.onEnvironmentDestroyLease?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "lease-a",
        config: { timeoutMs: 300000, reuseLease: true },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(deleteStarted).toBe(true);

      resolveDelete();
      await destroyPromise;

      const overlappingExec = plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      await expect(overlappingExec).rejects.toThrow(/no longer active/);

      resolveStop();
      await releasePromise;

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(sandbox.stop).toHaveBeenCalledTimes(1);
      expect(sandbox.delete).toHaveBeenCalledTimes(1);
      expect(sandbox.process.executeCommand).toHaveBeenCalledTimes(1);
    });

    it("rejects a queued execute after destroy teardown closes the lease", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      mockGet.mockImplementation(async () => createMockSandbox({ id: "lease-a" }));

      await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      const destroyPromise = plugin.definition.onEnvironmentDestroyLease?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "lease-a",
        config: { timeoutMs: 300000, reuseLease: false },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const queuedExecute = plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      await expect(queuedExecute).rejects.toThrow(/no longer active/);
      await destroyPromise;

      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it("rejects a queued execute after interactive cancel closes the lease", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      mockGet.mockImplementation(async () => createMockSandbox({ id: "lease-a" }));

      await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      const cancelPromise = plugin.definition.onEnvironmentCancelInteractiveSetup?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "lease-a",
        config: { timeoutMs: 300000, reuseLease: false },
        reason: "cancelled",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const queuedExecute = plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      await expect(queuedExecute).rejects.toThrow(/no longer active/);
      await cancelPromise;

      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it("waits for an in-flight execute before interactive cancel cleanup starts", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const sandbox = createMockSandbox({ id: "lease-a" });
      let resolveExecute!: () => void;
      sandbox.process.executeCommand.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          resolveExecute = resolve;
        });
        return {
          exitCode: 0,
          result: "bash",
          artifacts: { stdout: "bash" },
        };
      });
      mockGet.mockResolvedValue(sandbox);

      const executePromise = plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const cancelPromise = plugin.definition.onEnvironmentCancelInteractiveSetup?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "lease-a",
        config: { timeoutMs: 300000, reuseLease: false },
        reason: "cancelled",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sandbox.delete).not.toHaveBeenCalled();

      resolveExecute();
      await Promise.all([executePromise, cancelPromise]);

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(sandbox.process.executeCommand).toHaveBeenCalledTimes(1);
      expect(sandbox.delete).toHaveBeenCalledTimes(1);
    });

    it("waits for an in-flight syncIn before interactive cancel cleanup starts", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), "daytona-cancel-sync-"));
      const source = path.join(hostDir, "payload.txt");
      await fs.writeFile(source, "payload");
      const remoteDir = "/home/daytona/paperclip-workspace";

      const sandbox = createMockSandbox({ id: "lease-a" });
      let resolveUpload!: () => void;
      sandbox.fs.uploadFiles.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          resolveUpload = resolve;
        });
      });
      mockGet.mockResolvedValue(sandbox);

      const syncPromise = plugin.definition.onEnvironmentSyncIn?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        config: { timeoutMs: 300000, reuseLease: false },
        lease: { providerLeaseId: "lease-a", metadata: { remoteCwd: remoteDir } },
        operations: [
          {
            operationId: "sync-op-1",
            files: [{ sourcePath: source, targetPath: `${remoteDir}/payload.txt`, kind: "file" }],
          },
        ],
      });
      // Let syncIn register on the activity gate and reach the hung upload.
      await new Promise((resolve) => setTimeout(resolve, 0));

      const cancelPromise = plugin.definition.onEnvironmentCancelInteractiveSetup?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "lease-a",
        config: { timeoutMs: 300000, reuseLease: false },
        reason: "cancelled",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Cancel must drain the active sync before deleting the sandbox out from
      // under it — the same activity-gate contract the execute path relies on.
      expect(sandbox.delete).not.toHaveBeenCalled();

      resolveUpload();
      await Promise.all([syncPromise, cancelPromise]);

      expect(sandbox.fs.uploadFiles).toHaveBeenCalledTimes(1);
      expect(sandbox.delete).toHaveBeenCalledTimes(1);

      await fs.rm(hostDir, { recursive: true, force: true });
    });

    it("rejects a queued execute once interactive cancel tombstones the lease", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const sandbox = createMockSandbox({ id: "lease-a" });
      let resolveFirstExecute!: () => void;
      let cancelResolved = false;
      let queuedExecuteRejected = false;
      sandbox.process.executeCommand.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          resolveFirstExecute = resolve;
        });
        return {
          exitCode: 0,
          result: "bash",
          artifacts: { stdout: "bash" },
        };
      });
      mockGet.mockResolvedValue(sandbox);

      const firstExecutePromise = plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const cancelPromise = plugin.definition.onEnvironmentCancelInteractiveSetup?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "lease-a",
        config: { timeoutMs: 300000, reuseLease: false },
        reason: "cancelled",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const queuedExecutePromise = plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      queuedExecutePromise?.catch(() => {
        queuedExecuteRejected = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(sandbox.delete).not.toHaveBeenCalled();

      resolveFirstExecute();
      await cancelPromise.then(() => {
        cancelResolved = true;
      });
      await expect(queuedExecutePromise).rejects.toThrow(/no longer active/);
      await firstExecutePromise;

      expect(cancelResolved).toBe(true);
      expect(queuedExecuteRejected).toBe(true);
      expect(sandbox.process.executeCommand).toHaveBeenCalledTimes(1);
      expect(sandbox.delete).toHaveBeenCalledTimes(1);
    });

    it("waits for an in-flight snapshot capture before destroy cleanup starts", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const sandbox = createMockSandbox({ id: "lease-a" });
      let resolveSnapshot!: () => void;
      sandbox._experimental_createSnapshot.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          resolveSnapshot = resolve;
        });
      });
      mockGet.mockResolvedValue(sandbox);

      const capturePromise = plugin.definition.onEnvironmentCaptureTemplate?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "lease-a",
        config: { timeoutMs: 300000, reuseLease: false },
        templateLabel: "snapshot-check",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const destroyPromise = plugin.definition.onEnvironmentDestroyLease?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "lease-a",
        config: { timeoutMs: 300000, reuseLease: false },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sandbox.delete).not.toHaveBeenCalled();

      resolveSnapshot();
      await Promise.all([capturePromise, destroyPromise]);

      expect(sandbox._experimental_createSnapshot).toHaveBeenCalledTimes(1);
      expect(sandbox.delete).toHaveBeenCalledTimes(1);
    });

    it("does not cache a failed populate (NotFound) — the next lookup re-fetches", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const sandbox = createMockSandbox({ id: "lease-a" });
      mockGet
        .mockRejectedValueOnce(new MockDaytonaNotFoundError("missing"))
        .mockResolvedValue(sandbox);

      const first = await plugin.definition.onEnvironmentResumeLease?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "lease-a",
        config: { timeoutMs: 300000, reuseLease: true },
      });
      expect(first).toEqual({ providerLeaseId: null, metadata: { expired: true } });

      // The rejected populate must not linger; the exec re-fetches successfully.
      await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it("single-flights concurrent misses on one lease into a single client.get", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const sandbox = createMockSandbox({ id: "lease-a" });
      let resolveGet: ((value: unknown) => void) | undefined;
      mockGet.mockImplementation(
        () => new Promise((resolve) => { resolveGet = resolve; }),
      );

      const p1 = plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      const p2 = plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      // Let both execs reach the shared in-flight populate before it resolves.
      await Promise.resolve();
      resolveGet?.(sandbox);
      await Promise.all([p1, p2]);

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(sandbox.process.executeCommand).toHaveBeenCalledTimes(2);
    });

    it("keeps concurrent different-lease populates isolated (no promise crossing)", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const sandboxA = createMockSandbox({ id: "lease-a" });
      const sandboxB = createMockSandbox({ id: "lease-b" });
      mockGet.mockImplementation(async (id: string) => (id === "lease-a" ? sandboxA : sandboxB));

      await Promise.all([
        plugin.definition.onEnvironmentExecute?.(execParams("lease-a")),
        plugin.definition.onEnvironmentExecute?.(execParams("lease-b")),
      ]);

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(mockGet).toHaveBeenCalledWith("lease-a");
      expect(mockGet).toHaveBeenCalledWith("lease-b");
      // Each lease executed in its OWN sandbox, never the other's handle.
      expect(sandboxA.process.executeCommand).toHaveBeenCalledTimes(1);
      expect(sandboxB.process.executeCommand).toHaveBeenCalledTimes(1);
    });

    it("re-verifies the workspace sentinel on a cached resume and evicts on mismatch", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const sandbox = createMockSandbox({ id: "lease-a", state: "started" });
      // Every executeCommand (exec body + sentinel `cat`) returns a NON-matching token.
      sandbox.process.executeCommand.mockResolvedValue({
        exitCode: 0,
        result: JSON.stringify({ token: "other-token" }),
        artifacts: { stdout: JSON.stringify({ token: "other-token" }) },
      });
      mockGet.mockImplementation(async () => sandbox);

      // Prime the cache with a successful exec on this lease.
      await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      expect(mockGet).toHaveBeenCalledTimes(1);
      const sentinelCallsBefore = sandbox.process.executeCommand.mock.calls.length;

      // Resume hits the cache but MUST still verify the sentinel; mismatch expires.
      const resumed = await plugin.definition.onEnvironmentResumeLease?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "lease-a",
        config: { timeoutMs: 300000, reuseLease: true },
        leaseMetadata: {
          workspaceSentinel: {
            path: "/home/daytona/paperclip-workspace/.paperclip-runtime/reusable-sandbox-lease.json",
            token: "expected-token",
            result: "written",
          },
        },
      });
      expect(resumed).toMatchObject({
        providerLeaseId: null,
        metadata: { expired: true, workspaceSentinel: { result: "mismatch" } },
      });
      // The sentinel `cat` ran on the cached handle — verification was not skipped.
      expect(sandbox.process.executeCommand.mock.calls.length).toBeGreaterThan(sentinelCallsBefore);

      // The mismatched entry was evicted, so the next exec re-fetches.
      await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it("refreshes a handle left idle past the auto-stop window and restarts a provider-stopped sandbox", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const sandbox = createMockSandbox({ id: "lease-a", state: "started" });
      // Daytona auto-stopped the sandbox while our cached handle sat idle: a live
      // refresh reveals the true "stopped" state that the cached snapshot hid.
      sandbox.refreshData.mockImplementation(async () => {
        sandbox.state = "stopped";
      });
      mockGet.mockResolvedValue(sandbox);

      let nowMs = 1_000_000;
      const restoreFreshness = setDaytonaHandleFreshnessClockForTest(() => nowMs);
      try {
        // Prime the cache (single fetch, snapshot "started").
        await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
        expect(sandbox.refreshData).not.toHaveBeenCalled();
        expect(sandbox.start).not.toHaveBeenCalled();

        // Idle past half of the default 15-min auto-stop interval (> 7.5 min).
        nowMs += 8 * 60_000;
        await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      } finally {
        restoreFreshness();
      }

      // The stale handle was refreshed in place (no second REST fetch — the same
      // authenticated handle), the refresh exposed the stopped state, and the
      // sandbox was restarted before the exec instead of running against a
      // stopped sandbox.
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(sandbox.refreshData).toHaveBeenCalledTimes(1);
      expect(sandbox.start).toHaveBeenCalledTimes(1);
      expect(sandbox.process.executeCommand).toHaveBeenCalledTimes(2);
    });

    it("does not refresh a handle reused within the auto-stop window", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const sandbox = createMockSandbox({ id: "lease-a" });
      mockGet.mockResolvedValue(sandbox);

      let nowMs = 5_000_000;
      const restoreFreshness = setDaytonaHandleFreshnessClockForTest(() => nowMs);
      try {
        await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
        // Two more execs, each 6 min after the previous — always inside the
        // 7.5-min window measured from the last reuse.
        nowMs += 6 * 60_000;
        await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
        nowMs += 6 * 60_000;
        await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      } finally {
        restoreFreshness();
      }

      // Each reuse resets the freshness marker (an operation follows, resetting
      // the provider idle clock), so an actively-used lease never pays a refresh.
      expect(sandbox.refreshData).not.toHaveBeenCalled();
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it("does not advance freshness when an execute fails before succeeding", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const sandbox = createMockSandbox({ id: "lease-a" });
      sandbox.process.executeCommand
        .mockRejectedValueOnce(new Error("command failed"))
        .mockResolvedValue({
          exitCode: 0,
          result: "bash",
          artifacts: { stdout: "bash" },
        });
      mockGet.mockResolvedValue(sandbox);

      let nowMs = 7_000_000;
      const restoreFreshness = setDaytonaHandleFreshnessClockForTest(() => nowMs);
      try {
        await expect(plugin.definition.onEnvironmentExecute?.(execParams("lease-a"))).rejects.toThrow(
          "command failed",
        );
        nowMs += 8 * 60_000;
        await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      } finally {
        restoreFreshness();
      }

      expect(sandbox.refreshData).toHaveBeenCalledTimes(1);
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(sandbox.process.executeCommand).toHaveBeenCalledTimes(2);
    });

    it("does not advance freshness when an execute times out before succeeding", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const sandbox = createMockSandbox({ id: "lease-a" });
      sandbox.process.executeCommand
        .mockRejectedValueOnce(new MockDaytonaTimeoutError("timed out"))
        .mockResolvedValue({
          exitCode: 0,
          result: "bash",
          artifacts: { stdout: "bash" },
        });
      mockGet.mockResolvedValue(sandbox);

      let nowMs = 8_000_000;
      const restoreFreshness = setDaytonaHandleFreshnessClockForTest(() => nowMs);
      try {
        const first = await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
        expect(first).toMatchObject({ timedOut: true, exitCode: null });
        nowMs += 8 * 60_000;
        await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      } finally {
        restoreFreshness();
      }

      expect(sandbox.refreshData).toHaveBeenCalledTimes(1);
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(sandbox.process.executeCommand).toHaveBeenCalledTimes(2);
    });

    it("never refreshes when auto-stop is disabled, even after a long idle gap", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const sandbox = createMockSandbox({ id: "lease-a" });
      mockGet.mockResolvedValue(sandbox);
      const disabledAutoStop = { timeoutMs: 300000, reuseLease: false, autoStopInterval: 0 };

      let nowMs = 2_000_000;
      const restoreFreshness = setDaytonaHandleFreshnessClockForTest(() => nowMs);
      try {
        await plugin.definition.onEnvironmentExecute?.({ ...execParams("lease-a"), config: disabledAutoStop });
        nowMs += 60 * 60_000; // an hour idle
        await plugin.definition.onEnvironmentExecute?.({ ...execParams("lease-a"), config: disabledAutoStop });
      } finally {
        restoreFreshness();
      }

      // Auto-stop off → the provider never stops the sandbox out from under the
      // handle, so the cached started snapshot is trusted without a refresh.
      expect(sandbox.refreshData).not.toHaveBeenCalled();
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it("evicts the handle when a freshness refresh fails so the next lookup re-fetches", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const first = createMockSandbox({ id: "lease-a" });
      first.refreshData.mockRejectedValue(new MockDaytonaNotFoundError("sandbox vanished"));
      const second = createMockSandbox({ id: "lease-a" });
      mockGet.mockResolvedValueOnce(first).mockResolvedValue(second);

      let nowMs = 3_000_000;
      const restoreFreshness = setDaytonaHandleFreshnessClockForTest(() => nowMs);
      try {
        await plugin.definition.onEnvironmentExecute?.(execParams("lease-a")); // fetch #1 → first
        nowMs += 8 * 60_000; // idle past the refresh window
        // The refresh rejects; execute surfaces it (fail closed) and the bad
        // entry is evicted.
        await expect(
          plugin.definition.onEnvironmentExecute?.(execParams("lease-a")),
        ).rejects.toThrow("sandbox vanished");
        // Evicted → the following exec re-fetches a fresh handle.
        await plugin.definition.onEnvironmentExecute?.(execParams("lease-a"));
      } finally {
        restoreFreshness();
      }

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(second.process.executeCommand).toHaveBeenCalledTimes(1);
    });

    it("realizes the workspace from the acquire-seeded handle without a client.get", async () => {
      process.env.DAYTONA_API_KEY = "host-key";
      const sandbox = createMockSandbox({ id: "sandbox-seed" });
      mockCreate.mockResolvedValue(sandbox);

      const base = { driverKey: "daytona", companyId: "company-1", environmentId: "env-1" };
      const config = { image: "node:20", timeoutMs: 300000, reuseLease: false };

      const lease = await plugin.definition.onEnvironmentAcquireLease?.({
        ...base,
        runId: "run-1",
        config,
      });
      expect(lease?.providerLeaseId).toBe("sandbox-seed");

      const realize = await plugin.definition.onEnvironmentRealizeWorkspace?.({
        ...base,
        lease: { providerLeaseId: lease!.providerLeaseId, metadata: lease!.metadata },
        workspace: { remotePath: "/home/daytona/paperclip-workspace" },
        config,
      });

      // Acquire seeded the handle under the exact scope realize reads, so realize
      // reuses it and never pays a real REST re-fetch.
      expect(mockGet).not.toHaveBeenCalled();
      expect(sandbox.fs.createFolder).toHaveBeenCalledWith("/home/daytona/paperclip-workspace", "755");
      expect(realize?.cwd).toBe("/home/daytona/paperclip-workspace");
    });
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
    mockGet.mockReset();
    process.env.DAYTONA_API_KEY = "host-key";
    __resetDaytonaSandboxHandleCacheForTest();
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("declares both sync hooks so the worker advertises the native transport", () => {
    expect(plugin.definition.onEnvironmentSyncIn).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentSyncOut).toBeTypeOf("function");
  });

  it("records the writablePath destination of a staging-tar rw mapping, not the staging parent", async () => {
    const hostDir = await makeHostDir();
    const source = path.join(hostDir, "workspace.tar");
    await fs.writeFile(source, "bytes");

    const sandbox = createMockSandbox();
    mockGet.mockResolvedValue(sandbox);

    const params = {
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: syncLease(),
      operations: [
        {
          operationId: "sync-op-rw",
          files: [
            {
              // The mapping uploads a staging tar under the runtime root, and a
              // post-upload command extracts it into the workspace directory. So
              // `writablePath` names the real read-write destination.
              sourcePath: source,
              targetPath: `${REMOTE_DIR}/.paperclip-runtime/workspace-upload.tar`,
              kind: "file" as const,
              access: "rw" as const,
              writablePath: REMOTE_DIR,
            },
          ],
        },
      ],
    };
    await plugin.definition.onEnvironmentSyncIn?.(params);

    // The set holds the extract destination, not the staging archive parent.
    const recorded = __getDaytonaWritableDirsForTest(params);
    expect(recorded).toContain(REMOTE_DIR);
    expect(recorded).not.toContain(`${REMOTE_DIR}/.paperclip-runtime`);
  });

  it("falls back to the parent directory of an rw mapping with no writablePath", async () => {
    const hostDir = await makeHostDir();
    const source = path.join(hostDir, "in-place.txt");
    await fs.writeFile(source, "bytes");

    const sandbox = createMockSandbox();
    mockGet.mockResolvedValue(sandbox);

    const params = {
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: syncLease(),
      operations: [
        {
          operationId: "sync-op-rw-inplace",
          files: [
            {
              // No post-upload extract, so the mapping writes `targetPath` in
              // place and the parent directory is the read-write destination.
              sourcePath: source,
              targetPath: `${REMOTE_DIR}/data/in-place.txt`,
              kind: "file" as const,
              access: "rw" as const,
            },
          ],
        },
      ],
    };
    await plugin.definition.onEnvironmentSyncIn?.(params);

    expect(__getDaytonaWritableDirsForTest(params)).toContain(`${REMOTE_DIR}/data`);
  });

  it("skips ro and access-absent sync targets in the advisory writable set", async () => {
    const hostDir = await makeHostDir();
    const roSource = path.join(hostDir, "referenced");
    const defaultSource = path.join(hostDir, "default.tar");
    await fs.mkdir(roSource, { recursive: true });
    await fs.writeFile(path.join(roSource, "notes.md"), "reference");
    await fs.writeFile(defaultSource, "bytes");

    const sandbox = createMockSandbox();
    mockGet.mockResolvedValue(sandbox);

    const params = {
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: syncLease(),
      operations: [
        {
          operationId: "sync-op-ro",
          files: [
            {
              sourcePath: roSource,
              targetPath: `${REMOTE_DIR}/.paperclip-runtime/project-proj-first`,
              kind: "directory" as const,
              access: "ro" as const,
            },
            {
              // An absent `access` defaults to read-only, so it is not recorded.
              sourcePath: defaultSource,
              targetPath: `${REMOTE_DIR}/.paperclip-runtime/default-upload.tar`,
              kind: "file" as const,
            },
          ],
        },
      ],
    };
    await plugin.definition.onEnvironmentSyncIn?.(params);

    // Neither the ro directory nor the access-absent file directory is recorded.
    expect(__getDaytonaWritableDirsForTest(params)).toEqual([]);
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

  // A recording tracer that captures every provider span the file sync opens.
  // It satisfies the structural plugin tracer contract.
  function createRecordingPluginTracer() {
    const spans: Array<{
      name: string;
      attributes: Record<string, unknown>;
      status: { code: number; message?: string } | null;
      ended: boolean;
    }> = [];
    const tracer = {
      startSpan(name: string, options?: { attributes?: Record<string, string | number | boolean> }) {
        const span = {
          name,
          attributes: { ...(options?.attributes ?? {}) } as Record<string, unknown>,
          status: null as { code: number; message?: string } | null,
          ended: false,
          setAttribute(key: string, value: unknown) {
            span.attributes[key] = value;
          },
          setStatus(status: { code: number; message?: string }) {
            span.status = status;
          },
          end() {
            span.ended = true;
          },
        };
        spans.push(span);
        return span;
      },
    };
    return { tracer, spans };
  }

  it("opens a transfer span with the guard round-trip count around the bulk file upload", async () => {
    const hostDir = await makeHostDir();
    const source = path.join(hostDir, "config.txt");
    await fs.writeFile(source, "plain");
    const sandbox = createMockSandbox();
    mockGet.mockResolvedValue(sandbox);

    const { tracer, spans } = createRecordingPluginTracer();
    const restore = __setDaytonaPluginContextForTest({ tracer } as unknown as PluginContext);
    try {
      await plugin.definition.onEnvironmentSyncIn?.({
        driverKey: "daytona",
        companyId: "company-1",
        environmentId: "env-1",
        config: { timeoutMs: 300000, reuseLease: false },
        lease: syncLease(),
        operations: [
          {
            operationId: "sync-op-1",
            files: [{ sourcePath: source, targetPath: `${REMOTE_DIR}/config.txt`, kind: "file" }],
          },
        ],
      });
    } finally {
      restore();
    }

    const transfer = spans.find((span) => span.name === "transfer");
    expect(transfer).toBeDefined();
    expect(transfer!.ended).toBe(true);
    // The two serial guard round trips before the transfer: mkdir + confinement.
    expect(transfer!.attributes["paperclip.sandbox.startup.transfer.guard.count"]).toBe(2);
    expect(transfer!.attributes["paperclip.sandbox.startup.provider"]).toBe("daytona");
    expect(typeof transfer!.attributes["paperclip.sandbox.startup.transfer.wall_ms"]).toBe("number");
    // A bulk file upload builds no host tarball, so it opens no pack span.
    expect(spans.find((span) => span.name === "pack")).toBeUndefined();
  });

  it("opens a pack span and a transfer span around a directory mapping sync", async () => {
    const hostDir = await makeHostDir();
    const sourceDir = path.join(hostDir, "assets");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "a.txt"), "alpha");
    const sandbox = createMockSandbox();
    mockGet.mockResolvedValue(sandbox);

    const { tracer, spans } = createRecordingPluginTracer();
    const restore = __setDaytonaPluginContextForTest({ tracer } as unknown as PluginContext);
    try {
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
              { sourcePath: sourceDir, targetPath: `${REMOTE_DIR}/.paperclip-runtime/assets`, kind: "directory" },
            ],
          },
        ],
      });
    } finally {
      restore();
    }

    const pack = spans.find((span) => span.name === "pack");
    expect(pack).toBeDefined();
    expect(pack!.ended).toBe(true);
    expect(typeof pack!.attributes["paperclip.sandbox.startup.pack.wall_ms"]).toBe("number");

    const transfer = spans.find((span) => span.name === "transfer");
    expect(transfer).toBeDefined();
    expect(transfer!.attributes["paperclip.sandbox.startup.transfer.guard.count"]).toBe(2);
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

  // -------------------------------------------------------------------------
  // Post-upload commands (Phase 3 / Security Conditions C1–C4). Daytona runs an
  // operation's ordered `postUploadCommands` in-sandbox AFTER `uploadFiles`,
  // fail-fast, with the command `cwd` re-confined under the workspace remote dir.
  // -------------------------------------------------------------------------

  it("runs post-upload commands in array order AFTER uploadFiles, each verbatim via the exec seam", async () => {
    const hostDir = await makeHostDir();
    const source = path.join(hostDir, "config.txt");
    await fs.writeFile(source, "plain");

    const sandbox = createMockSandbox();
    mockGet.mockResolvedValue(sandbox);

    await plugin.definition.onEnvironmentSyncIn?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: syncLease(),
      operations: [
        {
          operationId: "op-cmd",
          files: [{ sourcePath: source, targetPath: `${REMOTE_DIR}/config.txt`, kind: "file" }],
          postUploadCommands: [
            { command: "codex-auth-merge --first" },
            { command: "chmod 600 config.txt" },
          ],
        },
      ],
    });

    // Both commands ran, VERBATIM (first arg is the exact authored string — the
    // provider never rewrote/concatenated a shell fragment onto it: C1/C3).
    const findCall = (cmd: string) =>
      sandbox.process.executeCommand.mock.calls.find(([c]: [string]) => c === cmd);
    expect(findCall("codex-auth-merge --first")).toBeDefined();
    expect(findCall("chmod 600 config.txt")).toBeDefined();

    // Ordered: the first command's exec precedes the second's (C4 array order).
    const orderOf = (cmd: string) => {
      const idx = sandbox.process.executeCommand.mock.calls.findIndex(([c]: [string]) => c === cmd);
      return sandbox.process.executeCommand.mock.invocationCallOrder[idx];
    };
    expect(orderOf("codex-auth-merge --first")).toBeLessThan(orderOf("chmod 600 config.txt"));

    // Upload happened BEFORE the first command.
    expect(sandbox.fs.uploadFiles.mock.invocationCallOrder[0]).toBeLessThan(
      orderOf("codex-auth-merge --first"),
    );

    // Absent `cwd` defaults to the provider-resolved remote dir — never a process
    // default cwd (C2). The command's structured cwd argument is REMOTE_DIR.
    expect(findCall("codex-auth-merge --first")?.[1]).toBe(REMOTE_DIR);
  });

  it("aborts the operation fail-loud on a non-zero post-upload command exit, skipping the remainder (C4)", async () => {
    const hostDir = await makeHostDir();
    const source = path.join(hostDir, "config.txt");
    await fs.writeFile(source, "plain");

    const sandbox = createMockSandbox();
    // The first command exits non-zero; every transfer/guard script stays green.
    sandbox.process.executeCommand.mockImplementation(async (command: string) => {
      if (command === "failing-command") {
        return { exitCode: 7, result: "boom", artifacts: { stdout: "boom" } };
      }
      return { exitCode: 0, result: "", artifacts: { stdout: "" } };
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
            operationId: "op-fail",
            files: [{ sourcePath: source, targetPath: `${REMOTE_DIR}/config.txt`, kind: "file" }],
            postUploadCommands: [{ command: "failing-command" }, { command: "should-not-run" }],
          },
        ],
      }),
    ).rejects.toThrow(/post-upload command failed \(exit 7\)/);

    // Fail-fast: the command after the failing one never executed.
    expect(
      sandbox.process.executeCommand.mock.calls.some(([c]: [string]) => c === "should-not-run"),
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Merged git-workspace operation. A git-backed workspace stage-sync rides ONE
  // operation whose `files` carry the git-history tar and the workspace-overlay
  // tar, with the two extract commands as ordered `postUploadCommands`. The
  // operation shares one mkdir, one confine guard, one `uploadFiles`, and one
  // rename exec.
  // -------------------------------------------------------------------------

  it("stages a merged git-workspace operation as one uploadFiles batch and one rename exec, both extracts in order", async () => {
    const hostDir = await makeHostDir();
    const gitTar = path.join(hostDir, "git-workspace.tar");
    const overlayTar = path.join(hostDir, "workspace.tar");
    await fs.writeFile(gitTar, "git-bytes");
    await fs.writeFile(overlayTar, "overlay-bytes");
    const runtimeDir = `${REMOTE_DIR}/.paperclip-runtime/adapter`;

    const sandbox = createMockSandbox();
    mockGet.mockResolvedValue(sandbox);

    const gitExtract = "git-history-extract";
    const overlayExtract = "workspace-overlay-extract";
    const result = await plugin.definition.onEnvironmentSyncIn?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: syncLease(),
      operations: [
        {
          operationId: "merged-workspace",
          files: [
            { sourcePath: gitTar, targetPath: `${runtimeDir}/git-workspace-upload.tar`, kind: "file" },
            { sourcePath: overlayTar, targetPath: `${runtimeDir}/workspace-upload.tar`, kind: "file" },
          ],
          postUploadCommands: [{ command: gitExtract }, { command: overlayExtract }],
        },
      ],
    });

    // One bulk upload carries BOTH tars; one rename exec promotes both temps.
    expect(sandbox.fs.uploadFiles).toHaveBeenCalledTimes(1);
    const [uploads] = sandbox.fs.uploadFiles.mock.calls[0] as [Array<{ source: string; destination: string }>];
    expect(uploads).toHaveLength(2);
    const mvCalls = sandbox.process.executeCommand.mock.calls.filter(([cmd]: [string]) =>
      String(cmd).includes("mv -f"),
    );
    expect(mvCalls).toHaveLength(1);
    expect(String(mvCalls[0][0]).match(/mv -f /g)).toHaveLength(2);

    // Both extract commands ran, in array order, AFTER the upload (git first).
    const orderOf = (cmd: string) => {
      const idx = sandbox.process.executeCommand.mock.calls.findIndex(([c]: [string]) => c === cmd);
      return sandbox.process.executeCommand.mock.invocationCallOrder[idx];
    };
    expect(orderOf(gitExtract)).toBeLessThan(orderOf(overlayExtract));
    expect(sandbox.fs.uploadFiles.mock.invocationCallOrder[0]).toBeLessThan(orderOf(gitExtract));

    expect(result).toEqual({
      operations: [{
        operationId: "merged-workspace",
        filesTransferred: 2,
        bytesTransferred: "git-bytes".length + "overlay-bytes".length,
      }],
    });
  });

  it("rejects a merged operation when either tar mapping target escapes the remote dir, before uploading", async () => {
    const hostDir = await makeHostDir();
    const gitTar = path.join(hostDir, "git-workspace.tar");
    const overlayTar = path.join(hostDir, "workspace.tar");
    await fs.writeFile(gitTar, "git-bytes");
    await fs.writeFile(overlayTar, "overlay-bytes");
    const runtimeDir = `${REMOTE_DIR}/.paperclip-runtime/adapter`;

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
            operationId: "merged-escape",
            files: [
              { sourcePath: gitTar, targetPath: `${runtimeDir}/git-workspace-upload.tar`, kind: "file" },
              // The overlay mapping target escapes the workspace remote dir.
              { sourcePath: overlayTar, targetPath: `${REMOTE_DIR}/../../etc/workspace-upload.tar`, kind: "file" },
            ],
            postUploadCommands: [{ command: "git-history-extract" }, { command: "workspace-overlay-extract" }],
          },
        ],
      }),
    ).rejects.toThrow(/escapes the workspace remote dir|not a confined absolute path/);

    // Neither tar uploaded: the confine check on the escaping mapping trips first.
    expect(sandbox.fs.uploadFiles).not.toHaveBeenCalled();
  });

  it("stops the overlay and remove-deleted commands when the git extract fails (merged operation fail-fast)", async () => {
    const hostDir = await makeHostDir();
    const gitTar = path.join(hostDir, "git-workspace.tar");
    const overlayTar = path.join(hostDir, "workspace.tar");
    await fs.writeFile(gitTar, "git-bytes");
    await fs.writeFile(overlayTar, "overlay-bytes");
    const runtimeDir = `${REMOTE_DIR}/.paperclip-runtime/adapter`;

    const sandbox = createMockSandbox();
    // The first (git-history) extract exits non-zero; every transfer/guard script
    // stays green so the fail-fast loop is the only thing that can trip this test.
    sandbox.process.executeCommand.mockImplementation(async (command: string) => {
      if (command === "git-history-extract") {
        return { exitCode: 5, result: "boom", artifacts: { stdout: "boom" } };
      }
      return { exitCode: 0, result: "", artifacts: { stdout: "" } };
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
            operationId: "merged-failfast",
            files: [
              { sourcePath: gitTar, targetPath: `${runtimeDir}/git-workspace-upload.tar`, kind: "file" },
              { sourcePath: overlayTar, targetPath: `${runtimeDir}/workspace-upload.tar`, kind: "file" },
            ],
            postUploadCommands: [
              { command: "git-history-extract" },
              { command: "workspace-overlay-extract" },
              { command: "remove-deleted-paths" },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/post-upload command failed \(exit 5\)/);

    // Fail-fast: the overlay extract and the remove-deleted command never ran.
    const ran = (cmd: string) =>
      sandbox.process.executeCommand.mock.calls.some(([c]: [string]) => c === cmd);
    expect(ran("git-history-extract")).toBe(true);
    expect(ran("workspace-overlay-extract")).toBe(false);
    expect(ran("remove-deleted-paths")).toBe(false);
  });

  it("rejects a post-upload command cwd that escapes the remote dir lexically, before any exec (C2)", async () => {
    const hostDir = await makeHostDir();
    const source = path.join(hostDir, "config.txt");
    await fs.writeFile(source, "plain");

    for (const badCwd of [`${REMOTE_DIR}/../etc`, "/etc"]) {
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
              operationId: "op-escape",
              files: [{ sourcePath: source, targetPath: `${REMOTE_DIR}/config.txt`, kind: "file" }],
              postUploadCommands: [{ command: "run-me", cwd: badCwd }],
            },
          ],
        }),
      ).rejects.toThrow(/not a confined absolute path|escapes the workspace remote dir/);
      // The command never ran — lexical confinement rejected it before exec.
      expect(sandbox.process.executeCommand.mock.calls.some(([c]: [string]) => c === "run-me")).toBe(
        false,
      );
    }
  });

  it("rejects a post-upload command whose cwd resolves outside the root via a symlink (realpath guard, C2)", async () => {
    const hostDir = await makeHostDir();
    const source = path.join(hostDir, "config.txt");
    await fs.writeFile(source, "plain");

    const cwd = `${REMOTE_DIR}/link`;
    const sandbox = createMockSandbox();
    // The in-sandbox realpath symlink-escape guard for THIS cwd fails closed (exit
    // 42), simulating a sandbox-planted symlink that resolves out of root.
    sandbox.process.executeCommand.mockImplementation(async (command: string) => {
      if (command.includes("_pc_resolve") && command.includes(cwd)) {
        return { exitCode: 42, result: "ESCAPE", artifacts: { stdout: "ESCAPE" } };
      }
      return { exitCode: 0, result: "", artifacts: { stdout: "" } };
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
            operationId: "op-symlink",
            files: [{ sourcePath: source, targetPath: `${REMOTE_DIR}/config.txt`, kind: "file" }],
            postUploadCommands: [{ command: "run-me", cwd }],
          },
        ],
      }),
    ).rejects.toThrow(/symlink-escape guard|command failed/i);
    expect(sandbox.process.executeCommand.mock.calls.some(([c]: [string]) => c === "run-me")).toBe(
      false,
    );
  });

  it("issues no extra exec when an operation has no post-upload commands (backward-compat)", async () => {
    const hostDir = await makeHostDir();
    const source = path.join(hostDir, "config.txt");
    await fs.writeFile(source, "plain");

    const baseline = createMockSandbox();
    mockGet.mockResolvedValue(baseline);
    await plugin.definition.onEnvironmentSyncIn?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: syncLease(),
      operations: [
        { operationId: "op-plain", files: [{ sourcePath: source, targetPath: `${REMOTE_DIR}/config.txt`, kind: "file" }] },
      ],
    });
    const baselineExecCount = baseline.process.executeCommand.mock.calls.length;

    // Same operation, now with an (empty) postUploadCommands array — must be
    // byte-identical: an absent/empty command list adds zero execs.
    // Reset the process-scoped handle cache so the second operation fetches its
    // own `withEmpty` handle. Both operations reuse the same providerLeaseId, so
    // without this reset the cache serves the first `baseline` handle again and
    // `withEmpty` records zero execs.
    __resetDaytonaSandboxHandleCacheForTest();
    const withEmpty = createMockSandbox();
    mockGet.mockResolvedValue(withEmpty);
    await plugin.definition.onEnvironmentSyncIn?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: syncLease(),
      operations: [
        {
          operationId: "op-plain",
          files: [{ sourcePath: source, targetPath: `${REMOTE_DIR}/config.txt`, kind: "file" }],
          postUploadCommands: [],
        },
      ],
    });
    expect(withEmpty.process.executeCommand.mock.calls.length).toBe(baselineExecCount);
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

describe("buildBwrapCommand advisory wrapper builder", () => {
  it("uses su to drop to sandbox user without --unshare-user", () => {
    const command = buildBwrapCommand(
      "echo hi",
      ["/home/daytona/paperclip-workspace"],
      null,
      "daytona",
    );

    expect(command).toBe(
      "sudo -n bwrap "
      + "--ro-bind / / --dev /dev --proc /proc --tmpfs /tmp "
      + "--bind-try '/home/daytona/paperclip-workspace' '/home/daytona/paperclip-workspace' "
      + "--new-session -- su -s /bin/sh 'daytona' -c 'echo hi'",
    );
    expect(command).not.toContain("--unshare-user");
    expect(command).not.toContain("--uid");
    expect(command).not.toContain("--gid");
  });

  it("re-binds the stdin path after tmpfs /tmp", () => {
    const command = buildBwrapCommand(
      "run-cmd",
      ["/work"],
      "/tmp/stdin.bin",
      "daytona",
    );

    expect(command).toBe(
      "sudo -n bwrap "
      + "--ro-bind / / --dev /dev --proc /proc --tmpfs /tmp "
      + "--bind-try '/work' '/work' "
      + "--ro-bind '/tmp/stdin.bin' '/tmp/stdin.bin' "
      + "--new-session -- su -s /bin/sh 'daytona' -c 'run-cmd'",
    );
    // The stdin re-bind must come after the tmpfs, so the tmpfs does not hide it.
    expect(command.indexOf("--ro-bind '/tmp/stdin.bin'")).toBeGreaterThan(command.indexOf("--tmpfs /tmp"));
  });

  it("quotes writable paths and inner script with single quotes", () => {
    const command = buildBwrapCommand(
      "echo 'hello'",
      ["/data/o'brien"],
      null,
      "daytona",
    );

    // shellQuote rewrites each embedded single quote as the `'"'"'` token.
    expect(command).toContain(`'"'"'`);
    expect(command).toContain(`--bind-try '/data/o'"'"'brien' '/data/o'"'"'brien'`);
    expect(command).toContain(`-c 'echo '"'"'hello'"'"''`);
  });

  it("falls back to sh -c when no username is given", () => {
    const command = buildBwrapCommand("plain", ["/w"], null, null);

    expect(command).toBe(
      "sudo -n bwrap "
      + "--ro-bind / / --dev /dev --proc /proc --tmpfs /tmp "
      + "--bind-try '/w' '/w' "
      + "--new-session -- sh -c 'plain'",
    );
    expect(command).not.toContain("--unshare-user");
    expect(command).not.toContain("su -s");
  });

  it("binds each writable directory with --bind-try so a stale or deleted path does not abort bwrap", () => {
    // The writable set holds advisory sandbox paths. A later sync can delete or
    // replace one. `--bind` aborts when the source is absent; `--bind-try` skips
    // a missing source and runs the command. Assert the builder emits
    // `--bind-try` for every writable directory and never a plain `--bind` for
    // them, so one stale path never poisons a later command.
    const command = buildBwrapCommand(
      "echo hi",
      ["/home/daytona/paperclip-workspace", "/home/daytona/data"],
      null,
      "daytona",
    );

    expect(command).toContain(
      "--bind-try '/home/daytona/paperclip-workspace' '/home/daytona/paperclip-workspace'",
    );
    expect(command).toContain("--bind-try '/home/daytona/data' '/home/daytona/data'");
    // The only plain `--bind` family in the command is the read-only bind
    // (`--ro-bind`). No writable directory uses a plain `--bind`.
    expect(command).not.toMatch(/(^| )--bind '/);
  });
});

describe("advisory bwrap capability probe at lease time", () => {
  // Route each probed command to a deterministic result so the hook exercises
  // the real end-to-end path: shell detect, bwrap capability, and username read.
  function bwrapExecMock(opts: {
    bwrapExit?: number;
    username?: string;
    usernameExit?: number;
    sentinelToken?: string;
  } = {}) {
    return async (command: string) => {
      if (command.startsWith("cat ")) {
        const token = opts.sentinelToken ?? "sentinel-token";
        return { exitCode: 0, result: JSON.stringify({ token }), artifacts: { stdout: JSON.stringify({ token }) } };
      }
      if (command.includes("command -v bash")) {
        return { exitCode: 0, result: "bash", artifacts: { stdout: "bash" } };
      }
      if (command.startsWith("sudo -n bwrap")) {
        return { exitCode: opts.bwrapExit ?? 0, result: "", artifacts: { stdout: "" } };
      }
      if (command === "id -un") {
        const username = opts.username ?? "daytona";
        return { exitCode: opts.usernameExit ?? 0, result: username, artifacts: { stdout: username } };
      }
      return { exitCode: 0, result: "", artifacts: { stdout: "" } };
    };
  }

  const acquireParams = {
    driverKey: "daytona",
    companyId: "company-1",
    environmentId: "env-1",
    runId: "run-1",
    agentId: "agent-1",
    executionWorkspaceId: "workspace-1",
    adapterType: "codex_local",
    config: { image: "node:20", timeoutMs: 300000, reuseLease: true },
  };

  it("records bwrap available and reads username when the probe exits zero", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    sandbox.process.executeCommand.mockImplementation(bwrapExecMock({ bwrapExit: 0, username: "daytona" }));
    mockCreate.mockResolvedValue(sandbox);

    const lease = await plugin.definition.onEnvironmentAcquireLease?.(acquireParams);

    expect(lease).toMatchObject({
      metadata: {
        bwrapAvailable: true,
        sandboxUsername: "daytona",
      },
    });
  });

  it("bounds the probe timeout well under the hook deadline so the hook returns fallback metadata", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    sandbox.process.executeCommand.mockImplementation(bwrapExecMock({ bwrapExit: 0, username: "daytona" }));
    mockCreate.mockResolvedValue(sandbox);

    // The hook deadline is 300 s; the probe must cap far below it.
    await plugin.definition.onEnvironmentAcquireLease?.(acquireParams);

    const probeCalls = sandbox.process.executeCommand.mock.calls.filter(
      ([command]: [string]) => command === "id -un" || command.startsWith("sudo -n bwrap"),
    );
    expect(probeCalls.length).toBeGreaterThan(0);
    for (const call of probeCalls) {
      const timeoutArg = call[3] as number;
      expect(timeoutArg).toBe(10);
    }
  });

  it("records bwrap unavailable when the capability probe exits non-zero", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    sandbox.process.executeCommand.mockImplementation(bwrapExecMock({ bwrapExit: 1, username: "daytona" }));
    mockCreate.mockResolvedValue(sandbox);

    const lease = await plugin.definition.onEnvironmentAcquireLease?.(acquireParams);

    expect(lease?.metadata).toMatchObject({ bwrapAvailable: false });
  });

  it("records bwrap unavailable and does not throw when the probe throws", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    sandbox.process.executeCommand.mockRejectedValue(new Error("sandbox exec failed"));
    mockCreate.mockResolvedValue(sandbox);

    const lease = await plugin.definition.onEnvironmentAcquireLease?.(acquireParams);

    expect(lease?.metadata).toMatchObject({
      bwrapAvailable: false,
      sandboxUsername: null,
    });
  });

  it("runs the probe on the environment probe hook", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox();
    sandbox.process.executeCommand.mockImplementation(bwrapExecMock({ bwrapExit: 0, username: "daytona" }));
    mockCreate.mockResolvedValue(sandbox);

    const result = await plugin.definition.onEnvironmentProbe?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { snapshot: "base-snapshot", timeoutMs: 300000, reuseLease: false },
    });

    expect(result).toMatchObject({
      ok: true,
      metadata: { bwrapAvailable: true, sandboxUsername: "daytona" },
    });
  });

  it("runs the probe on the resume-lease hook", async () => {
    process.env.DAYTONA_API_KEY = "host-key";
    const sandbox = createMockSandbox({ id: "sandbox-reuse", state: "stopped" });
    sandbox.process.executeCommand.mockImplementation(bwrapExecMock({ bwrapExit: 0, username: "daytona" }));
    mockGet.mockResolvedValue(sandbox);

    const lease = await plugin.definition.onEnvironmentResumeLease?.({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "sandbox-reuse",
      config: { timeoutMs: 300000, reuseLease: true },
      leaseMetadata: {
        workspaceSentinel: {
          path: "/home/daytona/paperclip-workspace/.paperclip-runtime/reusable-sandbox-lease.json",
          token: "sentinel-token",
          result: "written",
        },
      },
    });

    expect(lease).toMatchObject({
      providerLeaseId: "sandbox-reuse",
      metadata: { bwrapAvailable: true, sandboxUsername: "daytona" },
    });
  });
});
