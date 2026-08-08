// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExecutionWorkspace, Project } from "@paperclipai/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionWorkspaceDetail } from "./ExecutionWorkspaceDetail";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockExecutionWorkspacesApi = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  listWorkspaceOperations: vi.fn(),
  controlRuntimeCommands: vi.fn(),
}));
const mockProjectsApi = vi.hoisted(() => ({ get: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn() }));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockHeartbeatsApi = vi.hoisted(() => ({ liveRunsForCompany: vi.fn() }));
const mockRoutinesApi = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), run: vi.fn() }));
const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockUsePluginSlots = vi.hoisted(() => vi.fn());
const mockPluginSlotOutlet = vi.hoisted(() => vi.fn());
const mockPluginSlotMount = vi.hoisted(() => vi.fn());
const mockSummarySlotCard = vi.hoisted(() => vi.fn());
const mockPluginSlotState = vi.hoisted(() => ({
  slots: [] as unknown[],
  isLoading: false,
  errorMessage: null as string | null,
}));
const mockRouteLocation = vi.hoisted(() => ({
  pathname: "/execution-workspaces/workspace-1/issues",
  search: "",
}));

vi.mock("../api/execution-workspaces", () => ({ executionWorkspacesApi: mockExecutionWorkspacesApi }));
vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: mockHeartbeatsApi }));
vi.mock("../api/routines", () => ({ routinesApi: mockRoutinesApi }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, className }: { children?: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
  useLocation: () => ({ ...mockRouteLocation, hash: "", state: null }),
  useNavigate: () => mockNavigate,
  useParams: () => ({ workspaceId: "workspace-1" }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", issuePrefix: "PAP" }],
    selectedCompanyId: "company-1",
    setSelectedCompanyId: vi.fn(),
  }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: (props: unknown) => {
    mockPluginSlotMount(props);
    return <div data-testid="plugin-slot-mount" />;
  },
  PluginSlotOutlet: (props: unknown) => {
    mockPluginSlotOutlet(props);
    return <div data-testid="plugin-slot-outlet" />;
  },
  usePluginSlots: (filters: unknown) => {
    mockUsePluginSlots(filters);
    const entityType = (filters as { entityType?: string }).entityType;
    return {
      slots: entityType === "execution_workspace" ? mockPluginSlotState.slots : [],
      isLoading: mockPluginSlotState.isLoading,
      errorMessage: mockPluginSlotState.errorMessage,
    };
  },
}));

vi.mock("../components/IssuesList", () => ({
  IssuesList: () => <div data-testid="issues-list" />,
}));
vi.mock("../components/SummarySlotCard", () => ({
  SummarySlotCard: (props: unknown) => {
    mockSummarySlotCard(props);
    return <div data-testid="summary-slot-card" />;
  },
}));
vi.mock("../components/ExecutionWorkspaceCloseDialog", () => ({
  ExecutionWorkspaceCloseDialog: () => null,
}));
vi.mock("../components/RoutineRunVariablesDialog", () => ({
  RoutineRunVariablesDialog: () => null,
}));
vi.mock("../components/WorkspaceRuntimeControls", () => ({
  buildWorkspaceRuntimeControlSections: () => [],
  buildWorkspaceServiceControlEntries: () => [],
  resolveWorkspaceServiceControlRequests: () => [],
  WorkspaceRuntimeControls: () => <div data-testid="runtime-controls" />,
}));
vi.mock("../components/WorkspaceServiceControlBar", () => ({
  WorkspaceServiceControlBar: () => <div data-testid="service-control-bar" />,
}));
vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({ items }: { items: Array<{ value: string; label: string }> }) => (
    <div data-testid="page-tab-bar">
      {items.map((item) => (
        <button key={item.value} data-tab-value={item.value} type="button">{item.label}</button>
      ))}
    </div>
  ),
}));
vi.mock("../components/CopyText", () => ({ CopyText: () => null }));

