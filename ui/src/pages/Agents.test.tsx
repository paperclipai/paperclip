// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agents } from "./Agents";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const listAgentsMock = vi.fn();
const orgMock = vi.fn();
const listHeartbeatsMock = vi.fn();
const openNewAgentMock = vi.fn();
const setBreadcrumbsMock = vi.fn();
const navigateMock = vi.fn();

let selectedCompanyId: string | null = "company-1";
let pathname = "/agents/all";
let isMobile = false;

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: () => listAgentsMock(),
    org: () => orgMock(),
  },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: {
    list: () => listHeartbeatsMock(),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openNewAgent: openNewAgentMock }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile }),
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    agents: {
      list: (companyId: string) => ["agents", companyId],
    },
    org: (companyId: string) => ["org", companyId],
    heartbeats: (companyId: string) => ["heartbeats", companyId],
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, className, onClick }: { children: unknown; to: string; className?: string; onClick?: () => void }) => (
    <a href={to} className={className} onClick={onClick}>{children as never}</a>
  ),
  useNavigate: () => navigateMock,
  useLocation: () => ({ pathname, search: "", hash: "" }),
}));

vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({ items }: { items: Array<{ label: unknown }> }) => <div>{items.map((item, index) => <div key={index}>{item.label as never}</div>)}</div>,
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));

vi.mock("../components/EntityRow", () => ({
  EntityRow: ({ title, subtitle, trailing }: { title: string; subtitle?: string; trailing?: unknown }) => <div>{title}{subtitle}{trailing as never}</div>,
}));

vi.mock("../adapters/adapter-display-registry", () => ({
  getAdapterLabel: (adapterType: string) => adapterType,
}));

vi.mock("../components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Agents", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    selectedCompanyId = "company-1";
    pathname = "/agents/all";
    isMobile = false;
    listAgentsMock.mockResolvedValue([]);
    orgMock.mockResolvedValue([]);
    listHeartbeatsMock.mockResolvedValue([]);
    openNewAgentMock.mockReset();
    setBreadcrumbsMock.mockReset();
    navigateMock.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  async function renderPage() {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <Agents />
          </I18nProvider>
        </QueryClientProvider>,
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

    throw new Error("Timed out waiting for Agents to settle");
  }

  it("renders localized empty state when no company is selected", async () => {
    selectedCompanyId = null;
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("选择一个公司以查看智能体。") === true);

    expect(container.textContent).toContain("选择一个公司以查看智能体。");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([{ label: "智能体" }]);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized tabs, filters, and empty agent state", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("创建你的第一个智能体以开始使用。") === true);

    expect(container.textContent).toContain("全部");
    expect(container.textContent).toContain("活跃");
    expect(container.textContent).toContain("已暂停");
    expect(container.textContent).toContain("错误");
    expect(container.textContent).toContain("筛选");
    expect(container.textContent).toContain("新建智能体");
    expect(container.textContent).toContain("创建你的第一个智能体以开始使用。");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized no-match state in list view", async () => {
    pathname = "/agents/active";
    isMobile = true;
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    listAgentsMock.mockResolvedValue([
      {
        id: "agent-1",
        name: "Worker",
        urlKey: "worker",
        role: "worker",
        title: null,
        status: "paused",
        pausedAt: null,
        adapterType: "claude_local",
        lastHeartbeatAt: null,
      },
    ]);
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("没有智能体符合所选筛选条件。") === true);

    expect(container.textContent).toContain("没有智能体符合所选筛选条件。");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized org empty state", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    listAgentsMock.mockResolvedValue([
      {
        id: "agent-1",
        name: "Worker",
        urlKey: "worker",
        role: "worker",
        title: null,
        status: "running",
        pausedAt: null,
        adapterType: "claude_local",
        lastHeartbeatAt: null,
      },
    ]);
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("智能体：1") === true);

    expect(container.textContent).toContain("智能体：1");
    expect(container.textContent).toContain("尚未定义组织层级。");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized live badge in list view", async () => {
    isMobile = true;
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    listAgentsMock.mockResolvedValue([
      {
        id: "agent-1",
        name: "Worker",
        urlKey: "worker",
        role: "worker",
        title: null,
        status: "running",
        pausedAt: null,
        adapterType: "claude_local",
        lastHeartbeatAt: null,
      },
    ]);
    listHeartbeatsMock.mockResolvedValue([
      { id: "run-1", agentId: "agent-1", status: "running" },
      { id: "run-2", agentId: "agent-1", status: "queued" },
    ]);
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("实时 (2)") === true);

    expect(container.textContent).toContain("实时 (2)");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized org list content with adapter and heartbeat metadata", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    listAgentsMock.mockResolvedValue([
      {
        id: "agent-1",
        name: "Worker",
        urlKey: "worker",
        role: "worker",
        title: "Planner",
        status: "running",
        pausedAt: null,
        adapterType: "claude_local",
        lastHeartbeatAt: null,
      },
    ]);
    orgMock.mockResolvedValue([
      {
        id: "agent-1",
        name: "Worker",
        role: "worker",
        status: "running",
        reports: [],
      },
    ]);
    listHeartbeatsMock.mockResolvedValue([]);
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("智能体：1") === true);

    expect(container.textContent).toContain("Worker");
    expect(container.textContent).toContain("Planner");
    expect(container.textContent).toContain("claude_local");
    expect(container.textContent).toContain("—");
    expect(container.textContent).toContain("running");

    await act(async () => {
      root.unmount();
    });
  });
});
