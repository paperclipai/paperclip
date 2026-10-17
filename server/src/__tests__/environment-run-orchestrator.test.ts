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
const mockLoggerInfo = vi.hoisted(() => vi.fn());
const mockGetEnvironment = vi.hoisted(() => vi.fn());
const mockGetLease = vi.hoisted(() => vi.fn());

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
    getById: mockGetEnvironment,
    getLeaseById: mockGetLease,
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

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: mockLoggerInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
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
          mode: "copy",
          authoritativeRoot: "/workspace/project",
          pathAliases: [],
          outboundRestorePaths: [],
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

  it.each([false, true])("only requests active-work cancellation for explicit Stop: %s", async (cancelActiveWork) => {
    const releaseRunLeases = vi.fn().mockResolvedValue([]);
    const runtime = makeMockRuntime({ releaseRunLeases });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });
    await orchestrator.releaseForRun({
      heartbeatRunId: "run-1", companyId: "company-1", agentId: "agent-1",
      providerResourceDisposition: "stop_and_retain", cancelActiveWork,
    });
    expect(releaseRunLeases).toHaveBeenCalledWith(
      "run-1", "released", expect.any(Function), "stop_and_retain",
      ...(cancelActiveWork ? [true] : []),
    );
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
    expect(result.executionTarget).toEqual({
      ...executionTarget,
      workspaceRealization: {
        mode: "copy",
        authoritativeRoot: "/workspace/project",
        pathAliases: [],
        outboundRestorePaths: [],
      },
    });
    expect(result.remoteExecution).toEqual(remoteExecution);
    expect(result.workspaceRealization).toEqual(
      expect.objectContaining({ version: 1, driver: "local" }),
    );

    expect(runtime.realizeWorkspace).toHaveBeenCalledOnce();
    expect(mockResolveEnvironmentExecutionTarget).toHaveBeenCalledOnce();
  });

  it("uses an in-place authoritative root on the adapter execution target", async () => {
    mockResolveEnvironmentExecutionTarget.mockResolvedValue({
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/copied/workspace",
    });
    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockResolvedValue({
        cwd: "/app",
        metadata: {
          workspaceRealization: {
            version: 1,
            mode: "in_place",
            authoritativeRoot: "/app",
            pathAliases: [],
            outboundRestorePaths: [],
          },
        },
      }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    const result = await orchestrator.realizeForRun(
      makeRealizeInput({ environment: makeEnvironment("sandbox") }),
    );

    expect(result.executionTarget).toEqual(expect.objectContaining({
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/app",
      workspaceRealization: {
        mode: "in_place",
        authoritativeRoot: "/app",
        pathAliases: [],
        outboundRestorePaths: [],
      },
    }));
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
      transport: "ssh",
      remoteCwd: "/remote/workspace",
      environmentId: "env-1",
      leaseId: "lease-1",
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteCwd: "/remote/workspace",
        remoteWorkspacePath: "/remote/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    });

    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockResolvedValue({
        cwd: "/remote/workspace",
        metadata: {
          workspaceRealization: {
            version: 1,
            transport: "ssh",
            remote: { path: "/remote/workspace" },
          },
        },
      }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await orchestrator.realizeForRun(makeRealizeInput({
      environment: makeEnvironment("ssh"),
    }));

    // The `ssh` driver runs the command on the remote host that shares the
    // workspace path, so the configured provision command still runs there.
    expect(runtime.execute).toHaveBeenCalledOnce();
    expect(runtime.execute).toHaveBeenCalledWith(expect.objectContaining({
      environment: expect.objectContaining({ driver: "ssh" }),
      lease: expect.objectContaining({ id: "lease-1" }),
      command: "bash",
      args: ["-lc", "npm install -g @anthropic-ai/claude-code"],
      cwd: "/remote/workspace",
      env: {
        SHELL: "/bin/bash",
      },
    }));
    // The sandbox skip log is specific to the sandbox driver; ssh stays quiet.
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  it("skips the host provision command for a sandbox environment and logs the skip", async () => {
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

    // The sandbox receives the provisioned tree through the adapter stage.sync
    // step, so the orchestrator must not run the host command in the sandbox.
    expect(runtime.execute).not.toHaveBeenCalled();
    // The skip is observable: exactly one log line records it with the driver.
    expect(mockLoggerInfo).toHaveBeenCalledOnce();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ driver: "sandbox", environmentId: "env-1" }),
      expect.stringContaining("Skip host provisionCommand"),
    );
  });

  it("does not rerun the provision command during local environment realization", async () => {
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
      kind: "local",
      environmentId: "env-1",
      leaseId: "lease-1",
    });

    const runtime = makeMockRuntime();
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await orchestrator.realizeForRun(makeRealizeInput({
      environment: makeEnvironment("local"),
    }));

    // Local workspace provisioning already ran the command before realizeForRun.
    expect(runtime.execute).not.toHaveBeenCalled();
    // The sandbox skip log is specific to the sandbox driver; local stays quiet.
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  it("runs project-level provision commands for ssh environments", async () => {
    mockBuildWorkspaceRealizationRequest.mockReturnValue({
      version: 1,
      adapterType: "gemini_local",
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
        provisionCommand: "npm install -g @google/gemini-cli",
      },
    });
    mockResolveEnvironmentExecutionTarget.mockResolvedValue({
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/remote/workspace",
      environmentId: "env-1",
      leaseId: "lease-1",
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteCwd: "/remote/workspace",
        remoteWorkspacePath: "/remote/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    });

    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockResolvedValue({
        cwd: "/remote/workspace",
        metadata: {
          workspaceRealization: {
            version: 1,
            transport: "ssh",
            remote: { path: "/remote/workspace" },
          },
        },
      }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await orchestrator.realizeForRun(makeRealizeInput({
      environment: makeEnvironment("ssh"),
      lease: makeLease({
        provider: "ssh",
        metadata: {
          driver: "ssh",
          remoteCwd: "/remote/workspace",
          remoteWorkspacePath: "/remote/workspace",
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
        },
      }),
    }));

    expect(runtime.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "bash",
      args: ["-lc", "npm install -g @google/gemini-cli"],
    }));
    expect(mockResolveEnvironmentExecutionTarget).toHaveBeenCalledOnce();
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
      environment: makeEnvironment("ssh"),
    }))).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EnvironmentRunError &&
        err.code === "workspace_realization_failed" &&
        String(err.message).includes("install-tool: not found"),
    );

    expect(mockResolveEnvironmentExecutionTarget).not.toHaveBeenCalled();
  });
});


