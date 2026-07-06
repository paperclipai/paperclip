// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExecutionWorkspace, Issue, IssueWorkProduct, Project } from "@paperclipai/shared";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
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
vi.mock("../components/ExecutionWorkspaceCloseDialog", () => ({
  ExecutionWorkspaceCloseDialog: () => null,
}));
vi.mock("../components/RoutineRunVariablesDialog", () => ({
  RoutineRunVariablesDialog: () => null,
}));
vi.mock("../components/WorkspaceRuntimeControls", () => ({
  buildWorkspaceRuntimeControlSections: () => [],
  WorkspaceRuntimeQuickControls: () => <div data-testid="runtime-quick-controls" />,
  WorkspaceRuntimeControls: () => <div data-testid="runtime-controls" />,
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

function issue(overrides: Partial<Issue> = {}): Issue {
  const now = new Date("2026-05-01T00:00:00Z");
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Ship workspace outputs",
    description: null,
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    issueNumber: 17,
    identifier: "PAP-17",
    originKind: "manual",
    originId: null,
    originRunId: null,
    originFingerprint: null,
    requestDepth: 0,
    workMode: "standard",
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: "workspace-1",
    executionWorkspacePreference: "reuse_existing",
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    labels: [],
    blockerAttention: { state: "none", reason: null, unresolvedBlockerCount: 0, coveredBlockerCount: 0, stalledBlockerCount: 0, attentionBlockerCount: 0, sampleBlockerIdentifier: null, sampleStalledBlockerIdentifier: null },
    productivityReview: null,
    scheduledRetry: null,
    activeRecoveryAction: null,
    blockedBy: [],
    blocks: [],
    children: [],
    comments: [],
    documents: [],
    attachments: [],
    workProducts: [],
    currentExecutionWorkspace: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Issue;
}

function workProduct(overrides: Partial<IssueWorkProduct> & { id: string }): IssueWorkProduct {
  const now = new Date("2026-05-01T00:00:00Z");
  const { id, ...workProductOverrides } = overrides;
  return {
    id,
    companyId: "company-1",
    projectId: "project-1",
    issueId: "issue-1",
    executionWorkspaceId: "workspace-1",
    runtimeServiceId: null,
    type: "artifact",
    provider: "paperclip",
    externalId: null,
    title: "build-artifact.zip",
    url: null,
    status: "ready_for_review",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: null,
    metadata: {
      openPath: `/api/attachments/${id}/content`,
      downloadPath: `/api/attachments/${id}/content?download=1`,
    },
    sourceTrust: null,
    createdByRunId: null,
    createdAt: now,
    updatedAt: now,
    ...workProductOverrides,
  } as IssueWorkProduct;
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
    if (root) {
      flushSync(() => root?.unmount());
    }
    root = null;
    container.remove();
    vi.clearAllMocks();
    mockRouteLocation.pathname = "/execution-workspaces/workspace-1/issues";
    mockRouteLocation.search = "";
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <ExecutionWorkspaceDetail />
        </QueryClientProvider>,
      );
    });
    await flush();
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

  it("renders workspace work products without requiring a plugin tab", async () => {
    mockRouteLocation.pathname = "/execution-workspaces/workspace-1/work-products";
    mockIssuesApi.list.mockResolvedValue([issue()]);
    mockExecutionWorkspacesApi.get.mockResolvedValue(workspace({
      workProducts: [
        workProduct({
          id: "wp-pr",
          type: "pull_request",
          provider: "github",
          title: "PR 42",
          url: "https://github.com/paperclipai/paperclip/pull/42",
          status: "ready_for_review",
          summary: "Workspace branch is ready for review.",
        }),
        workProduct({
          id: "wp-preview",
          type: "preview_url",
          provider: "vercel",
          title: "Vercel preview",
          url: "https://preview.example.com",
          status: "active",
        }),
        workProduct({
          id: "wp-file",
          type: "artifact",
          provider: "paperclip",
          title: "qa-screenshot.png",
          status: "approved",
        }),
      ],
    }));

    await render();

    expect(container.textContent).toContain("Workspace work products");
    expect(container.textContent).toContain("3 work products");
    expect(container.textContent).toContain("1 pull request");
    expect(container.textContent).toContain("1 preview");
    expect(container.textContent).toContain("1 file");
    expect(container.textContent).toContain("PR 42");
    expect(container.textContent).toContain("Vercel preview");
    expect(container.textContent).toContain("qa-screenshot.png");
    expect(container.querySelector('a[href="https://github.com/paperclipai/paperclip/pull/42"]')).not.toBeNull();
    expect(container.querySelector('a[href="/issues/PAP-17"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plugin-slot-mount"]')).toBeNull();
  });

  it("does not render protocol-relative metadata work-product links", async () => {
    mockRouteLocation.pathname = "/execution-workspaces/workspace-1/work-products";
    mockIssuesApi.list.mockResolvedValue([issue()]);
    mockExecutionWorkspacesApi.get.mockResolvedValue(workspace({
      workProducts: [
        workProduct({
          id: "wp-file",
          title: "agent-report.html",
          metadata: {
            openPath: "//evil.example/report.html",
          },
        }),
      ],
    }));

    await render();

    expect(container.textContent).toContain("agent-report.html");
    expect(container.querySelector('a[href="//evil.example/report.html"]')).toBeNull();
    expect(container.querySelector('a[href="https://evil.example/report.html"]')).toBeNull();
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
      "Work products",
      "Configuration",
      "Runtime logs",
      "Inspect",
      "Routines",
      "Default",
    ]);
  });
});
