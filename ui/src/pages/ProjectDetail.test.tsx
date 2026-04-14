// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import type { ProjectWorkspaceSummary } from "../lib/project-workspaces-tab";
import { ProjectDetail } from "./ProjectDetail";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const setBreadcrumbsMock = vi.fn();
const navigateMock = vi.fn();
const setSelectedCompanyIdMock = vi.fn();
const invalidateQueriesMock = vi.fn();
const pushToastMock = vi.fn();
const closePanelMock = vi.fn();

let companyPrefix: string | undefined;
let projectId = "project-1";
let filter: string | undefined;
let pathname = "/projects/project-1/issues";
let search = "";
let hash = "";
let selectedCompanyId: string | null = "company-1";
let companies = [{ id: "company-1", issuePrefix: "pc" }];
let projectState: {
  data: {
    id: string;
    urlKey: string;
    name: string;
    companyId: string;
    color?: string | null;
    pauseReason?: string | null;
    description?: string | null;
    status?: string;
    targetDate?: string | null;
  } | null;
  isLoading: boolean;
  error: Error | null;
};
let experimentalSettings = { enableIsolatedWorkspaces: false };
let workspaceSummaries: ProjectWorkspaceSummary[] = [];

function makeIssue(index: number): Issue {
  return {
    id: `issue-${index}`,
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: `Issue ${index}`,
    description: null,
    status: "backlog",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: index,
    identifier: `PC-${index}`,
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
    createdAt: new Date("2026-04-13T10:00:00.000Z"),
    updatedAt: new Date("2026-04-13T10:00:00.000Z"),
  };
}

function makeIdleQuery<T>(data: T) {
  return {
    data,
    isLoading: false,
    isFetched: true,
    error: null,
  };
}

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a>,
  Navigate: ({ to }: { to: string }) => <div>{to}</div>,
  useNavigate: () => navigateMock,
  useLocation: () => ({ pathname, search, hash }),
  useParams: () => ({ companyPrefix, projectId, filter }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ companies, selectedCompanyId, setSelectedCompanyId: setSelectedCompanyIdMock }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({ closePanel: closePanelMock }),
}));

vi.mock("../components/InlineEditor", () => ({
  InlineEditor: ({ value, placeholder }: { value: string; placeholder?: string }) => <div data-placeholder={placeholder}>{value}</div>,
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div>page-skeleton</div>,
}));

vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({ items }: { items: Array<{ label: string }> }) => <div>{items.map((item) => item.label).join("|")}</div>,
}));

vi.mock("../components/ProjectProperties", () => ({
  ProjectProperties: () => <div>project-properties</div>,
}));

vi.mock("../components/BudgetPolicyCard", () => ({
  BudgetPolicyCard: () => <div>budget-policy-card</div>,
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: () => <div>plugin-slot-mount</div>,
  PluginSlotOutlet: () => <div>plugin-slot-outlet</div>,
  usePluginSlots: () => ({ slots: [], isLoading: false }),
}));

vi.mock("@/plugins/launchers", () => ({
  PluginLauncherOutlet: () => <div>plugin-launcher-outlet</div>,
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    get: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: { getExperimental: vi.fn() },
}));

vi.mock("../api/budgets", () => ({
  budgetsApi: { overview: vi.fn(), upsertPolicy: vi.fn() },
}));

vi.mock("../api/assets", () => ({
  assetsApi: { uploadImage: vi.fn() },
}));

vi.mock("../api/issues", () => ({
  issuesApi: { list: vi.fn(), update: vi.fn() },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: vi.fn() },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: vi.fn() },
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: { list: vi.fn(), controlRuntimeServices: vi.fn() },
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    projects: {
      detail: (projectRef: string) => ["projects", projectRef],
      list: (companyId: string) => ["projects", companyId, "list"],
    },
    issues: {
      listByProject: (companyId: string, projectId: string) => ["issues", companyId, projectId],
    },
    executionWorkspaces: {
      list: (companyId: string, opts: { projectId: string }) => ["execution-workspaces", companyId, opts.projectId],
    },
    budgets: {
      overview: (companyId: string) => ["budgets", companyId],
    },
    dashboard: (companyId: string) => ["dashboard", companyId],
    agents: {
      list: (companyId: string) => ["agents", companyId],
    },
    liveRuns: (companyId: string) => ["live-runs", companyId],
    instance: {
      experimentalSettings: ["instance", "experimental-settings"],
    },
  },
}));

vi.mock("../lib/project-workspaces-tab", () => ({
  buildProjectWorkspaceSummaries: () => workspaceSummaries,
}));