describe("native runner lifecycle changes before lease acquisition", () => {
  it("requests a reusable lease when an existing task switches from per-turn to warm", async () => {
    const environment = { ...makeEnvironment("sandbox"), config: { provider: "daytona", reuseLease: false } };
    mockGetEnvironment.mockResolvedValue(environment);
    const acquireRunLease = vi.fn(async (input) => ({
      environment: input.environment,
      lease: makeLease({ leasePolicy: input.environment.config.reuseLease ? "reuse_by_environment" : "ephemeral" }),
      leaseContext: { executionWorkspaceId: "existing-workspace", executionWorkspaceMode: "shared_workspace" },
    }));
    const orchestrator = environmentRunOrchestrator({} as never, { environmentRuntime: makeMockRuntime({ acquireRunLease }) });
    const input = {
      companyId: "company-1", selectedEnvironmentId: "env-1", localEnvironmentId: "local",
      adapterType: "paperclip_runner", issueId: "existing-task", heartbeatRunId: "run-1", agentId: "agent-1",
      persistedExecutionWorkspace: { id: "existing-workspace", mode: "shared_workspace" as const },
      executionWorkspaceSettings: null,
    };
    const cold = await orchestrator.acquireForRun({ ...input, adapterConfig: { lifecycleMode: "per_turn" } });
    expect(cold.lease.leasePolicy).toBe("ephemeral");
    const warm = await orchestrator.acquireForRun({ ...input, heartbeatRunId: "run-2", adapterConfig: { lifecycleMode: "warm", idleTimeoutMs: 60_000 } });
    expect(warm.lease.leasePolicy).toBe("reuse_by_environment");
    expect(warm.environment.config).toEqual({ provider: "daytona", reuseLease: true });
    expect(acquireRunLease.mock.calls[1][0].persistedExecutionWorkspace).toEqual(input.persistedExecutionWorkspace);
    // Run-scoped adaptation must not change the shared environment or other agents.
    expect(environment.config).toEqual({ provider: "daytona", reuseLease: false });
    const coldAgain = await orchestrator.acquireForRun({ ...input, heartbeatRunId: "run-3", adapterConfig: { lifecycleMode: "per_turn" } });
    expect(coldAgain.lease.leasePolicy).toBe("ephemeral");
  });

  it.each([
    ["paperclip_runner", undefined, undefined, false],
    ["paperclip_runner", "inherit", "per_turn", false],
    ["paperclip_runner", "per_turn", "warm", false],
    ["paperclip_runner", "warm", "per_turn", true],
    ["paperclip_runner", "inherit", "warm", true],
    ["codex_local", "inherit", "warm", false],
  ])("respects environment precedence and adapter scope (%s, %s, %s)", async (adapterType, runnerLifecycleMode, lifecycleMode, expectedReuse) => {
    const environment = { ...makeEnvironment("sandbox"), config: { provider: "daytona", reuseLease: false, runnerLifecycleMode } };
    mockGetEnvironment.mockResolvedValue(environment);
    const acquireRunLease = vi.fn(async (input) => ({ environment: input.environment, lease: makeLease(), leaseContext: {} }));
    const orchestrator = environmentRunOrchestrator({} as never, { environmentRuntime: makeMockRuntime({ acquireRunLease }) });
    await orchestrator.acquireForRun({
      companyId: "company-1", selectedEnvironmentId: "env-1", localEnvironmentId: "local", adapterType,
      adapterConfig: { lifecycleMode }, issueId: "task-1", heartbeatRunId: "run-1", agentId: "agent-1",
      persistedExecutionWorkspace: null, executionWorkspaceSettings: null,
    });
    expect(acquireRunLease.mock.calls[0][0].environment.config.reuseLease).toBe(expectedReuse);
  });
});


