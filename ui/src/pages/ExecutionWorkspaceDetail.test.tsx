// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionWorkspaceDetail } from "./ExecutionWorkspaceDetail";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const setBreadcrumbsMock = vi.fn();
const navigateMock = vi.fn();
const setSelectedCompanyIdMock = vi.fn();
const queryClientMock = {
  setQueryData: vi.fn(),
  invalidateQueries: vi.fn(),
};

let workspaceId = "workspace-1";
let pathname = "/execution-workspaces/workspace-1/configuration";
let search = "";
let hash = "";
let selectedCompanyId: string | null = "company-1";
let companies = [{ id: "company-1", issuePrefix: "pc" }];

const workspace: {
  id: string;
  name: string;
  companyId: string;
  projectId: string;
  projectWorkspaceId: string | null;
  sourceIssueId: string | null;
  derivedFromExecutionWorkspaceId: string | null;
  mode: string;
  providerType: string;
  status: string;
  cwd: string | null;
  repoUrl: string | null;
  baseRef: string | null;
  branchName: string | null;
  providerRef: string | null;
  openedAt: string;
  lastUsedAt: string;
  cleanupEligibleAt: string | null;
  cleanupReason: string | null;
  runtimeServices: Array<{
    id: string;
    serviceName: string;
    status: string;
    lifecycle: string;
    command: string | null;
    cwd: string | null;
    port: number | null;
    url: string | null;
    healthStatus: string;
  }>;
  config: {
    provisionCommand: string | null;
    teardownCommand: string | null;
    cleanupCommand: string | null;
    workspaceRuntime: Record<string, unknown> | null;
  };
} = {
  id: "workspace-1",
  name: "Exec Workspace",
  companyId: "company-1",
  projectId: "project-1",
  projectWorkspaceId: null,
  sourceIssueId: null,
  derivedFromExecutionWorkspaceId: null,
  mode: "shared_workspace",
  providerType: "local",
  status: "active",
  cwd: "/repo/exec",
  repoUrl: null,
  baseRef: null,
  branchName: null,
  providerRef: null,
  openedAt: "2026-04-13T10:00:00.000Z",
  lastUsedAt: "2026-04-13T10:05:00.000Z",
  cleanupEligibleAt: null,
  cleanupReason: null,
  runtimeServices: [],
  config: {
    provisionCommand: null,
    teardownCommand: null,
    cleanupCommand: null,
    workspaceRuntime: null,
  },
};

const project = {
  id: "project-1",
  urlKey: "project-1",
  name: "Project One",
  workspaces: [],
};

let workspaceOperations: Array<{
  id: string;
  phase: "worktree_prepare" | "workspace_provision" | "workspace_teardown" | "worktree_cleanup";
  command: string | null;
  status: "running" | "succeeded" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string | null;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
}> = [];

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
  useLocation: () => ({ pathname, search, hash }),
  useNavigate: () => navigateMock,
  useParams: () => ({ workspaceId }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId, setSelectedCompanyId: setSelectedCompanyIdMock, companies }),
}));

vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({ items }: { items: Array<{ label: string }> }) => <div>{items.map((item) => item.label).join("|")}</div>,
}));

vi.mock("../components/ExecutionWorkspaceCloseDialog", () => ({
  ExecutionWorkspaceCloseDialog: () => <div>execution-workspace-close-dialog</div>,
}));

vi.mock("../components/CopyText", () => ({
  CopyText: ({ children, copiedLabel }: { children: unknown; copiedLabel?: string }) => <span data-copied-label={copiedLabel}>{children as never}</span>,
}));

