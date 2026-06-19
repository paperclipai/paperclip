// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, Project } from "@paperclipai/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectDetail } from "./ProjectDetail";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockProjectsApi = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
}));
const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  update: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockHeartbeatsApi = vi.hoisted(() => ({ liveRunsForCompany: vi.fn() }));
const mockBudgetsApi = vi.hoisted(() => ({ overview: vi.fn(), upsertPolicy: vi.fn() }));
const mockExecutionWorkspacesApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));
const mockAssetsApi = vi.hoisted(() => ({ uploadImage: vi.fn() }));
const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockIssuesList = vi.hoisted(() => vi.fn());
const mockLocationState = vi.hoisted(() => ({
  pathname: "/projects/project-1/plugin-operations",
}));

vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: mockHeartbeatsApi }));
vi.mock("../api/budgets", () => ({ budgetsApi: mockBudgetsApi }));
vi.mock("../api/execution-workspaces", () => ({ executionWorkspacesApi: mockExecutionWorkspacesApi }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("../api/assets", () => ({ assetsApi: mockAssetsApi }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children?: ReactNode; to: string }) => <a href={to}>{children}</a>,
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
  useLocation: () => ({ pathname: mockLocationState.pathname, search: "", hash: "", state: null }),
  useNavigate: () => mockNavigate,
  useParams: () => ({ projectId: "project-1" }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", issuePrefix: "PAP" }],
    selectedCompanyId: "company-1",
    setSelectedCompanyId: vi.fn(),
  }),
}));
vi.mock("../context/PanelContext", () => ({ usePanel: () => ({ closePanel: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }) }));
vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: () => null,
  PluginSlotOutlet: () => null,
  usePluginSlots: () => ({ slots: [], isLoading: false }),
}));
vi.mock("@/plugins/launchers", () => ({ PluginLauncherOutlet: () => null }));
vi.mock("../components/ProjectProperties", () => ({
  ProjectProperties: () => <div data-testid="project-properties" />,
}));
vi.mock("../components/BudgetPolicyCard", () => ({
  BudgetPolicyCard: () => <div data-testid="budget-policy-card" />,
}));
vi.mock("../components/InlineEditor", () => ({
  InlineEditor: ({ value, placeholder }: { value?: string; placeholder?: string }) => (
    <span>{value || placeholder || null}</span>
  ),
}));
vi.mock("../components/ProjectWorkspacesContent", () => ({
  ProjectWorkspacesContent: () => <div data-testid="project-workspaces" />,
}));
vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({ items }: { items: Array<{ value: string; label: string }> }) => (
    <div>{items.map((item) => <button key={item.value}>{item.label}</button>)}</div>
  ),
}));
vi.mock("../components/IssuesList", () => ({
  IssuesList: (props: unknown) => {
    mockIssuesList(props);
    return <div data-testid="issues-list" />;
  },
}));

function project(overrides: Partial<Project> = {}): Project {
  const now = new Date("2026-05-01T00:00:00Z");
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Managed Project",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: "#14b8a6",
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
    managedByPlugin: {
      id: "managed-1",
      pluginId: "plugin-1",
      pluginKey: "paperclip.missions",
      pluginDisplayName: "Missions",
      resourceKind: "project",
      resourceKey: "operations",
      defaultsJson: {},
      createdAt: now,
      updatedAt: now,
    },
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? "issue-1",
    identifier: overrides.identifier ?? "PAP-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: overrides.title ?? "Issue title",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    visibility: "company",
    dueDate: null,
    workLeadDays: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    updatedAt: new Date("2026-05-01T00:00:00Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: null,
    isUnreadForMe: false,
    workMode: "standard",
    workItemType: "ai_task",
    ...overrides,
  } as Issue;
}

describe("ProjectDetail", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockLocationState.pathname = "/projects/project-1/plugin-operations";
    mockProjectsApi.get.mockResolvedValue(project());
    mockProjectsApi.list.mockResolvedValue([project()]);
    mockIssuesApi.list.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    mockBudgetsApi.overview.mockResolvedValue({ policies: [] });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    mockExecutionWorkspacesApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("shows managed plugin affordances and filters the operations tab by plugin origin", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProjectDetail />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("Managed by Missions");
    expect(container.textContent).toContain("Plugin operations");
    expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", {
      projectId: "project-1",
      originKindPrefix: "plugin:paperclip.missions",
    });
  });

  it("separates human-owned work on the project issues tab", async () => {
    mockLocationState.pathname = "/projects/project-1/issues";
    const humanIssue = issue({
      id: "issue-human",
      identifier: "PAP-10",
      title: "Approve product brief",
      assigneeUserId: "user-1",
      workItemType: "human_task",
    });
    const agentIssue = issue({
      id: "issue-agent",
      identifier: "PAP-11",
      title: "Build execution lane",
      assigneeAgentId: "agent-1",
      workItemType: "ai_task",
    });
    const initiativeIssue = issue({
      id: "issue-initiative",
      identifier: "PAP-12",
      title: "Launch work hub",
      workItemType: "initiative",
    });
    mockIssuesApi.list.mockResolvedValue([humanIssue, agentIssue, initiativeIssue]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProjectDetail />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("Project work lanes");
    expect(container.textContent).toContain("Human-owned");
    expect((mockIssuesList.mock.calls.at(-1)?.[0] as { issues: Issue[] }).issues.map((item) => item.id))
      .toEqual(["issue-human", "issue-agent", "issue-initiative"]);

    const humanLaneButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Human-owned"));
    expect(humanLaneButton).not.toBeUndefined();

    await act(async () => {
      humanLaneButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const latestProps = mockIssuesList.mock.calls.at(-1)?.[0] as {
      issues: Issue[];
      baseCreateIssueDefaults?: Record<string, unknown>;
    };
    expect(latestProps.issues.map((item) => item.id)).toEqual(["issue-human"]);
    expect(latestProps.baseCreateIssueDefaults).toEqual({ workItemType: "human_task" });
  });
});
