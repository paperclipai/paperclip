// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalDetail, GoalPropertiesToggleButton } from "./GoalDetail";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const goalGetMock = vi.fn();
const listGoalsMock = vi.fn();
const listProjectsMock = vi.fn();
const openNewGoalMock = vi.fn();
const setBreadcrumbsMock = vi.fn();
const setSelectedCompanyIdMock = vi.fn();
const openPanelMock = vi.fn();
const closePanelMock = vi.fn();
const setPanelVisibleMock = vi.fn();

let goalId = "goal-1";
let selectedCompanyId: string | null = "company-1";
let panelVisible = false;

vi.mock("../api/goals", () => ({
  goalsApi: {
    get: () => goalGetMock(),
    list: () => listGoalsMock(),
    update: vi.fn(),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    list: () => listProjectsMock(),
  },
}));

vi.mock("../api/assets", () => ({
  assetsApi: {
    uploadImage: vi.fn(),
  },
}));

vi.mock("@/lib/router", () => ({
  useParams: () => ({ goalId }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({
    openPanel: openPanelMock,
    closePanel: closePanelMock,
    panelVisible,
    setPanelVisible: setPanelVisibleMock,
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId, setSelectedCompanyId: setSelectedCompanyIdMock }),
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
      detail: (id: string) => ["goals", "detail", id],
      list: (companyId: string) => ["goals", companyId],
    },
    projects: {
      list: (companyId: string) => ["projects", companyId],
    },
  },
}));

vi.mock("../components/GoalProperties", () => ({
  GoalProperties: () => <div>goal-properties</div>,
}));

vi.mock("../components/GoalTree", () => ({
  GoalTree: ({ goals }: { goals: Array<{ title: string }> }) => <div>{goals.map((goal) => goal.title).join(", ")}</div>,
}));

vi.mock("../components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("../components/InlineEditor", () => ({
  InlineEditor: ({ value, placeholder }: { value: string; placeholder?: string }) => <div>{value || placeholder}</div>,
}));

vi.mock("../components/EntityRow", () => ({
  EntityRow: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  TabsList: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  TabsTrigger: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  TabsContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("GoalDetail i18n", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    goalId = "goal-1";
    selectedCompanyId = "company-1";
    panelVisible = false;
    goalGetMock.mockResolvedValue({
      id: "goal-1",
      companyId: "company-1",
      title: "Ship localization",
      description: "",
      level: "company",
      status: "active",
    });
    listGoalsMock.mockResolvedValue([]);
    listProjectsMock.mockResolvedValue([]);
    openNewGoalMock.mockReset();
    setBreadcrumbsMock.mockReset();
    setSelectedCompanyIdMock.mockReset();
    openPanelMock.mockReset();
    closePanelMock.mockReset();
    setPanelVisibleMock.mockReset();
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
            <GoalDetail />
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

    throw new Error("Timed out waiting for GoalDetail to settle");
  }

  it("renders localized host copy in zh-CN", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("子目标") === true);

    expect(container.textContent).toContain("子目标 (0)");
    expect(container.textContent).toContain("项目 (0)");
    expect(container.textContent).toContain("暂无子目标。");
    expect(container.textContent).toContain("暂无关联项目。");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([
      { label: "目标", href: "/goals" },
      { label: "Ship localization" },
    ]);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized placeholder and sub goal action", async () => {
    goalGetMock.mockResolvedValue({
      id: "goal-1",
      companyId: "company-1",
      title: "Ship localization",
      description: "",
      level: "company",
      status: "active",
    });
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("添加描述...") === true);

    expect(container.textContent).toContain("添加描述...");
    expect(container.textContent).toContain("子目标");

    await act(async () => {
      root.unmount();
    });
  });

  it("localizes properties toggle button title", () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <I18nProvider>
          <GoalPropertiesToggleButton panelVisible={false} onShowProperties={() => {}} />
        </I18nProvider>,
      );
    });

    expect(host.innerHTML).toContain('title="显示属性"');

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
