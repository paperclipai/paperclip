// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ExecutionWorkspace, Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectWorkspaceSummary } from "../lib/project-workspaces-tab";
import { ProjectWorkspaceSummaryCard } from "./ProjectWorkspaceSummaryCard";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));

vi.mock("./IssuesQuicklook", () => ({
  IssuesQuicklook: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./CopyText", () => ({
  CopyText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createIssue(overrides: Partial<Issue> = {}): Issue {
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
    issueNumber: overrides.issueNumber ?? 1,
    identifier: overrides.identifier ?? "PAP-1",
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
    createdAt: overrides.createdAt ?? new Date("2026-04-12T00:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-04-12T00:00:00Z"),
  } as Issue;
}

function createSummary(overrides: Partial<ProjectWorkspaceSummary> = {}): ProjectWorkspaceSummary {
  return {
    key: overrides.key ?? "execution:workspace-1",
    kind: overrides.kind ?? "execution_workspace",
    workspaceId: overrides.workspaceId ?? "workspace-1",
    workspaceName: overrides.workspaceName ?? "PAP-989-multi-user-implementation",
    cwd: overrides.cwd ?? "/worktrees/PAP-989-multi-user-implementation",
    branchName: overrides.branchName ?? "PAP-989-multi-user-implementation",
    lastUpdatedAt: overrides.lastUpdatedAt ?? new Date("2026-04-12T00:00:00Z"),
    projectWorkspaceId: overrides.projectWorkspaceId ?? "project-workspace-1",
    executionWorkspaceId: overrides.executionWorkspaceId ?? "workspace-1",
    executionWorkspaceStatus: overrides.executionWorkspaceStatus ?? "active",
    serviceCount: overrides.serviceCount ?? 2,
    runningServiceCount: overrides.runningServiceCount ?? 0,
    primaryServiceUrl: overrides.primaryServiceUrl ?? "http://127.0.0.1:62474",
    hasRuntimeConfig: overrides.hasRuntimeConfig ?? true,
    issues: overrides.issues ?? [
      createIssue({ id: "issue-1", identifier: "PAP-1364" }),
      createIssue({ id: "issue-2", identifier: "PAP-1367" }),
      createIssue({ id: "issue-3", identifier: "PAP-1362" }),
      createIssue({ id: "issue-4", identifier: "PAP-1363" }),
      createIssue({ id: "issue-5", identifier: "PAP-1340" }),
    ],
  };
}

describe("ProjectWorkspaceSummaryCard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a stacked mobile-friendly summary with metadata labels and compact issue pills", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <ProjectWorkspaceSummaryCard
          projectRef="paperclip-app"
          summary={createSummary()}
          runtimeActionKey={null}
          runtimeActionPending={false}
          onRuntimeAction={() => {}}
          onCloseWorkspace={() => {}}
        />,
      );
    });

    expect(container.textContent).toContain("Execution workspace");
    expect(container.textContent).toContain("Branch");
    expect(container.textContent).toContain("Path");
    expect(container.textContent).toContain("Service");
    expect(container.textContent).toContain("Linked issues");
    expect(container.textContent).toContain("Start services");
    expect(container.textContent).toContain("Close workspace");
    expect(container.textContent).toContain("+1 more");

    const actions = container.querySelector('[data-testid="workspace-summary-actions"]');
    expect(actions?.className).toContain("flex-col");

    act(() => {
      root.unmount();
    });
  });

  it("uses project workspace routes and omits close controls for project workspaces", () => {
    const runtimeSpy = vi.fn();
    const closeSpy = vi.fn();
    const root = createRoot(container);

    act(() => {
      root.render(
        <ProjectWorkspaceSummaryCard
          projectRef="paperclip-app"
          summary={createSummary({
            key: "project:workspace-2",
            kind: "project_workspace",
            executionWorkspaceId: null,
            executionWorkspaceStatus: null,
            hasRuntimeConfig: false,
            issues: [createIssue({ id: "issue-6", identifier: "PAP-1400" })],
          })}
          runtimeActionKey={null}
          runtimeActionPending={false}
          onRuntimeAction={runtimeSpy}
          onCloseWorkspace={closeSpy}
        />,
      );
    });

    const titleLink = container.querySelector("a[href='/projects/paperclip-app/workspaces/workspace-1']");
    expect(titleLink).not.toBeNull();
    expect(container.textContent).not.toContain("Close workspace");
    expect(container.textContent).not.toContain("Start services");

    act(() => {
      root.unmount();
    });
  });

  it("shows retry close for cleanup failures", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ProjectWorkspaceSummaryCard
          projectRef="paperclip-app"
          summary={createSummary({
            executionWorkspaceStatus: "cleanup_failed" as ExecutionWorkspace["status"],
          })}
          runtimeActionKey={null}
          runtimeActionPending={false}
          onRuntimeAction={() => {}}
          onCloseWorkspace={() => {}}
        />,
      );
    });

    expect(container.textContent).toContain("Retry close");

    act(() => {
      root.unmount();
    });
  });
});
