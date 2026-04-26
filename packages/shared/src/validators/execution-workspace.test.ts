import { describe, expect, it } from "vitest";
import {
  executionWorkspaceStatusSchema,
  executionWorkspaceConfigSchema,
  executionWorkspaceCloseReadinessStateSchema,
  executionWorkspaceCloseActionKindSchema,
  executionWorkspaceCloseActionSchema,
  executionWorkspaceCloseLinkedIssueSchema,
  executionWorkspaceCloseGitReadinessSchema,
  workspaceRuntimeServiceSchema,
  executionWorkspaceCloseReadinessSchema,
  updateExecutionWorkspaceSchema,
} from "./execution-workspace.js";

describe("executionWorkspaceStatusSchema", () => {
  it("accepts all valid statuses", () => {
    for (const status of ["active", "idle", "in_review", "archived", "cleanup_failed"]) {
      expect(executionWorkspaceStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it("rejects an invalid status", () => {
    expect(executionWorkspaceStatusSchema.safeParse("paused").success).toBe(false);
  });
});

describe("executionWorkspaceConfigSchema", () => {
  it("accepts an empty object", () => {
    expect(executionWorkspaceConfigSchema.safeParse({}).success).toBe(true);
  });

  it("accepts valid desiredState values", () => {
    expect(executionWorkspaceConfigSchema.safeParse({ desiredState: "running" }).success).toBe(true);
    expect(executionWorkspaceConfigSchema.safeParse({ desiredState: "stopped" }).success).toBe(true);
  });

  it("rejects invalid desiredState", () => {
    expect(executionWorkspaceConfigSchema.safeParse({ desiredState: "idle" }).success).toBe(false);
  });

  it("rejects unknown fields (strict schema)", () => {
    expect(executionWorkspaceConfigSchema.safeParse({ unknownField: true }).success).toBe(false);
  });

  it("accepts optional commands", () => {
    const result = executionWorkspaceConfigSchema.safeParse({
      provisionCommand: "make setup",
      teardownCommand: "make cleanup",
      cleanupCommand: "rm -rf .cache",
    });
    expect(result.success).toBe(true);
  });
});

describe("executionWorkspaceCloseReadinessStateSchema", () => {
  it("accepts all valid states", () => {
    for (const state of ["ready", "ready_with_warnings", "blocked"]) {
      expect(executionWorkspaceCloseReadinessStateSchema.safeParse(state).success).toBe(true);
    }
  });

  it("rejects an invalid state", () => {
    expect(executionWorkspaceCloseReadinessStateSchema.safeParse("pending").success).toBe(false);
  });
});

describe("executionWorkspaceCloseActionKindSchema", () => {
  it("accepts all valid action kinds", () => {
    for (const kind of [
      "archive_record", "stop_runtime_services", "cleanup_command", "teardown_command",
      "git_worktree_remove", "git_branch_delete", "remove_local_directory",
    ]) {
      expect(executionWorkspaceCloseActionKindSchema.safeParse(kind).success).toBe(true);
    }
  });

  it("rejects an invalid action kind", () => {
    expect(executionWorkspaceCloseActionKindSchema.safeParse("delete_all").success).toBe(false);
  });
});

describe("executionWorkspaceCloseActionSchema", () => {
  const valid = {
    kind: "archive_record" as const,
    label: "Archive",
    description: "Archive the workspace record",
    command: null,
  };

  it("accepts a valid close action", () => {
    expect(executionWorkspaceCloseActionSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a non-null command", () => {
    expect(executionWorkspaceCloseActionSchema.safeParse({ ...valid, command: "rm -rf .worktree" }).success).toBe(true);
  });

  it("rejects unknown fields (strict schema)", () => {
    expect(executionWorkspaceCloseActionSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});

describe("executionWorkspaceCloseLinkedIssueSchema", () => {
  const valid = {
    id: "00000000-0000-0000-0000-000000000001",
    identifier: "ISSUE-123",
    title: "Fix the bug",
    status: "in_progress",
    isTerminal: false,
  };

  it("accepts a valid linked issue", () => {
    expect(executionWorkspaceCloseLinkedIssueSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts null identifier", () => {
    expect(executionWorkspaceCloseLinkedIssueSchema.safeParse({ ...valid, identifier: null }).success).toBe(true);
  });

  it("rejects unknown fields (strict schema)", () => {
    expect(executionWorkspaceCloseLinkedIssueSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});

describe("executionWorkspaceCloseGitReadinessSchema", () => {
  const valid = {
    repoRoot: "/repo",
    workspacePath: "/repo/.worktrees/branch",
    branchName: "feat/my-feature",
    baseRef: "main",
    hasDirtyTrackedFiles: false,
    hasUntrackedFiles: true,
    dirtyEntryCount: 0,
    untrackedEntryCount: 2,
    aheadCount: 1,
    behindCount: 0,
    isMergedIntoBase: false,
    createdByRuntime: false,
  };

  it("accepts a valid git readiness object", () => {
    expect(executionWorkspaceCloseGitReadinessSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts null values for optional pointer fields", () => {
    const result = executionWorkspaceCloseGitReadinessSchema.safeParse({
      ...valid,
      repoRoot: null,
      workspacePath: null,
      branchName: null,
      baseRef: null,
      aheadCount: null,
      behindCount: null,
      isMergedIntoBase: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative dirtyEntryCount", () => {
    expect(executionWorkspaceCloseGitReadinessSchema.safeParse({ ...valid, dirtyEntryCount: -1 }).success).toBe(false);
  });

  it("rejects unknown fields (strict schema)", () => {
    expect(executionWorkspaceCloseGitReadinessSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});

describe("updateExecutionWorkspaceSchema", () => {
  it("accepts an empty object (all optional)", () => {
    expect(updateExecutionWorkspaceSchema.safeParse({}).success).toBe(true);
  });

  it("accepts valid status updates", () => {
    for (const status of ["active", "idle", "in_review", "archived", "cleanup_failed"]) {
      expect(updateExecutionWorkspaceSchema.safeParse({ status }).success).toBe(true);
    }
  });

  it("rejects an invalid status", () => {
    expect(updateExecutionWorkspaceSchema.safeParse({ status: "deleted" }).success).toBe(false);
  });

  it("accepts cleanupEligibleAt as ISO datetime", () => {
    const result = updateExecutionWorkspaceSchema.safeParse({
      cleanupEligibleAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects cleanupEligibleAt as non-ISO string", () => {
    expect(updateExecutionWorkspaceSchema.safeParse({ cleanupEligibleAt: "2026-01-01" }).success).toBe(false);
  });

  it("rejects unknown fields (strict schema)", () => {
    expect(updateExecutionWorkspaceSchema.safeParse({ unknownField: true }).success).toBe(false);
  });

  it("accepts config with valid values", () => {
    const result = updateExecutionWorkspaceSchema.safeParse({
      config: { desiredState: "stopped", provisionCommand: "make setup" },
    });
    expect(result.success).toBe(true);
  });
});

describe("workspaceRuntimeServiceSchema", () => {
  const valid = {
    id: "svc-1",
    companyId: "00000000-0000-0000-0000-000000000001",
    projectId: "00000000-0000-0000-0000-000000000002",
    projectWorkspaceId: null,
    executionWorkspaceId: null,
    issueId: null,
    scopeType: "execution_workspace" as const,
    scopeId: "scope-1",
    serviceName: "api-server",
    status: "running" as const,
    lifecycle: "ephemeral" as const,
    reuseKey: null,
    command: "npm start",
    cwd: "/repo",
    port: 3000,
    url: "http://localhost:3000",
    provider: "local_process" as const,
    providerRef: null,
    ownerAgentId: null,
    startedByRunId: null,
    lastUsedAt: new Date("2026-01-01T00:00:00.000Z"),
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    stoppedAt: null,
    stopPolicy: null,
    healthStatus: "healthy" as const,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("accepts a valid runtime service", () => {
    expect(workspaceRuntimeServiceSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts status values", () => {
    for (const status of ["starting", "running", "stopped", "failed"]) {
      expect(workspaceRuntimeServiceSchema.safeParse({ ...valid, status }).success).toBe(true);
    }
  });

  it("accepts lifecycle values", () => {
    for (const lifecycle of ["shared", "ephemeral"]) {
      expect(workspaceRuntimeServiceSchema.safeParse({ ...valid, lifecycle }).success).toBe(true);
    }
  });

  it("accepts provider values", () => {
    for (const provider of ["local_process", "adapter_managed"]) {
      expect(workspaceRuntimeServiceSchema.safeParse({ ...valid, provider }).success).toBe(true);
    }
  });

  it("rejects unknown fields (strict schema)", () => {
    expect(workspaceRuntimeServiceSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});

describe("executionWorkspaceCloseReadinessSchema", () => {
  const valid = {
    workspaceId: "00000000-0000-0000-0000-000000000001",
    state: "ready" as const,
    blockingReasons: [],
    warnings: [],
    linkedIssues: [],
    plannedActions: [],
    isDestructiveCloseAllowed: false,
    isSharedWorkspace: false,
    isProjectPrimaryWorkspace: false,
    git: null,
    runtimeServices: [],
  };

  it("accepts a minimal valid readiness response", () => {
    expect(executionWorkspaceCloseReadinessSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a non-uuid workspaceId", () => {
    expect(
      executionWorkspaceCloseReadinessSchema.safeParse({ ...valid, workspaceId: "not-uuid" }).success,
    ).toBe(false);
  });

  it("rejects unknown fields (strict schema)", () => {
    expect(executionWorkspaceCloseReadinessSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});
