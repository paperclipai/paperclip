// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectWorkspaceDetail } from "./ProjectWorkspaceDetail";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const setBreadcrumbsMock = vi.fn();
const navigateMock = vi.fn();
const setSelectedCompanyIdMock = vi.fn();
const invalidateQueriesMock = vi.fn();

let companyPrefix: string | undefined;
let projectId = "project-1";
let workspaceId = "workspace-1";
let selectedCompanyId: string | null = "company-1";
let companies = [{ id: "company-1", issuePrefix: "pc" }];
let projectQueryState: {
  data: {
    id: string;
    urlKey: string;
    name: string;
    companyId: string;
    workspaces: Array<{
      id: string;
      name: string;
      isPrimary: boolean;
      sourceType: "local_path";
      cwd: string | null;
      repoUrl: string | null;
      repoRef: string | null;
      defaultRef: string | null;
      visibility: "default";
      setupCommand: string | null;
      cleanupCommand: string | null;
      remoteProvider: string | null;
      remoteWorkspaceRef: string | null;
      sharedWorkspaceKey: string | null;
      runtimeConfig: { workspaceRuntime: Record<string, unknown> | null } | null;
      runtimeServices: Array<{
        id: string;
        serviceName: string;
        status: string;
        healthStatus: string;
        url: string | null;
        port: number | null;
        command: string | null;
        cwd: string | null;
      }>;
      updatedAt: string;
    }>;
  } | null;
  isLoading: boolean;
  error: Error | null;
} = {
  data: {
    id: "project-1",
    urlKey: "project-1",
    name: "Project One",
    companyId: "company-1",
    workspaces: [
      {
        id: "workspace-1",
        name: "Main Workspace",
        isPrimary: true,
        sourceType: "local_path",
        cwd: "/repo/main",
        repoUrl: null,
        repoRef: null,
        defaultRef: null,
        visibility: "default",
        setupCommand: null,
        cleanupCommand: null,
        remoteProvider: null,
        remoteWorkspaceRef: null,
        sharedWorkspaceKey: null,
        runtimeConfig: null,
        runtimeServices: [],
        updatedAt: "2026-04-13T10:00:00.000Z",
      },
    ],
  },
  isLoading: false,
  error: null,
};

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a>,
  useNavigate: () => navigateMock,
  useParams: () => ({ companyPrefix, projectId, workspaceId }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ companies, selectedCompanyId, setSelectedCompanyId: setSelectedCompanyIdMock }),
}));

vi.mock("../components/PathInstructionsModal", () => ({
  ChoosePathButton: () => <button>choose-path-button</button>,
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    get: vi.fn(),
    updateWorkspace: vi.fn(),
    controlWorkspaceRuntimeServices: vi.fn(),
  },
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    projects: {
      detail: (projectRef: string) => ["projects", projectRef],
      list: (companyId: string) => ["projects", companyId, "list"],
    },
  },
}));

