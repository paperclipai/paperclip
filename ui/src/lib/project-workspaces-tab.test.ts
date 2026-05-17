import { describe, expect, it } from "vitest";
import type { ExecutionWorkspace, Issue, Project, ProjectWorkspace, WorkspaceRuntimeService } from "@paperclipai/shared";
import { buildProjectWorkspaceSummaries } from "./project-workspaces-tab";

function createProjectWorkspace(overrides: Partial<ProjectWorkspace>): ProjectWorkspace {
  return {
    id: overrides.id ?? "workspace-default",
    companyId: overrides.companyId ?? "company-1",
    projectId: overrides.projectId ?? "project-1",
    name: overrides.name ?? "paperclip",
    sourceType: overrides.sourceType ?? "local_path",
    cwd: overrides.cwd ?? "/repo",
    repoUrl: overrides.repoUrl ?? null,
    repoRef: overrides.repoRef ?? null,
    defaultRef: overrides.defaultRef ?? null,
    visibility: overrides.visibility ?? "default",
    setupCommand: overrides.setupCommand ?? null,
    cleanupCommand: overrides.cleanupCommand ?? null,
    remoteProvider: overrides.remoteProvider ?? null,
    remoteWorkspaceRef: overrides.remoteWorkspaceRef ?? null,
    sharedWorkspaceKey: overrides.sharedWorkspaceKey ?? null,
    metadata: overrides.metadata ?? null,
    runtimeConfig: overrides.runtimeConfig ?? null,
    isPrimary: overrides.isPrimary ?? false,
    runtimeServices: overrides.runtimeServices ?? [],
    createdAt: overrides.createdAt ?? new Date("2026-03-20T00:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-03-20T00:00:00Z"),
  };
}

function createIssue(overrides: Partial<Issue>): Issue {
  return {
    id: overrides.id ?? "issue-1",
    companyId: overrides.companyId ?? "company-1",
    projectId: overrides.projectId ?? "project-1",
    projectWorkspaceId: overrides.projectWorkspaceId ?? null,
    goalId: overrides.goalId ?? null,
    parentId: overrides.parentId ?? null,
    title: overrides.title ?? "Issue",
    description: overrides.description ?? null,
    status: overrides.status ?? "todo",
    priority: overrides.priority ?? "medium",
    assigneeAgentId: overrides.assigneeAgentId ?? null,
    assigneeUserId: overrides.assigneeUserId ?? null,
    checkoutRunId: overrides.checkoutRunId ?? null,
    executionRunId: overrides.executionRunId ?? null,
    executionAgentNameKey: overrides.executionAgentNameKey ?? null,
    executionLockedAt: overrides.executionLockedAt ?? null,
    createdByAgentId: overrides.createdByAgentId ?? null,
    createdByUserId: overrides.createdByUserId ?? null,
    issueNumber: overrides.issueNumber ?? null,
    identifier: overrides.identifier ?? null,
    requestDepth: overrides.requestDepth ?? 0,
    billingCode: overrides.billingCode ?? null,
    assigneeAdapterOverrides: overrides.assigneeAdapterOverrides ?? null,
    executionWorkspaceId: overrides.executionWorkspaceId ?? null,
    executionWorkspacePreference: overrides.executionWorkspacePreference ?? null,
    executionWorkspaceSettings: overrides.executionWorkspaceSettings ?? null,
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    cancelledAt: overrides.cancelledAt ?? null,
    hiddenAt: overrides.hiddenAt ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-03-20T00:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-03-20T00:00:00Z"),
  } as Issue;
}

