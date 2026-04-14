// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Companies } from "./Companies";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const statsMock = vi.fn();
const openOnboardingMock = vi.fn();
const setBreadcrumbsMock = vi.fn();
const setSelectedCompanyIdMock = vi.fn();

let companies: Array<{
  id: string;
  name: string;
  status: string;
  description?: string | null;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  createdAt: string;
}> = [];
let selectedCompanyId: string | null = null;
let loading = false;
let error: Error | null = null;

vi.mock("../api/companies", () => ({
  companiesApi: {
    stats: () => statsMock(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies,
    selectedCompanyId,
    setSelectedCompanyId: setSelectedCompanyIdMock,
    loading,
    error,
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openOnboarding: openOnboardingMock }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    companies: {
      all: ["companies"],
      stats: ["companies", "stats"],
    },
  },
}));

vi.mock("@/components/ui/input", () => ({
  Input: () => <input />,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DropdownMenuContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: unknown; onClick?: () => void }) => <button type="button" onClick={onClick}>{children as never}</button>,
  DropdownMenuSeparator: () => <div />,
  DropdownMenuTrigger: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Companies", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    companies = [];
    selectedCompanyId = null;
    loading = false;
    error = null;
    statsMock.mockResolvedValue({});
    openOnboardingMock.mockReset();
    setBreadcrumbsMock.mockReset();
    setSelectedCompanyIdMock.mockReset();
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
        mutations: { retry: false },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <Companies />
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

    throw new Error("Timed out waiting for Companies to settle");
  }

  it("renders localized breadcrumb, action, and loading state", async () => {
    loading = true;
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("正在加载公司...") === true);

    expect(container.textContent).toContain("新建公司");
    expect(container.textContent).toContain("正在加载公司...");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([{ label: "公司" }]);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized unlimited budget copy", async () => {
    companies = [
      {
        id: "company-1",
        name: "Paperclip",
        status: "active",
        description: null,
        budgetMonthlyCents: 0,
        spentMonthlyCents: 12345,
        createdAt: new Date().toISOString(),
      },
    ];
    statsMock.mockResolvedValue({ companyId: { agentCount: 1, issueCount: 2 }, "company-1": { agentCount: 1, issueCount: 2 } });
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("智能体：1") === true && container.textContent?.includes("事项：2") === true);

    expect(container.textContent).toContain("Paperclip");
    expect(container.textContent).toContain("预算不限");
    expect(container.textContent).toContain("新建公司");
    expect(container.textContent).toContain("智能体：1");
    expect(container.textContent).toContain("事项：2");
    expect(container.textContent).toContain("创建于：");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized company description and selected state metadata", async () => {
    companies = [
      {
        id: "company-1",
        name: "Paperclip",
        status: "active",
        description: "Workspace tools",
        budgetMonthlyCents: 20000,
        spentMonthlyCents: 5000,
        createdAt: new Date().toISOString(),
      },
    ];
    selectedCompanyId = "company-1";
    statsMock.mockResolvedValue({ "company-1": { agentCount: 3, issueCount: 4 } });
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("Workspace tools") === true);

    expect(container.textContent).toContain("Paperclip");
    expect(container.textContent).toContain("Workspace tools");
    expect(container.textContent).toContain("智能体：0");
    expect(container.textContent).toContain("事项：0");
    expect(container.textContent).toContain("(25%)");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized company actions and delete confirmation", async () => {
    companies = [
      {
        id: "company-1",
        name: "Paperclip",
        status: "active",
        description: null,
        budgetMonthlyCents: 10000,
        spentMonthlyCents: 5000,
        createdAt: new Date().toISOString(),
      },
    ];
    // drive the delete confirmation branch directly
    statsMock.mockResolvedValue({ companyId: { agentCount: 1, issueCount: 1 }, "company-1": { agentCount: 1, issueCount: 1 } });
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("删除公司") === true);

    const deleteButton = Array.from(container.querySelectorAll("button")).find((node) => node.textContent?.includes("删除公司"));
    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => container.textContent?.includes("删除这个公司及其所有数据？此操作无法撤销。") === true);

    expect(container.textContent).toContain("重命名");
    expect(container.textContent).toContain("删除公司");
    expect(container.textContent).toContain("删除这个公司及其所有数据？此操作无法撤销。");
    expect(container.textContent).toContain("取消");
    expect(container.textContent).toContain("删除");

    await act(async () => {
      root.unmount();
    });
  });
});
