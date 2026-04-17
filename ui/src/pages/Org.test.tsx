// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Org } from "./Org";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const orgMock = vi.fn();
const setBreadcrumbsMock = vi.fn();

let selectedCompanyId: string | null = "company-1";

vi.mock("../api/agents", () => ({
  agentsApi: {
    org: () => orgMock(),
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
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, className }: { children: unknown; to: string; className?: string }) => <a href={to} className={className}>{children as never}</a>,
}));

vi.mock("../components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Org", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    selectedCompanyId = "company-1";
    orgMock.mockResolvedValue([]);
    setBreadcrumbsMock.mockReset();
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
            <Org />
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

    throw new Error("Timed out waiting for Org to settle");
  }

  it("renders localized empty state when no company is selected", async () => {
    selectedCompanyId = null;
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("选择一个公司以查看组织架构。") === true);

    expect(container.textContent).toContain("选择一个公司以查看组织架构。");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([{ label: "组织架构" }]);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized empty org state", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("组织中还没有智能体。创建智能体以构建你的组织架构图。") === true);

    expect(container.textContent).toContain("组织中还没有智能体。创建智能体以构建你的组织架构图。");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders org tree nodes as smoke when data exists", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
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
            role: "worker",
            status: "paused",
            reports: [],
          },
        ],
      },
    ]);
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("CEO Agent") === true);

    expect(container.textContent).toContain("CEO Agent");
    expect(container.textContent).toContain("Worker Agent");

    await act(async () => {
      root.unmount();
    });
  });
});