vi.mock("../components/IssuesList", () => ({
  IssuesList: () => <div>issues-list</div>,
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: {
    get: vi.fn(),
    update: vi.fn(),
    controlRuntimeServices: vi.fn(),
    listWorkspaceOperations: vi.fn(),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: { get: vi.fn() },
}));

vi.mock("../api/issues", () => ({
  issuesApi: { get: vi.fn(), list: vi.fn(), update: vi.fn() },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: vi.fn() },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: vi.fn() },
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    executionWorkspaces: {
      detail: (id: string) => ["execution-workspaces", "detail", id],
      closeReadiness: (id: string) => ["execution-workspaces", "close-readiness", id],
      workspaceOperations: (id: string) => ["execution-workspaces", "workspace-operations", id],
      list: (companyId: string, filters?: Record<string, string | boolean | undefined>) => ["execution-workspaces", companyId, filters ?? {}],
    },
    projects: {
      detail: (id: string) => ["projects", "detail", id],
    },
    issues: {
      detail: (id: string) => ["issues", "detail", id],
      listByExecutionWorkspace: (companyId: string, executionWorkspaceId: string) => ["issues", companyId, "execution-workspace", executionWorkspaceId],
      listByProject: (companyId: string, projectId: string) => ["issues", companyId, "project", projectId],
      list: (companyId: string) => ["issues", companyId],
    },
    agents: {
      list: (companyId: string) => ["agents", companyId],
    },
    liveRuns: (companyId: string) => ["live-runs", companyId],
  },
}));

