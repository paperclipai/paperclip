// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "@paperclipai/shared";
import { Activity } from "./Activity";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const listActivityMock = vi.fn();
const listAgentsMock = vi.fn();
const listIssuesMock = vi.fn();
const listProjectsMock = vi.fn();
const listGoalsMock = vi.fn();
const setBreadcrumbsMock = vi.fn();

let selectedCompanyId: string | null = "company-1";

vi.mock("../api/activity", () => ({
  activityApi: {
    list: () => listActivityMock(),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: () => listAgentsMock(),
  },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    list: () => listIssuesMock(),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    list: () => listProjectsMock(),
  },
}));

vi.mock("../api/goals", () => ({
  goalsApi: {
    list: () => listGoalsMock(),
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
    activity: (companyId: string) => ["activity", companyId],
    agents: { list: (companyId: string) => ["agents", "list", companyId] },
    issues: { list: (companyId: string) => ["issues", "list", companyId] },
    projects: { list: (companyId: string) => ["projects", "list", companyId] },
    goals: { list: (companyId: string) => ["goals", "list", companyId] },
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, className }: { children: unknown; to: string; className?: string }) => (
    <a href={to} className={className}>{children as never}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Activity", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    selectedCompanyId = "company-1";
    listActivityMock.mockResolvedValue([]);
    listAgentsMock.mockResolvedValue([]);
    listIssuesMock.mockResolvedValue([]);
    listProjectsMock.mockResolvedValue([]);
    listGoalsMock.mockResolvedValue([]);
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
            <Activity />
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

    throw new Error("Timed out waiting for Activity to settle");
  }

  it("renders the localized empty state when no company is selected", async () => {
    selectedCompanyId = null;
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("选择一个公司以查看活动。") === true);

    expect(container.textContent).toContain("选择一个公司以查看活动。");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([{ label: "活动" }]);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized row chrome for system events", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    listActivityMock.mockResolvedValue([
      {
        id: "activity-1",
        companyId: "company-1",
        action: "issue.created",
        entityType: "issue",
        entityId: "issue-1",
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        details: null,
        createdAt: new Date(),
      } satisfies ActivityEvent,
    ]);
    listIssuesMock.mockResolvedValue([
      { id: "issue-1", identifier: "PAP-1", title: "Test issue" },
    ]);

    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("PAP-1") === true);

    expect(container.textContent).toContain("系统");
    expect(container.textContent).toContain("创建了");
    expect(container.textContent).toContain("PAP-1");
    expect(container.textContent).toContain("刚刚");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([{ label: "活动" }]);

    await act(async () => {
      root.unmount();
    });
  });
});
