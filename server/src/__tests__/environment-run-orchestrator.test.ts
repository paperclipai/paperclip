import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that reference them
// ---------------------------------------------------------------------------

const mockResolveEnvironmentExecutionTarget = vi.hoisted(() => vi.fn());
const mockAdapterExecutionTargetToRemoteSpec = vi.hoisted(() => vi.fn());
const mockBuildWorkspaceRealizationRequest = vi.hoisted(() => vi.fn());
const mockUpdateLeaseMetadata = vi.hoisted(() => vi.fn());
const mockUpdateExecutionWorkspace = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/environment-execution-target.js", () => ({
  resolveEnvironmentExecutionTarget: mockResolveEnvironmentExecutionTarget,
  resolveEnvironmentExecutionTransport: vi.fn().mockResolvedValue(null),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  adapterExecutionTargetToRemoteSpec: mockAdapterExecutionTargetToRemoteSpec,
}));

vi.mock("../services/workspace-realization.js", () => ({
  buildWorkspaceRealizationRequest: mockBuildWorkspaceRealizationRequest,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: vi.fn(() => ({
    ensureLocalEnvironment: vi.fn(),
    getById: vi.fn(),
    acquireLease: vi.fn(),
    releaseLease: vi.fn(),
    updateLeaseMetadata: mockUpdateLeaseMetadata,
  })),
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: vi.fn(() => ({
    update: mockUpdateExecutionWorkspace,
  })),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  environmentRunOrchestrator,
  EnvironmentRunError,
} from "../services/environment-run-orchestrator.ts";
import type { Environment, EnvironmentLease, ExecutionWorkspace } from "@paperclipai/shared";
import type { RealizedExecutionWorkspace } from "../services/workspace-runtime.ts";
import type { EnvironmentRuntimeService } from "../services/environment-runtime.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEnvironment(driver: string = "local"): Environment {
  return {
    id: "env-1",
    companyId: "company-1",
    name: "Test Environment",
    description: null,
    driver: driver as Environment["driver"],
    status: "active",
    config: {},
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeLease(overrides: Partial<EnvironmentLease> = {}): EnvironmentLease {
  return {
    id: "lease-1",
    companyId: "company-1",
    environmentId: "env-1",
    executionWorkspaceId: null,
    issueId: null,
    heartbeatRunId: "run-1",
    status: "active",
    leasePolicy: "ephemeral",
    provider: "local",
    providerLeaseId: null,
    acquiredAt: new Date(),
    lastUsedAt: new Date(),
    expiresAt: null,
    releasedAt: null,
    failureReason: null,
    cleanupStatus: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeExecutionWorkspace(cwd: string = "/workspace/project"): RealizedExecutionWorkspace {
  return {
    baseCwd: "/workspace",
    source: "project_primary",
    projectId: "project-1",
    workspaceId: "ws-1",
    repoUrl: null,
    repoRef: null,
    strategy: "project_primary",
    cwd,
    branchName: null,
    worktreePath: null,
    warnings: [],
    created: false,
  };
}

function makePersistedExecutionWorkspace(
  overrides: Partial<ExecutionWorkspace> = {},
): ExecutionWorkspace {
  return {
    id: "ew-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: null,
    sourceIssueId: null,
    mode: "standard",
    strategyType: "project_primary",
    name: "workspace",
    status: "open",
    cwd: "/workspace/project",
    repoUrl: null,
    baseRef: null,
    branchName: null,
    providerType: "local",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date(),
    openedAt: new Date(),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRealizeInput(overrides: {
  environment?: Environment;
  lease?: EnvironmentLease;
  persistedExecutionWorkspace?: ExecutionWorkspace | null;
} = {}): Parameters<ReturnType<typeof environmentRunOrchestrator>["realizeForRun"]>[0] {
  return {
    environment: overrides.environment ?? makeEnvironment("local"),
    lease: overrides.lease ?? makeLease(),
    adapterType: "claude_local",
    companyId: "company-1",
    issueId: null,
    heartbeatRunId: "run-1",
    executionWorkspace: makeExecutionWorkspace(),
    effectiveExecutionWorkspaceMode: null,
    persistedExecutionWorkspace: overrides.persistedExecutionWorkspace !== undefined
      ? overrides.persistedExecutionWorkspace
      : null,
  };
}

function makeMockRuntime(overrides: Partial<EnvironmentRuntimeService> = {}): EnvironmentRuntimeService {
  return {
    acquireRunLease: vi.fn(),
    releaseRunLeases: vi.fn(),
    execute: vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    }),
    realizeWorkspace: vi.fn().mockResolvedValue({
      cwd: "/workspace/project",
      metadata: {
        workspaceRealization: {
          version: 1,
          driver: "local",
          cwd: "/workspace/project",
        },
      },
    }),
    ...overrides,
  } as unknown as EnvironmentRuntimeService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("environmentRunOrchestrator — realizeForRun", () => {
  const mockDb = {} as any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockBuildWorkspaceRealizationRequest.mockReturnValue({
      version: 1,
      adapterType: "claude_local",
      companyId: "company-1",
      environmentId: "env-1",
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: "run-1",
      requestedMode: null,
      source: {
        kind: "project_primary",
        localPath: "/workspace/project",
        projectId: null,
        projectWorkspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        branchName: null,
        worktreePath: null,
      },
      runtimeOverlay: {
        provisionCommand: null,
      },
    });

    mockAdapterExecutionTargetToRemoteSpec.mockReturnValue({
      kind: "local",
      environmentId: "env-1",
      leaseId: "lease-1",
    });

    mockUpdateLeaseMetadata.mockResolvedValue(null);
    mockUpdateExecutionWorkspace.mockResolvedValue(null);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("happy path: returns lease, executionTarget, and remoteExecution on successful realization", async () => {
    const executionTarget = { kind: "local", environmentId: "env-1", leaseId: "lease-1" };
    const remoteExecution = { kind: "local", environmentId: "env-1", leaseId: "lease-1" };

    mockResolveEnvironmentExecutionTarget.mockResolvedValue(executionTarget);
    mockAdapterExecutionTargetToRemoteSpec.mockReturnValue(remoteExecution);

    const runtime = makeMockRuntime();
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    const result = await orchestrator.realizeForRun(makeRealizeInput());

    expect(result.lease).toBeDefined();
    expect(result.executionTarget).toEqual(executionTarget);
    expect(result.remoteExecution).toEqual(remoteExecution);
    expect(result.workspaceRealization).toEqual(
      expect.objectContaining({ version: 1, driver: "local" }),
    );

    expect(runtime.realizeWorkspace).toHaveBeenCalledOnce();
    expect(mockResolveEnvironmentExecutionTarget).toHaveBeenCalledOnce();
  });

  it("realization failure: runtime.realizeWorkspace throws → EnvironmentRunError with code workspace_realization_failed", async () => {
    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockRejectedValue(new Error("sandbox unreachable")),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await expect(orchestrator.realizeForRun(makeRealizeInput())).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EnvironmentRunError &&
        err.code === "workspace_realization_failed" &&
        err.environmentId === "env-1" &&
        err.driver === "local",
    );

    expect(mockResolveEnvironmentExecutionTarget).not.toHaveBeenCalled();
  });

  it("target resolution failure: resolveEnvironmentExecutionTarget throws → EnvironmentRunError with code transport_resolution_failed", async () => {
    mockResolveEnvironmentExecutionTarget.mockRejectedValue(new Error("network error"));

    const runtime = makeMockRuntime();
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await expect(orchestrator.realizeForRun(makeRealizeInput())).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EnvironmentRunError &&
        err.code === "transport_resolution_failed" &&
        err.environmentId === "env-1",
    );
  });

  it("non-sandbox driver skips workspace realization and goes straight to target resolution", async () => {
    const environment = makeEnvironment("plugin" as Environment["driver"]);
    const executionTarget = null;

    mockResolveEnvironmentExecutionTarget.mockResolvedValue(executionTarget);

    const runtime = makeMockRuntime();
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    const result = await orchestrator.realizeForRun(
      makeRealizeInput({ environment }),
    );

    expect(runtime.realizeWorkspace).not.toHaveBeenCalled();
    expect(result.workspaceRealization).toEqual({});
    expect(result.executionTarget).toBeNull();
  });

  it("persisted metadata is updated on lease and execution workspace after realization", async () => {
    const persistedExecutionWorkspace = makePersistedExecutionWorkspace();
    const updatedLease = makeLease({
      metadata: { workspaceRealization: { version: 1, driver: "local", cwd: "/workspace/project" } },
    });
    const updatedEw = { ...persistedExecutionWorkspace, metadata: { workspaceRealizationRequest: {}, workspaceRealization: {} } };

    mockUpdateLeaseMetadata.mockResolvedValue(updatedLease);
    mockUpdateExecutionWorkspace.mockResolvedValue(updatedEw);
    mockResolveEnvironmentExecutionTarget.mockResolvedValue({ kind: "local", environmentId: "env-1", leaseId: "lease-1" });

    const runtime = makeMockRuntime();
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    const result = await orchestrator.realizeForRun(
      makeRealizeInput({ persistedExecutionWorkspace }),
    );

    // Lease metadata should have been updated with workspaceRealization
    expect(mockUpdateLeaseMetadata).toHaveBeenCalledOnce();
    expect(mockUpdateLeaseMetadata).toHaveBeenCalledWith(
      "lease-1",
      expect.objectContaining({ workspaceRealization: expect.any(Object) }),
    );

    // Execution workspace metadata should have been updated
    expect(mockUpdateExecutionWorkspace).toHaveBeenCalledOnce();
    expect(mockUpdateExecutionWorkspace).toHaveBeenCalledWith(
      "ew-1",
      expect.objectContaining({
        metadata: expect.objectContaining({
          workspaceRealizationRequest: expect.any(Object),
          workspaceRealization: expect.any(Object),
        }),
      }),
    );

    // The returned lease should reflect the updated value
    expect(result.lease).toEqual(updatedLease);
    expect(result.persistedExecutionWorkspace).toEqual(updatedEw);
  });

  it("runs a remote provision command after workspace realization when configured", async () => {
    mockBuildWorkspaceRealizationRequest.mockReturnValue({
      version: 1,
      adapterType: "claude_local",
      companyId: "company-1",
      environmentId: "env-1",
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: "run-1",
      requestedMode: null,
      source: {
        kind: "project_primary",
        localPath: "/workspace/project",
        projectId: null,
        projectWorkspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        branchName: null,
        worktreePath: null,
      },
      runtimeOverlay: {
        provisionCommand: "npm install -g @anthropic-ai/claude-code",
      },
    });
    mockResolveEnvironmentExecutionTarget.mockResolvedValue({
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      remoteCwd: "/remote/workspace",
      environmentId: "env-1",
      leaseId: "lease-1",
    });

    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockResolvedValue({
        cwd: "/remote/workspace",
        metadata: {
          workspaceRealization: {
            version: 1,
            transport: "sandbox",
            remote: { path: "/remote/workspace" },
          },
        },
      }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await orchestrator.realizeForRun(makeRealizeInput({
      environment: makeEnvironment("sandbox"),
    }));

    expect(runtime.execute).toHaveBeenCalledOnce();
    expect(runtime.execute).toHaveBeenCalledWith(expect.objectContaining({
      environment: expect.objectContaining({ driver: "sandbox" }),
      lease: expect.objectContaining({ id: "lease-1" }),
      command: "bash",
      args: ["-lc", "npm install -g @anthropic-ai/claude-code"],
      cwd: "/remote/workspace",
      env: {
        SHELL: "/bin/bash",
      },
    }));
  });

  it("surfaces remote provision command failures before resolving the adapter target", async () => {
    mockBuildWorkspaceRealizationRequest.mockReturnValue({
      version: 1,
      adapterType: "claude_local",
      companyId: "company-1",
      environmentId: "env-1",
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: "run-1",
      requestedMode: null,
      source: {
        kind: "project_primary",
        localPath: "/workspace/project",
        projectId: null,
        projectWorkspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        branchName: null,
        worktreePath: null,
      },
      runtimeOverlay: {
        provisionCommand: "install-tool",
      },
    });

    const runtime = makeMockRuntime({
      execute: vi.fn().mockResolvedValue({
        exitCode: 127,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "/bin/sh: install-tool: not found\n",
      }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await expect(orchestrator.realizeForRun(makeRealizeInput({
      environment: makeEnvironment("sandbox"),
    }))).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EnvironmentRunError &&
        err.code === "workspace_realization_failed" &&
        String(err.message).includes("install-tool: not found"),
    );

    expect(mockResolveEnvironmentExecutionTarget).not.toHaveBeenCalled();
  });
});