vi.mock("../lib/utils", async () => {
  const actual = await vi.importActual<typeof import("../lib/utils")>("../lib/utils");
  return {
    ...actual,
    projectRouteRef: (project: { urlKey: string }) => project.urlKey,
    projectWorkspaceUrl: (project: { urlKey: string }, nextWorkspaceId: string) => `/projects/${project.urlKey}/workspaces/${nextWorkspaceId}`,
  };
});

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: () => projectQueryState,
    useMutation: () => ({ isPending: false, mutate: vi.fn() }),
    useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProjectWorkspaceDetail", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    companyPrefix = undefined;
    projectId = "project-1";
    workspaceId = "workspace-1";
    selectedCompanyId = "company-1";
    companies = [{ id: "company-1", issuePrefix: "pc" }];
    projectQueryState = {
      data: {
        id: "project-1",
        urlKey: "project-1",
        name: "Project One",
        companyId: "company-1",
        workspaces: [
          {
            id: "workspace-1",
            name: "Main Workspace",
            isPrimary: true,
            sourceType: "local_path",
            cwd: "/repo/main",
            repoUrl: null,
            repoRef: null,
            defaultRef: null,
            visibility: "default",
            setupCommand: null,
            cleanupCommand: null,
            remoteProvider: null,
            remoteWorkspaceRef: null,
            sharedWorkspaceKey: null,
            runtimeConfig: null,
            runtimeServices: [],
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        ],
      },
      isLoading: false,
      error: null,
    };
    setBreadcrumbsMock.mockReset();
    navigateMock.mockReset();
    setSelectedCompanyIdMock.mockReset();
    invalidateQueriesMock.mockReset();
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
          <ProjectWorkspaceDetail />
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

    throw new Error("Timed out waiting for ProjectWorkspaceDetail to settle");
  }

  it("renders localized shell copy for a primary workspace", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("返回工作区") === true);

    expect(container.textContent).toContain("返回工作区");
    expect(container.textContent).toContain("主工作区");
    expect(container.textContent).toContain("项目工作区");
    expect(container.textContent).toContain("这是该项目的主代码库工作区。");
    expect(container.textContent).toContain("工作区名称");
    expect(container.textContent).toContain("可见性");
    expect(container.textContent).toContain("来源类型");
    expect(container.textContent).toContain("本地路径");
    expect(container.textContent).toContain("仓库 URL");
    expect(container.textContent).toContain("Setup 命令");
    expect(container.textContent).toContain("运行时服务 JSON");
    expect(container.textContent).toContain("保存更改");
    expect(container.textContent).toContain("重置");
    expect(container.textContent).toContain("没有未保存的更改。");
    expect(container.textContent).toContain("工作区信息");
    expect(container.textContent).toContain("当前状态");
    expect(container.textContent).toContain("运行时服务");
    expect(container.textContent).toContain("已附加服务");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([
      { label: "项目", href: "/projects" },
      { label: "Project One", href: "/projects/project-1" },
      { label: "工作区", href: "/projects/project-1/workspaces" },
      { label: "Main Workspace" },
    ]);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized secondary workspace badge and action", async () => {
    projectQueryState = {
      data: {
        id: "project-1",
        urlKey: "project-1",
        name: "Project One",
        companyId: "company-1",
        workspaces: [
          {
            id: "workspace-1",
            name: "Secondary Workspace",
            isPrimary: false,
            sourceType: "local_path",
            cwd: "/repo/secondary",
            repoUrl: null,
            repoRef: null,
            defaultRef: null,
            visibility: "default",
            setupCommand: null,
            cleanupCommand: null,
            remoteProvider: null,
            remoteWorkspaceRef: null,
            sharedWorkspaceKey: null,
            runtimeConfig: null,
            runtimeServices: [],
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        ],
      },
      isLoading: false,
      error: null,
    };
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("次工作区") === true);

    expect(container.textContent).toContain("次工作区");
    expect(container.textContent).toContain("设为主工作区");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized runtime service status labels", async () => {
    projectQueryState = {
      data: {
        id: "project-1",
        urlKey: "project-1",
        name: "Project One",
        companyId: "company-1",
        workspaces: [
          {
            id: "workspace-1",
            name: "Main Workspace",
            isPrimary: true,
            sourceType: "local_path",
            cwd: "/repo/main",
            repoUrl: null,
            repoRef: null,
            defaultRef: null,
            visibility: "default",
            setupCommand: null,
            cleanupCommand: null,
            remoteProvider: null,
            remoteWorkspaceRef: null,
            sharedWorkspaceKey: null,
            runtimeConfig: { workspaceRuntime: { services: [] } },
            runtimeServices: [
              {
                id: "service-1",
                serviceName: "web",
                status: "running",
                healthStatus: "healthy",
                url: "http://localhost:3000",
                port: 3000,
                command: "pnpm dev",
                cwd: "/repo/main",
              },
            ],
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        ],
      },
      isLoading: false,
      error: null,
    };
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("运行中 · 健康") === true);

    expect(container.textContent).toContain("运行中 · 健康");
    expect(container.textContent).not.toContain("running · healthy");

    await act(async () => {
      root.unmount();
    });
  });
});
