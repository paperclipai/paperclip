// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Goals } from "./Goals";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const listGoalsMock = vi.fn();
const openNewGoalMock = vi.fn();
const setBreadcrumbsMock = vi.fn();

let selectedCompanyId: string | null = "company-1";

vi.mock("../api/goals", () => ({
  goalsApi: {
    list: () => listGoalsMock(),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openNewGoal: openNewGoalMock }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    goals: {
      list: (companyId: string) => ["goals", companyId],
    },
  },
}));

vi.mock("../components/GoalTree", () => ({
  GoalTree: ({ goals }: { goals: Array<{ title: string }> }) => <div>{goals.map((goal) => goal.title).join(", ")}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Goals", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    selectedCompanyId = "company-1";
    listGoalsMock.mockResolvedValue([]);
    openNewGoalMock.mockReset();
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
            <Goals />
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

    throw new Error("Timed out waiting for Goals to settle");
  }

  it("renders the localized empty state when no company is selected", async () => {
    selectedCompanyId = null;
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("选择一个公司以查看目标。") === true);

    expect(container.textContent).toContain("选择一个公司以查看目标。");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([{ label: "目标" }]);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized empty state when no goals exist", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("暂无目标。") === true);

    expect(container.textContent).toContain("暂无目标。");
    expect(container.textContent).toContain("添加目标");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized action when goals exist", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    listGoalsMock.mockResolvedValue([
      { id: "goal-1", title: "Ship localization" },
    ]);
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("Ship localization") === true);

    expect(container.textContent).toContain("新建目标");
    expect(container.textContent).toContain("Ship localization");

    await act(async () => {
      root.unmount();
    });
  });
});
