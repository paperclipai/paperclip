// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExecutionWorkspace, Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectWorkspaceSummary } from "../lib/project-workspaces-tab";
import { queryKeys } from "../lib/queryKeys";
import { ProjectWorkspaceSummaryCard } from "./ProjectWorkspaceSummaryCard";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));

vi.mock("./IssuesQuicklook", () => ({
  IssuesQuicklook: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The card reads the managed-sandbox-only policy through the shared
 * instance-settings query, so every render needs a query client. Renders here
 * are synchronous and the path guard fails closed until the policy resolves, so
 * the cache is primed by default. Pass `null` to leave the policy unresolved.
 */
function withQueryClient(node: ReactNode, experimentalSettings: Record<string, unknown> | null = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (experimentalSettings) {
    queryClient.setQueryData(queryKeys.instance.experimentalSettings, experimentalSettings);
  }
  return <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>;
}

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  const maybePromise = result as Promise<void> | undefined;
  if (maybePromise !== undefined && typeof maybePromise.then === "function") {
    return maybePromise.then(() => {
      flushSync(() => {});
    });
  }
  return result;
}

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
  const issues = overrides.issues ?? [
    createIssue({ id: "issue-1", identifier: "PAP-1364" }),
    createIssue({ id: "issue-2", identifier: "PAP-1367" }),
    createIssue({ id: "issue-3", identifier: "PAP-1362" }),
    createIssue({ id: "issue-4", identifier: "PAP-1363" }),
    createIssue({ id: "issue-5", identifier: "PAP-1340" }),
  ];
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
    primaryServiceUrlRunning: overrides.primaryServiceUrlRunning ?? false,
    hasRuntimeConfig: overrides.hasRuntimeConfig ?? true,
    linkedIssueCount: overrides.linkedIssueCount ?? issues.length,
    issues,
  };
}