function createExecutionWorkspace(overrides: Partial<ExecutionWorkspace>): ExecutionWorkspace {
  return {
    id: overrides.id ?? "exec-1",
    companyId: overrides.companyId ?? "company-1",
    projectId: overrides.projectId ?? "project-1",
    projectWorkspaceId: overrides.projectWorkspaceId ?? "workspace-default",
    sourceIssueId: overrides.sourceIssueId ?? null,
    mode: overrides.mode ?? "isolated_workspace",
    strategyType: overrides.strategyType ?? "git_worktree",
    name: overrides.name ?? "PAP-893",
    status: overrides.status ?? "active",
    cwd: overrides.cwd ?? "/repo/.worktrees/PAP-893",
    repoUrl: overrides.repoUrl ?? null,
    baseRef: overrides.baseRef ?? "public-gh/master",
    branchName: overrides.branchName ?? "PAP-893-workspaces-tab",
    providerType: overrides.providerType ?? "git_worktree",
    providerRef: overrides.providerRef ?? null,
    derivedFromExecutionWorkspaceId: overrides.derivedFromExecutionWorkspaceId ?? null,
    lastUsedAt: overrides.lastUsedAt ?? new Date("2026-03-26T10:00:00Z"),
    openedAt: overrides.openedAt ?? new Date("2026-03-26T09:00:00Z"),
    closedAt: overrides.closedAt ?? null,
    cleanupEligibleAt: overrides.cleanupEligibleAt ?? null,
    cleanupReason: overrides.cleanupReason ?? null,
    config: overrides.config ?? null,
    metadata: overrides.metadata ?? null,
    runtimeServices: overrides.runtimeServices ?? [],
    createdAt: overrides.createdAt ?? new Date("2026-03-26T09:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-03-26T09:30:00Z"),
  };
}

function createRuntimeService(overrides: Partial<WorkspaceRuntimeService> = {}): WorkspaceRuntimeService {
  return {
    id: overrides.id ?? "service-1",
    companyId: overrides.companyId ?? "company-1",
    projectId: overrides.projectId ?? "project-1",
    projectWorkspaceId: overrides.projectWorkspaceId ?? null,
    executionWorkspaceId: overrides.executionWorkspaceId ?? null,
    issueId: overrides.issueId ?? null,
    scopeType: overrides.scopeType ?? "execution_workspace",
    scopeId: overrides.scopeId ?? null,
    serviceName: overrides.serviceName ?? "preview",
    status: overrides.status ?? "running",
    lifecycle: overrides.lifecycle ?? "ephemeral",
    reuseKey: overrides.reuseKey ?? null,
    command: overrides.command ?? null,
    cwd: overrides.cwd ?? null,
    port: overrides.port ?? 3100,
    url: overrides.url ?? "http://127.0.0.1:3100",
    provider: overrides.provider ?? "local_process",
    providerRef: overrides.providerRef ?? null,
    ownerAgentId: overrides.ownerAgentId ?? null,
    startedByRunId: overrides.startedByRunId ?? null,
    lastUsedAt: overrides.lastUsedAt ?? new Date("2026-03-26T10:00:00Z"),
    startedAt: overrides.startedAt ?? new Date("2026-03-26T09:00:00Z"),
    stoppedAt: overrides.stoppedAt ?? null,
    stopPolicy: overrides.stopPolicy ?? null,
    healthStatus: overrides.healthStatus ?? "healthy",
    configIndex: overrides.configIndex ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-03-26T09:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-03-26T09:30:00Z"),
  };
}

