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

function makeExecutionWorkspace(
  cwd: string = "/workspace/project",
  overrides: Partial<RealizedExecutionWorkspace> = {},
): RealizedExecutionWorkspace {
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
    created: true,
    ...overrides,
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
  executionWorkspace?: RealizedExecutionWorkspace;
} = {}): Parameters<ReturnType<typeof environmentRunOrchestrator>["realizeForRun"]>[0] {
  return {
    environment: overrides.environment ?? makeEnvironment("local"),
    lease: overrides.lease ?? makeLease(),
    adapterType: "claude_local",
    companyId: "company-1",
    issueId: null,
    heartbeatRunId: "run-1",
    executionWorkspace: overrides.executionWorkspace ?? makeExecutionWorkspace(),
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

  it("skips remote provision command when reusing an existing isolated worktree workspace", async () => {
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
        kind: "task_session",
        localPath: "/workspace/worktrees/issue-1",
        projectId: null,
        projectWorkspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "git_worktree",
        branchName: "issue-1",
        worktreePath: "/workspace/worktrees/issue-1",
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
            isNew: false,
          },
        },
      }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await orchestrator.realizeForRun(makeRealizeInput({
      environment: makeEnvironment("sandbox"),
      executionWorkspace: makeExecutionWorkspace("/workspace/worktrees/issue-1", {
        strategy: "git_worktree",
        branchName: "issue-1",
        worktreePath: "/workspace/worktrees/issue-1",
        created: false,
      }),
    }));

    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it("still runs the remote provision command when a reused local worktree gets a fresh ephemeral remote lease", async () => {
    // A reused local git worktree and a freshly acquired remote lease are independent
    // facts. Built-in realization records carry no per-run isNew/created field for the
    // remote side (unlike the plugin-sandbox test above, which reports `isNew: false`
    // explicitly), so the gate must fall back to the lease policy: an "ephemeral" lease
    // is fresh by construction and must not be skipped just because the local worktree
    // was reused, or the sandbox/SSH target starts without required setup.
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
        kind: "task_session",
        localPath: "/workspace/worktrees/issue-1",
        projectId: null,
        projectWorkspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "git_worktree",
        branchName: "issue-1",
        worktreePath: "/workspace/worktrees/issue-1",
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
      lease: makeLease({ leasePolicy: "ephemeral" }),
      executionWorkspace: makeExecutionWorkspace("/workspace/worktrees/issue-1", {
        strategy: "git_worktree",
        branchName: "issue-1",
        worktreePath: "/workspace/worktrees/issue-1",
        created: false,
      }),
    }));

    expect(runtime.execute).toHaveBeenCalledOnce();
  });

  it("still runs the remote provision command on a reusable sandbox's very first lease, even though the policy is already reuse_by_environment", async () => {
    // A `reuseLease: true` sandbox environment's very first-ever lease has
    // `leasePolicy: "reuse_by_environment"` from the moment it's acquired —
    // that's a config-level setting, not a fact about this specific lease.
    // The driver only sets `metadata.wasResumed` when it actually resumed an
    // existing provider-side lease (environment-runtime.ts); a lease with no
    // such flag was freshly acquired and must still be provisioned, or the
    // adapter starts without required tools/dependencies (regression caught
    // by Greptile on the prior fix for this gate).
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
        kind: "task_session",
        localPath: "/workspace/worktrees/issue-1",
        projectId: null,
        projectWorkspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "git_worktree",
        branchName: "issue-1",
        worktreePath: "/workspace/worktrees/issue-1",
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
            // No isNew/created freshness flag — matches built-in realization records.
          },
        },
      }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await orchestrator.realizeForRun(makeRealizeInput({
      environment: makeEnvironment("sandbox"),
      // Policy is already reuse_by_environment (the environment is configured
      // with reuseLease: true), but this specific lease was freshly acquired —
      // metadata carries no wasResumed flag, since the sandbox driver only sets
      // it to true when it actually resumed an existing provider lease.
      lease: makeLease({ leasePolicy: "reuse_by_environment", metadata: { wasResumed: false } }),
      executionWorkspace: makeExecutionWorkspace("/workspace/worktrees/issue-1", {
        strategy: "git_worktree",
        branchName: "issue-1",
        worktreePath: "/workspace/worktrees/issue-1",
        created: false,
      }),
    }));

    expect(runtime.execute).toHaveBeenCalledOnce();
  });

  it("still runs the remote provision command for a shared project_primary workspace even though its local directory is never reported as freshly \"created\"", async () => {
    // `project_primary` (shared workspace) realizations always report `created: false` for the
    // local directory (see workspace-runtime.ts) because it is the project's long-lived primary
    // checkout rather than something freshly created per run. The reuse-skip gate must not key off
    // that flag for this strategy, or shared-workspace remote/sandbox provisioning would silently
    // never run again — not even on the very first run.
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
      executionWorkspace: makeExecutionWorkspace("/workspace/project", {
        strategy: "project_primary",
        created: false,
      }),
    }));

    expect(runtime.execute).toHaveBeenCalledOnce();
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
