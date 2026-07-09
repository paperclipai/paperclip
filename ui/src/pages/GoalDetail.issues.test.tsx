// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Goal, Issue, Project } from "@paperclipai/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalDetail } from "./GoalDetail";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockGoalsApi = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), update: vi.fn() }));
const mockProjectsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockHeartbeatsApi = vi.hoisted(() => ({ liveRunsForCompany: vi.fn() }));
const mockAssetsApi = vi.hoisted(() => ({ uploadImage: vi.fn() }));
const mockIssuesList = vi.hoisted(() => vi.fn());

vi.mock("../api/goals", () => ({ goalsApi: mockGoalsApi }));
vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: mockHeartbeatsApi }));
vi.mock("../api/assets", () => ({ assetsApi: mockAssetsApi }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children?: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useParams: () => ({ goalId: "goal-1" }),
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    setSelectedCompanyId: vi.fn(),
  }),
}));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewGoal: vi.fn() }) }));
vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    panelVisible: false,
    setPanelVisible: vi.fn(),
  }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../components/GoalProperties", () => ({ GoalProperties: () => <div data-testid="goal-properties" /> }));
vi.mock("../components/InlineEditor", () => ({
  InlineEditor: ({ value, placeholder }: { value?: string; placeholder?: string }) => (
    <span>{value || placeholder || null}</span>
  ),
}));
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
  TabsContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/IssuesList", () => ({
  IssuesList: (props: unknown) => {
    mockIssuesList(props);
    return <div data-testid="issues-list" />;
  },
}));

function goal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date("2026-05-01T00:00:00Z");
  return {
    id: "goal-1",
    companyId: "company-1",
    title: "Grow Paperclip",
    description: null,
    level: "company",
    status: "active",
    parentId: null,
    ownerAgentId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  const now = new Date("2026-05-01T00:00:00Z");
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: "goal-1",
    parentId: null,
    title: "Linked issue",
    description: null,
    status: "todo",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  const now = new Date("2026-05-01T00:00:00Z");
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    goalId: "goal-1",
    goalIds: ["goal-1"],
    goals: [],
    name: "Project",
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
    managedByPlugin: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("GoalDetail issues tab", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const linkedIssue = issue();
    mockGoalsApi.get.mockResolvedValue(goal({ linkedIssues: [linkedIssue], linkedIssueCount: 1 }));
    mockGoalsApi.list.mockResolvedValue([goal()]);
    mockProjectsApi.list.mockResolvedValue([project()]);
    mockIssuesApi.list.mockResolvedValue([linkedIssue]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("renders linked issues as a tab and passes progress summary props to the issue list", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <GoalDetail />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("Issues (1)");
    expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", {
      goalId: "goal-1",
      includeBlockedBy: true,
    });
    expect(mockIssuesList).toHaveBeenCalledWith(expect.objectContaining({
      baseCreateIssueDefaults: { goalId: "goal-1" },
      searchFilters: { goalId: "goal-1", includeBlockedBy: true },
      showProgressSummary: true,
    }));
  });
});