vi.mock("../lib/utils", async () => {
  const actual = await vi.importActual<typeof import("../lib/utils")>("../lib/utils");
  return {
    ...actual,
    projectRouteRef: (projectArg: { urlKey: string }) => projectArg.urlKey,
    projectWorkspaceUrl: (projectArg: { urlKey: string }, nextWorkspaceId: string) => `/projects/${projectArg.urlKey}/workspaces/${nextWorkspaceId}`,
    issueUrl: (issue: { id: string }) => `/issues/${issue.id}`,
    formatDateTime: (value: string) => `formatted:${value}`,
  };
});

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: (options: { queryKey: unknown[] }) => {
      const key = options.queryKey[0];
      if (key === "execution-workspaces" && options.queryKey[1] === "detail") return makeIdleQuery(workspace);
      if (key === "projects") return makeIdleQuery(project);
      if (key === "issues" && options.queryKey[1] === "detail") return makeIdleQuery(null);
      if (key === "issues" && options.queryKey[2] === "execution-workspace") return makeIdleQuery([]);
      if (key === "execution-workspaces" && options.queryKey[1] === "workspace-operations") return makeIdleQuery(workspaceOperations);
      if (key === "agents") return makeIdleQuery([]);
      if (key === "live-runs") return makeIdleQuery([]);
      return makeIdleQuery([]);
    },
    useMutation: () => ({ isPending: false, mutate: vi.fn() }),
    useQueryClient: () => queryClientMock,
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ExecutionWorkspaceDetail", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    workspaceId = "workspace-1";
    pathname = "/execution-workspaces/workspace-1/configuration";
    search = "";
    hash = "";
    selectedCompanyId = "company-1";
    companies = [{ id: "company-1", issuePrefix: "pc" }];
    workspace.repoUrl = null;
    workspace.runtimeServices = [];
    workspace.status = "active";
    workspace.mode = "shared_workspace";
    workspace.providerType = "local";
    workspace.config.workspaceRuntime = null;
    workspaceOperations = [];
    setBreadcrumbsMock.mockReset();
    navigateMock.mockReset();
    setSelectedCompanyIdMock.mockReset();
    queryClientMock.setQueryData.mockReset();
    queryClientMock.invalidateQueries.mockReset();
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
          <ExecutionWorkspaceDetail />
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

    throw new Error("Timed out waiting for ExecutionWorkspaceDetail to settle");
  }

  it("renders localized configuration shell", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("返回所有工作区") === true);

    expect(container.textContent).toContain("返回所有工作区");
    expect(container.textContent).toContain("共享工作区");
    expect(container.textContent).toContain("本地文件系统");
    expect(container.textContent).toContain("活跃");
    expect(container.textContent).toContain("执行工作区");
    expect(container.textContent).toContain("配置|事项");
    expect(container.textContent).toContain("工作区设置");
    expect(container.textContent).toContain("关闭工作区");
    expect(container.textContent).toContain("工作区名称");
    expect(container.textContent).toContain("分支名称");
    expect(container.textContent).toContain("工作目录");
    expect(container.textContent).toContain("Provision 命令");
    expect(container.textContent).toContain("运行时配置来源");
    expect(container.textContent).toContain("重置为继承");
    expect(container.textContent).toContain("运行时服务 JSON");
    expect(container.textContent).toContain("保存更改");
    expect(container.textContent).toContain("没有未保存的更改。");
    expect(container.textContent).toContain("关联对象");
    expect(container.textContent).toContain("工作区上下文");
    expect(container.textContent).toContain("路径与引用");
    expect(container.textContent).toContain("实际位置");
    expect(container.textContent).toContain("运行时服务");
    expect(container.textContent).toContain("已附加服务");
    expect(container.textContent).toContain("当前这个执行工作区及其项目工作区都没有定义运行时配置。");
    expect(container.textContent).toContain("最近操作");
    expect(container.textContent).toContain("运行时与清理日志");
    expect(container.textContent).toContain("尚未记录任何工作区操作。");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([
      { label: "项目", href: "/projects" },
      { label: "Project One", href: "/projects/project-1" },
      { label: "工作区", href: "/projects/project-1/workspaces" },
      { label: "Exec Workspace" },
    ]);

    await act(async () => {
      root.unmount();
    });
  });

  it("uses localized copied label for repo url copy affordances", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    workspace.repoUrl = "https://github.com/paperclipai/paperclip";
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("仓库 URL") === true);

    const copiedNodes = Array.from(container.querySelectorAll("[data-copied-label]"));
    expect(copiedNodes.length).toBeGreaterThan(0);
    expect(copiedNodes.some((node) => node.getAttribute("data-copied-label") === "已复制")).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("shows localized invalid json error instead of raw parser text", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    workspace.config.workspaceRuntime = { services: [] };
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("保存更改") === true);

    const inheritCheckbox = container.querySelector("#inherit-runtime-config") as HTMLInputElement | null;
    expect(inheritCheckbox).not.toBeNull();

    await act(async () => {
      inheritCheckbox!.checked = false;
      inheritCheckbox?.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const textareas = Array.from(container.querySelectorAll("textarea"));
    const runtimeJsonTextarea = textareas[textareas.length - 1] as HTMLTextAreaElement | undefined;
    expect(runtimeJsonTextarea).toBeDefined();

    await act(async () => {
      const setTextareaValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setTextareaValue?.call(runtimeJsonTextarea, "{");
      runtimeJsonTextarea!.dispatchEvent(new Event("input", { bubbles: true }));
      runtimeJsonTextarea!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const saveButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("保存更改")) as HTMLButtonElement | undefined;
    expect(saveButton).toBeDefined();

    await waitFor(() => saveButton?.disabled === false);

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("JSON 无效。");
    expect(container.textContent).not.toContain("Unexpected");

    await act(async () => {
      root.unmount();
    });
  });

  it("localizes runtime service and workspace operation statuses", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    workspace.runtimeServices = [
      {
        id: "service-1",
        serviceName: "web",
        status: "running",
        lifecycle: "ephemeral",
        command: "pnpm dev",
        cwd: "/repo/exec",
        port: 3100,
        url: "http://localhost:3100",
        healthStatus: "healthy",
      },
    ];
    workspaceOperations = [
      {
        id: "op-1",
        phase: "worktree_cleanup",
        command: null,
        status: "succeeded",
        startedAt: "2026-04-13T10:00:00.000Z",
        finishedAt: "2026-04-13T10:05:00.000Z",
        stdoutExcerpt: "done",
        stderrExcerpt: null,
      },
    ];
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("已附加服务") === true && container.textContent?.includes("最近操作") === true);

    expect(container.textContent).toContain("运行中 · 临时");
    expect(container.textContent).toContain("健康");
    expect(container.textContent).toContain("清理工作区");
    expect(container.textContent).toContain("已成功");
    expect(container.textContent).not.toContain("running · ephemeral");
    expect(container.textContent).not.toContain("healthy");
    expect(container.textContent).not.toContain("workspace_teardown");
    expect(container.textContent).not.toContain("succeeded");

    await act(async () => {
      root.unmount();
    });
  });
});