function workspace(overrides: Partial<ExecutionWorkspace> = {}): ExecutionWorkspace {
  const now = new Date("2026-05-01T00:00:00Z");
  return {
    id: "workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: null,
    sourceIssueId: null,
    mode: "local",
    strategyType: "local_worktree",
    name: "Diff worktree",
    status: "active",
    cwd: "/tmp/workspace-1",
    repoUrl: null,
    baseRef: null,
    branchName: null,
    providerType: "local",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: now,
    openedAt: now,
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    runtimeServices: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as ExecutionWorkspace;
}

function project(overrides: Partial<Project> = {}): Project {
  const now = new Date("2026-05-01T00:00:00Z");
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Test Project",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: "#14b8a6",
    icon: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/project-1",
      effectiveLocalFolder: "/tmp/project-1",
      origin: "managed_checkout",
    },
    workspaces: [],
    primaryWorkspace: null,
    managedByPlugin: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function pluginSlot(overrides: Record<string, unknown> = {}) {
  return {
    id: "changes-tab",
    type: "detailTab",
    displayName: "Changes",
    exportName: "ExecutionWorkspaceChangesTab",
    entityTypes: ["execution_workspace"],
    pluginId: "plugin-1",
    pluginKey: "paperclip.workspace-diff",
    pluginDisplayName: "Workspace Changes",
    pluginVersion: "0.1.0",
    ...overrides,
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ExecutionWorkspaceDetail plugin slots", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockExecutionWorkspacesApi.get.mockResolvedValue(workspace());
    mockExecutionWorkspacesApi.listWorkspaceOperations.mockResolvedValue([]);
    mockProjectsApi.get.mockResolvedValue(project());
    mockIssuesApi.list.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockRoutinesApi.list.mockResolvedValue([]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    mockPluginSlotState.slots = [];
    mockPluginSlotState.isLoading = false;
    mockPluginSlotState.errorMessage = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
    mockRouteLocation.pathname = "/execution-workspaces/workspace-1/issues";
    mockRouteLocation.search = "";
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <ExecutionWorkspaceDetail />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await flush();
    });
  }

  it("scopes the plugin detail-tab discovery to execution_workspace and the workspace's company", async () => {
    await render();

    const enabledDetailTabFilters = mockUsePluginSlots.mock.calls
      .map(([filters]) => filters as { slotTypes: string[]; entityType: string; companyId: string | null; enabled?: boolean })
      .filter((filters) => filters.slotTypes.includes("detailTab") && filters.enabled !== false);

    expect(enabledDetailTabFilters.length).toBeGreaterThan(0);
    for (const filters of enabledDetailTabFilters) {
      expect(filters.entityType).toBe("execution_workspace");
      expect(filters.companyId).toBe("company-1");
    }
  });

  it("mounts a toolbar PluginSlotOutlet with execution_workspace context", async () => {
    await render();

    const outletCalls = mockPluginSlotOutlet.mock.calls.map(([props]) => props as {
      slotTypes: string[];
      entityType: string;
      context: { entityId: string; entityType: string; companyId: string; projectId: string };
    });
    const toolbarOutlet = outletCalls.find((props) => props.slotTypes.includes("toolbarButton"));
    expect(toolbarOutlet).toBeDefined();
    expect(toolbarOutlet?.entityType).toBe("execution_workspace");
    expect(toolbarOutlet?.context).toMatchObject({
      entityId: "workspace-1",
      entityType: "execution_workspace",
      companyId: "company-1",
      projectId: "project-1",
    });
  });

  it("shows the linked project workspace summary above tasks", async () => {
    mockExecutionWorkspacesApi.get.mockResolvedValue(workspace({ projectWorkspaceId: "project-workspace-1" }));

    await render();

    expect(mockSummarySlotCard).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      scopeKind: "project_workspace",
      scopeId: "project-workspace-1",
      title: "Workspace summary",
    }));
    const summary = container.querySelector('[data-testid="summary-slot-card"]');
    const issues = container.querySelector('[data-testid="issues-list"]');
    expect(summary).not.toBeNull();
    expect(issues).not.toBeNull();
    if (!summary || !issues) throw new Error("Expected summary and issues list to render");
    expect(summary.compareDocumentPosition(issues) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("does not show a project workspace summary for standalone execution workspaces", async () => {
    await render();

    expect(mockSummarySlotCard).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="summary-slot-card"]')).toBeNull();
  });

  it("does not mount plugin slots scoped to other entity types", async () => {
    await render();

    const outletCalls = mockPluginSlotOutlet.mock.calls.map(([props]) => props as { entityType: string });
    for (const props of outletCalls) {
      expect(props.entityType).toBe("execution_workspace");
    }
  });

  it("shows a missing plugin placeholder instead of routines for stale plugin tab URLs", async () => {
    mockRouteLocation.pathname = "/execution-workspaces/workspace-1";
    mockRouteLocation.search = "?tab=plugin%3Amissing%3Aslot";

    await render();

    expect(container.textContent).toContain("Workspace plugin tab is not available.");
    expect(container.querySelector('a[href="/execution-workspaces/workspace-1/issues"]')?.textContent).toBe("Back to tasks");
    expect(container.textContent).not.toContain("Workspace routines");
    expect(container.querySelector('[data-testid="plugin-slot-mount"]')).toBeNull();
  });

  it("orders execution workspace plugin tabs against built-in tabs by slot order", async () => {
    mockPluginSlotState.slots = [
      pluginSlot({ id: "default-tab", displayName: "Default" }),
      pluginSlot({ id: "changes-tab", displayName: "Changes", order: 25 }),
      pluginSlot({ id: "inspect-tab", displayName: "Inspect", order: 50 }),
    ];

    await render();

    const tabLabels = Array.from(container.querySelectorAll("[data-tab-value]")).map((tab) => tab.textContent);
    expect(tabLabels).toEqual([
      "Tasks",
      "Services",
      "Changes",
      "Configuration",
      "Runtime logs",
      "Inspect",
      "Routines",
      "Default",
    ]);
  });
});
