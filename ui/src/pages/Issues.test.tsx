// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Issues } from "./Issues";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const listIssuesMock = vi.fn();
const listAgentsMock = vi.fn();
const listProjectsMock = vi.fn();
const liveRunsMock = vi.fn();
const setBreadcrumbsMock = vi.fn();
const updateIssueMock = vi.fn();

let selectedCompanyId: string | null = "company-1";
let pathname = "/issues";
let search = "";
let hash = "";

vi.mock("../api/issues", () => ({
  issuesApi: {
    list: () => listIssuesMock(),
    update: (id: string, data: Record<string, unknown>) => updateIssueMock(id, data),
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
    liveRunsForCompany: () => liveRunsMock(),
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
    agents: { list: (companyId: string) => ["agents", companyId] },
    projects: { list: (companyId: string) => ["projects", companyId] },
    issues: { list: (companyId: string) => ["issues", companyId] },
    liveRuns: (companyId: string) => ["live-runs", companyId],
  },
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname, search, hash }),
  useSearchParams: () => [{ get: (key: string) => (key === "q" ? new URLSearchParams(search).get("q") : null) }],
}));

vi.mock("../lib/issueDetailBreadcrumb", () => ({
  createIssueDetailLocationState: (...args: unknown[]) => ({ args }),
}));

vi.mock("../components/IssuesList", () => ({
  IssuesList: ({ issueLinkState, initialSearch, enableRoutineVisibilityFilter }: { issueLinkState: { args: unknown[] }; initialSearch?: string; enableRoutineVisibilityFilter?: boolean }) => (
    <div>
      <div>{String(issueLinkState.args[0])}</div>
      <div>initialSearch:{initialSearch ?? ""}</div>
      <div>routineFilter:{String(enableRoutineVisibilityFilter)}</div>
    </div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Issues", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    selectedCompanyId = "company-1";
    pathname = "/issues";
    search = "";
    hash = "";
    listIssuesMock.mockResolvedValue([]);
    listAgentsMock.mockResolvedValue([]);
    listProjectsMock.mockResolvedValue([]);
    liveRunsMock.mockResolvedValue([]);
    setBreadcrumbsMock.mockReset();
    updateIssueMock.mockReset();
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
            <Issues />
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

    throw new Error("Timed out waiting for Issues to settle");
  }

  it("renders localized empty state when no company is selected", async () => {
    selectedCompanyId = null;
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("选择一个公司以查看事项。") === true);

    expect(container.textContent).toContain("选择一个公司以查看事项。");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([{ label: "事项" }]);

    await act(async () => {
      root.unmount();
    });
  });

  it("passes localized breadcrumb label into issue link state", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("事项") === true);

    expect(container.textContent).toContain("事项");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([{ label: "事项" }]);

    await act(async () => {
      root.unmount();
    });
  });

  it("passes localized search state into the issues list", async () => {
    search = "?q= billing ";
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("initialSearch: billing ") === true);

    expect(container.textContent).toContain("initialSearch: billing ");
    expect(container.textContent).toContain("routineFilter:true");

    await act(async () => {
      root.unmount();
    });
  });
});
