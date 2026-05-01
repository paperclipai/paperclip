// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, ExecutionWorkspace, Project } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutineRunVariablesDialog } from "./RoutineRunVariablesDialog";

let issueWorkspaceDraftCalls = 0;
let issueWorkspaceDraft = {
  executionWorkspaceId: null as string | null,
  executionWorkspacePreference: "shared_workspace",
  executionWorkspaceSettings: { mode: "shared_workspace" },
};
let issueWorkspaceBranchName: string | null = null;
let latestWorkspaceIssue: Record<string, unknown> | null = null;

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: {
    getExperimental: vi.fn(async () => ({ enableIsolatedWorkspaces: true })),
  },
}));

vi.mock("./IssueWorkspaceCard", async () => {
  const React = await import("react");

  return {
    IssueWorkspaceCard: ({
      issue,
      onDraftChange,
    }: {
      issue: Record<string, unknown>;
      onDraftChange?: (
        data: Record<string, unknown>,
        meta: { canSave: boolean; workspaceBranchName?: string | null },
      ) => void;
    }) => {
      React.useEffect(() => {
        latestWorkspaceIssue = issue;
        issueWorkspaceDraftCalls += 1;
        if (issueWorkspaceDraftCalls > 20) {
          throw new Error("IssueWorkspaceCard onDraftChange looped");
        }
        onDraftChange?.(issueWorkspaceDraft, {
          canSave: true,
          workspaceBranchName: issueWorkspaceBranchName,
        });
      }, [onDraftChange]);

      return <div data-testid="workspace-card">Workspace card</div>;
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createProject(): Project {
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "workspace-project",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Workspace project",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: "#22c55e",
    env: null,
    pauseReason: null,
    pausedAt: null,
    archivedAt: null,
    executionWorkspacePolicy: {
      enabled: true,
      defaultMode: "shared_workspace",
      allowIssueOverride: true,
    },
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/paperclip/project-1",
      effectiveLocalFolder: "/tmp/paperclip/project-1",
      origin: "managed_checkout",
    },
    workspaces: [],
    primaryWorkspace: null,
    createdAt: new Date("2026-04-02T00:00:00.000Z"),
    updatedAt: new Date("2026-04-02T00:00:00.000Z"),
  };
}

function createAgent(): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Routine Agent",
    role: "engineer",
    title: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    lastHeartbeatAt: null,
    icon: "code",
    metadata: null,
    createdAt: new Date("2026-04-02T00:00:00.000Z"),
    updatedAt: new Date("2026-04-02T00:00:00.000Z"),
    urlKey: "routine-agent",
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
  };
}

function createExecutionWorkspace(): ExecutionWorkspace {
  return {
    id: "workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "project-workspace-1",
    sourceIssueId: null,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "PAP-1634",
    status: "active",
    cwd: "/tmp/paperclip/PAP-1634",
    repoUrl: null,
    baseRef: "main",
    branchName: "pap-1634-routine-branch",
    providerType: "local_fs",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date("2026-04-02T00:00:00.000Z"),
    openedAt: new Date("2026-04-02T00:00:00.000Z"),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: {
      provisionCommand: null,
      teardownCommand: null,
      cleanupCommand: null,
      workspaceRuntime: null,
      desiredState: null,
    },
    metadata: null,
    runtimeServices: [],
    createdAt: new Date("2026-04-02T00:00:00.000Z"),
    updatedAt: new Date("2026-04-02T00:00:00.000Z"),
  };
}

describe("RoutineRunVariablesDialog", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    issueWorkspaceDraftCalls = 0;
    issueWorkspaceDraft = {
      executionWorkspaceId: null,
      executionWorkspacePreference: "shared_workspace",
      executionWorkspaceSettings: { mode: "shared_workspace" },
    };
    issueWorkspaceBranchName = null;
    latestWorkspaceIssue = null;
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("does not loop when the workspace card reports the same draft repeatedly", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RoutineRunVariablesDialog
            open
            onOpenChange={() => {}}
            companyId="company-1"
            projects={[createProject()]}
            agents={[createAgent()]}
            defaultProjectId="project-1"
            defaultAssigneeAgentId="agent-1"
            variables={[]}
            isPending={false}
            onSubmit={() => {}}
          />
        </QueryClientProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(issueWorkspaceDraftCalls).toBeLessThanOrEqual(2);
    expect(document.body.textContent).toContain("Run routine");
    expect(document.body.textContent).not.toContain("Search agents...");
    expect(document.body.textContent).not.toContain("Search projects...");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders workspaceBranch as a read-only selected workspace value", async () => {
    issueWorkspaceDraft = {
      executionWorkspaceId: "workspace-1",
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    };
    issueWorkspaceBranchName = "pap-1634-routine-branch";
    const onSubmit = vi.fn();
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RoutineRunVariablesDialog
            open
            onOpenChange={() => {}}
            companyId="company-1"
            projects={[createProject()]}
            agents={[createAgent()]}
            defaultProjectId="project-1"
            defaultAssigneeAgentId="agent-1"
            variables={[
              {
                name: "workspaceBranch",
                label: null,
                type: "text",
                defaultValue: null,
                required: true,
                options: [],
              },
            ]}
            isPending={false}
            onSubmit={onSubmit}
          />
        </QueryClientProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    for (let i = 0; i < 10 && !document.querySelector('[data-testid="workspace-card"]'); i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    const branchInput = Array.from(document.querySelectorAll("input"))
      .find((input) => input.value === "pap-1634-routine-branch");
    expect(branchInput?.disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Missing: workspaceBranch");

    const runButton = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Run routine");
    expect(runButton).toBeTruthy();

    await act(async () => {
      runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSubmit).toHaveBeenCalledWith({
      variables: {
        workspaceBranch: "pap-1634-routine-branch",
      },
      assigneeAgentId: "agent-1",
      projectId: "project-1",
      executionWorkspaceId: "workspace-1",
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("prefills the supplied execution workspace for workspace-specific routine runs", async () => {
    const workspace = createExecutionWorkspace();
    issueWorkspaceDraft = {
      executionWorkspaceId: workspace.id,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    };
    issueWorkspaceBranchName = workspace.branchName;

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RoutineRunVariablesDialog
            open
            onOpenChange={() => {}}
            companyId="company-1"
            projects={[createProject()]}
            agents={[createAgent()]}
            defaultProjectId="project-1"
            defaultAssigneeAgentId="agent-1"
            defaultExecutionWorkspace={workspace}
            variables={[]}
            isPending={false}
            onSubmit={() => {}}
          />
        </QueryClientProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    for (let i = 0; i < 10 && latestWorkspaceIssue === null; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(latestWorkspaceIssue).toMatchObject({
      executionWorkspaceId: workspace.id,
      executionWorkspacePreference: "reuse_existing",
      currentExecutionWorkspace: workspace,
      projectWorkspaceId: workspace.projectWorkspaceId,
    });

    await act(async () => {
      root.unmount();
    });
  });
});
