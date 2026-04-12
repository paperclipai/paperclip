// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "./Approvals";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const listApprovalsMock = vi.fn();
const listAgentsMock = vi.fn();
const setBreadcrumbsMock = vi.fn();
const navigateMock = vi.fn();

let selectedCompanyId: string | null = "company-1";
let pathname = "/approvals/pending";

vi.mock("../api/approvals", () => ({
  approvalsApi: {
    list: () => listApprovalsMock(),
    approve: vi.fn(),
    reject: vi.fn(),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
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
    approvals: {
      list: (companyId: string) => ["approvals", companyId],
    },
    agents: {
      list: (companyId: string) => ["agents", companyId],
    },
  },
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
  useLocation: () => ({ pathname, search: "", hash: "" }),
}));

vi.mock("../components/ApprovalCard", () => ({
  ApprovalCard: ({ approval }: { approval: { id: string } }) => <div>{approval.id}</div>,
}));

vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({ items }: { items: Array<{ label: unknown }> }) => <div>{items.map((item, index) => <div key={index}>{item.label as never}</div>)}</div>,
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Approvals", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    selectedCompanyId = "company-1";
    pathname = "/approvals/pending";
    listApprovalsMock.mockResolvedValue([]);
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
            <Approvals />
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

    throw new Error("Timed out waiting for Approvals to settle");
  }

  it("renders localized empty state when no company is selected", async () => {
    selectedCompanyId = null;
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("请先选择一个公司。") === true);

    expect(container.textContent).toContain("请先选择一个公司。");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([{ label: "审批" }]);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized pending empty state", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("暂无待处理审批。") === true);

    expect(container.textContent).toContain("暂无待处理审批。");
    expect(container.textContent).toContain("待处理");
    expect(container.textContent).toContain("全部");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized all empty state", async () => {
    pathname = "/approvals/all";
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("暂无审批记录。") === true);

    expect(container.textContent).toContain("暂无审批记录。");

    await act(async () => {
      root.unmount();
    });
  });
});
