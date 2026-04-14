// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrgChart } from "./OrgChart";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const orgMock = vi.fn();
const listAgentsMock = vi.fn();
const setBreadcrumbsMock = vi.fn();
const navigateMock = vi.fn();

let selectedCompanyId: string | null = "company-1";

vi.mock("../api/agents", () => ({
  agentsApi: {
    org: () => orgMock(),
    list: () => listAgentsMock(),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    org: (companyId: string) => ["org", companyId],
    agents: { list: (companyId: string) => ["agents", companyId] },
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a>,
  useNavigate: () => navigateMock,
}));

vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => <span>agent-icon</span>,
}));

vi.mock("../adapters/adapter-display-registry", () => ({
  getAdapterLabel: (adapterType: string) => adapterType,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("OrgChart", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    Object.defineProperty(container, "clientWidth", { value: 1200, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 800, configurable: true });
    document.body.appendChild(container);
    selectedCompanyId = "company-1";
    orgMock.mockResolvedValue([]);
    listAgentsMock.mockResolvedValue([]);
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
            <OrgChart />
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

    throw new Error("Timed out waiting for OrgChart to settle");
  }

  it("renders localized empty state when no company is selected", async () => {
    selectedCompanyId = null;
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("选择一个公司以查看组织架构图。") === true);

    expect(container.textContent).toContain("选择一个公司以查看组织架构图。");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([{ label: "组织架构图" }]);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized empty org chart state", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("尚未定义组织层级。") === true);

    expect(container.textContent).toContain("尚未定义组织层级。");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized chart controls and org nodes as smoke", async () => {
    orgMock.mockResolvedValue([
      {
        id: "agent-1",
        name: "CEO Agent",
        role: "ceo",
        status: "active",
        reports: [],
      },
    ]);
    listAgentsMock.mockResolvedValue([
      {
        id: "agent-1",
        name: "CEO Agent",
        title: "CEO",
        status: "active",
        adapterType: "claude_local",
        icon: null,
        capabilities: null,
      },
    ]);
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("导入公司") === true);

    expect(container.textContent).toContain("导入公司");
    expect(container.textContent).toContain("导出公司");
    expect(container.textContent).toContain("适配");
    expect(container.textContent).toContain("+");
    expect(container.textContent).toContain("−");
    expect(container.textContent).toContain("CEO Agent");
    expect(container.textContent).toContain("claude_local");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders nested org hierarchy nodes", async () => {
    orgMock.mockResolvedValue([
      {
        id: "agent-1",
        name: "CEO Agent",
        role: "ceo",
        status: "active",
        reports: [
          {
            id: "agent-2",
            name: "Worker Agent",
            role: "engineer",
            status: "paused",
            reports: [],
          },
        ],
      },
    ]);
    listAgentsMock.mockResolvedValue([
      {
        id: "agent-1",
        name: "CEO Agent",
        title: "CEO",
        status: "active",
        adapterType: "claude_local",
        icon: null,
        capabilities: null,
      },
      {
        id: "agent-2",
        name: "Worker Agent",
        title: "Engineer",
        status: "paused",
        adapterType: "codex_local",
        icon: null,
        capabilities: null,
      },
    ]);
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("Worker Agent") === true);

    expect(container.textContent).toContain("CEO Agent");
    expect(container.textContent).toContain("Worker Agent");
    expect(container.textContent).toContain("codex_local");

    await act(async () => {
      root.unmount();
    });
  });
});