vi.mock("../lib/utils", async () => {
  const actual = await vi.importActual<typeof import("../lib/utils")>("../lib/utils");
  return {
    ...actual,
    projectRouteRef: (project: { urlKey: string }) => project.urlKey,
    projectWorkspaceUrl: (project: { id: string; urlKey: string }, workspaceId: string) => `/projects/${project.urlKey}/workspaces/${workspaceId}`,
  };
});

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: (options: { queryKey: unknown[] }) => {
      const key = options.queryKey[0];
      if (key === "projects") return projectState;
      if (key === "instance") return { data: experimentalSettings, isFetched: true, isLoading: false, error: null };
      if (key === "budgets") return makeIdleQuery({ policies: [] });
      if (key === "issues") return makeIdleQuery([]);
      if (key === "execution-workspaces") return makeIdleQuery([]);
      if (key === "agents") return makeIdleQuery([]);
      if (key === "live-runs") return makeIdleQuery([]);
      return makeIdleQuery([]);
    },
    useMutation: () => ({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() }),
    useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProjectDetail", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    companyPrefix = undefined;
    projectId = "project-1";
    filter = undefined;
    pathname = "/projects/project-1/budget";
    search = "";
    hash = "";
    selectedCompanyId = "company-1";
    companies = [{ id: "company-1", issuePrefix: "pc" }];
    experimentalSettings = { enableIsolatedWorkspaces: false };
    workspaceSummaries = [];
    projectState = {
      data: {
        id: "project-1",
        urlKey: "project-1",
        name: "Project One",
        companyId: "company-1",
        color: null,
        pauseReason: null,
        description: null,
        status: "active",
        targetDate: null,
      },
      isLoading: false,
      error: null,
    };
    setBreadcrumbsMock.mockReset();
    navigateMock.mockReset();
    setSelectedCompanyIdMock.mockReset();
    invalidateQueriesMock.mockReset();
    pushToastMock.mockReset();
    closePanelMock.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  async function renderPage() {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider>
          <ProjectDetail />
        </I18nProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    return root;
  }

  async function waitFor(condition: () => boolean, attempts = 10) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (condition()) return;
      await act(async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    throw new Error("Timed out waiting for ProjectDetail to settle");
  }

  it("renders localized tabs and budget hard-stop badge", async () => {
    pathname = "/projects/project-1/budget";
    projectState = {
      data: {
        id: "project-1",
        urlKey: "project-1",
        name: "Project One",
        companyId: "company-1",
        color: null,
        pauseReason: "budget",
        description: null,
        status: "active",
        targetDate: null,
      },
      isLoading: false,
      error: null,
    };
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("事项|概览|配置|预算") === true);

    expect(container.textContent).toContain("事项|概览|配置|预算");
    expect(container.textContent).toContain("因预算硬停而暂停");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([
      { label: "项目", href: "/projects" },
      { label: "Project One" },
    ]);

    await act(async () => {
      root.unmount();
    });
  });

  it("closes panel on mount and unmount", async () => {
    pathname = "/projects/project-1/budget";
    const root = await renderPage();

    await waitFor(() => closePanelMock.mock.calls.length >= 1);

    await act(async () => {
      root.unmount();
    });

    expect(closePanelMock).toHaveBeenCalledTimes(2);
  });

  it("renders localized overview metadata and color picker labels", async () => {
    pathname = "/projects/project-1/overview";
    projectState = {
      data: {
        id: "project-1",
        urlKey: "project-1",
        name: "Project One",
        companyId: "company-1",
        color: "#6366f1",
        pauseReason: null,
        description: null,
        status: "active",
        targetDate: "2026-04-20",
      },
      isLoading: false,
      error: null,
    };
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("概览") === true);

    expect(container.innerHTML).toContain("data-placeholder=\"添加描述...\"");
    expect(container.textContent).toContain("状态");
    expect(container.textContent).toContain("目标日期");
    expect(container.innerHTML).toContain("aria-label=\"更改项目颜色\"");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized workspace actions and status labels", async () => {
    pathname = "/projects/project-1/workspaces";
    experimentalSettings = { enableIsolatedWorkspaces: true };
    workspaceSummaries = [
      {
        key: "execution:workspace-1",
        kind: "execution_workspace",
        workspaceId: "workspace-1",
        workspaceName: "Exec Workspace",
        cwd: "/repo/exec",
        branchName: "feature/i18n",
        lastUpdatedAt: new Date("2026-04-13T10:00:00.000Z"),
        projectWorkspaceId: null,
        executionWorkspaceId: "workspace-1",
        executionWorkspaceStatus: "cleanup_failed",
        serviceCount: 2,
        runningServiceCount: 1,
        primaryServiceUrl: "http://localhost:3000",
        hasRuntimeConfig: true,
        issues: Array.from({ length: 7 }, (_, index) => makeIssue(index + 1)),
      },
    ] as ProjectWorkspaceSummary[];
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("需要关注清理") === true);

    expect(container.textContent).toContain("需要关注清理");
    expect(container.textContent).toContain("清理失败");
    expect(container.textContent).toContain("停止");
    expect(container.textContent).toContain("重试关闭");
    expect(container.textContent).toContain("事项");
    expect(container.textContent).toContain("+2 更多");
    expect(container.textContent).not.toContain("cleanup_failed");
    expect(container.textContent).not.toContain("Retry close");
    expect(container.textContent).not.toContain("Stop");

    await act(async () => {
      root.unmount();
    });
  });
});
