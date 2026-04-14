// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, RoutineListItem } from "@paperclipai/shared";

function createRoutine(overrides: Partial<RoutineListItem> = {}): RoutineListItem {
  return {
    id: "routine-1",
    companyId: "company-1",
    projectId: null,
    goalId: null,
    parentIssueId: null,
    title: "Daily QA",
    description: null,
    assigneeAgentId: null,
    priority: "medium",
    status: "paused",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    variables: [],
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    lastTriggeredAt: null,
    lastEnqueuedAt: null,
    createdAt: new Date("2026-04-14T00:00:00.000Z"),
    updatedAt: new Date("2026-04-14T00:00:00.000Z"),
    triggers: [],
    lastRun: null,
    activeIssue: null,
    ...overrides,
  };
}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Routines } from "./Routines";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

let currentSearch = "";
let selectedCompanyId: string | null = "company-1";

const setBreadcrumbsMock = vi.fn();
const navigateMock = vi.fn();
const routinesListMock = vi.fn<(companyId: string) => Promise<RoutineListItem[]>>();
const issuesListMock = vi.fn<(companyId: string, filters?: Record<string, unknown>) => Promise<Issue[]>>();

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
  useLocation: () => ({ pathname: "/routines", search: currentSearch ? `?${currentSearch}` : "", hash: "" }),
  useSearchParams: () => [new URLSearchParams(currentSearch), vi.fn()],
  Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a>,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../api/routines", () => ({
  routinesApi: {
    list: (companyId: string) => routinesListMock(companyId),
    create: vi.fn(),
    update: vi.fn(),
    run: vi.fn(),
  },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    list: (companyId: string, filters?: Record<string, unknown>) => issuesListMock(companyId, filters),
    update: vi.fn(),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: vi.fn(async () => []) },
}));

vi.mock("../api/projects", () => ({
  projectsApi: { list: vi.fn(async () => []) },
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: { getExperimental: vi.fn(async () => ({ enableIsolatedWorkspaces: false })) },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: vi.fn(async () => []) },
}));

vi.mock("../components/IssuesList", () => ({
  IssuesList: ({ issues }: { issues: Issue[] }) => <div>{issues.map((issue) => issue.title).join(", ")}</div>,
}));

vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({ items }: { items: Array<{ label: string }> }) => <div>{items.map((item) => item.label).join("|")}</div>,
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  TabsContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: unknown; open?: boolean }) => (open === false ? null : <div>{children as never}</div>),
  DialogContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({ placeholder }: { placeholder?: string }) => <div data-placeholder={placeholder} />,
}));

vi.mock("../components/InlineEntitySelector", () => ({
  InlineEntitySelector: ({ placeholder, noneLabel, searchPlaceholder }: { placeholder?: string; noneLabel?: string; searchPlaceholder?: string }) => (
    <div>
      <button type="button">{placeholder ?? "selector"}</button>
      <span>{noneLabel}</span>
      <span>{searchPlaceholder}</span>
    </div>
  ),
}));

vi.mock("../components/RoutineRunVariablesDialog", () => ({
  RoutineRunVariablesDialog: () => null,
  routineRunNeedsConfiguration: () => false,
}));

vi.mock("../components/RoutineVariablesEditor", () => ({
  RoutineVariablesEditor: () => null,
  RoutineVariablesHint: () => null,
}));

vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Routines i18n shell", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    currentSearch = "";
    selectedCompanyId = "company-1";
    navigateMock.mockReset();
    routinesListMock.mockReset();
    issuesListMock.mockReset();
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
            <Routines />
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

    throw new Error("Timed out waiting for Routines to settle");
  }

  it("renders localized empty company state", async () => {
    selectedCompanyId = null;
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("选择一个公司以查看例行任务。") === true);

    expect(container.textContent).toContain("选择一个公司以查看例行任务。");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized shell copy and empty state", async () => {
    routinesListMock.mockResolvedValue([]);
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("例行任务") === true);

    expect(container.textContent).toContain("例行任务");
    expect(container.textContent).toContain("可周期性触发并最终落地为可审计执行事项的工作定义。");
    expect(container.textContent).toContain("创建例行任务");
    expect(container.textContent).toContain("例行任务|最近运行");
    expect(container.textContent).toContain("还没有例行任务。使用“创建例行任务”定义第一个周期性工作流。");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([{ label: "例行任务" }]);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized routine row copy for a non-empty list", async () => {
    routinesListMock.mockResolvedValue([
      createRoutine({
        status: "active",
        projectId: null,
        assigneeAgentId: "agent-1",
        lastTriggeredAt: null,
      }),
    ]);
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("Daily QA") === true);

    expect(container.textContent).toContain("Daily QA");
    expect(container.textContent).toContain("无项目");
    expect(container.textContent).toContain("未知智能体");
    expect(container.textContent).toContain("从未运行");
    expect(container.textContent).toContain("开启");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized composer and advanced settings copy", async () => {
    routinesListMock.mockResolvedValue([]);
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("创建例行任务") === true);

    const createButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("创建例行任务"));
    expect(createButton).toBeDefined();

    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => container.textContent?.includes("新建例行任务") === true);

    const dialogText = container.textContent ?? "";
    expect(dialogText).toContain("新建例行任务");
    expect(dialogText).toContain("先定义周期性工作。默认项目和默认智能体对草稿例行任务是可选的。");
    expect(dialogText).toContain("取消");
    expect(dialogText).toContain("负责人");
    expect(dialogText).toContain("无负责人");
    expect(dialogText).toContain("搜索负责人...");
    expect(dialogText).toContain("项目");
    expect(dialogText).toContain("无项目");
    expect(dialogText).toContain("搜索项目...");
    expect(dialogText).toContain("高级投递设置");
    expect(dialogText).toContain("创建后，Paperclip 会直接带你进入触发器设置。草稿例行任务在设置默认智能体之前会保持暂停。");
    expect(dialogText).toContain("创建例行任务");

    await act(async () => {
      root.unmount();
    });
  });
});
