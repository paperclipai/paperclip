// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const summaryMock = vi.fn();
const listActivityMock = vi.fn();
const listIssuesMock = vi.fn();
const listAgentsMock = vi.fn();
const listProjectsMock = vi.fn();
const listHeartbeatsMock = vi.fn();
const openOnboardingMock = vi.fn();
const setBreadcrumbsMock = vi.fn();

let selectedCompanyId: string | null = "company-1";
let companies: Array<{ id: string }> = [{ id: "company-1" }];

vi.mock("../api/dashboard", () => ({
  dashboardApi: {
    summary: () => summaryMock(),
  },
}));

vi.mock("../api/activity", () => ({
  activityApi: {
    list: () => listActivityMock(),
  },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    list: () => listIssuesMock(),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: () => listAgentsMock(),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    list: () => listProjectsMock(),
  },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: {
    list: () => listHeartbeatsMock(),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId, companies }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openOnboarding: openOnboardingMock }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    agents: { list: (companyId: string) => ["agents", companyId] },
    dashboard: (companyId: string) => ["dashboard", companyId],
    activity: (companyId: string) => ["activity", companyId],
    issues: { list: (companyId: string) => ["issues", companyId] },
    projects: { list: (companyId: string) => ["projects", companyId] },
    heartbeats: (companyId: string) => ["heartbeats", companyId],
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, className }: { children: unknown; to: string; className?: string }) => (
    <a href={to} className={className}>{children as never}</a>
  ),
}));

vi.mock("../components/MetricCard", () => ({
  MetricCard: ({ label, description }: { label: string; description?: unknown }) => <div>{label}{description as never}</div>,
}));

vi.mock("../components/ActivityCharts", () => ({
  ChartCard: ({ title, subtitle, children }: { title: string; subtitle: string; children: unknown }) => <div>{title} {subtitle}{children as never}</div>,
  RunActivityChart: () => <div>run-activity-chart</div>,
  PriorityChart: () => <div>priority-chart</div>,
  IssueStatusChart: () => <div>issue-status-chart</div>,
  SuccessRateChart: () => <div>success-rate-chart</div>,
}));

vi.mock("../components/ActiveAgentsPanel", () => ({
  ActiveAgentsPanel: () => <div>active-agents-panel</div>,
}));

vi.mock("../components/ActivityRow", () => ({
  ActivityRow: () => <div>activity-row</div>,
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Dashboard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    selectedCompanyId = "company-1";
    companies = [{ id: "company-1" }];
    summaryMock.mockResolvedValue({
      budgets: { activeIncidents: 0, pausedAgents: 0, pausedProjects: 0, pendingApprovals: 0 },
      agents: { active: 0, running: 0, paused: 0, error: 0 },
      tasks: { inProgress: 0, open: 0, blocked: 0 },
      costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 },
      pendingApprovals: 0,
    });
    listIssuesMock.mockResolvedValue([]);
    listActivityMock.mockResolvedValue([]);
    listAgentsMock.mockResolvedValue([]);
    listProjectsMock.mockResolvedValue([]);
    listHeartbeatsMock.mockResolvedValue([]);
    openOnboardingMock.mockReset();
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
            <Dashboard />
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

    throw new Error("Timed out waiting for Dashboard to settle");
  }

  it("renders localized empty state when no company is selected but companies exist", async () => {
    selectedCompanyId = null;
    companies = [{ id: "company-1" }];
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("创建一个公司或选择一个公司以查看仪表盘。") === true);

    expect(container.textContent).toContain("创建一个公司或选择一个公司以查看仪表盘。");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([{ label: "仪表盘" }]);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized onboarding empty state when there are no companies", async () => {
    selectedCompanyId = null;
    companies = [];
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("欢迎使用 Paperclip。先设置你的第一个公司和智能体以开始使用。") === true);

    expect(container.textContent).toContain("欢迎使用 Paperclip。先设置你的第一个公司和智能体以开始使用。");
    expect(container.textContent).toContain("开始使用");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized no-agents banner and metric labels", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("你还没有智能体。") === true && container.textContent?.includes("已启用智能体") === true);

    expect(container.textContent).toContain("你还没有智能体。");
    expect(container.textContent).toContain("在这里创建");
    expect(container.textContent).toContain("已启用智能体");
    expect(container.textContent).toContain("进行中的任务");
    expect(container.textContent).toContain("本月支出");
    expect(container.textContent).toContain("待处理审批");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized dashboard charts and stable summaries", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    summaryMock.mockResolvedValue({
      budgets: { activeIncidents: 2, pausedAgents: 3, pausedProjects: 1, pendingApprovals: 4 },
      agents: { active: 1, running: 2, paused: 1, error: 3 },
      tasks: { inProgress: 5, open: 6, blocked: 2 },
      costs: { monthSpendCents: 12345, monthBudgetCents: 50000, monthUtilizationPercent: 25 },
      pendingApprovals: 1,
    });
    listIssuesMock.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "PC-1",
        title: "修复 Dashboard",
        status: "open",
        updatedAt: new Date("2026-04-12T00:00:00Z").toISOString(),
        assigneeAgentId: null,
      },
    ]);
    listActivityMock.mockResolvedValue([{ id: "evt-1" }]);

    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("运行活动") === true && container.textContent?.includes("最近活动") === true);

    expect(container.textContent).toContain("运行活动");
    expect(container.textContent).toContain("按优先级统计事项");
    expect(container.textContent).toContain("按状态统计事项");
    expect(container.textContent).toContain("成功率");
    expect(container.textContent).toContain("最近 14 天");
    expect(container.textContent).toContain("最近活动");
    expect(container.textContent).toContain("最近任务");
    expect(container.textContent).toContain("运行中：2 · 已暂停：1 · 错误：3");
    expect(container.textContent).toContain("打开：6 · 阻塞：2");
    expect(container.textContent).toContain("已使用预算 $500.00 的 25%");
    expect(container.textContent).toContain("等待看板审核的预算覆盖：4");
    expect(container.textContent).toContain("活跃预算事件：2");
    expect(container.textContent).toContain("已暂停智能体：3 · 已暂停项目：1 · 待处理预算审批：4");
    expect(container.textContent).toContain("打开预算");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized empty recent tasks state", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("最近任务") === true);

    expect(container.textContent).toContain("最近任务");
    expect(container.textContent).toContain("还没有任务。");

    await act(async () => {
      root.unmount();
    });
  });
});
