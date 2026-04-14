// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionWorkspaceDetail } from "./ExecutionWorkspaceDetail";
import { I18nProvider } from "../context/I18nContext";

const storage = new Map<string, string>();
const localStorageMock = {
  getItem: vi.fn((key: string) => storage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    storage.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    storage.delete(key);
  }),
};

const getWorkspaceMock = vi.fn();
const listWorkspaceOperationsMock = vi.fn();
const getProjectMock = vi.fn();
const listIssuesMock = vi.fn();

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, ...props }: ComponentProps<"a">) => (
    <a className={className} {...props}>{children}</a>
  ),
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
  useParams: () => ({ workspaceId: "ws-1" }),
  useLocation: () => ({
    pathname: "/execution-workspaces/ws-1/configuration",
    search: "",
    hash: "",
  }),
  useNavigate: () => vi.fn(),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    setSelectedCompanyId: vi.fn(),
  }),
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: {
    get: () => getWorkspaceMock(),
    listWorkspaceOperations: () => listWorkspaceOperationsMock(),
    update: vi.fn(),
    controlRuntimeServices: vi.fn(),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    get: () => getProjectMock(),
  },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    get: vi.fn(),
    list: () => listIssuesMock(),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: vi.fn(),
  },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: {
    liveRunsForCompany: vi.fn(),
  },
}));

vi.mock("../components/ExecutionWorkspaceCloseDialog", () => ({
  ExecutionWorkspaceCloseDialog: () => null,
}));

vi.mock("../components/CopyText", () => ({
  CopyText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({ items }: { items: Array<{ label: string }> }) => (
    <div>{items.map((item) => item.label).join(", ")}</div>
  ),
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ExecutionWorkspaceDetail", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    storage.clear();
    Object.defineProperty(window, "localStorage", {
      value: localStorageMock,
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: localStorageMock,
      configurable: true,
    });
    localStorage.setItem("paperclip.locale", "zh-CN");
    getWorkspaceMock.mockResolvedValue({
      id: "ws-1",
      companyId: "company-1",
      projectId: "project-1",
      projectWorkspaceId: null,
      sourceIssueId: null,
      derivedFromExecutionWorkspaceId: null,
      name: "Workspace Alpha",
      mode: "isolated",
      providerType: "local",
      status: "active",
      cwd: "/tmp/workspace",
      repoUrl: "https://github.com/org/repo",
      baseRef: "origin/main",
      branchName: "feature/ws",
      providerRef: "/tmp/worktree",
      openedAt: "2026-04-01T00:00:00.000Z",
      lastUsedAt: "2026-04-02T00:00:00.000Z",
      cleanupEligibleAt: null,
      cleanupReason: null,
      runtimeServices: [],
      config: {
        provisionCommand: "bash ./scripts/provision.sh",
        teardownCommand: "bash ./scripts/teardown.sh",
        cleanupCommand: "pkill -f vite || true",
        workspaceRuntime: null,
      },
    });
    listWorkspaceOperationsMock.mockResolvedValue([]);
    getProjectMock.mockResolvedValue({
      id: "project-1",
      companyId: "company-1",
      name: "Project Alpha",
      urlKey: "project-alpha",
      workspaces: [],
    });
    listIssuesMock.mockResolvedValue([]);
  });

  afterEach(() => {
    localStorage.removeItem("paperclip.locale");
    getWorkspaceMock.mockReset();
    listWorkspaceOperationsMock.mockReset();
    getProjectMock.mockReset();
    listIssuesMock.mockReset();
    container.remove();
  });

  it("renders zh-CN copy for the configuration view", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const root = createRoot(container);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <ExecutionWorkspaceDetail />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });

    await flush();
    await flush();
    await flush();

    expect(container.textContent).toContain("返回所有工作区");
    expect(container.textContent).toContain("执行工作区");
    expect(container.textContent).toContain("配置");
    expect(container.textContent).toContain("工作区设置");
    expect(container.textContent).toContain("工作区名称");
    expect(container.textContent).toContain("准备命令");
    expect(container.textContent).toContain("拆除命令");
    expect(container.textContent).toContain("运行时配置来源");
    expect(container.textContent).toContain("关联对象");
    expect(container.textContent).toContain("路径与引用");
    expect(container.textContent).toContain("最近操作");
    expect(container.textContent).toContain("还没有记录任何工作区操作。");
    expect(container.textContent).not.toContain("Back to all workspaces");
    expect(container.textContent).not.toContain("Workspace settings");
    expect(container.textContent).not.toContain("Recent operations");

    act(() => {
      root.unmount();
    });
  });
});
