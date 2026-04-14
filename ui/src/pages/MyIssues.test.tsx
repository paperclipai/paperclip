// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MyIssues } from "./MyIssues";

function createIssue(overrides: Partial<{
  id: string;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  identifier: string | null;
  createdAt: string;
}> = {}) {
  return {
    id: "issue-1",
    title: "Unassigned issue",
    status: "todo",
    assigneeAgentId: null,
    identifier: "PC-1",
    createdAt: "2026-04-14T00:00:00.000Z",
    ...overrides,
  };
}
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const listIssuesMock = vi.fn();
const setBreadcrumbsMock = vi.fn();

let selectedCompanyId: string | null = "company-1";

vi.mock("../api/issues", () => ({
  issuesApi: {
    list: () => listIssuesMock(),
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
    issues: {
      list: (companyId: string) => ["issues", companyId],
    },
  },
}));

vi.mock("../components/EntityRow", () => ({
  EntityRow: ({ title }: { title: string }) => <div>{title}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("MyIssues", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    selectedCompanyId = "company-1";
    listIssuesMock.mockResolvedValue([]);
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
            <MyIssues />
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

    throw new Error("Timed out waiting for MyIssues to settle");
  }

  it("renders localized empty state when no company is selected", async () => {
    selectedCompanyId = null;
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("请先选择公司以查看你的事项。") === true);

    expect(container.textContent).toContain("请先选择公司以查看你的事项。");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([{ label: "我的事项" }]);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized empty list state", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("你当前没有待处理事项。") === true);

    expect(container.textContent).toContain("你当前没有待处理事项。");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders visible unassigned issues without empty state", async () => {
    listIssuesMock.mockResolvedValue([
      createIssue({ title: "Inbox cleanup" }),
    ]);
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("Inbox cleanup") === true);

    expect(container.textContent).toContain("Inbox cleanup");
    expect(container.textContent).not.toContain("你当前没有待处理事项。");

    await act(async () => {
      root.unmount();
    });
  });

  it("filters out completed, cancelled, and assigned issues", async () => {
    listIssuesMock.mockResolvedValue([
      createIssue({ id: "issue-1", title: "Keep todo", status: "todo", assigneeAgentId: null }),
      createIssue({ id: "issue-2", title: "Keep in progress", status: "in_progress", assigneeAgentId: null }),
      createIssue({ id: "issue-3", title: "Hide done", status: "done", assigneeAgentId: null }),
      createIssue({ id: "issue-4", title: "Hide cancelled", status: "cancelled", assigneeAgentId: null }),
      createIssue({ id: "issue-5", title: "Hide assigned", status: "todo", assigneeAgentId: "agent-1" }),
    ]);
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("Keep todo") === true);

    expect(container.textContent).toContain("Keep todo");
    expect(container.textContent).toContain("Keep in progress");
    expect(container.textContent).not.toContain("Hide done");
    expect(container.textContent).not.toContain("Hide cancelled");
    expect(container.textContent).not.toContain("Hide assigned");

    await act(async () => {
      root.unmount();
    });
  });

  it("falls back to empty state when every issue is filtered out", async () => {
    listIssuesMock.mockResolvedValue([
      createIssue({ id: "issue-1", title: "Done item", status: "done", assigneeAgentId: null }),
      createIssue({ id: "issue-2", title: "Assigned item", status: "todo", assigneeAgentId: "agent-1" }),
    ]);
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("你当前没有待处理事项。") === true);

    expect(container.textContent).toContain("你当前没有待处理事项。");
    expect(container.textContent).not.toContain("Done item");
    expect(container.textContent).not.toContain("Assigned item");

    await act(async () => {
      root.unmount();
    });
  });
});