describe("acquireForRun null-lease guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws EnvironmentRunError(lease_acquire_failed) when runtime yields lease=null", async () => {
    // Regression test for the bug exposed by the UUID guard on
    // `getLeaseById`: when the runtime legitimately returns
    // `{ environment, lease: null, leaseContext: null }`, the orchestrator
    // must NOT crash with `Cannot read properties of null (reading 'id')`
    // on `leaseRecord.lease.id` inside `logActivity`. Instead it must
    // surface a typed `lease_acquire_failed` error that the heartbeat
    // `try/catch` can terminalize as a regular failed run.
    const environment = makeEnvironment("sandbox");
    mockGetEnvironment.mockResolvedValue(environment);
    const acquireRunLease = vi.fn(async () => ({
      environment,
      lease: null,
      leaseContext: null,
    }));
    const orchestrator = environmentRunOrchestrator({} as never, {
      environmentRuntime: makeMockRuntime({ acquireRunLease }),
    });
    await expect(
      orchestrator.acquireForRun({
        companyId: "company-1",
        selectedEnvironmentId: "env-1",
        localEnvironmentId: "local",
        adapterType: "paperclip_runner",
        adapterConfig: { lifecycleMode: "per_turn" },
        issueId: "task-1",
        heartbeatRunId: "run-1",
        agentId: "agent-1",
        persistedExecutionWorkspace: null,
        executionWorkspaceSettings: null,
      }),
    ).rejects.toMatchObject({
      name: "EnvironmentRunError",
      code: "lease_acquire_failed",
      environmentId: "env-1",
    });
    // The crash path would have called `logActivity("environment.lease_acquired")`
    // before throwing. We must NOT record an `entityId: null` activity entry.
    const leaseAcquiredCalls = mockLogActivity.mock.calls.filter(
      ([, payload]: [unknown, { action?: string }]) =>
        payload?.action === "environment.lease_acquired",
    );
    expect(leaseAcquiredCalls).toHaveLength(0);
  });
});