describe("buildProjectWorkspaceSummaries", () => {
  const primaryWorkspace = createProjectWorkspace({
    id: "workspace-default",
    isPrimary: true,
    name: "paperclip",
  });
  const featureWorkspace = createProjectWorkspace({
    id: "workspace-feature",
    name: "feature-checkout",
    repoRef: "feature/workspaces",
    updatedAt: new Date("2026-03-25T09:00:00Z"),
  });
  const project = {
    workspaces: [primaryWorkspace, featureWorkspace],
    primaryWorkspace,
  } satisfies Pick<Project, "workspaces" | "primaryWorkspace">;

  it("groups isolated execution workspace issues ahead of shared non-primary workspace issues", () => {
    const summaries = buildProjectWorkspaceSummaries({
      project,
      issues: [
        createIssue({
          id: "issue-primary",
          projectWorkspaceId: primaryWorkspace.id,
          updatedAt: new Date("2026-03-26T08:00:00Z"),
        }),
        createIssue({
          id: "issue-feature-older",
          projectWorkspaceId: featureWorkspace.id,
          identifier: "PAP-800",
          updatedAt: new Date("2026-03-25T10:00:00Z"),
        }),
        createIssue({
          id: "issue-feature-newer",
          projectWorkspaceId: featureWorkspace.id,
          identifier: "PAP-801",
          updatedAt: new Date("2026-03-25T11:00:00Z"),
        }),
        createIssue({
          id: "issue-exec",
          projectWorkspaceId: primaryWorkspace.id,
          executionWorkspaceId: "exec-1",
          identifier: "PAP-893",
          updatedAt: new Date("2026-03-26T11:00:00Z"),
        }),
      ],
      executionWorkspaces: [
        createExecutionWorkspace({
          id: "exec-1",
          name: "PAP-893",
          branchName: "PAP-893-workspaces-tab",
          lastUsedAt: new Date("2026-03-26T10:30:00Z"),
        }),
      ],
    });

    expect(summaries).toHaveLength(3);
    expect(summaries[0]).toMatchObject({
      key: "execution:exec-1",
      kind: "execution_workspace",
      workspaceName: "PAP-893",
      branchName: "PAP-893-workspaces-tab",
      executionWorkspaceId: "exec-1",
    });
    expect(summaries[0]?.issues.map((issue) => issue.id)).toEqual(["issue-exec"]);

    expect(summaries[1]).toMatchObject({
      key: "project:workspace-feature",
      kind: "project_workspace",
      workspaceName: "feature-checkout",
      branchName: "feature/workspaces",
      projectWorkspaceId: "workspace-feature",
    });
    expect(summaries[1]?.issues.map((issue) => issue.id)).toEqual([
      "issue-feature-newer",
      "issue-feature-older",
    ]);
    expect(summaries[2]?.key).toBe("project:workspace-default");
  });

  it("does not duplicate non-primary workspace issues when an execution workspace owns them", () => {
    const summaries = buildProjectWorkspaceSummaries({
      project,
      issues: [
        createIssue({
          id: "issue-exec-derived",
          projectWorkspaceId: featureWorkspace.id,
          executionWorkspaceId: "exec-2",
          updatedAt: new Date("2026-03-26T12:00:00Z"),
        }),
      ],
      executionWorkspaces: [
        createExecutionWorkspace({
          id: "exec-2",
          projectWorkspaceId: featureWorkspace.id,
          name: "feature-branch run",
        }),
      ],
    });

    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.key).toBe("execution:exec-2");
    expect(summaries[1]?.key).toBe("project:workspace-default");
  });

  it("excludes issues that only use the default shared workspace", () => {
    const summaries = buildProjectWorkspaceSummaries({
      project,
      issues: [
        createIssue({
          id: "issue-default-shared",
          projectWorkspaceId: primaryWorkspace.id,
          executionWorkspaceId: "exec-shared-default",
          updatedAt: new Date("2026-03-26T12:00:00Z"),
        }),
      ],
      executionWorkspaces: [
        createExecutionWorkspace({
          id: "exec-shared-default",
          mode: "shared_workspace",
          strategyType: "project_primary",
          projectWorkspaceId: primaryWorkspace.id,
          branchName: null,
          baseRef: null,
          providerType: "local_fs",
        }),
      ],
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.key).toBe("project:workspace-default");
  });

  it("sorts workspaces with running services first and marks live service urls", () => {
    const summaries = buildProjectWorkspaceSummaries({
      project,
      issues: [
        createIssue({
          id: "issue-stopped",
          executionWorkspaceId: "exec-stopped",
          updatedAt: new Date("2026-03-27T12:00:00Z"),
        }),
        createIssue({
          id: "issue-live",
          executionWorkspaceId: "exec-live",
          updatedAt: new Date("2026-03-25T12:00:00Z"),
        }),
      ],
      executionWorkspaces: [
        createExecutionWorkspace({
          id: "exec-stopped",
          name: "newer stopped",
          lastUsedAt: new Date("2026-03-27T12:00:00Z"),
          runtimeServices: [
            createRuntimeService({
              id: "service-stopped",
              executionWorkspaceId: "exec-stopped",
              status: "stopped",
              url: "http://127.0.0.1:4100",
            }),
          ],
        }),
        createExecutionWorkspace({
          id: "exec-live",
          name: "older live",
          lastUsedAt: new Date("2026-03-25T12:00:00Z"),
          runtimeServices: [
            createRuntimeService({
              id: "service-live",
              executionWorkspaceId: "exec-live",
              status: "running",
              url: "http://127.0.0.1:4200",
            }),
          ],
        }),
      ],
    });

    expect(summaries[0]).toMatchObject({
      key: "execution:exec-live",
      primaryServiceUrl: "http://127.0.0.1:4200",
      primaryServiceUrlRunning: true,
      runningServiceCount: 1,
    });
    expect(summaries[1]).toMatchObject({
      key: "execution:exec-stopped",
      primaryServiceUrl: "http://127.0.0.1:4100",
      primaryServiceUrlRunning: false,
      runningServiceCount: 0,
    });
  });
});
