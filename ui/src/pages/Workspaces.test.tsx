// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkspaceOverviewItem, WorkspaceOverviewResponse } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspaces } from "./Workspaces";

const mockExecutionWorkspacesApi = vi.hoisted(() => ({
  listOverview: vi.fn(),
  list: vi.fn(),
  controlRuntimeServices: vi.fn(),
  getCloseReadiness: vi.fn(),
  update: vi.fn(),
}));
const mockInstanceSettingsApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSummarySlotCard = vi.hoisted(() => vi.fn());

vi.mock("../api/execution-workspaces", () => ({ executionWorkspacesApi: mockExecutionWorkspacesApi }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));
vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
}));
vi.mock("../components/IssuesQuicklook", () => ({
  IssuesQuicklook: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../components/SummarySlotCard", () => ({
  SummarySlotCard: (props: unknown) => {
    mockSummarySlotCard(props);
    return <div data-testid="summary-slot-card">Workspaces summary card</div>;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

function overviewItem(overrides: Partial<WorkspaceOverviewItem> = {}): WorkspaceOverviewItem {
  return {
    key: overrides.key ?? "execution:workspace-1",
    kind: "execution_workspace",
    workspaceId: overrides.workspaceId ?? "workspace-1",
    workspaceName: overrides.workspaceName ?? "Workspace Alpha",
    projectId: overrides.projectId ?? "project-1",
    projectUrlKey: overrides.projectUrlKey ?? "paperclip-app",
    projectName: overrides.projectName ?? "Paperclip App",
    mode: overrides.mode ?? "isolated_workspace",
    strategyType: overrides.strategyType ?? "git_worktree",
    cwd: overrides.cwd ?? "/tmp/workspace-alpha",
    branchName: overrides.branchName ?? "PAP-11916-workspaces",
    lastUpdatedAt: overrides.lastUpdatedAt ?? new Date("2026-06-25T01:00:00.000Z"),
    projectWorkspaceId: overrides.projectWorkspaceId ?? null,
    executionWorkspaceId: overrides.executionWorkspaceId ?? overrides.workspaceId ?? "workspace-1",
    executionWorkspaceStatus: overrides.executionWorkspaceStatus ?? "active",
    serviceCount: overrides.serviceCount ?? 1,
    runningServiceCount: overrides.runningServiceCount ?? 1,
    primaryServiceUrl: overrides.primaryServiceUrl ?? "http://localhost:3100",
    primaryServiceUrlRunning: overrides.primaryServiceUrlRunning ?? true,
    primaryService: overrides.primaryService ?? null,
    hasRuntimeConfig: overrides.hasRuntimeConfig ?? true,
    linkedIssueCount: overrides.linkedIssueCount ?? 2,
    linkedIssues: overrides.linkedIssues ?? [
      {
        id: "issue-1",
        identifier: "PAP-11916",
        title: "Use workspace overview data on /workspaces",
        status: "in_progress",
        priority: "medium",
        updatedAt: new Date("2026-06-25T01:05:00.000Z"),
      },
    ],
  };
}

function overviewResponse(overrides: Partial<WorkspaceOverviewResponse> = {}): WorkspaceOverviewResponse {
  const items = overrides.items ?? [overviewItem()];
  return {
    items,
    total: overrides.total ?? items.length,
    limit: overrides.limit ?? 50,
    offset: overrides.offset ?? 0,
    hasMore: overrides.hasMore ?? false,
    nextOffset: overrides.nextOffset ?? null,
  };
}

async function flushQueries() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Workspaces", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockExecutionWorkspacesApi.listOverview.mockResolvedValue(overviewResponse());
    mockExecutionWorkspacesApi.list.mockResolvedValue([]);
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("uses the bounded overview endpoint and renders grouped workspace cards with linked task summaries", async () => {
    mockExecutionWorkspacesApi.listOverview
      .mockResolvedValueOnce(overviewResponse({
        items: [overviewItem()],
        total: 2,
        hasMore: true,
        nextOffset: 50,
      }))
      .mockResolvedValueOnce(overviewResponse({
        items: [
          overviewItem({
            key: "execution:workspace-2",
            workspaceId: "workspace-2",
            workspaceName: "Workspace Beta",
            executionWorkspaceId: "workspace-2",
            runningServiceCount: 0,
            linkedIssueCount: 1,
            linkedIssues: [
              {
                id: "issue-2",
                identifier: "PAP-11917",
                title: "Verify /workspaces performance improvement",
                status: "blocked",
                priority: "medium",
                updatedAt: new Date("2026-06-25T01:06:00.000Z"),
              },
            ],
          }),
        ],
        total: 2,
        offset: 50,
      }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <Workspaces />
        </QueryClientProvider>,
      );
    });
    await flushQueries();

    expect(mockInstanceSettingsApi.getExperimental).toHaveBeenCalled();
    expect(mockExecutionWorkspacesApi.listOverview).toHaveBeenCalledWith("company-1", { offset: 0 });
    expect(mockExecutionWorkspacesApi.list).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Workspaces summary card");
    expect(mockSummarySlotCard).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      scopeKind: "workspaces_overview",
      title: "Workspace summary",
    }));
    const heading = Array.from(container.querySelectorAll("h2")).find((node) => node.textContent === "Workspaces");
    const summaryCard = container.querySelector('[data-testid="summary-slot-card"]');
    expect(heading && summaryCard ? Boolean(heading.compareDocumentPosition(summaryCard) & Node.DOCUMENT_POSITION_FOLLOWING) : false).toBe(true);
    expect(container.textContent).toContain("Paperclip App");
    expect(container.textContent).toContain("Workspace Alpha");
    expect(container.textContent).toContain("PAP-11916");
    expect(container.textContent).toContain("+1 more");
    expect(container.textContent).toContain("Showing 1 of 2 workspaces.");
    expect(container.querySelector('a[href="/projects/paperclip-app/workspaces"]')).not.toBeNull();

    const loadMoreButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Load more");
    expect(loadMoreButton).not.toBeNull();
    await act(async () => {
      loadMoreButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushQueries();

    expect(mockExecutionWorkspacesApi.listOverview).toHaveBeenLastCalledWith("company-1", { offset: 50 });
    expect(container.textContent).toContain("Workspace Beta");
    expect(container.textContent).toContain("PAP-11917");
  });

  it("keeps the isolated-workspaces feature flag redirect", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <Workspaces />
        </QueryClientProvider>,
      );
    });
    await flushQueries();

    expect(container.textContent).toContain("/issues");
    expect(mockExecutionWorkspacesApi.listOverview).not.toHaveBeenCalled();
  });
});
