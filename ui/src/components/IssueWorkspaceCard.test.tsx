// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import type { ExecutionWorkspace, Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueWorkspaceCard } from "./IssueWorkspaceCard";

const useQueryMock = vi.fn();

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: (options: unknown) => useQueryMock(options),
  };
});

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, ...props }: ComponentProps<"a">) => (
    <a className={className} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createExecutionWorkspace(overrides: Partial<ExecutionWorkspace> = {}): ExecutionWorkspace {
  return {
    id: "workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "project-workspace-1",
    sourceIssueId: null,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "Issue sandbox",
    status: "active",
    cwd: "/tmp/issue-sandbox",
    repoUrl: null,
    baseRef: null,
    branchName: "paperclip/papa-81",
    providerType: "git_worktree",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date("2026-04-16T05:00:00.000Z"),
    openedAt: new Date("2026-04-16T04:59:00.000Z"),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: {
      environmentId: "env-workspace",
      provisionCommand: null,
      teardownCommand: null,
      cleanupCommand: null,
      workspaceRuntime: null,
      desiredState: null,
    },
    metadata: null,
    runtimeServices: [],
    createdAt: new Date("2026-04-16T04:59:00.000Z"),
    updatedAt: new Date("2026-04-16T05:00:00.000Z"),
    ...overrides,
  };
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAPA-81",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "project-workspace-1",
    goalId: null,
    parentId: null,
    title: "Sandboxing",
    description: null,
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 81,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: "workspace-1",
    executionWorkspacePreference: "isolated_workspace",
    executionWorkspaceSettings: {
      mode: "isolated_workspace",
      environmentId: "env-issue",
    },
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    scheduledFor: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-16T04:30:00.000Z"),
    updatedAt: new Date("2026-04-16T05:30:00.000Z"),
    labels: [],
    labelIds: [],
    currentExecutionWorkspace: null,
    ...overrides,
  };
}

describe("IssueWorkspaceCard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    useQueryMock.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  it("locks the environment selector and clears the issue override when reusing a workspace", () => {
    const root = createRoot(container);
    const onUpdate = vi.fn();
    const reusableWorkspace = createExecutionWorkspace();

    useQueryMock.mockImplementation((options: { queryKey: unknown[] }) => {
      if (options.queryKey[0] === "instance") {
        return { data: { enableEnvironments: true, enableIsolatedWorkspaces: true } };
      }
      if (options.queryKey[0] === "environments") {
        return {
          data: [{ id: "env-workspace", name: "Local", driver: "local" }],
        };
      }
      if (options.queryKey[0] === "execution-workspaces") {
        return { data: [reusableWorkspace] };
      }
      return { data: undefined };
    });

    act(() => {
      root.render(
        <IssueWorkspaceCard
          issue={createIssue()}
          project={{
            id: "project-1",
            executionWorkspacePolicy: {
              enabled: true,
              defaultMode: "isolated_workspace",
              environmentId: "env-project",
            },
          }}
          onUpdate={onUpdate}
        />,
      );
    });

    const editButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Edit"));
    expect(editButton).not.toBeUndefined();

    act(() => {
      editButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const selects = container.querySelectorAll("select");
    expect(selects).toHaveLength(3);

    const environmentSelect = selects[2] as HTMLSelectElement;
    expect(environmentSelect.disabled).toBe(true);
    expect(environmentSelect.value).toBe("env-workspace");
    expect(container.textContent).toContain("Environment selection is locked while reusing an existing workspace.");

    const saveButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Save"));
    expect(saveButton).not.toBeUndefined();

    act(() => {
      saveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceId: "workspace-1",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        environmentId: null,
      },
    });

    act(() => {
      root.unmount();
    });
  });

  it("hides environment UI when environments are disabled", () => {
    const root = createRoot(container);

    useQueryMock.mockImplementation((options: { queryKey: unknown[] }) => {
      if (options.queryKey[0] === "instance") {
        return { data: { enableEnvironments: false, enableIsolatedWorkspaces: true } };
      }
      if (options.queryKey[0] === "execution-workspaces") {
        return { data: [createExecutionWorkspace()] };
      }
      return { data: undefined };
    });

    act(() => {
      root.render(
        <IssueWorkspaceCard
          issue={createIssue()}
          project={{
            id: "project-1",
            executionWorkspacePolicy: {
              enabled: true,
              defaultMode: "isolated_workspace",
              environmentId: "env-project",
            },
          }}
          onUpdate={vi.fn()}
        />,
      );
    });

    expect(container.textContent).not.toContain("Environment:");

    const editButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Edit"));
    expect(editButton).not.toBeUndefined();

    act(() => {
      editButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const selects = container.querySelectorAll("select");
    expect(selects).toHaveLength(2);
    expect(container.textContent).not.toContain("Project default environment");

    act(() => {
      root.unmount();
    });
  });
});