describe("admitted native lifecycle recovery", () => {
  it.each([
    ["warm", "per_turn", "per_turn", true],
    ["per_turn", "warm", "warm", false],
  ] as const)("preserves admitted %s over changed agent/environment settings", async (admittedLifecycleMode, lifecycleMode, runnerLifecycleMode, expectedReuse) => {
    const environment = { ...makeEnvironment("sandbox"), config: { provider: "daytona", reuseLease: false, runnerLifecycleMode } };
    mockGetEnvironment.mockResolvedValue(environment);
    const acquireRunLease = vi.fn(async (input) => ({ environment: input.environment, lease: makeLease(), leaseContext: {} }));
    const orchestrator = environmentRunOrchestrator({} as never, { environmentRuntime: makeMockRuntime({ acquireRunLease }) });
    await orchestrator.acquireForRun({
      companyId: "company-1", selectedEnvironmentId: "env-1", localEnvironmentId: "local",
      adapterType: "paperclip_runner", adapterConfig: { lifecycleMode }, admittedLifecycleMode,
      issueId: "task-1", heartbeatRunId: "run-1", agentId: "agent-1",
      persistedExecutionWorkspace: null, executionWorkspaceSettings: null,
    });
    expect(acquireRunLease.mock.calls[0][0].environment.config.reuseLease).toBe(expectedReuse);
    expect(environment.config.reuseLease).toBe(false);
  });
});

describe("live remote runner lease reattachment", () => {
  const input = {
    companyId: "company-1", selectedEnvironmentId: "env-1", localEnvironmentId: "local",
    adapterType: "paperclip_runner", admittedLifecycleMode: "per_turn" as const,
    issueId: "task-1", heartbeatRunId: "run-1", agentId: "agent-1",
    persistedExecutionWorkspace: { id: "ew-1", mode: "shared_workspace" as const },
    executionWorkspaceSettings: null,
    reattachRemoteLease: { leaseId: "lease-1", providerLeaseId: "original-sandbox", remoteCwd: "/remote/workspace" },
  };
  const originalLease = () => makeLease({
    provider: "daytona", providerLeaseId: "original-sandbox", issueId: "task-1", executionWorkspaceId: "ew-1",
    metadata: { agentId: "agent-1", remoteCwd: "/remote/workspace",
      sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: "original-sandbox" } },
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEnvironment.mockResolvedValue({ ...makeEnvironment("sandbox"), config: { provider: "daytona", reuseLease: false } });
    mockGetLease.mockResolvedValue(originalLease());
  });
  it("reattaches the original active ephemeral lease without acquiring or resuming a sandbox", async () => {
    const savedLease = originalLease();
    mockGetLease.mockResolvedValue(savedLease);
    const runtime = makeMockRuntime();
    const result = await environmentRunOrchestrator({} as never, { environmentRuntime: runtime }).acquireForRun(input);
    expect(mockGetLease).toHaveBeenCalledWith("lease-1");
    expect(runtime.acquireRunLease).not.toHaveBeenCalled();
    expect(result.lease).toEqual(savedLease);
    expect(result.leaseContext.executionWorkspaceId).toBe("ew-1");
    expect(result.environment.config.reuseLease).toBe(false);
  });
  it.each([
    { companyId: "foreign" }, { environmentId: "foreign" }, { heartbeatRunId: "another-run" },
    { issueId: "another-task" }, { executionWorkspaceId: "another-workspace" },
    { providerLeaseId: "replacement" }, { provider: "another-provider" },
    { status: "released" }, { expiresAt: new Date(0) }, { releasedAt: new Date() }, { cleanupStatus: "pending" },
    { metadata: { agentId: "another-agent", remoteCwd: "/remote/workspace" } },
    { metadata: { agentId: "agent-1", remoteCwd: "/other/workspace" } },
  ] as Partial<EnvironmentLease>[])("fails closed before provider acquisition for a mismatched lease %j", async (override) => {
    mockGetLease.mockResolvedValue({ ...originalLease(), ...override });
    const runtime = makeMockRuntime();
    await expect(environmentRunOrchestrator({} as never, { environmentRuntime: runtime }).acquireForRun(input))
      .rejects.toThrow("native_remote_recovery_lease_mismatch");
    expect(runtime.acquireRunLease).not.toHaveBeenCalled();
  });
  it("never replaces a missing original lease", async () => {
    mockGetLease.mockResolvedValue(null);
    const runtime = makeMockRuntime();
    await expect(environmentRunOrchestrator({} as never, { environmentRuntime: runtime }).acquireForRun(input))
      .rejects.toThrow("native_remote_recovery_lease_mismatch");
    expect(runtime.acquireRunLease).not.toHaveBeenCalled();
  });
});