describe("ProjectWorkspaceSummaryCard", () => {
  let container: HTMLDivElement;
  let writeClipboard: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    writeClipboard = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: writeClipboard },
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("keeps the path row hidden while the policy is still loading", () => {
    // A cold cache resolves the policy to false on the first render. The guard
    // fails closed so a managed instance never flashes the execution-host path.
    const root = createRoot(container);
    act(() => {
      root.render(withQueryClient(
        <ProjectWorkspaceSummaryCard
          projectRef="paperclip-app"
          summary={createSummary()}
          runtimeActionKey={null}
          runtimeActionPending={false}
          onRuntimeAction={() => {}}
          onCloseWorkspace={() => {}}
        />,
        null,
      ));
    });

    expect(container.textContent).not.toContain("Path");
    expect(container.textContent).toContain("Branch");

    act(() => {
      root.unmount();
    });
  });

  it("keeps the path row hidden when the policy read fails", async () => {
    // A failed settings read leaves the policy unknown, and an unknown policy
    // must not be read as "not managed". React Query reports such a query as
    // fetched with no data, so a guard keyed on "fetched" would show the
    // execution-host path on exactly the managed instance whose settings
    // endpoint is unreachable.
    mockInstanceSettingsApi.getExperimental.mockRejectedValue(new Error("settings unavailable"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProjectWorkspaceSummaryCard
            projectRef="paperclip-app"
            summary={createSummary()}
            runtimeActionKey={null}
            runtimeActionPending={false}
            onRuntimeAction={() => {}}
            onCloseWorkspace={() => {}}
          />
        </QueryClientProvider>,
      );
    });

    // Drive the rejected query all the way to a settled failure, so the
    // assertion below covers the resolved-error case and not merely the
    // in-flight one the loading test already covers.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (queryClient.getQueryState(queryKeys.instance.experimentalSettings)?.status === "error") break;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(queryClient.getQueryState(queryKeys.instance.experimentalSettings)?.status).toBe("error");

    expect(container.textContent).not.toContain("Path");
    expect(container.textContent).toContain("Branch");

    act(() => {
      root.unmount();
    });
  });

  it("drops the path row when the instance runs agents only in the platform-managed environment", () => {
    const root = createRoot(container);
    act(() => {
      root.render(withQueryClient(
        <ProjectWorkspaceSummaryCard
          projectRef="paperclip-app"
          summary={createSummary()}
          runtimeActionKey={null}
          runtimeActionPending={false}
          onRuntimeAction={() => {}}
          onCloseWorkspace={() => {}}
        />,
        { enableManagedSandboxOnly: true },
      ));
    });

    expect(container.textContent).not.toContain("Path");
    // Branch, service, and linked-task rows describe the workspace, not the host.
    expect(container.textContent).toContain("Branch");
    expect(container.textContent).toContain("Service");
    expect(container.textContent).toContain("Linked tasks");

    act(() => {
      root.unmount();
    });
  });

  it("renders a stacked mobile-friendly summary with metadata labels and compact issue pills", () => {
    const root = createRoot(container);
    act(() => {
      root.render(withQueryClient(
        <ProjectWorkspaceSummaryCard
          projectRef="paperclip-app"
          summary={createSummary()}
          runtimeActionKey={null}
          runtimeActionPending={false}
          onRuntimeAction={() => {}}
          onCloseWorkspace={() => {}}
        />,
      ));
    });

    expect(container.textContent).toContain("Execution workspace");
    expect(container.textContent).toContain("Branch");
    expect(container.textContent).toContain("Path");
    expect(container.textContent).toContain("Service");
    expect(container.textContent).toContain("Linked tasks");
    expect(container.textContent).toContain("Start services");
    expect(container.textContent).toContain("Close workspace");
    expect(container.textContent).toContain("+1 more");

    const actions = container.querySelector('[data-testid="workspace-summary-actions"]');
    expect(actions?.className).toContain("flex-col");
    const card = container.firstElementChild;
    expect(card?.className).toContain("rounded-lg");
    expect(card?.className).toContain("border");

    act(() => {
      root.unmount();
    });
  });

  it("uses project workspace routes and omits close controls for project workspaces", () => {
    const runtimeSpy = vi.fn();
    const closeSpy = vi.fn();
    const root = createRoot(container);

    act(() => {
      root.render(withQueryClient(
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
      ));
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
      root.render(withQueryClient(
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
      ));
    });

    expect(container.textContent).toContain("Retry close");

    act(() => {
      root.unmount();
    });
  });

  it("copies branch and path from both text and icon controls with feedback", async () => {
    const root = createRoot(container);
    const summary = createSummary({
      branchName: "PAP-1552-workspace-polish",
      cwd: "/Users/dotta/paperclip/.worktrees/PAP-1552-workspace-polish",
    });

    await act(async () => {
      root.render(withQueryClient(
        <ProjectWorkspaceSummaryCard
          projectRef="paperclip-app"
          summary={summary}
          runtimeActionKey={null}
          runtimeActionPending={false}
          onRuntimeAction={() => {}}
          onCloseWorkspace={() => {}}
        />,
      ));
    });

    const branchTextButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === summary.branchName);
    const pathTextButton = container.querySelector(`button[title="${summary.cwd}"]`);
    const branchIconButton = container.querySelector('button[aria-label="Copy branch"]');
    const pathIconButton = container.querySelector('button[aria-label="Copy path"]');

    expect(branchTextButton).not.toBeNull();
    expect(pathTextButton).not.toBeNull();
    expect(branchIconButton).not.toBeNull();
    expect(pathIconButton).not.toBeNull();

    await act(async () => {
      branchTextButton!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(writeClipboard).toHaveBeenLastCalledWith(summary.branchName);
    expect(branchTextButton?.nextElementSibling?.className).toContain("opacity-100");

    await act(async () => {
      pathTextButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(writeClipboard).toHaveBeenLastCalledWith(summary.cwd);
    expect(pathTextButton?.nextElementSibling?.className).toContain("opacity-100");

    await act(async () => {
      branchIconButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      pathIconButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(writeClipboard).toHaveBeenCalledWith(summary.branchName);
    expect(writeClipboard).toHaveBeenCalledWith(summary.cwd);

    act(() => {
      root.unmount();
    });
  });
  it("colors live service urls green", () => {
    const root = createRoot(container);

    act(() => {
      root.render(withQueryClient(
        <ProjectWorkspaceSummaryCard
          projectRef="paperclip-app"
          summary={createSummary({
            primaryServiceUrl: "http://127.0.0.1:62475",
            primaryServiceUrlRunning: true,
            runningServiceCount: 1,
          })}
          runtimeActionKey={null}
          runtimeActionPending={false}
          onRuntimeAction={() => {}}
          onCloseWorkspace={() => {}}
        />,
      ));
    });

    const serviceLink = container.querySelector("a[href='http://127.0.0.1:62475']");
    expect(serviceLink?.className).toContain("text-emerald");

    act(() => {
      root.unmount();
    });
  });
});
